"""Segment calculation for path data with groundspeed and altitude analysis.

Groundspeed uses a two-pass approach: instantaneous speeds for all segments,
then rolling window averages for smoothing. The window keeps running totals
of distance and time over the segments sorted by time, so each lookup is a
binary search and two subtractions, whatever the width of the window.
Timestamps are Unix epoch seconds that were parsed once by the KML parser.

A groundspeed that cannot be measured, or that is implausible, is None
(unknown), never 0: a 0 would read as standing still.
"""

from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from itertools import accumulate, pairwise
from typing import TYPE_CHECKING

from .constants import (
    KM_TO_NAUTICAL_MILES,
    MAX_GROUNDSPEED_KNOTS,
    MIN_SEGMENT_TIME_SECONDS,
    SECONDS_PER_HOUR,
    SPEED_WINDOW_SECONDS,
)
from .geometry import haversine_distance

if TYPE_CHECKING:
    from .types import FlightPath

__all__ = [
    "SegmentSpeed",
    "SpeedWindow",
    "calculate_fallback_groundspeed",
    "extract_segment_speeds",
    "outlasts_the_window",
]


@dataclass(slots=True)
class SegmentSpeed:
    """Instantaneous speed information for one path segment.

    ``valid`` marks a segment whose speed is a measurement: both points are
    timed, the time delta is usable and the speed plausible. Only valid
    segments enter the rolling window, including the ones where the aircraft
    stood still (speed 0), because their time counts toward the average.
    ``speed`` is None for every other segment.

    A segment of less than ``MIN_SEGMENT_TIME_SECONDS`` says nothing on its
    own, but its distance was flown: it is ``carried_distance`` (and
    ``carried_time``) of the next segment that is measured, which the speed
    and the window count with its own, unless the two together are faster
    than any aircraft (a position jump among the short segments).
    """

    timestamp: float | None
    relative_time: float | None
    speed: float | None
    distance: float
    time_delta: float
    valid: bool = False
    carried_distance: float = 0.0
    carried_time: float = 0.0


def _knots(distance_km: float, seconds: float) -> float:
    """The groundspeed of ``distance_km`` flown in ``seconds``."""
    return distance_km * KM_TO_NAUTICAL_MILES / seconds * SECONDS_PER_HOUR


def extract_segment_speeds(
    path: FlightPath, path_start_time: float | None
) -> list[SegmentSpeed]:
    """Calculate instantaneous speeds for all segments in a path.

    The distances of the segments add up to the length of the path, so a
    caller that needs it sums them instead of computing each one twice.
    Loggers that write a fix twice under one time, or fixes a hundredth of
    a second apart, leave segments too short to measure: their distance
    goes to the next one that is measured (see ``SegmentSpeed``), as left
    out it took the groundspeed of such a track down to half.
    """
    segment_speeds: list[SegmentSpeed] = []
    # The distance and time of the short segments since the last measured one
    pending_km = pending_seconds = 0.0

    for p1, p2 in pairwise(path):
        segment_distance_km = haversine_distance(p1.lat, p1.lon, p2.lat, p2.lon)

        instant_speed: float | None = None
        timestamp = None
        time_delta = 0.0
        relative_time = None
        valid = False
        carried_km = carried_seconds = 0.0

        if p1.ts is not None and p2.ts is not None:
            time_delta = p2.ts - p1.ts
            timestamp = p1.ts

            if path_start_time is not None:
                relative_time = p1.ts - path_start_time

            if time_delta >= MIN_SEGMENT_TIME_SECONDS:
                carried_km, carried_seconds = pending_km, pending_seconds
                speed = _knots(
                    segment_distance_km + carried_km, time_delta + carried_seconds
                )
                if speed > MAX_GROUNDSPEED_KNOTS and carried_km:
                    # The short segments were a position jump (a logger that
                    # froze and caught up at once): the segment on its own
                    carried_km = carried_seconds = 0.0
                    speed = _knots(segment_distance_km, time_delta)
                # An implausible speed (a position jump) is no measurement
                valid = speed <= MAX_GROUNDSPEED_KNOTS
                if valid:
                    instant_speed = speed
                pending_km = pending_seconds = 0.0
            elif time_delta >= 0:
                pending_km += segment_distance_km
                pending_seconds += time_delta
            else:
                pending_km = pending_seconds = 0.0
        else:
            pending_km = pending_seconds = 0.0

        segment_speeds.append(
            SegmentSpeed(
                timestamp=timestamp,
                relative_time=relative_time,
                speed=instant_speed,
                distance=segment_distance_km,
                time_delta=time_delta,
                valid=valid,
                carried_distance=carried_km,
                carried_time=carried_seconds,
            )
        )

    return segment_speeds


def outlasts_the_window(segment: SegmentSpeed) -> bool:
    """Whether a segment lasts longer than ``SPEED_WINDOW_SECONDS``.

    Such a segment is a gap in the recording (a logger paused, a lost fix)
    or a logger that writes a fix every few minutes. It stays out of the
    window (see ``SpeedWindow``), where it would outweigh the minute around
    it.
    """
    return segment.time_delta > SPEED_WINDOW_SECONDS


class SpeedWindow:
    """Rolling window averages of groundspeed over the valid segments.

    Only valid segments take part (see ``SegmentSpeed``). A segment where
    the aircraft stood still is valid: leaving it out made the window
    average the speed of the moving time only, so a minute of holding
    followed by a minute at 100 kt averaged to 100 kt instead of 50.

    A segment longer than the window stays out (``outlasts_the_window``): a
    window holds the segments that start in it with all of their time, so
    a 30-minute pause after flying at 100 kt took the groundspeed of the
    minute before it down to a few knots.

    The segments are sorted by time and their distances and durations kept
    as running totals, so the sums over any window are two subtractions.
    Summing each window anew took time proportional to its width for every
    segment.
    """

    __slots__ = ("_distance_totals", "_time_totals", "timestamps")

    def __init__(self, segment_speeds: list[SegmentSpeed]) -> None:
        """Index the valid, timed segments of a path."""
        timed = sorted(
            (
                seg
                for seg in segment_speeds
                if seg.valid
                and seg.timestamp is not None
                and not outlasts_the_window(seg)
            ),
            key=lambda seg: seg.timestamp or 0.0,
        )
        self.timestamps = [seg.timestamp for seg in timed if seg.timestamp is not None]
        self._distance_totals = list(
            accumulate(
                (seg.distance + seg.carried_distance for seg in timed), initial=0.0
            )
        )
        self._time_totals = list(
            accumulate(
                (seg.time_delta + seg.carried_time for seg in timed), initial=0.0
            )
        )

    def __len__(self) -> int:
        """The number of segments in the window index."""
        return len(self.timestamps)

    def totals(self, current_timestamp: float) -> tuple[float, float]:
        """Distance (km) and time (s) of the segments around a timestamp.

        The window is ``SPEED_WINDOW_SECONDS`` wide and centered on
        ``current_timestamp``; it holds the segments that start within it.
        """
        half_window = SPEED_WINDOW_SECONDS / 2
        start = bisect_left(self.timestamps, current_timestamp - half_window)
        end = bisect_right(self.timestamps, current_timestamp + half_window)
        return (
            self._distance_totals[end] - self._distance_totals[start],
            self._time_totals[end] - self._time_totals[start],
        )

    def groundspeed(self, current_timestamp: float) -> float | None:
        """The average groundspeed in knots around a timestamp.

        None (unknown) when the window holds too little time or its average
        is implausible.
        """
        if not self.timestamps:
            return None
        window_distance, window_time = self.totals(current_timestamp)
        if window_time < MIN_SEGMENT_TIME_SECONDS:
            return None
        window_distance_nm = window_distance * KM_TO_NAUTICAL_MILES
        groundspeed_knots = (window_distance_nm / window_time) * SECONDS_PER_HOUR
        if groundspeed_knots > MAX_GROUNDSPEED_KNOTS:
            return None
        return groundspeed_knots


def calculate_fallback_groundspeed(
    segment_distance_km: float, path_distance_km: float, path_duration_seconds: float
) -> float | None:
    """Groundspeed from path averages when timestamps are unavailable.

    None (unknown) when the path has no duration or distance, or the result
    would be implausible.
    """
    if path_duration_seconds <= 0 or path_distance_km <= 0:
        return None

    segment_time_seconds = (
        segment_distance_km / path_distance_km
    ) * path_duration_seconds

    if segment_time_seconds < MIN_SEGMENT_TIME_SECONDS:
        return None

    segment_distance_nm = segment_distance_km * KM_TO_NAUTICAL_MILES
    calculated_speed = (segment_distance_nm / segment_time_seconds) * SECONDS_PER_HOUR

    if 0 < calculated_speed <= MAX_GROUNDSPEED_KNOTS:
        return calculated_speed

    return None
