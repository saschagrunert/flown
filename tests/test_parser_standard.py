"""Tests for parser_standard module."""

from unittest.mock import MagicMock

from flown.aircraft import AircraftInfo
from flown.parser_common import empty_placemark_metadata
from flown.parser_standard import process_standard_coordinates
from flown.types import FlightPath, FlightPathGroup, PathMetadata, TrackPoint


def _elem(text):
    elem = MagicMock()
    elem.text = text
    return elem


def _run(elements, metadata=None, kml_file="test.kml"):
    coordinates: FlightPath = []
    path_groups: FlightPathGroup = []
    path_metadata: list[PathMetadata] = []
    process_standard_coordinates(
        elements,
        metadata or {},
        kml_file,
        coordinates,
        path_groups,
        path_metadata,
        None,
    )
    return coordinates, path_groups, path_metadata


class TestProcessStandardCoordinates:
    def test_none_text_skipped(self):
        assert _run([_elem(None)]) == ([], [], [])

    def test_empty_text_skipped(self):
        assert _run([_elem("   ")]) == ([], [], [])

    def test_single_point_is_no_path(self):
        """A waypoint would otherwise register an airport at its position."""
        coordinates, path_groups, path_metadata = _run([_elem("8.5,50.0,100.0")])
        assert coordinates == [TrackPoint(50.0, 8.5, 100.0, None)]
        assert path_groups == []
        assert path_metadata == []

    def test_two_points_form_a_path(self):
        coordinates, path_groups, path_metadata = _run(
            [_elem("8.5,50.0,100.0 8.6,50.1,150.0")]
        )
        assert path_groups == [coordinates]
        assert path_metadata[0]["start_point"] == [50.0, 8.5, 100.0]
        assert path_metadata[0]["filename"] == "test.kml"

    def test_space_after_comma_is_tolerated(self):
        """Google Earth accepts "lon, lat, alt" tuples; the split must not tear them."""
        coordinates, path_groups, _ = _run(
            [_elem("8.5, 50.0, 100.0\n8.6, 50.1,\t150.0 8.7,50.2,200.0")]
        )
        assert [(p.lat, p.lon, p.alt) for p in coordinates] == [
            (50.0, 8.5, 100.0),
            (50.1, 8.6, 150.0),
            (50.2, 8.7, 200.0),
        ]
        assert path_groups == [coordinates]

    def test_multi_point_path(self):
        coordinates, path_groups, _ = _run(
            [_elem("8.5,50.0,100.0 8.6,50.1,150.0 8.7,50.2,200.0")]
        )
        assert len(coordinates) == 3
        assert path_groups == [coordinates]

    def test_invalid_coordinates_skipped(self):
        coordinates, path_groups, _ = _run(
            [_elem("invalid 8.5,50.0,100.0 also-invalid 8.6,50.1,150.0")]
        )
        assert coordinates == [
            TrackPoint(50.0, 8.5, 100.0, None),
            TrackPoint(50.1, 8.6, 150.0, None),
        ]
        assert len(path_groups) == 1

    def test_metadata_lookup(self):
        elem = _elem("8.5,50.0,100.0 8.6,50.1,150.0")
        metadata = {
            id(elem): {
                "airport_name": "EDDS",
                "start_airport": None,
                "end_airport": None,
                "timestamp": "2025-03-03T08:58:01Z",
                "end_timestamp": None,
                "year": 2025,
            }
        }
        _, _, path_metadata = _run([elem], metadata)
        assert path_metadata[0]["airport_name"] == "EDDS"
        assert path_metadata[0]["timestamp"] == "2025-03-03T08:58:01Z"
        assert path_metadata[0]["year"] == 2025

    def test_missing_metadata_uses_empty_defaults(self):
        _, _, path_metadata = _run([_elem("8.5,50.0,100.0 8.6,50.1,150.0")])
        empty = empty_placemark_metadata()
        assert path_metadata[0]["airport_name"] == ""
        assert path_metadata[0]["timestamp"] == empty["timestamp"]
        assert path_metadata[0]["year"] is None

    def test_newline_separated_coordinates(self):
        coordinates, _, _ = _run([_elem("8.5,50.0,100.0\n8.6,50.1,150.0")])
        assert len(coordinates) == 2

    def test_multiple_elements(self):
        _, path_groups, path_metadata = _run(
            [
                _elem("8.5,50.0,100.0 8.6,50.1,150.0"),
                _elem("9.0,51.0,200.0 9.1,51.1,250.0"),
            ]
        )
        assert len(path_groups) == 2
        assert len(path_metadata) == 2

    def test_coordinates_without_altitude_are_not_paths(self, capsys):
        coordinates, path_groups, path_metadata = _run(
            [_elem("8.5,50.0 8.6,50.1")], kml_file="dir/1_DEAGJ_DA20.kml"
        )
        assert coordinates == [
            TrackPoint(50.0, 8.5, None, None),
            TrackPoint(50.1, 8.6, None, None),
        ]
        assert path_groups == []
        assert path_metadata == []
        # The file still has points, so nothing else would reveal the lost flight
        assert "1_DEAGJ_DA20.kml: 1 line(s) without usable altitudes were ignored" in (
            capsys.readouterr().err
        )

    def test_point_without_altitude_is_not_reported(self, capsys):
        _run([_elem("8.5,50.0")])
        assert capsys.readouterr().err == ""

    def test_aircraft_info_of_the_file_is_used(self):
        coordinates: FlightPath = []
        path_groups: FlightPathGroup = []
        path_metadata: list[PathMetadata] = []
        process_standard_coordinates(
            [_elem("8.5,50.0,100.0 8.6,50.1,150.0")],
            {},
            "whatever.kml",
            coordinates,
            path_groups,
            path_metadata,
            AircraftInfo("D-EAGJ", "DA20"),
        )
        assert path_metadata[0]["aircraft_registration"] == "D-EAGJ"
        assert path_metadata[0]["aircraft_type"] == "DA20"

    def test_invalid_altitude_point_excluded_from_path(self, capsys):
        coordinates, path_groups, _ = _run([_elem("8.5,50.0,999999 8.6,50.1,150.0")])
        assert len(coordinates) == 2
        assert coordinates[0].alt is None
        # One usable altitude is no path, and the line is reported as ignored
        assert path_groups == []
        assert "1 line(s) without usable altitudes" in capsys.readouterr().err

    def test_negative_altitude_kept(self):
        _, path_groups, _ = _run([_elem("8.5,50.0,-50 8.6,50.1,150.0")])
        assert path_groups[0][0].alt == -50.0


class TestPositionSpikes:
    """A point far off a line without times (see spikes.distance_spikes)."""

    def _line(self, count=600):
        return [f"{8.0 + 0.0007 * i:.5f},50.0,500" for i in range(count)]

    def test_a_spike_leaves_the_path_and_the_heat(self):
        """It stretched the map to the equator, and made the average speed of
        the line so fast that every groundspeed came out unknown
        (regression)."""
        points = self._line()
        points[300] = "8.21,0.0,500"
        points[301] = "8.2107,0.0001,500"

        coordinates, path_groups, _ = _run([_elem(" ".join(points))])

        assert len(coordinates) == len(path_groups[0]) == 598
        assert min(point.lat for point in coordinates) == 50.0

    def test_zeroed_points_at_the_start(self):
        points = self._line()
        points[0] = points[1] = "13.0,0.0,500"

        coordinates, _, _ = _run([_elem(" ".join(points))])

        assert len(coordinates) == 598
        assert min(point.lat for point in coordinates) == 50.0

    def test_points_far_off_at_an_end_stay(self):
        """Without times, a far end is no stale fix: the line may start
        there, or go on there after an outage (regression)."""
        points = self._line()
        points[0] = points[1] = "13.0,52.0,500"
        points[-8:] = [f"{9.0 + 0.0007 * i:.5f},51.0,500" for i in range(8)]

        coordinates, _, _ = _run([_elem(" ".join(points))])

        assert len(coordinates) == 600

    def test_the_far_fixes_of_an_out_and_back_with_an_outage_stay(self):
        """Dense near the field, a few fixes 120 km out after an outage, and
        back: without times no glitch can be told from it (regression: the
        turning point was dropped)."""
        points = self._line()
        points[300:305] = [f"{9.7 + 0.0007 * i:.5f},50.0,500" for i in range(5)]

        coordinates, _, _ = _run([_elem(" ".join(points))])

        assert len(coordinates) == 600

    def test_the_long_last_leg_of_a_route_stays(self):
        """Forty points a kilometre apart, then 120 km straight to the
        destination (regression: the destination was dropped)."""
        route = [f"{8.0 + 0.014 * i:.4f},50.0,500" for i in range(40)]
        route.append("10.2,50.9,500")

        coordinates, _, _ = _run([_elem(" ".join(route))])

        assert len(coordinates) == 41

    def test_a_route_of_long_legs_stays(self):
        """A route plan: few points, each tens of kilometres from the last."""
        route = "8.0,50.0,500 8.5,50.4,500 9.3,50.1,500 10.0,51.0,500 8.0,50.0,500"

        coordinates, _, _ = _run([_elem(route)])

        assert len(coordinates) == 5
