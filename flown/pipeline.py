"""The generation pipeline: parse, deduplicate, export, then package.

It renders nothing itself: the page and the files the site is made of come
from ``site_assets``, the data files from ``data_exporter``. This module is
about the order the stages run in, what they hand each other and how a
failure is reported (the exceptions of ``exceptions``, which ``cli`` turns
into its exit status).
"""

import contextlib
import gc
import os
import pickle
import shlex
import time
from concurrent.futures import as_completed
from concurrent.futures.process import BrokenProcessPool
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import quote

from .aircraft import merge_aircraft_data
from .airport_lookup import (
    database_fingerprint,
    load_airport_database,
    load_runway_database,
)
from .airports import deduplicate_airports
from .data_exporter import (
    ExportResult,
    ExportSelection,
    export_all_data,
    select_exported_paths,
)
from .exceptions import (
    ExportError,
    FlownError,
    InvalidInputError,
    KMLParseError,
    OutputRefusedError,
)
from .export_writers import (
    exported_airport_names,
    exported_country_codes,
    free_text_airport_names,
)
from .geometry import CoordinateExtent, trim_path_ends
from .landings import path_landings
from .logger import logger
from .parser import load_cached_entry, parse_and_cache, parse_size
from .parser_cache import prune_stale_cache_entries
from .path_content import is_exportable_path
from .previews import SITE_URL_ENV, normalize_site_url, write_previews
from .site_assets import (
    CODE_FILES,
    SITE_FILE_PATTERNS,
    SITE_FILES,
    available_country_flags,
    build_time,
    missing_build_files,
    package_assets,
    render_html,
    warn_about_a_stale_bundle,
)
from .site_output import STABLE_MTIMES_ENV, SiteOutput, day_start
from .validation import foreign_site_files, validate_kml_file, validate_output_dir
from .workers import (
    WorkerPool,
    default_worker_count,
    parse_worker_count,
    processes_allowed,
)

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Iterator, Sequence

    from .airport_lookup import AirportRecord
    from .airports import AirportData
    from .landings import FlightLandings
    from .terrain import TileSource
    from .types import FlightPath, FlightPathGroup, PathMetadata

__all__ = [
    "FlightDataExport",
    "ParsedFile",
    "build_site",
    "export_flight_data",
    "foreign_output_error",
    "load_cached",
    "no_flight_reason",
    "parse_files",
    "parse_inline",
    "preflight",
    "trim_paths",
]

# Files that are not in the parse cache are parsed in this process up to
# this many bytes in total, and in a process pool beyond. Starting the pool
# costs about as much as parsing 4 MB of KML, and 4 MB take about 60 MB of
# memory to parse, which the main process can well afford.
INLINE_PARSE_MAX_BYTES = 4 * 1024 * 1024
# Files the parse cache holds are read in this process, unless there is this
# much KML and at least POOLED_CACHE_MIN_WORKERS cores to read their entries
# in the pool: 3090 files (494 MB, 4.7 million points) took 3.4 s here and
# 2.0 s in 16 workers, 1030 of them (165 MB) 1.1 and 0.8 s, and 103 of them
# 0.1 s here and 0.3 s in the pool, which takes time to start.
POOLED_CACHE_MIN_BYTES = 128 * 1024 * 1024
POOLED_CACHE_MIN_WORKERS = 8


# Why a file the parse failed on with a bug failed, as a build names it
UNEXPECTED_PARSE_ERROR = "an unexpected error while reading it"


@dataclass
class ParsedFile:
    """What a parse worker sends back to the main process.

    The flat coordinate list stays in the worker: the main process only
    needs its size, which keeps the data crossing the process boundary (and
    held in the parent) to the flight paths themselves.
    """

    kml_file: str
    point_count: int = 0
    path_groups: FlightPathGroup = field(default_factory=list)
    path_metadata: list[PathMetadata] = field(default_factory=list)
    # The landings of every path, found with the parse and kept in the
    # parse cache (see landings.path_landings); None for an entry without
    landings: list[FlightLandings | None] | None = None
    # For a file without a path: whether a point of it has no altitude above
    # sea level (see no_flight_reason)
    altitudes_missing: bool = False
    # Why a file failed to parse, for a build that names it (_usable_results)
    error: str | None = None


def _parse_with_error_handling(
    kml_file: str, cache_path: Path | None = None
) -> ParsedFile:
    """Parse a KML file in a worker and reduce the result for the parent.

    ``cache_path`` is the parse cache entry the parent looked up and missed
    (see ``parser.load_cached_entry``); the result is stored there, with
    the landings of its paths.
    """
    try:
        (coordinates, path_groups, path_metadata), landings = parse_and_cache(
            kml_file, cache_path, path_landings
        )
    except (OSError, KMLParseError) as e:
        logger.error("Error processing %s: %s", kml_file, e)
        return ParsedFile(kml_file, error=str(e))
    except ValueError, TypeError:
        # The parser turns what is wrong with a file into a KMLParseError:
        # anything else is a bug of the parse or the landings, and its
        # traceback says where
        logger.exception("Unexpected error processing %s", kml_file)
        return ParsedFile(kml_file, error=UNEXPECTED_PARSE_ERROR)
    return _parsed_file(kml_file, coordinates, path_groups, path_metadata, landings)


def _parsed_file(
    kml_file: str,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    path_metadata: list[PathMetadata],
    landings: list[FlightLandings | None] | None,
) -> ParsedFile:
    """The parse of a file as the parent gets it (see ``ParsedFile``)."""
    return ParsedFile(
        kml_file,
        len(coordinates),
        path_groups,
        path_metadata,
        landings,
        altitudes_missing=not path_groups
        and any(point.alt is None for point in coordinates),
    )


def load_cached(kml_file: str) -> ParsedFile | Path | None:
    """The parse result of a file from the parse cache.

    On a miss the cache entry to store the parse in, or None without one.
    """
    try:
        cached, cache_path = load_cached_entry(kml_file)
    except OSError:
        return None
    if cached is None:
        return cache_path
    return _parsed_file(
        kml_file,
        cached.coordinates,
        cached.path_groups,
        cached.path_metadata,
        cached.landings,
    )


def _load_or_parse(kml_file: str, _cache_path: Path | None = None) -> ParsedFile:
    """The parse of a file, from the parse cache if it has it, in a worker.

    The second argument, the cache entry of ``_parse_in_pool``, is not used:
    the worker looks the entry up itself. The collector is paused
    meanwhile, see ``_collector_paused``.
    """
    enabled = gc.isenabled()
    gc.disable()
    try:
        cached = load_cached(kml_file)
        if isinstance(cached, ParsedFile):
            return cached
        return _parse_with_error_handling(kml_file, cached)
    finally:
        if enabled:
            gc.enable()


def parse_inline(
    kml_file: str,
    cache_path: Path | None,
    parse: Callable[[str, Path | None], ParsedFile] | None = None,
) -> ParsedFile:
    """Parse a file in this process, with the error handling of a worker.

    ``parse`` is what a worker would run for it (see ``_parse_in_pool``),
    ``_parse_with_error_handling`` by default.
    """
    try:
        return (parse or _parse_with_error_handling)(kml_file, cache_path)
    except FlownError:
        raise
    # A bug in the parser shows on this one file, with its traceback, and
    # the run reports the file as failed instead of dying without a name
    except Exception:  # noqa: BLE001
        logger.exception("Unexpected error processing %s", kml_file)
        return ParsedFile(kml_file, error=UNEXPECTED_PARSE_ERROR)


def _file_bytes(kml_files: list[str]) -> int:
    """The KML the files hold, that inside a KMZ counted uncompressed.

    The pool gates below are about the work and the memory a parse takes,
    which the document decides, not the archive (see ``parse_size``).
    """
    return sum(parse_size(kml_file) for kml_file in kml_files)


def _serve_hint(output_file: str | Path) -> str:
    """How to view a site: it only works over HTTP, not opened from disk.

    The command serves the site's directory, as usage.md has it: a plain
    ``python -m http.server`` would serve the directory it runs in.
    """
    site = Path(output_file)
    page = "" if site.name == "index.html" else quote(site.name)
    return (
        "View it over HTTP: python -m http.server 8000 --bind 127.0.0.1 -d "
        f"{shlex.quote(str(site.parent))}, then open http://127.0.0.1:8000/{page}"
    )


def _some_names(files: Sequence[str]) -> str:
    """The names of the first files of a list, and how many more there are."""
    shown = ", ".join(Path(kml_file).name for kml_file in files[:3])
    return f"{shown} and {len(files) - 3} more" if len(files) > 3 else shown


def _parse_in_pool(
    uncached: Sequence[tuple[str, Path | None]],
    record: Callable[[ParsedFile], None],
    airports: dict[str, AirportRecord],
    parse: Callable[[str, Path | None], ParsedFile] = _parse_with_error_handling,
) -> None:
    """Parse files in a process pool, handing each result to ``record``.

    ``uncached`` pairs each file with its parse cache entry (see
    ``_parse_with_error_handling``); ``parse`` is what a worker runs for
    each, ``_load_or_parse`` to look the cache up there. The workers get the
    airport and runway databases the parent loaded (see
    ``workers.init_worker``).
    """
    if not processes_allowed():
        # No worker to hand the databases to, which are not pickled for
        # nothing then: every file is parsed here (see configure_workers)
        for kml_file, cache_path in uncached:
            record(parse_inline(kml_file, cache_path, parse))
        return
    kml_files = [kml_file for kml_file, _ in uncached]
    cache_paths = dict(uncached)
    level = logger.getEffectiveLevel()
    database = pickle.dumps(airports, protocol=pickle.HIGHEST_PROTOCOL)
    # Loaded already, as the cache keys cover them (see _parse_kml_files)
    runways = pickle.dumps(load_runway_database(), protocol=pickle.HIGHEST_PROTOCOL)
    # Of the two as read here, which the workers' cache keys take as well
    fingerprint = database_fingerprint()
    done: set[str] = set()
    pool_broken = False
    # The files a worker ran out of memory on, parsed again one at a time
    out_of_memory: list[str] = []
    # A pool that cannot start parses here (see WorkerPool)
    with WorkerPool(
        parse_worker_count(kml_files),
        "parsing the KML files",
        (level, database, runways, fingerprint),
    ) as executor:
        future_to_file = {
            executor.submit(parse, f, cache_paths[f]): f for f in kml_files
        }
        for future in as_completed(future_to_file):
            try:
                parsed = future.result()
            except MemoryError:
                # Out of memory while others parsed large files at the same
                # time; the other files go on
                out_of_memory.append(future_to_file[future])
                continue
            except BrokenProcessPool:
                # Usually a worker killed for running out of memory: every
                # file not parsed yet is lost with the pool
                pool_broken = True
                break
            except FlownError:
                # Not a problem of this one file (the airport database, say),
                # so every other file would fail the same way
                executor.shutdown(wait=True, cancel_futures=True)
                raise
            # As in parse_inline: one file's bug, named with its traceback
            except Exception:  # noqa: BLE001
                kml_file = future_to_file[future]
                logger.exception("Unexpected error processing %s", kml_file)
                parsed = ParsedFile(kml_file, error=UNEXPECTED_PARSE_ERROR)
            done.add(parsed.kml_file)
            record(parsed)

    if pool_broken or out_of_memory:
        remaining = [f for f in kml_files if f not in done]
        logger.warning(
            "  A parser worker process %s; parsing the %d remaining "
            "file(s) one at a time",
            "crashed" if pool_broken else "ran out of memory",
            len(remaining),
        )
        # Still in a worker: a file that is too large to parse must not take
        # the main process down with it, and one at a time names the file
        with WorkerPool(
            1,
            "parsing the KML files one at a time",
            (level, database, runways, fingerprint),
        ) as executor:
            for kml_file in remaining:
                try:
                    parsed = executor.submit(
                        parse, kml_file, cache_paths[kml_file]
                    ).result()
                except BrokenProcessPool, MemoryError:
                    raise FlownError(
                        f"A parser worker process crashed on {kml_file}, possibly "
                        "out of memory; run with --debug for details"
                    ) from None
                record(parsed)


def _load_or_parse_here(
    valid_files: list[str],
    record: Callable[[ParsedFile], None],
    airports: dict[str, AirportRecord],
) -> None:
    """Read the parse cache in this process and parse what it misses.

    The misses are parsed here as well up to ``INLINE_PARSE_MAX_BYTES``, in
    a process pool beyond.
    """
    # The files to parse, with the cache entry to store each one in
    uncached: list[tuple[str, Path | None]] = []
    for kml_file in valid_files:
        cached = load_cached(kml_file)
        if isinstance(cached, ParsedFile):
            record(cached)
        else:
            uncached.append((kml_file, cached))

    if (
        uncached
        and _file_bytes([kml_file for kml_file, _ in uncached]) > INLINE_PARSE_MAX_BYTES
    ):
        _parse_in_pool(uncached, record, airports)
    else:
        for kml_file, cache_path in uncached:
            record(parse_inline(kml_file, cache_path))


def parse_files(
    valid_files: list[str], airports: dict[str, AirportRecord]
) -> list[ParsedFile]:
    """The parses of files, in their order, as a build reads or parses them.

    From the parse cache, and the misses here or in a process pool (see
    ``_load_or_parse_here``); ``--list`` reads its files through this.
    """
    results: list[ParsedFile] = []
    _load_or_parse_here(valid_files, results.append, airports)
    order = {kml_file: index for index, kml_file in enumerate(valid_files)}
    results.sort(key=lambda parsed: order[parsed.kml_file])
    for parsed in results:
        _mark_source(parsed)
    return results


def _mark_source(parsed: ParsedFile) -> None:
    """Name the file of its paths in their metadata (``source``).

    Two folders may hold files of one name: the duplicates tell them apart
    by it (see ``duplicates._one_file``), as ``--list`` must as the build.
    """
    for metadata in parsed.path_metadata:
        metadata["source"] = parsed.kml_file


@contextlib.contextmanager
def _collector_paused() -> Iterator[None]:
    """Pause the cyclic garbage collector, and freeze what exists after.

    Parsing or loading a few million points creates as many objects, none
    of them part of a cycle, and every few hundred thousand of them the
    collector walks all of them again: at 4.7 million points that took
    close to half the time of loading the parse cache. Afterwards they live
    until the export is written, so they are frozen out of the collector's
    walks (``gc.freeze``) for the rest of the run: sampling the ground under
    them was a third slower otherwise. ``build_site`` hands
    them back to the collector when it is done.
    """
    enabled = gc.isenabled()
    gc.disable()
    try:
        yield
    finally:
        gc.freeze()
        if enabled:
            gc.enable()


def _parse_kml_files(
    valid_files: list[str],
    skipped: list[SkippedFile] | None = None,
) -> tuple[FlightPathGroup, list[PathMetadata], list[FlightLandings | None]]:
    """Parse KML files and merge the results in input order.

    Files the parse cache holds are read from it in this process: a worker
    pool takes longer to start than reading them does, unless there are many
    of them (see ``POOLED_CACHE_MIN_BYTES``), when every file goes to the
    pool. Of the rest, a few small files are parsed here as well (up to
    ``INLINE_PARSE_MAX_BYTES``), anything more in a process pool.

    The input order decides the path ids, so the merge must not depend on
    which worker finished first or on the file names: two directories may
    well contain files with the same name. Returns the paths, their
    metadata and their landings (see ``landings.path_landings``). A file
    that fails to parse or holds no flight fails the run, or with
    ``skipped`` is left out and named there with the reason (see
    ``_usable_results``).
    """
    parse_start = time.time()
    # Load (and if needed download) the airport database once in the parent:
    # the workers get it from here instead of each reading the CSV, and the
    # cache keys below see the same database as they do
    airports = load_airport_database()
    # The runways as well: the landings of a parse are found at the fields
    # of both, and the cache keys cover both (see database_fingerprint)
    load_runway_database()
    if not airports:
        logger.warning("No airport database: the landings are not counted")
    prune_stale_cache_entries()

    results: list[ParsedFile] = []

    def record(parsed: ParsedFile) -> None:
        results.append(parsed)
        logger.info(
            "  [%d/%d] %.0f%% - %s",
            len(results),
            len(valid_files),
            (len(results) / len(valid_files)) * 100,
            Path(parsed.kml_file).name,
        )

    with _collector_paused():
        if (
            default_worker_count() >= POOLED_CACHE_MIN_WORKERS
            and _file_bytes(valid_files) > POOLED_CACHE_MIN_BYTES
        ):
            _parse_in_pool(
                [(kml_file, None) for kml_file in valid_files],
                record,
                airports,
                _load_or_parse,
            )
        else:
            _load_or_parse_here(valid_files, record, airports)

        input_order = {kml_file: index for index, kml_file in enumerate(valid_files)}
        results.sort(key=lambda parsed: input_order[parsed.kml_file])
        parse_time = time.time() - parse_start
        logger.info(
            "  Parsing took %.1fs (%.2fs per file)",
            parse_time,
            parse_time / len(valid_files),
        )
        usable = _usable_results(results, valid_files, skipped)
        total_points = 0
        all_path_groups: FlightPathGroup = []
        all_path_metadata: list[PathMetadata] = []
        all_landings: list[FlightLandings | None] = []
        for parsed in usable:
            total_points += parsed.point_count
            all_path_groups.extend(parsed.path_groups)
            _mark_source(parsed)
            all_path_metadata.extend(parsed.path_metadata)
            all_landings.extend(
                parsed.landings
                if parsed.landings is not None
                else path_landings(parsed.path_groups)
            )

    logger.info("\nTotal points: %d", total_points)
    return all_path_groups, all_path_metadata, all_landings


@dataclass(frozen=True)
class SkippedFile:
    """An input file left out of a build that skips them, and why."""

    kml_file: str
    reason: str


def _usable_results(
    results: list[ParsedFile],
    valid_files: list[str],
    skipped: list[SkippedFile] | None,
) -> list[ParsedFile]:
    """The parses that give the export a flight, of ``results`` in order.

    A file that failed to parse, or holds no flight to export (see
    ``no_flight_reason``), fails the run: a site published without one of
    the flights would hide it until someone notices. With ``skipped`` it is
    left out instead and named there with the reason, unless no file is
    left at all: the build in the page goes on with the rest, and says
    which files it left out and why (see ``flown.browser``).
    """
    by_file = {parsed.kml_file: parsed for parsed in results}
    failed: list[SkippedFile] = []
    without_flight: list[SkippedFile] = []
    for kml_file in valid_files:
        parsed = by_file.get(kml_file)
        # A file without a result at all failed as well
        if parsed is None or not parsed.point_count:
            error = parsed.error if parsed is not None else None
            failed.append(SkippedFile(kml_file, error or "could not be read"))
            continue
        reason = no_flight_reason(parsed)
        if reason is not None:
            logger.error("%s: %s", kml_file, reason)
            without_flight.append(SkippedFile(kml_file, reason))
    left_out = {entry.kml_file for entry in failed + without_flight}
    usable = [parsed for parsed in results if parsed.kml_file not in left_out]
    if skipped is not None and usable:
        skipped.extend(failed + without_flight)
    elif skipped is not None and left_out:
        # With the files the validation left out already, in one message
        raise InvalidInputError(_unusable_message(skipped + failed + without_flight))
    # Every file failing is no case of its own: the line says how many, and
    # names them, as for one of many ("No coordinates found in any KML
    # files" read as if the files had parsed)
    elif failed:
        raise InvalidInputError(
            f"{len(failed)} of {len(valid_files)} file(s) failed to parse "
            f"({_some_names([entry.kml_file for entry in failed])}, see above); "
            "fix or remove them"
        )
    elif without_flight:
        raise InvalidInputError(
            f"{len(without_flight)} of {len(valid_files)} file(s) hold no flight "
            f"to export ({_some_names([entry.kml_file for entry in without_flight])}"
            ", see above); fix or remove them"
        )
    # Their flights build, but count for no aircraft in the filter and the
    # statistics: a name the tool exported (export.kml) says nothing
    unnamed = [
        parsed.kml_file
        for parsed in usable
        if not any(
            metadata.get("aircraft_registration") or metadata.get("aircraft_type")
            for metadata in parsed.path_metadata
        )
    ]
    if unnamed:
        logger.warning(
            "%d file(s) name no aircraft (%s): their flights belong to none; "
            "name them N_REGISTRATION_TYPE.kml, such as 1_DEHYL_DA40.kml",
            len(unnamed),
            _some_names(unnamed),
        )
    return usable


def _unusable_message(left_out: Sequence[SkippedFile]) -> str:
    """Why no file of a build that skips them gave a flight, file by file."""
    reasons = "; ".join(
        f"{Path(entry.kml_file).name}: {entry.reason}" for entry in left_out[:3]
    )
    more = f"; and {len(left_out) - 3} more" if len(left_out) > 3 else ""
    return f"No file holds a flight to export ({reasons}{more})"


def no_flight_reason(parsed: ParsedFile) -> str | None:
    """Why a file with coordinates gives the export no path, None if it does.

    Such a file fails the run like one without coordinates: its points
    count, but the site would be published without its flight. A path
    without a year or one that never moves is only left out while another
    path of the file is exported. A path that the export drops as a
    recording of a flight another file holds as well (see ``duplicates``)
    counts: the flight is on the site.
    """
    if not parsed.path_groups:
        if not parsed.altitudes_missing:
            # Every point has an altitude, so none of them was on a line of
            # two or more valid ones: a waypoint, a field marked on the map,
            # or a line of which only one point was valid
            return "no track of two or more valid points (waypoints are none)"
        return (
            "no track of two or more points with altitudes above sea level "
            "(a 2D line, such as a route plan, and a clampToGround or "
            "relativeToGround track have none)"
        )
    dated = [
        path
        for path, metadata in zip(parsed.path_groups, parsed.path_metadata, strict=True)
        if metadata.get("year") is not None
    ]
    if not dated:
        return "no track with a determinable year"
    if not any(is_exportable_path(path) for path in dated):
        return "every track with a year stays on one spot"
    return None


def _drop_paths_without_year[T](
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    per_path: Sequence[T] | None = None,
) -> tuple[FlightPathGroup, list[PathMetadata], list[T] | None]:
    """Exclude paths whose year cannot be determined, with a warning each.

    ``per_path``, one entry per path (its landings), keeps the entries of
    the paths kept, so that they still belong to them; None stays None.
    """
    kept: list[int] = []
    for index, metadata in enumerate(all_path_metadata):
        if metadata.get("year") is None:
            logger.warning(
                "Excluding path without a determinable year: %s (%s)",
                metadata.get("filename") or "unknown file",
                metadata.get("airport_name") or "unnamed",
            )
            continue
        kept.append(index)
    return (
        [all_path_groups[index] for index in kept],
        [all_path_metadata[index] for index in kept],
        None if per_path is None else [per_path[index] for index in kept],
    )


def _map_extent(
    all_path_groups: FlightPathGroup, exportable: Sequence[bool] | None = None
) -> CoordinateExtent:
    """The extent of the exported paths, which the map is fitted to.

    Only exported paths count: an excluded path would widen the map and give
    away where it was. ``exportable`` tells for every path whether it is
    exported (``is_exportable_path`` when the caller passes nothing). Raises
    when there is nothing to export.
    """
    if exportable is None:
        exportable = [is_exportable_path(path) for path in all_path_groups]
    extent = CoordinateExtent.of(
        point
        for path, exported in zip(all_path_groups, exportable, strict=True)
        if exported
        for point in path
    )
    if extent is None:
        raise InvalidInputError("No flight paths with a determinable year to export")
    return extent


def _warn_free_text_airports(unique_airports: list[AirportData]) -> None:
    """Name the airports the site publishes not from the airport database, if any.

    They come from route names as written (see
    ``export_writers.free_text_airport_names``), which may be no airports.
    """
    names = free_text_airport_names(unique_airports)
    if names:
        logger.warning(
            "Publishing %d airport name(s) not from the airport database, as the route "
            "names give them: %s. Rename a placemark whose route names no "
            "airport (see doc/privacy.md)",
            len(names),
            ", ".join(repr(name) for name in names),
        )


@dataclass(frozen=True)
class _ExportPlan:
    """What both exports settle before the data is written (see ``_plan``)."""

    path_groups: FlightPathGroup
    path_metadata: list[PathMetadata]
    landings: list[FlightLandings | None] | None
    #: ``is_exportable_path`` of every path
    exportable: list[bool]
    selection: ExportSelection
    extent: CoordinateExtent
    unique_airports: list[AirportData]
    #: The countries of the exported airports, and the flags the site can
    #: publish of them, which metadata.json lists
    countries: list[str]
    available_flags: list[str]


def _plan(
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    landings: Sequence[FlightLandings | None] | None,
    flags: Iterable[str] | None = None,
    trim_metres: float = 0,
) -> _ExportPlan:
    """Settle which paths are exported, the extent and the airports.

    The site build and the build in the browser (``export_flight_data``)
    share this, so neither drifts from the other. Undated paths go first;
    the copies and second recordings of a flight are dropped next (see
    ``select_exported_paths``), so the extent and the airports are those of
    the paths the site publishes: a path that gets no id and no segments (a
    single point, a recording that never moved, a dropped copy) would
    otherwise still publish its location and name through the airport list.

    The countries get a flag where ``flags`` has one: the page's, for the
    build in it, which has none of its own to look at; those of this
    checkout by default (see ``available_country_flags``). With
    ``trim_metres``, every path loses its ground at both ends and its points
    within that distance of where the rest starts and ends (see
    ``trim_path_ends``) before anything else looks at it: the extent and
    the airports are of what is published.
    """
    all_path_groups, all_path_metadata = trim_paths(
        all_path_groups, all_path_metadata, trim_metres
    )
    path_groups, path_metadata, dated_landings = _drop_paths_without_year(
        all_path_groups, all_path_metadata, landings
    )
    # Once per path, for every stage that only looks at the exported ones
    exportable = [is_exportable_path(path) for path in path_groups]
    selection = select_exported_paths(path_groups, path_metadata, exportable)
    exported_indices = selection.exported()
    kept = set(exported_indices)
    extent = _map_extent(
        path_groups, [index in kept for index in range(len(path_groups))]
    )
    logger.info("\nProcessing %d start points...", len(exported_indices))
    unique_airports = deduplicate_airports(
        [path_metadata[index] for index in exported_indices],
        [path_groups[index] for index in exported_indices],
    )
    logger.info("  Found %d unique airports", len(unique_airports))
    _warn_free_text_airports(unique_airports)
    countries = exported_country_codes(unique_airports)
    return _ExportPlan(
        path_groups=path_groups,
        path_metadata=path_metadata,
        landings=dated_landings,
        exportable=exportable,
        selection=selection,
        extent=extent,
        unique_airports=unique_airports,
        countries=countries,
        available_flags=(
            available_country_flags(countries)
            if flags is None
            else sorted({code.lower() for code in countries} & set(flags))
        ),
    )


def trim_paths(
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    trim_metres: float,
) -> tuple[FlightPathGroup, list[PathMetadata]]:
    """Every path without its ground at its ends and what is near it.

    See ``trim_path_ends``; the paths as they are for 0. For the build
    (``_plan``) and ``--list`` (``listing.list_flights``) alike, so that the
    list shows what the site publishes.
    """
    if trim_metres <= 0:
        return all_path_groups, all_path_metadata
    path_groups = [trim_path_ends(path, trim_metres) for path in all_path_groups]
    # The start point goes with them: a departure the airport database
    # does not place is marked at it (airports._add_departures), which
    # published the parking spot the trim took out. On copies: the
    # metadata is the parse's, which the parse cache keeps.
    path_metadata = [
        _started_at(metadata, path)
        for metadata, path in zip(all_path_metadata, path_groups, strict=True)
    ]
    return path_groups, path_metadata


def _started_at(metadata: PathMetadata, path: FlightPath) -> PathMetadata:
    """``metadata`` with the first point of ``path`` as its ``start_point``."""
    if not path:
        return metadata
    first = path[0]
    started = metadata.copy()
    started["start_point"] = (
        [first.lat, first.lon]
        if first.alt is None
        else [first.lat, first.lon, first.alt]
    )
    return started


def _export_site(
    all_path_groups: FlightPathGroup,
    all_path_metadata: list[PathMetadata],
    output_file: Path,
    data_dir: Path,
    aircraft_data: dict[str, str] | None = None,
    terrain: TileSource | None = None,
    site_url: str | None = None,
    private: bool = False,
    landings: Sequence[FlightLandings | None] | None = None,
    trim_metres: float = 0,
) -> ExportResult:
    """Export the data, render the page and package its assets.

    Everything is staged first and published at the end (see ``SiteOutput``),
    so a failure at any step leaves the previous site in the output as it was.
    ``terrain`` is handed to ``export_all_data``, ``site_url`` (normalized,
    see ``previews.normalize_site_url``) to the link previews,
    ``trim_metres`` to ``_plan``.
    """
    plan = _plan(all_path_groups, all_path_metadata, landings, trim_metres=trim_metres)
    all_path_groups, all_path_metadata = plan.path_groups, plan.path_metadata
    extent, unique_airports, countries = (
        plan.extent,
        plan.unique_airports,
        plan.countries,
    )

    data_dir_name = data_dir.name
    # Read once: the day of map_config.js and that of the file times are
    # the same, and an invalid SOURCE_DATE_EPOCH is reported once
    built_at = build_time()
    with SiteOutput(
        output_file.parent,
        data_dir,
        SITE_FILES,
        SITE_FILE_PATTERNS,
        stable_mtimes=os.environ.get(STABLE_MTIMES_ENV) == "1",
        build_day=day_start(built_at),
        code_files=CODE_FILES,
    ) as site:
        result = export_all_data(
            all_path_groups,
            all_path_metadata,
            unique_airports,
            site.data_stage,
            aircraft_data=aircraft_data,
            exportable=plan.exportable,
            terrain=terrain,
            selection=plan.selection,
            available_flags=plan.available_flags,
            landings=plan.landings,
        )
        # The page opens on the latest year, see resolveYearSelection
        render_html(
            site.site_stage / output_file.name,
            data_dir_name,
            max(result.years, default=None),
            site_url,
            private,
        )
        package_assets(
            site.site_stage,
            extent,
            data_dir_name,
            countries,
            built_at,
        )
        write_previews(
            site.site_stage,
            all_path_groups,
            all_path_metadata,
            result.path_ids,
            exported_airport_names(unique_airports),
            site_url,
        )

        logger.info("\nPublishing the site to %s", output_file.parent)
        site.publish(result.years)

    return result


def foreign_output_error(output_file: str | Path, data_dir: str | Path) -> str | None:
    """Why a run must not write into the output directory, None when it may.

    It may not when it would replace files there that no earlier run wrote
    (see ``validation.foreign_site_files``).
    """
    output = Path(output_file)
    found = foreign_site_files(
        output.parent, data_dir, [output.name, *SITE_FILES], SITE_FILE_PATTERNS
    )
    if not found:
        return None
    return (
        f"Refusing to replace {len(found)} file(s) in {output.parent} that no "
        f"earlier run of flown wrote, such as {found[0]}: choose another "
        "output directory, or pass --force to replace them"
    )


def preflight(
    output_file: str | Path,
    data_dir: str | Path,
    inputs: Sequence[str | Path],
    force: bool = False,
) -> None:
    """Refuse a run that could not make a site, before it writes anything.

    Raises ``OutputRefusedError`` for an output directory that overlaps the
    ``inputs``, a data directory the page could not reach and files of a
    site no earlier run wrote (unless ``force``, see
    ``foreign_output_error``), and ``FlownError`` when the bundles are
    missing, which would make a page without its application.
    """
    output_dir = Path(output_file).resolve().parent
    if Path(data_dir).resolve().parent != output_dir:
        raise OutputRefusedError(
            f"The data directory {data_dir} must be directly inside the output "
            f"directory {output_dir}, where the page looks for it"
        )
    is_safe, error_msg = validate_output_dir(output_dir, inputs)
    if not is_safe:
        raise OutputRefusedError(error_msg or "Unsafe output directory")
    foreign = None if force else foreign_output_error(output_file, data_dir)
    if foreign:
        raise OutputRefusedError(foreign)
    missing = missing_build_files()
    if missing:
        raise FlownError(
            f"JavaScript bundle not found: {', '.join(missing)} (run 'npm run "
            "build' to generate it); the input files were left unchanged"
        )


def _validated_files(
    kml_files: list[str], skipped: list[SkippedFile] | None = None
) -> list[str]:
    """The inputs that are valid KML files; raises when any of them is not.

    A file that cannot be used fails the run: a site published without one
    of the flights, and exit status 0, would hide it until someone notices
    the flight is missing. So does a file that parses but holds no flight to
    export (see ``no_flight_reason``). With ``skipped``, an invalid file is
    left out instead and named there, unless none is valid (see
    ``_usable_results``).
    """
    valid_files = []
    invalid: list[SkippedFile] = []
    for kml_file in kml_files:
        is_valid, error_msg = validate_kml_file(kml_file)
        if not is_valid:
            logger.error("  %s", error_msg)
            invalid.append(SkippedFile(kml_file, error_msg or "not a valid KML file"))
        else:
            valid_files.append(kml_file)

    if skipped is not None and invalid:
        if not valid_files:
            raise InvalidInputError(_unusable_message(invalid))
        skipped.extend(invalid)
    elif invalid:
        raise InvalidInputError(
            f"{len(invalid)} of {len(kml_files)} input file(s) are not valid "
            f"KML files ({_some_names([entry.kml_file for entry in invalid])}, "
            "see above); fix or remove them"
        )

    # No input at all (a caller of the library; the CLI refuses it first)
    if not valid_files:
        raise InvalidInputError("No valid KML files to process!")
    return valid_files


@dataclass(frozen=True)
class FlightDataExport:
    """What ``export_flight_data`` wrote, and what the map opens on."""

    years: list[int]
    extent: CoordinateExtent
    airports: int
    flights: int
    # The files left out, with the reason, where the export skips them
    skipped: list[SkippedFile] = field(default_factory=list)


def export_flight_data(
    kml_files: list[str],
    data_dir: str | Path,
    aircraft_files: Sequence[Path] = (),
    terrain: TileSource | None = None,
    skip_unusable: bool = False,
    flags: Iterable[str] | None = None,
) -> FlightDataExport:
    """Write the data files of the flights into ``data_dir``, and nothing else.

    The page in the browser builds the flights someone drops on it this way
    (see ``flown.browser``): it has the page already, and needs the year
    files and the two index files of those flights, as ``export_all_data``
    writes them, plus the extent the map is fitted to, which
    ``map_config.js`` carries for a published site. ``data_dir`` is expected
    to be empty or missing. The inputs are validated and parsed as
    ``build_site`` does, and raise the same errors; with
    ``skip_unusable``, a file that cannot be used is left out instead and
    named in the result, as long as another one gives a flight. ``flags``
    are the country codes the page has a flag for, None for those of this
    checkout (see ``_plan``).
    """
    skipped: list[SkippedFile] | None = [] if skip_unusable else None
    valid_files = _validated_files(kml_files, skipped)
    logger.info("Parsing %d KML file(s)...", len(valid_files))
    try:
        try:
            all_path_groups, all_path_metadata, landings = _parse_kml_files(
                valid_files, skipped
            )
        except (ValueError, OSError) as e:
            raise ExportError(str(e)) from e
        plan = _plan(all_path_groups, all_path_metadata, landings, flags)
        aircraft_data = (
            merge_aircraft_data(list(aircraft_files)) if aircraft_files else None
        )
        try:
            result = export_all_data(
                plan.path_groups,
                plan.path_metadata,
                plan.unique_airports,
                data_dir,
                aircraft_data=aircraft_data,
                exportable=plan.exportable,
                terrain=terrain,
                selection=plan.selection,
                available_flags=plan.available_flags,
                landings=plan.landings,
            )
        except InvalidInputError:
            raise
        except (ValueError, RuntimeError, OSError, FlownError) as e:
            raise ExportError(f"Export failed: {e}") from e
        return FlightDataExport(
            years=result.years,
            extent=plan.extent,
            airports=len(plan.unique_airports),
            flights=len(plan.selection.exported()),
            skipped=skipped or [],
        )
    finally:
        gc.unfreeze()


def build_site(
    kml_files: list[str],
    output_file: str = "index.html",
    data_dir: str = "data",
    aircraft_files: list[Path] | None = None,
    terrain: TileSource | None = None,
    force: bool = False,
    site_url: str | None = None,
    private: bool = False,
    trim_ends: float = 0,
) -> ExportResult:
    """Generate the site: the page, its assets and the data files.

    Returns what the export produced. Raises ``InvalidInputError`` for
    inputs that cannot make a site (a missing or invalid KML file, one
    without a flight, a relative ``site_url``), ``OutputRefusedError`` for an
    output directory it must not write, ``ExportError`` when writing the
    site failed on the way, and ``FlownError`` for the rest (a missing
    bundle, a required database or tile that is unavailable). A previous
    site in the output is then left as it was.

    ``terrain`` is where the ground under the flights comes from (see
    ``flown.terrain``). The default, None, leaves it out of the year
    files; the command line passes ``TerrariumTiles`` unless told not to.

    An output directory with files of a site that no earlier run wrote (an
    ``index.html`` of its own, see ``foreign_output_error``) is refused
    unless ``force`` is set.

    ``site_url`` is the public address of the site, which its link preview
    images are named by (see ``previews``); None takes it from
    ``FLOWN_SITE_URL``, and without either the pages go without
    images. ``private`` asks search engines not to index the site (a robots
    meta tag in the page). ``trim_ends`` leaves out the ground of every
    flight before its takeoff and after its landing, and its points within
    that many metres of where the rest starts and ends (see
    ``geometry.trim_path_ends``): the taxiing, and the spot the aircraft is
    parked on.
    """
    if trim_ends < 0:
        raise InvalidInputError(f"trim_ends must not be negative, not {trim_ends}")
    aircraft_files = aircraft_files or []
    try:
        site_url = normalize_site_url(
            site_url if site_url is not None else os.environ.get(SITE_URL_ENV)
        )
    except ValueError as e:
        raise InvalidInputError(str(e)) from None

    # Stage 0: Refuse a run that could not make a site
    preflight(output_file, data_dir, [*kml_files, *aircraft_files], force)
    warn_about_a_stale_bundle()

    # Stage 1: Validate and parse
    valid_files = _validated_files(kml_files)

    logger.info("Parsing %d KML file(s)...", len(valid_files))

    try:
        try:
            all_path_groups, all_path_metadata, landings = _parse_kml_files(valid_files)
        except (ValueError, OSError) as e:
            raise ExportError(str(e)) from e

        # Stage 2: Export the data, the page and the assets
        aircraft_data = merge_aircraft_data(aircraft_files) if aircraft_files else None
        try:
            result = _export_site(
                all_path_groups,
                all_path_metadata,
                Path(output_file),
                Path(data_dir),
                aircraft_data=aircraft_data,
                terrain=terrain,
                site_url=site_url,
                private=private,
                landings=landings,
                trim_metres=trim_ends,
            )
        except InvalidInputError, OutputRefusedError:
            raise
        except (ValueError, RuntimeError, OSError, FlownError) as e:
            raise ExportError(f"Export failed: {e}") from e

        logger.info("  %s", _serve_hint(output_file))
        return result
    finally:
        # The parsed flights go back to the collector (see _collector_paused)
        gc.unfreeze()
