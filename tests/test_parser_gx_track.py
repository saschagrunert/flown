"""Tests for parser_gx_track module."""

from datetime import UTC, datetime, timedelta

import pytest
from lxml import etree

from flown.aircraft import parse_aircraft_from_filename
from flown.constants import KML_NAMESPACES
from flown.helpers import parse_timestamp_epoch
from flown.parser_common import local_name
from flown.parser_gx_track import (
    _collect_track_children,
    _position_spikes,
    parse_gx_tracks,
    process_gx_track,
)
from flown.types import FlightPath, FlightPathGroup, PathMetadata, TrackPoint

KML_NS = KML_NAMESPACES["kml"]
GX_NS = KML_NAMESPACES["gx"]


def _iso(moment):
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _document():
    # lxml takes None for the default namespace, which its stubs do not know
    nsmap = {None: KML_NS, "gx": GX_NS}
    return etree.Element(f"{{{KML_NS}}}Document", nsmap=nsmap)  # type: ignore[arg-type]


def _placemark(document, name=None, description=None, timestamp=None):
    pm = etree.SubElement(document, f"{{{KML_NS}}}Placemark")
    if name is not None:
        etree.SubElement(pm, f"{{{KML_NS}}}name").text = name
    if description is not None:
        etree.SubElement(pm, f"{{{KML_NS}}}description").text = description
    if timestamp is not None:
        ts = etree.SubElement(pm, f"{{{KML_NS}}}TimeStamp")
        etree.SubElement(ts, f"{{{KML_NS}}}when").text = timestamp
    return pm


def _track(parent, coords=(), whens=(), interleave=True):
    """Add a gx:Track (interleaved when/coord pairs, as SkyDemon writes them)."""
    track = etree.SubElement(parent, f"{{{GX_NS}}}Track")
    if interleave:
        for idx, coord in enumerate(coords):
            if idx < len(whens):
                etree.SubElement(track, f"{{{KML_NS}}}when").text = whens[idx]
            etree.SubElement(track, f"{{{GX_NS}}}coord").text = coord
        for when in whens[len(coords) :]:
            etree.SubElement(track, f"{{{KML_NS}}}when").text = when
    else:
        for when in whens:
            etree.SubElement(track, f"{{{KML_NS}}}when").text = when
        for coord in coords:
            etree.SubElement(track, f"{{{GX_NS}}}coord").text = coord
    return track


def _run(tracks):
    coordinates: FlightPath = []
    path_groups: FlightPathGroup = []
    path_metadata: list[PathMetadata] = []
    process_gx_track(
        tracks,
        KML_NAMESPACES,
        "1_DEAGJ_DA20.kml",
        coordinates,
        path_groups,
        path_metadata,
        parse_aircraft_from_filename("1_DEAGJ_DA20.kml"),
    )
    return coordinates, path_groups, path_metadata


class TestCollectTrackChildren:
    def test_interleaved_and_grouped_children_give_the_same_lists(self):
        whens = ["2025-01-01T10:00:00Z", " 2025-01-01T10:00:05Z ", ""]
        coords = ["8.0 50.0 100", "8.1 50.1 110", None]
        one = _track(_document(), coords, whens, interleave=True)
        other = _track(_document(), coords, whens, interleave=False)

        expected = ([w.strip() for w in whens], coords)
        assert _collect_track_children(one) == expected
        assert _collect_track_children(other) == expected

    def test_children_without_a_namespace_and_others_are_told_apart(self):
        track = etree.fromstring(
            "<Track><when>a</when><coord>1 2 3</coord><altitudeMode>absolute"
            "</altitudeMode><whenever>x</whenever><when>b</when></Track>"
        )

        assert _collect_track_children(track) == (["a", "b"], ["1 2 3"])


class TestLocalName:
    def test_strips_namespace(self):
        assert local_name(f"{{{GX_NS}}}coord") == "coord"
        assert local_name("when") == "when"

    def test_non_string_tags(self):
        assert local_name(etree.Comment) == ""


class TestParseGxTrack:
    def test_parses_coordinates_and_timestamps(self):
        track = _track(
            _document(),
            ["8.5 50.0 300", "9.0 51.0 400"],
            ["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
        )
        coordinates: FlightPath = []
        path, whens = parse_gx_tracks([track], "test.kml", coordinates)
        assert path == [
            TrackPoint(50.0, 8.5, 300.0, parse_timestamp_epoch("2025-03-01T10:00:00Z")),
            TrackPoint(51.0, 9.0, 400.0, parse_timestamp_epoch("2025-03-01T11:00:00Z")),
        ]
        assert coordinates == path
        assert whens == ["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"]

    def test_grouped_whens_and_coords_pair_by_position(self):
        track = _track(
            _document(),
            ["8.5 50.0 300", "9.0 51.0 400"],
            ["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
            interleave=False,
        )
        path, _ = parse_gx_tracks([track], "test.kml", [])
        assert path[1].ts == parse_timestamp_epoch("2025-03-01T11:00:00Z")

    def test_without_timestamps(self):
        track = _track(_document(), ["8.5 50.0 300"])
        path, whens = parse_gx_tracks([track], "test.kml", [])
        assert path == [TrackPoint(50.0, 8.5, 300.0, None)]
        assert whens == []

    def test_coordinate_without_altitude_only_in_coordinates(self):
        track = _track(_document(), ["8.5 50.0"])
        coordinates: FlightPath = []
        path, _ = parse_gx_tracks([track], "test.kml", coordinates)
        assert path == []
        assert coordinates == [TrackPoint(50.0, 8.5, None, None)]

    def test_invalid_altitude_treated_as_missing(self):
        track = _track(_document(), ["8.5 50.0 999999"])
        coordinates: FlightPath = []
        path, _ = parse_gx_tracks([track], "test.kml", coordinates)
        assert path == []
        assert coordinates[0].alt is None

    def test_skips_empty_and_invalid_coords(self):
        track = _track(
            _document(),
            ["", "   ", "8.5", "abc def ghi", "8.5 999.0 100", "8.5 50.0 300"],
        )
        etree.SubElement(track, f"{{{GX_NS}}}coord")  # text is None
        path, _ = parse_gx_tracks([track], "test.kml", [])
        assert path == [TrackPoint(50.0, 8.5, 300.0, None)]

    def test_count_mismatch_warns_and_pairs_by_position(self, capsys):
        track = _track(
            _document(), ["8.5 50.0 300", "9.0 51.0 400"], ["2025-03-01T10:00:00Z"]
        )
        path, whens = parse_gx_tracks([track], "test.kml", [])
        assert path[0].ts == parse_timestamp_epoch("2025-03-01T10:00:00Z")
        assert path[1].ts is None
        assert whens == ["2025-03-01T10:00:00Z"]
        assert "1 <when> but 2 <gx:coord>" in capsys.readouterr().err

    def test_unparsable_when_gives_none_timestamp(self):
        track = _track(_document(), ["8.5 50.0 300"], ["yesterday"])
        path, whens = parse_gx_tracks([track], "test.kml", [])
        assert path[0].ts is None
        assert whens == []

    def test_returned_whens_are_those_of_the_timed_path_points(self):
        track = _track(
            _document(),
            ["invalid", "8.5 50.0", "8.5 50.0 300", "9.0 51.0 400"],
            [
                "2024-03-01T10:00:00Z",
                "2025-03-01T09:00:00Z",
                "2025-03-01T10:00:00Z",
                "2025-03-01T11:00:00Z",
            ],
        )
        path, whens = parse_gx_tracks([track], "test.kml", [])
        assert len(path) == 2
        assert whens == ["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"]

    def test_out_of_order_timestamp_is_dropped(self):
        """A GPS week rollover or a clock resync must not run time backwards."""
        track = _track(
            _document(),
            ["8.5 50.0 300", "8.6 50.1 300", "8.7 50.2 300", "8.8 50.3 300"],
            [
                "2025-03-01T10:00:00Z",
                "2025-03-01T10:05:00Z",
                "2025-03-01T09:00:00Z",
                "2025-03-01T10:10:00Z",
            ],
        )
        path, whens = parse_gx_tracks([track], "test.kml", [])
        assert [p.ts for p in path] == [
            parse_timestamp_epoch("2025-03-01T10:00:00Z"),
            parse_timestamp_epoch("2025-03-01T10:05:00Z"),
            None,
            parse_timestamp_epoch("2025-03-01T10:10:00Z"),
        ]
        assert whens == [
            "2025-03-01T10:00:00Z",
            "2025-03-01T10:05:00Z",
            "2025-03-01T10:10:00Z",
        ]

    def test_single_stamp_from_the_future_is_dropped_alone(self):
        """One forward glitch must not cost every later point its time."""
        base = datetime(2025, 6, 1, 10, 0, tzinfo=UTC)
        whens = [_iso(base + timedelta(seconds=10 * i)) for i in range(300)]
        whens[5] = "2031-01-01T00:00:00Z"
        coords = [f"{8.5 + i * 0.001} 50.0 300" for i in range(300)]
        path, kept = parse_gx_tracks([_track(_document(), coords, whens)], "t.kml", [])
        assert [p.ts is None for p in path].count(True) == 1
        assert path[5].ts is None
        assert kept[-1] == whens[-1]
        assert len(kept) == 299

    def test_near_forward_glitch_is_dropped_alone(self):
        whens = [
            "2025-03-01T10:00:00Z",
            "2025-03-01T10:00:10Z",
            "2025-03-01T11:00:00Z",
            "2025-03-01T10:00:20Z",
            "2025-03-01T10:00:30Z",
        ]
        coords = [f"{8.5 + i * 0.01} 50.0 300" for i in range(5)]
        path, kept = parse_gx_tracks([_track(_document(), coords, whens)], "t.kml", [])
        assert [p.ts is not None for p in path] == [True, True, False, True, True]
        assert kept == [whens[0], whens[1], whens[3], whens[4]]

    def test_clock_before_the_gps_fix_is_dropped(self):
        """A logger's clock sits at its default date until the GPS fix."""
        whens = ["2000-01-01T00:00:00Z", "2000-01-01T00:00:05Z"] + [
            f"2025-06-01T10:00:{s:02d}Z" for s in range(0, 50, 10)
        ]
        coords = [f"{8.5 + i * 0.01} 50.0 300" for i in range(7)]
        path, kept = parse_gx_tracks([_track(_document(), coords, whens)], "t.kml", [])
        assert path[0].ts is None
        assert path[1].ts is None
        assert kept == whens[2:]

    def test_a_stamp_more_than_a_week_from_the_median_is_dropped(self):
        """Seven days: a logger left running for days keeps its stamps."""
        base = datetime(2025, 6, 1, 10, 0, tzinfo=UTC)
        whens = [
            _iso(base - timedelta(days=8)),
            _iso(base - timedelta(days=6)),
            *(_iso(base + timedelta(seconds=10 * i)) for i in range(5)),
        ]
        coords = [f"{8.5 + i * 0.01} 50.0 300" for i in range(7)]
        path, kept = parse_gx_tracks([_track(_document(), coords, whens)], "t.kml", [])
        assert path[0].ts is None
        assert path[1].ts is not None
        assert kept == whens[1:]

    def test_year_is_that_of_the_majority_of_the_track(self):
        doc = _document()
        pm = _placemark(doc, name="EDDS")
        whens = ["2000-01-01T00:00:00Z"] + [
            f"2025-06-01T10:00:{s:02d}Z" for s in range(0, 50, 10)
        ]
        track = _track(pm, [f"{8.5 + i * 0.01} 50.0 300" for i in range(6)], whens)
        _, _, metadata = _run([track])
        assert metadata[0]["year"] == 2025
        assert metadata[0]["timestamp"] == "2025-06-01T10:00:00Z"
        assert metadata[0]["end_timestamp"] == "2025-06-01T10:00:40Z"

    def test_null_island_coordinate_is_rejected(self):
        track = _track(
            _document(),
            ["8.5 50.0 300", "0 0 0", "8.6 50.1 300"],
            ["2025-03-01T10:00:00Z", "2025-03-01T10:00:05Z", "2025-03-01T10:00:10Z"],
        )
        coordinates: FlightPath = []
        path, whens = parse_gx_tracks([track], "t.kml", coordinates)
        assert [(p.lat, p.lon) for p in path] == [(50.0, 8.5), (50.1, 8.6)]
        assert len(coordinates) == 2
        assert whens == ["2025-03-01T10:00:00Z", "2025-03-01T10:00:10Z"]

    def test_ignores_comments_and_other_children(self):
        track = _track(_document(), ["8.5 50.0 300"], ["2025-03-01T10:00:00Z"])
        track.append(etree.Comment("ignored"))
        etree.SubElement(track, f"{{{GX_NS}}}angles").text = "1 2 3"
        path, _ = parse_gx_tracks([track], "test.kml", [])
        assert len(path) == 1


class TestProcessGxTrack:
    def test_no_tracks(self):
        assert _run([]) == ([], [], [])

    def test_single_track_with_placemark_metadata(self):
        doc = _document()
        pm = _placemark(doc, name="EDDS")
        track = _track(
            pm,
            ["8.5 50.0 300", "9.0 51.0 400"],
            ["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
        )

        coordinates, path_groups, path_metadata = _run([track])

        assert len(coordinates) == 2
        assert len(path_groups) == 1
        meta = path_metadata[0]
        assert meta["airport_name"] == "EDDS Stuttgart"
        assert meta["timestamp"] == "2025-03-01T10:00:00Z"
        assert meta["end_timestamp"] == "2025-03-01T11:00:00Z"
        assert meta["year"] == 2025
        assert meta["aircraft_registration"] == "D-EAGJ"
        assert meta["start_point"] == [50.0, 8.5, 300.0]

    def test_a_track_of_one_point_is_no_path(self):
        # As a LineString of one point: the point counts for the heat only
        doc = _document()
        pm = _placemark(doc, name="EDDS")
        track = _track(pm, ["8.5 50.0 300"], ["2025-03-01T10:00:00Z"])

        coordinates, path_groups, path_metadata = _run([track])

        assert len(coordinates) == 1
        assert path_groups == []
        assert path_metadata == []

    def test_two_tracks_in_one_placemark(self):
        doc = _document()
        pm = _placemark(doc, name="Two legs")
        first = _track(
            pm,
            ["8.5 50.0 300", "8.6 50.1 300"],
            ["2025-03-01T10:00:00Z", "2025-03-01T10:01:00Z"],
        )
        second = _track(
            pm,
            ["9.0 51.0 400", "9.1 51.1 400"],
            ["2025-03-01T12:00:00Z", "2025-03-01T12:05:00Z"],
        )

        coordinates, path_groups, path_metadata = _run([first, second])

        assert len(coordinates) == 4
        assert [len(p) for p in path_groups] == [2, 2]
        assert path_groups[1][0].ts == parse_timestamp_epoch("2025-03-01T12:00:00Z")
        assert [m["timestamp"] for m in path_metadata] == [
            "2025-03-01T10:00:00Z",
            "2025-03-01T12:00:00Z",
        ]
        assert [m["end_timestamp"] for m in path_metadata] == [
            "2025-03-01T10:01:00Z",
            "2025-03-01T12:05:00Z",
        ]
        assert all(m["airport_name"] == "Two legs" for m in path_metadata)

    def test_extra_timestamp_element_does_not_shift_pairing(self):
        doc = _document()
        pm = _placemark(doc, name="Track", timestamp="2025-02-01T00:00:00Z")
        track = _track(
            pm,
            ["8.5 50.0 300", "9.0 51.0 400"],
            ["2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
        )

        _, path_groups, path_metadata = _run([track])

        assert path_groups[0][0].ts == parse_timestamp_epoch("2025-03-01T10:00:00Z")
        assert path_groups[0][1].ts == parse_timestamp_epoch("2025-03-01T11:00:00Z")
        # The track's own timestamps define its span, not the placemark's TimeStamp
        assert path_metadata[0]["timestamp"] == "2025-03-01T10:00:00Z"
        assert path_metadata[0]["end_timestamp"] == "2025-03-01T11:00:00Z"

    def test_metadata_per_placemark(self):
        doc = _document()
        first = _track(
            _placemark(doc, name="EDAQ"),
            ["8.5 50.0 300", "8.6 50.1 300"],
            ["2025-03-01T10:00:00Z", "2025-03-01T10:01:00Z"],
        )
        second = _track(
            _placemark(doc, name="EDMV"),
            ["9.0 51.0 400", "9.1 51.1 400"],
            ["2026-03-01T10:00:00Z", "2026-03-01T10:01:00Z"],
        )

        _, _, path_metadata = _run([first, second])

        assert [m["airport_name"] for m in path_metadata] == [
            "EDAQ Halle-Oppin",
            "EDMV Vilshofen",
        ]
        assert [m["year"] for m in path_metadata] == [2025, 2026]
        assert [m["end_timestamp"] for m in path_metadata] == [
            "2025-03-01T10:01:00Z",
            "2026-03-01T10:01:00Z",
        ]

    def test_track_without_timestamps_uses_placemark_metadata(self):
        doc = _document()
        pm = _placemark(
            doc, name="Flight", description="Flight Jan 12 2026 03:01PM path of OE-AKI"
        )
        track = _track(pm, ["8.5 50.0 300", "8.6 50.1 300"])

        _, _, path_metadata = _run([track])

        assert path_metadata[0]["timestamp"] == "2026-01-12T15:01:00+00:00"
        assert path_metadata[0]["year"] == 2026

    def test_track_outside_placemark(self):
        track = _track(_document(), ["8.5 50.0 300", "8.6 50.1 300"])

        _, path_groups, path_metadata = _run([track])

        assert len(path_groups) == 1
        assert path_metadata[0]["airport_name"] == ""
        assert path_metadata[0]["year"] is None

    def test_track_without_valid_coords_is_skipped(self):
        track = _track(_placemark(_document(), name="X"), ["invalid"])
        assert _run([track]) == ([], [], [])

    def test_time_span_comes_from_the_path_points(self):
        """An unparsable first <when> must not cost the track its year."""
        track = _track(
            _placemark(_document(), name="EDDS"),
            ["8.5 50.0 300", "9.0 51.0 400", "9.1 51.1 400"],
            ["N/A", "2025-03-01T10:00:00Z", "2025-03-01T11:00:00Z"],
        )

        _, _, path_metadata = _run([track])

        assert path_metadata[0]["timestamp"] == "2025-03-01T10:00:00Z"
        assert path_metadata[0]["end_timestamp"] == "2025-03-01T11:00:00Z"
        assert path_metadata[0]["year"] == 2025


def _multi_track(parent, altitude_mode=None):
    multi = etree.SubElement(parent, f"{{{GX_NS}}}MultiTrack")
    if altitude_mode is not None:
        etree.SubElement(multi, f"{{{KML_NS}}}altitudeMode").text = altitude_mode
    return multi


class TestYearOfATrack:
    def test_a_flight_across_new_year_belongs_to_the_year_it_started(self):
        """Like a TimeSpan, and like the obfuscator, which anchors on the start."""
        start = datetime(2025, 12, 31, 23, 0, tzinfo=UTC)
        whens = [_iso(start + timedelta(minutes=10 * i)) for i in range(19)]
        coords = [f"{9.0 + 0.02 * i} 48.0 {400 + 20 * i}" for i in range(19)]
        track = _track(_placemark(_document(), name="EDDS - EDDP"), coords, whens)

        _, _, path_metadata = _run([track])

        # Most of the stamps are in 2026: the median would say 2026
        assert path_metadata[0]["year"] == 2025

    def test_a_clock_never_set_names_no_year(self):
        """Year 1 went into data/1/, which no year directory pattern matches,
        so it was never removed again."""
        whens = [f"0001-03-03T10:0{i}:00Z" for i in range(3)]
        coords = [f"{9.0 + 0.02 * i} 48.0 400" for i in range(3)]
        track = _track(_placemark(_document(), name="EDDS - EDDP"), coords, whens)

        _, path_groups, path_metadata = _run([track])

        assert len(path_groups) == 1
        assert path_metadata[0]["year"] is None


class TestMultiTrack:
    def test_the_tracks_of_a_multi_track_are_one_flight(self):
        """A recording that paused is still one flight, not one per part."""
        pm = _placemark(_document(), name="EDDS - EDDP")
        multi = _multi_track(pm)
        first = _track(
            multi,
            ["8.5 50.0 300", "8.6 50.1 350"],
            ["2025-03-01T10:00:00Z", "2025-03-01T10:01:00Z"],
        )
        second = _track(
            multi,
            ["8.9 50.4 500", "9.0 50.5 450"],
            ["2025-03-01T10:20:00Z", "2025-03-01T10:21:00Z"],
        )

        coordinates, path_groups, path_metadata = _run([first, second])

        assert len(coordinates) == 4
        assert len(path_groups) == len(path_metadata) == 1
        assert [point.alt for point in path_groups[0]] == [300, 350, 500, 450]
        assert path_metadata[0]["timestamp"] == "2025-03-01T10:00:00Z"
        assert path_metadata[0]["end_timestamp"] == "2025-03-01T10:21:00Z"

    def test_two_multi_tracks_are_two_flights(self):
        doc = _document()
        tracks: list[etree._Element] = []
        for day in (1, 2):
            multi = _multi_track(_placemark(doc, name="EDDS"))
            tracks.extend(
                _track(
                    multi,
                    [f"8.{hour} 50.0 300", f"8.{hour + 5} 50.1 300"],
                    [f"2025-03-0{day}T{hour}:00:00Z", f"2025-03-0{day}T{hour}:01:00Z"],
                )
                for hour in (10, 11)
            )

        _, path_groups, path_metadata = _run(tracks)

        assert [len(path) for path in path_groups] == [4, 4]
        assert [m["timestamp"][:10] for m in path_metadata] == [
            "2025-03-01",
            "2025-03-02",
        ]

    def test_the_altitude_mode_of_the_multi_track_applies_to_its_tracks(self, capsys):
        multi = _multi_track(_placemark(_document(), name="EDDS"), "relativeToGround")
        tracks = [
            _track(multi, ["8.5 50.0 300", "8.6 50.1 350"]),
            _track(multi, ["8.9 50.4 500", "9.0 50.5 450"]),
        ]

        coordinates, path_groups, _ = _run(tracks)

        assert path_groups == []
        assert [point.alt for point in coordinates] == [None] * 4
        # One warning for the flight, not one per track
        assert capsys.readouterr().err.count("altitudeMode relativeToGround") == 1

    def test_a_track_keeps_its_own_altitude_mode(self):
        multi = _multi_track(_placemark(_document(), name="EDDS"), "relativeToGround")
        track = _track(multi, ["8.5 50.0 300", "8.6 50.1 350"])
        etree.SubElement(track, f"{{{KML_NS}}}altitudeMode").text = "absolute"

        _, path_groups, _ = _run([track])

        assert [point.alt for point in path_groups[0]] == [300, 350]


def _east(count, start=0.0, lat=50.0, step_s=10.0):
    """(lat, lon, time) fixes east at 97 kt, ``step_s`` apart."""
    return [(lat, 8.0 + 0.007 * i, start + i * step_s) for i in range(count)]


class TestPositionSpikes:
    """A fix far off the flight, which stretched the map and the duplicate
    check (see parser_gx_track._position_spikes)."""

    @pytest.mark.parametrize(
        "spike",
        [
            (0.0, 8.035),  # the latitude zeroed
            (50.0, -8.035),  # the sign of the longitude flipped
            (50.0, 0.0),  # the longitude zeroed
        ],
    )
    def test_a_fix_far_off_between_two_that_agree(self, spike):
        fixes = _east(10)
        fixes[5] = (*spike, fixes[5][2])
        assert _position_spikes(fixes) == {5}

    def test_a_spike_at_either_end(self):
        fixes = _east(10)
        fixes[0] = (0.0, *fixes[0][1:])
        fixes[-1] = (50.0, 0.0, fixes[-1][2])
        assert _position_spikes(fixes) == {0, 9}

    def test_fast_flight_is_no_spike(self):
        """580 kt for every step: as fast as the limit allows, and kept."""
        fixes = [(50.0, 8.0 + 0.0416 * i, i * 10.0) for i in range(10)]
        assert _position_spikes(fixes) == set()

    def test_a_track_that_goes_on_elsewhere_is_no_spike(self):
        """A jump with nothing to go back to: a gap, not a stray fix."""
        fixes = _east(5) + _east(5, start=41.0, lat=52.0)
        assert _position_spikes(fixes) == set()

    def test_two_fixes_at_one_moment_are_no_spike(self):
        """GPS jitter between fixes with the same time is no jump."""
        fixes = _east(5)
        fixes.insert(3, (50.0005, fixes[2][1], fixes[2][2]))
        assert _position_spikes(fixes) == set()

    def test_too_few_fixes_to_tell(self):
        assert _position_spikes([(50.0, 8.0, 0.0), (0.0, 8.0, 10.0)]) == set()

    def test_a_spike_leaves_the_path_and_the_heat(self):
        start = datetime(2025, 6, 1, 10, 0, tzinfo=UTC)
        whens = [_iso(start + timedelta(seconds=10 * i)) for i in range(10)]
        coords = [f"{8.0 + 0.007 * i:.3f} 50.0 500" for i in range(10)]
        coords[4] = "8.028 0 500"
        track = _track(_placemark(_document(), name="EDDS - EDDP"), coords, whens)

        coordinates, path_groups, path_metadata = _run([track])

        assert len(path_groups[0]) == len(coordinates) == 9
        assert min(point.lat for point in coordinates) == 50.0
        assert path_metadata[0]["start_point"][0] == 50.0
