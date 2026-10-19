"""Tests for duplicates module."""

import logging
import random
from itertools import pairwise
from math import cos, floor, hypot, radians
from typing import Any, ClassVar, cast

import pytest
from hypothesis import given
from hypothesis import strategies as st

import flown.duplicates as duplicates_module
from flown.cache import decode_entry, encode_entry
from flown.duplicates import (
    _CELL_DEGREES,
    _MIN_AGREEING,
    _SHIFT_TOLERANCE_S,
    _clock_known,
    _clock_shifts,
    _clocks_may_line_up,
    _names,
    _one_flight,
    _Timed,
    drop_overlapping_paths,
    same_flight,
)
from flown.types import PathMetadata, TrackPoint
from tests.conftest import WITHOUT_EFFECT_MODULES, package_imports

# East at 50 m/s (97 kt) at 50 degrees north
SPEED = 0.0007
# 2025-06-01T00:00:00Z: a recording that starts after it runs on the real
# clock. One that starts near 0 (January 1st, 1970) is taken for an
# obfuscated one, whose clock may be anything.
JUNE_2025 = 1748736000.0
JANUARY_2025 = 1735689600.0


def _recording(start_s, seconds, step_s=10.0, lat=50.0, lon=8.0, lon_per_s=SPEED):
    """A flight east from (lat, lon), a fix every ``step_s`` seconds."""
    count = int(seconds / step_s) + 1
    return [
        TrackPoint(lat, lon + lon_per_s * i * step_s, 500.0, start_s + i * step_s)
        for i in range(count)
    ]


def _circuit(start_s, laps, wide_m=0.0, seed=1):
    """Circuits at a field at 50 degrees north, 4 by 1.5 km at 40 m/s, a
    fix every 5 s some 8 m off, standing a minute before and after."""
    noise = random.Random(seed)  # noqa: S311 - noise, not secrets
    points = []
    t = start_s

    def fix(x, y):
        nonlocal t
        lat = 50.0 + (y + noise.gauss(0, 8)) / 111320
        lon = 8.0 + (x + noise.gauss(0, 8)) / (111320 * cos(radians(50.0)))
        points.append(TrackPoint(lat, lon, 300.0, t))
        t += 5.0

    for _ in range(12):
        fix(0.0, 0.0)
    corners = [(0, 0), (4000, 0), (4000, 1500 + wide_m), (-1500, 1500 + wide_m)]
    corners += [(-1500, 0), (0, 0)]
    for _ in range(laps):
        for (x1, y1), (x2, y2) in pairwise(corners):
            steps = int(hypot(x2 - x1, y2 - y1) / 200)
            for i in range(steps):
                fix(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps)
    for _ in range(12):
        fix(0.0, 0.0)
    return points


def _with_ground(path, seconds=120.0):
    """``path`` after standing where it starts for ``seconds``."""
    first = path[0]
    return [
        first._replace(ts=first.ts - seconds + t) for t in range(0, int(seconds), 10)
    ] + path


def _drop(paths, names=None):
    metadata: Any = [
        {"filename": (names or [f"{i}.kml" for i in range(len(paths))])[i]}
        for i in range(len(paths))
    ]
    exported = dict.fromkeys(range(len(paths)), b"")
    return drop_overlapping_paths(
        {2025: list(range(len(paths)))}, paths, metadata, exported
    )


class TestDropOverlappingPaths:
    def test_two_recordings_of_one_flight_count_once(self, caplog):
        """A phone and a panel GPS: other fixes, the same flight, on the
        real clock (files that are not obfuscated)."""
        start = JUNE_2025 + 1000.0
        coarse = _recording(start, 3600.0, step_s=10.0)
        # Started a minute later, a fix every 3 s, a few metres off
        fine = _recording(start + 60.0, 3500.0, step_s=3.0, lat=50.0001)
        fine = [p._replace(lon=8.0 + SPEED * (p.ts - start)) for p in fine]

        with caplog.at_level(logging.WARNING, logger="flown"):
            kept = _drop([coarse, fine], ["phone.kml", "panel.kml"])

        # The finer recording stays, whichever came first
        assert kept == {2025: [1]}
        assert "phone.kml" in caplog.text
        assert "panel.kml" in caplog.text
        assert _drop([fine, coarse]) == {2025: [0]}

    def test_recordings_with_clocks_of_their_own_count_once(self, caplog):
        """Obfuscated files each start at midnight, so the phone started a
        minute before the panel GPS no longer lines up with it in time."""
        coarse = _recording(1000.0, 3600.0, step_s=10.0)
        # The same flight from a minute in, its clock starting at 0
        fine = [
            p._replace(lon=8.0 + SPEED * (p.ts - 1000.0), ts=p.ts - 1060.0)
            for p in _recording(1060.0, 3500.0, step_s=3.0, lat=50.0001)
        ]

        with caplog.at_level(logging.WARNING, logger="flown"):
            kept = _drop([coarse, fine], ["phone.kml", "panel.kml"])

        assert kept == {2025: [1]}
        assert "recorded twice" in caplog.text
        assert _drop([fine, coarse]) == {2025: [0]}

    def test_a_real_and_an_obfuscated_recording_of_one_flight_count_once(self):
        start = JUNE_2025 + 1000.0
        real = _recording(start, 3600.0, step_s=10.0)
        # Obfuscated on its own: started a minute later, at midnight now
        obfuscated = [
            p._replace(lon=8.0 + SPEED * (p.ts - start), ts=p.ts - start - 60.0)
            for p in _recording(start + 60.0, 3500.0, step_s=3.0, lat=50.0001)
        ]
        obfuscated = [p._replace(ts=p.ts + JANUARY_2025) for p in obfuscated]
        assert _drop([real, obfuscated]) == {2025: [1]}

    def test_real_clocks_tell_the_same_way_on_another_day_apart(self):
        """Two flights alike in the air: the real clock tells them apart,
        an obfuscated one cannot."""
        today = _recording(JUNE_2025 + 1000.0, 3600.0)
        tomorrow = _recording(JUNE_2025 + 1000.0 + 86400.0, 3600.0, lat=50.0001)
        assert _drop([today, tomorrow]) == {2025: [0, 1]}
        obfuscated = [
            [p._replace(ts=p.ts - path[0].ts) for p in path]
            for path in (today, tomorrow)
        ]
        assert _drop(obfuscated) == {2025: [0]}

    @pytest.mark.parametrize("offset", [5.0, 10.0, 18.0, -30.0, 3600.0, -7200.0])
    def test_real_clocks_that_are_off_count_once(self, offset):
        """A phone on its own clock, a logger on GPS time (18 s ahead of
        UTC), or one that writes the local time as UTC."""
        start = JUNE_2025 + 1000.0
        coarse = _with_ground(_recording(start, 3600.0, step_s=10.0))
        fine = _with_ground(
            [
                p._replace(lon=8.0 + SPEED * (p.ts - start), ts=p.ts + offset)
                for p in _recording(start + 60.0, 3500.0, step_s=3.0, lat=50.0001)
            ]
        )
        assert _drop([coarse, fine]) == {2025: [1]}
        assert _drop([fine, coarse]) == {2025: [0]}

    def test_real_clocks_are_off_by_whole_half_hours_only(self):
        """Two flights alike in the air, 1000 s apart: no two clocks are off
        by that, so they are two flights."""
        start = JUNE_2025 + 1000.0
        first = _with_ground(_recording(start, 3600.0))
        later = _with_ground(_recording(start + 1000.0, 3600.0, lat=50.0001))
        assert _drop([first, later]) == {2025: [0, 1]}

    def test_real_clocks_further_apart_than_any_two_are_off_are_two(self):
        start = JUNE_2025 + 1000.0
        first = _Timed.of(_with_ground(_recording(start, 3600.0)))
        later = _Timed.of(_with_ground(_recording(start + 86400.0, 3600.0)))
        assert first is not None
        assert later is not None
        assert not _one_flight(first, later)
        assert not _one_flight(later, first)

    def test_two_flights_of_one_day_on_real_clocks_are_two(self):
        """The same way twice in a day, a little off the first time."""
        start = JUNE_2025 + 1000.0
        morning = _with_ground(_recording(start, 3600.0))
        afternoon = _with_ground(_recording(start + 3 * 3600.0, 3600.0, lat=50.003))
        back = _with_ground(
            [
                p._replace(lon=8.0 + SPEED * 3600.0 - SPEED * (p.ts - start - 7200.0))
                for p in _recording(start + 7200.0, 3600.0)
            ]
        )
        assert _drop([morning, afternoon, back]) == {2025: [0, 1, 2]}

    def test_circuit_flights_an_hour_apart_with_other_laps_are_two(self):
        """Lined up at the hour, a lap is where a lap was: they did not take
        off and land together, though."""
        one = _circuit(JUNE_2025 + 36000.0, laps=1)
        two = _circuit(JUNE_2025 + 36000.0 + 3620.0, laps=2, wide_m=60.0, seed=2)
        assert _drop([one, two]) == {2025: [0, 1]}

    def test_the_circuits_of_a_session_are_as_many_flights(self):
        """A logger that ends a flight at each landing: the circuits are
        alike and close to a half hour apart, two or four of them on."""
        laps = []
        start = JUNE_2025 + 36000.0
        for k, wide in enumerate([0.0, 40.0, 70.0, 20.0, 50.0, 10.0]):
            lap = _circuit(start, laps=1, wide_m=wide, seed=10 + k)[12:-12]
            laps.append(lap)
            start = lap[-1].ts + 65.0
        everything = {2025: list(range(6))}
        # One file, one clock
        assert _drop(laps, ["session.kml"] * 6) == everything
        # A file each
        assert _drop(laps) == everything

    def test_files_of_one_name_in_two_folders_are_two_clocks(self):
        """Two loggers, their files named alike in folders of their own, one
        writing the local time as UTC: one flight, an hour apart."""
        start = JUNE_2025 + 1000.0
        coarse = _with_ground(_recording(start, 3600.0, step_s=10.0))
        fine = _with_ground(
            [
                p._replace(lon=8.0 + SPEED * (p.ts - start), ts=p.ts + 3600.0)
                for p in _recording(start + 60.0, 3500.0, step_s=3.0, lat=50.0001)
            ]
        )
        exported = {0: b"", 1: b"", 2: b""}
        metadata: Any = [
            {"filename": "1_DEHYL_DA40.kml", "source": "phone/1_DEHYL_DA40.kml"},
            {"filename": "1_DEHYL_DA40.kml", "source": "logger/1_DEHYL_DA40.kml"},
        ]
        assert drop_overlapping_paths(
            {2025: [0, 1]}, [coarse, fine], metadata, exported
        ) == {2025: [1]}
        # Of one file, one clock: not lined up by the hour
        for entry in metadata:
            entry["source"] = "1_DEHYL_DA40.kml"
        assert drop_overlapping_paths(
            {2025: [0, 1]}, [coarse, fine], metadata, exported
        ) == {2025: [0, 1]}

    def test_two_aircraft_on_one_circuit_an_hour_apart_are_two(self):
        """Lined up at the hour, two aircraft flying the same circuits look
        like one flight on two clocks; the registrations tell them apart."""
        first = _circuit(JUNE_2025 + 36000.0, laps=3, seed=1)
        second = _circuit(JUNE_2025 + 36000.0 + 3600.0, laps=3, seed=2)
        metadata: Any = [
            {"filename": "1_DEABC_C172.kml", "aircraft_registration": "D-EABC"},
            {"filename": "2_DEXYZ_C172.kml", "aircraft_registration": "D-EXYZ"},
        ]
        exported = {0: b"", 1: b""}
        paths = [first, second]
        assert drop_overlapping_paths({2025: [0, 1]}, paths, metadata, exported) == {
            2025: [0, 1]
        }
        # Obfuscated, lined up by where they flew: two aircraft still
        obfuscated = [
            [p._replace(ts=p.ts - path[0].ts) for p in path] for path in paths
        ]
        assert drop_overlapping_paths(
            {2025: [0, 1]}, obfuscated, metadata, exported
        ) == {2025: [0, 1]}

    def test_two_aircraft_in_formation_are_two(self):
        """Two aircraft flying in formation on real clocks, a few tens of
        metres apart, are as close as one flight on two loggers; the
        registrations keep them two."""
        lead = _recording(JUNE_2025, 1800.0, step_s=5.0)
        wing = _recording(JUNE_2025, 1800.0, step_s=5.0, lat=50.0003)
        metadata: Any = [
            {"filename": "1_DEABC_C172.kml", "aircraft_registration": "D-EABC"},
            {"filename": "2_DEXYZ_C172.kml", "aircraft_registration": "D-EXYZ"},
        ]
        exported = {0: b"", 1: b""}
        assert drop_overlapping_paths(
            {2025: [0, 1]}, [lead, wing], metadata, exported
        ) == {2025: [0, 1]}
        # One registration, or none named: one flight on two loggers
        metadata[1]["aircraft_registration"] = "D-EABC"
        assert drop_overlapping_paths(
            {2025: [0, 1]}, [lead, wing], metadata, exported
        ) == {2025: [0]}

    def test_flights_that_share_the_ground_only_are_two(self):
        """Obfuscated flights from one field, standing at the same place for
        most of their time: lined up by where they stood, they would agree."""
        ground = [TrackPoint(50.0, 8.0, 100.0, float(t)) for t in range(0, 1800, 10)]
        east = ground + _recording(1800.0, 600.0)
        north = ground + [
            p._replace(lat=50.0 + SPEED * (p.ts - 1800.0), lon=8.0)
            for p in _recording(1800.0, 600.0)
        ]
        assert _drop([east, north]) == {2025: [0, 1]}

    def test_the_same_way_at_another_pace_is_another_flight_at_any_time(self):
        first = _recording(1000.0, 3600.0)
        second = _recording(50000.0, 3600.0, lon_per_s=1.5 * SPEED)
        assert _drop([first, second]) == {2025: [0, 1]}

    def test_the_same_way_back_is_another_flight(self):
        out = _recording(1000.0, 3600.0)
        back = [
            p._replace(lon=8.0 + SPEED * 3600.0 - SPEED * (p.ts - 1000.0))
            for p in _recording(1000.0, 3600.0)
        ]
        assert _drop([out, back]) == {2025: [0, 1]}

    def test_as_many_points_keep_the_first(self):
        path = _recording(1000.0, 3600.0)
        assert _drop([path, list(path)]) == {2025: [0]}

    def test_the_same_time_elsewhere_is_another_flight(self):
        """Obfuscated flights of different days share January 1st."""
        home = _recording(1000.0, 3600.0)
        away = _recording(1000.0, 3600.0, lat=50.1)
        assert _drop([home, away]) == {2025: [0, 1]}

    def test_the_same_way_at_another_pace_is_another_flight(self):
        first = _recording(1000.0, 3600.0)
        second = _recording(1000.0, 3600.0, lon_per_s=1.5 * SPEED)
        assert _drop([first, second]) == {2025: [0, 1]}

    def test_little_overlap_in_time_is_another_flight(self):
        first = _recording(1000.0, 3600.0)
        # Starts where the first is after 40 minutes, in the same place
        later = [
            p._replace(lon=8.0 + SPEED * (p.ts - 1000.0))
            for p in _recording(1000.0 + 2400.0, 3600.0)
        ]
        assert _drop([first, later]) == {2025: [0, 1]}

    def test_recordings_that_never_moved_fast_are_two(self):
        """Two taxi-only recordings at one field on clocks of their own: a
        flight is told apart by the time it moved, and neither did."""
        taxi = [TrackPoint(50.0, 8.0 + 0.0001 * t, 100.0, float(t)) for t in range(600)]
        again = [p._replace(lat=50.00001) for p in taxi]
        assert _drop([taxi, again]) == {2025: [0, 1]}

    def test_recordings_without_times_are_not_compared(self):
        untimed = [p._replace(ts=None) for p in _recording(1000.0, 3600.0)]
        assert _drop([untimed, list(untimed)]) == {2025: [0, 1]}

    def test_a_year_left_empty_goes(self):
        path = _recording(1000.0, 3600.0)
        metadata = cast("Any", [{"filename": "a.kml"}, {"filename": "b.kml"}])
        kept = drop_overlapping_paths(
            {2024: [0], 2025: [1]}, [path, list(path)], metadata, {0: b"", 1: b""}
        )
        # Different years are compared around New Year only
        assert kept == {2024: [0], 2025: [1]}
        kept = drop_overlapping_paths(
            {2025: [0, 1]}, [path, list(path)], metadata, {0: b"", 1: b""}
        )
        assert kept == {2025: [0]}

    def test_a_flight_at_midnight_on_new_year_counts_once(self):
        """Two loggers 40 s apart put it into two years: one stays, in its year."""
        new_year = 1767225600.0  # 2026-01-01T00:00:00Z
        late = _with_ground(_recording(new_year - 40.0, 3600.0, step_s=10.0))
        fine = _with_ground(
            [
                p._replace(lon=8.0 + SPEED * (p.ts - new_year))
                for p in _recording(new_year, 3500.0, step_s=3.0, lat=50.0001)
            ]
        )
        metadata = cast("Any", [{"filename": "a.kml"}, {"filename": "b.kml"}])
        exported = {0: b"", 1: b""}

        kept = drop_overlapping_paths(
            {2025: [0], 2026: [1]}, [late, fine], metadata, exported
        )

        assert kept == {2026: [1]}
        # A flight of the evening before is another one
        evening = _with_ground(_recording(new_year - 20 * 3600.0, 3600.0))
        assert drop_overlapping_paths(
            {2025: [0], 2026: [1]}, [evening, fine], metadata, exported
        ) == {2025: [0], 2026: [1]}

    def test_the_recording_that_names_the_aircraft_stays(self):
        """A 1 Hz phone log and the panel GPS file with the registration."""
        panel = _recording(1000.0, 3600.0, step_s=10.0)
        phone = _recording(1000.0, 3600.0, step_s=1.0)
        paths = [phone, panel]
        metadata: Any = [
            {"filename": "phone.kml"},
            {
                "filename": "1_DEAGJ_DA20.kml",
                "aircraft_registration": "D-EAGJ",
                "aircraft_type": "DA20",
            },
        ]
        exported = dict.fromkeys(range(2), b"")
        kept = drop_overlapping_paths({2025: [0, 1]}, paths, metadata, exported)
        assert kept == {2025: [1]}

        # The registration counts before the type
        metadata[0]["aircraft_type"] = "DA20"
        metadata[1].pop("aircraft_type")
        kept = drop_overlapping_paths({2025: [0, 1]}, paths, metadata, exported)
        assert kept == {2025: [1]}


class TestSameFlight:
    def test_a_fix_or_two_that_jumped_are_forgiven(self):
        path = _recording(1000.0, 3600.0)
        # The fixes at two of the 20 moments compared jumped 11 km north
        jumped = [
            p._replace(lat=p.lat + (0.1 if p.ts in (1090.0, 1270.0) else 0.0))
            for p in path
        ]
        first, second = _Timed.of(path), _Timed.of(jumped)
        assert first is not None
        assert second is not None
        assert same_flight(first, second)

        lost = [p._replace(lat=p.lat + (0.1 if p.ts < 1600.0 else 0.0)) for p in path]
        third = _Timed.of(lost)
        assert third is not None
        assert not same_flight(first, third)

    def test_a_shift_lines_up_the_clocks(self):
        first = _Timed.of(_recording(1000.0, 3600.0))
        second = _Timed.of(_recording(0.0, 3600.0))
        assert first is not None
        assert second is not None
        assert same_flight(first, second, shift=-1000.0)
        assert not same_flight(first, second, shift=-900.0)


class TestClockKnown:
    def test_a_start_in_the_days_after_new_year_may_be_any_clock(self):
        assert _clock_known(JUNE_2025)
        assert not _clock_known(JANUARY_2025 + 3600.0)

    def test_a_start_no_date_holds_is_not_the_real_clock(self):
        # Past the year 9999, and not a number at all
        assert not _clock_known(1e20)
        assert not _clock_known(float("nan"))


def _shifts_looking_everywhere(first, second):
    """``_clock_shifts`` without the cells ``reach`` rules out first."""
    shifts = sorted(
        near - moment
        for moment, lat, lon in first.samples()
        if (near := second.time_near(lat, lon)) is not None
    )
    groups: list[list[float]] = []
    for shift in shifts:
        if groups and shift - groups[-1][-1] <= _SHIFT_TOLERANCE_S:
            groups[-1].append(shift)
        else:
            groups.append([shift])
    return [
        group[len(group) // 2]
        for group in sorted(groups, key=len, reverse=True)
        if len(group) >= _MIN_AGREEING
    ]


# Steps of up to 400 m in 2 s or more: no faster than an aircraft flies, so
# that every line between two fixes is indexed (see _index_lines)
_WALK = st.lists(
    st.tuples(st.floats(-0.003, 0.003), st.floats(-0.003, 0.003), st.floats(2.0, 60.0)),
    min_size=2,
    max_size=40,
)


def _walk(steps, lat=50.0, lon=8.0):
    """A recording from (lat, lon) by the steps of ``_WALK``."""
    points, time = [], 0.0
    for north, east, seconds in steps:
        points.append(TrackPoint(lat, lon, 500.0, time))
        lat, lon, time = lat + north, lon + east, time + seconds
    points.append(TrackPoint(lat, lon, 500.0, time))
    return _Timed.of(points)


class TestFastLines:
    def test_a_line_faster_than_any_aircraft_is_not_indexed(self):
        """A fix 5,000 km off, which the parser left: its lines ran through
        tens of thousands of cells, and a recording with one took 20 s to
        compare with the others."""
        path = _recording(JUNE_2025, 600.0)
        path[30] = path[30]._replace(lat=5.0)
        recording = _Timed.of(path)
        assert recording is not None
        assert len(recording.reach()) < 9 * len(path)
        # Nowhere on the way to it, and still at the fixes around it
        assert recording.time_near(27.5, path[30].lon) is None
        assert recording.time_near(path[29].lat, path[29].lon) == path[29].ts
        assert recording.time_near(path[31].lat, path[31].lon) == path[31].ts

    def test_a_long_line_as_fast_as_an_aircraft_is_indexed(self):
        """A fix a minute at 580 kt: 18 km between two fixes."""
        recording = _Timed.of(
            _recording(JUNE_2025, 600.0, step_s=60.0, lon_per_s=0.0042)
        )
        assert recording is not None
        assert recording.time_near(50.0, 8.0 + 0.0042 * 90.0) is not None


def _count_comparisons(monkeypatch):
    """The calls to duplicates._pair_recordings from now on, as it is called."""
    calls = []
    real = duplicates_module._pair_recordings

    def compare(*args):
        calls.append(args)
        return real(*args)

    monkeypatch.setattr(duplicates_module, "_pair_recordings", compare)
    return calls


class TestKeptOverlaps:
    """A build of the same flights finds the same recordings to drop
    (see duplicates.OVERLAPS_CACHE_DIR)."""

    @staticmethod
    def _twice():
        start = JUNE_2025 + 1000.0
        coarse = _recording(start, 3600.0, step_s=10.0)
        fine = _recording(start + 60.0, 3500.0, step_s=3.0, lat=50.0001)
        return [coarse, [p._replace(lon=8.0 + SPEED * (p.ts - start)) for p in fine]]

    def test_the_second_build_reads_what_the_first_found(self, monkeypatch, caplog):
        paths = self._twice()
        assert _drop(paths, ["phone.kml", "panel.kml"]) == {2025: [1]}

        def compare(*args):
            raise AssertionError("compared again")

        monkeypatch.setattr(duplicates_module, "_pair_recordings", compare)
        with caplog.at_level(logging.WARNING, logger="flown"):
            assert _drop(paths, ["phone.kml", "panel.kml"]) == {2025: [1]}
        # Still named, as the build that found it did
        assert "Skipping a flight in phone.kml: the same flight as in panel.kml" in (
            caplog.text
        )

    @pytest.mark.parametrize(
        "change",
        [
            lambda paths, names: paths[0].__setitem__(5, paths[0][5]._replace(ts=1.0)),
            lambda paths, names: paths[1].__setitem__(
                5, paths[1][5]._replace(lat=51.0)
            ),
            lambda paths, names: names.reverse(),
        ],
    )
    def test_other_paths_are_compared_again(self, monkeypatch, change):
        paths = self._twice()
        names = ["phone.kml", "panel.kml"]
        _drop(paths, names)
        calls = _count_comparisons(monkeypatch)
        change(paths, names)
        _drop(paths, names)
        assert len(calls) == 1

    def test_a_flight_added_to_another_year_compares_that_year_alone(self, monkeypatch):
        """The flights of 2025 move one index on, and keep what was found."""
        paths = self._twice()
        metadata: Any = [{"filename": "phone.kml"}, {"filename": "panel.kml"}]
        exported = dict.fromkeys(range(2), b"")
        assert drop_overlapping_paths({2025: [0, 1]}, paths, metadata, exported) == {
            2025: [1]
        }
        calls = _count_comparisons(monkeypatch)
        added = _recording(JUNE_2025 - 365 * 86400.0, 3600.0)
        more: Any = [{"filename": "2024.kml"}, *metadata]
        kept = drop_overlapping_paths(
            {2024: [0], 2025: [1, 2]},
            [added, *paths],
            more,
            dict.fromkeys(range(3), b""),
        )
        assert kept == {2024: [0], 2025: [2]}
        assert [list(recordings) for recordings, *_ in calls] == [[0]]

    def test_a_new_year_is_kept_as_well(self, monkeypatch):
        new_year = 1767225600.0  # 2026-01-01T00:00:00Z
        late = _with_ground(_recording(new_year - 40.0, 3600.0, step_s=10.0))
        fine = _with_ground(
            [
                p._replace(lon=8.0 + SPEED * (p.ts - new_year))
                for p in _recording(new_year, 3500.0, step_s=3.0, lat=50.0001)
            ]
        )
        metadata: Any = [{"filename": "a.kml"}, {"filename": "b.kml"}]
        exported = dict.fromkeys(range(2), b"")
        by_year = {2025: [0], 2026: [1]}
        assert drop_overlapping_paths(by_year, [late, fine], metadata, exported) == {
            2026: [1]
        }
        calls = _count_comparisons(monkeypatch)
        assert drop_overlapping_paths(by_year, [late, fine], metadata, exported) == {
            2026: [1]
        }
        assert calls == []

    def test_the_new_year_key_covers_the_paths_left_out_before(self):
        """The comparison around New Year leaves out what the years dropped."""
        key = duplicates_module._new_year_key
        assert key(2026, "a", "b", [3, 4, 5], {4}) != key(
            2026, "a", "b", [3, 4, 5], set()
        )
        # By their places, as the entry keeps its pairs
        assert key(2026, "a", "b", [3, 4, 5], {4}) == key(
            2026, "a", "b", [6, 7, 8], {7}
        )

    def test_an_entry_of_other_paths_is_compared_again(self, monkeypatch):
        """Places beyond the paths of the year are no pairs of them."""
        paths = self._twice()
        _drop(paths)
        (entry,) = duplicates_module.OVERLAPS_CACHE_DIR.iterdir()
        entry.write_bytes(encode_entry({"pairs": [[2, 0]]}))
        calls = _count_comparisons(monkeypatch)
        assert _drop(paths) == {2025: [1]}
        assert len(calls) == 1

    def test_the_kept_entry_is_this_users_alone(self):
        _drop(self._twice())
        directory = duplicates_module.OVERLAPS_CACHE_DIR
        (entry,) = directory.iterdir()
        assert directory.stat().st_mode & 0o777 == 0o700
        assert entry.stat().st_mode & 0o777 == 0o600

    def test_an_entry_that_holds_no_pairs_is_compared_again(self, monkeypatch):
        paths = self._twice()
        _drop(paths)
        (entry,) = duplicates_module.OVERLAPS_CACHE_DIR.iterdir()
        entry.write_bytes(encode_entry({"pairs": [["0", 1]]}))
        assert _drop(paths) == {2025: [1]}
        assert decode_entry(entry.read_bytes()) == {"pairs": [[0, 1]]}

    def test_the_fingerprint_covers_every_module_the_comparison_imports(self):
        imported = package_imports("duplicates") - WITHOUT_EFFECT_MODULES
        assert imported == set(duplicates_module._OVERLAPS_MODULES)


class TestReach:
    @given(_WALK, st.floats(-0.02, 0.02), st.floats(-0.02, 0.02))
    def test_holds_every_place_time_near_finds(self, steps, north, east):
        recording = _walk(steps)
        assert recording is not None
        lat, lon = 50.0 + north, 8.0 + east
        cell = (
            floor(lat / _CELL_DEGREES),
            floor(lon * recording.lon_scale / _CELL_DEGREES),
        )
        if recording.time_near(lat, lon) is not None:
            assert cell in recording.reach()

    @given(_WALK, st.floats(-0.005, 0.005), st.floats(-0.005, 0.005))
    def test_rules_out_no_shift(self, steps, north, east):
        """The same way, from a place up to 550 m off: near enough for a
        shift at some moments, and too far at others."""
        first = _walk(steps)
        second = _walk(steps, lat=50.0 + north, lon=8.0 + east)
        assert first is not None
        assert second is not None
        assert _clock_shifts(first, second) == _shifts_looking_everywhere(first, second)


class TestMoving:
    def test_from_the_takeoff_run_to_the_landing(self):
        # Taxiing at 7 m/s to where the takeoff run starts at 300 s
        taxi = [
            TrackPoint(50.0, 8.0 - 0.0001 * (300 - t), 100.0, float(t))
            for t in range(0, 300, 5)
        ]
        flight = _recording(300.0, 600.0)
        end = flight[-1]
        parked = [end._replace(ts=end.ts + t) for t in range(5, 300, 5)]
        recording = _Timed.of(taxi + flight + parked)
        assert recording is not None
        moving = recording.moving()
        assert moving is not None
        # From the last fix before the run, whose next 10 s were fast
        assert moving.times[0] == 295.0
        assert moving.times[-1] == 900.0
        assert moving.clock_known == recording.clock_known

    def test_none_for_a_recording_that_never_left_the_ground(self):
        taxi = [TrackPoint(50.0, 8.0 + 0.0001 * t, 100.0, float(t)) for t in range(600)]
        recording = _Timed.of(taxi)
        assert recording is not None
        assert recording.moving() is None


class TestTimeNear:
    def test_between_fixes_and_where_the_aircraft_stood(self):
        # Standing at the start for 20 s, then east at 0.0002 degrees a second
        path = [TrackPoint(50.0, 8.0, 500.0, 0.0), TrackPoint(50.0, 8.0, 500.0, 10.0)]
        path += _recording(20.0, 600.0, lon_per_s=0.0002)[1:]
        recording = _Timed.of(path)
        assert recording is not None
        assert recording.time_near(50.0, 8.0) == 0.0
        # Halfway between two fixes, a few metres off the line
        near = recording.time_near(50.00003, 8.0 + 0.0002 * 25.0)
        assert near is not None
        assert abs(near - 45.0) < 0.01
        # Further away than DUPLICATE_DISTANCE_KM from every fix
        assert recording.time_near(50.01, 8.0) is None

    def test_between_fixes_far_apart(self):
        """A fix a minute, 2.9 km apart: the line between them counts."""
        recording = _Timed.of(_recording(0.0, 600.0, step_s=60.0))
        assert recording is not None
        near = recording.time_near(50.001, 8.0 + SPEED * 90.0)
        assert near is not None
        assert abs(near - 90.0) < 0.01


def _wrapped(path):
    """The fixes with their longitudes from -180 to 180, as a file has them."""
    return [p._replace(lon=(p.lon + 180) % 360 - 180) for p in path]


class TestAntimeridian:
    # East from 179.5 at 16 degrees south, across the line after a while
    START: ClassVar[dict[str, float]] = {"lat": -16.0, "lon": 179.5}

    def test_a_crossing_has_the_cells_of_its_way(self):
        path = _wrapped(_recording(1000.0, 3600.0, **self.START))
        assert path[0].lon > 0 > path[-1].lon
        recording = _Timed.of(path)
        assert recording is not None
        # Indexed as one short way, not as a line around the whole world
        assert len(recording._index()) < 1000
        assert recording.lons[-1] > 180

    def test_two_recordings_of_a_crossing_count_once(self):
        """Obfuscated, so lined up by where they were; one starts after the
        line, the other before it."""
        coarse = _wrapped(_recording(1000.0, 3600.0, **self.START))
        fine = _wrapped(
            [
                p._replace(lat=-16.0001, lon=179.5 + SPEED * (p.ts - 1000.0))
                for p in _recording(1800.0, 2800.0, step_s=3.0)
            ]
        )
        assert fine[0].lon < 0
        assert _drop([coarse, fine]) == {2025: [1]}

    def test_another_way_across_is_another_flight(self):
        out = _wrapped(_recording(1000.0, 3600.0, **self.START))
        north = _wrapped(
            [
                p._replace(lat=-16.0 + SPEED * (p.ts - 1000.0), lon=179.9)
                for p in _recording(1000.0, 3600.0)
            ]
        )
        assert _drop([out, north]) == {2025: [0, 1]}


class TestClocksMayLineUp:
    """Two real clocks are lined up only where the times they moved allow
    a shift that real clocks are off by (see _real_clock_shift)."""

    @staticmethod
    def _moved(start_s, seconds=1800.0):
        timed = _Timed.of(_recording(start_s, seconds))
        assert timed is not None
        return timed

    def test_at_about_one_time(self):
        shorter = self._moved(JUNE_2025, 1200.0)
        assert _clocks_may_line_up(shorter, self._moved(JUNE_2025 + 600.0), False)
        # A minute apart at most, also of one file
        assert _clocks_may_line_up(shorter, self._moved(JUNE_2025 + 1250.0), True)

    @pytest.mark.parametrize("offset", [3600.0, 3610.0, -7200.0, 1800.0])
    def test_whole_half_hours_apart_of_two_files(self, offset):
        shorter = self._moved(JUNE_2025, 600.0)
        longer = self._moved(JUNE_2025 + offset, 1200.0)
        assert _clocks_may_line_up(shorter, longer, False)
        # Of one file, one clock: never lined up by the half hour
        assert not _clocks_may_line_up(shorter, longer, True)

    @pytest.mark.parametrize("offset", [2700.0, 5000.0, -3000.0])
    def test_not_at_a_half_hour(self, offset):
        """Two flights of one day that took off at other times"""
        shorter = self._moved(JUNE_2025, 600.0)
        assert not _clocks_may_line_up(
            shorter, self._moved(JUNE_2025 + offset, 1200.0), False
        )


def _metadata(*entries: dict[str, str]) -> list[PathMetadata]:
    return cast("list[PathMetadata]", list(entries))


class TestNames:
    def test_by_file_name(self):
        metadata = _metadata(
            {"filename": "1_DEAGJ_DA20.kml", "source": "a/1_DEAGJ_DA20.kml"},
            {"filename": "2_DEAGJ_DA20.kml", "source": "a/2_DEAGJ_DA20.kml"},
        )
        assert _names(metadata, 1, 0) == ["2_DEAGJ_DA20.kml", "1_DEAGJ_DA20.kml"]

    def test_by_path_where_the_names_are_the_same(self):
        """Two folders with files of one name."""
        metadata = _metadata(
            {"filename": "1_DEAGJ_DA20.kml", "source": "a/1_DEAGJ_DA20.kml"},
            {"filename": "1_DEAGJ_DA20.kml", "source": "b/1_DEAGJ_DA20.kml"},
        )
        assert _names(metadata, 1, 0) == ["b/1_DEAGJ_DA20.kml", "a/1_DEAGJ_DA20.kml"]
