"""The wire format of the exported segment rows.

A year file is by far the largest thing the page downloads, and it used to
be plain JSON floats: about 41 bytes for every row of
``[lat, lon, altitude_ft, groundspeed_knots, time?]``. Three properties of
the data make that wasteful. Every value is already rounded to a fixed
number of decimals by the exporter, so it is an integer in disguise;
consecutive rows are contiguous and slow-moving, so the difference between
neighbours is far smaller than the value itself; and those differences
repeat within a column (a steady climb, a constant speed) far more than
across one.

Encoding therefore scales each column to an integer, stores the difference
to the previous row, and writes a path column by column rather than row by
row, which puts the repeating differences next to each other for gzip. The
format is lossless for the values the exporter produces: every column is
scaled by exactly the step it was rounded to, so
``decode_rows(encode_start(start), encode_rows(start, rows)) == rows``,
which ``tests/test_segment_codec.py`` checks over generated data.

Format 4 adds the ground under every row (see ``flown.terrain``), in
feet, as a column of its own beside the others: ``encode_ground``. A path
whose ground is not known has none, and the page falls back to the line
between its airfields.

Format 5 writes the altitudes in steps of 20 ft instead of 100 ft, so a
1000 ft circuit no longer draws as ten stairs, and carries the landings of
every flight in its path info (see ``flown.landings``).

Format 6 writes the groundspeeds in whole knots instead of tenths. The
exporter already rounded them to whole knots, so every speed difference
carried a trailing zero that only cost bytes.

Format 7 writes the coordinates as second differences, the change of the
difference to the row before. An aircraft keeps its course and speed for
many rows, so the step it makes changes far less than it is long. The
other columns gain nothing from it (an altitude or a speed holds still,
and its first difference is already zero; their second differences came
out larger), so they stay first differences. The relative times stay in
tenths: in whole seconds, a segment shorter than the rounding would take
no time, and the heat it carries would change.

Format 8 lays the year file out column by column across all of its paths
instead of path by path. ``segments`` holds ``start``, the start point of
every path, ``columns``, five arrays (one per column above) of every path's
encoded column, and ``ground``, every path's ground column; all of them in
the order of ``path_info``, which carries the ids. A path without relative
times or without ground has null in that array. Written path by path, the
file made gzip switch between five unrelated number streams every few
hundred values; one stream at a time it compresses 7 to 8 % better.
:func:`split_segments` turns the layout back into one entry per path.

``flown/frontend/services/yearDecode.ts`` mirrors ``decode_rows``,
``decode_ground`` and the layout ``split_segments`` reads; the year file
carries ``FORMAT_VERSION`` so the two cannot be mismatched silently.
"""

from typing import TYPE_CHECKING, Any, NotRequired, TypedDict

from .types import COORDINATE_DECIMALS

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .types import SegmentRow

__all__ = [
    "ALTITUDE_STEP",
    "COORDINATE_SCALE",
    "FORMAT_VERSION",
    "GROUND_STEP",
    "SPEED_SCALE",
    "TIME_SCALE",
    "EncodedColumns",
    "PathEntry",
    "decode_ground",
    "decode_rows",
    "encode_ground",
    "encode_rows",
    "encode_start",
    "split_segments",
]

# Bumped whenever the layout below changes, so a page never reads a year
# file written by another release's exporter as if it were its own
FORMAT_VERSION = 8

# How each column becomes an integer: the step the exporter rounds it to.
# process_path_segments rounds coordinates to COORDINATE_DECIMALS ...
COORDINATE_SCALE = 10**COORDINATE_DECIMALS
# ... altitudes to multiples of 20 ft, which are written in twenties ...
ALTITUDE_STEP = 20
# ... groundspeeds to whole knots (see export_pipeline.exported_knots) ...
SPEED_SCALE = 1
# ... and relative times to one decimal
TIME_SCALE = 10
# The ground is written in steps of 10 ft: the altitudes above it are
# rounded to 20 ft, and a finer ground would only cost bytes
GROUND_STEP = 10

# Column order of a decoded row, and of the encoded columns
LAT, LON, ALTITUDE, SPEED, TIME = range(5)
# The divisor of each column but the altitude, which is multiplied instead
_SCALES = (COORDINATE_SCALE, COORDINATE_SCALE, 1, SPEED_SCALE, TIME_SCALE)
# The columns written as second differences (see format 7 above)
_SECOND_ORDER = (LAT, LON)

# The encoded columns of a path: lat, lon, altitude and speed, then the
# relative time when any row has one. A row without a time has None there.
EncodedColumns = list[list[int | None]]


class PathEntry(TypedDict):
    """One path of a year file's ``segments``, see :func:`split_segments`."""

    start: list[int]
    columns: EncodedColumns
    ground: NotRequired[list[int]]


def encode_start(start: Sequence[float]) -> list[int]:
    """Scale a path's start point to integers."""
    return [round(value * COORDINATE_SCALE) for value in start]


def _scale(row: SegmentRow) -> list[int | None]:
    altitude = row[ALTITUDE]
    if altitude % ALTITUDE_STEP:
        # The format counts in steps; refuse to lose the rest silently
        msg = f"altitude {altitude} is not a multiple of {ALTITUDE_STEP} ft"
        raise ValueError(msg)
    if row[SPEED] * SPEED_SCALE % 1:
        msg = f"groundspeed {row[SPEED]} is not a whole number of knots"
        raise ValueError(msg)
    return [
        round(row[LAT] * COORDINATE_SCALE),
        round(row[LON] * COORDINATE_SCALE),
        round(altitude / ALTITUDE_STEP),
        round(row[SPEED] * SPEED_SCALE),
        round(row[TIME] * TIME_SCALE) if len(row) > TIME else None,
    ]


def encode_rows(start: Sequence[float], rows: Sequence[SegmentRow]) -> EncodedColumns:
    """Scale every column to an integer and store differences, per column.

    ``start`` seeds the coordinate columns, so the first row is a difference
    like every other one. The remaining columns start from zero.

    The coordinates are second differences: what is written is how much the
    difference to the row before changed, and the difference before the
    first row counts as zero.

    The time column is left out when no row has a relative time. A row
    without one holds None in it, and the next time is a difference to the
    last row that had one, so a gap does not shift the rows after it.
    """
    previous = [*encode_start(start), 0, 0, 0] if start else [0] * 5
    # The last difference of each coordinate column
    step = [0, 0]
    columns: EncodedColumns = [[] for _ in range(5)]
    for row in rows:
        for column, value in enumerate(_scale(row)):
            if value is None:
                columns[column].append(None)
                continue
            difference = value - previous[column]
            if column in _SECOND_ORDER:
                columns[column].append(difference - step[column])
                step[column] = difference
            else:
                columns[column].append(difference)
            previous[column] = value
    if all(value is None for value in columns[TIME]):
        del columns[TIME]
    return columns


def _unscale(column: int, value: int) -> float:
    if column == ALTITUDE:
        return float(value * ALTITUDE_STEP)
    # Dividing by the scale gives the float nearest to the decimal, exactly
    # what round() produced on the way in
    return value / _SCALES[column]


def decode_rows(
    start: Sequence[int], columns: Sequence[Sequence[int | None]]
) -> list[SegmentRow]:
    """Undo :func:`encode_rows`. The mirror of the frontend's decoder."""
    previous = [start[LAT] if start else 0, start[LON] if start else 0, 0, 0, 0]
    step = [0, 0]
    rows: list[SegmentRow] = []
    for deltas in zip(*columns, strict=True):
        row: SegmentRow = []
        for column, difference in enumerate(deltas):
            if difference is None:
                continue
            if column in _SECOND_ORDER:
                step[column] += difference
                previous[column] += step[column]
            else:
                previous[column] += difference
            row.append(_unscale(column, previous[column]))
        rows.append(row)
    return rows


def encode_ground(ground: Sequence[float]) -> list[int]:
    """The ground column of a path: feet in ``GROUND_STEP``, as differences.

    The first value is a difference to zero. The ground changes slowly along
    a flight, so most differences are one or two digits.
    """
    column: list[int] = []
    previous = 0
    for feet in ground:
        if feet % GROUND_STEP:
            msg = f"ground {feet} is not a multiple of {GROUND_STEP} ft"
            raise ValueError(msg)
        value = round(feet / GROUND_STEP)
        column.append(value - previous)
        previous = value
    return column


def decode_ground(column: Sequence[int]) -> list[float]:
    """Undo :func:`encode_ground`. The mirror of the frontend's decoder."""
    ground: list[float] = []
    value = 0
    for difference in column:
        value += difference
        ground.append(float(value * GROUND_STEP))
    return ground


def split_segments(year_file: dict[str, Any]) -> dict[int, PathEntry]:
    """The ``segments`` of a parsed year file, one entry per path id.

    Undoes the layout of format 8: the arrays of ``segments`` hold one
    entry per path in the order of ``path_info``. A path's columns are what
    :func:`encode_rows` returned for it, without the time column when it has
    no relative times, and its ground is left out when it has none.
    """
    segments = year_file["segments"]
    paths: dict[int, PathEntry] = {}
    for index, info in enumerate(year_file["path_info"]):
        columns = [column[index] for column in segments["columns"]]
        entry: PathEntry = {
            "start": segments["start"][index],
            "columns": columns if columns[TIME] is not None else columns[:TIME],
        }
        if segments["ground"][index] is not None:
            entry["ground"] = segments["ground"][index]
        paths[info["id"]] = entry
    return paths
