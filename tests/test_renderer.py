"""Tests for the generation pipeline in the renderer module."""

import errno
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool
from datetime import UTC, datetime
from pathlib import Path
from typing import cast
from unittest.mock import MagicMock, patch

import pytest
from lxml import html as lxml_html

import flown.airport_lookup as lookup_module
import flown.cache as cache_module
import flown.data_exporter as exporter_module
import flown.renderer as renderer_module
from flown import path_content
from flown.data_exporter import export_all_data
from flown.exceptions import (
    ExportError,
    FlownError,
    InvalidInputError,
    OutputRefusedError,
)
from flown.geometry import CoordinateExtent
from flown.landings import FlightLandings
from flown.listing import list_flights
from flown.parser import parse_and_cache
from flown.previews import encode_path_id
from flown.renderer import (
    UNEXPECTED_PARSE_ERROR,
    FlightDataExport,
    ParsedFile,
    _drop_paths_without_year,
    _export_site,
    _map_extent,
    _parse_kml_files,
    _parse_with_error_handling,
    _serve_hint,
    build_site,
    export_flight_data,
    load_cached,
    no_flight_reason,
    parse_files,
)
from flown.site_output import STABLE_MTIMES_ENV, STAGING_PREFIX
from flown.types import PathMetadata, TrackPoint
from flown.workers import configure_workers
from tests.conftest import (
    FIXTURE_AIRPORTS_CSV,
    FIXTURE_RUNWAYS_CSV,
    decoded_segments,
)

TRACK_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document><Placemark><name>EDAQ - EDDC</name><gx:Track>
    <when>{year}-03-15T10:00:00Z</when><gx:coord>12.05 51.55 110</gx:coord>
    <when>{year}-03-15T10:10:00Z</when><gx:coord>12.5 51.4 800</gx:coord>
    <when>{year}-03-15T10:20:00Z</when><gx:coord>13.76 51.13 230</gx:coord>
  </gx:Track></Placemark></Document></kml>
"""

# A track without any date: its year cannot be determined
UNDATED_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <name>somewhere</name><LineString><coordinates>
    -3.70,40.41,700 -3.60,40.50,900 -3.50,40.60,1200
  </coordinates></LineString></Placemark></Document></kml>
"""

# A dated flight and an undated track in Spain in one file: the flight is
# exported, the track left out
PARTLY_DATED_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document><Placemark><name>EDAQ - EDDC</name><gx:Track>
    <when>{year}-03-15T10:00:00Z</when><gx:coord>12.05 51.55 110</gx:coord>
    <when>{year}-03-15T10:10:00Z</when><gx:coord>12.5 51.4 800</gx:coord>
    <when>{year}-03-15T10:20:00Z</when><gx:coord>13.76 51.13 230</gx:coord>
  </gx:Track></Placemark><Placemark>
  <name>somewhere</name><LineString><coordinates>
    -3.70,40.41,700 -3.60,40.50,900 -3.50,40.60,1200
  </coordinates></LineString></Placemark></Document></kml>
"""

# A line whose altitudes are above the ground, not above sea level: its
# points count, but it is no flight path
CLAMPED_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <name>EDAQ - EDDC</name><TimeStamp><when>{year}-03-15</when></TimeStamp>
  <LineString><altitudeMode>relativeToGround</altitudeMode><coordinates>
    12.05,51.55,0 12.5,51.4,700 13.76,51.13,0
  </coordinates></LineString></Placemark></Document></kml>
"""

# A dated recording that never left its spot
PARKED_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document><Placemark><name>EDAQ</name><gx:Track>
    <when>{year}-03-15T10:00:00Z</when><gx:coord>12.05 51.55 110</gx:coord>
    <when>{year}-03-15T10:10:00Z</when><gx:coord>12.05 51.55 111</gx:coord>
  </gx:Track></Placemark></Document></kml>
"""

# A waypoint file: places marked on the map, no flight
WAYPOINTS_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
  <Placemark><name>EDAQ</name><Point><coordinates>12.05,51.55,110</coordinates></Point></Placemark>
  <Placemark><name>EDDC</name><Point><coordinates>13.76,51.13,230</coordinates></Point></Placemark>
</Document></kml>
"""

# A line of which only one point is valid: the other is off the globe
ONE_POINT_LINE_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <name>EDAQ - EDDC</name><TimeStamp><when>{year}-03-15</when></TimeStamp>
  <LineString><coordinates>12.05,51.55,110 512.5,151.4,300</coordinates></LineString>
</Placemark></Document></kml>
"""

# A route plan: a line without altitudes
ROUTE_PLAN_KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><Placemark>
  <name>EDAQ - EDDC</name><TimeStamp><when>{year}-03-15</when></TimeStamp>
  <LineString><coordinates>12.05,51.55 12.5,51.4 13.76,51.13</coordinates></LineString>
</Placemark></Document></kml>
"""

MAP_BOUNDS = re.compile(r'"bounds":\[\[([-\d.]+),([-\d.]+)\],\[([-\d.]+),([-\d.]+)\]\]')


def _write_kml(path, year=2025, template=TRACK_KML):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(template.format(year=year), encoding="utf-8")
    return str(path)


def _map_bounds(out):
    """The [[min_lat, min_lon], [max_lat, max_lon]] of a generated map_config.js."""
    match = MAP_BOUNDS.search((out / "map_config.js").read_text())
    assert match, "map_config.js has no bounds"
    min_lat, min_lon, max_lat, max_lon = map(float, match.groups())
    return [[min_lat, min_lon], [max_lat, max_lon]]


def _tree(directory):
    """Every file below ``directory`` with its content."""
    return {
        path.relative_to(directory).as_posix(): path.read_bytes()
        for path in sorted(directory.rglob("*"))
        if path.is_file()
    }


def _stages(directory):
    return [p for p in directory.rglob("*") if p.name.startswith(STAGING_PREFIX)]


@pytest.fixture
def bundle(tmp_path_factory, monkeypatch):
    """A stand-in application bundle.

    The Python tests run without `npm run build`, and the pipeline refuses to
    generate a site without the bundle.
    """
    static = tmp_path_factory.mktemp("static")
    bundle = static / "mapApp.bundle.js"
    bundle.write_text("/* test bundle */", encoding="utf-8")
    features = static / "features.bundle.js"
    features.write_text("/* test features */", encoding="utf-8")
    wrapped = static / "wrapped.bundle.js"
    wrapped.write_text("/* test wrapped */", encoding="utf-8")
    search = static / "search.bundle.js"
    search.write_text("/* test search */", encoding="utf-8")
    extras = static / "extras.bundle.js"
    extras.write_text("/* test extras */", encoding="utf-8")
    monkeypatch.setattr("flown.site_assets.BUNDLE_FILE", bundle)
    monkeypatch.setattr("flown.site_assets.FEATURES_BUNDLE_FILE", features)
    monkeypatch.setattr("flown.site_assets.WRAPPED_BUNDLE_FILE", wrapped)
    monkeypatch.setattr("flown.site_assets.SEARCH_BUNDLE_FILE", search)
    monkeypatch.setattr("flown.site_assets.EXTRAS_BUNDLE_FILE", extras)
    monkeypatch.setattr(
        "flown.site_assets.BUNDLE_FILES",
        (bundle, features, wrapped, search, extras),
    )
    return bundle


class TestCoordinateExtent:
    def test_of_empty_list_is_none(self):
        assert CoordinateExtent.of([]) is None

    def test_of_points(self):
        extent = CoordinateExtent.of([TrackPoint(50.0, 8.0), TrackPoint(52.0, 7.0)])
        assert extent == CoordinateExtent(50.0, 52.0, 7.0, 8.0)

    def test_across_the_antimeridian_keeps_every_flight_in_view(self):
        """Fiji: the map draws 179°W at -179, so the box has to reach it.

        A box that wrapped around 180 (178.5 to 181) would open the map on
        the flights east of the antimeridian and leave the others 358° away.
        """
        extent = CoordinateExtent.of(
            [TrackPoint(-17.0, 178.5), TrackPoint(-16.0, -179.0), TrackPoint(-18, 179)]
        )
        assert extent == CoordinateExtent(-18.0, -16.0, -179.0, 179.0)
        assert -180 <= extent.min_lon < extent.max_lon <= 180
        assert extent.center_lon == pytest.approx(0.0)

    def test_center(self):
        extent = CoordinateExtent(48.0, 54.0, 9.0, 17.0)
        assert (extent.center_lat, extent.center_lon) == (51.0, 13.0)


class TestMapExtent:
    def test_covers_only_exportable_paths(self):
        paths = [
            [TrackPoint(50.0, 8.0, 1.0), TrackPoint(51.0, 9.0, 1.0)],
            [TrackPoint(40.0, -3.0, 1.0)],  # a single point is not exported
            [TrackPoint(50.5, 8.5, 1.0), TrackPoint(50.2, 9.5, 1.0)],
        ]
        assert _map_extent(paths) == CoordinateExtent(50.0, 51.0, 8.0, 9.5)

    def test_nothing_to_export_raises(self):
        with pytest.raises(FlownError, match="No flight paths"):
            _map_extent([[TrackPoint(40.0, -3.0, 1.0)]])


class _NoPool:
    def __init__(self, *args, **kwargs):
        raise AssertionError("no process pool expected")


class TestParseWithoutAPool:
    def test_small_files_are_parsed_inline(self, tmp_path):
        files = [
            _write_kml(tmp_path / "10_DEAGJ_DA20.kml", 2026),
            _write_kml(tmp_path / "2_DEAGJ_DA20.kml", 2025),
        ]
        with patch("flown.workers.ProcessPoolExecutor", _NoPool):
            _, metadata, _ = _parse_kml_files(files)
        assert [m["year"] for m in metadata] == [2026, 2025]
        # Which file each path is of, folders and all (see duplicates._one_file)
        assert [m["source"] for m in metadata] == files

    def test_cached_files_are_read_here_and_only_the_rest_goes_to_the_pool(
        self, tmp_path, monkeypatch
    ):
        cached = _write_kml(tmp_path / "1_DEAGJ_DA20.kml", 2025)
        _parse_kml_files([cached])
        fresh = _write_kml(tmp_path / "2_DEAGJ_DA20.kml", 2026)
        monkeypatch.setattr("flown.renderer.INLINE_PARSE_MAX_BYTES", -1)
        pool = _InlineExecutor()
        submitted = []
        real_submit = pool.submit

        def submit(fn, *args):
            submitted.append(args[0])
            return real_submit(fn, *args)

        with (
            patch.object(pool, "submit", submit),
            patch("flown.workers.ProcessPoolExecutor", pool),
        ):
            _, metadata, _ = _parse_kml_files([cached, fresh])
        assert submitted == [fresh]
        assert [m["year"] for m in metadata] == [2025, 2026]

    def test_without_processes_large_files_are_parsed_here(self, tmp_path, monkeypatch):
        """The databases are not pickled for workers that never come."""
        files = [
            _write_kml(tmp_path / "1_DEAGJ_DA20.kml"),
            _write_kml(tmp_path / "2_DEAGJ_DA20.kml", 2026),
        ]
        monkeypatch.setattr("flown.renderer.INLINE_PARSE_MAX_BYTES", -1)
        configure_workers(1, processes=False)
        with (
            patch("flown.renderer.pickle.dumps") as dumps,
            patch("flown.renderer.WorkerPool") as pool,
        ):
            _, metadata, _ = _parse_kml_files(files)
        dumps.assert_not_called()
        pool.assert_not_called()
        assert [m["year"] for m in metadata] == [2025, 2026]

    def test_a_kmz_counts_with_the_kml_inside_for_the_pool(self, tmp_path, monkeypatch):
        """The archive is a fraction of the KML the parse reads."""
        kml = TRACK_KML.format(year=2025).replace(
            "</kml>", "<!--" + " " * 200_000 + "--></kml>"
        )
        kmz = tmp_path / "1_DEAGJ_DA20.kmz"
        with zipfile.ZipFile(kmz, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("doc.kml", kml)
        assert kmz.stat().st_size < 100_000
        monkeypatch.setattr("flown.renderer.POOLED_CACHE_MIN_BYTES", 100_000)
        monkeypatch.setattr("flown.renderer.POOLED_CACHE_MIN_WORKERS", 1)
        # The stand-in parses nothing, so no coordinates come back
        with (
            patch("flown.renderer._parse_in_pool") as parse_in_pool,
            pytest.raises(InvalidInputError),
        ):
            _parse_kml_files([str(kmz)])
        parse_in_pool.assert_called_once()

    def test_many_files_read_their_cache_entries_in_the_pool(
        self, tmp_path, monkeypatch, capsys
    ):
        """Hits and misses alike go to the workers, which look the cache up."""
        cached = tmp_path / "1_DEAGJ_DA20.kml"
        # A gx:coord outside the track: a warning the cache keeps
        cached.write_text(
            TRACK_KML.format(year=2025).replace(
                "</Document>",
                "<Placemark><gx:coord>12.0 51.0 100</gx:coord></Placemark></Document>",
            )
        )
        _parse_kml_files([str(cached)])
        capsys.readouterr()
        fresh = _write_kml(tmp_path / "2_DEAGJ_DA20.kml", 2026)
        monkeypatch.setattr("flown.renderer.POOLED_CACHE_MIN_BYTES", -1)
        monkeypatch.setattr("flown.renderer.POOLED_CACHE_MIN_WORKERS", 1)
        pool = _InlineExecutor()
        submitted = []
        real_submit = pool.submit

        def submit(fn, *args):
            submitted.append((fn, args))
            return real_submit(fn, *args)

        parsed = []

        def parse(kml_file, *args):
            parsed.append(kml_file)
            return parse_and_cache(kml_file, *args)

        with (
            patch.object(pool, "submit", submit),
            patch("flown.workers.ProcessPoolExecutor", pool),
            patch("flown.renderer.parse_and_cache", parse),
        ):
            _, metadata, _ = _parse_kml_files([str(cached), fresh])

        assert submitted == [
            (renderer_module._load_or_parse, (str(cached), None)),
            (renderer_module._load_or_parse, (fresh, None)),
        ]
        # Only the miss is parsed, the hit's warning is logged again
        assert parsed == [fresh]
        assert "gx:coord element(s) outside of gx:Track" in capsys.readouterr().err
        assert [m["year"] for m in metadata] == [2025, 2026]

    def test_without_an_airport_database_no_landing_is_counted(self, tmp_path, capsys):
        lookup_module.databases.use({})
        lookup_module.databases.runways = {}
        files = [_write_kml(tmp_path / "1_DEAGJ_DA20.kml", 2025)]

        _, _, landings = _parse_kml_files(files)

        assert landings == [None]
        assert "No airport database: the landings are not counted" in (
            capsys.readouterr().err
        )

    def test_warm_cache_needs_no_pool(self, tmp_path, monkeypatch):
        files = [_write_kml(tmp_path / f"{i}_DEAGJ_DA20.kml", 2025) for i in (1, 2)]
        first = _parse_kml_files(files)
        monkeypatch.setattr("flown.renderer.INLINE_PARSE_MAX_BYTES", -1)
        with patch("flown.workers.ProcessPoolExecutor", _NoPool):
            assert _parse_kml_files(files) == first

    def test_an_uncached_file_is_hashed_once(self, tmp_path):
        """The cache key of the lookup is where the parse is stored."""
        from flown import parser_cache

        files = [_write_kml(tmp_path / f"{i}_DEAGJ_DA20.kml", 2025) for i in (1, 2)]
        hashed = []
        real_digest = parser_cache._content_digest

        def digest(path):
            hashed.append(path.name)
            return real_digest(path)

        with patch.object(parser_cache, "_content_digest", digest):
            _parse_kml_files(files)
            assert sorted(hashed) == ["1_DEAGJ_DA20.kml", "2_DEAGJ_DA20.kml"]
            hashed.clear()
            # And the entry was written, with the landings: the next run
            # reads it, and finds no landing either
            with (
                patch("flown.renderer.parse_and_cache", side_effect=AssertionError),
                patch("flown.renderer.path_landings", side_effect=AssertionError),
            ):
                _parse_kml_files(files)

    def test_unreadable_cache_is_a_miss(self, tmp_path):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        with patch("flown.renderer.load_cached_entry", side_effect=OSError):
            _, metadata, _ = _parse_kml_files([kml_file])
        assert len(metadata) == 1

    def test_pipeline_error_inline_stops_the_run(self, tmp_path):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        with (
            patch(
                "flown.renderer._parse_with_error_handling",
                side_effect=FlownError("Airport database unavailable"),
            ),
            pytest.raises(FlownError, match="Airport database unavailable"),
        ):
            _parse_kml_files([kml_file])

    def test_unexpected_error_inline_is_logged(self, tmp_path, capsys):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        with (
            patch(
                "flown.renderer._parse_with_error_handling",
                side_effect=RuntimeError("unexpected"),
            ),
            pytest.raises(FlownError, match=r"1 of 1 file\(s\) failed to parse"),
        ):
            _parse_kml_files([kml_file])
        assert "Unexpected error processing" in capsys.readouterr().err


class TestNoFlightReason:
    """Why a file with coordinates gives the export no path."""

    @pytest.mark.parametrize(
        ("template", "reason"),
        [
            (WAYPOINTS_KML, "no track of two or more valid points"),
            (ONE_POINT_LINE_KML, "no track of two or more valid points"),
            (ROUTE_PLAN_KML, "no track of two or more points with altitudes above"),
            (CLAMPED_KML, "no track of two or more points with altitudes above"),
        ],
    )
    def test_says_what_the_file_holds(self, tmp_path, template, reason):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml", template=template)
        entry = load_cached(kml_file)
        assert isinstance(entry, Path)
        parsed = _parse_with_error_handling(kml_file, entry)
        assert (no_flight_reason(parsed) or "").startswith(reason)
        # The same from the parse cache
        cached = load_cached(kml_file)
        assert isinstance(cached, ParsedFile)
        assert cached == parsed


class TestParseWithErrorHandling:
    def test_nonexistent_file_returns_empty_result(self):
        parsed = _parse_with_error_handling("/nonexistent/file.kml")
        assert parsed.kml_file == "/nonexistent/file.kml"
        assert parsed.point_count == 0
        assert parsed.path_groups == []
        # What a build that skips the file says about it
        assert "No such file" in (parsed.error or "")

    def test_invalid_kml_returns_empty_result(self, tmp_path):
        path = tmp_path / "bad.kml"
        path.write_text("<not-kml>garbage")
        parsed = _parse_with_error_handling(str(path))
        assert (parsed.point_count, parsed.path_groups) == (0, [])
        assert parsed.error

    def test_a_bug_of_the_parse_logs_its_traceback(self, tmp_path, capsys):
        """Only a KMLParseError or OSError is what is wrong with the file."""
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        with patch(
            "flown.renderer.parse_and_cache",
            side_effect=ValueError("landing bug"),
        ):
            assert _parse_with_error_handling(kml_file) == ParsedFile(
                kml_file, error=UNEXPECTED_PARSE_ERROR
            )
        err = capsys.readouterr().err
        assert "Unexpected error processing" in err
        assert "Traceback" in err
        assert "landing bug" in err

    def test_reduces_coordinates_to_count(self, tmp_path):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        parsed = _parse_with_error_handling(kml_file)
        assert parsed.kml_file == kml_file
        assert parsed.point_count == 3
        assert len(parsed.path_groups) == 1
        assert parsed.path_metadata[0]["year"] == 2025


class _FakeExecutor:
    """A ProcessPoolExecutor stand-in whose futures fail with a given error."""

    def __init__(self, error):
        self.error = error
        self.cancelled = False

    def __call__(self, *args, **kwargs):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def submit(self, fn, *args):
        future: Future[object] = Future()
        future.set_exception(self.error)
        return future

    def shutdown(self, wait=True, cancel_futures=False):
        self.cancelled = self.cancelled or cancel_futures


class _InlineExecutor(_FakeExecutor):
    """A ProcessPoolExecutor stand-in that runs the work in the test process."""

    def __init__(self):
        super().__init__(None)

    def submit(self, fn, *args):
        future: Future[object] = Future()
        future.set_result(fn(*args))
        return future


class TestParseKmlFiles:
    @pytest.fixture(autouse=True)
    def _in_a_pool(self, monkeypatch):
        """These files are small enough to be parsed inline; use the pool."""
        monkeypatch.setattr("flown.renderer.INLINE_PARSE_MAX_BYTES", -1)

    def test_merges_results_in_input_order(self, tmp_path):
        files = [
            _write_kml(tmp_path / "10_DEAGJ_DA20.kml", 2026),
            _write_kml(tmp_path / "2_DEAGJ_DA20.kml", 2025),
        ]

        paths, metadata, _ = _parse_kml_files(files)

        assert len(paths) == 2
        assert [m["filename"] for m in metadata] == [
            "10_DEAGJ_DA20.kml",
            "2_DEAGJ_DA20.kml",
        ]
        assert all(isinstance(p, TrackPoint) for path in paths for p in path)

    def test_same_basename_in_two_directories_keeps_input_order(self, tmp_path):
        """Path ids follow this order, so it must not depend on worker timing."""
        files = [
            _write_kml(tmp_path / "2025" / "1_DEAGJ_DA20.kml", 2025),
            _write_kml(tmp_path / "2026" / "1_DEAGJ_DA20.kml", 2026),
        ]

        years = [[m["year"] for m in _parse_kml_files(files)[1]] for _ in range(3)]

        assert years == [[2025, 2026]] * 3

    def test_a_file_that_fails_to_parse_fails_the_run(self, tmp_path):
        """A site without one of the flights must not be published quietly."""
        bad = tmp_path / "bad.kml"
        bad.write_text("<not-kml>garbage")
        good = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")

        with pytest.raises(FlownError, match="1 of 2 file"):
            _parse_kml_files([str(bad), good])

    def test_no_coordinates_raises(self, tmp_path):
        empty = tmp_path / "empty.kml"
        empty.write_text("<kml><Document/></kml>")
        with pytest.raises(FlownError, match=r"1 of 1 file\(s\) failed to parse"):
            _parse_kml_files([str(empty)])

    def test_a_file_without_a_flight_fails_the_run(self, tmp_path, capsys):
        clamped = _write_kml(tmp_path / "2_DEAGJ_DA20.kml", template=CLAMPED_KML)
        good = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")

        with pytest.raises(FlownError, match="1 of 2 file"):
            _parse_kml_files([clamped, good])
        assert f"{clamped}: no track of two or more points" in capsys.readouterr().err

    def test_files_that_name_no_aircraft_are_named_in_one_line(self, tmp_path, capsys):
        """An export left as the tool named it builds, but belongs to no
        aircraft in the filter and the statistics."""
        files = [
            _write_kml(tmp_path / "1_DEAGJ_DA20.kml"),
            _write_kml(tmp_path / "export.kml"),
            _write_kml(tmp_path / "flight.kml", 2026),
        ]

        _parse_kml_files(files)

        err = capsys.readouterr().err
        assert (
            "2 file(s) name no aircraft (export.kml, flight.kml): their flights "
            "belong to none; name them N_REGISTRATION_TYPE.kml" in err
        )
        assert err.count("name no aircraft") == 1

    def test_a_path_without_a_year_next_to_a_flight_is_no_error(self, tmp_path):
        """The file still has a flight to export; the path is left out later."""
        paths, metadata, _ = _parse_kml_files(
            [_write_kml(tmp_path / "1.kml", template=PARTLY_DATED_KML)]
        )
        assert len(paths) == 2
        assert {m["year"] for m in metadata} == {2025, None}

    def test_crashed_worker_pool_falls_back_to_sequential_parsing(
        self, tmp_path, capsys
    ):
        files = [
            _write_kml(tmp_path / "1_DEAGJ_DA20.kml", 2025),
            _write_kml(tmp_path / "2_DEAGJ_DA20.kml", 2026),
        ]
        pools = iter([_FakeExecutor(BrokenProcessPool("crashed")), _InlineExecutor()])
        initargs = []

        def pool(*args, **kwargs):
            initargs.append(kwargs["initargs"])
            return next(pools)

        with patch("flown.workers.ProcessPoolExecutor", side_effect=pool):
            paths, metadata, _ = _parse_kml_files(files)

        # Both pools get the databases and their fingerprint (see init_worker)
        assert len(initargs) == 2
        assert initargs[1] == initargs[0]
        assert len(initargs[1]) == 4
        assert len(paths) == 2
        assert [m["filename"] for m in metadata] == [
            "1_DEAGJ_DA20.kml",
            "2_DEAGJ_DA20.kml",
        ]
        assert "parsing the 2 remaining file(s) one at a time" in (
            capsys.readouterr().err
        )

    def test_a_file_that_crashes_its_own_worker_is_named(self, tmp_path):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        with (
            patch(
                "flown.workers.ProcessPoolExecutor",
                _FakeExecutor(BrokenProcessPool("crashed")),
            ),
            pytest.raises(FlownError, match=r"crashed on .*1_DEAGJ_DA20"),
        ):
            _parse_kml_files([kml_file])

    def test_pipeline_error_in_a_worker_stops_the_run(self, tmp_path, capsys):
        """An error that is not about one file (the airport database) is fatal."""
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        executor = _FakeExecutor(FlownError("Airport database unavailable"))
        with (
            patch("flown.workers.ProcessPoolExecutor", executor),
            pytest.raises(FlownError, match="Airport database unavailable"),
        ):
            _parse_kml_files([kml_file])
        assert executor.cancelled
        assert "Traceback" not in capsys.readouterr().err

    def test_a_pool_that_cannot_start_parses_here(self, tmp_path, caplog):
        """No semaphores in a sandbox: the files are parsed all the same."""
        files = [_write_kml(tmp_path / f"{i}_DEAGJ_DA20.kml") for i in (1, 2)]
        with patch(
            "flown.workers.ProcessPoolExecutor",
            MagicMock(side_effect=OSError("no semaphores")),
        ):
            paths, _, _ = _parse_kml_files(files)

        assert len(paths) == 2
        assert "going on in this process" in caplog.text

    def test_a_worker_out_of_memory_parses_one_file_at_a_time(self, tmp_path):
        """The retry runs each file alone, in a worker of its own."""
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        pools = [_FakeExecutor(MemoryError()), _InlineExecutor()]
        with patch("flown.workers.ProcessPoolExecutor", MagicMock(side_effect=pools)):
            paths, _, _ = _parse_kml_files([kml_file])

        assert len(paths) == 1

    def test_a_file_out_of_memory_costs_no_other_parse(self, tmp_path):
        """f1 to f9 are parsed once; only f0 goes again, on its own."""
        files = [_write_kml(tmp_path / f"{i}_DEAGJ_DA20.kml") for i in range(10)]
        parsed: list[str] = []

        class Pool(_InlineExecutor):
            def submit(self, fn, *args):
                future: Future[object] = Future()
                if args[0] == files[0] and files[0] not in parsed:
                    parsed.append(files[0])
                    future.set_exception(MemoryError())
                else:
                    parsed.append(args[0])
                    future.set_result(fn(*args))
                return future

        with patch(
            "flown.workers.ProcessPoolExecutor",
            MagicMock(side_effect=lambda *_a, **_k: Pool()),
        ):
            paths, _, _ = _parse_kml_files(files)

        assert len(paths) == 10
        assert sorted(parsed) == sorted([files[0], *files])

    def test_unexpected_worker_error_is_logged(self, tmp_path, capsys):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        with (
            patch(
                "flown.workers.ProcessPoolExecutor",
                _FakeExecutor(RuntimeError("unexpected")),
            ),
            pytest.raises(FlownError, match=r"1 of 1 file\(s\) failed to parse"),
        ):
            _parse_kml_files([kml_file])
        assert "Unexpected error processing" in capsys.readouterr().err

    def test_debug_output_from_forkserver_workers(self, tmp_path, bundle):
        """Workers start via forkserver; --debug must still show their output."""
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml_file = _write_kml(input_dir / "1_DEAGJ_DA20.kml")
        # The child process does not see the in-process network guard, so it
        # gets its own cache directory with a fresh copy of the fixture
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        shutil.copyfile(FIXTURE_AIRPORTS_CSV, cache_dir / "airports.csv")
        shutil.copyfile(FIXTURE_RUNWAYS_CSV, cache_dir / "runways.csv")
        # Nor does it see the stand-in bundle, which it gets as an argument
        run_cli = (
            "import sys; from pathlib import Path; import flown.renderer as r; "
            "r.BUNDLE_FILE = Path(sys.argv.pop(1)); "
            "from flown.cli import main; main()"
        )

        result = subprocess.run(  # noqa: S603
            [
                sys.executable,
                "-c",
                run_cli,
                str(bundle),
                "--debug",
                kml_file,
                "--output-dir",
                str(tmp_path / "out"),
            ],
            capture_output=True,
            text=True,
            check=False,
            cwd=Path(__file__).parent.parent,
            env={**os.environ, "FLOWN_CACHE_DIR": str(cache_dir)},
        )

        assert result.returncode == 0, result.stderr
        # Emitted by a parse worker process
        assert "DEBUG: Found 1 gx:Track element(s)" in result.stdout
        # Emitted by the parent, which loads the airport database before the pool
        assert "airports from cache" in result.stdout
        assert "Downloading" not in result.stdout


class TestDropPathsWithoutYear:
    def test_excludes_paths_without_year(self, capsys):
        paths = [[TrackPoint(1, 1, 1)], [TrackPoint(2, 2, 2)], [TrackPoint(3, 3, 3)]]
        # Partial metadata: the function only reads the year and the names
        metadata = cast(
            "list[PathMetadata]",
            [
                {"year": 2025, "filename": "a.kml"},
                {"year": None, "filename": "b.kml", "airport_name": "Somewhere"},
                {"filename": "c.kml"},
            ],
        )

        kept_paths, kept_metadata, kept = _drop_paths_without_year(
            paths, metadata, ["a", "b", "c"]
        )

        assert kept_paths == [paths[0]]
        assert kept_metadata == [metadata[0]]
        # The landings of the paths kept still belong to them
        assert kept == ["a"]
        err = capsys.readouterr().err
        assert "b.kml (Somewhere)" in err
        assert "c.kml" in err


@pytest.mark.usefixtures("bundle")
class TestExportSite:
    def test_the_landings_stay_with_their_paths(self, tmp_path, parse_data):
        """A path without a year first: the landings of the next one are its own."""
        undated = [TrackPoint(52.0, 10.0, 1.0), TrackPoint(52.1, 10.1, 2.0)]
        dated = [TrackPoint(50.0, 8.0, 100.0), TrackPoint(51.0, 9.0, 200.0)]
        metadata: list[PathMetadata] = [
            {"year": None, "start_point": [52.0, 10.0, 1.0], "airport_name": ""},
            {"year": 2025, "start_point": [50.0, 8.0, 100.0], "airport_name": ""},
        ]
        landings = [
            FlightLandings(landings=9, touchdowns=[("XXXX", None)]),
            FlightLandings(landings=1, touchdowns=[("EDDK", "14L")]),
        ]
        out = tmp_path / "out"

        _export_site(
            [undated, dated],
            metadata,
            out / "index.html",
            out / "data",
            landings=landings,
        )

        info = parse_data(out / "data" / "2025" / "data.json")["path_info"]
        assert [(p["landings"], p["touchdowns"]) for p in info] == [
            (1, [["EDDK", "14L"]])
        ]

    def test_landings_of_other_paths_are_refused(self, tmp_path):
        path = [TrackPoint(50.0, 8.0, 100.0), TrackPoint(51.0, 9.0, 200.0)]
        metadata: list[PathMetadata] = [
            {"year": 2025, "start_point": [50.0, 8.0, 100.0], "airport_name": ""}
        ]
        with pytest.raises(ValueError, match="one per path"):
            export_all_data(
                [path], metadata, [], tmp_path, landings=[], available_flags=[]
            )

    def test_exports_and_excludes_yearless_paths(self, tmp_path, parse_data):
        coords = [
            TrackPoint(50.0, 8.0, 100.0),
            TrackPoint(51.0, 9.0, 200.0),
            TrackPoint(52.0, 10.0, 1.0),
        ]
        paths = [coords[:2], [coords[2], TrackPoint(52.1, 10.1, 2.0)]]
        metadata: list[PathMetadata] = [
            {
                "year": 2025,
                "start_point": [50.0, 8.0, 100.0],
                "airport_name": "EDDF Frankfurt Main - EDDK Cologne Bonn",
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
                "filename": "1_DEAGJ_DA20.kml",
            },
            {
                "year": None,
                "start_point": [52.0, 10.0, 1.0],
                "airport_name": "EDDH - EDDW",
            },
        ]
        out = tmp_path / "out"

        result = _export_site(
            paths, metadata, out / "index.html", out / "data", {"D-EAGJ": "Katana"}
        )

        # The map is fitted to the exported path only
        assert _map_bounds(out) == [[50.0, 8.0], [51.0, 9.0]]
        assert result.years == [2025]
        site_metadata = parse_data(out / "data" / "metadata.json")
        assert site_metadata["aircraft_models"] == {"D-EAGJ": "Katana"}
        year = parse_data(out / "data" / "2025" / "data.json")
        assert len(year["path_info"]) == 1
        assert year["original_points"] == 2
        airports = parse_data(out / "data" / "airports.json")["airports"]
        assert [airport["name"] for airport in airports] == [
            "EDDF Frankfurt Main",
            "EDDK Cologne Bonn",
        ]
        assert sorted(p.name for p in (out / "data").iterdir()) == [
            "2025",
            "airports.json",
            "metadata.json",
        ]
        assert (out / "index.html").exists()
        assert _stages(out) == []

    def test_airports_leave_out_excluded_paths(self, tmp_path, parse_data):
        """A path without an export must not publish its location either."""
        paths = [
            [TrackPoint(50.0, 8.0, 100.0), TrackPoint(51.0, 9.0, 200.0)],
            # A single point (a waypoint placemark with an altitude)
            [TrackPoint(49.5678, 10.1234, 320.0)],
            # A recording that never moved
            [TrackPoint(47.654321, 7.123456, 400.0)] * 3,
        ]
        metadata: list[PathMetadata] = [
            {
                "year": 2025,
                "start_point": [50.0, 8.0, 100.0],
                "airport_name": "EDDF Frankfurt Main - EDDK Cologne Bonn",
            },
            {
                "year": 2025,
                "start_point": [49.5678, 10.1234, 320.0],
                "airport_name": "Home Strip",
            },
            {
                "year": 2025,
                "start_point": [47.654321, 7.123456, 400.0],
                "airport_name": "Secret Strip",
            },
        ]
        out = tmp_path / "out"

        _export_site(paths, metadata, out / "index.html", out / "data")

        airports = parse_data(out / "data" / "airports.json")["airports"]
        assert [airport["name"] for airport in airports] == [
            "EDDF Frankfurt Main",
            "EDDK Cologne Bonn",
        ]

    def test_names_the_airports_without_a_code(self, tmp_path, parse_data, caplog):
        """A route between two people publishes their names as airports."""
        path = [TrackPoint(50.0, 8.0, 100.0), TrackPoint(51.0, 9.0, 200.0)]
        metadata: list[PathMetadata] = [
            {
                "year": 2025,
                "start_point": [50.0, 8.0, 100.0],
                "airport_name": "EDDF Frankfurt Main - EDDK Cologne Bonn",
            },
            {
                "year": 2025,
                "start_point": [52.0, 10.0, 100.0],
                "airport_name": "Anna Mueller - Bob Smith",
            },
        ]
        moved = [TrackPoint(52.0, 10.0, 100.0), TrackPoint(52.5, 10.5, 200.0)]
        out = tmp_path / "out"

        _export_site([path, moved], metadata, out / "index.html", out / "data")

        airports = parse_data(out / "data" / "airports.json")["airports"]
        assert {"Anna Mueller", "Bob Smith"} <= {
            airport["name"] for airport in airports
        }
        warnings = [r.getMessage() for r in caplog.records if r.levelname == "WARNING"]
        assert any(
            "2 airport name(s) not from the airport database" in message
            and "'Anna Mueller', 'Bob Smith'" in message
            and "EDDF" not in message
            for message in warnings
        ), warnings

    def test_trimmed_ends_are_not_published(self, tmp_path, parse_data):
        """--trim-ends: the parking spot widens nothing and is in no file."""
        start = 1748736000.0
        # East at 97 kt for an hour, a fix every 10 s; about 500 m a fix
        path = [
            TrackPoint(50.0, 8.0 + 0.007 * i, 500.0, start + i * 10) for i in range(361)
        ]
        metadata: list[PathMetadata] = [
            {
                "year": 2025,
                "start_point": [50.0, 8.0, 500.0],
                "airport_name": "EDDF Frankfurt Main - EDDK Cologne Bonn",
                "aircraft_registration": "D-EAGJ",
                "filename": "1_DEAGJ_DA20.kml",
            }
        ]
        out = tmp_path / "out"

        _export_site(
            [path], metadata, out / "index.html", out / "data", trim_metres=600
        )

        # The first and the last fix within 600 m of either end are gone
        assert _map_bounds(out) == [[50.0, 8.014], [50.0, 10.506]]

    def test_trimmed_ends_place_no_airport_at_the_parking_spot(
        self, tmp_path, parse_data
    ):
        """A field the database does not know is marked where the path starts:
        where it starts once trimmed, not where it was parked."""
        start = 1748736000.0
        # On the ground for the first and the last few fixes
        path = [
            TrackPoint(
                50.0,
                8.0 + 0.007 * i,
                100.0 if i < 5 or i > 355 else 800.0,
                start + i * 10,
            )
            for i in range(361)
        ]
        metadata: list[PathMetadata] = [
            {
                "year": 2025,
                "start_point": [50.0, 8.0, 100.0],
                "airport_name": "Wiese Nord - Wiese Sued",
                "aircraft_registration": "D-EAGJ",
                "filename": "1_DEAGJ_DA20.kml",
            }
        ]
        out = tmp_path / "out"

        _export_site(
            [path], metadata, out / "index.html", out / "data", trim_metres=600
        )

        airports = parse_data(out / "data" / "airports.json")["airports"]
        assert airports, "the route places its fields"
        assert all(airport["lon"] >= 8.014 for airport in airports), airports
        # The parse's metadata is left as it was: the parse cache keeps it
        assert metadata[0]["start_point"] == [50.0, 8.0, 100.0]

    def test_a_dropped_recording_adds_no_airport_and_no_extent(
        self, tmp_path, parse_data
    ):
        """A phone that recorded the flight of the panel GPS, and started
        before it somewhere else, is dropped: its start must not widen the
        map or publish an airport either."""
        start = 1748736000.0  # 2025-06-01T00:00:00Z
        # East from EDDF at 97 kt for an hour, a fix every 10 s
        panel = [
            TrackPoint(
                50.0, 8.0 + 0.007 * i, 100.0 if i == 0 else 500.0, start + i * 10
            )
            for i in range(361)
        ]
        # Started 20 minutes before, 50 km away, then the same flight
        phone = [
            TrackPoint(49.5, 7.5, 100.0, start - 1200),
            TrackPoint(49.75, 7.75, 500.0, start - 600),
            *panel,
        ]
        metadata: list[PathMetadata] = [
            {
                "year": 2025,
                "start_point": [50.0, 8.0, 100.0],
                "airport_name": "EDDF Frankfurt Main - EDDK Cologne Bonn",
                "aircraft_registration": "D-EAGJ",
                "filename": "panel.kml",
            },
            {
                "year": 2025,
                "start_point": [49.5, 7.5, 100.0],
                "airport_name": "EDFE Egelsbach - EDDK Cologne Bonn",
                "filename": "phone.kml",
            },
        ]
        out = tmp_path / "out"

        _export_site([panel, phone], metadata, out / "index.html", out / "data")

        year = parse_data(out / "data" / "2025" / "data.json")
        assert len(year["path_info"]) == 1
        assert _map_bounds(out) == [[50.0, 8.0], [50.0, 10.52]]
        airports = parse_data(out / "data" / "airports.json")["airports"]
        assert [airport["name"] for airport in airports] == [
            "EDDF Frankfurt Main",
            "EDDK Cologne Bonn",
        ]

    def test_a_skipped_copy_adds_no_airport(self, tmp_path, parse_data):
        """The same flight under another file name and route name."""
        path = [
            TrackPoint(50.0, 8.0, 100.0),
            TrackPoint(50.5, 8.5, 500.0),
            TrackPoint(51.0, 9.0, 100.0),
        ]
        metadata: list[PathMetadata] = [
            {
                "year": 2025,
                "start_point": [50.0, 8.0, 100.0],
                "airport_name": "EDDF Frankfurt Main - EDDK Cologne Bonn",
                "filename": "a.kml",
            },
            {
                "year": 2025,
                "start_point": [50.0, 8.0, 100.0],
                "airport_name": "EDFE Egelsbach - EDDK Cologne Bonn",
                "filename": "copy of a.kml",
            },
        ]
        out = tmp_path / "out"

        _export_site([path, list(path)], metadata, out / "index.html", out / "data")

        airports = parse_data(out / "data" / "airports.json")["airports"]
        assert [airport["name"] for airport in airports] == [
            "EDDF Frankfurt Main",
            "EDDK Cologne Bonn",
        ]

    def test_every_path_is_checked_for_export_once(self, tmp_path):

        paths = [
            [TrackPoint(50.0, 8.0, 100.0), TrackPoint(51.0, 9.0, 200.0)],
            [TrackPoint(49.5678, 10.1234, 320.0)],
        ]
        metadata: list[PathMetadata] = [
            {"year": 2025, "start_point": [50.0, 8.0, 100.0], "airport_name": ""},
            {"year": 2025, "start_point": [49.5, 10.1, 320.0], "airport_name": ""},
        ]
        checked = []
        real_check = path_content.is_exportable_path

        def check(path):
            checked.append(len(path))
            return real_check(path)

        out = tmp_path / "out"
        with (
            patch("flown.renderer.is_exportable_path", check),
            patch.object(exporter_module, "is_exportable_path", check),
        ):
            _export_site(paths, metadata, out / "index.html", out / "data")
        assert checked == [2, 1]

    def test_nothing_exportable_raises_before_writing(self, tmp_path):
        paths = [[TrackPoint(50.0, 8.0, 100.0), TrackPoint(51.0, 9.0, 200.0)]]
        metadata: list[PathMetadata] = [
            {"year": None, "start_point": [50.0, 8.0, 100.0], "airport_name": ""}
        ]
        out = tmp_path / "out"

        with pytest.raises(FlownError, match="No flight paths"):
            _export_site(paths, metadata, out / "index.html", out / "data")

        assert not out.exists()


class TestExportFlightData:
    """The data files alone, for the build in the browser (flown.browser)."""

    def test_writes_the_data_files_and_nothing_of_the_page(self, tmp_path):
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        data = tmp_path / "site"

        result = export_flight_data([kml_file], data)

        assert result == FlightDataExport(
            years=[2025],
            extent=CoordinateExtent(51.13, 51.55, 12.05, 13.76),
            airports=2,
            flights=1,
        )
        assert json.loads((data / "metadata.json").read_text())["available_years"] == [
            2025
        ]
        assert (data / "airports.json").is_file()
        assert (data / "2025" / "data.json").is_file()
        assert not (data / "index.html").exists()
        assert not (data / "map_config.js").exists()
        assert not (tmp_path / "site.html").exists()

    def test_takes_the_aircraft_file_it_is_given(self, tmp_path):
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        aircraft = tmp_path / "input" / "aircraft.json"
        aircraft.write_text(json.dumps({"DEAGJ": "Diamond DA20"}))

        export_flight_data([kml_file], tmp_path / "site", aircraft_files=[aircraft])

        metadata = json.loads((tmp_path / "site" / "metadata.json").read_text())
        assert metadata["aircraft_models"] == {"D-EAGJ": "Diamond DA20"}

    def test_an_invalid_file_fails_as_the_site_build_does(self, tmp_path, capsys):
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        bad = tmp_path / "input" / "2_DEAGJ_DA20.kml"
        bad.write_text("not xml")

        with pytest.raises(InvalidInputError, match="1 of 2"):
            export_flight_data([kml_file, str(bad)], tmp_path / "site")

        assert not (tmp_path / "site").exists()

    def test_nothing_to_export_is_refused(self, tmp_path):
        kml_file = _write_kml(tmp_path / "input" / "1.kml", template=UNDATED_KML)

        with pytest.raises(InvalidInputError, match="hold no flight to export"):
            export_flight_data([kml_file], tmp_path / "site")


class TestCreateProgressiveHeatmap:
    def test_refuses_overlapping_output_dir(self, tmp_path, capsys):
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        with pytest.raises(OutputRefusedError) as failure:
            build_site([kml_file], str(tmp_path.parent / "index.html"), str(tmp_path))
        assert "Refusing" in str(failure.value)
        assert not (tmp_path / "airports.json").exists()

    def test_a_symlink_in_the_site_is_a_refusal(self, tmp_path):
        """Not a failed build: the CLI exits with 2 for it, as documented."""
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        out = tmp_path / "out"
        victim = tmp_path / "victim.json"
        victim.write_text("precious")
        (out / "data").mkdir(parents=True)
        (out / "data" / "airports.json").symlink_to(victim)

        with pytest.raises(OutputRefusedError, match="symlink"):
            build_site([kml_file], str(out / "index.html"), str(out / "data"))

        assert victim.read_text() == "precious"

    def test_refuses_when_aircraft_json_dir_overlaps(self, tmp_path):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml_file = _write_kml(input_dir / "1_DEAGJ_DA20.kml")
        aircraft = tmp_path / "out" / "data" / "aircraft.json"
        aircraft.parent.mkdir(parents=True)
        aircraft.write_text("{}")
        out = tmp_path / "out"
        with pytest.raises(FlownError):
            build_site(
                [kml_file], str(out / "index.html"), str(out / "data"), [aircraft]
            )

    def test_missing_bundle_fails_before_any_work(self, tmp_path, capsys, monkeypatch):
        missing = tmp_path / "static" / "missing.js"
        monkeypatch.setattr("flown.site_assets.BUNDLE_FILE", missing)
        monkeypatch.setattr("flown.site_assets.BUNDLE_FILES", (missing,))
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        out = tmp_path / "out"

        with pytest.raises(FlownError) as failure:
            build_site([kml_file], str(out / "index.html"), str(out / "data"))

        # Said once, by the exception the command line prints
        assert "JavaScript bundle not found" not in capsys.readouterr().err
        assert "JavaScript bundle not found" in str(failure.value)
        assert "npm run build" in str(failure.value)
        assert not out.exists()

    @pytest.mark.usefixtures("bundle")
    def test_the_build_time_is_read_once(self, tmp_path, monkeypatch, caplog):
        """map_config.js and the file times share a day, and a bad
        SOURCE_DATE_EPOCH is reported once."""
        monkeypatch.delenv(STABLE_MTIMES_ENV, raising=False)
        monkeypatch.setenv("SOURCE_DATE_EPOCH", "yesterday")
        out = tmp_path / "out"
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        assert build_site([kml_file], str(out / "index.html"), str(out / "data"))
        warnings = [
            record.getMessage()
            for record in caplog.records
            if "SOURCE_DATE_EPOCH" in record.getMessage()
        ]
        assert len(warnings) == 1
        built_on = json.loads(
            (out / "map_config.js").read_text().removeprefix("window.MAP_CONFIG=")[:-1]
        )["builtOn"]
        midnight = datetime.fromtimestamp((out / "index.html").stat().st_mtime, UTC)
        assert midnight.strftime("%Y-%m-%d") == built_on

    @pytest.mark.usefixtures("bundle")
    def test_no_valid_files(self, tmp_path):
        with pytest.raises(FlownError):
            build_site(
                [str(tmp_path / "missing.kml")],
                str(tmp_path / "o" / "index.html"),
                str(tmp_path / "o" / "data"),
            )

    @pytest.mark.usefixtures("bundle")
    def test_output_dir_equal_to_input_dir_is_refused(self, tmp_path, capsys):
        """The site files would land next to the KML files, and stale
        tool-owned files (a foreign manifest.json) would be removed."""
        input_dir = tmp_path / "input"
        kml_file = _write_kml(input_dir / "1_DEAGJ_DA20.kml")
        (input_dir / "manifest.json").write_text("{}")

        with pytest.raises(FlownError) as failure:
            build_site(
                [kml_file], str(input_dir / "index.html"), str(input_dir / "data")
            )

        assert "Refusing to use output directory" in str(failure.value)
        assert (input_dir / "manifest.json").read_text() == "{}"
        assert not (input_dir / "index.html").exists()

    @pytest.mark.usefixtures("bundle")
    def test_data_dir_outside_the_output_dir_is_refused(self, tmp_path, capsys):
        """The page loads the data directory by its name, next to itself."""
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")

        with pytest.raises(FlownError) as failure:
            build_site(
                [kml_file],
                str(tmp_path / "a" / "index.html"),
                str(tmp_path / "b" / "data"),
            )

        assert "must be directly inside the output directory" in str(failure.value)
        assert not (tmp_path / "a").exists()
        assert not (tmp_path / "b").exists()

    @pytest.mark.usefixtures("bundle")
    def test_one_invalid_input_fails_the_run(self, tmp_path, capsys):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        good = _write_kml(input_dir / "1_DEAGJ_DA20.kml")
        empty = input_dir / "2_DEAGJ_DA20.kml"
        empty.write_text("")

        with pytest.raises(FlownError) as failure:
            build_site(
                [good, str(empty)],
                str(tmp_path / "o" / "index.html"),
                str(tmp_path / "o" / "data"),
            )

        assert "1 of 2 input file(s) are not valid" in str(failure.value)
        assert isinstance(failure.value, InvalidInputError)
        assert not (tmp_path / "o").exists()

    @pytest.mark.usefixtures("bundle")
    def test_no_coordinates(self, tmp_path):
        """The line usage.md documents, naming the file, as for one of many."""
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        (input_dir / "empty.kml").write_text("<kml><Document/></kml>")
        out = tmp_path / "out"
        with pytest.raises(FlownError) as failure:
            build_site(
                [str(input_dir / "empty.kml")],
                str(out / "index.html"),
                str(out / "data"),
            )
        assert str(failure.value) == (
            "1 of 1 file(s) failed to parse (empty.kml, see above); fix or remove them"
        )

    @pytest.mark.usefixtures("bundle")
    def test_no_input_at_all(self, tmp_path, monkeypatch):
        """A caller of the library with no files: refused before any parse."""
        monkeypatch.setattr(
            renderer_module,
            "_parse_kml_files",
            lambda *args, **kwargs: pytest.fail("parsed nothing"),
        )
        with pytest.raises(InvalidInputError, match="No valid KML files"):
            build_site(
                [], str(tmp_path / "o" / "index.html"), str(tmp_path / "o" / "data")
            )

    @pytest.mark.usefixtures("bundle")
    def test_every_file_invalid(self, tmp_path):
        """Not "No valid KML files to process!", which usage.md never named."""
        files = []
        for index in range(5):
            empty = tmp_path / f"{index}.kml"
            empty.write_text("")
            files.append(str(empty))
        with pytest.raises(InvalidInputError) as failure:
            build_site(
                files, str(tmp_path / "o" / "index.html"), str(tmp_path / "o" / "data")
            )
        assert str(failure.value) == (
            "5 of 5 input file(s) are not valid KML files (0.kml, 1.kml, 2.kml "
            "and 2 more, see above); fix or remove them"
        )

    @pytest.mark.usefixtures("bundle")
    def test_no_path_with_a_year_is_an_error(self, tmp_path, capsys):
        kml_file = _write_kml(tmp_path / "input" / "track.kml", template=UNDATED_KML)
        out = tmp_path / "out"

        with pytest.raises(FlownError) as failure:
            build_site([kml_file], str(out / "index.html"), str(out / "data"))

        err = capsys.readouterr().err
        assert f"{kml_file}: no track with a determinable year" in err
        assert "1 of 1 file(s) hold no flight to export" in str(failure.value)
        assert isinstance(failure.value, InvalidInputError)
        assert not (out / "index.html").exists()

    @pytest.mark.usefixtures("bundle")
    @pytest.mark.parametrize(
        ("template", "reason"),
        [
            (UNDATED_KML, "no track with a determinable year"),
            (CLAMPED_KML, "no track of two or more points with altitudes above"),
            (PARKED_KML, "every track with a year stays on one spot"),
        ],
    )
    def test_a_file_without_a_flight_fails_the_run(
        self, tmp_path, capsys, template, reason
    ):
        """Its points count, but the site would be published without it."""
        good = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        bad = _write_kml(tmp_path / "input" / "2_DEAGJ_DA20.kml", template=template)
        out = tmp_path / "out"

        with pytest.raises(FlownError) as failure:
            build_site([good, bad], str(out / "index.html"), str(out / "data"))

        err = capsys.readouterr().err
        assert f"{bad}: {reason}" in err
        assert good not in err
        assert "1 of 2 file(s) hold no flight to export" in str(failure.value)
        assert not out.exists()

    @pytest.mark.usefixtures("bundle")
    def test_a_copy_of_a_flight_does_not_fail_the_run(self, tmp_path):
        """The export skips it with a warning, and the flight is on the site."""
        files = [
            _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml"),
            _write_kml(tmp_path / "input" / "2_DEAGJ_DA20.kml"),
        ]
        out = tmp_path / "out"

        assert build_site(files, str(out / "index.html"), str(out / "data"))

    @pytest.mark.usefixtures("bundle")
    def test_map_bounds_leave_out_excluded_paths(self, tmp_path):
        files = [
            _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml"),
            _write_kml(tmp_path / "input" / "2.kml", template=PARTLY_DATED_KML),
        ]
        out = tmp_path / "out"

        assert build_site(files, str(out / "index.html"), str(out / "data"))

        assert _map_bounds(out) == [[51.13, 12.05], [51.55, 13.76]]

    @pytest.mark.usefixtures("bundle")
    def test_export_failure_raises(self, tmp_path, capsys):
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        out = tmp_path / "out"
        with (
            patch(
                "flown.renderer.export_all_data",
                side_effect=RuntimeError("Failed to process year 2025"),
            ),
            pytest.raises(FlownError) as failure,
        ):
            build_site([kml_file], str(out / "index.html"), str(out / "data"))
        assert str(failure.value) == "Export failed: Failed to process year 2025"
        assert isinstance(failure.value, ExportError)
        assert not (out / "index.html").exists()

    @pytest.mark.usefixtures("bundle")
    def test_full_disk_leaves_the_previous_site(self, tmp_path, capsys):
        out = tmp_path / "out"
        first = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml", 2025)
        assert build_site([first], str(out / "index.html"), str(out / "data"))
        previous = _tree(out)

        second = _write_kml(tmp_path / "input" / "2_DEAGJ_DA20.kml", 2026)
        real_atomic_write = cache_module.atomic_write

        def atomic_write(path, write):
            if path.name == "data.json":
                raise OSError(errno.ENOSPC, "No space left on device")
            return real_atomic_write(path, write)

        with (
            patch("flown.data_exporter.atomic_write", atomic_write),
            pytest.raises(ExportError) as failure,
        ):
            build_site([first, second], str(out / "index.html"), str(out / "data"))

        assert "Export failed" in str(failure.value)
        assert "No space left on device" in str(failure.value)
        assert "Traceback" not in capsys.readouterr().err
        assert _tree(out) == previous
        assert _stages(out) == []

    @pytest.mark.usefixtures("bundle")
    def test_failure_after_the_data_export_leaves_the_previous_site(self, tmp_path):
        out = tmp_path / "out"
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml", 2025)
        assert build_site([kml_file], str(out / "index.html"), str(out / "data"))
        previous = _tree(out)

        other = _write_kml(tmp_path / "input" / "2_DEAGJ_DA20.kml", 2026)
        with (
            patch(
                "flown.renderer.package_assets",
                side_effect=PermissionError(errno.EACCES, "Permission denied"),
            ),
            pytest.raises(ExportError),
        ):
            build_site([kml_file, other], str(out / "index.html"), str(out / "data"))

        assert _tree(out) == previous
        assert _stages(out) == []

    @pytest.mark.usefixtures("bundle")
    def test_symlinked_site_file_is_not_written_through(self, tmp_path, capsys):
        out = tmp_path / "out"
        out.mkdir()
        victim = tmp_path / "victim.txt"
        victim.write_text("precious")
        # A site of an earlier run, or the run stops before the symlink
        (out / "map_config.js").write_text("")
        (out / "manifest.json").symlink_to(victim)
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")

        with pytest.raises(FlownError) as failure:
            build_site([kml_file], str(out / "index.html"), str(out / "data"))

        assert "symlink" in str(failure.value)
        assert victim.read_text() == "precious"
        assert not (out / "index.html").exists()
        assert not (out / "data" / "metadata.json").exists()

    @pytest.mark.usefixtures("bundle")
    def test_a_site_of_its_own_is_not_replaced(self, tmp_path, capsys):
        """docs/ is where many a project keeps its own site."""
        out = tmp_path / "out"
        out.mkdir()
        (out / "index.html").write_text("my own page")
        (out / "README.md").write_text("docs")
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")

        with pytest.raises(FlownError) as failure:
            build_site([kml_file], str(out / "index.html"), str(out / "data"))

        assert "--force" in str(failure.value)
        assert isinstance(failure.value, OutputRefusedError)
        assert _tree(out) == {"README.md": b"docs", "index.html": b"my own page"}

        assert build_site(
            [kml_file], str(out / "index.html"), str(out / "data"), force=True
        )
        assert (out / "index.html").read_text() != "my own page"
        assert (out / "README.md").read_text() == "docs"
        # The site is the tool's now, and the next run replaces it as such
        assert build_site([kml_file], str(out / "index.html"), str(out / "data"))

    @pytest.mark.usefixtures("bundle")
    @pytest.mark.parametrize(
        "marker", ["map_config.js", "data/metadata.json", "unrelated.txt"]
    )
    def test_a_site_of_an_earlier_run_is_replaced(self, tmp_path, marker):
        out = tmp_path / "out"
        (out / marker).parent.mkdir(parents=True)
        (out / marker).write_text("")
        if marker == "unrelated.txt":
            # Nothing a run would replace is there
            (out / "CNAME").write_text("maps.example.org")
        else:
            (out / "index.html").write_text("an earlier page")
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")

        assert build_site([kml_file], str(out / "index.html"), str(out / "data"))

    @pytest.mark.usefixtures("bundle")
    def test_stable_mtimes_on_request(self, tmp_path, monkeypatch):
        monkeypatch.setenv("FLOWN_STABLE_MTIMES", "1")
        out = tmp_path / "out"
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")

        assert build_site([kml_file], str(out / "index.html"), str(out / "data"))

        files = [path for path in out.rglob("*") if path.is_file()]
        assert files
        assert all(path.stat().st_mtime < 1.3e9 for path in files)

    @pytest.mark.usefixtures("bundle")
    def test_stale_bundle_source_map_is_removed(self, tmp_path):
        out = tmp_path / "out"
        out.mkdir()
        (out / "map_config.js").write_text("")
        (out / "mapApp.bundle.js.map").write_text("{}")
        (out / "CNAME").write_text("maps.example.org")
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")

        assert build_site([kml_file], str(out / "index.html"), str(out / "data"))

        assert not (out / "mapApp.bundle.js.map").exists()
        assert (out / "mapApp.bundle.js").exists()
        assert (out / "features.bundle.js").exists()
        assert (out / "wrapped.bundle.js").exists()
        assert (out / "search.bundle.js").exists()
        assert (out / "extras.bundle.js").exists()
        assert (out / "CNAME").read_text() == "maps.example.org"

    @pytest.mark.usefixtures("bundle")
    @pytest.mark.parametrize("private", [False, True])
    def test_a_robots_txt_of_its_own_is_left_alone(self, tmp_path, private):
        """robots.txt belongs to whoever runs the server: --private only adds
        the meta tag to the page."""
        out = tmp_path / "out"
        out.mkdir()
        (out / "map_config.js").write_text("")
        (out / "robots.txt").write_text("User-agent: *\nAllow: /\n")
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")

        assert build_site(
            [kml_file], str(out / "index.html"), str(out / "data"), private=private
        )

        assert (out / "robots.txt").read_text() == "User-agent: *\nAllow: /\n"
        assert ('content="noindex, nofollow"' in (out / "index.html").read_text()) is (
            private
        )

    @pytest.mark.usefixtures("bundle")
    def test_output_below_input_directory(self, tmp_path):
        """The documented ``flown flight.kml --output-dir out`` layout."""
        kml_file = _write_kml(tmp_path / "1_DEAGJ_DA20.kml")
        out = tmp_path / "out"
        assert (
            build_site([kml_file], str(out / "index.html"), str(out / "data"))
            is not None
        )
        assert (out / "data" / "2025" / "data.json").exists()

    @pytest.mark.usefixtures("bundle")
    def test_end_to_end_with_aircraft_data(self, tmp_path, parse_data):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml_file = _write_kml(input_dir / "1_DEAGJ_DA20.kml")
        aircraft = input_dir / "aircraft.json"
        aircraft.write_text(json.dumps({"D-EAGJ": "Diamond Katana"}))
        out = tmp_path / "out"
        out.mkdir()

        assert (
            build_site(
                [kml_file], str(out / "index.html"), str(out / "data"), [aircraft]
            )
            is not None
        )

        assert (out / "index.html").exists()
        meta = parse_data(out / "data" / "metadata.json")
        assert meta["available_years"] == [2025]
        assert meta["aircraft_models"] == {"D-EAGJ": "Diamond Katana"}
        year = parse_data(out / "data" / "2025" / "data.json")
        assert len(year["path_info"]) == 1

    @pytest.mark.usefixtures("bundle")
    def test_removing_an_input_file_keeps_the_other_path_ids(
        self, tmp_path, parse_data
    ):
        """Path ids end up in shared links, which must keep their flights."""
        # Every file flies through a different waypoint
        kml_files = [
            _write_kml(
                tmp_path / "input" / f"{index + 1}_DEAGJ_DA20.kml",
                year,
                TRACK_KML.replace("12.5 51.4", f"12.{index + 1} 51.4"),
            )
            for index, year in enumerate((2025, 2026, 2025, 2025, 2026))
        ]

        def ids_by_waypoint(out):
            ids = {}
            for data_file in sorted((out / "data").glob("*/data.json")):
                for path_id, entry in parse_data(data_file)["segments"].items():
                    _, rows = decoded_segments(entry)
                    ids[rows[0][1]] = int(path_id)
            return ids

        everything = tmp_path / "all"
        fewer = tmp_path / "fewer"
        assert build_site(
            kml_files, str(everything / "index.html"), str(everything / "data")
        )
        removed = kml_files.pop(0)
        assert build_site(kml_files, str(fewer / "index.html"), str(fewer / "data"))

        before = ids_by_waypoint(everything)
        after = ids_by_waypoint(fewer)
        assert len(before) == 5
        assert removed.endswith("1_DEAGJ_DA20.kml")
        del before[12.1]
        assert after == before


@pytest.mark.usefixtures("bundle")
class TestLinkPreviews:
    SITE = "https://example.org/flights"

    @pytest.fixture(autouse=True)
    def _previews(self, tmp_path_factory, monkeypatch):
        """A cache of its own, no pool, and images that take no time."""
        monkeypatch.setattr(
            "flown.previews.PREVIEW_CACHE_DIR",
            tmp_path_factory.mktemp("previews") / "cache",
        )
        monkeypatch.setattr(os, "process_cpu_count", lambda: 1)
        monkeypatch.setattr(
            "flown.previews.render_preview",
            lambda tracks: b"\x89PNG " + str(len(tracks)).encode(),
        )

    @staticmethod
    def _inputs(tmp_path):
        return [
            _write_kml(
                tmp_path / "input" / f"{index + 1}_DEAGJ_DA20.kml",
                year,
                TRACK_KML.replace("12.5 51.4", f"12.{index + 1} 51.4"),
            )
            for index, year in enumerate((2025, 2026))
        ]

    @staticmethod
    def _previews_of(out):
        return sorted(
            path.relative_to(out).as_posix()
            for pattern in ("y/*", "f/*", "preview.png")
            for path in out.glob(pattern)
        )

    @staticmethod
    def _meta(page, key):
        tree = lxml_html.fromstring(page.read_text())
        return [
            element.get("content")
            for element in tree.iter("meta")
            if key in (element.get("property"), element.get("name"))
        ]

    @staticmethod
    def _ids(out, parse_data):
        """The flights of each year, as their pages are named."""
        return {
            data_file.parent.name: [
                encode_path_id(info["id"])
                for info in parse_data(data_file)["path_info"]
            ]
            for data_file in sorted((out / "data").glob("*/data.json"))
        }

    def test_a_page_and_an_image_for_the_site_every_year_and_flight(
        self, tmp_path, parse_data
    ):
        out = tmp_path / "out"

        assert build_site(
            self._inputs(tmp_path),
            str(out / "index.html"),
            str(out / "data"),
            site_url=self.SITE,
        )

        ids = self._ids(out, parse_data)
        flights = [*ids["2025"], *ids["2026"]]
        assert self._previews_of(out) == sorted(
            [
                "preview.png",
                "y/2025.html",
                "y/2025.png",
                "y/2026.html",
                "y/2026.png",
                *(f"f/{flight}.html" for flight in flights),
                *(f"f/{flight}.png" for flight in flights),
            ]
        )
        # Every flight alone, every year and the site with all of them
        assert (out / "f" / f"{flights[0]}.png").read_bytes() == b"\x89PNG 1"
        assert (out / "preview.png").read_bytes() == b"\x89PNG 2"
        index = out / "index.html"
        assert self._meta(index, "og:image") == [f"{self.SITE}/preview.png"]
        assert self._meta(index, "og:url") == [f"{self.SITE}/"]
        assert self._meta(index, "twitter:card") == ["summary_large_image"]
        stub = (out / "f" / f"{ids['2026'][0]}.html").read_text()
        assert f"url=../?y=2026&amp;p={ids['2026'][0]}&amp;sv=4" in stub

    def test_the_site_url_comes_from_the_environment(self, tmp_path, monkeypatch):
        monkeypatch.setenv("FLOWN_SITE_URL", f"{self.SITE}/")
        out = tmp_path / "out"

        assert build_site(
            self._inputs(tmp_path)[:1], str(out / "index.html"), str(out / "data")
        )

        assert self._meta(out / "index.html", "og:image") == [
            f"{self.SITE}/preview.png"
        ]
        assert (out / "preview.png").is_file()

    def test_without_a_site_url_the_pages_go_without_images(self, tmp_path):
        out = tmp_path / "out"

        assert build_site(
            self._inputs(tmp_path), str(out / "index.html"), str(out / "data")
        )

        files = self._previews_of(out)
        assert len(files) == 4
        assert all(name.endswith(".html") for name in files)
        index = out / "index.html"
        assert self._meta(index, "og:image") == []
        assert self._meta(index, "og:url") == []
        assert self._meta(index, "twitter:card") == ["summary"]

    def test_a_removed_flight_takes_its_page_and_image_along(
        self, tmp_path, parse_data
    ):
        out = tmp_path / "out"
        inputs = self._inputs(tmp_path)
        assert build_site(
            inputs, str(out / "index.html"), str(out / "data"), site_url=self.SITE
        )
        (gone,) = self._ids(out, parse_data)["2026"]
        (out / "notes.txt").write_text("mine")

        assert build_site(
            inputs[:1], str(out / "index.html"), str(out / "data"), site_url=self.SITE
        )

        (kept,) = self._ids(out, parse_data)["2025"]
        assert gone != kept
        assert self._previews_of(out) == sorted(
            [
                "preview.png",
                "y/2025.html",
                "y/2025.png",
                f"f/{kept}.html",
                f"f/{kept}.png",
            ]
        )
        assert (out / "notes.txt").read_text() == "mine"

    def test_dropping_the_site_url_removes_the_images(self, tmp_path):
        out = tmp_path / "out"
        inputs = self._inputs(tmp_path)
        assert build_site(
            inputs, str(out / "index.html"), str(out / "data"), site_url=self.SITE
        )

        assert build_site(
            inputs, str(out / "index.html"), str(out / "data"), site_url=""
        )

        files = self._previews_of(out)
        assert len(files) == 4
        assert all(name.endswith(".html") for name in files)

    def test_a_relative_site_url_fails_before_any_work(self, tmp_path, capsys):
        out = tmp_path / "out"

        with pytest.raises(FlownError) as failure:
            build_site(
                self._inputs(tmp_path),
                str(out / "index.html"),
                str(out / "data"),
                site_url="flights/",
            )

        assert "absolute http(s) address" in str(failure.value)
        assert isinstance(failure.value, InvalidInputError)
        assert not out.exists()


class TestServeHint:
    def test_serves_the_directory_of_the_site(self):
        """Not the directory it runs in, as python -m http.server alone does."""
        assert _serve_hint("docs/index.html") == (
            "View it over HTTP: python -m http.server 8000 --bind 127.0.0.1 -d "
            "docs, then open http://127.0.0.1:8000/"
        )

    def test_another_page_and_a_directory_with_a_space(self):
        assert _serve_hint("my site/map.html") == (
            "View it over HTTP: python -m http.server 8000 --bind 127.0.0.1 -d "
            "'my site', then open http://127.0.0.1:8000/map.html"
        )


class TestListFlights:
    def test_every_reason_a_flight_is_left_out(self, tmp_path):
        files = [
            _write_kml(tmp_path / "1_DEAGJ_DA20.kml"),
            _write_kml(tmp_path / "2_DEAGJ_DA20.kml", template=UNDATED_KML),
            _write_kml(tmp_path / "3_DEAGJ_DA20.kml", template=PARKED_KML),
            _write_kml(tmp_path / "4_DEAGJ_DA20.kml", template=CLAMPED_KML),
            _write_kml(tmp_path / "5.kml", template="not valid xml <"),
        ]

        rows = list_flights(files).rows

        assert [(Path(row.file).name, row.skipped) for row in rows] == [
            ("1_DEAGJ_DA20.kml", ""),
            ("2_DEAGJ_DA20.kml", "no determinable year"),
            ("3_DEAGJ_DA20.kml", "stays on one spot"),
            (
                "4_DEAGJ_DA20.kml",
                (
                    "no track of two or more points with altitudes above sea "
                    "level (a 2D line, such as a route plan, and a clampToGround "
                    "or relativeToGround track have none)"
                ),
            ),
            ("5.kml", "failed to parse"),
        ]
        # A build of them fails on every file but the first
        assert [row.fails_build for row in rows] == [False, True, True, True, True]
        assert list_flights(files).failing_files == files[1:]
        first = rows[0]
        assert (first.year, first.aircraft, first.timed) == (2025, "D-EAGJ", True)
        assert first.airports.startswith("EDAQ")
        # A name that is no route
        assert rows[1].airports == "somewhere"
        assert rows[2].airports == "EDAQ Halle-Oppin"

    def test_names_the_airports_without_a_code(self, tmp_path):
        """The airports the build would publish, of the published paths only."""
        people = TRACK_KML.replace("EDAQ - EDDC", "Anna Mueller - Bob Smith")
        files = [
            _write_kml(tmp_path / "1_DEAGJ_DA20.kml", template=people),
            # Never published, so neither is its name
            _write_kml(
                tmp_path / "2_DEAGJ_DA20.kml",
                template=UNDATED_KML.replace("somewhere", "Carl - Dora"),
            ),
        ]

        assert list_flights(files).free_text_airports == ["Anna Mueller", "Bob Smith"]
        # Next to a field with a code, the names are that field's
        coded = _write_kml(tmp_path / "3_DEAGJ_DA20.kml")
        assert list_flights([coded, *files]).free_text_airports == []

    def test_parses_many_files_in_the_pool(self, tmp_path, monkeypatch):
        """As a build does, see renderer._load_or_parse_here."""
        files = [
            _write_kml(tmp_path / "1_DEAGJ_DA20.kml"),
            _write_kml(tmp_path / "2_DEAGJ_DA20.kml", year=2026),
        ]
        monkeypatch.setattr("flown.renderer.INLINE_PARSE_MAX_BYTES", -1)
        pool = _InlineExecutor()
        submitted = []
        real_submit = pool.submit

        def submit(fn, *args):
            submitted.append(args[0])
            return real_submit(fn, *args)

        with (
            patch.object(pool, "submit", submit),
            patch("flown.workers.ProcessPoolExecutor", pool),
        ):
            rows = list_flights(files).rows

        assert sorted(submitted) == files
        assert [(row.file, row.year) for row in rows] == [
            (files[0], 2025),
            (files[1], 2026),
        ]

    def test_a_second_recording_of_a_flight(self, tmp_path, monkeypatch):
        files = [
            _write_kml(tmp_path / "1_DEAGJ_DA20.kml"),
            # Not an exact copy, which the list names as one
            _write_kml(
                tmp_path / "2_DEAGJ_DA20.kml",
                year=2026,
                template=TRACK_KML.replace("12.5 51.4", "12.6 51.4"),
            ),
        ]
        # Found by where it was when; here the second is taken for one
        monkeypatch.setattr(
            "flown.data_exporter.drop_overlapping_paths",
            lambda by_year, *_: {2025: by_year[2025]},
        )

        rows = list_flights(files).rows

        assert rows[1].skipped == "the same flight as another recording"

    def test_files_of_one_name_in_two_folders_are_two_files(self, tmp_path):
        """As the build tells them apart, by their paths."""
        files = [
            _write_kml(tmp_path / "a" / "1_DEAGJ_DA20.kml"),
            _write_kml(tmp_path / "b" / "1_DEAGJ_DA20.kml"),
        ]

        parsed = parse_files(files, {})

        assert [
            [metadata["source"] for metadata in entry.path_metadata] for entry in parsed
        ] == [[files[0]], [files[1]]]


class TestPipelineErrors:
    @pytest.mark.usefixtures("bundle")
    def test_a_parse_that_fails_on_the_way_is_an_export_error(self, tmp_path):
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        out = tmp_path / "out"
        with (
            patch(
                "flown.renderer._parse_kml_files",
                side_effect=OSError("disk gone"),
            ),
            pytest.raises(ExportError, match="disk gone"),
        ):
            build_site([kml_file], str(out / "index.html"), str(out / "data"))

    @pytest.mark.usefixtures("bundle")
    def test_an_input_error_of_the_export_keeps_its_kind(self, tmp_path):
        kml_file = _write_kml(tmp_path / "input" / "1_DEAGJ_DA20.kml")
        out = tmp_path / "out"
        with (
            patch(
                "flown.renderer._export_site",
                side_effect=InvalidInputError("No flight paths"),
            ),
            pytest.raises(InvalidInputError, match=r"^No flight paths$"),
        ):
            build_site([kml_file], str(out / "index.html"), str(out / "data"))
