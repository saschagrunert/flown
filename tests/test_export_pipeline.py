"""Tests for export_pipeline module."""

import random
from itertools import pairwise
from typing import Any, cast

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from flown.constants import (
    ALTITUDE_GAIN_HYSTERESIS_FT,
    METERS_TO_FEET,
    SECONDS_PER_HOUR,
)
from flown.export_pipeline import (
    _segment_groundspeed,
    altitude_gain_m,
    build_path_info,
    exported_knots,
    path_duration,
    process_path_segments,
    without_altitude_spikes,
)
from flown.helpers import parse_timestamp_epoch
from flown.segment_calculator import SegmentSpeed, SpeedWindow
from flown.segment_codec import ALTITUDE_STEP
from flown.spikes import altitude_spikes
from flown.types import PathMetadata, TrackPoint
from tests.conftest import LINEAR_GROWTH, growth


def _metadata(fields: dict[str, Any]) -> PathMetadata:
    """Metadata built by hand, with only the keys a test is about.

    The functions under test read every key with ``get``, so the keys the
    parser always sets may be missing here.
    """
    return cast("PathMetadata", fields)


def _make_path(count=10, alt=1000.0, timed=False):
    path = []
    for i in range(count):
        ts = parse_timestamp_epoch(f"2025-03-03T08:{i:02d}:00Z") if timed else None
        path.append(TrackPoint(50.0 + i * 0.01, 8.5 + i * 0.01, alt + i * 50, ts))
    return path


class TestPathDuration:
    def test_duration(self):
        metadata = _metadata(
            {
                "timestamp": "2025-03-03T08:00:00Z",
                "end_timestamp": "2025-03-03T09:30:00Z",
            }
        )
        assert path_duration(metadata) == pytest.approx(5400.0)

    def test_missing_or_invalid_timestamps_give_zero_duration(self):
        assert path_duration(_metadata({})) == 0.0
        metadata = _metadata({"timestamp": "invalid", "end_timestamp": "also-invalid"})
        assert path_duration(metadata) == 0.0


class TestBuildPathInfo:
    def test_airport_name_parsing(self):
        metadata = _metadata({"airport_name": "EDDS - EDDP"})
        info = build_path_info(_make_path(), metadata, 4, 2025)
        assert info["start_airport"] == "EDDS"
        assert info["end_airport"] == "EDDP"
        assert info["year"] == 2025
        assert info["id"] == 4

    def test_none_values_are_omitted(self):
        metadata = _metadata({"airport_name": "", "aircraft_registration": None})
        info = build_path_info(_make_path(), metadata, 1, 2025)
        assert "start_airport" not in info
        assert "end_airport" not in info
        assert "aircraft_registration" not in info
        assert set(info) == {
            "id",
            "year",
            "min_altitude_ft",
            "max_altitude_ft",
            "altitude_gain_ft",
        }

    def test_key_order_is_stable(self):
        """The exported JSON keeps this order; the frontend contract test pins it."""
        info = build_path_info(
            _make_path(), _metadata({"airport_name": "A - B"}), 1, 2025
        )
        assert list(info) == [
            "id",
            "year",
            "min_altitude_ft",
            "max_altitude_ft",
            "altitude_gain_ft",
            "start_airport",
            "end_airport",
        ]

    def test_single_airport_no_split(self):
        info = build_path_info(
            _make_path(), _metadata({"airport_name": "EDDS"}), 0, 2025
        )
        assert "start_airport" not in info
        assert "end_airport" not in info

    @pytest.mark.parametrize(
        ("name", "markers", "expected"),
        [
            # A local flight: its marker has the name of the placemark
            ("EDDS Stuttgart", {"EDDS Stuttgart"}, "EDDS Stuttgart"),
            # The marker name has the date taken out as well
            ("Aunt farm 16 Aug", {"Aunt farm"}, "Aunt farm"),
            # A start in the air gets no marker
            ("EDDS Stuttgart", {"EDDP Leipzig"}, None),
            ("Home", {"Home"}, None),
            ("Takeoff: 03 Mar 2025 08:31 Z", {"Takeoff"}, None),
        ],
    )
    def test_single_airport_is_the_start_when_it_has_a_marker(
        self, name, markers, expected
    ):
        """The page only shows the markers of names in the path info."""
        metadata = _metadata(
            {"airport_name": name, "start_airport": None, "end_airport": None}
        )
        info = build_path_info(_make_path(), metadata, 0, 2025, frozenset(markers))
        assert info.get("start_airport") == expected
        assert "end_airport" not in info

    def test_an_end_with_the_code_of_a_marker_is_that_marker(self):
        """One code under two names makes one marker, under the first name.

        "EDZZ local flight" and then "EDZZ - EDDF", with EDZZ unknown to the
        airport database: the second flight lost its start.
        """
        metadata = _metadata({"airport_name": "EDZZ - EDDF Frankfurt Main"})
        markers = frozenset({"EDZZ local flight", "EDDF Frankfurt Main"})
        info = build_path_info(_make_path(), metadata, 0, 2025, markers)
        assert info.get("start_airport") == "EDZZ local flight"
        assert info.get("end_airport") == "EDDF Frankfurt Main"

    def test_an_end_without_a_marker_of_its_code_has_none(self):
        metadata = _metadata({"airport_name": "EDZZ - EDDF Frankfurt Main"})
        info = build_path_info(
            _make_path(), metadata, 0, 2025, frozenset({"EDDF Frankfurt Main"})
        )
        assert "start_airport" not in info

    def test_three_part_name_goes_from_the_first_stop_to_the_last(self):
        metadata = _metadata({"airport_name": "EDDF - EDDM - EDDT"})
        info = build_path_info(_make_path(), metadata, 0, 2025)
        assert info["start_airport"] == "EDDF"
        assert info["end_airport"] == "EDDT"

    def test_three_part_name_without_a_departure_code_not_split(self):
        metadata = _metadata({"airport_name": "Home strip - EDDM - EDDT"})
        info = build_path_info(_make_path(), metadata, 0, 2025)
        assert "start_airport" not in info

    def test_airports_come_from_the_parsed_metadata(self):
        """LFBN is "Niort - Marais Poitevin"; splitting the display name fails."""
        metadata = _metadata(
            {
                "airport_name": "EDAQ Halle-Oppin - LFBN Niort - Marais Poitevin",
                "start_airport": "EDAQ Halle-Oppin",
                "end_airport": "LFBN Niort - Marais Poitevin",
            }
        )
        info = build_path_info(_make_path(), metadata, 0, 2025)
        assert info["start_airport"] == "EDAQ Halle-Oppin"
        assert info["end_airport"] == "LFBN Niort - Marais Poitevin"

    def test_parsed_non_route_is_not_split(self):
        metadata = _metadata(
            {
                "airport_name": "Some Field - Other Field",
                "start_airport": None,
                "end_airport": None,
            }
        )
        info = build_path_info(_make_path(), metadata, 0, 2025)
        assert "start_airport" not in info
        assert "end_airport" not in info

    def test_names_match_the_exported_airports(self, tmp_path, parse_data):
        """The frontend counts a path for an airport by comparing these names."""
        from flown.airports import deduplicate_airports
        from flown.export_writers import export_airports_data
        from tests.conftest import parse_kml_coordinates

        kml = tmp_path / "1_DEAGJ_DA20.kml"
        coords = "".join(
            f"<gx:coord>{12.05 - i * 0.3} {51.55 - i * 0.13} "
            f"{100 if i in (0, 39) else 1500}</gx:coord>"
            for i in range(40)
        )
        kml.write_text(
            '<kml xmlns="http://www.opengis.net/kml/2.2" '
            'xmlns:gx="http://www.google.com/kml/ext/2.2"><Placemark>'
            "<name>EDAQ Halle-Oppin - LFBN Niort</name>"
            f"<gx:Track>{coords}</gx:Track></Placemark></kml>",
            encoding="utf-8",
        )
        _, paths, metadata = parse_kml_coordinates(str(kml))

        info = build_path_info(paths[0], metadata[0], 0, 2025)
        export_airports_data(deduplicate_airports(metadata, paths), str(tmp_path))
        airports = parse_data(tmp_path / "airports.json")["airports"]
        names = [airport["name"] for airport in airports]

        assert names == [info["start_airport"], info["end_airport"]]
        assert names == ["EDAQ Halle-Oppin", "LFBN Niort - Marais Poitevin"]

    def test_a_local_flight_names_its_marker(self, tmp_path, parse_data):
        """A single-airport name puts a marker on the map: the path names it."""
        from flown.airports import deduplicate_airports
        from flown.export_writers import (
            export_airports_data,
            exported_airport_names,
        )
        from tests.conftest import parse_kml_coordinates

        kml = tmp_path / "1_DEAGJ_DA20.kml"
        coords = "".join(
            f"<gx:coord>{9.22 + i * 0.01} {48.69 + (i % 20) * 0.005} "
            f"{400 if i in (0, 39) else 900}</gx:coord>"
            for i in range(40)
        )
        kml.write_text(
            '<kml xmlns="http://www.opengis.net/kml/2.2" '
            'xmlns:gx="http://www.google.com/kml/ext/2.2"><Placemark>'
            f"<name>EDDS</name><gx:Track>{coords}</gx:Track></Placemark></kml>",
            encoding="utf-8",
        )
        _, paths, metadata = parse_kml_coordinates(str(kml))
        airports = deduplicate_airports(metadata, paths)

        info = build_path_info(
            paths[0], metadata[0], 0, 2025, exported_airport_names(airports)
        )
        export_airports_data(airports, str(tmp_path))
        names = [a["name"] for a in parse_data(tmp_path / "airports.json")["airports"]]

        assert names == [info["start_airport"]]
        assert names == ["EDDS Stuttgart"]

    def test_an_end_without_a_marker_is_no_airport(self):
        """A "Home" end gets no marker, so it must not count as an airport."""
        metadata = _metadata(
            {
                "airport_name": "Home - EDDP",
                "start_airport": "Home",
                "end_airport": "EDDP",
            }
        )
        info = build_path_info(_make_path(), metadata, 0, 2025, frozenset({"EDDP"}))
        assert "start_airport" not in info
        assert info["end_airport"] == "EDDP"

    def test_without_marker_names_every_end_is_kept(self):
        metadata = _metadata({"airport_name": "Home - Away", "start_airport": "Home"})
        info = build_path_info(_make_path(), metadata, 0, 2025)
        assert info["start_airport"] == "Home"

    def test_aircraft_metadata_included(self):
        metadata = _metadata(
            {"aircraft_registration": "D-EAGJ", "aircraft_type": "C172"}
        )
        info = build_path_info(_make_path(), metadata, 0, 2025)
        assert info["aircraft_registration"] == "D-EAGJ"
        assert info["aircraft_type"] == "C172"

    def test_no_coordinates_or_counts(self):
        """The frontend reads both from the segments; see types.PathInfo."""
        info = build_path_info(_make_path(count=5), _metadata({}), 0, 2025)
        assert not {"start_coords", "end_coords", "segment_count"} & set(info)

    def test_altitude_range_omitted_without_altitudes(self):
        path = [TrackPoint(50.0, 8.5, None, None), TrackPoint(50.1, 8.6, None, None)]
        info = build_path_info(path, _metadata({}), 0, 2025)
        assert "min_altitude_ft" not in info
        assert "altitude_gain_ft" not in info

    def test_altitude_gain_of_a_climb(self):
        """_make_path climbs 50 m per point: 450 m, from the exact altitudes."""
        info = build_path_info(_make_path(), _metadata({}), 0, 2025)
        assert info["altitude_gain_ft"] == round(450 * METERS_TO_FEET, 1) == 1476.4

    @pytest.mark.parametrize(
        "name",
        [
            "Sunday flight 16 Aug 2026",
            "Flight EDDS-EDDP 2026-08-16",
            "EDXX 16 Aug 2026",
            "16.08.2026",
        ],
    )
    def test_no_date_in_the_airports(self, name):
        metadata = _metadata(
            {"airport_name": name, "start_airport": name, "end_airport": name}
        )
        info = build_path_info(_make_path(), metadata, 0, 2025)
        for airport in (info.get("start_airport", ""), info.get("end_airport", "")):
            assert "2026" not in airport
            assert "16" not in airport

    def test_a_date_is_no_aircraft_type(self):
        """The type is a part of the file name: 1_DEHYL_2026-08-16.kml."""
        metadata = _metadata(
            {"aircraft_registration": "D-EHYL", "aircraft_type": "2026-08-16"}
        )
        info = build_path_info(_make_path(), metadata, 0, 2025)
        assert "aircraft_type" not in info
        metadata["aircraft_type"] = "DA40 16 Aug 2026"
        assert build_path_info(_make_path(), metadata, 0, 2025)["aircraft_type"] == (
            "DA40"
        )

    @pytest.mark.parametrize("aircraft_type", ["1513h", "15h13", "0930z", "Saturday"])
    def test_a_time_or_weekday_is_no_aircraft_type(self, aircraft_type):
        """1_DEHYL_1513h.kml would publish the time of the flight."""
        metadata = _metadata(
            {"aircraft_registration": "D-EHYL", "aircraft_type": aircraft_type}
        )
        info = build_path_info(_make_path(), metadata, 0, 2025)
        assert "aircraft_type" not in info
        assert info["aircraft_registration"] == "D-EHYL"

    @pytest.mark.parametrize("aircraft_type", ["C172", "PA28", "DA20", "SR22", "DO27"])
    def test_a_type_stays(self, aircraft_type):
        metadata = _metadata({"aircraft_type": aircraft_type})
        info = build_path_info(_make_path(), metadata, 0, 2025)
        assert info["aircraft_type"] == aircraft_type


class TestAltitudeGain:
    HYSTERESIS_M = ALTITUDE_GAIN_HYSTERESIS_FT / METERS_TO_FEET

    def test_jitter_adds_nothing(self):
        """A level cruise with +-7 m of noise is no climb at all."""
        noise = [0, 7, -7, 5, -6, 7, -7, 0, 6, -5] * 50
        assert altitude_gain_m([1500.0 + n for n in noise]) == 0.0

    def test_a_climb_with_jitter_counts_once(self):
        """Up by 1000 m in wobbling steps: the wobbles do not add to it."""
        altitudes = []
        for step in range(100):
            base = 500.0 + step * 10
            altitudes.extend([base, base + 8, base - 4])
        gain = altitude_gain_m(altitudes)
        assert gain == pytest.approx(max(altitudes) - min(altitudes))

    def test_climbs_after_descents_add_up(self):
        altitudes = [300.0, 900.0, 600.0, 1200.0, 400.0]
        assert altitude_gain_m(altitudes) == pytest.approx(600 + 600)

    def test_rises_below_the_hysteresis_count_for_nothing(self):
        below = self.HYSTERESIS_M - 0.1
        assert altitude_gain_m([100.0, 100 + below, 100.0, 100 + below]) == 0.0
        above = self.HYSTERESIS_M + 0.1
        assert altitude_gain_m([100.0, 100 + above]) == pytest.approx(above)

    def test_the_hysteresis_itself_counts(self):
        """A rise or dip of exactly the hysteresis starts or ends a climb."""
        h = self.HYSTERESIS_M
        assert altitude_gain_m([0.0, h]) == h
        # The dip to h ends the climb to 2h, and the rise back is another
        assert altitude_gain_m([0.0, 2 * h, h, 2 * h]) == pytest.approx(3 * h)

    def test_a_dip_below_the_hysteresis_does_not_end_a_climb(self):
        altitudes = [100.0, 500.0, 500 - self.HYSTERESIS_M + 1, 800.0]
        assert altitude_gain_m(altitudes) == pytest.approx(700.0)

    def test_empty(self):
        assert altitude_gain_m([]) == 0.0


def _feet_path(*altitudes_ft):
    """Fixes a second apart, eastward, at these altitudes in feet."""
    return [
        TrackPoint(50.0, 8.0 + i * 0.001, alt / METERS_TO_FEET, 1000.0 + i)
        for i, alt in enumerate(altitudes_ft)
    ]


def _feet(path):
    return [round(point.alt * METERS_TO_FEET, 6) for point in path]


class TestAltitudeSpikes:
    def test_a_fix_at_0_ft_in_flight(self):
        altitudes = [2000.0, 2010, 2020, 0, 2040, 2050, 2060]
        assert altitude_spikes(altitudes) == [False] * 3 + [True] + [False] * 3

    def test_a_steady_climb_is_none(self):
        """Not even at the ends, where the window is cut short: a few sparse
        fixes up a climb read as spikes all but one."""
        assert not any(altitude_spikes([300.0, 650, 1000, 1350]))
        assert not any(altitude_spikes([float(feet) for feet in range(0, 9000, 300)]))

    def test_a_glitch_at_an_end_against_neighbours_that_agree(self):
        """A logger that wrote 0 ft as its last fix, on the ground at 350 ft."""
        assert altitude_spikes([350.0, 352, 349, 351, 0]) == [False] * 4 + [True]
        assert altitude_spikes([0.0, 350, 352, 349]) == [True] + [False] * 3

    def test_too_few_fixes_say_nothing(self):
        assert altitude_spikes([0.0, 3000]) == [False, False]
        assert altitude_spikes([]) == []


def _timed(*stretches, seconds=5.0):
    """Altitudes and times: ``seconds`` from one fix to the next, but the
    first fix of each of the ``stretches`` after the first under the time
    of the fix before it, as loggers write their jumps."""
    altitudes, times, t = [], [], 1000.0
    for number, stretch in enumerate(stretches):
        for index, altitude in enumerate(stretch):
            t += 0.0 if number and not index else seconds
            altitudes.append(altitude)
            times.append(t)
    return altitudes, times


def _glitch(before, glitch, after, seconds=5.0):
    """Altitudes and times: level at ``before``, a jump within the same
    second to the ``glitch`` altitudes, one a fix, and back to ``after``."""
    return _timed(before, glitch, after, seconds=seconds)


class TestAltitudeGlitchRuns:
    """A logger that lost its height for a minute or two (data/ flights 42,
    84, 85, 88 and 91)."""

    def test_a_run_too_long_for_the_median_is_one_by_the_times(self):
        """Flight 85: 1,400 ft below the sea for 20 fixes."""
        altitudes, times = _glitch(
            [2025.0] * 10, [-713.0 - 35 * i for i in range(20)], [2030.0] * 10
        )

        spikes = altitude_spikes(altitudes, times)

        assert spikes == [False] * 10 + [True] * 20 + [False] * 10
        # Too many fixes for the median alone
        assert not any(altitude_spikes(altitudes)[12:28])

    def test_it_follows_a_climb_or_descent(self):
        """A glitch at the end of an approach: the jump back lands lower,
        and it is on the line between the two that counts."""
        before = [2000.0 - 40 * i for i in range(10)]
        glitch = [400.0 - 40 * i for i in range(25)]
        after = [340.0 - 10 * i for i in range(5)]
        altitudes, times = _glitch(before, glitch, after)

        assert altitude_spikes(altitudes, times) == (
            [False] * 10 + [True] * 25 + [False] * 5
        )

    def test_a_glitch_within_a_glitch(self):
        """A smaller glitch back towards the flight inside a longer one is
        part of it (flight 85)."""
        altitudes, times = _glitch(
            [2000.0] * 10, [-700.0] * 8 + [300.0] * 4 + [-700.0] * 8, [2000.0] * 10
        )

        assert altitude_spikes(altitudes, times) == (
            [False] * 10 + [True] * 20 + [False] * 10
        )

    def test_a_jump_that_does_not_come_back_is_none(self):
        """A logger whose height is off from then on, or far longer than
        ``ALTITUDE_GLITCH_SECONDS``, is read as it is."""
        altitudes, times = _glitch([2000.0] * 10, [1000.0] * 30, [], seconds=5.0)
        assert not any(altitude_spikes(altitudes, times))
        altitudes, times = _glitch(
            [2000.0] * 10, [1000.0] * 80, [2000.0] * 10, seconds=5.0
        )
        assert not any(altitude_spikes(altitudes, times))

    def test_a_climb_and_descent_an_aircraft_flies_is_none(self):
        """Steps of 50 ft a second, up and back down, under the limit: the
        times add nothing to what the median reads."""
        altitudes = [1000.0] * 5 + [1000.0 + 250 * i for i in range(1, 9)]
        altitudes += [3000.0] * 5
        altitudes += [3000.0 - 250 * i for i in range(1, 9)] + [1000.0] * 5
        times = [1000.0 + 5 * i for i in range(len(altitudes))]

        assert altitude_spikes(altitudes, times) == altitude_spikes(altitudes)
        assert not any(altitude_spikes(altitudes, times))

    def test_two_glitches_in_a_row(self):
        """Flight 88: a jump up and, before it comes back, one far down, the
        largest jump of all. The stretch it jumped from to the second is no
        flight it jumped away from: both are the glitch."""
        altitudes, times = _timed(
            [2300.0] * 20, [3700.0] * 10, [400.0] * 12, [2300.0] * 20
        )

        assert altitude_spikes(altitudes, times) == (
            [False] * 20 + [True] * 22 + [False] * 20
        )

    def test_the_flight_between_two_glitches_stays(self):
        """Flight 88: a glitch 950 ft below a climb, the climb levelling off
        after it, then two glitches in a row. The level stretch, a jump
        from the first glitch and one to the next, is the flight: the climb
        before reaches it, not the glitch."""
        climb = [400.0 + 50 * i for i in range(20)]
        below = [1450.0 + 50 * i - 950 for i in range(17)]
        level = [2300.0 + 10 * i for i in range(20)]
        altitudes, times = _timed(
            climb, below, level, [3700.0] * 10, [400.0] * 12, [2500.0] * 20
        )

        assert altitude_spikes(altitudes, times) == (
            [False] * 20 + [True] * 17 + [False] * 20 + [True] * 22 + [False] * 20
        )

    def test_a_glitch_of_short_stretches_wherever_they_lie(self):
        """Flight 85: a logger that jumps from one height to the next a few
        fixes at a time, one of them near the flight's: none lasts as long
        as a stretch the flight is told by."""
        altitudes, times = _timed(
            [2000.0] * 20,
            [1000.0] * 4,
            [1900.0] * 4,
            [300.0] * 4,
            [1500.0] * 4,
            [2000.0] * 20,
        )

        assert altitude_spikes(altitudes, times) == (
            [False] * 20 + [True] * 16 + [False] * 20
        )

    def test_a_drift_into_a_glitch_is_part_of_it(self):
        """Flight 85: the logger sank 50 ft a second for 20 seconds, within
        what one fix to the next allows but no aircraft keeps up, before it
        jumped: the glitch begins where the drift does."""
        drift = [2000.0 - 250 * i for i in range(1, 5)]
        altitudes, times = _timed([2000.0] * 20 + drift, [-700.0] * 10, [2000.0] * 20)

        assert altitude_spikes(altitudes, times) == (
            [False] * 20 + [True] * 14 + [False] * 20
        )

    def test_a_drift_back_after_a_jump_is_part_of_it(self):
        """Flight 42: a jump up, and back down at 50 ft a second, before the
        logger jumps back to the flight."""
        drift = [3500.0 - 250 * i for i in range(5)]
        altitudes, times = _timed([2000.0] * 20, drift, [2000.0] * 20)

        assert altitude_spikes(altitudes, times) == (
            [False] * 20 + [True] * 5 + [False] * 20
        )

    @pytest.mark.parametrize(
        "times",
        [
            pytest.param(lambda size: [0.0] * size, id="one time"),
            pytest.param(
                lambda size: [float(i % 100) for i in range(size)], id="reset"
            ),
            pytest.param(
                lambda size: [float(i // 50) for i in range(size)], id="stuck"
            ),
            pytest.param(lambda size: [float(i) for i in range(size)], id="a second"),
        ],
    )
    def test_the_glitches_take_linear_time(self, times):
        """A logger that writes noise of hundreds of feet a fix, under times
        that stand still or run back: looking for the stretches of a glitch
        must not take each fix with each other."""

        def make(size):
            noise = random.Random(size)  # noqa: S311 - noise, not secrets
            altitudes = [3000.0 + noise.uniform(-300, 300) for _ in range(size)]
            return altitudes, times(size)

        ratio = growth(lambda track: altitude_spikes(*track), make, 1_000)
        assert ratio < LINEAR_GROWTH

    def test_a_run_back_across_the_line_is_none(self):
        """A jump up and one down again, with the fixes between them back
        below the line from the one before to the one after: what the two
        jumps hold is the flight, not a glitch off it."""
        glitch = [2000.0] * 3 + [1750.0, 1500, 1250, 1000] + [1000.0] * 3
        glitch += [1000.0 + 250 * i for i in range(1, 6)]
        altitudes, times = _glitch([1000.0] * 10, glitch, [1500.0] * 10)

        assert altitude_spikes(altitudes, times) == altitude_spikes(altitudes)

    def test_a_track_under_one_time_is_read_by_the_median(self):
        """A few fixes of a flight from 1,500 ft up to 3,500 ft and back, all
        under one time: steps a logger jumps, but times that tell nothing
        of how fast. The flight between the two ends at its field stays."""
        altitudes = [1500.0 + 500 * i for i in range(5)]
        altitudes += [3500.0] * 5 + altitudes[::-1]

        spikes = altitude_spikes(altitudes, [1000.0] * len(altitudes))

        assert spikes == altitude_spikes(altitudes)
        assert not any(spikes)


class TestWithoutAltitudeSpikes:
    def test_a_glitch_gets_the_line_between_its_neighbours(self):
        path = _feet_path(1000, 1100, 1200, 0, 0, 1500, 1600, 1700, 1800)
        smoothed = without_altitude_spikes(path)
        assert _feet(smoothed) == [
            1000,
            1100,
            1200,
            1300,
            1400,
            1500,
            1600,
            1700,
            1800,
        ]
        # The positions and times stay
        assert [(p.lat, p.lon, p.ts) for p in smoothed] == [
            (p.lat, p.lon, p.ts) for p in path
        ]

    def test_a_glitch_at_an_end_gets_its_neighbour(self):
        smoothed = without_altitude_spikes(_feet_path(350, 352, 349, 351, 0))
        assert _feet(smoothed)[-1] == 351

    def test_a_long_glitch_of_a_timed_path(self):
        altitudes, times = _glitch([2000.0] * 10, [-700.0] * 20, [2000.0] * 10)
        path = [
            TrackPoint(50.0, 8.0 + i * 0.001, alt / METERS_TO_FEET, t)
            for i, (alt, t) in enumerate(zip(altitudes, times, strict=True))
        ]

        assert _feet(without_altitude_spikes(path)) == [2000.0] * 40
        # Without the times, the median alone reads it
        untimed = [point._replace(ts=None) for point in path]
        assert min(_feet(without_altitude_spikes(untimed))) == -700.0

    def test_a_logger_that_repeats_its_last_fix_jumps_nothing(self):
        """A low approach at 2,000 ft a minute, fixes 5 s apart, with the
        logger writing its last fix again for 15 s on the way down and up,
        as the landings leave out (see ``landings._timed_fixes``): the step
        after each holds the 15 s it repeated, no jump, and the 500 ft at
        the bottom stay."""
        altitudes = [2500.0] * 12 + [2500.0 - 165 * i for i in range(1, 13)]
        altitudes += [520.0] * 4 + [520.0 + 165 * i for i in range(1, 13)]
        altitudes += [2500.0] * 12
        path = [
            TrackPoint(50.0, 8.0 + i * 0.003, alt / METERS_TO_FEET, 1000.0 + 5 * i)
            for i, alt in enumerate(altitudes)
        ]
        for first in (16, 32):
            for index in range(first + 1, first + 4):
                path[index] = path[first]._replace(ts=path[index].ts)

        assert without_altitude_spikes(path) is path

    def test_a_path_without_glitches_is_the_same(self):
        path = _make_path()
        assert without_altitude_spikes(path) is path

    def test_the_statistics_leave_the_glitch_out(self):
        """A single fix at 0 ft added a climb from the ground and back."""
        path = _feet_path(2000, 2010, 2020, 0, 2040, 2050, 2060)
        info = build_path_info(without_altitude_spikes(path), _metadata({}), 0, 2025)
        assert info["min_altitude_ft"] == 2000.0
        assert info["altitude_gain_ft"] == 60.0


class TestSegmentGroundspeed:
    def test_windowed_speed_used_when_available(self):
        seg = SegmentSpeed(1000.0, 0.0, 100.0, 1.0, 30.0, valid=True)
        speed = _segment_groundspeed(seg, SpeedWindow([seg]), 10.0, 0.0)
        assert speed == pytest.approx(1.0 / 1.852 / 30.0 * 3600, rel=1e-6)

    def test_fallback_when_no_timestamp(self):
        seg = SegmentSpeed(None, None, None, 1.0, 0.0)
        speed = _segment_groundspeed(seg, SpeedWindow([]), 10.0, 600.0)
        assert speed == pytest.approx(1.0 / 1.852 / 60.0 * 3600, rel=1e-6)

    def test_unknown_when_nothing_known(self):
        seg = SegmentSpeed(None, None, None, 1.0, 0.0)
        assert _segment_groundspeed(seg, SpeedWindow([]), 10.0, 0.0) is None

    def test_measured_standstill_is_not_replaced_by_the_average(self):
        seg = SegmentSpeed(1000.0, 0.0, 0.0, 0.0, 60.0, valid=True)
        assert _segment_groundspeed(seg, SpeedWindow([seg]), 10.0, 600.0) == 0.0

    def test_a_segment_longer_than_the_window_is_its_own_speed(self):
        """A logger that writes a fix every few minutes: nothing else is in
        the window around a segment."""
        seg = SegmentSpeed(1000.0, 0.0, 90.0, 5.0, 300.0, valid=True)
        window = SpeedWindow([seg])
        assert len(window) == 0
        assert _segment_groundspeed(seg, window, 100.0, 600.0) == 90.0

    def test_a_gap_takes_the_speed_before_it(self):
        """The straight line over a lost fix says little about the speed."""
        before = SegmentSpeed(940.0, 0.0, 100.0, 3.087, 60.0, valid=True)
        gap = SegmentSpeed(1000.0, 60.0, 30.0, 1.852, 120.5, valid=True)
        speed = _segment_groundspeed(gap, SpeedWindow([before, gap]), 5.0, 180.5)
        assert speed == pytest.approx(100.0, rel=1e-3)

    def test_a_long_gap_leaves_the_speed_before_it_alone(self):
        """A fix every second at 100 kt, then 30 minutes on the spot."""
        start = 1748736000.0
        degrees_per_second = 100 * 1.852 / SECONDS_PER_HOUR / 111.195
        path = [
            TrackPoint(50.0 + degrees_per_second * i, 8.0, 500.0, start + i)
            for i in range(121)
        ]
        path.append(path[-1]._replace(ts=start + 120 + 1800))
        path.append(
            path[-1]._replace(lat=path[-1].lat + degrees_per_second, ts=start + 1921)
        )

        _, rows = process_path_segments(path, 1921.0)

        # The minute before the gap flew at 100 kt; the gap stood still
        # and is not drawn, the second after it flew at 100 kt again
        assert [row[3] for row in rows[60:120]] == [100.0] * 60
        assert rows[-1][3] == 100.0


class TestProcessPathSegments:
    def test_generates_rows_with_time(self):
        start, rows = process_path_segments(_make_path(timed=True), 540.0)
        assert start == [50.0, 8.5]
        assert len(rows) == 9
        assert all(len(row) == 5 for row in rows)
        assert rows[0][4] == 0.0
        assert rows[1][4] == 60.0

    def test_rows_without_time(self):
        _, rows = process_path_segments(_make_path(count=3), 600.0)
        assert all(len(row) == 4 for row in rows)

    def test_rows_are_contiguous(self):
        """Each row starts where the previous one ended, so only ends are stored."""
        start, rows = process_path_segments(_make_path(count=5), 600.0)
        path = _make_path(count=5)
        assert start == [round(path[0].lat, 5), round(path[0].lon, 5)]
        for row, point in zip(rows, path[1:], strict=True):
            assert row[:2] == [round(point.lat, 5), round(point.lon, 5)]

    def test_coordinates_rounded_to_five_decimals(self):
        path = [
            TrackPoint(50.123456789, 8.987654321, 1000.0, None),
            TrackPoint(50.223456789, 8.887654321, 1000.0, None),
        ]
        start, rows = process_path_segments(path, 60.0)
        assert start == [50.12346, 8.98765]
        assert rows[0][:2] == [50.22346, 8.88765]

    def test_identical_coordinates_filtered(self):
        path = [
            TrackPoint(50.0, 8.5, 1000.0, None),
            TrackPoint(50.0, 8.5, 1100.0, None),
            TrackPoint(50.1, 8.6, 1200.0, None),
        ]
        start, rows = process_path_segments(path, 120.0)
        assert len(rows) == 1
        # The dropped segment had zero length, so the chain stays contiguous
        assert start == [50.0, 8.5]
        assert rows[0][:2] == [50.1, 8.6]

    def test_standstill_below_the_exported_precision_filtered(self):
        """GPS jitter while standing still must not export zero-length rows."""
        path = [
            TrackPoint(50.0, 8.5, 1000.0, 0.0),
            TrackPoint(50.000001, 8.499999, 1000.0, 1.0),
            TrackPoint(50.000002, 8.5, 1000.0, 2.0),
            TrackPoint(50.1, 8.6, 1200.0, 60.0),
            TrackPoint(50.100003, 8.600001, 1200.0, 61.0),
        ]
        start, rows = process_path_segments(path, 61.0)
        assert start == [50.0, 8.5]
        assert [row[:2] for row in rows] == [[50.1, 8.6]]
        # The kept row is the segment that starts at the last standstill point
        assert rows[0][4] == 2.0

    def test_altitude_rounded_to_20ft(self):
        path = [
            TrackPoint(50.0, 8.5, 1523.5, None),
            TrackPoint(50.1, 8.6, 1523.5, None),
        ]
        _, rows = process_path_segments(path, 60.0)
        # 4998.4 ft
        assert rows[0][2] == 5000
        path = [
            TrackPoint(50.0, 8.5, 1000.0, None),
            TrackPoint(50.1, 8.6, 1000.0, None),
        ]
        _, rows = process_path_segments(path, 60.0)
        # 3280.8 ft, which the 100 ft of format 4 rounded to 3300
        assert rows[0][2] == 3280
        assert rows[0][2] % ALTITUDE_STEP == 0

    def test_missing_altitude_on_one_end_uses_the_other(self):
        path = [TrackPoint(50.0, 8.5, None, None), TrackPoint(50.1, 8.6, 304.8, None)]
        _, rows = process_path_segments(path, 60.0)
        assert rows[0][2] == 1000

    def test_missing_altitude_on_both_ends_keeps_the_segment(self):
        """Skipping it would break the end-to-start chain of the row format."""
        path = [
            TrackPoint(50.0, 8.5, None, None),
            TrackPoint(50.1, 8.6, None, None),
            TrackPoint(50.2, 8.7, 100.0, None),
        ]
        start, rows = process_path_segments(path, 60.0)
        assert start == [50.0, 8.5]
        assert [row[:2] for row in rows] == [[50.1, 8.6], [50.2, 8.7]]
        assert rows[0][2] == 0.0  # no altitude known yet
        assert rows[1][2] == 320  # 100 m rounded to the nearest 20 ft

    def test_groundspeed_rounded(self):
        _, rows = process_path_segments(_make_path(timed=True), 540.0)
        for row in rows:
            assert row[3] == round(row[3])
            assert row[3] > 0

    @pytest.mark.parametrize(
        ("knots", "exported"),
        [
            (None, 0.0),
            (0.0, 0.0),
            # A known speed below half a knot is no unknown one
            (0.01, 1.0),
            (0.4, 1.0),
            (1.4, 1.0),
            (1.6, 2.0),
            (39.4, 39.0),
            (120.5, 120.0),
            (167.4, 167.0),
        ],
    )
    def test_whole_knots(self, knots, exported):
        assert exported_knots(knots) == exported

    def test_a_crawl_keeps_a_speed(self):
        """Taxiing at walking pace still counts as taxiing, not as unknown."""
        step_km = 0.3 * 1.852 / 3600 * 60  # a minute at 0.3 kt
        path = [
            TrackPoint(50.0 + i * step_km / 111.195, 8.5, 100.0, 60.0 * i)
            for i in range(5)
        ]
        _, rows = process_path_segments(path, 240.0)
        assert rows
        assert all(row[3] == 1.0 for row in rows)

    def test_relative_time_rounded(self):
        path = [
            TrackPoint(50.0, 8.5, 100.0, 1000.0),
            TrackPoint(50.1, 8.6, 100.0, 1000.0 + 61.26),
            TrackPoint(50.2, 8.7, 100.0, 1000.0 + 120.0),
        ]
        _, rows = process_path_segments(path, 120.0)
        assert rows[1][4] == 61.3

    def test_fast_aircraft_keeps_its_speed(self):
        """Over 200 kt used to export as 0, which hid the flight's speed."""
        step_km = 280 * 1.852 / 60  # a minute at 280 kt
        path = [
            TrackPoint(50.0 + i * step_km / 111.195, 8.5, 3000.0, 60.0 * i)
            for i in range(10)
        ]
        _, rows = process_path_segments(path, 540.0)
        assert all(row[3] == pytest.approx(280.0, abs=0.5) for row in rows)

    def test_unknown_speed_is_exported_as_zero(self):
        """The frontend reads 0 as "no speed" (see process_path_segments)."""
        path = [TrackPoint(50.0, 8.5, 100.0, None), TrackPoint(50.1, 8.6, 100.0, None)]
        _, rows = process_path_segments(path, 0.0)
        assert rows[0][3] == 0.0

    def test_empty_path_has_no_start(self):
        _, rows = process_path_segments([], 0.0)
        assert rows == []
        start, _ = process_path_segments([], 0.0)
        assert start == []


class TestProcessPathSegmentsProperties:
    @settings(max_examples=150)
    @given(
        st.lists(
            st.tuples(
                st.floats(min_value=-89.0, max_value=89.0),
                st.floats(min_value=-179.0, max_value=179.0),
                st.floats(min_value=0.0, max_value=5000.0),
            ),
            min_size=2,
            max_size=25,
        ),
        st.booleans(),
    )
    def test_rows_form_a_contiguous_chain(self, points, timed):
        """Every row continues where the previous one ended.

        The exported format stores only end points, so the chain must stay
        intact whatever the geometry, including repeated (zero-length) points.
        """
        path = [
            TrackPoint(lat, lon, alt, float(i) if timed else None)
            for i, (lat, lon, alt) in enumerate(points)
        ]
        start, rows = process_path_segments(path, 60.0)

        assert len(start) == (2 if rows else 0)
        for row in rows:
            assert row[2] % ALTITUDE_STEP == 0
            assert row[3] >= 0
        exported = [[round(p.lat, 5), round(p.lon, 5)] for p in path]
        assert [row[:2] for row in rows] == [
            end for begin, end in pairwise(exported) if begin != end
        ]
