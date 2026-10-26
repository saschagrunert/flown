"""Tests for the ground under the flights (flown.terrain).

No test reaches the network: the tiles are made here, as PNGs written by the
small encoder of tests/tiles.py, or answered by a tile source of the test's
own. conftest.py makes any download fail loudly. The download and the cache
of the tiles are tested in test_terrain_fetch.py, the PNG decoder in
test_png.py and the numbers the frontend shares in test_frontend_parity.py.
"""

import json
import logging
import math
from array import array
from pathlib import Path

import pytest

import flown.terrain as terrain_module
import flown.terrain_pixels as pixels_module
from flown.constants import METERS_TO_FEET
from flown.png import PngError
from flown.terrain import (
    TERRAIN_ZOOM,
    TILE_SIZE,
    TileKey,
    _field_offset_ft,
    elevations_by_coordinate,
    ground_profile_ft,
    sample_elevations,
    sample_path_elevations,
)
from flown.types import TrackPoint
from tests.conftest import FlatTiles
from tests.tiles import (
    FunctionTiles,
    encode_png,
    global_pixel,
    path_contents,
    terrarium_png,
)


def _lon_of_pixel(gx, zoom=TERRAIN_ZOOM):
    """The longitude of a global pixel column's centre."""
    return (gx + 0.5) / (TILE_SIZE << zoom) * 360 - 180


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
            x, y = global_pixel(lat, lon)
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
        x, y = global_pixel(*uncovered)
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

        by_path = sample_path_elevations(paths, FlatTiles(42.0), path_contents(paths))

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
            x, y = global_pixel(*point)
            left, top = math.floor(x), math.floor(y)
            tx, ty = x - left, y - top
            upper = at(left, top) + (at(left + 1, top) - at(left, top)) * tx
            lower = at(left, top + 1) + (at(left + 1, top + 1) - at(left, top + 1)) * tx
            assert elevation == upper + (lower - upper) * ty

    def test_warns_once_about_missing_tiles(self, caplog):
        paths = {1: [TrackPoint(50.0, 8.0, 0.0)], 2: [TrackPoint(50.0, 12.0, 0.0)]}
        x, y = global_pixel(50.0, 12.0)
        missing = TileKey(TERRAIN_ZOOM, int(x) // TILE_SIZE, int(y) // TILE_SIZE)

        with caplog.at_level(logging.WARNING, logger="flown"):
            by_path = sample_path_elevations(
                paths,
                FunctionTiles(lambda gx, gy: 5.0, missing=[missing]),
                path_contents(paths),
            )

        assert list(by_path) == [1]
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        assert "1 flight(s)" in warnings[0].getMessage()


class _KeptGround(FunctionTiles):
    """Tiles that keep the ground of the paths in ``ground_dir``, and count
    the pixels they are asked for."""

    def __init__(self, ground_dir, elevation=lambda gx, gy: gx * 0.5 - gy, **kwargs):
        super().__init__(elevation, **kwargs)
        self.ground_dir = ground_dir
        self.pixels_asked = 0

    def pixels(self, wanted):
        self.pixels_asked += sum(len(indices) for indices in wanted.values())
        return super().pixels(wanted)


_KEPT_PATHS = {
    3: [TrackPoint(50.0000004, 8.0, 100.0), TrackPoint(50.1, 8.1, 200.0)],
    7: [TrackPoint(51.0, 9.0, 100.0)],
}


class TestKeptGround:
    def _contents(self, paths=None):
        return path_contents(paths or _KEPT_PATHS)

    def test_a_build_reads_the_ground_the_last_one_sampled(self, tmp_path):
        tiles = _KeptGround(tmp_path / "ground")
        first = sample_path_elevations(_KEPT_PATHS, tiles, self._contents())
        asked = tiles.pixels_asked

        again = sample_path_elevations(_KEPT_PATHS, tiles, self._contents())

        assert asked > 0
        assert tiles.pixels_asked == asked
        assert {i: list(v) for i, v in again.items()} == {
            i: list(v) for i, v in first.items()
        }
        assert len(list((tmp_path / "ground").iterdir())) == 2

    def test_the_ground_at_the_coordinates_as_the_rows_carry_them(self, tmp_path):
        """The contents hold the coordinates as the exporter rounds them."""
        tiles = _KeptGround(tmp_path / "ground")
        by_path = sample_path_elevations(_KEPT_PATHS, tiles, self._contents())

        for index, path in _KEPT_PATHS.items():
            rounded = [(round(p.lat, 6), round(p.lon, 6)) for p in path]
            expected, _, _ = sample_elevations(rounded, FunctionTiles(tiles.elevation))
            assert list(by_path[index]) == list(expected)

    def test_a_changed_flight_is_sampled_again(self, tmp_path):
        tiles = _KeptGround(tmp_path / "ground")
        sample_path_elevations(_KEPT_PATHS, tiles, self._contents())
        asked = tiles.pixels_asked
        moved = {**_KEPT_PATHS, 7: [TrackPoint(51.0, 9.001, 100.0)]}

        sample_path_elevations(moved, tiles, self._contents(moved))

        # The points of path 7 alone, four pixels each
        assert tiles.pixels_asked == asked + 4

    def test_a_ground_with_a_gap_is_not_kept(self, tmp_path, caplog):
        """Its tile may be there the next time."""
        x, y = global_pixel(51.0, 9.0)
        missing = TileKey(TERRAIN_ZOOM, int(x) // TILE_SIZE, int(y) // TILE_SIZE)
        tiles = _KeptGround(tmp_path / "ground", missing=[missing])

        with caplog.at_level(logging.WARNING, logger="flown"):
            sample_path_elevations(_KEPT_PATHS, tiles, self._contents())

        assert len(list((tmp_path / "ground").iterdir())) == 1

    def test_a_broken_entry_is_sampled_again(self, tmp_path):
        tiles = _KeptGround(tmp_path / "ground")
        sample_path_elevations(_KEPT_PATHS, tiles, self._contents())
        for entry in (tmp_path / "ground").iterdir():
            entry.write_bytes(b"short")
        asked = tiles.pixels_asked

        again = sample_path_elevations(_KEPT_PATHS, tiles, self._contents())

        assert tiles.pixels_asked == 2 * asked
        assert len(again[3]) == 2

    def test_another_sampling_code_misses(self, tmp_path, monkeypatch):
        tiles = _KeptGround(tmp_path / "ground")
        sample_path_elevations(_KEPT_PATHS, tiles, self._contents())
        asked = tiles.pixels_asked
        monkeypatch.setattr(terrain_module, "_GROUND_FORMAT", 0)

        sample_path_elevations(_KEPT_PATHS, tiles, self._contents())

        assert tiles.pixels_asked == 2 * asked


# --- The ground of a flight ---------------------------------------------


def _row(lon, altitude_ft, speed, lat=50.0, time=0.0):
    """A row with a relative time, as a recording with timestamps has."""
    row = [lat, lon, altitude_ft, speed]
    return row if time is None else [*row, time]


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


FIELD_GROUND_CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "field-ground.json").read_text(
        encoding="utf-8"
    )
)["cases"]


@pytest.mark.parametrize(
    "case", FIELD_GROUND_CASES, ids=[case["name"] for case in FIELD_GROUND_CASES]
)
def test_the_fields_as_the_page_reads_them(case):
    """The cases the frontend's fieldFt runs as well (fieldGround.test.ts)."""
    rows = [
        _row(8.0, altitude, speed, time=float(index) if timed else None)
        for index, (altitude, speed, timed) in enumerate(case["rows"])
    ]
    flat = [0.0] * len(rows)

    assert _field_offset_ft(rows, flat, range(len(rows))) == case["start"]
    assert _field_offset_ft(rows, flat, reversed(range(len(rows)))) == case["end"]


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

    def test_rows_without_a_time_are_no_taxiing(self):
        """A line with a TimeSpan has the average speed in every row: below
        TAXI_KNOTS, a flight of circuits taxied at its circuit height."""
        rows = [
            _row(8.01 + i / 100, altitude, 30, time=None)
            for i, altitude in enumerate([1000, 1300, 1300, 1300, 1300, 1000])
        ]

        ground = ground_profile_ft(START, rows, _elevations(rows, lambda lon: 100.0))

        assert ground == [round(100 * METERS_TO_FEET / 10) * 10] * 6

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
