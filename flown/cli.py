"""Command-line interface.

The exit status tells what went wrong: 0 for a site written (or a listing
printed of inputs a build accepts), 2 for a problem with what the command
was given (a usage error, a missing or invalid input, a listing of inputs a
build would refuse, an output directory it must not write), 1 for a
build that failed on the way and 130 when it was interrupted. Every failure
ends in one line on stderr.
"""

import argparse
import logging
import math
import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, NoReturn

from . import __version__
from .constants import CACHE_DIR_ENV
from .exceptions import (
    FlownError,
    InvalidInputError,
    OutputRefusedError,
)
from .logger import logger, set_debug_mode, set_info_stream, set_log_level
from .validation import find_kml_files, validate_kml_file

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .listing import FlightListing

# Obfuscation violations listed per file before the rest are summarized
MAX_REPORTED_VIOLATIONS = 5

# The exit statuses (see the module)
EXIT_FAILED = 1
EXIT_USAGE = 2
EXIT_INTERRUPTED = 130


# What the environment variables were called before the rename to Flown
OLD_ENV_PREFIX = "KML_HEATMAP_"


def _old_cache_dir() -> Path | None:
    """Where kml-heatmap kept its cache, None without a home (containers)."""
    try:
        return Path.home() / ".cache" / "kml-heatmap"
    except RuntimeError:
        return None


def _warn_about_old_names() -> None:
    """Say what the rename from kml-heatmap left behind, which nothing reads.

    A deploy that set ``KML_HEATMAP_REQUIRE_AIRPORT_DB=1`` to fail without
    the airport database would now publish without it, without a word; the
    old cache directory keeps the parsed flights, real dates among them,
    that nothing reads or prunes any more.
    """
    old = sorted(name for name in os.environ if name.startswith(OLD_ENV_PREFIX))
    if old:
        logger.warning(
            "%s %s no longer read; rename %s",
            ", ".join(old),
            "is" if len(old) == 1 else "are",
            ", ".join(
                f"{name} to {name.replace(OLD_ENV_PREFIX, 'FLOWN_', 1)}" for name in old
            ),
        )
    old_cache = _old_cache_dir()
    if old_cache is not None and old_cache.is_dir():
        logger.warning(
            "%s is the cache of kml-heatmap, which Flown does not read; it "
            "holds parsed flights with their dates, and can be removed",
            old_cache,
        )


def _fatal(message: str, status: int = EXIT_FAILED) -> NoReturn:
    """Print a fatal error to stderr and exit."""
    print(f"Error: {message}", file=sys.stderr)
    sys.exit(status)


def _collect_kml_files(paths: list[str]) -> tuple[list[str], dict[str, Path]]:
    """Resolve KML files from file and directory arguments.

    A directory is searched with its subdirectories (see ``find_kml_files``,
    which the obfuscation check uses as well). A file named more than once
    (directly, or through its directory) is processed once; it would otherwise
    be counted twice in every statistic. Paths are normalized but symlinks are
    not followed: a symlink is rejected by the validation later and must not
    shadow its target here.

    Also returns the input root of every file: the directory argument it was
    found in, or its own directory for a file named directly, which is as
    far up as ``_find_aircraft_files`` looks.
    """
    kml_files: list[str] = []
    roots: dict[str, Path] = {}
    seen: set[str] = set()

    def add(kml_file: str, root: Path) -> None:
        normalized = os.path.abspath(kml_file)
        if normalized in seen:
            logger.warning("Ignoring duplicate input: %s", kml_file)
            return
        seen.add(normalized)
        kml_files.append(kml_file)
        roots[kml_file] = root

    for path in paths:
        p = Path(path)
        if p.is_dir():
            dir_kml_files = [str(f) for f in find_kml_files(p)]
            if dir_kml_files:
                for kml_file in dir_kml_files:
                    add(kml_file, p)
                logger.info(
                    "Found %d KML file(s) in directory: %s", len(dir_kml_files), path
                )
            else:
                logger.warning("No KML files found in directory: %s", path)
        elif p.is_file():
            add(path, p.parent)
        else:
            # A mistyped input would otherwise publish a site without it
            raise InvalidInputError(f"File or directory not found: {path}")
    return kml_files, roots


def _find_aircraft_files(
    kml_files: list[str], roots: dict[str, Path] | None = None
) -> list[Path]:
    """The aircraft.json files for the inputs, the nearest one first.

    For every file (in input order) its own directory and each one above it
    up to and including the input root it was found in (``roots``, its own
    directory by default): an aircraft.json next to data/ covers the flights
    in data/2025/ as well. ``merge_aircraft_data`` lets the first file win,
    so a file in a subdirectory is put before the ones of the directories
    above it, and otherwise the files keep the order they were found in.
    """
    roots = roots or {}
    aircraft_files: list[Path] = []
    seen: set[Path] = set()
    for kml_file in kml_files:
        directory = Path(kml_file).resolve().parent
        root = roots.get(kml_file, Path(kml_file).parent).resolve()
        for candidate_dir in (directory, *directory.parents):
            candidate = candidate_dir / "aircraft.json"
            if candidate_dir not in seen and candidate.is_file():
                # Before the first file of a directory above it, if any
                position = next(
                    (
                        index
                        for index, found in enumerate(aircraft_files)
                        if found.parent in candidate_dir.parents
                    ),
                    len(aircraft_files),
                )
                aircraft_files.insert(position, candidate)
                logger.info("Using aircraft data from %s", candidate)
            seen.add(candidate_dir)
            if candidate_dir == root or root not in candidate_dir.parents:
                break
    return aircraft_files


def _obfuscate_inputs(kml_files: list[str]) -> list[str]:
    """Rename and rewrite the (validated) input KML files in place for privacy.

    Only runs with ``--obfuscate-inputs``; see ``_generate``. Returns
    ``kml_files`` with the new path of every renamed file. Raises
    when a file cannot be rewritten: leaving a file the user asked to scrub
    with its real dates would be worse than not running at all.
    """
    # Reads the cache directory at import, which --cache-dir sets first
    from .obfuscate import (  # noqa: PLC0415
        check_kml_obfuscated,
        obfuscate_kml_files,
        rename_dated_files,
    )

    valid: list[Path] = []
    valid_names: list[str] = []
    for kml_file in kml_files:
        is_valid, error_msg = validate_kml_file(kml_file)
        if is_valid:
            valid.append(Path(kml_file))
            valid_names.append(kml_file)
        else:
            # An invalid file fails the run later, before anything is
            # published, so it cannot leak anything
            logger.warning("Not obfuscating: %s", error_msg)

    renamed = rename_dated_files(valid)
    # Keyed by the given spelling: Path() would normalize "./a.kml" to "a.kml"
    new_names = {
        name: str(new)
        for name, old, new in zip(valid_names, valid, renamed, strict=True)
        if new != old
    }
    modified = obfuscate_kml_files(renamed)
    logger.info("Obfuscated %d of %d KML file(s) in place", modified, len(renamed))

    failed = False
    for path in renamed:
        violations = check_kml_obfuscated(path)
        if not violations:
            continue
        failed = True
        logger.error("Not obfuscated: %s", path)
        for violation in violations[:MAX_REPORTED_VIOLATIONS]:
            logger.error("  %s", violation)
        if len(violations) > MAX_REPORTED_VIOLATIONS:
            logger.error("  ... and %d more", len(violations) - MAX_REPORTED_VIOLATIONS)
    if failed:
        raise FlownError(
            "Could not obfuscate every input file; refusing to continue. See "
            "the messages above: a file that is read-only or not UTF-8 has to "
            "be fixed first, and a date in a place the tool does not rewrite "
            "(such as extended data, or a file name that is taken without "
            "it) has to be removed by hand"
        )

    return [new_names.get(kml_file, kml_file) for kml_file in kml_files]


def _symbol(row: FlightListing) -> str:
    """The mark of a row: a symbol on a terminal, ASCII anywhere else.

    Published, left out, or failing the build.
    """
    kind = 2 if row.fails_build else 1 if row.skipped else 0
    if sys.stdout.isatty():
        return ("✓", "⚠", "✗")[kind]
    return ("ok", "--", "!!")[kind]


def _note(row: FlightListing) -> str:
    if row.fails_build:
        return f"fails the build: {row.skipped}" if row.skipped else "fails the build"
    return row.skipped or "published"


def format_listing(
    rows: Sequence[FlightListing], free_text_airports: Sequence[str] = ()
) -> str:
    """The ``--list`` table: one line per path, and per file without one.

    ``free_text_airports`` are the airport names the site would publish
    not from the airport database, named below the table.
    """
    header = ("", "file", "year", "aircraft", "airports", "points", "timed", "note")
    lines = [
        (
            _symbol(row),
            Path(row.file).name,
            str(row.year) if row.year is not None else "-",
            row.aircraft or "-",
            row.airports or "-",
            str(row.points),
            "yes" if row.timed else "no",
            _note(row),
        )
        for row in rows
    ]
    # Every column but the note, which ends the line, as wide as its widest
    padded = len(header) - 1
    widths = [max(len(line[i]) for line in [header, *lines]) for i in range(padded)]
    text = [
        "  ".join(
            [
                *(
                    cell.ljust(width)
                    for cell, width in zip(line[:padded], widths, strict=True)
                ),
                line[padded],
            ]
        ).rstrip()
        for line in [header, *lines]
    ]
    failing = len({row.file for row in rows if row.fails_build})
    if failing:
        # the pipeline refuses the run: nothing is published, not the rest either
        text.append(
            f"A build would fail on {failing} file(s) and publish nothing: "
            "fix or remove them"
        )
    else:
        published = sum(1 for row in rows if not row.skipped)
        text.append(f"{published} of {len(rows)} flight(s) would be published")
    if free_text_airports:
        text.append(
            "Airport names not from the airport database that would be published, "
            "as the route names give them: "
            + ", ".join(repr(name) for name in free_text_airports)
        )
    return "\n".join(text)


def _list(paths: list[str], trim_ends: float = 0) -> None:
    """Print what a build of ``paths`` would publish, and write nothing.

    ``trim_ends`` as for the build (see ``_generate``).
    """
    # Needs lxml and reads the cache directory, see _generate
    from .listing import list_flights  # noqa: PLC0415

    kml_files, _ = _collect_kml_files(paths)
    if not kml_files:
        raise InvalidInputError("No KML files specified or found!")
    listing = list_flights(kml_files, trim_ends)
    print(format_listing(listing.rows, listing.free_text_airports))
    failing = listing.failing_files
    if failing:
        # The exit status of the build it lists
        raise InvalidInputError(
            f"{len(failing)} of {len(kml_files)} input file(s) would fail the "
            "build (see the list)"
        )


def _generate(
    paths: list[str],
    output_dir: Path,
    obfuscate_inputs: bool,
    terrain: bool = True,
    force: bool = False,
    site_url: str | None = None,
    private: bool = False,
    quiet: bool = False,
    trim_ends: float = 0,
) -> None:
    """Generate the site into ``output_dir``.

    ``terrain`` samples the ground under the flights from the elevation
    tiles of AWS (see ``flown.terrain``), which are downloaded once
    into the cache directory. ``force`` replaces the files of a site that
    no earlier run wrote (see ``pipeline.foreign_output_error``).
    ``site_url`` is where the site is published, which its link preview
    images are named by (see ``flown.previews``); None takes it from
    ``FLOWN_SITE_URL``. ``private`` asks search engines not to index
    the site. ``quiet`` leaves out the banner and prints one line at the end.
    ``trim_ends`` leaves out the points of every flight within that many
    metres of where it starts and ends (see ``geometry.trim_path_ends``).

    The generated site never carries a flight date finer than the year,
    whatever the inputs hold: the exported paths keep their year, their
    relative timing and nothing else (see ``data_exporter``). Rewriting the
    inputs is therefore not needed to publish safely and is not done unless
    ``obfuscate_inputs`` asks for it, because it cannot be undone.

    The modules below are imported here rather than at the top: they need
    lxml and the minifiers, which ``--help`` and ``--version`` do not, and
    they read the cache directory, which ``--cache-dir`` sets first.
    """
    # See the docstring: lxml, the minifiers and the cache directory
    from .previews import SITE_URL_ENV, normalize_site_url  # noqa: PLC0415

    try:
        site_url = normalize_site_url(
            site_url if site_url is not None else os.environ.get(SITE_URL_ENV)
        )
    except ValueError as e:
        raise InvalidInputError(str(e)) from None

    kml_files, roots = _collect_kml_files(paths)

    if not kml_files:
        raise InvalidInputError("No KML files specified or found!")

    if not quiet:
        print("\nFlown")
        print(f"{'=' * 50}\n")

    output_file = str(output_dir / "index.html")
    data_dir = str(output_dir / "data")

    aircraft_files = _find_aircraft_files(kml_files, roots)

    # Lazy for the same reasons as the previews above
    from .pipeline import build_site, preflight  # noqa: PLC0415

    # Checked again inside build_site, which is public API;
    # checking here stops before --obfuscate-inputs rewrites the inputs
    preflight(output_file, data_dir, [*kml_files, *aircraft_files], force)

    output_dir.mkdir(parents=True, exist_ok=True)

    if obfuscate_inputs:
        kml_files = _obfuscate_inputs(kml_files)

    # Reads the cache directory at import, like the others above
    from .terrain import TerrariumTiles  # noqa: PLC0415

    result = build_site(
        kml_files,
        output_file,
        data_dir,
        aircraft_files=aircraft_files,
        terrain=TerrariumTiles() if terrain else None,
        force=force,
        # "" rather than None: resolved above, the environment is not read
        # a second time
        site_url=site_url or "",
        private=private,
        trim_ends=trim_ends,
    )
    if quiet:
        # The line the quiet run is for: where the site went
        years = ", ".join(str(year) for year in result.years)
        print(f"Wrote the site to {output_dir} ({years})")


def _refresh_airports() -> None:
    """Mark the cached OurAirports files expired, so the run downloads them.

    The files stay until a download replaces them: offline, the run goes on
    with them and says so (see ``airport_lookup._ensure_cache_file``).
    """
    # Reads the cache directory at import, which --cache-dir sets first
    from .airport_lookup import refresh_airport_databases  # noqa: PLC0415

    refresh_airport_databases()
    logger.info("Marked the cached airport database for a fresh download")


def _metres(text: str) -> float:
    """``--trim-ends``: a distance of at least 0 metres."""
    try:
        metres = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number of metres: {text!r}") from None
    if not math.isfinite(metres) or metres < 0:
        raise argparse.ArgumentTypeError(f"must be at least 0, not {text}")
    return metres


def _jobs(text: str) -> int:
    """``--jobs``: a whole number of at least 1."""
    try:
        jobs = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number: {text!r}") from None
    if jobs < 1:
        raise argparse.ArgumentTypeError(f"must be at least 1, not {jobs}")
    return jobs


def build_parser() -> argparse.ArgumentParser:
    """The command line's arguments, grouped as ``--help`` shows them."""
    parser = argparse.ArgumentParser(
        prog="flown",
        description="Turn KML flight logs into a static site of where you have flown.",
        epilog="""
examples:
  %(prog)s flight.kml --output-dir out
  %(prog)s ./my_flights/ --output-dir out
  %(prog)s *.kml --output-dir mymap
  %(prog)s --list ./my_flights/
  %(prog)s --debug problematic.kml --output-dir out
  %(prog)s --obfuscate-inputs ./my_flights/ --output-dir out

The input KML files are read and left alone. The generated site never carries
a flight date finer than the year in the first place: a flight keeps its year
and the intervals between its points, and every absolute timestamp is dropped
on export. The only full date that depends on the flights is the day the
site was built.

--obfuscate-inputs additionally rewrites the input files THEMSELVES, IN PLACE
and IRREVERSIBLY, so that the files on disk carry no real dates either (useful
before committing or sharing them). All timestamps and dates are shifted so
that every flight starts at midnight (UTC) on January 1st of its year, which
keeps the intervals between its points but neither its date nor its time of
day, and the creator attribute is replaced. Names and descriptions lose
their other dates and times. Charterware files are renamed to January 1st as
well (2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml becomes 2026-01-01_0000h_...),
and other file names lose their dates (1_DEHYL_DA40_16Aug.kml becomes
1_DEHYL_DA40.kml). Keep a copy of the originals if you need the real
dates. The same rewrite is available on its own, without generating a site, as
`python -m flown.obfuscate <dir>`.

The output directory must not be the directory of an input file, or contain
one: the tool replaces and removes its own files in there. An output
directory below the directory of an input file is fine, so `flown
flight.kml` in the file's directory writes to ./docs. A
run that fails while generating the site leaves the previous site in the
output directory untouched. An output directory with files of another site
(an index.html, a styles.css) and no sign of an earlier run of this tool
(map_config.js, data/metadata.json) is refused unless --force is given.

exit status: 0 on success, 2 for a usage error, a missing or invalid input or
a refused output directory, 1 when the build failed, 130 when interrupted.
""",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "paths",
        nargs="+",
        metavar="path",
        help="KML or KMZ file(s) or directory containing them",
    )
    parser.add_argument(
        "--version",
        action="version",
        version=f"%(prog)s {__version__}",
    )

    output = parser.add_argument_group("output")
    output.add_argument(
        "--output-dir",
        metavar="DIR",
        default="docs",
        help="output directory (default: docs)",
    )
    output.add_argument(
        "--force",
        action="store_true",
        help=(
            "replace the files of a site in the output directory that no "
            "earlier run of this tool wrote (such as an index.html of its own)"
        ),
    )
    output.add_argument(
        "--site-url",
        metavar="URL",
        help=(
            "the address the site is published at, such as "
            "https://example.org/flights (default: $FLOWN_SITE_URL); "
            "with it every year and flight gets a link preview image, "
            "which needs an absolute URL"
        ),
    )
    output.add_argument(
        "--list",
        action="store_true",
        help=(
            "list every flight of the inputs with its year, aircraft, "
            "airports and points, why any would be left out, and the airport "
            "names not from the airport database it would publish; writes no site and "
            "downloads no elevation tiles"
        ),
    )
    output.add_argument(
        "-q",
        "--quiet",
        action="store_true",
        help="print warnings and errors only, and one line at the end",
    )
    output.add_argument(
        "--debug",
        action="store_true",
        help="enable debug output to diagnose parsing issues",
    )

    privacy = parser.add_argument_group("privacy")
    privacy.add_argument(
        "--obfuscate-inputs",
        action="store_true",
        help=(
            "also rewrite the input KML files in place, irreversibly, so that "
            "they carry no real dates either (the generated site never does); "
            "keep a copy of the originals first"
        ),
    )
    privacy.add_argument(
        "--private",
        action="store_true",
        help=(
            "ask search engines not to index the site (a robots meta tag in "
            "the page); it is still public to anyone with the address"
        ),
    )

    privacy.add_argument(
        "--trim-ends",
        metavar="METRES",
        type=_metres,
        default=0,
        help=(
            "leave out the points of every flight within METRES of where it "
            "starts and ends, so the taxiing and the spot the aircraft is "
            "parked on are not published (300 covers most; default: 0, keep "
            "them)"
        ),
    )

    network = parser.add_argument_group("network and cache")
    network.add_argument(
        "--no-terrain",
        dest="terrain",
        action="store_false",
        help=(
            "do not sample the ground under the flights from elevation tiles; "
            "the 3D view then puts each flight on a line between its airfields "
            "(the tiles of the flown area are otherwise downloaded once from "
            "AWS and cached)"
        ),
    )
    network.add_argument(
        "--cache-dir",
        metavar="DIR",
        help=(
            "where the airport database, the elevation tiles, the link "
            "preview images and the parse cache are kept (default: "
            "$FLOWN_CACHE_DIR, else ~/.cache/flown)"
        ),
    )
    network.add_argument(
        "--refresh-airports",
        action="store_true",
        help=(
            "download the OurAirports database again instead of using the "
            "cached copy (renewed every 30 days otherwise)"
        ),
    )
    network.add_argument(
        "--jobs",
        metavar="N",
        type=_jobs,
        help="use at most N worker processes (default: one per CPU)",
    )
    return parser


def main() -> None:
    """Main CLI entry point; exits with the status the module describes."""
    # argparse exits with 2 on a usage error by itself
    parser = build_parser()
    args = parser.parse_args()
    if args.list and args.obfuscate_inputs:
        # --list writes nothing: the inputs would keep the real dates the
        # run was asked to take out of them, without a word
        parser.error(
            "--list writes nothing and cannot rewrite the inputs; run "
            "--obfuscate-inputs without it"
        )

    if args.debug:
        set_debug_mode(True)
    elif args.quiet:
        set_log_level(logging.WARNING)
    # The table of --list goes to stdout alone, so it can be piped or saved
    set_info_stream("stderr" if args.list else "stdout")
    _warn_about_old_names()
    if args.cache_dir:
        # Before anything reads it: flown.cache does at import
        os.environ[CACHE_DIR_ENV] = str(Path(args.cache_dir).expanduser().resolve())
    if args.jobs:
        # After --cache-dir: workers imports the airport lookup, which
        # reads the cache directory at import
        from .workers import configure_workers  # noqa: PLC0415

        configure_workers(args.jobs)

    try:
        if args.refresh_airports:
            _refresh_airports()
        if args.list:
            _list(args.paths, args.trim_ends)
            return
        _generate(
            args.paths,
            Path(args.output_dir),
            args.obfuscate_inputs,
            args.terrain,
            args.force,
            args.site_url,
            args.private,
            args.quiet and not args.debug,
            args.trim_ends,
        )
    except KeyboardInterrupt:
        _fatal("Interrupted", EXIT_INTERRUPTED)
    except (InvalidInputError, OutputRefusedError) as e:
        _fatal(str(e), EXIT_USAGE)
    except (FlownError, OSError) as e:
        # Expected failures (an unwritable output directory, a missing airport
        # database) end in one line instead of a traceback
        _fatal(str(e))
