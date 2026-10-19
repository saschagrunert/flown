"""KML parse result caching.

Cache files are keyed by the content and name of the KML file, the cache
format version, a fingerprint of the parser code and a fingerprint of the
airport database, so any change invalidates the entry. The content rather
than the modification time is hashed so that entries survive git checkouts
and CI clones; hashing costs little next to parsing. The name is part of the
key because the parse result carries it (and the aircraft taken from it). The
airport database is part of the key because the parser standardizes airport
names with it: a file parsed while the database was unavailable would
otherwise keep its raw names until the KML changed.

An entry is the parse compressed with zstd: a header of compact JSON (the
metadata, warnings and landings of the paths), then the coordinates as four
columns of doubles and the paths as indices into them. Reading the points
back from columns takes half the time JSON did, which a build whose files
are all in the cache spent a sixth of its time on.

Stale entries are not removed on the fly. ``prune_stale_cache_entries`` does
that in one pass over the cache directory before a run: entries that another
parser, format version or airport database wrote can never be read again,
and any other entry goes once it has not been used for ``CACHE_MAX_AGE_DAYS``.
"""

import contextlib
import dataclasses
import functools
import hashlib
import json
import math
import os
import re
import sys
import time
from array import array
from compression import zstd
from pathlib import Path
from typing import TYPE_CHECKING, Any, NamedTuple, cast

from .airport_lookup import database_fingerprint
from .cache import (
    CACHE_DIR,
    PRIVATE_FILE_MODE,
    atomic_bytes_write,
    private_directory,
    source_fingerprint,
)
from .landings import FlightLandings
from .logger import logger
from .types import FlightPath, FlightPathGroup, PathMetadata, TrackPoint

if TYPE_CHECKING:
    from collections.abc import Sequence

__all__ = [
    "CACHE_FORMAT_VERSION",
    "CACHE_MAX_AGE_DAYS",
    "CACHE_SUFFIX",
    "KML_CACHE_DIR",
    "CachedParse",
    "get_cache_key",
    "load_cached_parse",
    "parser_fingerprint",
    "prune_cache_entries_except",
    "prune_stale_cache_entries",
    "save_to_cache",
]

# Bump whenever the serialized structure or its encoding changes (6: zstd,
# 7: the landings of the paths, 8: no circuits in them, 9: the points in
# columns of doubles). Entries of any other version are pruned (see
# prune_stale_cache_entries).
CACHE_FORMAT_VERSION = 9
# The name an entry ends in (see save_to_cache)
CACHE_SUFFIX = ".parse.zst"

# Entries not read or written for this long are removed
CACHE_MAX_AGE_DAYS = 30

# KML parse cache subdirectory
KML_CACHE_DIR = CACHE_DIR / "kml"

# The modules whose code decides what a parse returns
_PARSER_MODULES = (
    "aircraft",
    "airport_lookup",
    "constants",
    "date_tokens",
    "date_words",
    "geometry",
    "helpers",
    "landings",
    "parser",
    "parser_cache",
    "parser_common",
    "parser_gx_track",
    "parser_standard",
    "spikes",
    "types",
    "validation",
)

_ENTRY_NAME = re.compile(
    r"^[0-9a-f]{32}_v(?P<version>\d+)_(?P<parser>[0-9a-f]{8})"
    r"_(?P<database>[0-9a-f]{8}|nodb)\.(?:json(?:\.zst)?|parse\.zst)$"
)
# The names this module ever gave an entry, for the legacy ones
_ENTRY_SUFFIXES = (".json", ".zst")
_HASH_CHUNK_BYTES = 1024 * 1024
# The zstd level of an entry, as cache.encode_entry takes it
_ZSTD_LEVEL = 3
# The columns of the points of an entry, in this order, NaN for None
_COLUMNS = 4
# Bytes of the header's length, which comes first
_HEADER_LENGTH_BYTES = 4
# The array type of the indices of the path points, and its bytes (four on
# every platform CPython runs on)
_INDEX_TYPECODE = "i"
_INDEX_BYTES = array(_INDEX_TYPECODE).itemsize


@functools.cache
def parser_fingerprint() -> str:
    """A short token that changes whenever the parser code does."""
    return source_fingerprint(Path(__file__).parent, _PARSER_MODULES)


def _content_digest(kml_path: Path) -> str | None:
    """Hash the file name and content of a KML file (None when unreadable)."""
    # fsencode: a name that is not valid UTF-8 holds surrogates
    digest = hashlib.blake2b(os.fsencode(kml_path.name) + b"\0", digest_size=16)
    try:
        with open(kml_path, "rb") as f:
            while chunk := f.read(_HASH_CHUNK_BYTES):
                digest.update(chunk)
    except OSError:
        return None
    return digest.hexdigest()


def _cache_name(kml_path: Path) -> str | None:
    content = _content_digest(kml_path)
    if content is None:
        return None
    return (
        f"{content}_v{CACHE_FORMAT_VERSION}_{parser_fingerprint()}"
        f"_{database_fingerprint()}{CACHE_SUFFIX}"
    )


def get_cache_key(
    kml_file: str, cache_dir: Path | None = None
) -> tuple[Path | None, bool]:
    """Return the cache path for a KML file and whether a cache entry exists.

    The entries hold the raw flights, real dates and times among them, so
    the directory is this user's alone (see ``cache.private_directory``);
    without one there is no cache.
    """
    if cache_dir is None:
        cache_dir = KML_CACHE_DIR

    if not private_directory(cache_dir):
        logger.debug(
            "Parse cache unavailable: %s is no directory of this user's own", cache_dir
        )
        return None, False

    cache_name = _cache_name(Path(kml_file))
    if cache_name is None:
        return None, False

    cache_path = cache_dir / cache_name
    return cache_path, cache_path.exists()


def _is_stale(entry: Path, now: float) -> bool:
    match = _ENTRY_NAME.match(entry.name)
    if match is None:
        if entry.suffix in _ENTRY_SUFFIXES:
            # An older naming scheme, which no current key produces
            return True
        if entry.suffix != ".tmp":
            return False
        # A temp file an interrupted write left behind goes by its age
    elif (
        not entry.name.endswith(CACHE_SUFFIX)
        or int(match["version"]) != CACHE_FORMAT_VERSION
        or match["database"] != database_fingerprint()
    ):
        return True
    # An entry of another parser goes by its age: a worktree on another
    # commit shares the cache directory and still reads its own entries
    try:
        age_seconds = now - entry.stat().st_mtime
    except OSError:
        return False
    return age_seconds > CACHE_MAX_AGE_DAYS * 24 * 3600


def prune_stale_cache_entries(cache_dir: Path | None = None) -> int:
    """Remove the cache entries that are no longer useful in one directory pass.

    An entry goes when no current key can produce it (a legacy name, another
    format version or airport database) or when it has not been used for
    ``CACHE_MAX_AGE_DAYS``, like a temp file an interrupted write left or an
    entry of another parser version, which a checkout on another commit that
    shares the cache directory may still read.
    Reading an entry renews it. Other files are left alone. Returns the
    number of removed entries.
    """
    if cache_dir is None:
        cache_dir = KML_CACHE_DIR

    try:
        entries = list(cache_dir.iterdir())
    except OSError:
        return 0

    now = time.time()
    removed = 0
    for entry in entries:
        if not _is_stale(entry, now):
            continue
        with contextlib.suppress(OSError):
            entry.unlink()
            removed += 1

    if removed:
        logger.debug("Removed %d stale parse cache entries", removed)
    return removed


def prune_cache_entries_except(
    kml_files: Sequence[str], cache_dir: Path | None = None
) -> int:
    """Remove every entry but those of ``kml_files`` as they are now.

    For a cache of one person's files alone, the build in the page (see
    ``flown.browser``): a file they removed must not leave its parse behind,
    with its real dates and times, for the month ``prune_stale_cache_entries``
    keeps it. Other files are left alone. Returns the number removed.
    """
    if cache_dir is None:
        cache_dir = KML_CACHE_DIR
    kept = {_cache_name(Path(kml_file)) for kml_file in kml_files}
    try:
        entries = list(cache_dir.iterdir())
    except OSError:
        return 0
    removed = 0
    for entry in entries:
        if entry.name in kept or not (
            _ENTRY_NAME.match(entry.name) or entry.suffix == ".tmp"
        ):
            continue
        with contextlib.suppress(OSError):
            entry.unlink()
            removed += 1
    return removed


class CachedParse(NamedTuple):
    """A parse result read from the cache.

    ``warnings`` are the (level, message) pairs the parse logged at WARNING
    or above, which a cache hit logs again: a file that was empty or partly
    unreadable the first time still is.
    """

    coordinates: FlightPath
    path_groups: FlightPathGroup
    path_metadata: list[PathMetadata]
    warnings: list[tuple[int, str]]
    # The landings of every path (see landings.path_landings), None for an
    # entry stored without them
    landings: list[FlightLandings | None] | None = None


def _landings_to_json(landings: FlightLandings | None) -> dict[str, Any] | None:
    return None if landings is None else dataclasses.asdict(landings)


def _landings_from_json(item: Any, paths: int) -> list[FlightLandings | None]:
    """The landings of an entry, one per path."""
    if not isinstance(item, list) or len(item) != paths:
        raise TypeError("landings must be a list of one per path")
    return [
        None
        if entry is None
        else FlightLandings(
            **{
                **entry,
                "touchdowns": [
                    (str(ident), None if runway is None else str(runway))
                    for ident, runway in entry["touchdowns"]
                ],
            }
        )
        for entry in item
    ]


def _metadata_list(value: Any, paths: int) -> list[PathMetadata]:
    """The path metadata of an entry, a list of one per path.

    Every path has its metadata, in the same order: an entry that holds more
    of one than of the other is no parse of the file.
    """
    if not isinstance(value, list):
        raise TypeError("path_metadata must be a list")
    if len(value) != paths:
        raise ValueError("path_groups and path_metadata differ in length")
    if not all(isinstance(item, dict) for item in value):
        raise TypeError("path_metadata items must be objects")
    return value


def _little_endian(values: array[Any]) -> array[Any]:
    """``values`` in little endian order, which an entry stores."""
    if sys.byteorder == "big":
        values.byteswap()
    return values


def _doubles(data: bytes) -> list[float]:
    """The values of a column of doubles."""
    return _little_endian(array("d", data)).tolist()


def _has_nan(values: list[float]) -> bool:
    # The sum is NaN when a value is (or two infinities cancel, which only
    # costs the slower way): one pass in C rather than one call per value
    return math.isnan(sum(values)) and any(map(math.isnan, values))


def _positions(data: bytes) -> list[float]:
    """A column of latitudes or longitudes, which every point has."""
    values = _doubles(data)
    if _has_nan(values):
        raise ValueError("a point without a position")
    return values


def _optional(data: bytes) -> list[float | None]:
    """A column of altitudes or times, None for NaN."""
    values = _doubles(data)
    if _has_nan(values):
        return [None if math.isnan(value) else value for value in values]
    # No None in it: the list itself, as list is invariant to mypy
    return cast("list[float | None]", values)


def _split_entry(data: bytes) -> tuple[dict[str, Any], bytes]:
    """The header of an entry and the bytes of its columns and indices."""
    body = zstd.decompress(data)
    length = int.from_bytes(body[:_HEADER_LENGTH_BYTES], "little")
    end = _HEADER_LENGTH_BYTES + length
    header = json.loads(body[_HEADER_LENGTH_BYTES:end])
    if not isinstance(header, dict):
        raise TypeError("the header must be an object")
    return header, body[end:]


def _join_entry(header: dict[str, Any], rest: bytes) -> bytes:
    """An entry of ``header`` and the bytes after it (see ``_split_entry``)."""
    encoded = json.dumps(header, separators=(",", ":")).encode()
    return zstd.compress(
        len(encoded).to_bytes(_HEADER_LENGTH_BYTES, "little") + encoded + rest,
        level=_ZSTD_LEVEL,
    )


def _points(header: dict[str, Any], rest: bytes) -> tuple[FlightPath, FlightPathGroup]:
    """The coordinates and the paths of an entry (see ``save_to_cache``).

    Raises ``TypeError``, ``ValueError`` or ``IndexError`` for an entry
    whose counts, columns or indices do not fit together.
    """
    points = header["points"]
    count = header["coordinates"]
    lengths = header["path_lengths"]
    if not (
        isinstance(points, int)
        and isinstance(count, int)
        and 0 <= count <= points
        and isinstance(lengths, list)
        and all(isinstance(length, int) and length >= 0 for length in lengths)
    ):
        raise TypeError("the counts of the entry are malformed")
    column_bytes = points * 8
    if len(rest) != _COLUMNS * column_bytes + sum(lengths) * _INDEX_BYTES:
        raise ValueError("the entry is cut short or too long")
    lat, lon, alt, ts = (
        rest[n * column_bytes : (n + 1) * column_bytes] for n in range(_COLUMNS)
    )
    table = list(
        map(
            TrackPoint,
            _positions(lat),
            _positions(lon),
            _optional(alt),
            _optional(ts),
            strict=True,
        )
    )
    indices = _little_endian(array(_INDEX_TYPECODE, rest[_COLUMNS * column_bytes :]))
    if indices and not 0 <= min(indices) <= max(indices) < points:
        raise IndexError("a path point outside the points")
    path_groups: FlightPathGroup = []
    position = 0
    for length in lengths:
        path_groups.append([table[i] for i in indices[position : position + length]])
        position += length
    return table[:count], path_groups


def load_cached_parse(cache_path: Path) -> CachedParse | None:
    """Load cached parse results, or None if the cache entry is invalid.

    Path points are stored as indices into the points of the entry, so a
    path point and its coordinate entry are the same object after loading,
    as they are after parsing. A loaded entry is touched, which keeps it
    from being pruned for its age.
    """
    try:
        header, rest = _split_entry(cache_path.read_bytes())
        if header.get("version") != CACHE_FORMAT_VERSION:
            logger.debug("Cache file %s has an unsupported version", cache_path)
            return None
        coordinates, path_groups = _points(header, rest)
        path_metadata = _metadata_list(header["path_metadata"], len(path_groups))
        warnings = [(int(level), str(message)) for level, message in header["warnings"]]
        landings = (
            _landings_from_json(header["landings"], len(path_groups))
            if "landings" in header
            else None
        )
    except (
        json.JSONDecodeError,
        zstd.ZstdError,
        UnicodeDecodeError,
        IndexError,
        KeyError,
        OSError,
        TypeError,
        ValueError,
        AttributeError,
    ) as e:
        logger.debug("Cache file %s is corrupt or unreadable: %s", cache_path, e)
        return None

    with contextlib.suppress(OSError):
        os.utime(cache_path)
    return CachedParse(coordinates, path_groups, path_metadata, warnings, landings)


def save_to_cache(
    cache_path: Path,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    path_metadata: list[PathMetadata],
    warnings: Sequence[tuple[int, str]] = (),
    landings: Sequence[FlightLandings | None] | None = None,
) -> None:
    """Save parse results to cache, with the warnings the parse logged.

    ``landings``, one per path, are kept with them (see
    ``landings.path_landings``); an entry without them gets them found
    again by the build.

    The parser appends every path point to the coordinate list as well, so a
    path is stored as the indices of its points. A point that is not in the
    coordinate list (results built by hand) is stored after the coordinates,
    which the entry says the number of.
    """
    table = list(coordinates)
    index_by_id = {id(point): index for index, point in enumerate(table)}
    indices = array(_INDEX_TYPECODE)
    for path in path_groups:
        for point in path:
            index = index_by_id.get(id(point))
            if index is None:
                index = index_by_id[id(point)] = len(table)
                table.append(point)
            indices.append(index)
    header: dict[str, Any] = {
        "version": CACHE_FORMAT_VERSION,
        "points": len(table),
        "coordinates": len(coordinates),
        "path_lengths": [len(path) for path in path_groups],
        "path_metadata": path_metadata,
        "warnings": [list(warning) for warning in warnings],
    }
    if landings is not None:
        header["landings"] = [_landings_to_json(item) for item in landings]
    columns = [
        _little_endian(
            array(
                "d",
                (math.nan if point[n] is None else point[n] for point in table),
            )
        ).tobytes()
        for n in range(_COLUMNS)
    ]
    data = _join_entry(header, b"".join(columns) + _little_endian(indices).tobytes())
    try:
        atomic_bytes_write(cache_path, data, mode=PRIVATE_FILE_MODE)
    except OSError as e:
        # The next run parses the file again, that is all
        logger.debug("Failed to write cache file %s: %s", cache_path, e)
