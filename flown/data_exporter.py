"""Data export of the flights for the site.

Exports flight data to JSON files for the browser frontend:
- <year>/data.json: per-year path info and segments
- airports.json: deduplicated airport locations
- metadata.json: years, year file sizes, the groundspeed range, the aircraft
  models and the countries it carries a flag for (``available_flags``)

The frontend computes every flight statistic from the year files, so the
export keeps no statistics of its own beyond the groundspeed range.

The work is split into chunks that run in parallel: a year with many paths is
cut into several chunks so that the export scales with the number of CPU
cores even when there are only one or two years. Each worker writes its share
of the year file as JSON fragments and returns its counts and groundspeed
range instead of the segments themselves; the main process concatenates the
fragments into the year file without parsing them.

Path ids are derived from the path content (see ``path_content``) in the
main process, before the work is chunked. They end up in shared links and in
the saved state of the frontend, so a re-export has to keep the id of every
flight that is still there, whatever was added or removed around it. Within a
year file the paths keep the input order.

The files are written into the staging directories of a ``SiteOutput`` (see
``site_output``), which publishes them all at once.
"""

import json
import math
import shutil
from array import array
from concurrent.futures import (
    FIRST_COMPLETED,
    Executor,
    Future,
    wait,
)
from concurrent.futures.process import BrokenProcessPool
from contextlib import ExitStack
from dataclasses import dataclass, field
from pathlib import Path
from typing import IO, TYPE_CHECKING, Any, cast

from .aircraft import resolve_aircraft_models
from .cache import atomic_write
from .duplicates import drop_overlapping_paths
from .exceptions import FlownError
from .export_pipeline import (
    build_path_info,
    path_duration,
    process_path_segments,
    without_altitude_spikes,
)
from .export_writers import (
    export_airports_data,
    export_metadata,
    exported_airport_names,
)
from .landings import detect_landings, log_landings
from .logger import logger
from .path_content import (
    assign_path_ids,
    drop_duplicate_paths,
    exported_contents,
    is_exportable_path,
)
from .segment_codec import (
    FORMAT_VERSION,
    SPEED,
    encode_ground,
    encode_rows,
    encode_start,
)
from .site_output import YEAR_FILE
from .terrain import (
    elevations_by_coordinate,
    ground_profile_ft,
    sample_path_elevations,
)
from .types import TrackPoint
from .workers import WorkerPool, default_worker_count

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from .airports import AirportData
    from .landings import FlightLandings
    from .terrain import PointElevations, TileSource
    from .types import FlightPathGroup, PathMetadata, YearFileHeader

__all__ = [
    "MIN_POINTS_PER_CHUNK",
    "ChunkResult",
    "ExportResult",
    "ExportSelection",
    "GroundspeedRange",
    "YearExportResult",
    "export_all_data",
    "export_needs_a_pool",
    "process_year_chunk",
    "select_exported_paths",
]

# A chunk gets at least this many points: a worker process only pays off
# when it has real work to do. Points rather than paths, since the paths of a
# year differ a lot in length (data/ exports about 1,500 points per path, and
# 50 paths a chunk left 14 of 16 workers idle)
MIN_POINTS_PER_CHUNK = 10_000
# Chunks handed to the process pool ahead of time, per worker
MAX_QUEUED_CHUNKS_PER_WORKER = 2
JSON_SEPARATORS = (",", ":")


@dataclass
class GroundspeedRange:
    """The lowest positive and the highest groundspeed of exported rows.

    Only the extremes are kept, and they merge to the same values in any
    order, so the range does not depend on how the years were chunked.
    """

    min_knots: float | None = None
    max_knots: float = 0.0

    def include(self, low: float, high: float) -> None:
        """Widen the range to cover ``low`` and ``high``."""
        self.min_knots = low if self.min_knots is None else min(self.min_knots, low)
        self.max_knots = max(self.max_knots, high)

    def merge(self, other: GroundspeedRange) -> None:
        """Widen the range to cover ``other``."""
        if other.min_knots is not None:
            self.include(other.min_knots, other.max_knots)


@dataclass
class ChunkResult:
    """Result of exporting one chunk of a year (picklable, no segment data)."""

    year: int
    index: int
    path_count: int
    original_points: int
    groundspeed: GroundspeedRange = field(default_factory=GroundspeedRange)


@dataclass
class YearExportResult:
    """Result of exporting one year (picklable, no segment data)."""

    year: int
    path_count: int
    original_points: int
    file_bytes: int
    groundspeed: GroundspeedRange = field(default_factory=GroundspeedRange)


@dataclass
class ExportResult:
    """Everything ``export_all_data`` produced."""

    years: list[int]
    #: The id of every exported path, by its index in the input (see
    #: ``assign_path_ids``), for the link previews
    path_ids: dict[int, int] = field(default_factory=dict)


@dataclass
class ExportSelection:
    """The paths the export publishes (see ``select_exported_paths``)."""

    #: The paths of every year (see ``_group_paths_by_year``), without the
    #: ones dropped as the same flight as another
    paths_by_year: dict[int, list[int]]
    #: The content of every exportable path (see ``exported_contents``),
    #: the dropped ones included
    contents: dict[int, bytes]

    def exported(self) -> list[int]:
        """The indices of the paths that are exported, in input order."""
        return sorted(
            index
            for indices in self.paths_by_year.values()
            for index in indices
            if index in self.contents
        )


def select_exported_paths(
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    exportable: Sequence[bool],
) -> ExportSelection:
    """The paths the export publishes, by year.

    Every exportable path with a year (``exportable`` is
    ``is_exportable_path`` of every path), except a copy of another one
    (``drop_duplicate_paths``) and a second recording of the same flight
    (``drop_overlapping_paths``), each left out with a warning. The map
    extent and the airports are taken from the same paths: a dropped
    recording must neither widen the map nor add an airport.
    """
    paths_by_year = _group_paths_by_year(all_path_metadata, exportable)
    contents = exported_contents(paths_by_year, all_path_groups, exportable)
    paths_by_year = drop_duplicate_paths(
        paths_by_year, contents, all_path_metadata, all_path_groups
    )
    # The same flight in two recordings of their own, see duplicates
    paths_by_year = drop_overlapping_paths(
        paths_by_year, all_path_groups, all_path_metadata, contents
    )
    return ExportSelection(paths_by_year, contents)


@dataclass
class _ChunkPlan:
    year: int
    index: int
    path_indices: list[int]
    # One entry per path index: its id, or None when it is not exported
    path_ids: list[int | None]
    # One entry per path index: the ground under its points, see terrain
    elevations: list[PointElevations | None]
    # One entry per path index: its landings, see landings.detect_landings;
    # empty for none at all
    landings: list[FlightLandings | None] = field(default_factory=list)


@dataclass
class _PackedPaths:
    """Paths as a column of doubles per field of their points, to pickle.

    A list of TrackPoints pickles point by point: the chunks of data/ took
    90 ms to pickle, in the parent, one after the other, and 20 ms to pack
    (``of``), which pickle in a fraction of a millisecond. The worker gets
    the same points back (``paths``): floats, and None where a point has no
    altitude or time, which is NaN here, as in the parse cache (see
    ``parser_cache``); no point of a parse is NaN otherwise.
    """

    lengths: list[int]
    # lat, lon, alt and ts, the fields of TrackPoint
    columns: list[array[float]]

    @classmethod
    def of(cls, paths: FlightPathGroup) -> _PackedPaths:
        """``paths`` packed."""
        points = [point for path in paths for point in path]
        columns = [
            array(
                "d",
                [math.nan if v is None else v for v in values]
                if None in values
                else values,
            )
            for values in (zip(*points, strict=True) if points else [()] * 4)
        ]
        return cls([len(path) for path in paths], columns)

    def paths(self) -> FlightPathGroup:
        """The paths ``of`` packed."""
        lat, lon, alt, ts = (column.tolist() for column in self.columns)
        points = list(
            map(TrackPoint, lat, lon, _optional(alt), _optional(ts), strict=True)
        )
        paths: FlightPathGroup = []
        position = 0
        for length in self.lengths:
            paths.append(points[position : position + length])
            position += length
        return paths


def _optional(values: list[float]) -> list[float | None]:
    """A column of ``_PackedPaths``, None for NaN."""
    # The sum is NaN when a value is (or two infinities cancel, which only
    # costs the slower way): one pass in C rather than one call per value
    if math.isnan(sum(values)) and any(map(math.isnan, values)):
        return [None if math.isnan(value) else value for value in values]
    # No None in it: the list itself, as list is invariant to mypy
    return cast("list[float | None]", values)


# The fragments a chunk writes: its path_info entries, then one per array of
# the segments object (see segment_codec, format 8): the start points, the
# five encoded columns and the ground
_PARTS = ("info", "start", "lat", "lon", "altitude", "speed", "time", "ground")
_COLUMN_PARTS = _PARTS[2:7]


def _part_paths(output_dir: str, year: int, index: int) -> list[Path]:
    """The fragment files of a chunk, in the order of ``_PARTS``."""
    year_dir = Path(output_dir) / str(year)
    return [year_dir / f".data.{index}.{name}.part" for name in _PARTS]


def process_year_chunk(
    year: int,
    year_path_groups: FlightPathGroup,
    year_path_metadata: list[PathMetadata],
    path_ids: Sequence[int | None],
    output_dir: str,
    index: int = 0,
    airport_names: frozenset[str] | None = None,
    path_elevations: Sequence[PointElevations | None] | None = None,
    path_landings: Sequence[FlightLandings | None] | None = None,
) -> ChunkResult:
    """Export a chunk of a year's paths into JSON fragments.

    ``path_ids`` holds the id of each path, None for the paths that are not
    exported (see ``assign_path_ids``). ``airport_names`` are the exported
    airport markers (see ``export_pipeline.build_path_info``).
    ``path_elevations`` holds the ground under the points of each path, in
    their order (see ``terrain.sample_path_elevations``), None for a path
    without; a path gets a ground column when they cover every row of it.
    ``path_landings`` holds the landings of each path (see
    ``landings.detect_landings``), None for a path without. Writes
    ``<output_dir>/<year>/.data.<index>.<part>.part`` for each of
    ``_PARTS``: the path_info entries, then the entries of each array of the
    segments object, one per path, comma separated. The fragments are
    streamed path by path, so the chunk never holds all of its segment rows
    in memory at once.
    """
    original_points = sum(len(path) for path in year_path_groups)
    groundspeed = GroundspeedRange()
    parts = _part_paths(output_dir, year, index)
    parts[0].parent.mkdir(parents=True, exist_ok=True)

    if path_elevations is None:
        path_elevations = [None] * len(path_ids)
    if not path_landings:
        path_landings = [None] * len(path_ids)
    path_count = 0
    with ExitStack() as stack:
        info_out, *segment_outs = (
            stack.enter_context(open(part, "w", encoding="utf-8")) for part in parts
        )
        for path, metadata, path_id, elevations, landings in zip(
            year_path_groups,
            year_path_metadata,
            path_ids,
            path_elevations,
            path_landings,
            strict=True,
        ):
            if path_id is None:
                continue

            # Smoothed for the statistics and the drawing alone: the ground
            # was sampled at its positions, which stay, and the landings
            # read the path as recorded
            smoothed = without_altitude_spikes(path)
            start, rows = process_path_segments(smoothed, path_duration(metadata))
            info = build_path_info(
                smoothed, metadata, path_id, year, airport_names, landings
            )

            # json.dumps rather than json.dump: only the one-shot encoder is
            # the C implementation, dumping to a file uses the Python one
            separator = "," if path_count else ""
            info_out.write(separator + json.dumps(info, separators=JSON_SEPARATORS))
            # Scaled to integers, stored as differences and written column
            # by column across the paths, see segment_codec. The time column
            # and the ground are null for a path without them.
            columns = encode_rows(start, rows)
            ground = (
                ground_profile_ft(
                    start, rows, elevations_by_coordinate(path, elevations)
                )
                if elevations is not None
                else None
            )
            values = [
                encode_start(start),
                *columns,
                *[None] * (len(_COLUMN_PARTS) - len(columns)),
                encode_ground(ground) if ground is not None else None,
            ]
            for out, value in zip(segment_outs, values, strict=True):
                out.write(separator + json.dumps(value, separators=JSON_SEPARATORS))

            speeds = [row[SPEED] for row in rows if row[SPEED] > 0]
            if speeds:
                groundspeed.include(min(speeds), max(speeds))
            path_count += 1

    return ChunkResult(
        year=year,
        index=index,
        path_count=path_count,
        original_points=original_points,
        groundspeed=groundspeed,
    )


def _process_packed_chunk(
    year: int, packed: _PackedPaths, *arguments: Any
) -> ChunkResult:
    """``process_year_chunk`` in a worker, of its paths packed for the pool."""
    return process_year_chunk(year, packed.paths(), *arguments)


def _copy_fragments(out: IO[str], parts: list[Path]) -> None:
    """Concatenate non-empty fragment files, comma separated."""
    first = True
    for part in parts:
        if part.stat().st_size == 0:
            continue
        if not first:
            out.write(",")
        first = False
        with open(part, encoding="utf-8") as fragment:
            shutil.copyfileobj(fragment, out)


def _remove_parts(output_dir: str, year: int, indices: list[int]) -> None:
    for index in indices:
        for part in _part_paths(output_dir, year, index):
            part.unlink(missing_ok=True)


def _assemble_year_file(
    year: int, chunks: list[ChunkResult], output_dir: str
) -> YearExportResult:
    """Write <output_dir>/<year>/data.json from the chunk fragments."""
    chunks = sorted(chunks, key=lambda chunk: chunk.index)
    original_points = sum(chunk.original_points for chunk in chunks)
    output_file = Path(output_dir) / str(year) / YEAR_FILE

    header: YearFileHeader = {"format": FORMAT_VERSION, "year": year}
    # The object stays open for the paths that follow
    head = json.dumps(header, separators=JSON_SEPARATORS).removesuffix("}")

    chunk_parts = [_part_paths(output_dir, year, chunk.index) for chunk in chunks]

    def copy(out: IO[str], name: str) -> None:
        position = _PARTS.index(name)
        _copy_fragments(out, [parts[position] for parts in chunk_parts])

    def write(out: IO[str]) -> None:
        out.write(head + ',"path_info":[')
        copy(out, "info")
        out.write('],"segments":{"start":[')
        copy(out, "start")
        out.write('],"columns":[')
        for position, name in enumerate(_COLUMN_PARTS):
            out.write(("," if position else "") + "[")
            copy(out, name)
            out.write("]")
        out.write('],"ground":[')
        copy(out, "ground")
        out.write("]}}")

    try:
        atomic_write(output_file, write)
    finally:
        _remove_parts(output_dir, year, [chunk.index for chunk in chunks])

    groundspeed = GroundspeedRange()
    for chunk in chunks:
        groundspeed.merge(chunk.groundspeed)

    return YearExportResult(
        year=year,
        path_count=sum(chunk.path_count for chunk in chunks),
        original_points=original_points,
        file_bytes=output_file.stat().st_size,
        groundspeed=groundspeed,
    )


def _group_paths_by_year(
    all_path_metadata: list[PathMetadata], exportable: Sequence[bool]
) -> dict[int, list[int]]:
    """Group path indices by year; paths without a year are skipped.

    ``exportable`` tells for each path whether it is exported (see
    ``is_exportable_path``).

    A year without a single exportable path is left out, so that a file with
    nothing but point markers does not add an empty year. In the other years
    the markers stay in the groups, where they count for ``original_points``
    and for the chunk sizes as before.
    """
    paths_by_year: dict[int, list[int]] = {}
    for path_idx, metadata in enumerate(all_path_metadata):
        year = metadata.get("year")
        if year is None:
            # The pipeline drops these in pipeline._drop_paths_without_year,
            # which also keeps them out of the airports.
            # This guard only covers direct calls to export_all_data.
            logger.debug(
                "Skipping path without year: %s", metadata.get("filename", path_idx)
            )
            continue
        paths_by_year.setdefault(year, []).append(path_idx)
    return {
        year: indices
        for year, indices in paths_by_year.items()
        if any(exportable[i] for i in indices)
    }


def _chunk_count(points: int, target: int, path_count: int) -> int:
    """How many chunks a year of ``points`` is split into, ``target`` points
    each at most (see ``_chunk_target``), with at least one path and
    ``MIN_POINTS_PER_CHUNK`` each.

    At most, rather than at least: years of 1.3 and 2.7 shares of a worker
    were cut into one and two chunks, and the worker of the first took a
    third longer than the others (a build of four copies of data/ in eight
    years took 5 % less time with 16 workers once the count was rounded up).
    """
    return max(
        1,
        min(
            path_count,
            math.ceil(points / max(1, target)),
            points // MIN_POINTS_PER_CHUNK,
        ),
    )


def _chunk_target(total_points: int, max_workers: int) -> int:
    """The points a chunk should get: every worker gets about the same share
    of all the years, and no chunk less than ``MIN_POINTS_PER_CHUNK``."""
    return max(MIN_POINTS_PER_CHUNK, math.ceil(total_points / max(1, max_workers)))


def export_needs_a_pool(
    all_path_groups: FlightPathGroup, all_path_metadata: list[PathMetadata]
) -> bool:
    """Whether the export of these paths cuts them into more than one chunk,
    which a process pool writes (see ``_plan_chunks``).

    Before the paths it leaves out are known (see ``select_exported_paths``),
    for ``workers.start_worker_server``: a duplicate counts as well.
    """
    weights: dict[int, list[int]] = {}
    for path, metadata in zip(all_path_groups, all_path_metadata, strict=True):
        year = metadata.get("year")
        if year is not None:
            weights.setdefault(year, []).append(max(1, len(path)))
    target = _chunk_target(
        sum(sum(year) for year in weights.values()), default_worker_count()
    )
    chunks = sum(
        _chunk_count(sum(year), target, len(year)) for year in weights.values()
    )
    return chunks > 1


def _split_by_weight(
    indices: list[int], weights: list[int], chunks: int
) -> list[list[int]]:
    """Cut ``indices`` into ``chunks`` runs of about the same weight, in order.

    A run ends at the first path that takes it to its share of the total,
    and every run keeps at least one path.
    """
    if chunks <= 1 or len(indices) <= 1:
        return [indices]
    total = sum(weights)
    runs: list[list[int]] = []
    run: list[int] = []
    reached = 0
    for position, (index, weight) in enumerate(zip(indices, weights, strict=True)):
        run.append(index)
        reached += weight
        left_paths = len(indices) - position - 1
        left_runs = chunks - len(runs) - 1
        if left_runs <= 0:
            continue
        if reached * chunks >= total * (len(runs) + 1) or left_paths == left_runs:
            runs.append(run)
            run = []
    # The cuts leave a path for every run still to come: the last one has some
    runs.append(run)
    return runs


def _plan_chunks(
    paths_by_year: dict[int, list[int]],
    path_ids: Mapping[int, int],
    max_workers: int,
    elevations: Mapping[int, PointElevations] | None = None,
    landings: Mapping[int, FlightLandings] | None = None,
    point_counts: Mapping[int, int] | None = None,
) -> list[_ChunkPlan]:
    """Cut the years into chunks, in input order, and hand each its path ids.

    ``path_ids`` are the ids of the exported paths by input index (see
    ``assign_path_ids``); the chunk boundaries do not change them.
    ``elevations`` are the ground under the points of the paths, by input
    index (see ``terrain.sample_path_elevations``), and ``landings`` what
    the paths did at the fields, likewise (see ``landings.detect_landings``).
    ``point_counts`` are the points of the paths by input index, which the
    chunks are sized by; a path without one counts as one point.
    """
    elevations = elevations or {}
    landings = landings or {}
    point_counts = point_counts or {}
    weights_by_year = {
        year: [max(1, point_counts.get(i, 1)) for i in indices]
        for year, indices in paths_by_year.items()
    }
    target = _chunk_target(
        sum(sum(weights) for weights in weights_by_year.values()), max_workers
    )
    plans: list[_ChunkPlan] = []
    for year in sorted(paths_by_year):
        indices = paths_by_year[year]
        weights = weights_by_year[year]
        chunks = _chunk_count(sum(weights), target, len(indices))
        for index, chunk_indices in enumerate(
            _split_by_weight(indices, weights, chunks)
        ):
            chunk_ids = [path_ids.get(i) for i in chunk_indices]
            plans.append(
                _ChunkPlan(
                    year,
                    index,
                    chunk_indices,
                    chunk_ids,
                    [elevations.get(i) for i in chunk_indices],
                    [landings.get(i) for i in chunk_indices],
                )
            )
    return plans


# The arguments of process_year_chunk, in its order
type _ChunkArguments = tuple[
    int,
    FlightPathGroup,
    list[PathMetadata],
    list[int | None],
    str,
    int,
    frozenset[str] | None,
    list[PointElevations | None],
    list[FlightLandings | None],
]


@dataclass
class _ChunkJob:
    """What every chunk of one export shares: the paths and where they go."""

    all_path_groups: FlightPathGroup
    all_path_metadata: list[PathMetadata]
    output_dir: str
    airport_names: frozenset[str] | None
    #: The chunk indices of every year, for the file names and the cleanup
    parts_per_year: dict[int, list[int]]

    def arguments(self, plan: _ChunkPlan) -> _ChunkArguments:
        """The arguments of ``process_year_chunk`` for ``plan``."""
        return (
            plan.year,
            [self.all_path_groups[i] for i in plan.path_indices],
            [self.all_path_metadata[i] for i in plan.path_indices],
            plan.path_ids,
            self.output_dir,
            plan.index,
            self.airport_names,
            plan.elevations,
            plan.landings,
        )

    def packed_arguments(self, plan: _ChunkPlan) -> tuple[Any, ...]:
        """The arguments of ``_process_packed_chunk`` for ``plan``."""
        year, paths, *arguments = self.arguments(plan)
        return (year, _PackedPaths.of(paths), *arguments)

    def describe(self, plan: _ChunkPlan) -> str:
        """The chunk as the progress lines name it."""
        parts = len(self.parts_per_year[plan.year])
        if parts == 1:
            return f"Year {plan.year}"
        return f"Year {plan.year} (part {plan.index + 1}/{parts})"


def _fail(
    job: _ChunkJob,
    plan: _ChunkPlan,
    exc: Exception,
    executor: Executor | None = None,
) -> RuntimeError:
    """Clean up after a chunk that failed; the error to raise for it."""
    if executor is not None:
        # Chunks that are still running (or already handed to a worker)
        # would write their fragments after the cleanup below
        executor.shutdown(wait=True, cancel_futures=True)
    for year, indices in job.parts_per_year.items():
        _remove_parts(job.output_dir, year, indices)
    if isinstance(exc, OSError | FlownError | BrokenProcessPool | MemoryError):
        # Expected failures (a full disk, a worker killed for running out
        # of memory, or out of it) are reported in one line
        logger.debug("Error processing year %s", plan.year, exc_info=exc)
    else:
        logger.exception("  Error processing year %s", plan.year)
    # A MemoryError says nothing of its own
    reason = (
        "out of memory"
        if isinstance(exc, MemoryError)
        else str(exc) or type(exc).__name__
    )
    return RuntimeError(f"Failed to process year {plan.year}: {reason}")


def _run_single(job: _ChunkJob, plan: _ChunkPlan) -> list[ChunkResult]:
    """Run the only chunk of an export in this process."""
    try:
        result = process_year_chunk(*job.arguments(plan))
    except Exception as exc:
        raise _fail(job, plan, exc) from exc
    logger.info(
        "  [1/1] %s: %s points", job.describe(plan), f"{result.original_points:,}"
    )
    return [result]


def _run_pooled(
    job: _ChunkJob, plans: list[_ChunkPlan], max_workers: int
) -> list[ChunkResult]:
    """Run the chunks in a process pool, a few of them queued at a time."""
    chunk_results: list[ChunkResult] = []
    workers = max(1, min(len(plans), max_workers))
    # A pool that cannot start, or breaks, writes the chunks here, one after
    # the other (see WorkerPool)
    with WorkerPool(
        workers, "writing the year files", (logger.getEffectiveLevel(),)
    ) as executor:
        # Submitting every chunk at once would pickle the whole dataset into
        # the executor's queue while the main process still holds it; a
        # bounded number of chunks is in flight at any time
        # With the arguments handed to the pool, for a task that is done
        # again here (see WorkerPool.result): packing them again for every
        # chunk took as long as packing them for the pool
        pending: dict[Future[ChunkResult], tuple[_ChunkPlan, tuple[Any, ...]]] = {}
        queued = iter(plans)

        def submit_next() -> None:
            plan = next(queued, None)
            if plan is not None:
                arguments = job.packed_arguments(plan)
                future = executor.submit(_process_packed_chunk, *arguments)
                pending[future] = (plan, arguments)

        for _ in range(workers * MAX_QUEUED_CHUNKS_PER_WORKER):
            submit_next()
        while pending:
            done, _ = wait(pending, return_when=FIRST_COMPLETED)
            for future in done:
                plan, arguments = pending.pop(future)
                try:
                    result = executor.result(future, _process_packed_chunk, *arguments)
                except Exception as exc:
                    raise _fail(job, plan, exc, executor) from exc
                chunk_results.append(result)
                logger.info(
                    "  [%d/%d] %s: %s points",
                    len(chunk_results),
                    len(plans),
                    job.describe(plan),
                    f"{result.original_points:,}",
                )
                submit_next()
    return chunk_results


def _export_chunks(
    plans: list[_ChunkPlan],
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    output_dir: str,
    max_workers: int,
    airport_names: frozenset[str] | None = None,
) -> list[YearExportResult]:
    """Run the chunks (in a process pool when there are several) and assemble
    the year files. Returns the results sorted by year."""
    parts_per_year: dict[int, list[int]] = {}
    for plan in plans:
        parts_per_year.setdefault(plan.year, []).append(plan.index)
    job = _ChunkJob(
        all_path_groups, all_path_metadata, output_dir, airport_names, parts_per_year
    )

    if len(plans) == 1:
        chunk_results = _run_single(job, plans[0])
    elif plans:
        chunk_results = _run_pooled(job, plans, max_workers)
    else:
        chunk_results = []

    year_results = []
    for year in sorted(parts_per_year):
        chunks = [chunk for chunk in chunk_results if chunk.year == year]
        year_results.append(_assemble_year_file(year, chunks, output_dir))
    return year_results


def export_all_data(
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    unique_airports: list[AirportData],
    output_dir: str | Path = "data",
    aircraft_data: Mapping[str, str] | None = None,
    exportable: Sequence[bool] | None = None,
    terrain: TileSource | None = None,
    selection: ExportSelection | None = None,
    *,
    available_flags: Sequence[str],
    landings: Sequence[FlightLandings | None] | None = None,
) -> ExportResult:
    """Write the data files into ``output_dir``.

    ``output_dir`` is expected to hold no previous export: the pipeline
    passes the data staging directory of a ``SiteOutput``, which publishes
    the files. ``exportable`` is ``is_exportable_path`` of every path, and
    ``selection`` the ``select_exported_paths`` of them, when the caller has
    them already; ``unique_airports`` should come from the paths of that
    selection. ``terrain`` is where the ground under the flights comes from
    (see ``flown.terrain``); without it the year files carry no ground
    and the page takes it from the airfields. ``available_flags`` are the
    countries the site publishes a flag for (see
    ``site_assets.available_country_flags``), which metadata.json lists.
    They have no default: without them the stats and Wrapped show country
    codes where the site has flags, and a caller that forgot them would not
    notice. ``landings`` are those of every path, found with the parse (see
    ``landings.path_landings``); without them they are found here.
    """
    if landings is not None and len(landings) != len(all_path_groups):
        raise ValueError("The landings have to be one per path")
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    logger.info("\n  Exporting data to JSON files...")

    if selection is None:
        if exportable is None:
            exportable = [is_exportable_path(path) for path in all_path_groups]
        selection = select_exported_paths(
            all_path_groups, all_path_metadata, exportable
        )
    paths_by_year = selection.paths_by_year
    contents = selection.contents
    logger.info("\n  Splitting data by year: %s", sorted(paths_by_year))

    path_ids = assign_path_ids(paths_by_year, contents)
    # Once for all paths, in this process: every tile is fetched and decoded
    # once, and a chunk only gets the elevations of its own paths
    elevations = (
        sample_path_elevations(
            {index: all_path_groups[index] for index in path_ids}, terrain, contents
        )
        if terrain is not None and path_ids
        else None
    )
    # Here as well when the parse did not find them: the export workers have
    # no airport database
    if landings is None:
        found = (
            detect_landings({index: all_path_groups[index] for index in path_ids})
            if path_ids
            else {}
        )
    else:
        found = {
            index: path for index in path_ids if (path := landings[index]) is not None
        }
        log_landings(found)
    max_workers = default_worker_count()
    plans = _plan_chunks(
        paths_by_year,
        path_ids,
        max_workers,
        elevations,
        found,
        {
            index: len(all_path_groups[index])
            for indices in paths_by_year.values()
            for index in indices
        },
    )

    logger.info(
        "\n  Processing %d year(s) in %d chunk(s)...", len(paths_by_year), len(plans)
    )
    year_results = _export_chunks(
        plans,
        all_path_groups,
        all_path_metadata,
        str(output_path),
        max_workers,
        exported_airport_names(unique_airports),
    )

    groundspeed = GroundspeedRange()
    year_file_bytes: dict[str, int] = {}
    for result in year_results:
        groundspeed.merge(result.groundspeed)
        year_file_bytes[str(result.year)] = result.file_bytes

    # Only the aircraft of exported paths: the frontend never shows another
    aircraft_models = resolve_aircraft_models(
        (all_path_metadata[index].get("aircraft_registration") for index in path_ids),
        aircraft_data,
    )

    years = [result.year for result in year_results]
    _, airports_bytes = export_airports_data(unique_airports, str(output_path))
    _, metadata_bytes = export_metadata(
        groundspeed.min_knots or 0.0,
        groundspeed.max_knots,
        years,
        year_file_bytes,
        aircraft_models,
        str(output_path),
        list(available_flags),
    )

    total_size = airports_bytes + metadata_bytes + sum(year_file_bytes.values())
    logger.info("  Total data size: %.1f KB", total_size / 1024)

    return ExportResult(years=years, path_ids=path_ids)
