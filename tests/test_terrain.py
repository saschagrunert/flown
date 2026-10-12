"""Tests for the ground under the flights (flown.terrain).

No test reaches the network: the tiles are made here, as PNGs written by a
small encoder of this file with every filter type, or answered by a tile
source of the test's own. conftest.py makes any download fail loudly.
"""

import ast
import http.client
import logging
import math
import operator
import os
import re
import struct
import time
import zlib
from array import array
from concurrent.futures.process import BrokenProcessPool
from pathlib import Path
from typing import ClassVar
from unittest.mock import MagicMock

import pytest

import flown.png as png_module
import flown.terrain as terrain_module
import flown.terrain_fetch as fetch_module
import flown.terrain_pixels as pixels_module
import flown.workers as workers_module
from flown.constants import KM_TO_NAUTICAL_MILES, METERS_TO_FEET
from flown.exceptions import TerrainUnavailableError
from flown.geometry import METRES_PER_DEGREE
from flown.logger import logger
from flown.path_content import PATH_ID_BITS
from flown.png import PngError, decode_png
from flown.segment_codec import (
    ALTITUDE_STEP,
    COORDINATE_SCALE,
    FORMAT_VERSION,
    GROUND_STEP,
    SPEED_SCALE,
    TIME_SCALE,
)
from flown.terrain import (
    TERRAIN_ZOOM,
    TILE_SIZE,
    TerrariumTiles,
    TileKey,
    elevations_by_coordinate,
    ground_profile_ft,
    sample_elevations,
    sample_path_elevations,
)
from flown.types import TrackPoint
from flown.workers import init_worker
from tests.conftest import FlatTiles

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


def _chunk(kind: bytes, body: bytes) -> bytes:
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
        + _chunk(b"IHDR", struct.pack(">IIBBBBB", *fields))
        + _chunk(b"tEXt", b"Comment\x00made by the test")
        + _chunk(b"IDAT", zlib.compress(bytes(raw))[:10])
        + _chunk(b"IDAT", zlib.compress(bytes(raw))[10:])
        + _chunk(b"IEND", b"")
    )


def _noise(count, seed=7):
    """Bytes that exercise every predictor, reproducibly."""
    value = seed
    out = bytearray()
    for _ in range(count):
        value = (value * 1103515245 + 12345) & 0x7FFFFFFF
        out.append(value >> 16 & 0xFF)
    return bytes(out)


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


def _global_pixel(lat, lon, zoom=TERRAIN_ZOOM):
    """Where a point is in global pixels, measured from the pixel centres."""
    world = TILE_SIZE << zoom
    sin = math.sin(math.radians(lat))
    x = (lon + 180) / 360 * world - 0.5
    y = (0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * world - 0.5
    return x, y


def _lon_of_pixel(gx, zoom=TERRAIN_ZOOM):
    """The longitude of a global pixel column's centre."""
    return (gx + 0.5) / (TILE_SIZE << zoom) * 360 - 180


# --- PNG ----------------------------------------------------------------


class TestDecodePng:
    @pytest.mark.parametrize("channels", [3, 4])
    @pytest.mark.parametrize("kind", [0, 1, 2, 3, 4])
    def test_every_filter_type(self, kind, channels):
        width, height = 7, 5
        pixels = _noise(width * height * channels)
        data = encode_png(width, height, pixels, channels=channels, filters=(kind,))

        assert decode_png(data) == (width, height, channels, bytearray(pixels))

    @pytest.mark.parametrize("channels", [3, 4])
    def test_filter_types_mixed_line_by_line(self, channels):
        width, height = 9, 11
        pixels = _noise(width * height * channels, seed=3)
        data = encode_png(width, height, pixels, channels=channels)

        assert decode_png(data)[3] == bytearray(pixels)

    @pytest.mark.parametrize(
        ("header", "message"),
        [
            ((2, 2, 16, 2, 0, 0, 0), "bit depth 16"),
            ((2, 2, 8, 3, 0, 0, 0), "colour type 3"),
            ((2, 2, 8, 0, 0, 0, 0), "colour type 0"),
            ((2, 2, 8, 2, 0, 0, 1), "interlaced"),
            ((2, 2, 8, 2, 1, 0, 0), "compression or filter"),
            ((2, 2, 8, 2, 0, 1, 0), "compression or filter"),
            ((0, 2, 8, 2, 0, 0, 0), "no pixels"),
        ],
    )
    def test_refuses_what_it_does_not_read(self, header, message):
        data = encode_png(2, 2, bytes(12), header=header)

        with pytest.raises(PngError, match=message):
            decode_png(data)

    def test_refuses_what_is_not_a_png(self):
        with pytest.raises(PngError, match="not a PNG"):
            decode_png(b"GIF89a")

    def test_refuses_a_corrupt_chunk(self):
        data = bytearray(encode_png(2, 2, bytes(12)))
        # A byte of the IHDR body, which its CRC no longer matches
        data[20] ^= 0xFF

        with pytest.raises(PngError, match="corrupt"):
            decode_png(bytes(data))

    @pytest.mark.parametrize("cut", [1, 12, 40])
    def test_refuses_a_cut_off_file(self, cut):
        data = encode_png(2, 2, bytes(12))

        with pytest.raises(PngError, match="IEND"):
            decode_png(data[:-cut])

    def test_refuses_an_unknown_filter_type(self):
        data = encode_png(1, 1, None, raw=b"\x05\x00\x00\x00")

        with pytest.raises(PngError, match="filter type 5"):
            decode_png(data)

    def test_refuses_image_data_of_the_wrong_length(self):
        data = encode_png(2, 2, None, raw=b"\x00" * 7)

        with pytest.raises(PngError, match="wrong length"):
            decode_png(data)

    def test_refuses_a_header_too_large_for_a_tile(self):
        side = png_module.MAX_PNG_SIDE + 1
        data = encode_png(2, 2, bytes(12), header=(side, 1, 8, 2, 0, 0, 0))

        with pytest.raises(PngError, match="too large"):
            decode_png(data)

    def test_inflates_no_further_than_the_image(self, monkeypatch):
        """A small bomb of zeros must not inflate beyond the header's size."""
        bomb = zlib.compress(bytes(64 * 1024 * 1024), 9)
        data = (
            b"\x89PNG\r\n\x1a\n"
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", bomb)
            + _chunk(b"IEND", b"")
        )
        inflated = []
        real = zlib.decompressobj

        class Recording:
            def __init__(self):
                self.inner = real()

            def decompress(self, data, max_length=0):
                out = self.inner.decompress(data, max_length)
                inflated.append(len(out))
                return out

        monkeypatch.setattr(zlib, "decompressobj", Recording)

        with pytest.raises(PngError, match="wrong length"):
            decode_png(data)
        # Two lines of a filter byte and two RGB pixels, and one byte more
        assert inflated == [2 * (2 * 3 + 1) + 1]

    def test_refuses_image_data_that_does_not_inflate(self):
        signature = b"\x89PNG\r\n\x1a\n"
        data = (
            signature
            + _chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0))
            + _chunk(b"IDAT", b"not zlib")
            + _chunk(b"IEND", b"")
        )

        with pytest.raises(PngError, match="image data is corrupt"):
            decode_png(data)

    def test_refuses_a_png_without_or_with_a_short_header(self):
        signature = b"\x89PNG\r\n\x1a\n"
        without = signature + _chunk(b"IEND", b"")
        short = signature + _chunk(b"IHDR", b"\x00" * 12) + _chunk(b"IEND", b"")

        with pytest.raises(PngError, match="no header"):
            decode_png(without)
        with pytest.raises(PngError, match="header has the wrong length"):
            decode_png(short)


def decode_tile_pixels(data, indices):
    """The elevations of the pixels at ``indices`` of a Terrarium tile."""
    return list(
        pixels_module._elevations_at(pixels_module._decode_planes(data), indices)
    )


class TestTerrarium:
    def test_elevation_of_a_pixel(self):
        pixels = TILE_SIZE * TILE_SIZE
        planes = bytearray(3 * pixels)
        for index, rgb in enumerate([(128, 0, 0), (129, 44, 128), (127, 255, 0)]):
            for plane, value in enumerate(rgb):
                planes[plane * pixels + index] = value

        assert list(pixels_module._elevations_at(bytes(planes), [0, 1, 2])) == [
            0,
            300.5,
            -1,
        ]

    @pytest.mark.parametrize("channels", [3, 4])
    def test_decodes_the_pixels_asked_for(self, channels):
        data = terrarium_png(lambda x, y: x + y * 0.5 - 100, channels)

        values = decode_tile_pixels(data, [0, 1, 256, 256 * 255 + 255])

        assert values == [-100, -99, -99.5, 282.5]

    def test_refuses_a_tile_of_another_size(self):
        data = encode_png(2, 2, bytes(12))

        with pytest.raises(PngError, match="not 256"):
            decode_tile_pixels(data, [0])


# --- Sampling -----------------------------------------------------------


class TestSampleElevations:
    def test_bilinear_between_pixel_centres(self):
        # A plane: bilinear interpolation reproduces it exactly
        source = FunctionTiles(lambda gx, gy: 2.0 * gx - 3.0 * gy)
        points = [(50.0, 8.0), (51.12345, 9.87654), (-33.9, 151.2)]

        elevations, tiles, missing = sample_elevations(points, source)

        for (lat, lon), elevation in zip(points, elevations, strict=True):
            x, y = _global_pixel(lat, lon)
            assert elevation == pytest.approx(2 * x - 3 * y, abs=1e-6)
        assert (tiles, missing) == (len(source.asked[0]), 0)

    def test_across_a_tile_edge(self):
        source = FunctionTiles(lambda gx, gy: float(gx))
        # Half way between the last column of one tile and the first of the
        # next: the two pixels are in different tiles
        edge = 546 * TILE_SIZE
        lon = (_lon_of_pixel(edge - 1) + _lon_of_pixel(edge)) / 2

        elevations, tiles, _ = sample_elevations([(50.0, lon)], source)

        assert elevations[0] == pytest.approx(edge - 0.5)
        assert {tile.x for tile in source.asked[0]} == {545, 546}
        assert tiles == len(source.asked[0])

    def test_across_the_antimeridian(self):
        world = TILE_SIZE << TERRAIN_ZOOM
        source = FunctionTiles(lambda gx, gy: 100.0 if gx == world - 1 else 0.0)

        elevations, _, _ = sample_elevations([(0.0, 180.0)], source)

        # Half way between the last column and the first, which wraps
        assert elevations[0] == pytest.approx(50.0)
        assert {tile.x for tile in source.asked[0]} == {0, (world - 1) // TILE_SIZE}

    def test_beyond_the_mercator_square(self):
        source = FunctionTiles(lambda gx, gy: float(gy))

        elevations, _, _ = sample_elevations([(89.0, 0.0), (-89.0, 0.0)], source)

        # The edge rows stand in for the ones beyond
        world = TILE_SIZE << TERRAIN_ZOOM
        assert elevations[0] == pytest.approx(0.0, abs=0.5)
        assert elevations[1] == pytest.approx(world - 1, abs=0.5)

    def test_leaves_out_what_a_missing_tile_covers(self):
        covered = (50.0, 8.0)
        uncovered = (50.0, 12.0)
        x, y = _global_pixel(*uncovered)
        missing = TileKey(TERRAIN_ZOOM, int(x) // TILE_SIZE, int(y) // TILE_SIZE)
        source = FunctionTiles(lambda gx, gy: 1.0, missing=[missing])

        elevations, tiles, count = sample_elevations([covered, uncovered], source)

        assert elevations[0] == 1.0
        assert math.isnan(elevations[1])
        assert count >= 1
        assert tiles == len(source.asked[0])

    def test_asks_for_every_pixel_once(self):
        source = FunctionTiles(lambda gx, gy: 1.0)

        sample_elevations([(50.0, 8.0), (50.0, 8.0), (50.00001, 8.0)], source)

        for indices in source.asked[0].values():
            assert len(indices) == len(set(indices))

    def test_flat_tiles(self):
        elevations, _, missing = sample_elevations([(50.0, 8.0)], FlatTiles(123.0))

        assert list(elevations) == [123.0]
        assert missing == 0


class TestSamplePathElevations:
    def test_one_elevation_per_point_keyed_by_path(self):
        paths = {
            3: [TrackPoint(50.000001, 8.0, 100.0), TrackPoint(50.1, 8.1, 200.0)],
            7: [TrackPoint(51.0, 9.0, 100.0)],
        }

        by_path = sample_path_elevations(paths, FlatTiles(42.0))

        assert {index: list(values) for index, values in by_path.items()} == {
            3: [42.0, 42.0],
            7: [42.0],
        }

    def test_by_coordinate_as_the_rows_carry_it(self):
        path = [
            TrackPoint(50.000001, 8.0, 100.0),
            TrackPoint(50.1, 8.1, 200.0),
            TrackPoint(50.2, 8.2, 200.0),
        ]

        by_coordinate = elevations_by_coordinate(path, array("d", [1.0, 2.0, math.nan]))

        # Rounded like the rows, and without the point the tiles miss
        assert by_coordinate == {(50.0, 8.0): 1.0, (50.1, 8.1): 2.0}

    def test_the_same_elevations_as_one_coordinate_at_a_time(self):
        """Points in one tile, across tile edges and repeated, alike."""
        source = FunctionTiles(lambda gx, gy: math.sin(gx / 7.0) * 300 + gy % 13)
        edge = 546 * TILE_SIZE
        lons = [
            8.0,
            8.0,
            _lon_of_pixel(edge - 1),
            (_lon_of_pixel(edge - 1) + _lon_of_pixel(edge)) / 2,
            8.3,
            180.0,
            -179.99,
        ]
        points = [(50.0 + i * 0.013, lon) for i, lon in enumerate(lons)]

        together, _, _ = sample_elevations(points, source)

        world = TILE_SIZE << TERRAIN_ZOOM

        def at(gx, gy):
            return source.elevation(gx % world, gy)

        for point, elevation in zip(points, together, strict=True):
            alone, _, _ = sample_elevations([point], source)
            assert elevation == alone[0]
            x, y = _global_pixel(*point)
            left, top = math.floor(x), math.floor(y)
            tx, ty = x - left, y - top
            upper = at(left, top) + (at(left + 1, top) - at(left, top)) * tx
            lower = at(left, top + 1) + (at(left + 1, top + 1) - at(left, top + 1)) * tx
            assert elevation == upper + (lower - upper) * ty

    def test_warns_once_about_missing_tiles(self, caplog):
        paths = {1: [TrackPoint(50.0, 8.0, 0.0)], 2: [TrackPoint(50.0, 12.0, 0.0)]}
        x, y = _global_pixel(50.0, 12.0)
        missing = TileKey(TERRAIN_ZOOM, int(x) // TILE_SIZE, int(y) // TILE_SIZE)

        with caplog.at_level(logging.WARNING, logger="flown"):
            by_path = sample_path_elevations(
                paths, FunctionTiles(lambda gx, gy: 5.0, missing=[missing])
            )

        assert list(by_path) == [1]
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        assert "1 flight(s)" in warnings[0].getMessage()


# --- Tiles from AWS -----------------------------------------------------


class FakeResponse:
    """What ``HTTPSConnection.getresponse`` answers."""

    def __init__(self, status=200, body=b"", headers=None):
        self.status = status
        self._body = body
        self._headers = headers or {}

    def read(self, amount=None):
        if amount is None:
            amount = len(self._body)
        body, self._body = self._body[:amount], self._body[amount:]
        return body

    def isclosed(self):
        # A real response closes once its body is read to the end
        return not self._body

    def getheader(self, name, default=None):
        return self._headers.get(name, default)


class FakeConnection:
    """An ``HTTPSConnection`` whose answers a test scripts.

    ``answer`` is called with the request path and returns a
    ``FakeResponse``, or raises. ``connections`` counts the connections
    opened and ``requests`` lists every path asked for, across threads.
    """

    connections = 0
    requests: ClassVar[list[str]] = []
    closed = 0

    def __init__(self, host, timeout=None, context=None):
        self.host = host
        self.timeout = timeout
        self.context = context
        self.headers = None
        self.path = ""
        type(self).connections += 1

    def request(self, method, path, headers=None):
        assert method == "GET"
        self.path = path
        self.headers = headers
        type(self).requests.append(path)

    def getresponse(self):
        return self.answer(self.path)

    def close(self):
        type(self).closed += 1

    @staticmethod
    def answer(path):
        return FakeResponse(200, _tile_png(250.0))


@pytest.fixture
def connections(monkeypatch):
    """A ``FakeConnection`` in place of the real one, counters reset.

    Tests replace ``answer`` on the class; set here, monkeypatch puts the
    default back afterwards, or the next test would get the last one's
    answer and pass whatever the code does with a sound tile.
    """
    FakeConnection.connections = 0
    FakeConnection.closed = 0
    FakeConnection.requests = []
    monkeypatch.setattr(FakeConnection, "answer", FakeConnection.__dict__["answer"])
    monkeypatch.setattr(fetch_module, "HTTPSConnection", FakeConnection)
    return FakeConnection


def _answers(answer):
    """A connection class whose responses come from ``answer(path)``."""
    return type(
        "ScriptedConnection", (FakeConnection,), {"answer": staticmethod(answer)}
    )


def _tile_png(elevation=250.0):
    return terrarium_png(lambda x, y: elevation)


@pytest.fixture(autouse=True)
def no_retry_pauses(monkeypatch):
    """The pauses between the attempts of a fetch are skipped.

    A test that fails a tile on every attempt would otherwise sleep through
    the whole backoff, seven seconds of it; the tests of the pauses record
    them with a patch of their own.
    """
    monkeypatch.setattr("flown.terrain_fetch.time.sleep", lambda _: None)


@pytest.fixture(autouse=True)
def no_proxy_environment(monkeypatch):
    """No proxy of the machine running the tests reaches the fetch."""
    for name in ("https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


class TestHttpsProxy:
    """The proxy settings urlopen honours, which the fetch honours as well."""

    class Tunnelled(FakeConnection):
        def __init__(self, host, port=None, timeout=None, context=None):
            super().__init__(host, timeout, context)
            self.port = port
            self.tunnel = None

        def set_tunnel(self, host, port=None, headers=None):
            self.tunnel = (host, headers)

    @pytest.fixture
    def tunnelled(self, monkeypatch):
        monkeypatch.setattr(self.Tunnelled, "connections", 0)
        monkeypatch.setattr(fetch_module, "HTTPSConnection", self.Tunnelled)
        return self.Tunnelled

    def test_a_proxy_tunnels_to_the_host(
        self, tmp_path, no_proxy_environment, tunnelled
    ):
        no_proxy_environment.setenv("HTTPS_PROXY", "http://proxy.example:3128")

        connection = TerrariumTiles(tmp_path)._connection("s3.amazonaws.com")

        assert isinstance(connection, tunnelled)
        assert (connection.host, connection.port) == ("proxy.example", 3128)
        assert connection.tunnel == ("s3.amazonaws.com", {})

    @pytest.mark.usefixtures("tunnelled")
    @pytest.mark.parametrize(
        ("proxy", "port"),
        [("proxy.example", 80), ("https://proxy.example", 443)],
    )
    def test_a_proxy_without_a_port_or_scheme(
        self, tmp_path, no_proxy_environment, proxy, port
    ):
        no_proxy_environment.setenv("https_proxy", proxy)

        connection = TerrariumTiles(tmp_path)._connection("s3.amazonaws.com")

        assert (connection.host, connection.port) == ("proxy.example", port)

    @pytest.mark.usefixtures("tunnelled")
    def test_credentials_in_the_proxy_url_authorize(
        self, tmp_path, no_proxy_environment
    ):
        no_proxy_environment.setenv(
            "HTTPS_PROXY", "http://me:p%40ss@proxy.example:8080"
        )

        connection = TerrariumTiles(tmp_path)._connection("s3.amazonaws.com")

        assert isinstance(connection, self.Tunnelled)
        assert connection.tunnel == (
            "s3.amazonaws.com",
            {"Proxy-Authorization": "Basic bWU6cEBzcw=="},
        )

    @pytest.mark.usefixtures("tunnelled")
    def test_no_proxy_for_the_host_connects_directly(
        self, tmp_path, no_proxy_environment
    ):
        no_proxy_environment.setenv("HTTPS_PROXY", "http://proxy.example:3128")
        no_proxy_environment.setenv("NO_PROXY", "amazonaws.com")

        connection = TerrariumTiles(tmp_path)._connection("s3.amazonaws.com")

        assert isinstance(connection, self.Tunnelled)
        assert connection.host == "s3.amazonaws.com"
        assert connection.tunnel is None

    def test_the_connection_is_kept_for_the_host(
        self, tmp_path, no_proxy_environment, tunnelled
    ):
        no_proxy_environment.setenv("HTTPS_PROXY", "http://proxy.example:3128")
        tiles = TerrariumTiles(tmp_path)

        first = tiles._connection("s3.amazonaws.com")

        assert tiles._connection("s3.amazonaws.com") is first
        assert tunnelled.connections == 1


class TestTerrariumTiles:
    def test_a_getter_of_its_own_replaces_the_connection(self, tmp_path, connections):
        """The browser build fetches with the worker's XMLHttpRequest."""
        asked = []

        def get(url):
            asked.append(url)
            return 200, _tile_png(250.0)

        tiles = TerrariumTiles(tmp_path / "terrain", get=get, workers=1)
        tile = TileKey(10, 546, 341)

        assert tiles.pixels({tile: [0]}) == {tile: array("d", [250.0])}
        assert asked == [
            "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/546/341.png"
        ]
        assert connections.connections == 0

    def test_one_worker_fetches_in_this_thread(self, tmp_path):
        """Where no thread can be started (Pyodide), none is."""
        import threading

        threads = set()

        def get(url):
            threads.add(threading.current_thread())
            return 200, _tile_png(250.0)

        tiles = TerrariumTiles(tmp_path / "terrain", get=get, workers=1)
        wanted = {TileKey(10, x, 1): [0] for x in range(3)}

        assert len(tiles.pixels(wanted)) == 3
        assert threads == {threading.main_thread()}

    def test_a_getter_that_fails_is_taken_like_a_lost_connection(self, tmp_path):
        def get(url):
            raise OSError("no network")

        tiles = TerrariumTiles(tmp_path / "terrain", get=get, workers=1)

        assert tiles.pixels({TileKey(10, 546, 341): [0]}) == {}

    def test_fetches_a_tile_once_and_reuses_the_cache(self, tmp_path, connections):
        body = _tile_png(250.0)
        tiles = TerrariumTiles(tmp_path / "terrain")
        tile = TileKey(10, 546, 341)

        first = tiles.pixels({tile: [0, 65535]})
        second = TerrariumTiles(tmp_path / "terrain").pixels({tile: [7]})

        assert first == {tile: array("d", [250.0, 250.0])}
        assert second == {tile: array("d", [250.0])}
        assert connections.requests == [
            "/elevation-tiles-prod/terrarium/10/546/341.png"
        ]
        assert connections.connections == 1
        assert tiles.path(tile).read_bytes() == body

    def test_one_connection_carries_the_tiles_of_a_thread(
        self, tmp_path, monkeypatch, connections
    ):
        """A handshake per tile would take longer than the tiles themselves."""
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        opened = []
        original = connections.__init__

        def record(self, host, timeout=None, context=None):
            original(self, host, timeout, context)
            opened.append((host, timeout, context))

        monkeypatch.setattr(connections, "__init__", record)
        wanted = {TileKey(10, x, 1): [0] for x in range(5)}

        tiles = TerrariumTiles(tmp_path)
        assert len(tiles.pixels(wanted)) == 5
        assert len(connections.requests) == 5
        # And closed once the downloads are done
        assert connections.closed == 1
        assert opened == [
            (
                "s3.amazonaws.com",
                fetch_module.FETCH_TIMEOUT_SECONDS,
                tiles._ssl_context,
            )
        ]

    def test_sends_the_user_agent(self, tmp_path, monkeypatch):
        seen = {}

        class Recording(FakeConnection):
            def request(self, method, path, headers=None):
                seen["headers"] = headers
                super().request(method, path, headers)

        monkeypatch.setattr(fetch_module, "HTTPSConnection", Recording)
        TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]})
        assert seen["headers"]["User-Agent"].startswith("flown/")

    def test_pixels_that_cannot_be_kept_are_decoded_again(self, tmp_path, caplog):
        """Keeping them is a saving for the next build, never a failure."""
        with caplog.at_level(logging.DEBUG, logger="flown"):
            pixels_module._keep_pixel_planes(
                tmp_path / "missing" / "10-546-341.png", b"png", b"planes"
            )
        assert "Cannot keep the pixels of 10-546-341.png" in caplog.text
        assert list(tmp_path.iterdir()) == []

    def test_a_tile_the_host_does_not_have_is_missing(self, tmp_path, monkeypatch):
        def answer(path):
            if path.endswith("/1/1.png"):
                return FakeResponse(403, b"Forbidden")
            return FakeResponse(200, _tile_png(10.0))

        monkeypatch.setattr(fetch_module, "HTTPSConnection", _answers(answer))
        wanted = {TileKey(10, 1, 1): [0], TileKey(10, 2, 1): [0]}

        answered = TerrariumTiles(tmp_path).pixels(wanted)

        assert answered == {TileKey(10, 2, 1): array("d", [10.0])}

    @pytest.mark.parametrize(
        "error",
        [
            ConnectionResetError("no network"),
            TimeoutError("timed out"),
            http.client.IncompleteRead(b""),
            http.client.RemoteDisconnected("closed"),
        ],
    )
    def test_offline_stops_asking_and_does_not_fail(
        self, tmp_path, monkeypatch, connections, error
    ):
        def answer(path):
            raise error

        connections.answer = staticmethod(answer)
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        monkeypatch.setattr(fetch_module, "FETCH_RETRY_SECONDS", 0.0)
        wanted = {TileKey(10, x, 1): [0] for x in range(5)}

        assert TerrariumTiles(tmp_path).pixels(wanted) == {}
        # Every attempt of the first tile, and none of the others
        assert len(connections.requests) == fetch_module.FETCH_ATTEMPTS
        # A fresh connection for every attempt: the old one is in no known
        # state after a failure on the way
        assert connections.connections == fetch_module.FETCH_ATTEMPTS

    def test_a_server_error_on_every_attempt_does_not_give_the_host_up(
        self, tmp_path, monkeypatch, connections
    ):
        """A 503 is the host answering: the other tiles may well get through."""
        seen = []

        def answer(path):
            seen.append(path)
            if path.endswith("/0/1.png"):
                return FakeResponse(503, b"later")
            return FakeResponse(200, _tile_png(10.0))

        connections.answer = staticmethod(answer)
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        wanted = {TileKey(10, x, 1): [0] for x in range(3)}

        answered = TerrariumTiles(tmp_path).pixels(wanted)

        assert set(answered) == {TileKey(10, 1, 1), TileKey(10, 2, 1)}
        assert len(seen) == fetch_module.FETCH_ATTEMPTS + 2

    def test_a_host_that_answers_every_tile_with_a_server_error_is_given_up(
        self, tmp_path, monkeypatch, connections
    ):
        """Every tile's attempts and pauses would take minutes for a run."""
        connections.answer = staticmethod(lambda path: FakeResponse(503, b"later"))
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        wanted = {TileKey(10, x, 1): [0] for x in range(10)}
        tiles = TerrariumTiles(tmp_path)

        assert tiles.pixels(wanted) == {}
        given_up_after = fetch_module.SERVER_ERROR_TILES_TO_GIVE_UP
        assert len(connections.requests) == (
            given_up_after * fetch_module.FETCH_ATTEMPTS
        )
        assert tiles._offline.is_set()

    def test_a_tile_that_gets_through_resets_the_server_errors(
        self, tmp_path, monkeypatch, connections
    ):
        """Only tiles in a row give the host up."""
        failing = {1, 2, 4, 5, 7, 8}

        def answer(path):
            x = int(path.rsplit("/", 2)[1])
            if x in failing:
                return FakeResponse(503, b"later")
            return FakeResponse(200, _tile_png(10.0))

        connections.answer = staticmethod(answer)
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        wanted = {TileKey(10, x, 1): [0] for x in range(10)}
        tiles = TerrariumTiles(tmp_path)

        answered = tiles.pixels(wanted)

        assert set(answered) == {TileKey(10, x, 1) for x in (0, 3, 6, 9)}
        assert not tiles._offline.is_set()

    @pytest.mark.parametrize(
        "glitch",
        [
            ConnectionResetError("connection reset"),
            TimeoutError("timed out"),
            FakeResponse(503, b"Unavailable"),
            FakeResponse(429, b"Too Many"),
        ],
    )
    def test_a_glitch_is_tried_again(self, tmp_path, monkeypatch, glitch):
        """One dropped connection must not leave the other tiles unfetched."""
        glitched = set()

        def answer(path):
            if path not in glitched:
                glitched.add(path)
                if isinstance(glitch, Exception):
                    raise glitch
                return glitch
            return FakeResponse(200, _tile_png(10.0))

        pauses: list[float] = []
        monkeypatch.setattr(fetch_module, "HTTPSConnection", _answers(answer))
        monkeypatch.setattr("flown.terrain_fetch.time.sleep", pauses.append)
        wanted = {TileKey(10, x, 1): [0] for x in range(3)}

        answered = TerrariumTiles(tmp_path).pixels(wanted)

        assert answered == {tile: array("d", [10.0]) for tile in wanted}
        assert pauses == [fetch_module.FETCH_RETRY_SECONDS] * 3

    def test_a_host_given_up_meanwhile_is_not_asked_again(
        self, tmp_path, monkeypatch, connections
    ):
        """Another tile's fetch may give the host up while this one pauses."""

        def answer(path):
            raise TimeoutError("slow")

        connections.answer = staticmethod(answer)
        tiles = TerrariumTiles(tmp_path)
        monkeypatch.setattr(
            "flown.terrain_fetch.time.sleep", lambda _: tiles._offline.set()
        )

        assert tiles.pixels({TileKey(10, 1, 1): [0]}) == {}
        assert len(connections.requests) == 1

    def test_the_pause_grows_with_every_attempt(self, tmp_path, monkeypatch):
        pauses: list[float] = []

        def answer(path):
            raise TimeoutError("slow")

        monkeypatch.setattr(fetch_module, "HTTPSConnection", _answers(answer))
        monkeypatch.setattr("flown.terrain_fetch.time.sleep", pauses.append)

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert pauses == [
            fetch_module.FETCH_RETRY_SECONDS * 2**attempt
            for attempt in range(fetch_module.FETCH_ATTEMPTS - 1)
        ]

    def test_a_tile_the_host_refuses_is_not_asked_again(self, tmp_path, connections):
        connections.answer = staticmethod(lambda path: FakeResponse(404, b"gone"))

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert len(connections.requests) == 1

    @pytest.mark.parametrize(
        ("location", "moved_to"),
        [
            ("https://s3.amazonaws.com/moved/1/1.png", "/moved/1/1.png"),
            # Relative to the URL it answers, on the same host
            ("/moved/1/1.png", "/moved/1/1.png"),
            ("../moved.png", "/elevation-tiles-prod/terrarium/10/moved.png"),
        ],
    )
    def test_follows_a_redirect_on_the_host(
        self, tmp_path, connections, location, moved_to
    ):
        def answer(path):
            if path.endswith("/10/1/1.png"):
                return FakeResponse(302, b"", {"Location": location})
            return FakeResponse(200, _tile_png(10.0))

        connections.answer = staticmethod(answer)

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {
            TileKey(10, 1, 1): array("d", [10.0])
        }
        assert connections.requests[-1] == moved_to

    @pytest.mark.parametrize(
        "target",
        [
            "https://evil.example/1/1.png",
            "http://s3.amazonaws.com/1/1.png",
            "",
        ],
    )
    def test_refuses_a_redirect_off_the_host_or_off_https(
        self, tmp_path, connections, target
    ):
        """The request must not end up at a host nobody chose."""
        connections.answer = staticmethod(
            lambda path: FakeResponse(301, b"", {"Location": target})
        )

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert all(path.endswith("/10/1/1.png") for path in connections.requests)
        assert "evil.example" not in "".join(connections.requests)

    def test_a_refused_redirect_costs_only_its_tile(
        self, tmp_path, monkeypatch, connections
    ):
        """The host answered: it stays online, and the tile is not asked again."""

        def answer(path):
            if path.endswith("/10/0/1.png"):
                return FakeResponse(302, b"", {"Location": "https://evil.example/"})
            return FakeResponse(200, _tile_png(10.0))

        connections.answer = staticmethod(answer)
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        wanted = {TileKey(10, x, 1): [0] for x in range(3)}
        tiles = TerrariumTiles(tmp_path)

        answered = tiles.pixels(wanted)

        assert set(answered) == {TileKey(10, 1, 1), TileKey(10, 2, 1)}
        assert len(connections.requests) == 3
        assert not tiles._offline.is_set()

    def test_gives_up_after_too_many_redirects(self, tmp_path, connections):
        connections.answer = staticmethod(
            lambda path: FakeResponse(
                307, b"", {"Location": "https://s3.amazonaws.com" + path + "/again"}
            )
        )

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}

    def test_refuses_a_tile_url_that_is_not_https(
        self, tmp_path, monkeypatch, connections
    ):
        monkeypatch.setattr(fetch_module, "TILE_URL", "http://host/{z}/{x}/{y}.png")

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert connections.requests == []

    @pytest.mark.parametrize(
        "body",
        [
            b"<html>not found</html>",
            b"\x89PNG\r\n\x1a\n" + b"junk",
            # Cut off after the header: the chunks up to it are intact
            _tile_png()[:33],
            # A sound PNG, but not a tile's size
            encode_png(4, 4, bytes(48)),
        ],
    )
    def test_refuses_a_body_that_is_no_tile(self, tmp_path, connections, body):
        """Nothing but a complete PNG of a tile's size reaches the cache."""
        connections.answer = staticmethod(lambda path: FakeResponse(200, body))
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)

        assert tiles.pixels({tile: [0]}) == {}
        assert not tiles.path(tile).exists()
        assert list(tmp_path.iterdir()) == []

    def test_refuses_an_oversized_body(self, tmp_path, monkeypatch, connections):
        """The default answer is a sound tile, refused only for its size."""
        monkeypatch.setattr(fetch_module, "MAX_TILE_BYTES", 10)

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert list(tmp_path.iterdir()) == []
        assert len(connections.requests) == 1

    def test_an_oversized_body_leaves_the_next_tile_a_fresh_connection(
        self, tmp_path, monkeypatch, connections
    ):
        """The rest of a body cut short would answer the next request."""
        normal = _tile_png(10.0)
        monkeypatch.setattr(fetch_module, "MAX_TILE_BYTES", len(normal) + 10)
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)

        class Pipelined(FakeConnection):
            # Like http.client: an answer not read to the end blocks the next
            last: FakeResponse | None = None

            def getresponse(self):
                if self.last is not None and not self.last.isclosed():
                    raise http.client.ResponseNotReady("Idle")
                self.last = super().getresponse()
                return self.last

            @staticmethod
            def answer(path):
                if path.endswith("/1/1.png"):
                    return FakeResponse(200, b"x" * (len(normal) + 100))
                return FakeResponse(200, normal)

        monkeypatch.setattr(fetch_module, "HTTPSConnection", Pipelined)
        tiles = TerrariumTiles(tmp_path)

        answered = tiles.pixels({TileKey(10, 1, 1): [0], TileKey(10, 2, 1): [0]})

        assert Pipelined.requests == [
            "/elevation-tiles-prod/terrarium/10/1/1.png",
            "/elevation-tiles-prod/terrarium/10/2/1.png",
        ]
        assert answered == {TileKey(10, 2, 1): array("d", [10.0])}
        assert not tiles._offline.is_set()
        assert Pipelined.connections == 2

    def test_an_unwritable_cache_degrades(self, tmp_path, connections):
        blocker = tmp_path / "file"
        blocker.write_text("")

        answered = TerrariumTiles(blocker / "terrain").pixels({TileKey(10, 1, 1): [0]})

        assert answered == {}
        assert connections.requests == []

    def test_a_tile_that_cannot_be_stored_is_missing(
        self, tmp_path, monkeypatch, connections
    ):
        replace = MagicMock(side_effect=OSError("full"))
        monkeypatch.setattr(os, "replace", replace)

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert list(tmp_path.iterdir()) == []
        # The sound tile got as far as being stored
        replace.assert_called_once()

    def test_kept_pixels_of_an_older_version_are_decoded_again(self, tmp_path):
        """Version 1 kept them with zlib; the header tells them apart."""
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)
        png = _tile_png(123.0)
        tiles.path(tile).write_bytes(png)
        kept = tmp_path / "10-1-1.pixels"
        planes = pixels_module._decode_planes(png)
        kept.write_bytes(
            pixels_module._PIXELS_HEADER.pack(b"KHTP", 1, zlib.crc32(png))
            + zlib.compress(planes, 6)
        )

        assert tiles.pixels({tile: [0]}) == {tile: array("d", [123.0])}
        header = pixels_module._PIXELS_HEADER.unpack_from(kept.read_bytes())
        assert header == (b"KHTP", pixels_module._PIXELS_VERSION, zlib.crc32(png))

    def test_the_pixels_of_a_decoded_tile_are_kept(self, tmp_path, monkeypatch):
        """The next build reads them instead of decoding the PNG again."""
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)
        tiles.path(tile).write_bytes(terrarium_png(lambda x, y: x * 3.5 - y))
        first = tiles.pixels({tile: [0, 5, 65535]})
        assert (tmp_path / "10-1-1.pixels").is_file()

        decode = MagicMock(side_effect=AssertionError("decoded again"))
        monkeypatch.setattr(pixels_module, "decode_png", decode)
        second = TerrariumTiles(tmp_path).pixels({tile: [0, 5, 65535]})

        assert second == first == {tile: array("d", [0.0, 17.5, 892.5 - 255])}

    @pytest.mark.parametrize(
        "damage",
        [
            lambda kept: kept[:-10],
            lambda kept: b"XXXX" + kept[4:],
            # The kept pixels of another PNG than the one in the cache
            lambda kept: kept[:5] + bytes(4) + kept[9:],
            lambda kept: b"",
        ],
    )
    def test_kept_pixels_that_do_not_fit_are_decoded_again(self, tmp_path, damage):
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)
        tiles.path(tile).write_bytes(_tile_png(123.0))
        tiles.pixels({tile: [0]})
        kept = tmp_path / "10-1-1.pixels"
        kept.write_bytes(damage(kept.read_bytes()))

        assert tiles.pixels({tile: [0]}) == {tile: array("d", [123.0])}
        # And kept again as they should be
        assert TerrariumTiles(tmp_path).pixels({tile: [7]}) == {
            tile: array("d", [123.0])
        }
        assert kept.read_bytes()[:4] == b"KHTP"

    def test_a_corrupt_cached_tile_is_removed(self, tmp_path):
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)
        tiles.path(tile).write_bytes(_tile_png()[:-20])

        assert tiles.pixels({tile: [0]}) == {}
        assert not tiles.path(tile).exists()

    def test_the_temp_files_of_a_killed_build_are_removed(self, tmp_path):
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)
        tiles.path(tile).write_bytes(_tile_png(3.0))
        stale = tmp_path / ".10-1-1.png.k2j3.tmp"
        stale_pixels = tmp_path / ".10-1-1.pixels.x9q1.tmp"
        fresh = tmp_path / ".10-2-1.png.a8b7.tmp"
        for path in (stale, stale_pixels, fresh):
            path.write_bytes(b"half")
        day_ago = time.time() - fetch_module.STALE_TEMP_SECONDS - 60
        for path in (stale, stale_pixels):
            os.utime(path, (day_ago, day_ago))

        assert tiles.pixels({tile: [0]}) == {tile: array("d", [3.0])}

        assert not stale.exists()
        assert not stale_pixels.exists()
        # Perhaps a write of another build still going on
        assert fresh.exists()
        assert tiles.remove_stale_temp_files() == 0
        assert TerrariumTiles(tmp_path / "none").remove_stale_temp_files() == 0

    def test_decodes_many_tiles_in_a_pool(self, tmp_path):
        tiles = TerrariumTiles(tmp_path)
        wanted = {}
        for x in range(fetch_module.DECODE_POOL_MIN_TILES):
            tile = TileKey(10, x, 1)
            tiles.path(tile).write_bytes(_tile_png(float(x)))
            wanted[tile] = [0, 1]

        answered = tiles.pixels(wanted)

        assert answered == {tile: array("d", [tile.x, tile.x]) for tile in wanted}

    @pytest.mark.parametrize(("version", "pooled"), [(1, True), (None, False)])
    def test_pixels_of_an_older_version_are_decoded_in_the_pool(
        self, tmp_path, monkeypatch, version, pooled
    ):
        """After an upgrade every tile is decoded again: not one by one."""
        tiles = TerrariumTiles(tmp_path)
        wanted = {}
        for x in range(fetch_module.DECODE_POOL_MIN_TILES):
            tile = TileKey(10, x, 1)
            png = _tile_png(float(x))
            tiles.path(tile).write_bytes(png)
            wanted[tile] = [0]
            planes = pixels_module._decode_planes(png)
            if version is None:
                pixels_module._keep_pixel_planes(tiles.path(tile), png, planes)
            else:
                (tmp_path / f"10-{x}-1.pixels").write_bytes(
                    pixels_module._PIXELS_HEADER.pack(b"KHTP", version, zlib.crc32(png))
                    + zlib.compress(planes, 6)
                )

        class InlinePool:
            started = 0

            def __init__(self, max_workers, initializer, initargs):
                InlinePool.started += 1

            def __enter__(self):
                return self

            def map(self, fn, *iterables, chunksize=1, **_kwargs):
                return map(fn, *iterables, strict=True)

            def shutdown(self, *_args, **_kwargs):
                pass

        monkeypatch.setattr(workers_module, "ProcessPoolExecutor", InlinePool)

        answered = tiles.pixels(wanted)

        assert answered == {tile: array("d", [tile.x]) for tile in wanted}
        assert InlinePool.started == (1 if pooled else 0)

    @staticmethod
    def _pooled_points(tiles):
        """A point in each of as many cached tiles as start the pool."""
        points = [
            TrackPoint(50.0, 8.0 + x * 0.5, 0.0)
            for x in range(fetch_module.DECODE_POOL_MIN_TILES)
        ]
        for point in points:
            gx, gy = _global_pixel(point.lat, point.lon)
            tiles.path(
                TileKey(TERRAIN_ZOOM, int(gx) // TILE_SIZE, int(gy) // TILE_SIZE)
            ).write_bytes(_tile_png(7.0))
        return points

    def test_the_decoding_workers_log_at_the_parents_level(self, tmp_path, monkeypatch):
        """--debug names the tiles a worker could not use."""
        tiles = TerrariumTiles(tmp_path)
        points = self._pooled_points(tiles)
        pool = MagicMock(side_effect=OSError("no semaphores"))
        monkeypatch.setattr(workers_module, "ProcessPoolExecutor", pool)

        monkeypatch.setattr(logger, "getEffectiveLevel", lambda: logging.DEBUG)

        sample_path_elevations({1: points}, tiles)

        kwargs = pool.call_args.kwargs
        assert kwargs["initializer"] is init_worker
        assert kwargs["initargs"] == (logging.DEBUG,)

    @staticmethod
    def _failing_pool(at_start=None, in_map=None):
        """A process pool that cannot start, or whose workers fail."""
        if at_start is not None:
            return MagicMock(side_effect=at_start)
        pool = MagicMock()
        pool.return_value.map.side_effect = in_map
        return pool

    @pytest.mark.parametrize(
        ("at_start", "in_map"),
        [
            (None, BrokenProcessPool("a worker died")),
            # A worker out of memory raises it to the parent as it is
            (None, MemoryError()),
            (OSError("no semaphores"), None),
        ],
    )
    def test_a_decoding_pool_that_dies_decodes_the_tiles_here(
        self, tmp_path, monkeypatch, caplog, at_start, in_map
    ):
        tiles = TerrariumTiles(tmp_path)
        points = self._pooled_points(tiles)
        pool = self._failing_pool(at_start, in_map)
        monkeypatch.setattr(workers_module, "ProcessPoolExecutor", pool)

        with caplog.at_level(logging.WARNING, logger="flown"):
            by_path = sample_path_elevations({1: points}, tiles)

        assert list(by_path[1]) == [7.0] * len(points)
        pool.assert_called_once()
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        message = warnings[0].getMessage()
        assert "decoding the elevation tiles" in message
        assert "going on in this process" in message

    def test_tiles_that_cannot_be_decoded_here_either_leave_the_ground_out(
        self, tmp_path, monkeypatch, caplog
    ):
        tiles = TerrariumTiles(tmp_path)
        points = self._pooled_points(tiles)
        monkeypatch.setattr(
            workers_module,
            "ProcessPoolExecutor",
            self._failing_pool(in_map=BrokenProcessPool("a worker died")),
        )
        monkeypatch.setattr(
            fetch_module, "decode_cached_tile", MagicMock(side_effect=MemoryError)
        )

        with caplog.at_level(logging.WARNING, logger="flown"):
            by_path = sample_path_elevations({1: points}, tiles)

        assert by_path == {}
        warnings = [r.getMessage() for r in caplog.records]
        assert "could not be decoded" in warnings[-1]

    def test_required_terrain_fails_without_a_tile(self, monkeypatch):
        monkeypatch.setenv(terrain_module.REQUIRE_TERRAIN_ENV, "1")
        paths = {1: [TrackPoint(50.0, 8.0, 0.0)]}
        x, y = _global_pixel(50.0, 8.0)
        missing = TileKey(TERRAIN_ZOOM, int(x) // TILE_SIZE, int(y) // TILE_SIZE)

        with pytest.raises(TerrainUnavailableError, match="REQUIRE_TERRAIN"):
            sample_path_elevations(
                paths, FunctionTiles(lambda gx, gy: 5.0, missing=[missing])
            )
        # Every tile there: nothing to complain about
        assert list(sample_path_elevations(paths, FlatTiles(5.0))) == [1]

    def test_required_terrain_fails_without_a_decoder(self, tmp_path, monkeypatch):
        monkeypatch.setenv(terrain_module.REQUIRE_TERRAIN_ENV, "1")

        class Broken:
            def pixels(self, wanted):
                raise terrain_module.DecodeFailedError("a worker died")

        with pytest.raises(TerrainUnavailableError, match="could not be decoded"):
            sample_path_elevations({1: [TrackPoint(50.0, 8.0, 0.0)]}, Broken())

    def test_a_download_in_a_test_fails_loudly(self, tmp_path):
        # conftest.py refuses every download; the tile code must not swallow
        # that as an offline network
        with pytest.raises(AssertionError, match="network"):
            TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]})

    def test_the_default_cache_is_below_the_cache_directory(self):
        from flown.cache import CACHE_DIR

        assert TerrariumTiles().cache_dir == CACHE_DIR / "terrain"


# --- The ground of a flight ---------------------------------------------


def _row(lon, altitude_ft, speed, lat=50.0):
    return [lat, lon, altitude_ft, speed]


def _flight(from_ft, to_ft):
    """Taxiing at a field, a flight east, taxiing at another field."""
    return [
        _row(8.01, from_ft, 5),
        _row(8.02, from_ft, 10),
        _row(8.03, from_ft + 100, 8),
        _row(8.04, 3000, 110),
        _row(8.05, 3000, 115),
        _row(8.06, to_ft, 12),
        _row(8.07, to_ft, 6),
        _row(8.08, to_ft, 3),
    ]


def _elevations(rows, metres_of):
    return {(row[0], row[1]): metres_of(row[1]) for row in rows}


START = [50.0, 8.0]


class TestGroundProfile:
    def test_a_flat_model_gives_the_line_between_the_fields(self):
        rows = _flight(400, 2000)

        ground = ground_profile_ft(START, rows, _elevations(rows, lambda lon: 0.0))

        # What groundProfileFt draws without a ground column: the fields at
        # both ends and the line in proportion to the distance between them
        expected = [400 + 1600 * (i + 1) / 8 for i in range(8)]
        assert ground == [round(feet / 10) * 10 for feet in expected]

    def test_follows_the_relief_and_meets_the_fields(self):
        rows = _flight(400, 400)
        # The model is 30 m below the recorded fields and has a ridge between
        ridge = {8.04: 300.0, 8.05: 300.0}
        elevations = _elevations(
            rows, lambda lon: ridge.get(lon, 400 / METERS_TO_FEET - 30)
        )

        ground = ground_profile_ft(START, rows, elevations)

        assert ground is not None
        assert ground[0] == 400
        assert ground[-1] == 400
        # The ridge, lifted by the same 30 m the fields are off by
        assert ground[3] == round((300 + 30) * METERS_TO_FEET / 10) * 10

    def test_shifts_from_the_one_offset_to_the_other(self):
        rows = _flight(400, 1000)

        # The model rises by 100 m from the one field to the other, less
        # than the recorded fields do
        def metres(lon):
            return 0.0 if lon <= 8.03 else 100.0 if lon >= 8.06 else 50.0

        ground = ground_profile_ft(START, rows, _elevations(rows, metres))

        start_offset = 400
        end_offset = 1000 - 100 * METERS_TO_FEET
        expected = [
            metres(row[1]) * METERS_TO_FEET
            + start_offset
            + (end_offset - start_offset) * (i + 1) / 8
            for i, row in enumerate(rows)
        ]
        assert ground == [round(feet / 10) * 10 for feet in expected]
        assert ground[-1] == 1000

    def test_one_field_holds_all_the_way(self):
        rows = _flight(400, 1000)[3:]

        ground = ground_profile_ft(
            [50.0, 8.03], rows, _elevations(rows, lambda lon: 100.0)
        )

        offset = 1000 - 100 * METERS_TO_FEET
        assert ground == [round((100 * METERS_TO_FEET + offset) / 10) * 10] * 5

    def test_without_fields_the_model_is_the_ground(self):
        rows = [_row(8.01 + i / 100, 3000, 110) for i in range(4)]

        ground = ground_profile_ft(START, rows, _elevations(rows, lambda lon: 100.0))

        assert ground == [round(100 * METERS_TO_FEET / 10) * 10] * 4

    def test_a_speed_of_zero_is_no_speed(self):
        # A path without timing: every speed is 0, none of it is taxiing
        rows = [_row(8.01 + i / 100, 3000, 0.0) for i in range(4)]

        ground = ground_profile_ft(START, rows, _elevations(rows, lambda lon: 0.0))

        assert ground == [0, 0, 0, 0]

    def test_too_little_taxiing_is_no_field(self):
        rows = [_row(8.01, 400, 5), _row(8.02, 400, 5), *_flight(0, 0)[3:5]]

        ground = ground_profile_ft(START, rows, _elevations(rows, lambda lon: 0.0))

        assert ground == [0, 0, 0, 0]

    def test_no_ground_with_a_hole_in_the_model(self):
        rows = _flight(400, 400)
        elevations = _elevations(rows, lambda lon: 0.0)
        del elevations[(50.0, 8.05)]

        assert ground_profile_ft(START, rows, elevations) is None

    def test_no_ground_without_rows(self):
        assert ground_profile_ft([], [], {}) is None

    def test_measures_the_way_across_the_antimeridian(self):
        rows = [
            _row(179.99, 400, 5),
            _row(179.995, 400, 5),
            _row(179.999, 400, 5),
            _row(-179.99, 3000, 110),
            _row(-179.98, 1200, 5),
            _row(-179.97, 1200, 5),
            _row(-179.96, 1200, 5),
        ]

        ground = ground_profile_ft(
            [50.0, 179.98], rows, _elevations(rows, lambda lon: 0.0)
        )

        # Seven short legs, not one round the world: the ground climbs
        # steadily rather than jumping to the far field at once
        assert ground is not None
        assert ground[3] < 1000
        assert ground == sorted(ground)


# --- Parity with the frontend -------------------------------------------

FRONTEND = Path(__file__).parent.parent / "flown" / "frontend"


_TS_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
}


def _ts_evaluate(node, lookup):
    """A numeric TypeScript initializer, which Python parses the same way.

    Numbers, the four operators and ``**``, and the names of other constants
    of the same file: ``2 ** 40`` or ``1.0 / NAUTICAL_MILES_TO_KM``. Anything
    else fails the test rather than being guessed at.
    """
    match node:
        case ast.Constant(value=int() | float() as value):
            return float(value)
        case ast.Name(id=name):
            return lookup(name)
        case ast.BinOp(left=left, op=op, right=right) if type(op) in _TS_OPERATORS:
            return _TS_OPERATORS[type(op)](
                _ts_evaluate(left, lookup), _ts_evaluate(right, lookup)
            )
        case ast.UnaryOp(op=ast.USub(), operand=operand):
            return -_ts_evaluate(operand, lookup)
    raise AssertionError(f"cannot evaluate {ast.unparse(node)}")


def _ts_constant(relative, name):
    source = (FRONTEND / relative).read_text(encoding="utf-8")

    def value(constant):
        match = re.search(rf"\bconst {constant}(?:: \w+)? = ([^;]+);", source)
        assert match, f"{constant} not found in {relative}"
        expression = ast.parse(match.group(1).strip(), mode="eval").body
        return _ts_evaluate(expression, value)

    return value(name)


@pytest.mark.parametrize(
    ("relative", "name", "value"),
    [
        ("services/yearDecode.ts", "DATA_FORMAT_VERSION", FORMAT_VERSION),
        ("services/yearDecode.ts", "GROUND_STEP", GROUND_STEP),
        ("services/yearDecode.ts", "ALTITUDE_STEP", ALTITUDE_STEP),
        ("calculations/groundProfile.ts", "TAXI_KNOTS", terrain_module.TAXI_KNOTS),
        (
            "calculations/groundProfile.ts",
            "TAXI_MIN_FIXES",
            terrain_module.TAXI_MIN_FIXES,
        ),
        (
            "utils/geometry.ts",
            "METRES_PER_DEGREE",
            METRES_PER_DEGREE,
        ),
        ("services/yearDecode.ts", "COORDINATE_SCALE", COORDINATE_SCALE),
        ("services/yearDecode.ts", "SPEED_SCALE", SPEED_SCALE),
        ("services/yearDecode.ts", "TIME_SCALE", TIME_SCALE),
        # The page draws the relief from the tiles the ground was sampled
        # from, and no finer
        ("calculations/liftZoom.ts", "TERRAIN_TILE_MAX_ZOOM", TERRAIN_ZOOM),
        # The units the altitudes and distances are exported and shown in
        ("utils/constants.ts", "METERS_TO_FEET", METERS_TO_FEET),
        ("utils/constants.ts", "KM_TO_NAUTICAL_MILES", KM_TO_NAUTICAL_MILES),
        # A link names its flights by id, and ids are content hashes
        ("state/urlState.ts", "PATH_ID_LIMIT", 2**PATH_ID_BITS),
    ],
)
def test_the_frontend_reads_what_the_exporter_writes(relative, name, value):
    """The two sides of the ground column share their numbers."""
    assert _ts_constant(relative, name) == value


@pytest.mark.parametrize(
    ("expression", "value"),
    [
        ("2 ** 40", 2.0**40),
        ("1.0 / 1.852", 1.0 / 1.852),
        ("-3.5e2", -350.0),
    ],
)
def test_the_parity_check_reads_expressions(expression, value):
    """Constants written as expressions are read, not skipped (regression)."""
    node = ast.parse(expression, mode="eval").body
    assert _ts_evaluate(node, pytest.fail) == value


def test_the_parity_check_refuses_what_it_cannot_read():
    node = ast.parse("Math.max(1, 2)", mode="eval").body
    with pytest.raises(AssertionError, match="cannot evaluate"):
        _ts_evaluate(node, lambda name: 0.0)


def test_the_frontend_asks_for_tiles_of_the_size_they_are():
    """The relief source is told the size of the tiles the ground came from.

    The size is a constant of calculations/lift.ts, which reliefPixelM
    measures the relief's pixels with as well.
    """
    source = (FRONTEND / "ui" / "terrain.ts").read_text(encoding="utf-8")
    match = re.search(r'type: "raster-dem",[^}]*?\btileSize: (\w+),', source)
    assert match, "the raster-dem source's tileSize not found in ui/terrain.ts"
    assert match.group(1) == "TERRAIN_TILE_SIZE_PX"
    assert _ts_constant("calculations/lift.ts", "TERRAIN_TILE_SIZE_PX") == TILE_SIZE


def test_the_frontend_draws_the_relief_from_the_same_tiles():
    source = (FRONTEND / "ui" / "terrain.ts").read_text(encoding="utf-8")
    match = re.search(r'\bconst TERRAIN_TILE_URL =\s*"([^"]+)";', source)
    assert match, "TERRAIN_TILE_URL not found in ui/terrain.ts"
    assert match.group(1) == fetch_module.TILE_URL
