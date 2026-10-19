"""Tests for airports module."""

from typing import cast
from unittest.mock import patch

import pytest

import flown.airports as airports_module
from flown.airports import (
    AirportDeduplicator,
    AltitudeSample,
    airport_elevation,
    deduplicate_airports,
    extract_airport_name,
    is_mid_flight_start,
    is_point_marker,
    is_valid_landing,
    reference_altitude,
    route_airports,
    sample_path_altitudes,
)
from flown.constants import AIRPORT_GRID_SIZE_DEGREES
from flown.geometry import haversine_distance
from flown.types import PathMetadata, TrackPoint


def _path(*points):
    return [TrackPoint(lat, lon, alt, None) for lat, lon, alt in points]


def _flat(alt, count=100):
    return [TrackPoint(50.0, 8.0, float(alt), None)] * count


def _profile(*altitudes):
    """A path along a meridian with the given altitudes, one point each."""
    return [
        TrackPoint(50.0 + i * 0.01, 8.0, float(alt), None)
        for i, alt in enumerate(altitudes)
    ]


class TestSamplePathAltitudes:
    def test_short_path_returns_none(self):
        assert sample_path_altitudes(_flat(100, 10)) is None
        assert sample_path_altitudes(_flat(100, 22)) is None

    def test_from_start_and_from_end(self):
        path = _profile(*range(0, 1000, 10))  # 100 points, 0..990
        start = sample_path_altitudes(path)
        end = sample_path_altitudes(path, from_end=True)
        assert start == AltitudeSample(0.0, 240.0, 240.0)
        assert end == AltitudeSample(750.0, 990.0, 240.0)

    def test_sample_is_capped(self):
        path = _profile(*range(1000))
        sample = sample_path_altitudes(path)
        assert sample is not None
        assert sample.max == 49.0

    def test_no_altitudes_returns_none(self):
        path = [TrackPoint(50.0, 8.0, None, None)] * 100
        assert sample_path_altitudes(path) is None


class TestIsMidFlightStart:
    def test_flat_high_start_is_mid_flight(self):
        assert is_mid_flight_start(_flat(2000), 2000.0) is True

    def test_climbing_start_is_not(self):
        assert is_mid_flight_start(_profile(*range(100, 4100, 40)), 100.0) is False

    def test_low_start_is_not(self):
        assert is_mid_flight_start(_flat(100), 100.0) is False

    def test_short_path_or_unknown_altitude(self):
        assert is_mid_flight_start(_flat(2000, 5), 2000.0) is False
        assert is_mid_flight_start(_flat(2000), None) is False

    def test_the_limits_are_not_mid_flight(self):
        """More than 400 m up and less than 100 m of variation, exactly."""
        assert is_mid_flight_start(_flat(400), 400.0) is False
        assert is_mid_flight_start(_flat(401), 401.0) is True
        start = [2000.0, 2100.0]
        assert is_mid_flight_start(_profile(*start, *[2050.0] * 98), 2000.0) is False
        assert (
            is_mid_flight_start(_profile(2000.0, 2099.0, *[2050.0] * 98), 2000.0)
            is True
        )

    def test_height_is_measured_above_the_reference(self):
        """A taxi at Munich (453 m) is flat and above 400 m, but on the ground."""
        assert is_mid_flight_start(_flat(453), 453.0) is True
        assert is_mid_flight_start(_flat(453), 453.0, 453.0) is False
        assert is_mid_flight_start(_flat(900), 900.0, 453.0) is True


class TestReferenceAltitude:
    def test_airport_elevation_wins(self):
        assert reference_altitude(_profile(*range(100, 4100, 40)), 1707.0) == 1707.0

    def test_lowest_altitude_of_a_climbing_path(self):
        assert reference_altitude(_profile(*range(1700, 4100, 40)), None) == 1700.0

    def test_flat_path_has_no_ground_in_it(self):
        """A cruise recording keeps sea level, so its flat start stays mid-flight."""
        assert reference_altitude(_flat(2000), None) == 0.0
        assert reference_altitude(_profile(*range(2000, 2090, 10)), None) == 0.0

    def test_empty_path(self):
        assert reference_altitude([], None) == 0.0


class TestAirportElevation:
    def test_from_the_database(self):
        assert airport_elevation("EDDM Munich - EDDK Cologne", False) == pytest.approx(
            1487 / 3.28084
        )
        assert airport_elevation("EDDM Munich - EDDK Cologne", True) == pytest.approx(
            302 / 3.28084
        )

    @pytest.mark.parametrize("name", [None, "", "Some Field", "XXXX Unknown"])
    def test_unknown(self, name):
        assert airport_elevation(name, False) is None


class TestIsValidLanding:
    def test_stable_low_end_is_a_landing(self):
        assert is_valid_landing(_flat(100), 100.0) is True

    def test_descent_to_low_altitude_is_a_landing(self):
        descent = _profile(*range(3000, 90, -30))
        assert is_valid_landing(descent, descent[-1].alt) is True

    def test_high_variable_end_is_not(self):
        climb = _profile(*range(100, 4100, 40))
        assert is_valid_landing(climb, climb[-1].alt) is False

    def test_short_path_uses_fallback_altitude(self):
        assert is_valid_landing(_flat(100, 3), 100.0) is True
        assert is_valid_landing(_flat(5000, 3), 5000.0) is False
        assert is_valid_landing(_flat(100, 3), None) is False

    def test_height_is_measured_above_the_reference(self):
        """A descent onto Samedan (1707 m) ends far above 600 m MSL."""
        descent = _profile(*range(3500, 1700, -30))
        assert is_valid_landing(descent, descent[-1].alt) is False
        assert is_valid_landing(descent, descent[-1].alt, 1707.0) is True
        assert is_valid_landing(_flat(1707, 3), 1707.0) is False
        assert is_valid_landing(_flat(1707, 3), 1707.0, 1707.0) is True


class TestExtractAirportName:
    def test_route_departure_and_arrival(self):
        assert (
            extract_airport_name("EDDF Frankfurt - KJFK New York", False)
            == "EDDF Frankfurt"
        )
        assert (
            extract_airport_name("EDDF Frankfurt - KJFK New York", True)
            == "KJFK New York"
        )

    def test_marker_returns_none(self):
        assert extract_airport_name("Log Start: 03 Mar 2025 08:58 Z", False) is None

    def test_single_icao_code(self):
        assert extract_airport_name("EDDF", True) == "EDDF"
        assert extract_airport_name("EDDF", False) == "EDDF"

    @pytest.mark.parametrize("value", [None, "", "Unknown", "Airport"])
    def test_empty_and_placeholder_names(self, value):
        assert extract_airport_name(value, True) is None

    def test_multi_word_name_without_icao(self):
        assert extract_airport_name("Unknown Location", True) == "Unknown Location"

    def test_single_word_without_icao(self):
        assert extract_airport_name("Somewhere", False) is None

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("Evening flight 16 Aug 2026", "Evening flight"),
            # The weekday goes as well, and a single word is no airport
            ("Sunday flight 16 Aug 2026", None),
            ("Samstag EDDS 1513h", "EDDS"),
            ("KFHR Friday Harbor Sa., 16.08.2026", "KFHR Friday Harbor"),
            # A route without spaces names its departure here
            ("Flight EDDS-EDDP 2026-08-16", "Flight EDDS"),
            ("EDXX 16 Aug 2026", "EDXX"),
            ("EDDS Stuttgart (16.08.2026)", "EDDS Stuttgart"),
            ("Sunday 16 Aug 2026", None),
            ("2026-08-16", None),
            ("16 Aug 2026 08:50 Z", None),
        ],
    )
    def test_dates_are_taken_out(self, name, expected):
        """A marker must not publish the day of the flight."""
        assert extract_airport_name(name, False) == expected

    @pytest.mark.parametrize("is_at_path_end", [False, True])
    def test_airport_name_with_dash_is_not_split(self, is_at_path_end):
        """The deduplicator stores one airport; LFBN is "Niort - Marais Poitevin"."""
        name = "LFBN Niort - Marais Poitevin"
        assert extract_airport_name(name, is_at_path_end) == name

    def test_route_with_dashed_arrival(self):
        route = "EDAQ Halle-Oppin - LFBN Niort - Marais Poitevin"
        assert extract_airport_name(route, True) == "LFBN Niort - Marais Poitevin"
        assert extract_airport_name(route, False) == "EDAQ Halle-Oppin"


class TestRouteAirports:
    def test_structured_airports_win(self):
        metadata: PathMetadata = {
            "start_point": [50.0, 8.5],
            "airport_name": "EDAQ Halle-Oppin - LFBN Niort - Marais Poitevin",
            "start_airport": "EDAQ Halle-Oppin",
            "end_airport": "LFBN Niort - Marais Poitevin",
        }
        assert route_airports(metadata) == (
            "EDAQ Halle-Oppin",
            "LFBN Niort - Marais Poitevin",
        )

    def test_parsed_name_that_is_no_route(self):
        """The parser sets both keys to None; the name is not split again."""
        metadata: PathMetadata = {
            "start_point": [50.0, 8.5],
            "airport_name": "Some Field - Other Field",
            "start_airport": None,
            "end_airport": None,
        }
        assert route_airports(metadata) == (None, None)

    def test_metadata_without_the_keys_splits_the_name(self):
        def metadata(**fields: str) -> PathMetadata:
            # Hand-built metadata, which lacks what route_airports never reads
            return cast("PathMetadata", fields)

        assert route_airports(metadata(airport_name="EDDS - EDDP")) == (
            "EDDS",
            "EDDP",
        )
        assert route_airports(metadata(airport_name="EDDS")) == (None, None)
        assert route_airports(metadata()) == (None, None)


class TestIsPointMarker:
    @pytest.mark.parametrize(
        "name", ["Log Start: EDAQ", "Takeoff: EDAQ", "Landing: EDMV", "Log Stop: X"]
    )
    def test_markers(self, name):
        assert is_point_marker(name) is True

    def test_route_not_marker(self):
        assert is_point_marker("EDAQ Halle - EDMV Vilshofen") is False

    @pytest.mark.parametrize(
        "name",
        [
            "CYNL Points North Landing",
            "CYNL Points North Landing - EDDP Leipzig/Halle",
            "BGDH Danmarkshavn Landing Strip",
            "Takeoff Field",
            "Log Starter",
        ],
    )
    def test_marker_words_inside_a_name(self, name):
        """49 airports have "Landing" in their name; their flights must count."""
        assert is_point_marker(name) is False

    @pytest.mark.parametrize(
        "name", ["Landing: 2025-01-01", "Log Stop: 03 Mar 2025 08:54 Z", "Takeoff"]
    )
    def test_obfuscated_and_bare_markers(self, name):
        assert is_point_marker(name) is True

    @pytest.mark.parametrize("value", ["", None])
    def test_empty_name_is_marker(self, value):
        assert is_point_marker(value) is True


class TestDeduplicateAirports:
    def test_empty_metadata(self):
        assert deduplicate_airports([], []) == []

    def test_single_route_creates_departure_and_arrival(self):
        metadata: list[PathMetadata] = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF Frankfurt - EDDK Cologne",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100), (50.86, 7.14, 200))]

        result = deduplicate_airports(metadata, path_groups)

        assert len(result) == 2
        assert result[0].is_at_path_end is False
        assert result[1].is_at_path_end is True

    def test_departure_is_registered_once(self):
        """The metadata start point is the path's first point; no second pass."""
        path = _path((50.0, 8.5, 100), (50.4, 8.3, 900), (50.86, 7.14, 200))
        metadata: list[PathMetadata] = [
            {
                "start_point": [path[0].lat, path[0].lon, path[0].alt],
                "airport_name": "Some Field - Other Field",
            }
        ]

        result = deduplicate_airports(metadata, [path])

        assert [(a.lat, a.is_at_path_end) for a in result] == [
            (50.0, False),
            (50.86, True),
        ]

    def test_duplicate_locations_merge(self):
        metadata: list[PathMetadata] = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF",
            },
            {
                "start_point": [50.0001, 8.5001, 100],
                "airport_name": "EDDF",
            },
        ]
        path_groups = [
            _path((50.0, 8.5, 100), (51.0, 9.5, 200)),
            _path((50.0001, 8.5001, 100), (51.0, 9.5, 200)),
        ]

        result = deduplicate_airports(metadata, path_groups)

        assert len(result) == 1

    def test_different_locations_are_kept(self):
        metadata: list[PathMetadata] = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF",
            },
            {
                "start_point": [51.0, 9.5, 100],
                "airport_name": "EDDK",
            },
        ]
        path_groups = [
            _path((50.0, 8.5, 100), (51.0, 9.5, 200)),
            _path((51.0, 9.5, 100), (52.0, 10.5, 200)),
        ]

        result = deduplicate_airports(metadata, path_groups)

        assert len(result) == 2

    def test_mid_flight_start_filtered(self):
        metadata: list[PathMetadata] = [
            {
                "start_point": [50.0, 8.0, 5000],
                "airport_name": "Mid-air Somewhere",
            }
        ]
        path_groups = [_flat(5000, 40)]

        result = deduplicate_airports(metadata, path_groups)

        assert result == []

    def test_invalid_landing_not_added(self):
        metadata: list[PathMetadata] = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDF Frankfurt - EDDK Cologne",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100), (50.86, 7.14, 5000))]

        result = deduplicate_airports(metadata, path_groups)

        assert len(result) == 1
        assert result[0].is_at_path_end is False

    def test_point_marker_skipped(self):
        metadata: list[PathMetadata] = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "Log Start: EDDF",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100), (51.0, 9.5, 200))]

        result = deduplicate_airports(metadata, path_groups)

        assert result == []

    def test_single_point_path_registers_nothing(self):
        """A waypoint or a stationary recording is no flight; its position
        would give away where it was although the export holds no path."""
        metadata: list[PathMetadata] = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "Home Strip - EDDK Cologne",
            }
        ]
        path_groups = [_path((50.0, 8.5, 100))]

        assert deduplicate_airports(metadata, path_groups) == []

    def test_metadata_without_matching_path(self):
        metadata: list[PathMetadata] = [
            {"start_point": [50.0, 8.5], "airport_name": "EDDF"}
        ]

        assert deduplicate_airports(metadata, []) == []

    def test_departure_from_a_high_field(self):
        """Munich lies at 453 m: the taxi-out is flat and above 400 m MSL."""
        taxi = [453.0] * 30
        climb = [453.0 + i * 100.0 for i in range(1, 31)]
        path = _profile(*taxi, *climb)
        metadata: list[PathMetadata] = [
            {
                "start_point": [path[0].lat, path[0].lon, 453.0],
                "airport_name": "EDDM Munich - EDDK Cologne",
            }
        ]

        result = deduplicate_airports(metadata, [path])

        assert [(a.name, a.is_at_path_end) for a in result] == [("EDDM Munich", False)]

    def test_departure_from_an_alpine_field(self):
        """Samedan lies at 1707 m; the fixture database has no elevation for
        it, so the lookup is stubbed."""
        taxi = [1707.0] * 30
        climb = [1707.0 + i * 100.0 for i in range(1, 31)]
        path = _profile(*taxi, *climb)
        metadata: list[PathMetadata] = [
            {
                "start_point": [path[0].lat, path[0].lon, 1707.0],
                "airport_name": "LSZS Samedan - EDDM Munich",
            }
        ]

        with patch.object(
            airports_module, "lookup_airport_elevation", return_value=1707.0
        ):
            result = deduplicate_airports(metadata, [path])

        assert [(a.name, a.is_at_path_end) for a in result] == [("LSZS Samedan", False)]

    def test_departure_from_a_high_field_without_the_database(self):
        """Without a known elevation the lowest altitude of the path is the ground."""
        taxi = [1707.0] * 30
        climb = [1707.0 + i * 100.0 for i in range(1, 31)]
        path = _profile(*taxi, *climb)
        metadata: list[PathMetadata] = [
            {
                "start_point": [path[0].lat, path[0].lon, 1707.0],
                "airport_name": "Alpine Strip - Valley Field",
            }
        ]

        result = deduplicate_airports(metadata, [path])

        assert [a.name for a in result] == ["Alpine Strip"]

    def test_landing_at_an_alpine_field(self):
        descent = [3500.0 - i * 60.0 for i in range(30)]
        path = _profile(*descent, 1707.0, 1707.0)
        metadata: list[PathMetadata] = [
            {
                "start_point": [path[0].lat, path[0].lon, 3500.0],
                "airport_name": "EDDM Munich - LSZS Samedan",
            }
        ]

        with patch.object(
            airports_module, "lookup_airport_elevation", return_value=1707.0
        ):
            result = deduplicate_airports(metadata, [path])

        assert [(a.name, a.is_at_path_end) for a in result] == [
            ("EDDM Munich", False),
            ("LSZS Samedan", True),
        ]

    def test_route_airports_keep_their_own_names(self):
        """A " - " inside an airport name must not merge both names into one."""
        path = _path((51.55, 12.05, 100), (48.9, 6.0, 900), (46.31, -0.39, 60))
        metadata: list[PathMetadata] = [
            {
                "start_point": [51.55, 12.05, 100],
                "airport_name": "EDAQ Halle-Oppin - LFBN Niort - Marais Poitevin",
                "start_airport": "EDAQ Halle-Oppin",
                "end_airport": "LFBN Niort - Marais Poitevin",
            }
        ]

        result = deduplicate_airports(metadata, [path])

        assert [(a.name, a.is_at_path_end) for a in result] == [
            ("EDAQ Halle-Oppin", False),
            ("LFBN Niort - Marais Poitevin", True),
        ]
        # Both snap to their own database position
        assert result[0].lat == pytest.approx(51.552223)
        assert result[1].lat == pytest.approx(46.313477)
        assert [
            extract_airport_name(a.name or "", a.is_at_path_end) for a in result
        ] == [
            "EDAQ Halle-Oppin",
            "LFBN Niort - Marais Poitevin",
        ]

    def test_parsed_non_route_registers_no_arrival(self):
        path = _path((50.0, 8.5, 100), (50.86, 7.14, 200))
        metadata: list[PathMetadata] = [
            {
                "start_point": [50.0, 8.5, 100],
                "airport_name": "EDDS Some Field - Other Field - Third",
                "start_airport": None,
                "end_airport": None,
            }
        ]

        result = deduplicate_airports(metadata, [path])

        assert [a.name for a in result] == ["EDDS Some Field - Other Field - Third"]

    @pytest.mark.parametrize(
        "name", ["Flight with Anna", "Untitled Path", "Sunday flight 16 Aug 2026"]
    )
    def test_free_text_is_no_airport(self, name):
        """A placemark name that is no route and has no code is no marker."""
        path = _path((50.0, 8.5, 100), (50.1, 8.6, 200))
        metadata: list[PathMetadata] = [
            {"start_point": [50.0, 8.5, 100], "airport_name": name}
        ]

        assert deduplicate_airports(metadata, [path]) == []

    def test_equal_names_without_a_code_are_one_airport(self):
        """The page keys its airports by name: one name is one marker."""
        paths = [
            _path((50.0, 8.5, 100), (50.1, 8.6, 200)),
            # Far from the first, but from the same field by its name
            _path((50.5, 9.5, 100), (50.6, 9.6, 200)),
        ]
        metadata: list[PathMetadata] = [
            {
                "start_point": [p[0].lat, p[0].lon, 100],
                "airport_name": "Home strip - Aunt farm",
                "start_airport": "Home strip",
                "end_airport": "Aunt farm",
            }
            for p in paths
        ]

        result = deduplicate_airports(metadata, paths)

        assert [(a.name, a.lat) for a in result] == [
            ("Home strip", 50.0),
            ("Aunt farm", 50.1),
        ]

    def test_mid_flight_route_omits_departure(self):
        cruise = [3000.0] * 30
        descent = [3000.0 - i * 290.0 for i in range(1, 11)]
        path = _profile(*cruise, *descent)
        metadata: list[PathMetadata] = [
            {
                "start_point": [path[0].lat, path[0].lon, 3000],
                "airport_name": "EDDF Frankfurt - EDDK Cologne",
            }
        ]

        result = deduplicate_airports(metadata, [path])

        assert len(result) == 1
        assert result[0].is_at_path_end is True


class TestAirportDeduplicator:
    def test_initialization(self):
        deduplicator = AirportDeduplicator()
        assert deduplicator.unique_airports == []
        assert deduplicator.spatial_grid == {}

    def test_custom_grid_size(self):
        assert AirportDeduplicator(grid_size=0.5).grid_size == 0.5

    def test_add_new_airport(self):
        deduplicator = AirportDeduplicator()
        idx = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="Some Field Name",
            path_index=0,
            is_at_path_end=False,
        )
        assert idx == 0
        assert deduplicator.unique_airports[0].name == "Some Field Name"
        assert deduplicator.unique_airports[0].lat == 50.0

    def test_icao_name_uses_database_coordinates(self):
        deduplicator = AirportDeduplicator()
        deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="EDDF",
            path_index=0,
            is_at_path_end=False,
        )
        airport = deduplicator.unique_airports[0]
        assert airport.lat == pytest.approx(50.026706)
        assert airport.lon == pytest.approx(8.55835)

    def test_route_uses_arrival_icao_at_path_end(self):
        deduplicator = AirportDeduplicator()
        deduplicator.add_or_update_airport(
            lat=0.0,
            lon=0.0,
            name="EDDF - EDDM",
            path_index=0,
            is_at_path_end=True,
        )
        airport = deduplicator.unique_airports[0]
        assert airport.lat == pytest.approx(48.353802)

    def test_update_existing_airport(self):
        deduplicator = AirportDeduplicator()
        idx1 = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="EDDF",
            path_index=0,
            is_at_path_end=False,
        )
        idx2 = deduplicator.add_or_update_airport(
            lat=50.0001,
            lon=8.5001,
            name="EDDF",
            path_index=1,
            is_at_path_end=False,
        )
        assert idx1 == idx2
        assert len(deduplicator.unique_airports) == 1

    def test_prefer_route_names_over_markers(self):
        deduplicator = AirportDeduplicator()
        idx1 = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="Log Start: EDDF",
            path_index=0,
            is_at_path_end=False,
        )
        idx2 = deduplicator.add_or_update_airport(
            lat=50.0001,
            lon=8.5001,
            name="EDDF Frankfurt - EDDM Munich",
            path_index=1,
            is_at_path_end=False,
        )
        assert idx1 == idx2
        assert deduplicator.unique_airports[0].name == "EDDF Frankfurt - EDDM Munich"

    @pytest.mark.parametrize("lat", [0.0, 51.0, 70.0, -65.0, 89.99])
    def test_fields_within_the_merge_distance_merge_at_any_latitude(self, lat):
        """At 51°N a 0.018° grid cell is only 1.26 km wide."""
        dlon = 1.45 / haversine_distance(lat, 0.0, lat, 1.0)
        # Start just before a cell boundary so the second point is two cells on
        start = 445 * AIRPORT_GRID_SIZE_DEGREES - 0.00001
        assert haversine_distance(lat, start, lat, start + dlon) < 1.5
        deduplicator = AirportDeduplicator()
        for lon in (start, start + dlon):
            deduplicator.add_or_update_airport(
                lat=lat, lon=lon, name=None, path_index=0, is_at_path_end=False
            )
        assert len(deduplicator.unique_airports) == 1

    def test_fields_beyond_the_merge_distance_stay_apart(self):
        deduplicator = AirportDeduplicator()
        dlon = 1.6 / haversine_distance(51.0, 0.0, 51.0, 1.0)
        for lon in (8.0, 8.0 + dlon):
            deduplicator.add_or_update_airport(
                lat=51.0, lon=lon, name=None, path_index=0, is_at_path_end=False
            )
        assert len(deduplicator.unique_airports) == 2

    def test_get_unique_airports(self):
        deduplicator = AirportDeduplicator()
        deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name="EDDF",
            path_index=0,
            is_at_path_end=False,
        )
        deduplicator.add_or_update_airport(
            lat=51.0,
            lon=9.5,
            name="EDDM",
            path_index=1,
            is_at_path_end=False,
        )
        assert len(deduplicator.get_unique_airports()) == 2

    def test_airport_with_no_name(self):
        deduplicator = AirportDeduplicator()
        idx = deduplicator.add_or_update_airport(
            lat=50.0,
            lon=8.5,
            name=None,
            path_index=0,
            is_at_path_end=False,
        )
        assert idx == 0
        assert deduplicator.unique_airports[0].name is None


class TestIcaoCodesNeverMerge:
    def _add(self, deduplicator, lat, lon, name):
        return deduplicator.add_or_update_airport(
            lat=lat, lon=lon, name=name, path_index=0, is_at_path_end=False
        )

    def test_different_codes_stay_apart_however_close(self):
        """EDTX and EDTY are 0.7 km apart and two airports all the same."""
        deduplicator = AirportDeduplicator()
        first = self._add(deduplicator, 49.2, 9.5, "ZZTX Field")
        second = self._add(deduplicator, 49.2, 9.5097, "ZZTY Other Field")
        assert haversine_distance(49.2, 9.5, 49.2, 9.5097) < 0.8
        assert first != second
        assert [a.name for a in deduplicator.unique_airports] == [
            "ZZTX Field",
            "ZZTY Other Field",
        ]

    def test_same_code_merges_at_any_distance(self):
        deduplicator = AirportDeduplicator()
        first = self._add(deduplicator, 49.2, 9.5, "ZZTX Field")
        second = self._add(deduplicator, 49.3, 9.6, "ZZTX Field")
        assert first == second

    def test_entry_without_a_code_merges_by_proximity(self):
        deduplicator = AirportDeduplicator()
        first = self._add(deduplicator, 49.2, 9.5, "ZZTX Field")
        second = self._add(deduplicator, 49.2, 9.501, "Aunt Martha")
        assert first == second
        assert deduplicator.unique_airports[0].name == "ZZTX Field"

    def test_entry_without_a_code_merges_with_the_nearest_field(self):
        """Two fields 0.7 km apart: an end 70 m from the second is the second."""
        deduplicator = AirportDeduplicator()
        first = self._add(deduplicator, 49.2, 9.5, "ZZTX Field")
        second = self._add(deduplicator, 49.2, 9.5097, "ZZTY Other Field")
        near_second = self._add(deduplicator, 49.2, 9.5088, "Aunt Martha")
        assert haversine_distance(49.2, 9.5088, 49.2, 9.5) < 1.5
        assert near_second == second != first

    @pytest.mark.parametrize("coded_first", [True, False])
    def test_code_wins_whatever_the_order(self, coded_first):
        """The coded entry must not lose its marker to a nearby plain name."""
        coded: PathMetadata = {
            "start_point": [49.2, 9.5, 200.0],
            "airport_name": "ZZTX Field",
            "start_airport": None,
            "end_airport": None,
        }
        plain: PathMetadata = {**coded, "airport_name": "Aunt Martha"}
        plain["start_point"] = [49.2, 9.501, 200.0]
        path = _path((49.2, 9.5, 200.0), (49.3, 9.6, 200.0))
        metadata = [coded, plain] if coded_first else [plain, coded]
        result = deduplicate_airports(metadata, [path, path])
        assert [a.name for a in result] == ["ZZTX Field"]


class TestAntimeridian:
    def test_fields_across_the_antimeridian_merge(self):
        deduplicator = AirportDeduplicator()
        for lon in (179.9995, -179.9995):
            deduplicator.add_or_update_airport(
                lat=-16.0, lon=lon, name=None, path_index=0, is_at_path_end=False
            )
        assert haversine_distance(-16.0, 179.9995, -16.0, -179.9995) < 0.2
        assert len(deduplicator.unique_airports) == 1

    def test_grid_wraps(self):
        deduplicator = AirportDeduplicator()
        east = deduplicator._get_grid_key(0.0, 179.999)[1]
        west = deduplicator._get_grid_key(0.0, -180.0)[1]
        assert west == 0
        assert (east + 1) % deduplicator._lon_cell_count == west
