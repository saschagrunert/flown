"""PNGs and tile sources the terrain tests share.

A small PNG encoder, the decoder's counterpart, which writes every filter
type, and the Terrarium tiles made with it; a tile source that answers every
pixel from a function of its position. Not a test module: test_png.py,
test_terrain.py and test_terrain_fetch.py import it.
"""

import math
import struct
import zlib

from flown.terrain import TERRAIN_ZOOM, TILE_SIZE

# --- A PNG encoder, the decoder's counterpart ---------------------------


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def _filtered(line: bytes, previous: bytes, kind: int, bpp: int) -> bytes:
    out = bytearray()
    for i, x in enumerate(line):
        a = line[i - bpp] if i >= bpp else 0
        b = previous[i]
        c = previous[i - bpp] if i >= bpp else 0
        predictor = (0, a, b, (a + b) // 2, _paeth(a, b, c))[kind]
        out.append((x - predictor) & 0xFF)
    return bytes(out)


def png_chunk(kind: bytes, body: bytes) -> bytes:
    return (
        struct.pack(">I", len(body))
        + kind
        + body
        + struct.pack(">I", zlib.crc32(kind + body))
    )


def encode_png(
    width,
    height,
    pixels,
    *,
    channels=3,
    filters=(0, 1, 2, 3, 4),
    header=None,
    raw=None,
):
    """A PNG of 8-bit ``pixels``, line ``y`` filtered with ``filters[y % n]``.

    ``header`` replaces the IHDR fields and ``raw`` the filtered image data,
    for the PNGs the decoder has to refuse.
    """
    stride = width * channels
    if raw is None:
        raw = bytearray()
        previous = bytes(stride)
        for y in range(height):
            line = bytes(pixels[y * stride : (y + 1) * stride])
            kind = filters[y % len(filters)]
            raw += bytes([kind]) + _filtered(line, previous, kind, channels)
            previous = line
    colour = {3: 2, 4: 6}.get(channels, 0)
    fields = header or (width, height, 8, colour, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", *fields))
        + png_chunk(b"tEXt", b"Comment\x00made by the test")
        + png_chunk(b"IDAT", zlib.compress(bytes(raw))[:10])
        + png_chunk(b"IDAT", zlib.compress(bytes(raw))[10:])
        + png_chunk(b"IEND", b"")
    )


def terrarium_png(elevation_of, channels=3):
    """A Terrarium tile whose pixel (x, y) encodes ``elevation_of(x, y)``."""
    pixels = bytearray()
    for y in range(TILE_SIZE):
        for x in range(TILE_SIZE):
            value = elevation_of(x, y) + 32768
            red = int(value // 256)
            green = int(value % 256)
            blue = round((value - math.floor(value)) * 256)
            pixels += bytes([red, green, blue, 255][:channels])
    return encode_png(TILE_SIZE, TILE_SIZE, pixels, channels=channels)


# --- Tile sources of the tests ------------------------------------------


class FunctionTiles:
    """Every pixel at ``elevation(gx, gy)``, of its global pixel position.

    ``missing`` tiles are left out of the answer. The tiles asked for are
    kept in ``asked``.
    """

    def __init__(self, elevation, missing=()):
        self.elevation = elevation
        self.missing = set(missing)
        self.asked = []

    def pixels(self, wanted):
        self.asked.append(dict(wanted))
        return {
            tile: [
                self.elevation(
                    tile.x * TILE_SIZE + index % TILE_SIZE,
                    tile.y * TILE_SIZE + index // TILE_SIZE,
                )
                for index in indices
            ]
            for tile, indices in wanted.items()
            if tile not in self.missing
        }


def global_pixel(lat, lon, zoom=TERRAIN_ZOOM):
    """Where a point is in global pixels, measured from the pixel centres."""
    world = TILE_SIZE << zoom
    sin = math.sin(math.radians(lat))
    x = (lon + 180) / 360 * world - 0.5
    y = (0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * world - 0.5
    return x, y
