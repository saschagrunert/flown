"""Position spikes: the fixes of a track that are far off the flight.

Some loggers write a position that is far off for a fix or a few: one
coordinate zeroed (latitude 0, 5,000 km south of the flight), a sign
flipped, the stale fixes of the last flight before the receiver has a new
one. Kept, one such fix stretched the map to the equator, put the start of
the flight on another continent and made the duplicate check index its
lines into tens of thousands of cells.

The fixes are split into runs wherever one cannot follow the one before it
(``joined``: too fast to get there for a timed track, too far for a line
without times). The longest run is the flight. From it outward, a run that
can follow the last fix kept is kept; one that cannot is a spike, along
with the runs after it up to the next one that can, when they are short
(``spike_limit``): the recording goes on where it was. A short stretch at
either end that nothing after it can follow is a spike as well, when it is
a single fix or far shorter than the rest: the stale fixes before the
receiver had its own. Anything else, a long stretch elsewhere, is a track
that goes on there after a gap, and stays. A line without times only
tells a stale end by a zeroed coordinate: a long last leg is how a route
is drawn, and a recording may go on after an outage.

A single fix is a spike that way wherever it is. More than one only when
they are all ``far`` from the last fix kept: a logger whose clock lags
writes a stretch of the real flight with times too close together, a few
kilometres a second apart, which no aircraft flies, but where it flew.
"""

from bisect import bisect_left
from collections.abc import Callable
from itertools import pairwise
from statistics import median_low
from typing import TYPE_CHECKING

from .constants import MAX_VERTICAL_FT_PER_SECOND
from .geometry import haversine_distance

if TYPE_CHECKING:
    from collections.abc import Sequence

__all__ = [
    "ALTITUDE_GLITCH_SECONDS",
    "ALTITUDE_SPIKE_FT",
    "ALTITUDE_SPIKE_WINDOW",
    "SPIKE_MIN_KM",
    "SPIKE_STEP_FACTOR",
    "SUSTAINED_FT_PER_SECOND",
    "altitude_spikes",
    "distance_spikes",
    "run_spikes",
    "smoothed_altitudes",
    "spike_limit",
]

# An altitude this far from the median of the fixes around it is a glitch
# of the logger (see altitude_spikes)
ALTITUDE_SPIKE_FT = 200.0
ALTITUDE_SPIKE_WINDOW = 7
# A logger that loses its height for longer comes back within this (see
# _glitch_runs): the longest seen, 4 minutes
ALTITUDE_GLITCH_SECONDS = 300.0
# The most a light aircraft climbs or sinks for more than a few seconds,
# 1,500 ft a minute (see _glitch_runs)
SUSTAINED_FT_PER_SECOND = 25.0
# A stretch between two jumps that lasts this long may be one the flight
# flew (see _Stretches), and the most stretches and fixes one glitch spans:
# the longest seen, 12 and 95
_GLITCH_REFERENCE_SECONDS = 30.0
_GLITCH_STRETCHES = 16
_GLITCH_FIXES = 600
# A drift is told over this many seconds, from a fix at most this many
# fixes away (see _Stretches._settled)
_DRIFT_SECONDS = 5.0
_DRIFT_FIXES = 10

# The most fixes a spike holds: ten, or a fiftieth of the track for a long
# one (a minute of stale fixes at one a second in an hour's flight)
_SPIKE_FIXES = 10
_SPIKE_SHARE = 50
# A stretch at an end is stale only when the rest is this many times longer
_END_SHARE = 4
# Without times, a step this many times the usual one, and this long at
# least, leaves the line: a route of a few legs has steps of tens of
# kilometres, a recording one of tens of metres. Nothing tells a glitch
# from an outage on an out-and-back without times, so only a jump no
# light aircraft makes between two fixes counts: a zeroed coordinate is
# thousands of kilometres off
SPIKE_STEP_FACTOR = 100
SPIKE_MIN_KM = 500.0

# Whether the fix of the second index can follow that of the first (always
# the lower one), and whether it is far from it
type Joined = Callable[[int, int], bool]
# Whether the fix of an index may be a stale fix at an end
type Stale = Callable[[int], bool]


def spike_limit(count: int) -> int:
    """The most fixes of a track of ``count`` that make one spike."""
    return max(_SPIKE_FIXES, count // _SPIKE_SHARE)


def _runs(count: int, joined: Joined) -> list[tuple[int, int]]:
    """The first and last index of each run of fixes that follow each other."""
    runs: list[tuple[int, int]] = []
    start = 0
    for index in range(1, count):
        if not joined(index - 1, index):
            runs.append((start, index - 1))
            start = index
    runs.append((start, count - 1))
    return runs


def _walk(
    runs: Sequence[tuple[int, int]],
    last: int,
    joined: Joined,
    far: Joined,
    count: int,
    stale: Stale,
) -> set[int]:
    """The spikes among ``runs``, walked away from the fix ``last``.

    Each run is (the end next to the fixes kept, the far end). ``joined``
    and ``far`` are asked with the lower index first, whichever way the
    walk goes.
    """

    def ordered(test: Joined, a: int, b: int) -> bool:
        return test(min(a, b), max(a, b))

    def fixes(block: Sequence[tuple[int, int]]) -> list[int]:
        return [
            fix
            for near, end in block
            for fix in range(min(near, end), max(near, end) + 1)
        ]

    limit = spike_limit(count)
    spikes: set[int] = set()
    position = 0
    while position < len(runs):
        run = runs[position]
        if ordered(joined, last, run[0]):
            last = run[1]
            position += 1
            continue
        # The runs up to the next one that follows the last fix kept, as long
        # as they are short enough together for a spike
        skipped = 0
        ahead = position
        while (
            ahead < len(runs)
            and not ordered(joined, last, runs[ahead][0])
            and skipped + abs(runs[ahead][1] - runs[ahead][0]) + 1 <= limit
        ):
            skipped += abs(runs[ahead][1] - runs[ahead][0]) + 1
            ahead += 1
        block = fixes(runs[position:ahead])
        resumes = ahead < len(runs) and ordered(joined, last, runs[ahead][0])
        stale_end = (
            ahead == len(runs)
            and (len(block) == 1 or skipped * _END_SHARE <= count - skipped)
            and all(stale(fix) for fix in block)
        )
        off = len(block) == 1 or all(ordered(far, last, fix) for fix in block)
        if block and off and (resumes or stale_end):
            spikes.update(block)
            position = ahead
            continue
        # A long stretch elsewhere, or one along the flight: the track goes
        # on there
        last = run[1]
        position += 1
    return spikes


def run_spikes(
    count: int,
    joined: Joined,
    far: Joined,
    stale: Stale = lambda _: True,
) -> set[int]:
    """The indices of the spikes among ``count`` fixes (see the module).

    ``joined(a, b)`` says whether fix ``b`` can follow fix ``a``, and
    ``far(a, b)`` whether it is far from it, for any ``a < b``, not only
    neighbours. ``stale(a)`` whether fix ``a`` may be a stale fix at an
    end: any of a timed track.
    """
    if count < 3:
        return set()
    runs = _runs(count, joined)
    if len(runs) == 1:
        return set()
    # The longest run, the first of them on a tie
    anchor = max(range(len(runs)), key=lambda r: (runs[r][1] - runs[r][0], -r))
    first, last = runs[anchor]
    return _walk(runs[anchor + 1 :], last, joined, far, count, stale) | _walk(
        [(end, start) for start, end in reversed(runs[:anchor])],
        first,
        joined,
        far,
        count,
        stale,
    )


def altitude_spikes(
    altitudes_ft: Sequence[float], times: Sequence[float] | None = None
) -> list[bool]:
    """Whether each altitude leaps away from those of its neighbours.

    Some loggers write an altitude of 0 now and then, or another that is
    hundreds of feet off, for a fix or two. One is more than
    ``ALTITUDE_SPIKE_FT`` from the median of the ``ALTITUDE_SPIKE_WINDOW``
    fixes around it, which no climb or descent of a light aircraft is. By
    the fixes rather than their times: loggers write a stretch of fixes
    under one time as often as a time per fix, which would read as a climb
    no aircraft makes.

    Near an end of the track, where the window is cut short, the median of
    a steady climb lies fixes away from the fix: a recording of a few
    sparse fixes up a climb read as spikes all but one. There a fix is one
    only when its neighbours in the window agree among themselves, within
    ``ALTITUDE_SPIKE_FT``, and it is that far from their median.

    With the ``times`` of the fixes, a longer glitch is one as well (see
    ``_glitch_runs``).
    """
    half = ALTITUDE_SPIKE_WINDOW // 2
    last = len(altitudes_ft) - 1
    spikes: list[bool] = []
    for index, altitude in enumerate(altitudes_ft):
        if half <= index <= last - half:
            window = sorted(altitudes_ft[index - half : index + half + 1])
            spikes.append(abs(altitude - window[half]) > ALTITUDE_SPIKE_FT)
            continue
        others = sorted(
            [
                *altitudes_ft[max(0, index - half) : index],
                *altitudes_ft[index + 1 : index + half + 1],
            ]
        )
        spikes.append(
            len(others) >= 2
            and others[-1] - others[0] <= ALTITUDE_SPIKE_FT
            and abs(altitude - others[len(others) // 2]) > ALTITUDE_SPIKE_FT
        )
    if times is not None:
        _glitch_runs(altitudes_ft, times, spikes)
    return spikes


def smoothed_altitudes(
    altitudes: Sequence[float], spikes: Sequence[bool]
) -> list[float]:
    """``altitudes`` with each spike on the line between the fixes either
    side of it that are none, by their order, or at the altitude of the
    nearest such fix at an end."""
    kept = [index for index, spike in enumerate(spikes) if not spike]
    smoothed = list(altitudes)
    if not kept:
        return smoothed
    for index, spike in enumerate(spikes):
        if not spike:
            continue
        position = bisect_left(kept, index)
        if position == 0:
            smoothed[index] = altitudes[kept[0]]
        elif position == len(kept):
            smoothed[index] = altitudes[kept[-1]]
        else:
            left, right = kept[position - 1], kept[position]
            share = (index - left) / (right - left)
            smoothed[index] = (
                altitudes[left] + (altitudes[right] - altitudes[left]) * share
            )
    return smoothed


def _glitch_runs(
    altitudes_ft: Sequence[float], times: Sequence[float], spikes: list[bool]
) -> None:
    """Mark the longer glitches of a logger among ``spikes``.

    Some loggers lose their height for a minute or two: it jumps hundreds
    or thousands of feet from one fix to the next, faster than
    ``MAX_VERTICAL_FT_PER_SECOND``, wanders off, often with more such
    jumps, and comes back. Too many fixes for the median, it put a flight
    1,400 ft below the sea and added thousands of feet to its climb.

    The jumps split the fixes into stretches, and the flight flew the
    first and the last of them. Between, it flew a stretch it can have
    flown to from the one it flew before, the stretches between them, and
    a drift at the ends of the two, passed over as a glitch (see
    ``_Stretches.across``). Of the ways from the first to the last, the
    one that leaves the fewest jumps as they are counts, and of those the
    one that keeps the most fixes. Which side of a jump the glitch is on
    is told that way by the stretches around it, not by the jump: of two
    glitches in a row, the jump between them is the largest of all. One
    glitch spans ``_GLITCH_STRETCHES`` and ``_GLITCH_FIXES`` at most, so
    that a logger that jumps at every fix, under times that stand still,
    takes each fix with a few others only.
    """
    smoothed = smoothed_altitudes(altitudes_ft, spikes)

    def jumps(index: int) -> bool:
        step = abs(smoothed[index] - smoothed[index - 1])
        seconds = max(1.0, times[index] - times[index - 1])
        return step > max(ALTITUDE_SPIKE_FT, MAX_VERTICAL_FT_PER_SECOND * seconds)

    starts = [
        0,
        *(index for index in range(1, len(smoothed)) if jumps(index)),
        len(smoothed),
    ]
    if len(starts) < 3:
        return
    for first, stop in _Stretches(smoothed, times, list(pairwise(starts))).glitches():
        for index in range(first, stop):
            spikes[index] = True


class _Stretches:
    """The stretches of fixes between the jumps of an altitude, each as
    its first fix and the one past its last (see ``_glitch_runs``)."""

    def __init__(
        self,
        altitudes: Sequence[float],
        times: Sequence[float],
        stretches: list[tuple[int, int]],
    ) -> None:
        self.altitudes = altitudes
        self.times = times
        self.stretches = stretches
        # Only a stretch that lasts _GLITCH_REFERENCE_SECONDS is one the
        # flight can be told by: a logger that lost its height writes a few
        # fixes at whatever height between its jumps
        self.told = [
            stretch in {0, len(stretches) - 1}
            or times[stop - 1] - times[first] >= _GLITCH_REFERENCE_SECONDS
            for stretch, (first, stop) in enumerate(stretches)
        ]
        # The fixes where each such stretch settles from its start and from
        # its end (see _settled)
        self.settled = [
            (self._settled(first, stop, 1), self._settled(first, stop, -1))
            if told
            else (first, stop - 1)
            for told, (first, stop) in zip(self.told, stretches, strict=True)
        ]

    def _settled(self, first: int, stop: int, direction: int) -> int:
        """Where the stretch from ``first`` to before ``stop`` settles, from
        its start (``direction`` 1) or its end (-1).

        A logger that lost its height may drift off before it jumps, or back
        after it jumps back: within ``MAX_VERTICAL_FT_PER_SECOND`` from one
        fix to the next, but at more than ``SUSTAINED_FT_PER_SECOND`` for
        ``_DRIFT_SECONDS``, which no light aircraft keeps up for long. Such a
        drift at an end is part of the glitch next to it, as far as halfway
        along the stretch.
        """
        middle = (first + stop - 1) // 2
        index = first if direction > 0 else stop - 1
        while index != middle:
            # The first fix _DRIFT_SECONDS on, within _DRIFT_FIXES
            other = next(
                (
                    other
                    for other in range(
                        index + direction,
                        index + direction * (_DRIFT_FIXES + 1),
                        direction,
                    )
                    if first <= other < stop
                    and abs(self.times[other] - self.times[index]) >= _DRIFT_SECONDS
                ),
                None,
            )
            if other is None or abs(
                self.altitudes[other] - self.altitudes[index]
            ) <= SUSTAINED_FT_PER_SECOND * abs(self.times[other] - self.times[index]):
                break
            index += direction
        return index

    def across(self, before: int, after: int) -> bool:
        """Whether the flight can have flown from stretch ``before`` to
        ``after``, the stretches between them glitches.

        From where the one settles to where the other does, within
        ``ALTITUDE_GLITCH_SECONDS``, at no more than
        ``SUSTAINED_FT_PER_SECOND``. Not under one time: fixes whose times
        stand still say nothing of how fast, and a few of a flight written
        so, each a jump from the next, read as a glitch from its field to
        its field. A stretch between them that lasts as
        long as one the flight is told by lies on one side of the line it
        takes, as a glitch does: one that crosses the line climbs and sinks
        with the flight.
        """
        altitudes = self.altitudes
        start, end = self.settled[before][1], self.settled[after][0]
        seconds = self.times[end] - self.times[start]
        if not 0 < seconds <= ALTITUDE_GLITCH_SECONDS or abs(
            altitudes[end] - altitudes[start]
        ) > max(ALTITUDE_SPIKE_FT, SUSTAINED_FT_PER_SECOND * seconds):
            return False
        slope = (altitudes[end] - altitudes[start]) / (end - start)
        for stretch in range(before + 1, after):
            if not self.told[stretch]:
                continue
            first, stop = self.stretches[stretch]
            offs = [
                altitudes[index] - altitudes[start] - slope * (index - start)
                for index in range(first, stop)
            ]
            if not (all(off > 0 for off in offs) or all(off < 0 for off in offs)):
                return False
        return True

    def glitches(self) -> list[tuple[int, int]]:
        """The runs of fixes the flight did not fly, each as its first fix
        and the one past its last."""
        stretches, settled = self.stretches, self.settled
        # For the way to each stretch: the jumps it leaves as they are, the
        # fixes it keeps, the stretch it came from, and whether it passed
        # over a glitch from there
        left = [0] * len(stretches)
        kept = [stretches[0][1]] * len(stretches)
        came_from = [-1] * len(stretches)
        passed = [False] * len(stretches)
        for after in range(1, len(stretches)):
            first, stop = stretches[after]
            left[after] = left[after - 1] + 1
            kept[after] = kept[after - 1] + stop - first
            came_from[after] = after - 1
            if not self.told[after]:
                continue
            # From the stretch before, the glitch is a drift at their ends
            for before in range(after - 1, max(-1, after - 2 - _GLITCH_STRETCHES), -1):
                if first - stretches[before][1] > _GLITCH_FIXES:
                    break
                if not self.told[before] or not self.across(before, after):
                    continue
                fixes = (
                    kept[before]
                    - (stretches[before][1] - 1 - settled[before][1])
                    + stop
                    - settled[after][0]
                )
                if (left[before], -fixes) < (left[after], -kept[after]):
                    left[after], kept[after] = left[before], fixes
                    came_from[after], passed[after] = before, True
        runs: list[tuple[int, int]] = []
        after = len(stretches) - 1
        while after > 0:
            if passed[after]:
                runs.append((settled[came_from[after]][1] + 1, settled[after][0]))
            after = came_from[after]
        return runs


def distance_spikes(points: Sequence[tuple[float, float]]) -> set[int]:
    """The spikes among (lat, lon) points without times.

    A step is too long to follow when it is ``SPIKE_STEP_FACTOR`` times the
    usual step of the line (the median) and ``SPIKE_MIN_KM`` at least, and
    a point that far is far. A line of a few long legs, as a route is
    drawn, has no such step. At an end, only a point with a zeroed
    coordinate is stale: the last leg of a route may be far longer than the
    others, and a recording may go on after an outage.
    """
    if len(points) < 3:
        return set()
    steps = [haversine_distance(a[0], a[1], b[0], b[1]) for a, b in pairwise(points)]
    reach = max(SPIKE_STEP_FACTOR * median_low(steps), SPIKE_MIN_KM)

    def joined(a: int, b: int) -> bool:
        return (
            haversine_distance(points[a][0], points[a][1], points[b][0], points[b][1])
            <= reach
        )

    return run_spikes(
        len(points),
        joined,
        lambda a, b: not joined(a, b),
        lambda a: points[a][0] == 0 or points[a][1] == 0,
    )
