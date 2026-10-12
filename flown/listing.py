"""What ``--list`` shows: every flight of the inputs and what the site makes of it.

The files are parsed as a build parses them (see ``renderer``), without
writing anything but the parse cache, and a file the build would refuse is
marked as one.
"""

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .airport_lookup import load_airport_database, load_runway_database
from .airports import deduplicate_airports
from .data_exporter import ExportSelection, select_exported_paths
from .date_tokens import strip_dates
from .export_writers import free_text_airport_names
from .path_content import is_exportable_path
from .renderer import ParsedFile, no_flight_reason, parse_files
from .validation import validate_kml_file

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .types import FlightPathGroup, PathMetadata

__all__ = ["FlightListing", "Listing", "list_flights"]


@dataclass(frozen=True)
class FlightListing:
    """One row of ``--list``: a path of an input file, or a file without one."""

    file: str
    year: int | None = None
    aircraft: str = ""
    airports: str = ""
    points: int = 0
    timed: bool = False
    #: Why the site leaves it out, "" for a path it publishes
    skipped: str = ""
    #: Whether a build refuses the file, and with it the whole run: an
    #: invalid file, one that does not parse and one without a flight
    fails_build: bool = False


@dataclass(frozen=True)
class Listing:
    """What ``--list`` prints: a row per path, and the free-text airports.

    ``free_text_airports`` are the airport names the site would publish
    not from the airport database (see ``export_writers.free_text_airport_names``).
    """

    rows: list[FlightListing]
    free_text_airports: list[str] = field(default_factory=list)

    @property
    def failing_files(self) -> list[str]:
        """The files a build would refuse, which fails it and publishes nothing."""
        return list(dict.fromkeys(row.file for row in self.rows if row.fails_build))


def _listed_airports(metadata: PathMetadata) -> str:
    """The airports of a path as the site names them: without their dates.

    ``export_pipeline`` and ``airports`` take the dates, times and weekdays
    out of what they publish (``date_tokens.strip_dates``), so the list does
    as well; a name with nothing left is "?".
    """
    start, end = metadata.get("start_airport"), metadata.get("end_airport")
    if start or end:
        return f"{strip_dates(start) or '?'} - {strip_dates(end) or '?'}"
    return strip_dates(metadata.get("airport_name")) or ""


def _listed_paths(
    parsed: list[ParsedFile],
) -> tuple[FlightPathGroup, list[PathMetadata], list[str]]:
    """Every path of the parsed files, with the file each came from."""
    paths: FlightPathGroup = []
    metadata: list[PathMetadata] = []
    files: list[str] = []
    for entry in parsed:
        paths.extend(entry.path_groups)
        metadata.extend(entry.path_metadata)
        files.extend([entry.kml_file] * len(entry.path_groups))
    return paths, metadata, files


def _skip_reason(
    index: int,
    exportable: bool,
    selection: ExportSelection,
    exported: set[int],
    metadata: PathMetadata,
) -> str:
    """Why the path at ``index`` is not published, "" when it is."""
    if metadata.get("year") is None:
        return "no determinable year"
    if not exportable:
        return "stays on one spot"
    if index in exported:
        return ""
    # Copies are looked for across the years (see drop_duplicate_paths)
    content = selection.contents.get(index)
    if content is not None and any(
        other in exported and other_content == content
        for other, other_content in selection.contents.items()
    ):
        return "an exact copy of another file's flight"
    return "the same flight as another recording"


def list_flights(kml_files: Sequence[str]) -> Listing:
    """What the site would hold of every file, without writing anything.

    Every path gets a row with its year, aircraft, airports (as the site
    names them) and points, whether it has times, and the reason it would
    be left out; a file that is invalid, does not parse or holds no path
    gets a row of its own. The rows of a file the build refuses are marked
    (``FlightListing.fails_build``), as the build fails then. The files are
    parsed as a build parses them (through the parse cache, the misses in a
    process pool when there are many), and the copies and second recordings
    are found the same way (``select_exported_paths``), as are the
    airports, of which the ones not from the airport database are listed
    too. No elevation tile is fetched and nothing is written but the parse
    cache.
    """
    rows: list[FlightListing] = []
    parsed: list[ParsedFile] = []
    # Once, before the files: its download messages come first, and the
    # parse cache keys see the same database as a build
    airports_database = load_airport_database()
    load_runway_database()
    valid_files = []
    for kml_file in kml_files:
        is_valid, error_msg = validate_kml_file(kml_file)
        if is_valid:
            valid_files.append(kml_file)
        else:
            rows.append(
                FlightListing(
                    kml_file, skipped=error_msg or "not valid", fails_build=True
                )
            )
    # The files without a flight fail the build, see renderer._parse_kml_files
    failing: set[str] = set()
    for entry in parse_files(valid_files, airports_database):
        reason = (
            "failed to parse" if entry.point_count == 0 else no_flight_reason(entry)
        )
        if not entry.path_groups:
            rows.append(
                FlightListing(entry.kml_file, skipped=reason or "", fails_build=True)
            )
            continue
        if reason is not None:
            failing.add(entry.kml_file)
        parsed.append(entry)

    paths, metadata, files = _listed_paths(parsed)
    exportable = [is_exportable_path(path) for path in paths]
    selection = select_exported_paths(paths, metadata, exportable)
    exported = set(selection.exported())
    for index, (path, meta) in enumerate(zip(paths, metadata, strict=True)):
        rows.append(
            FlightListing(
                file=files[index],
                year=meta.get("year"),
                aircraft=meta.get("aircraft_registration")
                or meta.get("aircraft_type")
                or "",
                airports=_listed_airports(meta),
                points=len(path),
                timed=any(point.ts is not None for point in path),
                skipped=_skip_reason(
                    index, exportable[index], selection, exported, meta
                ),
                fails_build=files[index] in failing,
            )
        )
    order = {kml_file: position for position, kml_file in enumerate(kml_files)}
    rows.sort(key=lambda row: order.get(row.file, len(order)))
    # The airports of the build: those of the published paths alone
    published = selection.exported()
    airports = deduplicate_airports(
        [metadata[index] for index in published], [paths[index] for index in published]
    )
    return Listing(rows, free_text_airport_names(airports))
