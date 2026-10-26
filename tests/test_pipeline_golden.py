"""Golden pipeline test: run the full export on committed data/*.kml files.

Checks the shape of the generated output and pins the values a fixed subset
of the sample data produces, so that a consistent regression (every speed
halved, a flight dropped, ids renumbered) fails instead of passing as
internally consistent.
"""

import math
import re
from datetime import datetime, timedelta
from pathlib import Path
from pprint import pformat

import pytest
from lxml import html as lxml_html

from flown.airport_lookup import airport_icao_code
from flown.geometry import haversine_distance
from flown.obfuscate import obfuscate_kml_files
from flown.path_content import PATH_ID_BITS
from flown.pipeline import build_site
from flown.segment_codec import (
    ALTITUDE_STEP,
    COORDINATE_SCALE,
    FORMAT_VERSION,
    GROUND_STEP,
)
from flown.site_assets import CARTO_STYLE_URL, CARTO_TILEJSON_URL
from flown.terrain import TILE_SIZE
from tests.codec import decode_ground, decode_rows
from tests.conftest import parse_data as _load_js
from tests.conftest import segments_by_id

DATA_DIR = Path(__file__).parent.parent / "data"
pytestmark = pytest.mark.repo_data
# Row: [lat, lon, altitude_ft, groundspeed_knots] plus an optional time
SEGMENT_MIN_COLUMNS = 4
SEGMENT_MAX_COLUMNS = 5


PER_YEAR = 4

# How far test_real_dates_export_exactly_like_obfuscated_ones moves the sample
# flights off January 1st. Any whole number of days that stays inside the year
# does; 137 is far enough that a date leaking into the export would be obvious.
DATE_SHIFT_DAYS = 137

# What the subset of data/ picked by _select_input_files exports, with the
# fixture airport database of the tests. After an intended change to the
# parser, the exporter or the sample data, run
#
#     pytest tests/test_pipeline_golden.py -k golden_values
#
# which fails with the new values, and paste them here; review the diff like
# any other change. The path ids are persisted in shared links: changing them
# needs a new STATE_SCHEMA_VERSION in the frontend (state/urlState.ts).
GOLDEN = {
    "aircraft_models": {
        "D-EAGJ": "Diamond DA-20A-1 Katana",
        "D-EHYL": "Diamond DA-40TDI Diamond Star",
        "D-ELGD": "Cessna T182T Turbo Skylane",
    },
    "airport_names": ["EDAQ Halle-Oppin", "EDVM Hildesheim"],
    "available_years": [2025, 2026],
    "distance_km": {2025: 387.5, 2026: 1176.2},
    "flight_seconds": {2025: 12338.5, 2026: 23987.6},
    # Paths with a ground, and its lowest, highest and mean, over Hills
    "ground_ft": {2025: (4, 50.0, 510.0, 328.7), 2026: (4, -50.0, 950.0, 403.5)},
    # Whole knots, and a positive speed at 1 kt at least
    "groundspeed_knots": (1.0, 167.0),
    # Full stops, touch-and-goes and go-arounds. The flight to EDVM lands
    # at a field the fixture database does not have, and counts no landing
    "landings": {2025: (4, 19, 0), 2026: (3, 2, 0)},
    "path_count": 8,
    "path_ids": {
        2025: [411100833082, 642456146975, 336383306180, 68245584272],
        2026: [197972773580, 210679907966, 714877417394, 750385786302],
    },
    "segment_rows": {2025: 4070, 2026: 5609},
    "touchdowns": {"EDAQ 11": 1, "EDAQ 29": 27},
}


# The subset of data/ GOLDEN pins: the first PER_YEAR files of each year by
# their number. Written out rather than picked by reading every file of
# data/ on every run; a name that goes missing fails the test instead of
# silently picking another flight.
GOLDEN_FILES = {
    "2025": [
        "1_DEAGJ_DA20.kml",
        "2_DEAGJ_DA20.kml",
        "3_DEAGJ_DA20.kml",
        "4_DEAGJ_DA20.kml",
    ],
    "2026": [
        "73_DELGD_C182.kml",
        "74_DEAGJ_DA20.kml",
        "75_DEHYL_DA40.kml",
        "76_DEHYL_DA40.kml",
    ],
}


def _select_input_files():
    """The committed files GOLDEN pins, in year and number order.

    Returns the selection and the number of files it holds per year; empty
    when data/ is not there (the image leaves it out).
    """
    if not DATA_DIR.is_dir():
        return [], {}
    selected = [
        DATA_DIR / name for year in sorted(GOLDEN_FILES) for name in GOLDEN_FILES[year]
    ]
    missing = [path.name for path in selected if not path.is_file()]
    assert not missing, f"the golden files are gone from data/: {missing}"
    for year, names in GOLDEN_FILES.items():
        for name in names:
            text = (DATA_DIR / name).read_text(encoding="utf-8")
            assert re.search(rf"<when>{year}-", text), f"{name} is not of {year}"
    return selected, {year: len(names) for year, names in GOLDEN_FILES.items()}


@pytest.fixture(scope="session")
def golden_inputs():
    """``_select_input_files`` once for the session."""
    return _select_input_files()


class Hills:
    """Rolling hills of a few hundred metres, the same on every run.

    Stands in for the elevation tiles, which the tests never download.
    """

    def pixels(self, wanted):
        return {
            tile: [
                200.0
                + 150.0
                * math.sin((tile.x * TILE_SIZE + index % TILE_SIZE) / 40)
                * math.cos((tile.y * TILE_SIZE + index // TILE_SIZE) / 40)
                for index in indices
            ]
            for tile, indices in wanted.items()
        }


def _build_site(out, inputs):
    """Run the pipeline on ``inputs`` into ``out / "site"``.

    The pipeline never writes to its inputs (only the CLI does, and only with
    --obfuscate-inputs), so data/ is safe to read here. The ground comes from
    ``Hills``.
    """
    # The pipeline requires the bundle, which the Python tests do not build
    bundle = out / "static" / "mapApp.bundle.js"
    bundle.parent.mkdir(parents=True)
    bundle.write_text("/* test bundle */", encoding="utf-8")
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr("flown.site_assets.BUNDLE_FILE", bundle)
        return build_site(
            [str(p) for p in inputs],
            str(out / "site" / "index.html"),
            str(out / "site" / "data"),
            [DATA_DIR / "aircraft.json"],
            terrain=Hills(),
        )


def _observed_values(data_dir):
    """The values GOLDEN pins, read from a generated data directory."""
    metadata = _load_js(data_dir / "metadata.json")
    airports = _load_js(data_dir / "airports.json")["airports"]
    path_ids = {}
    segment_rows = {}
    distance_km = {}
    flight_seconds = {}
    ground_ft = {}
    landings = {}
    touchdowns: dict[str, int] = {}
    for year in metadata["available_years"]:
        data = _load_js(data_dir / str(year) / "data.json")
        path_ids[year] = [info["id"] for info in data["path_info"]]
        # Full stops, touch-and-goes and go-arounds, and the touchdowns by
        # field and runway (see flown.landings)
        landings[year] = tuple(
            sum(info.get(key, 0) for info in data["path_info"])
            for key in ("landings", "touch_and_goes", "go_arounds")
        )
        for info in data["path_info"]:
            for airport, runway in info.get("touchdowns", []):
                key = f"{airport} {runway}"
                touchdowns[key] = touchdowns.get(key, 0) + 1
        entries = segments_by_id(data).values()
        segment_rows[year] = sum(len(entry["columns"][0]) for entry in entries)
        # The rows are scaled integers stored as differences; decoding them
        # here is a second implementation of what the frontend does, so the
        # numbers below are the ones a visitor sees. They were pinned before
        # the format changed and did not move with it.
        distance = 0.0
        seconds = 0.0
        for entry in entries:
            rows = decode_rows(entry["start"], entry["columns"])
            previous = [value / COORDINATE_SCALE for value in entry["start"]]
            for row in rows:
                distance += haversine_distance(*previous[:2], *row[:2])
                previous = row
            times = [row[4] for row in rows if len(row) > 4]
            if times:
                seconds += max(times) - min(times)
        distance_km[year] = round(distance, 1)
        flight_seconds[year] = round(seconds, 1)
        grounds = [
            feet
            for entry in entries
            if "ground" in entry
            for feet in decode_ground(entry["ground"])
        ]
        # How many paths have a ground, and its range and mean
        ground_ft[year] = (
            sum("ground" in entry for entry in entries),
            min(grounds),
            max(grounds),
            round(sum(grounds) / len(grounds), 1),
        )
    return {
        "aircraft_models": metadata["aircraft_models"],
        "airport_names": sorted(airport["name"] for airport in airports),
        "available_years": metadata["available_years"],
        "distance_km": distance_km,
        "flight_seconds": flight_seconds,
        "ground_ft": ground_ft,
        "groundspeed_knots": (
            metadata["min_groundspeed_knots"],
            metadata["max_groundspeed_knots"],
        ),
        "landings": landings,
        "path_count": sum(len(ids) for ids in path_ids.values()),
        "path_ids": path_ids,
        "segment_rows": segment_rows,
        "touchdowns": dict(sorted(touchdowns.items())),
    }


@pytest.fixture(scope="module")
def golden_output(tmp_path_factory, golden_inputs):
    inputs, files_per_year = golden_inputs
    if not inputs:
        pytest.skip("no sample KML files available (data/ is not part of the image)")
    assert len(files_per_year) >= 2, "the sample data must span at least two years"
    assert set(files_per_year.values()) == {PER_YEAR}
    out = tmp_path_factory.mktemp("golden")
    assert _build_site(out, inputs) is not None
    return out / "site", inputs


def test_golden_values(golden_output):
    out, _ = golden_output
    observed = _observed_values(out / "data")
    assert observed == GOLDEN, "GOLDEN is now:\n" + pformat(observed)


def test_index_html_references_bundles(golden_output):
    out, _ = golden_output
    html = (out / "index.html").read_text(encoding="utf-8")
    assert "mapApp.bundle.js" in html
    # The library bundle was removed; nothing may pull it back in
    assert "./bundle.js" not in html
    assert (out / "map_config.js").exists()
    assert (out / "styles.css").exists()


def test_index_html_preloads_the_latest_year(golden_output):
    """The year the page opens on, at the URL the loader requests it by."""
    out, _ = golden_output
    page = lxml_html.fromstring((out / "index.html").read_text(encoding="utf-8"))
    latest = max(_load_js(out / "data" / "metadata.json")["available_years"])
    preloads = [
        (link.get("as"), link.get("href"))
        for link in page.iter("link")
        if link.get("rel") == "preload"
    ]
    assert preloads[:3] == [
        ("fetch", "data/metadata.json"),
        ("fetch", "data/airports.json"),
        ("fetch", f"data/{latest}/data.json"),
    ]
    assert (out / "data" / str(latest) / "data.json").exists()
    # Then CARTO's style and tile index, with the key of the build if any
    assert [str(href).split("?")[0] for _, href in preloads[3:]] == [
        CARTO_STYLE_URL,
        CARTO_TILEJSON_URL,
    ]


def test_top_level_data_files(golden_output):
    out, _ = golden_output
    data_dir = out / "data"
    metadata = _load_js(data_dir / "metadata.json")
    airports = _load_js(data_dir / "airports.json")

    # No statistics: the frontend computes them from the year files
    assert set(metadata) == {
        "aircraft_models",
        "available_flags",
        "min_groundspeed_knots",
        "max_groundspeed_knots",
        "available_years",
        "year_file_bytes",
    }
    assert 0 <= metadata["min_groundspeed_knots"] <= metadata["max_groundspeed_knots"]

    assert set(airports) == {"airports"}
    assert airports["airports"]
    for airport in airports["airports"]:
        assert set(airport) <= {"name", "lat", "lon", "code", "country"}
        assert {"name", "lat", "lon"} <= set(airport)
        # The code the page shows, the one the airports were merged by
        assert airport.get("code") == airport_icao_code(airport["name"])


def test_year_files_match_available_years(golden_output):
    out, _ = golden_output
    data_dir = out / "data"
    metadata = _load_js(data_dir / "metadata.json")
    year_dirs = sorted(int(p.name) for p in data_dir.iterdir() if p.is_dir())

    assert metadata["available_years"] == year_dirs
    assert len(year_dirs) >= 2
    for year in year_dirs:
        data_file = data_dir / str(year) / "data.json"
        assert [p.name for p in (data_dir / str(year)).iterdir()] == ["data.json"]
        assert metadata["year_file_bytes"][str(year)] == data_file.stat().st_size


def test_year_data_shape_and_unique_ids(golden_output):
    out, inputs = golden_output
    data_dir = out / "data"
    metadata = _load_js(data_dir / "metadata.json")

    all_ids = []
    registrations = set()
    for year in metadata["available_years"]:
        data = _load_js(data_dir / str(year) / "data.json")
        assert list(data) == [
            "format",
            "year",
            "path_info",
            "segments",
        ]
        assert data["format"] == FORMAT_VERSION
        assert data["year"] == year

        ids = [info["id"] for info in data["path_info"]]
        # Column by column across the paths: every array has one entry per
        # path, in the order of path_info
        segments = data["segments"]
        assert list(segments) == ["start", "columns", "ground"]
        assert len(segments["columns"]) == SEGMENT_MAX_COLUMNS
        for array in [segments["start"], *segments["columns"], segments["ground"]]:
            assert len(array) == len(ids)
        all_ids.extend(ids)

        for info in data["path_info"]:
            assert set(info) <= {
                "id",
                "aircraft_registration",
                "aircraft_type",
                "year",
                "start_airport",
                "end_airport",
                "min_altitude_ft",
                "max_altitude_ft",
                "altitude_gain_ft",
                "landings",
                "touch_and_goes",
                "go_arounds",
                "touchdowns",
            }
            assert None not in info.values()
            # The sample flights are all timed, and the landings of a timed
            # flight are written together: one touchdown for every full stop
            # and touch-and-go, never a time
            assert len(info["touchdowns"]) == (
                info["landings"] + info["touch_and_goes"]
            )
            for airport, runway in info["touchdowns"]:
                assert isinstance(airport, str)
                assert runway is None or isinstance(runway, str)
            assert info["year"] == year
            registrations.add(info.get("aircraft_registration"))

        for entry in segments_by_id(data).values():
            encoded = entry["columns"]
            assert encoded[0]
            assert len(entry["start"]) == 2
            # Everything on disk is an integer, which is the point of the format
            assert all(isinstance(value, int) for value in entry["start"])
            assert SEGMENT_MIN_COLUMNS <= len(encoded) <= SEGMENT_MAX_COLUMNS
            for column in encoded:
                assert len(column) == len(encoded[0])
                assert all(isinstance(value, int) for value in column)
            for row in decode_rows(entry["start"], encoded):
                assert row[2] % ALTITUDE_STEP == 0
                assert row[3] >= 0
            # The ground is optional, and covers every row where it is written
            assert set(entry) <= {"start", "columns", "ground"}
            if "ground" in entry:
                assert len(entry["ground"]) == len(encoded[0])
                assert all(isinstance(value, int) for value in entry["ground"])
                assert all(
                    feet % GROUND_STEP == 0 for feet in decode_ground(entry["ground"])
                )

    assert len(set(all_ids)) == len(all_ids) == len(inputs)
    assert all(0 <= path_id < 2**PATH_ID_BITS for path_id in all_ids)
    assert set(metadata["aircraft_models"]) <= registrations


def test_ids_survive_removing_an_input_file(golden_output, tmp_path):
    """Shared links name flights by id; another flight must not take it."""
    out, inputs = golden_output
    before = _observed_values(out / "data")["path_ids"]

    assert _build_site(tmp_path, inputs[1:]) is not None

    after = _observed_values(tmp_path / "site" / "data")["path_ids"]
    first_year = min(before)
    assert after == {**before, first_year: before[first_year][1:]}


def _with_real_dates(source_files, destination):
    """Copies of ``source_files`` with their dates moved off January 1st.

    The committed files are obfuscated, so this undoes that for the test: it
    shifts every flight by the same whole number of days, which is what a
    recording with real dates looks like to the parser (the year and the time
    of day are kept, and so are the intervals between the points).
    """
    destination.mkdir(parents=True, exist_ok=True)

    def shift(m: re.Match[str]) -> str:
        moment = datetime.fromisoformat(f"{m.group(1)}-01-01T{m.group(2)}")
        return (moment + timedelta(days=DATE_SHIFT_DAYS)).strftime("%Y-%m-%dT%H:%M:%S")

    shifted = []
    for path in source_files:
        text = path.read_text(encoding="utf-8")
        moved = re.sub(r"(\d{4})-01-01T(\d{2}:\d{2}:\d{2})", shift, text)
        assert moved != text, f"no timestamp to shift in {path.name}"
        copy = destination / path.name
        copy.write_text(moved, encoding="utf-8")
        shifted.append(copy)
    return shifted


def test_real_dates_export_exactly_like_obfuscated_ones(tmp_path, golden_inputs):
    """The site is the same whether or not the inputs were rewritten.

    This is why ``--obfuscate-inputs`` is off by default: rewriting the user's
    files in place buys the published site nothing, because the export drops
    every absolute timestamp anyway. If this ever stops holding, the default
    has to be reconsidered, not the assertion.
    """
    inputs, _ = golden_inputs
    if not inputs:
        pytest.skip("no sample KML files available (data/ is not part of the image)")
    with_dates = _with_real_dates(inputs, tmp_path / "with-dates")
    obfuscated = _with_real_dates(inputs, tmp_path / "obfuscated")

    assert _build_site(tmp_path / "a", with_dates) is not None
    assert obfuscate_kml_files(obfuscated) == len(obfuscated)
    assert _build_site(tmp_path / "b", obfuscated) is not None

    def data_files(root):
        return {
            path.relative_to(root): path.read_bytes()
            for path in sorted((root / "site" / "data").rglob("*.json"))
        }

    exported = data_files(tmp_path / "a")
    assert len(exported) > 2
    assert exported == data_files(tmp_path / "b")


# Free-text names and file names with the date, the time of day or the
# weekday of the flight in them
DATED_FLIGHTS = {
    "1_DEHYL_2026-08-16.kml": "Sunday flight 16 Aug 2026",
    "2_DEAGJ_DA20.kml": "Flight EDDS-EDDP 2026-08-16",
    "3_DEAGJ_DA20.kml": "EDXX 16 Aug 2026",
    "4_DEAGJ_DA20.kml": "EDDS 16.08.2026 08:50 Z - EDDP",
    "5_DEHYL_1513h.kml": "EDXY Saturday",
}


def _dated_flight(directory, file_name, name, offset):
    """A flight that takes off and lands (so its ends become airports)."""
    points = 40
    whens = "".join(f"<when>2026-08-16T10:{i:02d}:00Z</when>" for i in range(points))
    coords = "".join(
        f"<gx:coord>{8.0 + offset + i * 0.02:.3f} {48.5 + i * 0.01:.3f} "
        f"{300 if i in (0, points - 1) else 1500}</gx:coord>"
        for i in range(points)
    )
    path = directory / file_name
    path.write_text(
        '<kml xmlns="http://www.opengis.net/kml/2.2" '
        'xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark>'
        f"<name>{name}</name><gx:Track>{whens}{coords}</gx:Track>"
        "</Placemark></Document></kml>",
        encoding="utf-8",
    )
    return path


def test_no_date_of_a_name_is_exported(tmp_path):
    """Names are free text; the export publishes them without their dates.

    And, as for the timestamps, the site is the same whether or not the
    inputs were obfuscated.
    """
    from flown.date_tokens import find_date_tokens, find_weekday_tokens

    sources = {}
    for label in ("a", "b"):
        directory = tmp_path / f"{label}-input"
        directory.mkdir()
        sources[label] = [
            _dated_flight(directory, file_name, name, offset)
            for offset, (file_name, name) in enumerate(DATED_FLIGHTS.items())
        ]
    assert obfuscate_kml_files(sources["b"]) == len(sources["b"])
    for label, inputs in sources.items():
        assert _build_site(tmp_path / label, inputs) is not None

    data_dir = tmp_path / "a" / "site" / "data"
    airports = _load_js(data_dir / "airports.json")["airports"]
    path_info = _load_js(data_dir / "2026" / "data.json")["path_info"]
    names = [airport["name"] for airport in airports] + [
        info[key]
        for info in path_info
        for key in ("start_airport", "end_airport", "aircraft_type")
        if key in info
    ]
    assert len(path_info) == len(DATED_FLIGHTS)
    # Free text without a code and no route is no airport at all
    assert not any("Sunday" in name for name in names)
    # A route between two codes without spaces, its date left out
    assert (path_info[1]["start_airport"], path_info[1]["end_airport"]) == (
        "EDDS Stuttgart",
        "EDDP Leipzig/Halle",
    )
    assert "EDXX" in names
    assert "EDXY" in names
    for name in names:
        assert not find_date_tokens(name), name
        assert not find_weekday_tokens(name), name
        assert not re.search(r"\b16\b|Aug|08:50|1513h|Saturday", name), name
    # The file names with a date or a time have no type left, the others
    # keep theirs
    assert [info.get("aircraft_type") for info in path_info] == [
        None,
        "DA20",
        "DA20",
        "DA20",
        None,
    ]
    # Nor do the pages of the flights carry them
    pages = list((tmp_path / "a" / "site").rglob("*.html"))
    assert len(pages) > len(DATED_FLIGHTS)
    for page in pages:
        assert not re.search(r"1513h|Saturday|Sunday", page.read_text()), page

    def data_files(root):
        return {
            path.relative_to(root): path.read_bytes()
            for path in sorted((root / "site" / "data").rglob("*.json"))
        }

    exported = data_files(tmp_path / "a")
    assert len(exported) == 3
    assert exported == data_files(tmp_path / "b")
