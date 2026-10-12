"""The little of PNG this package reads and writes.

The elevation tiles arrive as PNGs, which ``decode_png`` reads (see
``terrain_pixels``), and the link previews are written as PNGs by
``previews``. Both need the signature and the chunk layout: a length, a
type, the data and a CRC over the type and the data.
"""

import struct
import zlib
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable

__all__ = [
    "PNG_SIGNATURE",
    "PngError",
    "chunk",
    "chunks",
    "decode_png",
    "ihdr_fields",
]

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


class PngError(ValueError):
    """A PNG this package cannot or will not read."""


def chunks(data: bytes) -> Iterable[tuple[bytes, bytes]]:
    """The chunks of a PNG after its signature, each checked against its CRC.

    Raises ``PngError`` for a corrupt chunk, and once the data runs out
    before an IEND chunk: a reader stops at IEND itself.
    """
    pos = len(PNG_SIGNATURE)
    while pos + 12 <= len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if len(body) != length or pos + 12 + length > len(data):
            break
        (crc,) = struct.unpack_from(">I", data, pos + 8 + length)
        if zlib.crc32(kind + body) != crc:
            raise PngError(f"PNG chunk {kind!r} is corrupt")
        yield kind, body
        pos += 12 + length
    raise PngError("PNG ends before its IEND chunk")


def chunk(kind: bytes, data: bytes) -> bytes:
    """One chunk of a PNG: its length, type, data and CRC."""
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", zlib.crc32(kind + data))
    )


# Colour types this decoder reads, by the channels of a pixel: truecolour
# and truecolour with alpha, which is what elevation tiles are
_CHANNELS = {2: 3, 6: 4}
# The widest and highest PNG this decoder reads: an elevation tile is 256 or
# 512 pixels a side, and a header that claims more than this is no tile
MAX_PNG_SIDE = 4096


def _unfilter(raw: bytes, width: int, height: int, bpp: int) -> bytearray:  # noqa: C901
    """Undo the per-line filters of a non-interlaced 8-bit image.

    Every line starts with its filter type; the filters predict a byte from
    the one ``bpp`` bytes to the left (a), the one above (b) and the one
    above and to the left (c). One branch per filter type in one loop
    (hence the complexity exemption): a function call per byte would cost
    what the pool of decoders saves.
    """
    stride = width * bpp
    if len(raw) != height * (stride + 1):
        raise PngError("PNG image data has the wrong length")
    out = bytearray(height * stride)
    previous = bytearray(stride)
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        line = bytearray(raw[start + 1 : start + 1 + stride])
        if kind == 1:  # Sub
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif kind == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + previous[i]) & 0xFF
        elif kind == 3:  # Average
            for i in range(bpp):
                line[i] = (line[i] + (previous[i] >> 1)) & 0xFF
            for i in range(bpp, stride):
                line[i] = (line[i] + ((line[i - bpp] + previous[i]) >> 1)) & 0xFF
        elif kind == 4:  # Paeth
            for i in range(bpp):
                line[i] = (line[i] + previous[i]) & 0xFF
            for i in range(bpp, stride):
                a = line[i - bpp]
                b = previous[i]
                c = previous[i - bpp]
                # The distances of a + b - c to a, b and c
                pa = abs(b - c)
                pb = abs(a - c)
                pc = abs(a + b - c - c)
                if pa <= pb and pa <= pc:
                    predictor = a
                elif pb <= pc:
                    predictor = b
                else:
                    predictor = c
                line[i] = (line[i] + predictor) & 0xFF
        elif kind != 0:
            raise PngError(f"PNG line {y} has the unknown filter type {kind}")
        out[y * stride : (y + 1) * stride] = line
        previous = line
    return out


def ihdr_fields(body: bytes) -> tuple[int, ...]:
    """The seven fields of an IHDR chunk."""
    if len(body) != 13:
        raise PngError("PNG header has the wrong length")
    return struct.unpack(">IIBBBBB", body)


def decode_png(data: bytes) -> tuple[int, int, int, bytearray]:
    """Decode an 8-bit RGB or RGBA PNG without interlacing.

    Returns the width, the height, the channels per pixel (3 or 4) and the
    pixels, line by line. Anything else (another bit depth, a palette, grey,
    interlacing) raises ``PngError``: an elevation tile is never one of them,
    and a decoder for all of PNG is not worth its code here.
    """
    if not data.startswith(PNG_SIGNATURE):
        raise PngError("not a PNG file")
    header: tuple[int, ...] | None = None
    compressed = bytearray()
    for kind, body in chunks(data):
        if kind == b"IHDR":
            header = ihdr_fields(body)
        elif kind == b"IDAT":
            compressed += body
        elif kind == b"IEND":
            break
    if header is None:
        raise PngError("PNG has no header")
    width, height, depth, colour, compression, filtering, interlace = header
    if depth != 8 or colour not in _CHANNELS:
        raise PngError(
            f"PNG of bit depth {depth} and colour type {colour}: only 8-bit "
            "RGB and RGBA are supported"
        )
    if compression != 0 or filtering != 0:
        raise PngError("PNG uses an unknown compression or filter method")
    if interlace != 0:
        raise PngError("interlaced PNGs are not supported")
    if width == 0 or height == 0:
        raise PngError("PNG has no pixels")
    if width > MAX_PNG_SIDE or height > MAX_PNG_SIDE:
        raise PngError(f"PNG of {width}x{height} pixels is too large")
    channels = _CHANNELS[colour]
    # A line is its filter type and its pixels. The image data is inflated
    # no further than one byte beyond that, which _unfilter refuses: a few
    # kilobytes of zeros inflate to gigabytes otherwise.
    expected = height * (width * channels + 1)
    try:
        raw = zlib.decompressobj().decompress(compressed, expected + 1)
    except zlib.error as e:
        raise PngError(f"PNG image data is corrupt: {e}") from e
    return width, height, channels, _unfilter(raw, width, height, channels)
