"""Input validation utilities."""

import contextlib
import json
import os
import re
from pathlib import Path, PurePath
from typing import TYPE_CHECKING, NamedTuple

from .helpers import numeric_filename_key
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Iterable

MAX_KML_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
# The extensions of the inputs: KML, and KMZ (a zip archive holding a KML
# file, see parser._read_kmz), in any case
KML_SUFFIXES = (".kml", ".kmz")

# Files that only a site of this tool has, relative to the output directory
# and to the data directory: where either is, the site is ours to replace.
# Another site may have a file by either name, so each must also read as
# this tool writes it (see _is_marker)
SITE_MARKERS = ("map_config.js",)
DATA_MARKERS = ("metadata.json",)
# How map_config.js starts: the assignment of the configuration, after the
# comment lines the template of the builds before 2026-10-02 had
_SITE_MARKER_START = re.compile(rb"(?:\s*//[^\n]*\n)*\s*window\.MAP_CONFIG\s*=")
# The most of map_config.js read to find it
_MAX_SITE_MARKER_BYTES = 4096
_DATA_MARKER_KEYS = ("available_years", "year_file_bytes")
# Larger than any metadata.json of a site: it lists the years and aircraft
_MAX_DATA_MARKER_BYTES = 1024 * 1024
# The data files a run owns besides its markers
_OWNED_DATA_FILES = ("airports.json", "metadata.json", "[0-9][0-9][0-9][0-9]/data.json")

__all__ = [
    "KML_SUFFIXES",
    "SITE_MARKERS",
    "find_kml_files",
    "foreign_site_files",
    "is_protected_directory",
    "protected_directories",
    "validate_kml_file",
    "validate_output_dir",
]


def validate_kml_file(file_path: str) -> tuple[bool, str | None]:
    """Validate KML file exists and is readable."""
    path = Path(file_path)

    if path.is_symlink():
        return False, f"Symlinks are not allowed: {file_path}"

    if not path.exists():
        return False, f"File not found: {file_path}"

    if not path.is_file():
        return False, f"Not a file: {file_path}"

    if not os.access(path, os.R_OK):
        return False, f"File not readable: {file_path}"

    if not str(path).lower().endswith(KML_SUFFIXES):
        return False, f"File does not have a .kml or .kmz extension: {file_path}"

    file_size = path.stat().st_size
    if file_size == 0:
        return False, f"File is empty: {file_path}"

    if file_size > MAX_KML_FILE_SIZE:
        size_mb = file_size / 1024 / 1024
        max_mb = MAX_KML_FILE_SIZE / 1024 / 1024
        return (
            False,
            f"File too large ({size_mb:.1f} MB, max {max_mb:.0f} MB): {file_path}",
        )

    return True, None


class KmlListing(NamedTuple):
    """The KML files of a directory tree, and the directories not listed."""

    files: list[Path]
    unlisted: list[Path]


def list_kml_files(directory: Path) -> KmlListing:
    """List the KML files of a directory tree, the one rule for every caller.

    The generator and the obfuscation pass (with its check) have to agree on
    which files a directory holds: a file the check never saw would otherwise
    be published with its real dates. Files match on the ``.kml`` and
    ``.kmz`` extensions in any case (the obfuscator refuses a KMZ it cannot
    rewrite, and its check reports one) and are listed per directory in
    numeric order (``2_x.kml``
    before ``10_x.kml``), subdirectories after the files of their parent.
    Symlinks to files are listed so that the caller can refuse or skip them;
    symlinks to directories are not followed. A directory that cannot be
    listed yields no files, with a warning, and comes back in ``unlisted``:
    the check has to fail on it rather than certify the files it never saw.
    The AppleDouble files macOS writes next to every
    file on a foreign disk (``._1_x.kml``) are left out, being no KML, and
    so is ``.git``, which holds no flights. Other hidden files and
    directories are listed: the check has to see every file a build reads.
    """
    listing = KmlListing([], [])
    _collect_kml_files(directory, listing)
    return listing


def find_kml_files(directory: Path) -> list[Path]:
    """The files of ``list_kml_files``, for a caller that only reads them."""
    return list_kml_files(directory).files


def _collect_kml_files(directory: Path, listing: KmlListing) -> None:
    try:
        entries = [
            entry
            for entry in directory.iterdir()
            if not entry.name.startswith("._") and entry.name != ".git"
        ]
    except OSError as e:
        logger.warning("Cannot list %s: %s", directory, e)
        listing.unlisted.append(directory)
        return

    listing.files.extend(
        sorted(
            (
                path
                for path in entries
                if path.suffix.lower() in KML_SUFFIXES
                and (path.is_file() or path.is_symlink())
            ),
            key=lambda path: numeric_filename_key(path.name),
        )
    )
    for child in sorted(entries):
        if child.is_dir() and not child.is_symlink():
            _collect_kml_files(child, listing)


def protected_directories() -> tuple[Path, ...]:
    """Directories that must never be used as an output directory.

    Resolved, like the output directory they are compared with: a home
    directory that is a symlink (or a HOME set to one) is its target there.
    """
    protected = [Path("/")]
    # No HOME and no passwd entry (containers)
    with contextlib.suppress(RuntimeError):
        protected.append(Path.home())
    return tuple(dict.fromkeys(directory.resolve() for directory in protected))


def is_protected_directory(resolved: PurePath) -> bool:
    """Whether a resolved directory must never be used as an output directory.

    The root of every file system counts, not only the one of
    ``protected_directories``: "/" resolves to the root of the current drive
    on Windows, and every other drive and network share has a root of its
    own.
    """
    return resolved.parent == resolved or resolved in protected_directories()


def foreign_site_files(
    output_dir: str | Path,
    data_dir: str | Path,
    owned: Iterable[str],
    owned_patterns: Iterable[str] = (),
) -> list[Path]:
    """The files a run would replace in a directory that holds no site of it.

    ``owned`` are the files a run writes into ``output_dir`` (relative to it,
    with forward slashes), ``owned_patterns`` glob patterns of those whose
    names are not known in advance. A run replaces them by name, and
    ``docs``, the default output directory, is where many a project keeps a
    site of its own: an ``index.html`` there is somebody else's, unless the
    directory has the marks of an earlier run (``SITE_MARKERS`` in it, or
    ``DATA_MARKERS`` in ``data_dir``). Empty when there is such a mark or
    nothing would be replaced.
    """
    output = Path(output_dir)
    data = Path(data_dir)
    if any(_is_marker(output / name) for name in SITE_MARKERS) or any(
        _is_marker(data / name) for name in DATA_MARKERS
    ):
        return []
    found = [
        output / name
        for name in owned
        if (output / name).exists() or (output / name).is_symlink()
    ]
    for directory, patterns in (
        (output, owned_patterns),
        (data, _OWNED_DATA_FILES),
    ):
        with contextlib.suppress(OSError):
            for pattern in patterns:
                found.extend(sorted(directory.glob(pattern)))
    return list(dict.fromkeys(found))


def _is_marker(path: Path) -> bool:
    """Whether a marker file is one this tool wrote, by what it holds.

    ``map_config.js`` starts with the assignment of the configuration,
    ``metadata.json`` is an object with the years of the site.
    """
    try:
        with open(path, "rb") as f:
            if path.suffix == ".js":
                start = f.read(_MAX_SITE_MARKER_BYTES)
                return _SITE_MARKER_START.match(start) is not None
            text = f.read(_MAX_DATA_MARKER_BYTES + 1)
    except OSError:
        return False
    if len(text) > _MAX_DATA_MARKER_BYTES:
        return False
    try:
        metadata = json.loads(text)
    except ValueError:
        return False
    return isinstance(metadata, dict) and all(
        key in metadata for key in _DATA_MARKER_KEYS
    )


def validate_output_dir(
    output_dir: str | Path, input_paths: Iterable[str | Path]
) -> tuple[bool, str | None]:
    """Refuse output directories that overlap with any input directory.

    The output directory must not be, or contain, the parent directory of
    any input file (KML files or aircraft.json): a run replaces the
    tool-owned files in it, removes the ones it no longer produces and does
    the same below its ``data`` directory. The home directory and the root
    are refused for the same reason. An output directory below an input
    directory is fine: ``flown flight.kml --output-dir out`` from the
    file's own directory writes to ``out/`` without touching the inputs.
    """
    output = Path(output_dir).resolve()

    if is_protected_directory(output):
        return False, f"Refusing to use dangerous output directory: {output_dir}"

    for input_path in input_paths:
        parent = Path(input_path).resolve().parent
        if output == parent or output in parent.parents:
            message = (
                f"Refusing to use output directory '{output}': it is, or "
                f"contains, the input directory '{parent}'. Choose a different "
                "--output-dir."
            )
            return False, message

    return True, None
