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

from collections.abc import Callable
from itertools import pairwise
from statistics import median_low
from typing import TYPE_CHECKING

from .geometry import haversine_distance

if TYPE_CHECKING:
    from collections.abc import Sequence

__all__ = [
    "SPIKE_MIN_KM",
    "SPIKE_STEP_FACTOR",
    "distance_spikes",
    "run_spikes",
    "spike_limit",
]

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
