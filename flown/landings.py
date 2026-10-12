"""Landings, touch-and-goes, go-arounds and the runways they used.

The page only sees altitudes in steps of 20 ft and cannot tell a touchdown
from a pass a few dozen feet up, so the flights are read here, at build
time, from the parsed track with its full precision and its timestamps.
Each exported flight gets four counts in its path info (see
``export_pipeline.build_path_info``): full-stop ``landings``,
``touch_and_goes``, ``go_arounds`` (a low approach looks the same at GPS
precision, so both count as one) and the ``touchdowns`` as a list of
``[airport, runway]``. Nothing of it carries a time.

The rules, per timed fix of a flight:

- A field is the nearest airport of the database (one with a runway, so
  no heliport) within ``FIELD_RADIUS_KM``. Its ground is the elevation the
  database gives plus the logger's offset: how far the altitudes the
  logger recorded while taxiing at known fields are above their published
  elevations, the median over the whole flight. A GPS altitude is off by
  tens of feet, a barometric one by the pressure of the day, and the taxi
  altitudes at a single field can be off by far more (a receiver that has
  not settled yet), which the median over the flight evens out.
- The aircraft is airborne once its groundspeed passes ``TAKEOFF_KNOTS``
  and it is ``TAKEOFF_CLIMB_FT`` above the field ``TAKEOFF_CHECK_SECONDS``
  later.
- A touchdown only counts once the aircraft has climbed ``ARMED_CLIMB_FT``
  above its takeoff (or its last touch-and-go): otherwise every takeoff
  roll would read as a touch-and-go.
- Within ``CONTACT_FT`` of the field's ground at ``CONTACT_KNOTS`` or more
  is a touchdown. Below ``STOP_KNOTS``, still within ``CONTACT_FT`` of the
  ground, it is a full-stop landing; a climb of ``CLIMB_AWAY_FT`` without
  stopping makes it a touch-and-go. The height matters for the stop as
  well: a gap in the timestamps reads as a stop wherever it is. Within
  means above or below: a logger that loses its altitude for a while
  reports the aircraft hundreds of feet under the ground.
- Below ``APPROACH_FT`` above a field without coming within ``CONTACT_FT``
  of it, then a climb of ``CLIMB_AWAY_FT``, is a go-around when the track
  to the lowest point lines up with a runway of the field (any track at a
  field without runways in the list). No new approach starts before the
  aircraft is above ``APPROACH_FT`` or away from the field again, so the
  climb away counts once.
- The runway is the track over the last ``APPROACH_SECONDS`` before the
  touchdown, snapped to the nearest runway end of the field in the
  OurAirports runway list (``airport_lookup.load_runway_database``). A
  constant magnetic variation would only hold in one part of the world;
  the true headings of the runway list hold everywhere.

The detection runs with the parse of every file, in the parse workers
(see ``path_landings``), and the parse cache keeps what it found with the
paths: its key covers the airport and the runway database. The export
only falls back to detecting them itself (``detect_landings``) for paths
that come without them; its workers never load the databases.
"""

import math
import time
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field
from itertools import pairwise
from statistics import median
from typing import TYPE_CHECKING, NamedTuple

from .airport_lookup import load_airport_database, load_runway_database
from .constants import (
    KM_TO_NAUTICAL_MILES,
    MAX_GROUNDSPEED_KNOTS,
    METERS_TO_FEET,
    SECONDS_PER_HOUR,
)
from .geometry import METRES_PER_DEGREE, planar_km, true_bearing
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence

    from .airport_lookup import AirportRecord, RunwayEnd
    from .types import FlightPath

__all__ = [
    "Field",
    "FieldIndex",
    "FlightLandings",
    "detect_landings",
    "detect_path_landings",
    "field_index",
    "log_landings",
    "path_landings",
]

# How far from an airport's reference point a fix still counts as at the
# field: a 3 km runway and the approach to it at 400 ft fit inside
FIELD_RADIUS_KM = 5.0
# Groundspeed of a takeoff roll, and how far the aircraft has to be above
# the field that long after it
TAKEOFF_KNOTS = 45.0
TAKEOFF_CHECK_SECONDS = 30.0
TAKEOFF_CLIMB_FT = 150.0
# Climb after a takeoff or a touch-and-go before the next touchdown counts
ARMED_CLIMB_FT = 400.0
# Height above the field's ground that is a touchdown, at no less than this
# groundspeed
CONTACT_FT = 60.0
CONTACT_KNOTS = 35.0
# Groundspeed below which a touchdown ends in a full stop
STOP_KNOTS = 25.0
# Climb after a touchdown or the lowest point of an approach that is a
# touch-and-go or a go-around
CLIMB_AWAY_FT = 300.0
# Height above a field below which the aircraft is on an approach to it
APPROACH_FT = 400.0
# The part of the approach the runway is read from, and the least distance
# it has to cover for a heading
APPROACH_SECONDS = 30.0
APPROACH_MIN_METRES = 200.0
# A runway end further off the track than this is not the one it used
RUNWAY_MAX_OFF_DEGREES = 30.0
# Fewer timed fixes than this say nothing about landings
MIN_TIMED_FIXES = 10
# Speeds are measured over this long on either side of a fix (see
# _groundspeeds), and a measurement over less or more time than the bounds
# below is none: jitter, or a gap in the recording
SPEED_HALF_WINDOW_SECONDS = 5.0
SPEED_MIN_SECONDS = 2.0
SPEED_MAX_SECONDS = 120.0
# An altitude this far from the median of the fixes around it is a glitch
# of the logger (see _without_spikes)
SPIKE_FT = 200.0
SPIKE_WINDOW = 7
# Faster than this up or down is no light aircraft but a logger that lost
# its fix; no approach or touchdown is read from such a fix
MAX_VERTICAL_FT_PER_SECOND = 60.0

# The grid the fields are looked up in, in degrees of latitude
_CELL_DEGREES = 0.1
# The height of a cell, and its width at the equator
_CELL_KM = _CELL_DEGREES * METRES_PER_DEGREE / 1000
# The cells around a parallel
_COLUMNS = round(360 / _CELL_DEGREES)


class Field(NamedTuple):
    """An airport a flight may land at."""

    ident: str
    lat: float
    lon: float
    elevation_ft: float | None
    # The runway ends: designator and true heading, see RunwayEnd
    runways: tuple[RunwayEnd, ...] = ()


def _angle_off(a: float, b: float) -> float:
    """The angle between two headings, 0 to 180 degrees."""
    return abs((a - b + 180) % 360 - 180)


class FieldIndex:
    """The fields in a grid, for the nearest one to a fix."""

    def __init__(self, fields: Iterable[Field]) -> None:
        """Put every field into its cell."""
        self._cells: dict[tuple[int, int], list[Field]] = {}
        for entry in fields:
            self._cells.setdefault(self._cell(entry.lat, entry.lon), []).append(entry)
        # The fields around a cell, by cell and radius (see _around)
        self._nearby: dict[tuple[int, int, float], list[Field]] = {}

    def __len__(self) -> int:
        """The number of fields."""
        return sum(len(cell) for cell in self._cells.values())

    @staticmethod
    def _cell(lat: float, lon: float) -> tuple[int, int]:
        # -180 and 180 degrees are one meridian, and the columns either side
        # of it neighbours
        return (
            math.floor(lat / _CELL_DEGREES),
            math.floor(lon / _CELL_DEGREES) % _COLUMNS,
        )

    def _around(self, row: int, column: int, radius_km: float) -> list[Field]:
        """The fields of the cells the radius reaches from anywhere in a cell.

        One cell on either side where a cell is wider than the radius, as it
        is up to 60 degrees of latitude, more further north and south, where
        the cells narrow. Kept per cell: a track has thousands of fixes in
        each, and gathering the cells again for every fix was half of the
        time the landings took.
        """
        key = (row, column, radius_km)
        found = self._nearby.get(key)
        if found is None:
            rows = math.ceil(radius_km / _CELL_KM)
            # Where the rows reach furthest from the equator, from the edge
            # of the cell nearest the pole, their cells are the narrowest
            edge = max(abs(row), abs(row + 1)) * _CELL_DEGREES
            furthest_lat = min(89.9, edge + rows * _CELL_DEGREES)
            narrowest_km = _CELL_KM * math.cos(math.radians(furthest_lat))
            columns = math.ceil(radius_km / narrowest_km)
            found = [
                candidate
                for d_row in range(-rows, rows + 1)
                for d_column in range(-columns, columns + 1)
                for candidate in self._cells.get(
                    (row + d_row, (column + d_column) % _COLUMNS), ()
                )
            ]
            self._nearby[key] = found
        return found

    def nearest(
        self, lat: float, lon: float, radius_km: float = FIELD_RADIUS_KM
    ) -> tuple[Field, float] | None:
        """The nearest field within ``radius_km`` and its distance, or None."""
        best: tuple[Field, float] | None = None
        for candidate in self._around(*self._cell(lat, lon), radius_km):
            distance = planar_km(lat, lon, candidate.lat, candidate.lon)
            if distance <= radius_km and (best is None or distance < best[1]):
                best = (candidate, distance)
        return best


def field_index(
    airports: Mapping[str, AirportRecord] | None = None,
    runways: Mapping[str, tuple[RunwayEnd, ...]] | None = None,
) -> FieldIndex:
    """The fields of the airport and runway databases.

    An airport counts as a field when the runway list has a runway for it,
    which leaves out heliports (their "runways" are pads, H1) and anything
    else without one. Without a runway list every airport of the database
    counts, and no touchdown gets a runway.
    """
    if airports is None:
        airports = load_airport_database()
    if runways is None:
        runways = load_runway_database()
    if not runways:
        return FieldIndex(
            Field(ident, record.lat, record.lon, _feet(record.elevation_m))
            for ident, record in airports.items()
        )
    return FieldIndex(
        Field(ident, record.lat, record.lon, _feet(record.elevation_m), ends)
        for ident, record in airports.items()
        if (ends := runways.get(ident))
    )


def _feet(metres: float | None) -> float | None:
    return None if metres is None else metres * METERS_TO_FEET


@dataclass
class FlightLandings:
    """What a flight did at the fields it came to."""

    # The site carries none; they check the detector against what a log
    # shows, and cost nothing
    takeoffs: int = 0
    landings: int = 0
    touch_and_goes: int = 0
    go_arounds: int = 0
    # Every touchdown in the order flown: the field and the runway, None
    # where the runway could not be told
    touchdowns: list[tuple[str, str | None]] = field(default_factory=list)


class _Fix(NamedTuple):
    lat: float
    lon: float
    alt_ft: float
    t: float


def _timed_fixes(path: FlightPath) -> list[_Fix]:
    """The fixes with an altitude and a time, in the order of their times.

    Without the fixes that repeat the position of the one before (a logger
    that writes its last fix again, with a new time, while it has no new
    one) and the altitude spikes (see ``_without_spikes``).
    """
    fixes: list[_Fix] = []
    for point in path:
        if point.alt is None or point.ts is None:
            continue
        if fixes and (point.lat, point.lon) == (fixes[-1].lat, fixes[-1].lon):
            continue
        fixes.append(_Fix(point.lat, point.lon, point.alt * METERS_TO_FEET, point.ts))
    # The parser keeps the recorded order; a clock that ran backwards would
    # make every speed after it meaningless
    if any(b.t < a.t for a, b in pairwise(fixes)):
        return []
    return _without_spikes(fixes)


def _without_spikes(fixes: list[_Fix]) -> list[_Fix]:
    """The fixes without those whose altitude leaps away from their neighbours.

    Some loggers write an altitude of 0 now and then, or another that is
    hundreds of feet off, for a fix or two; read as they are, they touch
    down wherever they happen near a field. A fix is dropped when its
    altitude is more than ``SPIKE_FT`` from the median of the
    ``SPIKE_WINDOW`` fixes around it, which a real touchdown, at the rates
    a light aircraft climbs and sinks, never is.
    """
    half = SPIKE_WINDOW // 2
    altitudes = [fix.alt_ft for fix in fixes]
    kept: list[_Fix] = []
    for i, fix in enumerate(fixes):
        window = sorted(altitudes[max(0, i - half) : i + half + 1])
        if abs(fix.alt_ft - window[len(window) // 2]) <= SPIKE_FT:
            kept.append(fix)
    return kept


def _groundspeeds(fixes: Sequence[_Fix], times: Sequence[float]) -> list[float | None]:
    """Knots at every fix, None where they cannot be told.

    Measured from the last fix ``SPEED_HALF_WINDOW_SECONDS`` or more before
    it to the first as far after it: loggers write fixes a fraction of a
    second apart as often as seconds apart, and the jitter of the position
    over a fraction of a second reads as hundreds of knots.
    """
    speeds: list[float | None] = []
    last = len(fixes) - 1
    for fix in fixes:
        a = fixes[max(0, bisect_right(times, fix.t - SPEED_HALF_WINDOW_SECONDS) - 1)]
        b = fixes[min(last, bisect_left(times, fix.t + SPEED_HALF_WINDOW_SECONDS))]
        seconds = b.t - a.t
        if not SPEED_MIN_SECONDS <= seconds <= SPEED_MAX_SECONDS:
            speeds.append(None)
            continue
        km = planar_km(a.lat, a.lon, b.lat, b.lon)
        knots = km * KM_TO_NAUTICAL_MILES / seconds * SECONDS_PER_HOUR
        speeds.append(knots if knots <= MAX_GROUNDSPEED_KNOTS else None)
    return speeds


def _logger_offset_ft(
    fixes: Sequence[_Fix],
    speeds: Sequence[float | None],
    nearest: Sequence[tuple[Field, float] | None],
) -> float:
    """How far the logger's altitudes are above the published elevations.

    The median over every fix the aircraft taxied at a field with a known
    elevation, 0 for a flight that taxied at none.
    """
    offsets = [
        fix.alt_ft - near[0].elevation_ft
        for fix, speed, near in zip(fixes, speeds, nearest, strict=True)
        if speed is not None
        and speed < STOP_KNOTS
        and near is not None
        and near[0].elevation_ft is not None
    ]
    return median(offsets) if offsets else 0.0


def _taxi_grounds_ft(
    fixes: Sequence[_Fix],
    speeds: Sequence[float | None],
    nearest: Sequence[tuple[Field, float] | None],
) -> dict[str, float]:
    """The ground of each field the database has no elevation for.

    The median altitude the logger recorded while taxiing there.
    """
    altitudes: dict[str, list[float]] = {}
    for fix, speed, near in zip(fixes, speeds, nearest, strict=True):
        if (
            speed is not None
            and speed < STOP_KNOTS
            and near is not None
            and near[0].elevation_ft is None
        ):
            altitudes.setdefault(near[0].ident, []).append(fix.alt_ft)
    return {ident: median(values) for ident, values in altitudes.items()}


def _runway(
    fixes: Sequence[_Fix], times: Sequence[float], touchdown: int, at: Field
) -> str | None:
    """The runway end the aircraft touched down on, None when unknown.

    The track from the fix ``APPROACH_SECONDS`` before the touchdown to the
    touchdown, snapped to the nearest runway end of the field.
    """
    if not at.runways:
        return None
    end = fixes[touchdown]
    start = fixes[bisect_left(times, end.t - APPROACH_SECONDS, 0, touchdown)]
    if planar_km(start.lat, start.lon, end.lat, end.lon) * 1000 < (APPROACH_MIN_METRES):
        return None
    track = true_bearing(start.lat, start.lon, end.lat, end.lon)
    off, designator = min(
        (_angle_off(track, runway.heading), runway.designator) for runway in at.runways
    )
    return designator if off <= RUNWAY_MAX_OFF_DEGREES else None


@dataclass
class _Approach:
    """The lowest point of an approach to a field so far."""

    at: Field
    lowest_ft: float
    lowest: int


class _Detector:
    """The state of one flight as ``detect_path_landings`` walks its fixes.

    ``step`` reads one fix, handing it to the phase the flight is in: the
    ground roll before a takeoff (``_rolling``), a touchdown that has not
    stopped or climbed away yet (``_after_contact``), the climb that arms
    the next touchdown, and low over a field (``_near_field``, which
    ``_approach`` continues). ``finish`` counts a touchdown the recording
    ended on.
    """

    def __init__(self, fixes: list[_Fix], fields: FieldIndex) -> None:
        """Measure the fixes and tell whether the recording starts on the ground."""
        self.fixes = fixes
        self.times = [fix.t for fix in fixes]
        self.speeds = _groundspeeds(fixes, self.times)
        self.nearest = [fields.nearest(fix.lat, fix.lon) for fix in fixes]
        self.offset = _logger_offset_ft(fixes, self.speeds, self.nearest)
        self.taxi_grounds = _taxi_grounds_ft(fixes, self.speeds, self.nearest)
        self.result = FlightLandings()
        # The recording starts on the ground when it starts slow or close to
        # the ground of a field. Either can be wrong at the first fixes of a
        # receiver: they often share a time, and their scatter reads as
        # speed, and the altitude may not have settled yet.
        first = self.nearest[0]
        first_ground = self.ground_ft(first[0]) if first is not None else None
        first_speed = next((speed for speed in self.speeds if speed is not None), 0.0)
        self.on_ground = first_speed < TAKEOFF_KNOTS or (
            first_ground is not None
            and abs(fixes[0].alt_ft - first_ground) <= CONTACT_FT
        )
        # Starting in the air, the logger missed the takeoff: a touchdown
        # counts
        self.armed = not self.on_ground
        # The altitude the climb that arms the next touchdown is measured from
        self.base_ft = fixes[0].alt_ft
        # The first fix of a touchdown that has not stopped or climbed away
        self.contact: int | None = None
        self.contact_at: Field | None = None
        self.approach: _Approach | None = None
        # After a go-around, until the aircraft is above APPROACH_FT or away
        # from the field again: the climb away passes through the approach
        # band, and read as a new approach there it would climb away twice
        self.climbing_away = False

    def ground_ft(self, at: Field) -> float | None:
        """The ground of a field: its elevation plus the logger's offset."""
        if at.elevation_ft is not None:
            return at.elevation_ft + self.offset
        return self.taxi_grounds.get(at.ident)

    def touch_down(self, index: int, at: Field) -> None:
        """Record a touchdown at ``at`` from the fix at ``index``."""
        self.result.touchdowns.append(
            (at.ident, _runway(self.fixes, self.times, index, at))
        )

    def step(self, index: int, fix: _Fix) -> None:
        """Read one fix."""
        speed = self.speeds[index]
        near = self.nearest[index]
        at = near[0] if near is not None else None
        ground = self.ground_ft(at) if at is not None else None
        if speed is None:
            return
        if index and abs(fix.alt_ft - self.fixes[index - 1].alt_ft) > (
            MAX_VERTICAL_FT_PER_SECOND * max(1.0, fix.t - self.fixes[index - 1].t)
        ):
            self.approach = None
            return
        if self.on_ground:
            self._rolling(fix, speed, ground)
        elif self.contact is not None and self.contact_at is not None:
            self._after_contact(fix, speed, self.contact, self.contact_at)
        elif not self.armed:
            self.armed = fix.alt_ft - self.base_ft >= ARMED_CLIMB_FT
        elif at is None or ground is None:
            self.approach = None
            self.climbing_away = False
        else:
            self._near_field(index, speed, at, fix.alt_ft - ground)

    def _rolling(self, fix: _Fix, speed: float, ground: float | None) -> None:
        """On the ground: a takeoff once it is fast and climbs after."""
        if speed < TAKEOFF_KNOTS:
            return
        later = bisect_left(self.times, fix.t + TAKEOFF_CHECK_SECONDS)
        if later >= len(self.fixes):
            return
        reference = ground if ground is not None else fix.alt_ft
        if self.fixes[later].alt_ft - reference >= TAKEOFF_CLIMB_FT:
            self.on_ground = False
            self.armed = False
            self.base_ft = reference
            self.approach = None
            self.result.takeoffs += 1

    def _after_contact(
        self, fix: _Fix, speed: float, contact: int, contact_at: Field
    ) -> None:
        """After a touchdown: a full stop, or a climb that is a touch-and-go."""
        contact_ground = self.ground_ft(contact_at)
        if (
            speed < STOP_KNOTS
            and contact_ground is not None
            and abs(fix.alt_ft - contact_ground) <= CONTACT_FT
        ):
            self.result.landings += 1
            self.touch_down(contact, contact_at)
            self.on_ground = True
            self.contact = self.contact_at = None
        elif fix.alt_ft - self.fixes[contact].alt_ft >= CLIMB_AWAY_FT:
            self.result.touch_and_goes += 1
            self.touch_down(contact, contact_at)
            self.base_ft = self.fixes[contact].alt_ft
            self.armed = False
            self.contact = self.contact_at = None

    def _near_field(self, index: int, speed: float, at: Field, height: float) -> None:
        """At a field, ``height`` above its ground: a touchdown or an approach."""
        if height < -CONTACT_FT:
            # Under the ground: the logger lost its altitude
            self.approach = None
            return
        if height <= CONTACT_FT:
            if speed < STOP_KNOTS:
                # Down and stopped between two fixes
                self.result.landings += 1
                self.touch_down(index, at)
                self.on_ground = True
            elif speed >= CONTACT_KNOTS:
                self.contact, self.contact_at = index, at
            self.approach = None
            return
        self._approach(index, at, height)

    def _approach(self, index: int, at: Field, height: float) -> None:
        """Above a field: the lowest point of an approach, or its go-around."""
        if height >= APPROACH_FT:
            self.climbing_away = False
        elif not self.climbing_away:
            if self.approach is None or self.approach.at is not at:
                self.approach = _Approach(at, height, index)
            elif height < self.approach.lowest_ft:
                self.approach.lowest_ft, self.approach.lowest = height, index
        approach = self.approach
        if approach is not None and height - approach.lowest_ft >= CLIMB_AWAY_FT:
            # Low over a field is no approach unless it lines up with one of
            # its runways, where the list has them
            if not approach.at.runways or _runway(
                self.fixes, self.times, approach.lowest, approach.at
            ):
                self.result.go_arounds += 1
            self.approach = None
            self.climbing_away = True

    def finish(self) -> FlightLandings:
        """What the flight did, with a touchdown the recording ended on."""
        if self.contact is not None and self.contact_at is not None:
            # The recording ended on the runway, before the aircraft slowed
            self.result.landings += 1
            self.touch_down(self.contact, self.contact_at)
        return self.result


def detect_path_landings(path: FlightPath, fields: FieldIndex) -> FlightLandings | None:
    """What one flight did at the fields it came to (see the module).

    None for a flight without enough timed fixes to tell.
    """
    fixes = _timed_fixes(path)
    if len(fixes) < MIN_TIMED_FIXES:
        return None
    detector = _Detector(fixes, fields)
    for index, fix in enumerate(fixes):
        detector.step(index, fix)
    return detector.finish()


# The fields of the databases this process loaded, with those databases: at
# most one entry
_fields: list[tuple[object, object, FieldIndex]] = []


def _fields_of_this_process() -> FieldIndex:
    """The fields of the databases this process loaded, built once for them.

    Built again when the databases changed, as after
    ``AirportDatabases.reset`` and a refresh.
    """
    airports = load_airport_database()
    runways = load_runway_database()
    if not _fields or _fields[0][0] is not airports or _fields[0][1] is not runways:
        _fields[:] = [(airports, runways, field_index(airports, runways))]
    return _fields[0][2]


def path_landings(paths: Sequence[FlightPath]) -> list[FlightLandings | None]:
    """The landings of every path, in their order, None for a path without.

    What a parse keeps with its paths in the parse cache, whose key covers
    the airport and runway databases the fields come from. Without an
    airport database every path gets None, as ``detect_landings`` counts no
    landing then.
    """
    fields = _fields_of_this_process()
    if not len(fields):
        return [None] * len(paths)
    return [detect_path_landings(path, fields) for path in paths]


def detect_landings(
    paths: Mapping[int, FlightPath], fields: FieldIndex | None = None
) -> dict[int, FlightLandings]:
    """The landings of every path, by its key; paths without timing are left out.

    ``fields`` defaults to the airport and runway databases (``field_index``).
    """
    started = time.monotonic()
    if fields is None:
        fields = field_index()
    if not len(fields):
        logger.warning("No airport database: the landings are not counted")
        return {}
    found: dict[int, FlightLandings] = {}
    for key, path in paths.items():
        landings = detect_path_landings(path, fields)
        if landings is not None:
            found[key] = landings
    log_landings(found, time.monotonic() - started)
    return found


def log_landings(
    found: Mapping[int, FlightLandings], seconds: float | None = None
) -> None:
    """Say how many landings the flights hold, and the time it took to tell.

    Without ``seconds`` they came with the parse, from the cache or not.
    """
    took = "with the parse" if seconds is None else f"in {seconds:.1f} s"
    logger.info(
        "  Found %d landing(s) and %d touch-and-go(es) in %d flight(s) %s",
        sum(landings.landings for landings in found.values()),
        sum(landings.touch_and_goes for landings in found.values()),
        len(found),
        took,
    )
