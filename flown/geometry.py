"""Geometric calculations and coordinate manipulations.

The constants and the small distance functions several modules share live
here, each with the exact value and formula its callers used before they
were shared, so that no exported number moves.
"""

from bisect import bisect_left, bisect_right
from collections import deque
from dataclasses import dataclass
from itertools import pairwise
from math import atan2, cos, degrees, hypot, log, pi, radians, sin, sqrt, tan
from typing import TYPE_CHECKING, Protocol

from .constants import FEET_TO_METERS, KM_TO_NAUTICAL_MILES, SECONDS_PER_HOUR

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Sequence

    from .types import TrackPoint

__all__ = [
    "EARTH_RADIUS_KM",
    "KM_PER_DEGREE",
    "MAX_LATITUDE",
    "METRES_PER_DEGREE",
    "SPEED_HALF_WINDOW_SECONDS",
    "SPEED_MAX_SECONDS",
    "SPEED_MIN_SECONDS",
    "TERRAIN_MAX_LATITUDE",
    "CoordinateExtent",
    "haversine_distance",
    "heading_difference",
    "longitude_difference",
    "planar_km",
    "planar_metres",
    "trim_path_ends",
    "trim_span",
    "true_bearing",
    "web_mercator",
    "window_knots",
]

EARTH_RADIUS_KM = 6371
# A degree of latitude on the sphere above, for the grids the airports and
# the recordings of a flight are indexed in
KM_PER_DEGREE = radians(EARTH_RADIUS_KM)
# A degree of latitude as the frontend measures distances along a path
# (calculations/groundProfile.ts), and as the landing detector does: a
# round figure rather than the sphere's, kept so the ground and the
# landings the site carries stay as they are
METRES_PER_DEGREE = 111_320.0
# Where Web Mercator ends, in a square: the latitude of the top and bottom
# edges of the world at every zoom, which the link previews clamp to
MAX_LATITUDE = 85.051129
# The rounder figure the elevation sampling has always clamped to (terrain):
# a few metres short of the edge, so a point beyond it samples the top row
# of pixels as before and the ground the site carries stays the same
TERRAIN_MAX_LATITUDE = 85.0511


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate great circle distance in kilometers between two points."""
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    a = min(1.0, max(0.0, a))
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return EARTH_RADIUS_KM * c


# Groundspeeds are measured over this long on either side of a fix (see
# window_knots), and a measurement over less or more time than the bounds
# below is none: jitter, or a gap in the recording
SPEED_HALF_WINDOW_SECONDS = 5.0
SPEED_MIN_SECONDS = 2.0
SPEED_MAX_SECONDS = 120.0

# --trim-ends anchors the trim on the flight itself where the times tell
# it: the stretches at a groundspeed of at least TRIM_FLIGHT_KNOTS, a takeoff
# roll passes it and taxiing never does (see window_knots). A takeoff climbs
# TRIM_CLIMB_M above where its stretch began within TRIM_CLIMB_SECONDS, a
# landing sinks as much to where its stretch ended; a drive along a road
# does neither as fast. A stretch that runs from the first fix or on to the
# last for TRIM_MOVING_SECONDS was recorded on the move (in the air, or on
# the road), so the times do not tell that end; a shorter one is a stale fix
# jumping to the receiver's own.
# The start of a takeoff roll lies less than TRIM_FIELD_M above the lowest
# heights recorded before it (TRIM_LOW_SHARE of them, so a stray fix does
# not count), the field: a glider circling level after its launch, a
# helicopter hovering or an ultralight's slow climb out sit above the field
# they rose from, while a home or an apron above the field, or a height the
# receiver had wrong while it warmed up, do not lower it.
TRIM_FLIGHT_KNOTS = 40.0
TRIM_FIELD_M = 30.0
TRIM_LOW_SHARE = 0.05
TRIM_CLIMB_M = 300 * FEET_TO_METERS
TRIM_CLIMB_SECONDS = 180.0
TRIM_MOVING_SECONDS = 30.0


class _Located(Protocol):
    """A fix with a position: a track point, or one the landings read."""

    @property
    def lat(self) -> float: ...

    @property
    def lon(self) -> float: ...


def window_knots(
    fixes: Sequence[_Located],
    times: Sequence[float],
    km: Callable[[float, float, float, float], float],
) -> list[float | None]:
    """The groundspeed at each of ``fixes``, at ``times`` in order.

    Measured from the last fix ``SPEED_HALF_WINDOW_SECONDS`` or more before
    it to the first as far after it, ``km`` apart: loggers write fixes a
    fraction of a second apart as often as seconds apart, and the jitter of
    the position over a fraction of a second reads as hundreds of knots.
    None where it cannot be told.
    """
    last = len(fixes) - 1
    speeds: list[float | None] = []
    for t in times:
        before = bisect_right(times, t - SPEED_HALF_WINDOW_SECONDS) - 1
        after = bisect_left(times, t + SPEED_HALF_WINDOW_SECONDS)
        seconds = times[min(last, after)] - times[max(0, before)]
        if not SPEED_MIN_SECONDS <= seconds <= SPEED_MAX_SECONDS:
            speeds.append(None)
            continue
        a, b = fixes[max(0, before)], fixes[min(last, after)]
        distance = km(a.lat, a.lon, b.lat, b.lon)
        speeds.append(distance * KM_TO_NAUTICAL_MILES / seconds * SECONDS_PER_HOUR)
    return speeds


def _gains_quickly(heights: Sequence[tuple[float, float]]) -> bool:
    """Whether ``heights`` (time, height) gain ``TRIM_CLIMB_M`` within
    ``TRIM_CLIMB_SECONDS`` anywhere: the lowest height of the window so
    far, kept in a queue of rising heights."""
    window: deque[tuple[float, float]] = deque()
    for t, height in heights:
        while window and window[0][0] < t - TRIM_CLIMB_SECONDS:
            window.popleft()
        if window and height - window[0][1] >= TRIM_CLIMB_M:
            return True
        while window and window[-1][1] >= height:
            window.pop()
        window.append((t, height))
    return False


def _level(heights: Sequence[float]) -> float | None:
    """The height ``heights`` keep (their median) when all but a tenth at
    either end lie within ``TRIM_CLIMB_M`` of each other: the ground of a
    field, where taxiing never climbs. None when they climb or sink, as a
    thermal or a slow climb out does, or for none."""
    if not heights:
        return None
    ordered = sorted(heights)
    cut = len(ordered) // 10
    if ordered[-1 - cut] - ordered[cut] >= TRIM_CLIMB_M:
        return None
    return ordered[len(ordered) // 2]


def _takeoff(
    fixes: Sequence[tuple[int, TrackPoint]],
    speeds: Sequence[float | None],
) -> int | None:
    """Where the takeoff roll of ``fixes`` begins, as a position in them.

    The first stretch of fixes not known to be slow that climbs like a
    takeoff (``_gains_quickly``), from the level ground the slow fixes
    before it waited at for ``TRIM_MOVING_SECONDS`` or more, starting less
    than ``TRIM_FIELD_M`` above the lowest heights recorded before it
    (``TRIM_LOW_SHARE`` of them), and nothing before it higher: what the
    trim then drops was on the ground. A wait in the air (level circling
    after a winch launch, a hover, the top of a slow climb out) is above
    the field it rose from, and so is a field above the home the recording
    began at: both leave the end to the circle. A stretch that climbs
    slower is skipped (a road over a rise), and ends the wait when it
    lasts ``TRIM_MOVING_SECONDS`` (a drive); one that climbs fast but
    follows no such wait (a slow climb out into the wind, a logger that
    froze or lost its height in the air, a thermal) leaves the end to the
    circle, as does a recording that starts on the move. Only the first
    stretch that climbs like a takeoff counts, so what a slow stretch in
    the air splits off later never does.
    """
    heights = [point.alt or 0.0 for _, point in fixes]
    times = [point.ts or 0.0 for _, point in fixes]
    first: int | None = None
    stopped = moving = False
    waited = 0
    for position, speed in enumerate([*speeds, 0.0]):
        slow = speed is not None and speed < TRIM_FLIGHT_KNOTS
        if not slow:
            if speed is not None and first is None:
                first, moving = position, not stopped
            continue
        stopped = True
        if first is None:
            continue
        last, start, first = position - 1, first, None
        if moving:
            # From the first fix: on the move, or a stale fix
            if times[last] - times[0] >= TRIM_MOVING_SECONDS:
                return None
            waited = position
            continue
        ground = _level(heights[waited:start])
        long_enough = times[start - 1] - times[waited] >= TRIM_MOVING_SECONDS
        stretch = heights[start : last + 1]
        if max(stretch) - heights[start] < TRIM_CLIMB_M or not _gains_quickly(
            list(zip(times[start : last + 1], stretch, strict=True))
        ):
            # A drive ends the wait; a moment over the speed does not, as a
            # takeoff roll that dips below it for a fix (42, 38, 57 kn) has
            # one at its start
            if times[last] - times[start] >= TRIM_MOVING_SECONDS:
                waited = position
            continue
        before = sorted(heights[:start])
        low = before[int(len(before) * TRIM_LOW_SHARE)]
        if (
            ground is None
            or not long_enough
            or heights[start] - low >= TRIM_FIELD_M
            or before[-1] - heights[start] >= TRIM_CLIMB_M
        ):
            return None
        return start
    return None


def _flight_span(path: Sequence[TrackPoint]) -> tuple[int | None, int | None]:
    """Where the takeoff roll of a path begins and the landing roll ends.

    As indices of ``path`` (``_takeoff``, and the same for the landing on
    the fixes the other way round). None for an end the times cannot tell:
    a path without times, one that starts or ends on the move, one whose
    times run backwards, one whose ground there is not level.
    """
    fixes = [
        (index, point)
        for index, point in enumerate(path)
        if point.ts is not None and point.alt is not None
    ]
    if len(fixes) < 3 or any(
        (b.ts or 0.0) < (a.ts or 0.0) for (_, a), (_, b) in pairwise(fixes)
    ):
        return None, None
    speeds = window_knots(
        [point for _, point in fixes],
        [point.ts or 0.0 for _, point in fixes],
        haversine_distance,
    )
    start = _takeoff(fixes, speeds)
    # The other way round, with the times running backwards from the end
    end_ts = fixes[-1][1].ts or 0.0
    backwards = [
        (index, point._replace(ts=end_ts - (point.ts or 0.0)))
        for index, point in reversed(fixes)
    ]
    end = _takeoff(backwards, speeds[::-1])
    return (
        None if start is None else fixes[start][0],
        None if end is None else backwards[end][0],
    )


def trim_path_ends(
    path: Sequence[TrackPoint],
    metres: float,
    smoothed: Sequence[TrackPoint] | None = None,
) -> list[TrackPoint]:
    """``path`` without its ground at either end and what is near it.

    Where the times tell where the flight began and ended (``_flight_span``,
    of the path with the glitches of its altitudes ``smoothed`` over, or as
    it is), everything before its takeoff roll and after its landing roll goes,
    whatever it is: the taxiing, the spot the aircraft was parked on, a
    stale fix from before the receiver had its own, a drive to the field or
    home from it. Then, as at an end the times cannot tell, the points
    within ``metres`` of where the rest starts and ends go: what is left
    begins with the first point that is farther from its first point, and
    ends with the last that is farther from its last. A path that never
    leaves the circles (a recording of a taxi) is left with its first point
    alone, which the export leaves out as a path that does not move: kept
    whole, it would publish the spot. The points left are those of
    ``trim_span``.
    """
    return list(path[trim_span(path, metres, smoothed)])


def trim_span(
    path: Sequence[TrackPoint],
    metres: float,
    smoothed: Sequence[TrackPoint] | None = None,
) -> slice:
    """The points of ``path`` that ``trim_path_ends`` keeps, as a slice.

    It cuts ``smoothed`` alike, which has the points of ``path`` in their
    order.
    """
    if metres <= 0 or len(path) < 2:
        return slice(0, len(path))
    takeoff, landing = _flight_span(path if smoothed is None else smoothed)
    first_index = 0 if takeoff is None else takeoff
    last_index = len(path) - 1 if landing is None else landing
    offset = 0
    if last_index - first_index >= 1:
        path = path[first_index : last_index + 1]
        offset = first_index
    km = metres / 1000
    first, last = path[0], path[-1]
    start = next(
        (
            index
            for index, point in enumerate(path)
            if haversine_distance(first.lat, first.lon, point.lat, point.lon) > km
        ),
        len(path),
    )
    end = next(
        (
            index
            for index in range(len(path) - 1, -1, -1)
            if haversine_distance(last.lat, last.lon, path[index].lat, path[index].lon)
            > km
        ),
        -1,
    )
    if end - start < 1:
        return slice(offset, offset + 1)
    return slice(offset + start, offset + end + 1)


def longitude_difference(lon0: float, lon1: float) -> float:
    """``lon1 - lon0`` the short way round, from -180 to 180 degrees."""
    difference = (lon1 - lon0 + 180) % 360 - 180
    # A sum just below a multiple of 360 rounds up to it, and leaves 180
    return -180.0 if difference >= 180 else difference


def heading_difference(a: float, b: float) -> float:
    """The angle between two headings, 0 to 180 degrees."""
    return abs(longitude_difference(a, b))


def planar_km(lat0: float, lon0: float, lat1: float, lon1: float) -> float:
    """Distance in km on a plane tangent at the first point; fine for 10 km.

    The short way round across the antimeridian. What the landing detector
    measures the fixes of a flight with.
    """
    dx = longitude_difference(lon0, lon1) * cos(radians(lat0))
    return hypot(dx, lat1 - lat0) * METRES_PER_DEGREE / 1000


def planar_metres(lat0: float, lon0: float, lat1: float, lon1: float) -> float:
    """Distance in metres on a plane at the middle latitude of the two points.

    The short way round across the antimeridian, and the formula the
    frontend measures the metres flown along a path with (alongMetres in
    calculations/groundProfile.ts), so that the ground the build samples
    shifts between the fields as the page's own ground does. Not to the
    bit: CPython's and V8's hypot differ in the last bit for a third of all
    inputs, far below the 10 ft the year file stores the ground in.
    """
    dlon = longitude_difference(lon0, lon1)
    return hypot(
        dlon * METRES_PER_DEGREE * cos(radians((lat0 + lat1) / 2)),
        (lat1 - lat0) * METRES_PER_DEGREE,
    )


def true_bearing(lat0: float, lon0: float, lat1: float, lon1: float) -> float:
    """True bearing from the first point to the second, in degrees.

    On a plane, which is close enough for points a few kilometres apart (the
    ends of a runway, the last half minute of an approach), and the short
    way round across the antimeridian.
    """
    dx = longitude_difference(lon0, lon1) * cos(radians((lat0 + lat1) / 2))
    return degrees(atan2(dx, lat1 - lat0)) % 360


def web_mercator(lat: float, lon: float) -> tuple[float, float]:
    """A point in Web Mercator, as fractions of the world from 0 to 1.

    x runs east from the antimeridian, y south from the top edge. A
    latitude beyond ``MAX_LATITUDE`` is clamped to the edge.
    """
    phi = radians(max(-MAX_LATITUDE, min(MAX_LATITUDE, lat)))
    return (
        (lon + 180.0) / 360.0,
        (1.0 - log(tan(pi / 4 + phi / 2)) / pi) / 2.0,
    )


@dataclass(frozen=True)
class CoordinateExtent:
    """Bounding box of a set of coordinates.

    Plain minimum and maximum, also for data on both sides of the
    antimeridian: the map draws every path, marker and heat point at its own
    longitude, not where it would be nearest to the others, so a box that
    wrapped around 180 (179 to 181) would open the map on half of the
    flights.
    """

    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float

    @classmethod
    def of(cls, coordinates: Iterable[TrackPoint]) -> CoordinateExtent | None:
        """The extent of the coordinates, or None when there are none."""
        points = list(coordinates)
        if not points:
            return None
        return cls(
            min(point.lat for point in points),
            max(point.lat for point in points),
            min(point.lon for point in points),
            max(point.lon for point in points),
        )
