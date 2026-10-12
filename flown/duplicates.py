"""The same flight recorded twice, found by where it was when.

``path_content.drop_duplicate_paths`` drops a path that repeats another one
exactly: the same file under two names. The same flight recorded by two
devices (a phone and a panel-mounted GPS), or exported twice by different
tools, has points of its own in each recording, and was counted twice in
every statistic. Two recordings are of one flight when, with the clock of
one moved against the other's, they overlap in time by more than half of
the shorter one, and at the times they share they are in the same place
(``same_flight``). One of them is left out, with a warning that names both
files: the one that does not name the aircraft, when only one does (a phone
log without a registration, next to the file of the panel GPS), and
otherwise the one with fewer points (the coarser recording).

Only recordings with timed points are compared; a line without times has
nothing to tell two flights over the same route apart. Two recordings on
real clocks are compared as they are, and where that tells them apart,
with the clock of one moved by what two real clocks are off by: a few
seconds (GPS time runs 18 s ahead of UTC), or whole half hours (a
device that writes the local time as UTC) when the two are of two files
and took off and landed about together, lined up like the obfuscated
ones below. Obfuscated files, though, start every flight at midnight on
January 1st, each file on its own, so two recordings of one flight that
did not start at the same second no longer line up, and every flight of a
year overlaps every other in time. Where one of two
recordings starts in those days, the clocks are lined up from where the
recordings were instead (``_clock_shifts``), and where they are at each
moment then tells two flights apart, since no two flights take the same way
at the same pace. Only the time the aircraft moved counts then (the ground
of one field is the same for every flight from it), and the two have to be
closer to each other (``_LINED_UP_DISTANCE_KM``).
"""

from bisect import bisect_right
from dataclasses import dataclass, field
from datetime import UTC, datetime
from heapq import merge
from math import ceil, cos, floor, radians, sqrt
from typing import TYPE_CHECKING, NamedTuple

from .date_tokens import near_jan_first
from .geometry import KM_PER_DEGREE, haversine_distance
from .logger import logger
from .path_content import aircraft_known, without_paths

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from .types import FlightPath, FlightPathGroup, PathMetadata

__all__ = [
    "DUPLICATE_DISTANCE_KM",
    "MIN_TIME_OVERLAP",
    "drop_overlapping_paths",
    "same_flight",
]

# Two recordings share more than this part of the shorter one's time
MIN_TIME_OVERLAP = 0.5
# ... and are this close at the moments compared: two GPS receivers agree
# within a few tens of metres, and a second of clock difference is 80 m at
# 150 kt. The moments are spread evenly over the time they share, and a
# tenth of them may be further apart (a fix that jumped).
DUPLICATE_DISTANCE_KM = 0.3
_MOMENTS = 20
_MAX_APART = _MOMENTS // 10

# DUPLICATE_DISTANCE_KM in degrees of latitude, the size of the cells the
# lines between the fixes of a recording are indexed in, at points along
# them half a cell apart (see _index_lines)
_CELL_DEGREES = DUPLICATE_DISTANCE_KM / KM_PER_DEGREE
_SAMPLE_DEGREES = _CELL_DEGREES / 2
# A line that comes this close to a place (225 m) has one of those points
# in the cell of the place or in one of its eight neighbours, however far
# apart its fixes are (a logger that writes a fix a minute): the lines
# ``time_near`` finds
_NEAR_DEGREES = _CELL_DEGREES - _SAMPLE_DEGREES / 2
# A shift of the clock is taken for one that at least this many of the
# moments of ``_clock_shifts`` agree on, to within this many seconds: a
# fix every few seconds, and a few tens of metres between two receivers
# at the speed of a taxiing aircraft
_MIN_AGREEING = 3
_SHIFT_TOLERANCE_S = 5.0
# Faster than this over this long (20 m/s, 39 kt), an aircraft is on its
# takeoff run or in the air, and no longer taxiing (see _Timed.moving)
_MOVING_KM_PER_S = 0.02
_MOVING_WINDOW_S = 10.0
# Two recordings whose clocks were lined up are this close at the moments
# compared, rather than DUPLICATE_DISTANCE_KM: with the time free, two
# circuits flown at one field on different days come within 300 m of each
# other often enough. Two receivers in one aircraft stay within a few tens
# of metres, and a fix every 15 s cuts a turn by 70 m.
_LINED_UP_DISTANCE_KM = 0.15
# What two real clocks are off by (see _real_clock_shift): a minute at
# most (a phone on its own clock, the 18 s GPS time runs ahead), or a whole
# number of half hours (the local time of a time zone written as UTC) and
# no more than GPS time and a clock's drift add to it, up to the furthest
# two zones are apart. Half hours rather than quarters: only two small
# zones are off by a quarter, and every step more lets two flights of one
# day that took the same way at the same pace line up at one of them.
# Two recordings on real clocks further apart in time are of two flights.
_ZONE_STEP_S = 1800.0
_CLOCK_SLACK_S = 60.0
_ZONE_SLACK_S = 25.0
_MAX_CLOCK_OFFSET_S = 15 * 3600.0
# Two recordings on real clocks lined up across a half hour or more are
# of one flight only if they took off and landed about together too: two
# circuit flights an hour apart line up at the hour as well, but not at
# both ends once one flew a lap more than the other. About together is
# within a share of the shorter one's time in the air, or a few samples
# where that is less: a logger started after the takeoff, or stopped
# before the landing, misses a part of the flight but rarely that much.
_ENDS_SLACK_S = 30.0
_ENDS_SHARE = 0.15


class _Line(NamedTuple):
    """The line from one fix of a recording to the next, on a plane.

    North in degrees of latitude, east in degrees of longitude times the
    ``lon_scale`` of the recording, so that both are lengths alike.
    """

    # The index of the fix it starts at, which decides between lines as
    # close to a place
    start: int
    north: float
    east: float
    # How far it runs to the north and the east, and one over the square
    # of its length (0 for a line that stays where it is)
    to_north: float
    to_east: float
    inverse_length: float
    time: float
    duration: float


@dataclass(slots=True)
class _Timed:
    """The timed points of a recording, as parallel lists sorted by time."""

    times: list[float]
    lats: list[float]
    lons: list[float]
    # Whether the clock is the real one: an obfuscated file starts its
    # flight at midnight on January 1st, and so a recording that starts in
    # the days after it may have any clock (see _clock_known)
    clock_known: bool
    # The length of a degree of longitude in degrees of latitude, at the
    # middle latitude of the recording, for distances on a plane
    lon_scale: float = field(init=False)
    # South, north, west and east, DUPLICATE_DISTANCE_KM beyond the fixes
    box: tuple[float, float, float, float] = field(init=False)
    # Made when first needed: two recordings on real clocks that agree as
    # they are, or that cannot be lined up (see _clocks_may_line_up), are
    # compared without them. The lines between the fixes that pass through each cell
    # (see _index_lines), the cells of ``reach``, the part of the
    # recording ``moving`` returns, and the moments of ``samples``.
    _cells: dict[tuple[int, int], list[_Line]] | None = None
    _reach: set[tuple[int, int]] | None = None
    _moving: _Timed | None = None
    _moving_found: bool = False
    _samples: list[tuple[float, float, float]] | None = None

    def __post_init__(self) -> None:
        south, north = min(self.lats), max(self.lats)
        self.lon_scale = max(cos(radians((south + north) / 2)), 0.01)
        self.box = (
            south - _CELL_DEGREES,
            north + _CELL_DEGREES,
            min(self.lons) - _CELL_DEGREES / self.lon_scale,
            max(self.lons) + _CELL_DEGREES / self.lon_scale,
        )

    @classmethod
    def of(cls, path: FlightPath) -> _Timed | None:
        points = sorted(
            (point.ts, point.lat, point.lon) for point in path if point.ts is not None
        )
        if len(points) < 2 or points[-1][0] <= points[0][0]:
            return None
        times, lats, lons = (list(column) for column in zip(*points, strict=True))
        return cls(times, lats, _unwrapped(lons), _clock_known(times[0]))

    @property
    def middle_lon(self) -> float:
        return (self.box[2] + self.box[3]) / 2

    def own_lon(self, lon: float) -> float:
        """``lon`` on the copy of the world the recording is on.

        Its longitudes run on past 180 where it crosses the antimeridian
        (see ``_unwrapped``); a place of another recording is moved by
        whole turns to the side of the line it is on.
        """
        return _beside(lon, self.middle_lon)

    @property
    def duration(self) -> float:
        return self.times[-1] - self.times[0]

    def at(self, moment: float) -> tuple[float, float]:
        """Where the recording was at ``moment``, between its fixes."""
        after = min(max(bisect_right(self.times, moment), 1), len(self.times) - 1)
        before = after - 1
        span = self.times[after] - self.times[before]
        share = (moment - self.times[before]) / span if span > 0 else 0.0
        share = min(max(share, 0.0), 1.0)
        return (
            self.lats[before] + (self.lats[after] - self.lats[before]) * share,
            self.lons[before] + (self.lons[after] - self.lons[before]) * share,
        )

    def samples(self) -> list[tuple[float, float, float]]:
        """The moments ``_clock_shifts`` compares at, and where it was then.

        ``_MOMENTS`` of them, spread evenly over the recording. It is
        compared with every other recording of its year at the same ones.
        """
        if self._samples is None:
            self._samples = []
            for step in range(_MOMENTS):
                moment = self.times[0] + self.duration * (step + 0.5) / _MOMENTS
                self._samples.append((moment, *self.at(moment)))
        return self._samples

    def moving(self) -> _Timed | None:
        """The recording from its takeoff run to its last landing.

        From the first moment the aircraft went faster than
        ``_MOVING_KM_PER_S`` over ``_MOVING_WINDOW_S`` to the last one,
        None when it never did. Two flights from one field stood and taxied
        in the same places, for as long as they did: lined up by where
        they were, that time would make any two of them one flight.
        """
        if not self._moving_found:
            self._moving_found = True
            self._moving = self._find_moving()
        return self._moving

    def _find_moving(self) -> _Timed | None:
        times, lats, lons = self.times, self.lats, self.lons
        speed = _MOVING_KM_PER_S / KM_PER_DEGREE
        first = last = None
        later = 0
        for index, time in enumerate(times):
            while later < len(times) and times[later] < time + _MOVING_WINDOW_S:
                later += 1
            if later == len(times):
                break
            north = lats[later] - lats[index]
            east = (lons[later] - lons[index]) * self.lon_scale
            if north * north + east * east > (speed * (times[later] - time)) ** 2:
                if first is None:
                    first = index
                last = later
        if first is None or last is None:
            return None
        end = last + 1
        return _Timed(
            times[first:end], lats[first:end], lons[first:end], self.clock_known
        )

    def time_near(self, lat: float, lon: float) -> float | None:
        """When the recording passed closest to a place.

        None when it never came within ``_NEAR_DEGREES`` of it.
        Between two fixes, the time is that of the closest point of the
        line between them. Of lines as close, the earliest counts.
        """
        cells = self._index()
        east_of = self.own_lon(lon) * self.lon_scale
        row, column = floor(lat / _CELL_DEGREES), floor(east_of / _CELL_DEGREES)
        nearest_time = None
        nearest_distance = _NEAR_DEGREES**2
        nearest_start = len(self.times)
        for cell_row in (row - 1, row, row + 1):
            for cell_column in (column - 1, column, column + 1):
                for line in cells.get((cell_row, cell_column), ()):
                    start, north, east, to_north, to_east, inverse, time, span = line
                    off_north = lat - north
                    off_east = east_of - east
                    share = (off_north * to_north + off_east * to_east) * inverse
                    share = 0.0 if share < 0.0 else min(share, 1.0)
                    off_north -= share * to_north
                    off_east -= share * to_east
                    distance = off_north * off_north + off_east * off_east
                    if distance < nearest_distance or (
                        distance == nearest_distance
                        and nearest_time is not None
                        and start < nearest_start
                    ):
                        nearest_distance, nearest_start = distance, start
                        nearest_time = time + share * span
        return nearest_time

    def reach(self) -> set[tuple[int, int]]:
        """The cells of the places ``time_near`` may find the recording near.

        Those a line of the recording passes through, and their eight
        neighbours: of a place in any other cell, ``time_near`` surely
        returns None. A set lookup, where it looks at every line nearby.
        """
        if self._reach is None:
            self._reach = {
                (row + rows, column + columns)
                for row, column in self._index()
                for rows in (-1, 0, 1)
                for columns in (-1, 0, 1)
            }
        return self._reach

    def _index(self) -> dict[tuple[int, int], list[_Line]]:
        if self._cells is None:
            self._cells = _index_lines(self.times, self.lats, self.lons, self.lon_scale)
        return self._cells


def _index_lines(
    times: list[float], lats: list[float], lons: list[float], lon_scale: float
) -> dict[tuple[int, int], list[_Line]]:
    """The lines between the fixes of a recording, by the cells they touch.

    A line that stays where it is after the first one is left out: the end
    of the line before it is as close to any place, and earlier.
    """
    cells: dict[tuple[int, int], list[_Line]] = {}
    for start in range(len(times) - 1):
        end = start + 1
        north, east = lats[start], lons[start] * lon_scale
        to_north = lats[end] - north
        to_east = lons[end] * lon_scale - east
        length = to_north * to_north + to_east * to_east
        if length == 0 and start > 0:
            continue
        line = _Line(
            start,
            north,
            east,
            to_north,
            to_east,
            1 / length if length > 0 else 0.0,
            times[start],
            times[end] - times[start],
        )
        touched = {
            (floor(north / _CELL_DEGREES), floor(east / _CELL_DEGREES)): None,
            (
                floor(lats[end] / _CELL_DEGREES),
                floor((east + to_east) / _CELL_DEGREES),
            ): None,
        }
        if length > _SAMPLE_DEGREES**2:
            samples = ceil(sqrt(length) / _SAMPLE_DEGREES)
            for step in range(1, samples):
                share = step / samples
                cell = (
                    floor((north + to_north * share) / _CELL_DEGREES),
                    floor((east + to_east * share) / _CELL_DEGREES),
                )
                touched[cell] = None
        for cell in touched:
            cells.setdefault(cell, []).append(line)
    return cells


def _unwrapped(lons: list[float]) -> list[float]:
    """The longitudes of a recording, running on past 180 across the line.

    A flight across the antimeridian would otherwise jump from 180 to -180
    between two fixes: its line would cross the whole world, and the cells
    it passes through (see ``_index_lines``) would be counted in hundreds
    of thousands. A recording that does not cross keeps its longitudes as
    they are, to the last bit.
    """
    unwrapped: list[float] = []
    offset = 0.0
    previous = lons[0]
    for lon in lons:
        if abs(lon - previous) > 180:
            offset -= 360 * round((lon - previous) / 360)
        previous = lon
        unwrapped.append(lon + offset)
    return unwrapped


def _beside(lon: float, reference: float) -> float:
    """``lon`` moved by whole turns to within 180 degrees of ``reference``."""
    if abs(lon - reference) <= 180:
        return lon
    return lon - 360 * round((lon - reference) / 360)


def _clock_known(start: float) -> bool:
    """Whether a recording that starts at ``start`` runs on the real clock.

    An obfuscated one starts at midnight on January 1st, and one piece of
    a file that holds several starts in the days after it, since a flight
    keeps its intervals. A real flight in those days is taken for an
    obfuscated one, which costs nothing but the time to compare it.
    """
    try:
        started = datetime.fromtimestamp(start, UTC)
    except OverflowError, OSError, ValueError:
        return False
    return not near_jan_first(started.month, started.day)


def same_flight(
    first: _Timed,
    second: _Timed,
    shift: float = 0.0,
    within_km: float = DUPLICATE_DISTANCE_KM,
) -> bool:
    """Whether two timed recordings are of one flight (see the module).

    ``shift`` is how far the clock of ``second`` runs ahead of the clock of
    ``first``: the moment ``t`` of the first is ``t + shift`` in the second.
    """
    begin = max(first.times[0], second.times[0] - shift)
    end = min(first.times[-1], second.times[-1] - shift)
    shorter = min(first.duration, second.duration)
    if end - begin <= MIN_TIME_OVERLAP * shorter:
        return False
    apart = 0
    for step in range(_MOMENTS):
        moment = begin + (end - begin) * (step + 0.5) / _MOMENTS
        lat1, lon1 = first.at(moment)
        lat2, lon2 = second.at(moment + shift)
        if haversine_distance(lat1, lon1, lat2, lon2) > within_km:
            apart += 1
            if apart > _MAX_APART:
                return False
    return True


def _clock_shifts(first: _Timed, second: _Timed) -> list[float]:
    """The shifts of the clock of ``second`` that may line it up with ``first``.

    At moments spread over the first recording, the time the second passed
    closest to where the first was, less the moment (see ``same_flight``).
    A shift that at least ``_MIN_AGREEING`` of them agree on is returned as
    the middle one of them, the one agreed on most first. Two recordings of
    one flight agree on their shift wherever the aircraft moved.

    Most two flights of a year are not near each other at enough of those
    moments for a shift to be agreed on, which the cells the second one
    may be found near (``reach``) tell before any of its lines is looked
    at. The cell of a place is the one ``time_near`` looks in.
    """
    reach, lon_scale, middle = second.reach(), second.lon_scale, second.middle_lon
    near_places: list[tuple[float, float, float]] = []
    for moment, lat, place_lon in first.samples():
        # On the second's copy of the world (see _Timed.own_lon)
        lon = (
            place_lon if abs(place_lon - middle) <= 180 else _beside(place_lon, middle)
        )
        cell = (floor(lat / _CELL_DEGREES), floor(lon * lon_scale / _CELL_DEGREES))
        if cell in reach:
            near_places.append((moment, lat, lon))
    if len(near_places) < _MIN_AGREEING:
        return []
    shifts: list[float] = []
    for moment, lat, lon in near_places:
        near = second.time_near(lat, lon)
        if near is not None:
            shifts.append(near - moment)
    shifts.sort()
    agreeing: list[list[float]] = []
    for shift in shifts:
        if agreeing and shift - agreeing[-1][-1] <= _SHIFT_TOLERANCE_S:
            agreeing[-1].append(shift)
        else:
            agreeing.append([shift])
    return [
        group[len(group) // 2]
        for group in sorted(agreeing, key=len, reverse=True)
        if len(group) >= _MIN_AGREEING
    ]


def _real_clock_shift(
    shift: float, shorter: _Timed, longer: _Timed, one_clock: bool
) -> bool:
    """Whether two real clocks may be off by ``shift`` seconds.

    By a few seconds, or a whole number of half hours (see
    ``_ZONE_STEP_S``), up to ``_MAX_CLOCK_OFFSET_S``. Off by half
    hours only for recordings of two files (``one_clock`` is that they are
    of one, whose logger wrote them by one clock), and only when the two
    took off and landed about together once lined up (see
    ``_ENDS_SLACK_S``). ``shorter`` and ``longer`` are the times they
    moved (see ``_Timed.moving``).
    """
    steps = round(shift / _ZONE_STEP_S)
    off_step = abs(shift - _ZONE_STEP_S * steps)
    if steps == 0:
        return off_step <= _CLOCK_SLACK_S
    if abs(shift) > _MAX_CLOCK_OFFSET_S or off_step > _ZONE_SLACK_S:
        return False
    slack = max(_ENDS_SLACK_S, _ENDS_SHARE * shorter.duration)
    return (
        not one_clock
        and abs(longer.times[0] - shorter.times[0] - shift) <= slack
        and abs(longer.times[-1] - shorter.times[-1] - shift) <= slack
    )


def _clocks_may_line_up(shorter: _Timed, longer: _Timed, one_clock: bool) -> bool:
    """Whether any shift ``_real_clock_shift`` allows may line two real
    clocks up, judged by the times the two moved alone.

    Off by a minute at most, the two moved at about one time. Off by a
    whole number of half hours, they took off about that far apart (see
    ``_ENDS_SLACK_S``). Two recordings that do neither are not lined up at
    all, which saves finding the shifts of two flights of one day.
    """
    if (
        longer.times[0] - _CLOCK_SLACK_S <= shorter.times[-1]
        and shorter.times[0] - _CLOCK_SLACK_S <= longer.times[-1]
    ):
        return True
    if one_clock:
        return False
    takeoff = longer.times[0] - shorter.times[0]
    slack = max(_ENDS_SLACK_S, _ENDS_SHARE * shorter.duration) + _ZONE_SLACK_S
    low = floor(takeoff / _ZONE_STEP_S)
    return any(
        steps != 0 and abs(takeoff - _ZONE_STEP_S * steps) <= slack
        for steps in (low, low + 1)
    )


def _apart_in_time(first: _Timed, second: _Timed) -> bool:
    """Whether two recordings on real clocks are too far apart in time.

    Further than any two real clocks are off by (``_MAX_CLOCK_OFFSET_S``):
    two flights of other days.
    """
    return (
        second.times[0] - first.times[-1] > _MAX_CLOCK_OFFSET_S
        or first.times[0] - second.times[-1] > _MAX_CLOCK_OFFSET_S
    )


def _one_flight(
    first: _Timed,
    second: _Timed,
    one_clock: bool = False,
    two_aircraft: bool = False,
) -> bool:
    """Whether two recordings are of one flight.

    Two real clocks agree, or are off by what real clocks are off by (see
    ``_real_clock_shift``): the recordings are compared as they are, then
    lined up like the others where the times they moved allow it (see
    ``_clocks_may_line_up``), and two flights of other days are never
    compared. Where one of them may be obfuscated, the clocks are lined up
    first (see ``_clock_shifts``), and only the time the aircraft moved
    counts (see ``_Timed.moving``). ``one_clock`` is whether the two are of
    one file, ``two_aircraft`` whether they name two aircraft (see
    ``_two_aircraft``), which are never one flight: two aircraft flying in
    formation are as close as one flight on two loggers, and two flying one
    circuit an hour apart line up as well as one flight on two clocks.
    """
    if two_aircraft:
        return False
    real_clocks = first.clock_known and second.clock_known
    if real_clocks:
        if _apart_in_time(first, second):
            return False
        if same_flight(first, second):
            return True
    first_moving, second_moving = first.moving(), second.moving()
    if first_moving is None or second_moving is None:
        return False
    south, north, west, east = first_moving.box
    box = second_moving.box
    # The two boxes on one copy of the world, should either cross the line
    turn = (
        _beside(second_moving.middle_lon, first_moving.middle_lon)
        - second_moving.middle_lon
    )
    if box[0] > north or box[1] < south or box[2] + turn > east or box[3] + turn < west:
        return False
    # The moments are spread over the shorter one, most of which the other
    # one shares if they are of one flight
    shorter, longer = sorted(
        (first_moving, second_moving), key=lambda recording: recording.duration
    )
    if real_clocks and not _clocks_may_line_up(shorter, longer, one_clock):
        return False
    return any(
        same_flight(shorter, longer, shift, _LINED_UP_DISTANCE_KM)
        for shift in _clock_shifts(shorter, longer)
        if not real_clocks or _real_clock_shift(shift, shorter, longer, one_clock)
    )


def _one_file(first: PathMetadata, second: PathMetadata) -> bool:
    """Whether two recordings are of one input file.

    By its path where the run set it (``source``): two folders may hold
    files of one name, recorded by two loggers. By the file name otherwise.
    """
    if "source" in first and "source" in second:
        return first["source"] == second["source"]
    name = first.get("filename")
    return bool(name) and name == second.get("filename")


def _two_aircraft(first: PathMetadata, second: PathMetadata) -> bool:
    """Whether two recordings name two aircraft: both a registration, not
    the same one."""
    one = (first.get("aircraft_registration") or "").upper()
    other = (second.get("aircraft_registration") or "").upper()
    return bool(one) and bool(other) and one != other


def _name(metadata: Sequence[PathMetadata], index: int) -> str:
    return metadata[index].get("filename") or f"path {index}"


def drop_overlapping_paths(
    paths_by_year: Mapping[int, list[int]],
    all_path_groups: FlightPathGroup,
    all_path_metadata: Sequence[PathMetadata],
    exported: Mapping[int, object],
) -> dict[int, list[int]]:
    """Leave out every exported path that records a flight another one does.

    ``exported`` holds the indices of the exported paths (see
    ``path_content.exported_contents``). Of two recordings of one flight
    the one that names the aircraft stays: its registration first, then its
    type (see ``aircraft_known``). Of two that name as much, the one with
    more points stays, and of two with as many the first in input order, so
    the choice does not depend on the order they are compared in. Every
    recording of a year is compared with every other one: those on real
    clocks by time, and the others with every one whose area they touch
    (see the module). Two on real clocks that are further apart in time
    than two real clocks are off by are not compared at all: the kept ones
    are gone through in the order they started, and one that ended long
    before a recording on a real clock started did so before every later
    one. A year left without an exported path is left out.
    """
    dropped: set[int] = set()
    for indices in paths_by_year.values():
        timed = {
            index: recording
            for index in indices
            if index in exported
            and (recording := _Timed.of(all_path_groups[index])) is not None
        }

        # The order the recordings started in, and a recording's place in it
        started = {
            index: (recording.times[0], index) for index, recording in timed.items()
        }
        # The kept recordings, each in the order they started: those on
        # real clocks, of which the first ``open_from`` ended too long ago
        # for any later one on a real clock, and the others
        real: list[int] = []
        open_from = 0
        other_clocks: list[int] = []
        for index in sorted(timed, key=started.__getitem__):
            recording = timed[index]
            if recording.clock_known:
                while (
                    open_from < len(real)
                    and recording.times[0] - timed[real[open_from]].times[-1]
                    > _MAX_CLOCK_OFFSET_S
                ):
                    open_from += 1
                candidates = merge(
                    other_clocks, real[open_from:], key=started.__getitem__
                )
            else:
                candidates = merge(other_clocks, real, key=started.__getitem__)
            for other in list(candidates):
                if other in dropped or not _one_flight(
                    timed[other],
                    recording,
                    _one_file(all_path_metadata[other], all_path_metadata[index]),
                    _two_aircraft(all_path_metadata[other], all_path_metadata[index]),
                ):
                    continue
                keep, drop = sorted(
                    (other, index),
                    key=lambda i: (
                        aircraft_known(all_path_metadata[i]),
                        -len(timed[i].times),
                        i,
                    ),
                )
                dropped.add(drop)
                logger.warning(
                    "Skipping a flight in %s: the same flight as in %s, recorded twice",
                    _name(all_path_metadata, drop),
                    _name(all_path_metadata, keep),
                )
                if drop == index:
                    break
            if index not in dropped:
                (real if recording.clock_known else other_clocks).append(index)
    return without_paths(paths_by_year, dropped, exported)
