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

An entry is the parse as compact JSON, compressed with zstd: a few million
points take a fifth of the space, and the files are read back faster than
the JSON alone is from disk.

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
import os
import re
import time
from compression import zstd
from pathlib import Path
from typing import TYPE_CHECKING, Any, NamedTuple

from .airport_lookup import database_fingerprint
from .cache import (
    CACHE_DIR,
    PRIVATE_FILE_MODE,
    atomic_bytes_write,
    private_directory,
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
    "prune_stale_cache_entries",
    "save_to_cache",
]

# Bump whenever the serialized structure or its encoding changes (6: zstd,
# 7: the landings of the paths, 8: no circuits in them).
# Entries of any other version are pruned (see prune_stale_cache_entries).
CACHE_FORMAT_VERSION = 8
# The name an entry ends in, and how hard it is compressed: level 3 is
# zstd's default, most of the saving at a fraction of the time of the
# higher ones
CACHE_SUFFIX = ".json.zst"
_ZSTD_LEVEL = 3

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
    "geometry",
    "helpers",
    "landings",
    "parser",
    "parser_cache",
    "parser_common",
    "parser_gx_track",
    "parser_standard",
    "types",
    "validation",
)

_ENTRY_NAME = re.compile(
    r"^[0-9a-f]{32}_v(?P<version>\d+)_(?P<parser>[0-9a-f]{8})"
    r"_(?P<database>[0-9a-f]{8}|nodb)\.json(?:\.zst)?$"
)
# The names this module ever gave an entry, for the legacy ones
_ENTRY_SUFFIXES = (".json", ".zst")
_HASH_CHUNK_BYTES = 1024 * 1024


@functools.cache
def parser_fingerprint() -> str:
    """A short token that changes whenever the parser code does."""
    digest = hashlib.sha256()
    package = Path(__file__).parent
    for module in _PARSER_MODULES:
        digest.update(module.encode())
        try:
            digest.update((package / f"{module}.py").read_bytes())
        except OSError:
            # No sources (a bytecode-only install): the format version
            # still invalidates entries on structural changes
            continue
    return digest.hexdigest()[:8]


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


def encode_entry(data: Any) -> bytes:
    """An entry as it is stored: compact JSON, compressed."""
    content = json.dumps(data, separators=(",", ":")).encode()
    return zstd.compress(content, level=_ZSTD_LEVEL)


def decode_entry(data: bytes) -> Any:
    """The data of a stored entry (see ``encode_entry``)."""
    return json.loads(zstd.decompress(data))


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


def _point_from_json(item: Any) -> TrackPoint:
    lat, lon, alt, ts = item
    return TrackPoint(
        float(lat),
        float(lon),
        None if alt is None else float(alt),
        None if ts is None else float(ts),
    )


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


def load_cached_parse(cache_path: Path) -> CachedParse | None:
    """Load cached parse results, or None if the cache entry is invalid.

    Path points are stored as indices into the coordinate list, so a path
    point and its coordinate entry are the same object after loading, as
    they are after parsing. A loaded entry is touched, which keeps it from
    being pruned for its age.
    """
    try:
        cached = decode_entry(cache_path.read_bytes())
        if cached.get("version") != CACHE_FORMAT_VERSION:
            logger.debug("Cache file %s has an unsupported version", cache_path)
            return None
        coordinates = [_point_from_json(item) for item in cached["coordinates"]]
        path_groups = [
            [
                coordinates[item] if isinstance(item, int) else _point_from_json(item)
                for item in path
            ]
            for path in cached["path_groups"]
        ]
        path_metadata = _metadata_list(cached["path_metadata"], len(path_groups))
        warnings = [(int(level), str(message)) for level, message in cached["warnings"]]
        landings = (
            _landings_from_json(cached["landings"], len(path_groups))
            if "landings" in cached
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
    coordinate list (results built by hand) is stored in full instead.
    """
    index_by_id = {id(point): index for index, point in enumerate(coordinates)}

    def encode(point: TrackPoint) -> int | list[Any]:
        index = index_by_id.get(id(point))
        return list(point) if index is None else index

    entry: dict[str, Any] = {
        "version": CACHE_FORMAT_VERSION,
        "coordinates": [list(point) for point in coordinates],
        "path_groups": [[encode(point) for point in path] for path in path_groups],
        "path_metadata": path_metadata,
        "warnings": [list(warning) for warning in warnings],
    }
    if landings is not None:
        entry["landings"] = [_landings_to_json(item) for item in landings]
    data = encode_entry(entry)
    try:
        atomic_bytes_write(cache_path, data, mode=PRIVATE_FILE_MODE)
    except OSError as e:
        # The next run parses the file again, that is all
        logger.debug("Failed to write cache file %s: %s", cache_path, e)
