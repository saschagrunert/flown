"""The pixels of the elevation tiles, decoded once and kept next to the PNGs.

Decoding a PNG takes a few tens of milliseconds of pure Python, which a few
hundred tiles turn into seconds on every build. The pixels of a decoded tile
are therefore kept next to its PNG as well (see ``_read_pixel_planes``).
The tiles are fetched by ``terrain_fetch`` and sampled by ``terrain``.
"""

import contextlib
import struct
import zlib
from array import array
from compression import zstd
from typing import TYPE_CHECKING, NamedTuple

from .cache import atomic_bytes_write
from .logger import logger
from .png import PNG_SIGNATURE, PngError, chunks, decode_png, ihdr_fields

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

__all__ = [
    "PIXELS_SUFFIX",
    "TILE_SIZE",
    "DecodeFailedError",
    "TileKey",
    "decode_cached_tile",
    "has_current_pixels",
    "is_tile_png",
]

TILE_SIZE = 256


class TileKey(NamedTuple):
    """A tile of the elevation model: zoom, column and row."""

    z: int
    x: int
    y: int


class DecodeFailedError(RuntimeError):
    """The tiles could not be decoded at all, not even in this process."""


def is_tile_png(data: bytes) -> bool:
    """Whether ``data`` is a complete PNG of a tile's size.

    Every chunk against its CRC, the header at ``TILE_SIZE`` a side and the
    IEND chunk in place: a body cut short on the way, or one the host
    filled with something else, must not be cached as a tile and decoded
    again on every build after.
    """
    if not data.startswith(PNG_SIGNATURE):
        return False
    try:
        for kind, body in chunks(data):
            if kind == b"IHDR" and ihdr_fields(body)[:2] != (TILE_SIZE, TILE_SIZE):
                return False
            if kind == b"IEND":
                return True
    except PngError:
        return False
    return False


# The decoded pixels of a tile, next to its PNG: a header, then the red,
# the green and the blue value of every pixel, one plane after the other,
# compressed with zstd. Planes compress better than the PNG itself (the red
# one is all but constant) and inflate in a fraction of a millisecond. The
# header holds the CRC of the PNG the pixels are of, so a tile fetched
# again is decoded again. Bump the version whenever the layout or the
# compression changes (version 1 was zlib): a file of an older version is
# decoded again and replaced.
PIXELS_SUFFIX = ".pixels"
_PIXELS_HEADER = struct.Struct(">4sBI")
_PIXELS_MAGIC = b"KHTP"
_PIXELS_VERSION = 2
_PIXELS_ZSTD_LEVEL = 3
_PLANES_BYTES = 3 * TILE_SIZE * TILE_SIZE


def _pixels_path(path: Path) -> Path:
    return path.with_suffix(PIXELS_SUFFIX)


def has_current_pixels(path: Path) -> bool:
    """Whether the pixels kept of the tile at ``path`` are of this version.

    Only the header's magic and version: whether they are of this PNG
    takes reading the PNG, which the decoding does anyway.
    """
    try:
        with _pixels_path(path).open("rb") as kept:
            head = kept.read(len(_PIXELS_MAGIC) + 1)
    except OSError:
        return False
    return head == _PIXELS_MAGIC + bytes([_PIXELS_VERSION])


def _decode_planes(data: bytes) -> bytes:
    """The red, green and blue planes of a Terrarium tile's PNG."""
    width, height, channels, pixels = decode_png(data)
    if width != TILE_SIZE or height != TILE_SIZE:
        raise PngError(f"tile is {width}x{height} pixels, not {TILE_SIZE}")
    return (
        bytes(pixels[0::channels])
        + bytes(pixels[1::channels])
        + bytes(pixels[2::channels])
    )


def _read_pixel_planes(path: Path, data: bytes) -> bytes | None:
    """The kept planes of the tile at ``path`` whose PNG is ``data``.

    None when there are none, or none of this PNG, or they are damaged:
    the tile is then decoded again.
    """
    try:
        kept = _pixels_path(path).read_bytes()
        magic, version, crc = _PIXELS_HEADER.unpack_from(kept)
        if (magic, version, crc) != (_PIXELS_MAGIC, _PIXELS_VERSION, zlib.crc32(data)):
            return None
        # Inflated no further than the planes and a byte, like the PNG
        planes = zstd.ZstdDecompressor().decompress(
            kept[_PIXELS_HEADER.size :], _PLANES_BYTES + 1
        )
    except OSError, struct.error, zstd.ZstdError:
        return None
    return planes if len(planes) == _PLANES_BYTES else None


def _keep_pixel_planes(path: Path, data: bytes, planes: bytes) -> None:
    """Keep the planes of a decoded tile next to its PNG, atomically."""
    header = _PIXELS_HEADER.pack(_PIXELS_MAGIC, _PIXELS_VERSION, zlib.crc32(data))
    try:
        atomic_bytes_write(
            _pixels_path(path),
            header + zstd.compress(planes, level=_PIXELS_ZSTD_LEVEL),
        )
    except OSError as e:
        # Only the next build pays for it: it decodes the tile again
        logger.debug("Cannot keep the pixels of %s: %s", path.name, e)


def _elevations_at(planes: bytes, indices: Sequence[int]) -> array[float]:
    """The elevations in metres of the pixels at ``indices`` of the planes.

    A Terrarium pixel encodes red * 256 + green + blue / 256 - 32768.
    """
    green = TILE_SIZE * TILE_SIZE
    blue = 2 * green
    return array(
        "d",
        [
            planes[index] * 256
            + planes[green + index]
            + planes[blue + index] / 256
            - 32768
            for index in indices
        ],
    )


def decode_cached_tile(path: Path, indices: Sequence[int]) -> array[float] | None:
    """The elevations of the pixels at ``indices`` of a cached tile.

    From the pixels kept of it when there are any, from its PNG otherwise,
    whose pixels are then kept. None when the tile is unusable. A
    module-level function, so the decoding pool can run it. A file that does
    not decode is removed, so the next build fetches it again.
    """
    try:
        data = path.read_bytes()
        planes = _read_pixel_planes(path, data)
        if planes is None:
            planes = _decode_planes(data)
            _keep_pixel_planes(path, data, planes)
        return _elevations_at(planes, indices)
    except (OSError, PngError) as e:
        logger.debug("Elevation tile %s is unusable: %s", path.name, e)
        for unusable in (path, _pixels_path(path)):
            with contextlib.suppress(OSError):
                unusable.unlink()
        return None
