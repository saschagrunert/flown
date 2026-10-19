"""The reading side of the year files' format, for the tests.

``flown.segment_codec`` writes the format and the page reads it
(``flown/frontend/services/yearDecode.ts``); the package itself never
decodes a year file. These mirror the frontend's decoder in Python, so the
tests can check what the exporter wrote: ``decode_rows`` undoes
``encode_rows``, ``decode_ground`` undoes ``encode_ground`` and
``split_segments`` undoes the layout of format 8.
"""

from typing import TYPE_CHECKING, Any, NotRequired, TypedDict

from flown.segment_codec import (
    ALTITUDE,
    ALTITUDE_STEP,
    COORDINATE_SCALE,
    GROUND_STEP,
    LAT,
    LON,
    SPEED_SCALE,
    TIME,
    TIME_SCALE,
    EncodedColumns,
)

if TYPE_CHECKING:
    from collections.abc import Sequence

    from flown.types import SegmentRow

# The divisor of each column but the altitude, which is multiplied instead
_SCALES = (COORDINATE_SCALE, COORDINATE_SCALE, 1, SPEED_SCALE, TIME_SCALE)
# The columns written as second differences (see format 7)
_SECOND_ORDER = (LAT, LON)


class PathEntry(TypedDict):
    """One path of a year file's ``segments``, see :func:`split_segments`."""

    start: list[int]
    columns: EncodedColumns
    ground: NotRequired[list[int]]


def _unscale(column: int, value: int) -> float:
    if column == ALTITUDE:
        return float(value * ALTITUDE_STEP)
    # Dividing by the scale gives the float nearest to the decimal, exactly
    # what round() produced on the way in
    return value / _SCALES[column]


def decode_rows(
    start: Sequence[int], columns: Sequence[Sequence[int | None]]
) -> list[SegmentRow]:
    """Undo ``encode_rows``. The mirror of the frontend's decoder."""
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


def decode_ground(column: Sequence[int]) -> list[float]:
    """Undo ``encode_ground``. The mirror of the frontend's decoder."""
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
    ``encode_rows`` returned for it, without the time column when it has
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
