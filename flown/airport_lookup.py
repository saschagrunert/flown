"""Airport coordinate lookup from ICAO codes using OurAirports with local caching."""

import contextlib
import csv
import hashlib
import http.client
import io
import math
import os
import re
import ssl
import threading
import time
import urllib.error
from pathlib import Path
from typing import TYPE_CHECKING, Any, NamedTuple
from urllib.parse import urlsplit
from urllib.request import urlopen

# Try to import fcntl for Unix-like systems (for process-safe file locking)
try:
    import fcntl

    HAS_FCNTL = True
except ImportError:
    # Windows doesn't have fcntl
    HAS_FCNTL = False

from .cache import (
    CACHE_DIR,
    atomic_bytes_write,
    load_entry,
    source_fingerprint,
    store_entry,
)
from .constants import FEET_TO_METERS, ICAO_REGION_PREFIXES
from .exceptions import AirportDatabaseError
from .geometry import true_bearing
from .helpers import DATE_PATTERN
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Callable
    from typing import IO, BinaryIO

# Pre-compiled pattern for ICAO code extraction. VIII is no code but August
# in Roman numerals, as a date in Poland or Hungary has it ("16.VIII.2026"),
# which would make a route name with a date look like one with a code.
_ICAO_PATTERN = re.compile(r"\b(?!VIII\b)([A-Z]{4})\b")

# Route names: "EDDS Stuttgart - EDDP Leipzig" or "EDDS to EDDP - 16 Aug 2026",
# with a dash, an arrow or a "to" in any case between spaces
_ROUTE_SEPARATOR = re.compile(r"\s+(?:->|[-\u2013\u2014>]|(?i:to))\s+")
# Between two codes the spaces may be left out, and a slash separates them
# too: "EDDF-EDDM", "EDDF->EDDM", "EDDF/EDDM"
_CODE_SEPARATOR = re.compile(
    r"(?<=\b[A-Z]{4})(?:\s*(?:->|[-\u2013\u2014>/])\s*|\s+(?i:to)\s+)(?=[A-Z]{4}\b)"
)
_ROUTE_DATE_SUFFIX = re.compile(rf"\s+-\s+{DATE_PATTERN.pattern}\s*$")

__all__ = [
    "REQUIRE_DATABASE_ENV",
    "AirportDatabases",
    "AirportNames",
    "AirportRecord",
    "RunwayEnd",
    "airport_icao_code",
    "database_airport_name",
    "database_fingerprint",
    "extract_icao_codes_from_name",
    "load_airport_database",
    "load_runway_database",
    "lookup_airport_coordinates",
    "lookup_airport_country",
    "lookup_airport_elevation",
    "refresh_airport_databases",
    "retry_missing_databases",
    "split_route_name",
    "standardize_airport_names",
    "standardize_route",
    "use_airport_database",
    "use_database_fingerprint",
    "use_runway_database",
]

# OurAirports database URL
OURAIRPORTS_URL = "https://davidmegginson.github.io/ourairports-data/airports.csv"

# Cache settings
CACHE_FILE = CACHE_DIR / "airports.csv"
CACHE_LOCK_FILE = CACHE_DIR / "airports.lock"
# Touched when a download fails so that the other processes of the same run
# (and the next runs within DOWNLOAD_RETRY_SECONDS) do not each wait for the
# timeout again while offline
DOWNLOAD_FAILED_MARKER = CACHE_DIR / "airports.download-failed"
CACHE_MAX_AGE_DAYS = 30
DOWNLOAD_TIMEOUT_SECONDS = 30
DOWNLOAD_RETRY_SECONDS = 3600
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
# The database has about 86,000 rows; a body far below that was cut off
MIN_DOWNLOAD_ROWS = 50_000
REQUIRED_COLUMNS = ("ident", "name", "latitude_deg", "longitude_deg")
# Set to "1" to fail instead of running without airport names (CI, deploys)
REQUIRE_DATABASE_ENV = "FLOWN_REQUIRE_AIRPORT_DB"

# The runways of the same database, cached the same way: the landing
# detector (flown.landings) snaps the track of a touchdown to them
RUNWAYS_URL = "https://davidmegginson.github.io/ourairports-data/runways.csv"
RUNWAYS_CACHE_FILE = CACHE_DIR / "runways.csv"
RUNWAYS_LOCK_FILE = CACHE_DIR / "runways.lock"
RUNWAYS_DOWNLOAD_FAILED_MARKER = CACHE_DIR / "runways.download-failed"
# The list has about 48,000 rows
MIN_RUNWAY_ROWS = 20_000
RUNWAY_COLUMNS = ("airport_ident", "le_ident", "he_ident", "closed")
# A runway designator: a number from 01 to 36, and a letter for parallels,
# or one that says the number is a true heading (T, in the far north) or
# that the strip is for gliders, ultralights, arrivals or departures (G, U,
# A, D). A W is a water lane and an H a helipad: no flight here lands there
_DESIGNATOR = re.compile(r"^(0?[1-9]|[12][0-9]|3[0-6])([LCR]|[TGUAD])?$")
# Many small strips name their ends by the compass point they face, N, NE
# or SSW, with a letter for parallels (NEL), and a few by a bearing from
# north or south: N75E
_COMPASS_POINTS = (
    "N",
    "NNE",
    "NE",
    "ENE",
    "E",
    "ESE",
    "SE",
    "SSE",
    "S",
    "SSW",
    "SW",
    "WSW",
    "W",
    "WNW",
    "NW",
    "NNW",
)
_COMPASS_DESIGNATOR = re.compile(r"^([NESW]{1,3})([LCR]?)$")
_BEARING_DESIGNATOR = re.compile(r"^([NS])([0-8]?[0-9])([EW])$")

# The databases as this module reads them, kept by the digest of the file
# they were read from (see _read_database): reading the CSV files took
# 480 ms, a fifth of a build that found every flight in the parse cache,
# reading the kept ones 85 ms. In a directory of this user's alone, as the
# parse cache (see cache.store_entry).
PARSED_DATABASE_DIR = CACHE_DIR / "databases"
# The modules whose code decides what is read of a file
_READER_MODULES = ("airport_lookup", "constants", "geometry", "helpers", "types")


class AirportRecord(NamedTuple):
    """One airport of the database; the elevation is missing for some."""

    lat: float
    lon: float
    name: str
    country: str
    elevation_m: float | None = None


class RunwayEnd(NamedTuple):
    """One end of a runway: its designator ("29", "08L") and true heading."""

    designator: str
    heading: float


class _CsvDatabase(NamedTuple):
    """A file of OurAirports, where it comes from and where it is cached."""

    name: str
    url: str
    cache_file: Path
    lock_file: Path
    failed_marker: Path
    min_rows: int
    columns: tuple[str, ...]


def _airports_csv() -> _CsvDatabase:
    """airports.csv, from the module's settings as they are now."""
    return _CsvDatabase(
        "airport database",
        OURAIRPORTS_URL,
        CACHE_FILE,
        CACHE_LOCK_FILE,
        DOWNLOAD_FAILED_MARKER,
        MIN_DOWNLOAD_ROWS,
        REQUIRED_COLUMNS,
    )


def _runways_csv() -> _CsvDatabase:
    """runways.csv, from the module's settings as they are now."""
    return _CsvDatabase(
        "runway database",
        RUNWAYS_URL,
        RUNWAYS_CACHE_FILE,
        RUNWAYS_LOCK_FILE,
        RUNWAYS_DOWNLOAD_FAILED_MARKER,
        MIN_RUNWAY_ROWS,
        RUNWAY_COLUMNS,
    )


def _is_valid_csv_file(path: Path, columns: tuple[str, ...] = REQUIRED_COLUMNS) -> bool:
    """Check that a CSV file is non-empty, complete and has the required header."""
    try:
        with open(path, "rb") as f:
            return _is_valid_open_csv(f, columns)
    except OSError:
        return False


def _is_valid_open_csv(f: BinaryIO, columns: tuple[str, ...]) -> bool:
    """``_is_valid_csv`` of an open file, read from its first byte to its last.

    An empty file has no line break at its end and fails it.
    """
    f.seek(0)
    header_line = f.readline()
    size = f.seek(0, os.SEEK_END)
    f.seek(max(size - 1, 0))
    return _is_valid_csv(header_line, f.read(1), columns)


def _is_valid_csv(
    header_line: bytes, last_byte: bytes, columns: tuple[str, ...]
) -> bool:
    """Whether a CSV file of this first line and last byte is usable.

    It has to end in a line break, or the download was cut short, and its
    header has to name ``columns``.
    """
    if last_byte != b"\n":
        return False  # truncated download
    try:
        header = header_line.decode("utf-8", errors="replace").strip()
        header_columns = next(csv.reader([header]))
    except csv.Error, StopIteration:
        return False

    return all(column in header_columns for column in columns)


def _is_cache_valid(database: _CsvDatabase | None = None) -> bool:
    """Check if a cached database is present, recent and well-formed.

    ``database`` is airports.csv unless it names another file.
    """
    database = database or _airports_csv()
    if not database.cache_file.exists():
        return False

    file_age_seconds = time.time() - database.cache_file.stat().st_mtime
    file_age_days = file_age_seconds / (24 * 3600)
    if file_age_days >= CACHE_MAX_AGE_DAYS:
        return False

    return _is_valid_csv_file(database.cache_file, database.columns)


def _recent_download_failure(database: _CsvDatabase | None = None) -> bool:
    """True when a download failed less than DOWNLOAD_RETRY_SECONDS ago."""
    database = database or _airports_csv()
    try:
        age = time.time() - database.failed_marker.stat().st_mtime
    except OSError:
        return False
    return 0 <= age < DOWNLOAD_RETRY_SECONDS


def _record_download_failure(database: _CsvDatabase | None = None) -> None:
    database = database or _airports_csv()
    with contextlib.suppress(OSError):
        database.failed_marker.touch()


def _clear_download_failure(database: _CsvDatabase | None = None) -> None:
    database = database or _airports_csv()
    with contextlib.suppress(OSError):
        database.failed_marker.unlink()


def _fetch_database(database: _CsvDatabase) -> bool:
    """Download a database into the cache; False on any failure."""
    name = database.name
    try:
        logger.info("📥 Downloading the OurAirports %s...", name)
        context = ssl.create_default_context()
        with urlopen(  # noqa: S310
            database.url, timeout=DOWNLOAD_TIMEOUT_SECONDS, context=context
        ) as response:
            final_url = response.url
            if not _same_origin(final_url, database.url):
                logger.warning(
                    "✗ Refusing the %s from %s: redirected off %s",
                    name,
                    final_url,
                    urlsplit(database.url).netloc,
                )
                return False
            data = response.read(MAX_DOWNLOAD_BYTES + 1)
            content_length = response.headers.get("Content-Length")

        if len(data) > MAX_DOWNLOAD_BYTES:
            logger.warning(
                "✗ The %s exceeds %d MB, refusing to cache it",
                name,
                MAX_DOWNLOAD_BYTES // (1024 * 1024),
            )
            return False

        # A body shorter than announced ends the read without an error, and a
        # cut at a line boundary still looks like a complete CSV file
        if (
            content_length is not None
            and content_length.isdigit()
            and len(data) != int(content_length)
        ):
            logger.warning(
                "✗ The %s download is incomplete (%d of %s bytes)",
                name,
                len(data),
                content_length,
            )
            return False
        rows = data.count(b"\n")
        if rows < database.min_rows:
            logger.warning(
                "✗ The %s download has only %d rows, expected at least %d",
                name,
                rows,
                database.min_rows,
            )
            return False

        header_line = data.partition(b"\n")[0]
        if not _is_valid_csv(header_line, data[-1:], database.columns):
            logger.warning("✗ The downloaded %s is empty or invalid", name)
            return False

        # Readable like a regular write, for a shared cache directory (a
        # build container, a CI runner)
        atomic_bytes_write(database.cache_file, data)
        # The file changes every day upstream; the digest tells which one a
        # build used, for a site that has to be built again the same way
        logger.info(
            "✓ Downloaded the %.1f MB %s (SHA-256 %s)",
            len(data) / 1024 / 1024,
            name,
            hashlib.sha256(data).hexdigest(),
        )
    # http.client.IncompleteRead (a connection dropped mid-body) is no OSError
    except (
        OSError,
        urllib.error.URLError,
        http.client.HTTPException,
        ValueError,
    ) as e:
        logger.warning("✗ Failed to download the %s: %s", name, e)
        return False
    return True


def _same_origin(url: str, expected: str) -> bool:
    """Whether ``url`` is on https and on the host of ``expected``.

    urlopen follows redirects: a database that ends up anywhere else is
    not the one the build asked for, whatever it holds.
    """
    parts = urlsplit(url)
    return parts.scheme == "https" and parts.netloc == urlsplit(expected).netloc


def _download_airport_database(database: _CsvDatabase | None = None) -> bool:
    """Download the OurAirports database into the cache atomically.

    ``database`` is airports.csv unless it names another file. A failed
    attempt is remembered in the cache directory and not retried for
    DOWNLOAD_RETRY_SECONDS, so an offline run pays the timeout once instead
    of once per worker process.
    """
    database = database or _airports_csv()
    cache_dir = database.cache_file.parent
    try:
        cache_dir.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.warning("✗ Cannot create airport cache directory %s: %s", cache_dir, e)
        return False

    if not os.access(cache_dir, os.W_OK):
        logger.warning("✗ Airport cache directory is not writable: %s", cache_dir)
        return False

    if _recent_download_failure(database):
        logger.debug(
            "Skipping the %s download: the last attempt failed less than %d s ago",
            database.name,
            DOWNLOAD_RETRY_SECONDS,
        )
        return False

    if _fetch_database(database):
        _clear_download_failure(database)
        return True

    _record_download_failure(database)
    return False


def _airport_rows(text: IO[str]) -> dict[str, AirportRecord]:
    """Parse the airports CSV into a mapping of ICAO code to record."""
    airports: dict[str, AirportRecord] = {}
    for row in csv.DictReader(text):
        icao = (row.get("ident") or "").strip().upper()
        # Only include airports with valid ICAO codes (4 characters)
        if not icao or len(icao) != 4:
            continue
        try:
            lat = float(row.get("latitude_deg") or "")
            lon = float(row.get("longitude_deg") or "")
        except ValueError:
            continue
        name = (row.get("name") or "").strip()
        country = (row.get("iso_country") or "").strip()
        try:
            elevation_m: float | None = (
                float(row.get("elevation_ft") or "") * FEET_TO_METERS
            )
        except ValueError:
            elevation_m = None
        if name:
            airports[icao] = AirportRecord(lat, lon, name, country, elevation_m)
    return airports


class _StoredRows[T](NamedTuple):
    """How a database is kept once read (see ``_read_database``)."""

    name: str
    to_json: Callable[[T], Any]
    from_json: Callable[[Any], T]


def _kept_airport(record: list[Any]) -> AirportRecord:
    lat, lon, name, country, elevation_m = record
    return AirportRecord(
        float(lat),
        float(lon),
        str(name),
        str(country),
        None if elevation_m is None else float(elevation_m),
    )


_STORED_AIRPORTS = _StoredRows[dict[str, AirportRecord]](
    "airports",
    lambda airports: {icao: list(record) for icao, record in airports.items()},
    lambda data: {icao: _kept_airport(record) for icao, record in data.items()},
)
_STORED_RUNWAYS = _StoredRows[dict[str, tuple[RunwayEnd, ...]]](
    "runways",
    lambda runways: {
        ident: [list(end) for end in ends] for ident, ends in runways.items()
    },
    lambda data: {
        ident: tuple(RunwayEnd(str(name), float(heading)) for name, heading in ends)
        for ident, ends in data.items()
    },
)


def _stored_path(stored: _StoredRows[Any], digest: bytes) -> Path:
    """Where ``stored`` of the file of ``digest`` is kept, by this code."""
    fingerprint = source_fingerprint(Path(__file__).parent, _READER_MODULES)
    name = f"{stored.name}_{digest.hex()[:32]}_{fingerprint}.json.zst"
    return PARSED_DATABASE_DIR / name


def _read_database[T](
    path: Path,
    rows: Callable[[IO[str]], T],
    columns: tuple[str, ...] | None,
    stored: _StoredRows[T] | None = None,
) -> tuple[T, bytes] | None:
    """A cached database and the digest of exactly the bytes it was read from.

    One open file for both: the download of another run may replace the
    file at any time (atomically, so this one keeps reading the file it
    opened), and a digest of the file on disk could then describe another
    database than the one read, under which the parse cache would store
    results computed with this one. ``columns`` checks the file is complete
    and has them first (see ``_is_valid_csv``), None for no check; None is
    returned for a file that fails it.

    With ``stored``, what was read of a file is kept under its digest and
    the code that read it (see ``PARSED_DATABASE_DIR``), and read from there
    the next time; the digest is of the file still.
    """
    with open(path, "rb") as f:
        digest = hashlib.file_digest(f, "sha256").digest()
        if columns is not None and not _is_valid_open_csv(f, columns):
            return None
        if stored is not None:
            kept = _kept_database(stored, digest)
            if kept is not None:
                return kept, digest
        f.seek(0)
        with io.TextIOWrapper(f, encoding="utf-8") as text:
            database = rows(text)
    if stored is not None:
        store_entry(_stored_path(stored, digest), stored.to_json(database))
    return database, digest


def _kept_database[T](stored: _StoredRows[T], digest: bytes) -> T | None:
    """The database ``_read_database`` kept of the file of ``digest``, if any."""
    kept = load_entry(_stored_path(stored, digest))
    if kept is None:
        return None
    try:
        return stored.from_json(kept)
    except (TypeError, ValueError, AttributeError) as e:
        logger.debug("The kept %s are unreadable: %s", stored.name, e)
        return None


def _ensure_cache_file(database: _CsvDatabase | None = None) -> None:
    """Download the database when the cache is stale, under a file lock.

    The lock coordinates the processes of one run (Unix only). A cache
    directory that cannot be written (read-only mount, foreign owner) only
    disables the lock; loading continues. Only the download runs under the
    lock: parsing the CSV is per process and must not serialize the workers.
    ``database`` is airports.csv unless it names another file.
    """
    database = database or _airports_csv()
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        logger.debug("Cannot create cache directory %s: %s", CACHE_DIR, e)

    lock_file = None
    if HAS_FCNTL:
        try:
            lock_file = open(database.lock_file, "w", encoding="utf-8")  # noqa: SIM115
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
        except OSError as e:
            logger.debug(
                "Cannot lock %s, continuing without: %s", database.lock_file, e
            )
            if lock_file is not None:
                lock_file.close()
            lock_file = None

    try:
        # Check again after acquiring the lock: another process might have
        # downloaded the database while we waited
        if not _is_cache_valid(database):
            logger.debug("The %s cache is stale, missing or invalid", database.name)
            if not _download_airport_database(database) and _is_valid_csv_file(
                database.cache_file, database.columns
            ):
                # An expired cache (by age or --refresh-airports) is still
                # read; the user should know the run did not get a new one
                logger.warning(
                    "Could not refresh the %s, using the cached copy", database.name
                )
    finally:
        if lock_file:
            try:
                if HAS_FCNTL:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
            except OSError:
                pass
            finally:
                # Closing releases the lock as well; a failed unlock must not
                # leak the descriptor
                with contextlib.suppress(OSError):
                    lock_file.close()


def _database_required() -> bool:
    return os.environ.get(REQUIRE_DATABASE_ENV) == "1"


def _designator(ident: str | None) -> tuple[str, float] | None:
    """A runway end's designator ("08L", "NE") and the heading it names.

    A number with two digits. Its heading is magnetic, but for a T, and off
    by the variation, which still tells the ends of most fields apart.
    None for a pad, a water lane and anything else.
    """
    text = (ident or "").strip().upper()
    match = _DESIGNATOR.match(text)
    if match is not None:
        number = int(match.group(1))
        return f"{number:02d}{match.group(2) or ''}", number * 10.0
    match = _COMPASS_DESIGNATOR.match(text)
    if match is not None and match.group(1) in _COMPASS_POINTS:
        return text, _COMPASS_POINTS.index(match.group(1)) * 22.5
    match = _BEARING_DESIGNATOR.match(text)
    if match is not None:
        degrees = float(match.group(2))
        from_north = degrees if match.group(1) == "N" else 180 - degrees
        return text, from_north if match.group(3) == "E" else -from_north % 360
    return None


def _float(text: str | None) -> float | None:
    try:
        value = float(text or "")
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _runway_ends(row: dict[str, str]) -> list[RunwayEnd]:
    """The two ends of a runway row with their true headings.

    The heading of an end is the one the list gives, else the bearing from
    its threshold to the other one, else the one its designator names (see
    ``_designator``).
    """
    low_end = _designator(row.get("le_ident"))
    high_end = _designator(row.get("he_ident"))
    if low_end is not None:
        low, named = low_end
    elif high_end is not None:
        low, named = None, high_end[1] + 180
    else:
        return []
    high = high_end[0] if high_end is not None else None
    low_heading = _float(row.get("le_heading_degT"))
    high_heading = _float(row.get("he_heading_degT"))
    coordinates = [
        _float(row.get(key))
        for key in (
            "le_latitude_deg",
            "le_longitude_deg",
            "he_latitude_deg",
            "he_longitude_deg",
        )
    ]
    if low_heading is None and None not in coordinates:
        lat0, lon0, lat1, lon1 = (value or 0.0 for value in coordinates)
        if (lat0, lon0) != (lat1, lon1):
            low_heading = true_bearing(lat0, lon0, lat1, lon1)
    if low_heading is None and high_heading is not None:
        low_heading = high_heading + 180
    if low_heading is None:
        low_heading = named
    if high_heading is None:
        high_heading = low_heading + 180
    return [
        RunwayEnd(designator, heading % 360)
        for designator, heading in ((low, low_heading), (high, high_heading))
        if designator is not None
    ]


def _runway_rows(text: IO[str]) -> dict[str, tuple[RunwayEnd, ...]]:
    """The ends of the open runways of every airport, by its ident."""
    runways: dict[str, list[RunwayEnd]] = {}
    for row in csv.DictReader(text):
        ident = (row.get("airport_ident") or "").strip().upper()
        if len(ident) != 4 or (row.get("closed") or "0").strip() == "1":
            continue
        ends = _runway_ends(row)
        if ends:
            runways.setdefault(ident, []).extend(ends)
    return {ident: tuple(ends) for ident, ends in runways.items()}


class AirportDatabases:
    """The airport and runway databases of this process, loaded once.

    ``load`` and ``load_runways`` read them from the cache (downloading
    them when needed) the first time and keep them; ``use`` and
    ``use_runways`` take those another process loaded (see
    ``workers.init_worker``), and
    ``reset`` forgets both, so the next lookup loads them again. One holder
    per process (``databases``), shared by every thread under its lock.
    """

    def __init__(self) -> None:
        """Start with nothing loaded."""
        self._lock = threading.Lock()
        self.airports: dict[str, AirportRecord] | None = None
        # The runway ends of every airport, by its ident
        self.runways: dict[str, tuple[RunwayEnd, ...]] | None = None
        # The last fingerprint computed, keyed by the file's path and stat:
        # hashing the database takes a few milliseconds, and the parse
        # cache asks for the fingerprint once per KML file
        self._fingerprint: tuple[list[tuple[str, int, int, int]], str] | None = None
        # Whether ``load`` and ``load_runways`` read the databases here, and
        # the digests of the files they read, None for none; and the
        # fingerprint of the databases another process loaded, which
        # ``use_fingerprint`` hands over
        self._read_here = {"airports": False, "runways": False}
        self._airport_digest: bytes | None = None
        self._runway_digest: bytes | None = None
        self._given_fingerprint: str | None = None

    def use(self, airports: dict[str, AirportRecord]) -> None:
        """Use a database another process loaded instead of loading it here."""
        self.airports = airports
        self._read_here["airports"] = False

    def use_runways(self, runways: dict[str, tuple[RunwayEnd, ...]]) -> None:
        """Use runways another process loaded instead of loading them here."""
        self.runways = runways
        self._read_here["runways"] = False

    def use_fingerprint(self, fingerprint: str) -> None:
        """The fingerprint of the databases ``use`` and ``use_runways`` gave."""
        self._given_fingerprint = fingerprint

    def reset(self) -> None:
        """Forget what was loaded; the next lookup reads the cache again."""
        with self._lock:
            self.airports = None
            self.runways = None
            self._fingerprint = None
            self._read_here = {"airports": False, "runways": False}
            self._airport_digest = None
            self._runway_digest = None
            self._given_fingerprint = None

    def load(self) -> dict[str, AirportRecord]:
        """The airport database, from the cache, downloading it when needed.

        The first call in a process pays for the parse (and possibly the
        download).

        Raises:
            AirportDatabaseError: When ``FLOWN_REQUIRE_AIRPORT_DB`` is
                "1" and no complete database could be loaded. Without it the
                run continues with raw airport names.
        """
        # Fast path: return cached data if already loaded (no lock needed)
        if self.airports is not None:
            return self.airports

        # Only one thread per process loads the database
        with self._lock:
            # Double-check: another thread might have loaded it meanwhile
            if self.airports is not None:
                return self.airports

            _ensure_cache_file()
            required = _database_required()

            # A stale but complete cache is still used when the download failed
            if CACHE_FILE.exists():
                try:
                    loaded = _read_database(
                        CACHE_FILE,
                        _airport_rows,
                        REQUIRED_COLUMNS if required else None,
                        stored=_STORED_AIRPORTS,
                    )
                except (OSError, csv.Error, ValueError, UnicodeDecodeError) as e:
                    logger.warning("Failed to load airport cache: %s", e)
                    loaded = None
                if loaded is not None:
                    airports, digest = loaded
                    if airports or not required:
                        self.airports = airports
                        self._airport_digest = digest
                        self._read_here["airports"] = True
                        logger.debug(
                            "Loaded %s airports from cache", f"{len(airports):,}"
                        )
                        return airports

            if required:
                raise AirportDatabaseError(
                    "The OurAirports database could not be loaded from "
                    f"{CACHE_FILE}, and {REQUIRE_DATABASE_ENV}=1 requires it"
                )
            # The run goes on: what is lost is the names and positions the
            # database gives the codes, nothing else
            logger.warning(
                "Airport database unavailable: the airports keep the names the "
                "files give them (set %s=1 to stop instead)",
                REQUIRE_DATABASE_ENV,
            )
            self.airports = {}
            self._read_here["airports"] = True
            return self.airports

    def load_runways(self) -> dict[str, tuple[RunwayEnd, ...]]:
        """The runway ends of every airport, from the cache like the airports.

        Downloaded like ``load`` does it, and required under the same
        ``FLOWN_REQUIRE_AIRPORT_DB``. Without it the landings are still
        counted, without their runways.

        Raises:
            AirportDatabaseError: When the database is required and could not
                be loaded.
        """
        if self.runways is not None:
            return self.runways
        with self._lock:
            if self.runways is not None:
                return self.runways
            database = _runways_csv()
            _ensure_cache_file(database)
            required = _database_required()
            runways: dict[str, tuple[RunwayEnd, ...]] = {}
            if database.cache_file.exists():
                try:
                    loaded = _read_database(
                        database.cache_file,
                        _runway_rows,
                        database.columns if required else None,
                        stored=_STORED_RUNWAYS,
                    )
                except (OSError, csv.Error, ValueError, UnicodeDecodeError) as e:
                    logger.warning("Failed to load the runway cache: %s", e)
                else:
                    if loaded is not None:
                        runways, self._runway_digest = loaded
            if required and not runways:
                raise AirportDatabaseError(
                    f"The OurAirports runways could not be loaded from "
                    f"{database.cache_file}, and {REQUIRE_DATABASE_ENV}=1 "
                    "requires them"
                )
            if not runways:
                logger.warning("Runway database unavailable - touchdowns get no runway")
            self.runways = runways
            self._read_here["runways"] = True
            return runways

    def fingerprint(self) -> str:
        """A short token that changes whenever a cached database does.

        The airports and the runways: a parse finds the landings of its
        flights at the fields of both (see ``landings.path_landings``). A
        hash of the content: the databases are downloaded again every
        ``CACHE_MAX_AGE_DAYS``, and a download with the same bytes must not
        invalidate every parse cache entry, as its new modification time
        would.

        Returns ``"nodb"`` while there is no cached airport database, so
        results computed without one are told apart from results computed
        with it. A missing runway database counts as an empty one.

        Once both are loaded, of the bytes they were read from rather than
        of the files: a run that downloads them again meanwhile would make
        the parse cache keep what this process computes with the old ones
        under the key of the new ones. A worker takes the parent's (see
        ``use_fingerprint``).
        """
        if self._given_fingerprint is not None:
            return self._given_fingerprint
        if self._read_here["airports"] and self._read_here["runways"]:
            if self._airport_digest is None:
                return "nodb"
            digest = hashlib.sha256(self._airport_digest)
            if self._runway_digest is not None:
                digest.update(self._runway_digest)
            return digest.hexdigest()[:8]
        files = (CACHE_FILE, RUNWAYS_CACHE_FILE)
        key: list[tuple[str, int, int, int]] = []
        for path in files:
            try:
                stat = path.stat()
            except OSError:
                if path == CACHE_FILE:
                    return "nodb"
                continue
            key.append((str(path), stat.st_size, stat.st_mtime_ns, stat.st_ino))
        memo = self._fingerprint
        if memo is not None and memo[0] == key:
            return memo[1]
        digest = hashlib.sha256()
        for path in files:
            try:
                with open(path, "rb") as database:
                    digest.update(hashlib.file_digest(database, "sha256").digest())
            except OSError:
                if path == CACHE_FILE:
                    return "nodb"
        token = digest.hexdigest()[:8]
        self._fingerprint = (key, token)
        return token


#: The databases of this process
databases = AirportDatabases()


def load_airport_database() -> dict[str, AirportRecord]:
    """The airport database of this process (see ``AirportDatabases.load``)."""
    return databases.load()


def load_runway_database() -> dict[str, tuple[RunwayEnd, ...]]:
    """The runways of this process (see ``AirportDatabases.load_runways``)."""
    return databases.load_runways()


def use_airport_database(airports: dict[str, AirportRecord]) -> None:
    """Use a database another process loaded instead of loading it here."""
    databases.use(airports)


def use_runway_database(runways: dict[str, tuple[RunwayEnd, ...]]) -> None:
    """Use runways another process loaded instead of loading them here."""
    databases.use_runways(runways)


def database_fingerprint() -> str:
    """See ``AirportDatabases.fingerprint``."""
    return databases.fingerprint()


def use_database_fingerprint(fingerprint: str) -> None:
    """See ``AirportDatabases.use_fingerprint``."""
    databases.use_fingerprint(fingerprint)


def refresh_airport_databases() -> None:
    """Mark the cached airport and runway files expired, so the run downloads them.

    For ``--refresh-airports``: OurAirports changes every day, and the cache
    is only renewed after ``CACHE_MAX_AGE_DAYS``. The files stay: the
    download replaces them only once it is complete and valid, and a run
    that cannot download (offline) goes on with them, as it does with a
    cache that expired by age. The markers of a failed download go, so the
    download is tried right away.
    """
    expired = time.time() - (CACHE_MAX_AGE_DAYS + 1) * 24 * 3600
    for database in (_airports_csv(), _runways_csv()):
        try:
            stat = database.cache_file.stat()
            os.utime(database.cache_file, (stat.st_atime, expired))
        except FileNotFoundError:
            pass
        except OSError as e:
            logger.warning("✗ Cannot mark the %s for download: %s", database.name, e)
        with contextlib.suppress(FileNotFoundError):
            database.failed_marker.unlink()
    databases.reset()


def retry_missing_databases(download: bool = True) -> None:
    """Let the next lookup load again a database the last one went without.

    For a process that builds more than once, the worker of the build in
    the browser, whose cache outlives it: a database loaded empty stays
    empty in the process, and the next build would not say again that it
    goes without it. ``download`` also lets it download again at once: the
    marker of the failed download holds the next try back for
    DOWNLOAD_RETRY_SECONDS, though the connection may be back by then, and
    is kept where not asked (a slow line would wait for the timeout at
    every build). Databases that loaded are kept as they are.
    """
    if databases.airports and databases.runways:
        return
    if download:
        for database in (_airports_csv(), _runways_csv()):
            with contextlib.suppress(OSError):
                database.failed_marker.unlink()
    databases.reset()


def lookup_airport_coordinates(icao_code: str) -> tuple[float, float, str] | None:
    """Look up airport coordinates from ICAO code using OurAirports."""
    if not icao_code or len(icao_code) != 4:
        logger.debug("Invalid ICAO code: %s", icao_code)
        return None

    airports = load_airport_database()

    icao_upper = icao_code.upper()
    if icao_upper in airports:
        record = airports[icao_upper]
        logger.debug(
            "Found airport %s: %s at (%s, %s)",
            icao_upper,
            record.name,
            record.lat,
            record.lon,
        )
        return (record.lat, record.lon, record.name)

    logger.debug("Airport %s not found in database", icao_upper)
    return None


def lookup_airport_country(icao_code: str) -> str | None:
    """Look up airport country code from ICAO code using OurAirports."""
    if not icao_code or len(icao_code) != 4:
        return None

    airports = load_airport_database()

    icao_upper = icao_code.upper()
    if icao_upper in airports:
        country = airports[icao_upper].country
        return country or None

    return None


def lookup_airport_elevation(icao_code: str | None) -> float | None:
    """The field elevation of an airport in meters, None when unknown."""
    if not icao_code or len(icao_code) != 4:
        return None
    record = load_airport_database().get(icao_code.upper())
    return record.elevation_m if record is not None else None


def extract_icao_codes_from_name(airport_name: str | None) -> list[str]:
    """Extract potential ICAO airport codes from an airport name string."""
    if not airport_name:
        return []

    matches = _ICAO_PATTERN.findall(airport_name)

    # Filter to valid ICAO region prefixes (excludes I, J, Q, X which are not
    # assigned to airport codes), helping reject false positives like month names
    return [code for code in matches if code[0] in ICAO_REGION_PREFIXES]


def _starts_with_icao_code(text: str) -> bool:
    match = _ICAO_PATTERN.match(text)
    return match is not None and match.group(1)[0] in ICAO_REGION_PREFIXES


def airport_icao_code(airport_name: str | None) -> str | None:
    """The ICAO code of a single airport name, or None.

    Flight logs and standardized names lead with the code, so "EGDY RNAS
    Yeovilton" is EGDY. A name that does not start with a code has to hold
    exactly one.
    """
    codes = extract_icao_codes_from_name(airport_name)
    if not codes:
        return None
    if len(codes) == 1 or (airport_name and _starts_with_icao_code(airport_name)):
        return codes[0]
    return None


_AIRPORT_SUFFIXES = (
    " International Airport",
    " Regional Airport",
    " Municipal Airport",
    " Airport",
    " Airfield",
    " Air Base",
    " Heliport",
)


def _strip_airport_suffix(name: str) -> str:
    """Remove common airport suffixes for cleaner display."""
    for suffix in _AIRPORT_SUFFIXES:
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def database_airport_name(icao_code: str) -> str | None:
    """The standardized name of an airport ("EDDS Stuttgart"), or None."""
    coords = lookup_airport_coordinates(icao_code)
    if coords is None:
        return None
    return f"{icao_code} {_strip_airport_suffix(coords[2])}"


def split_route_name(name: str | None) -> tuple[str, str] | None:
    """Split a route name into its departure and arrival, or return None.

    A trailing date ("EDDS to EDDP - 16 Aug 2026") is not part of the route.
    Airport names may contain " - " themselves (LFBN "Niort - Marais
    Poitevin"), so in a name with ICAO codes only a separator (" - ", " to ",
    " > ", see ``_ROUTE_SEPARATOR``) followed by a code can split it, and
    exactly one such separator must exist; without one, a separator between
    two codes ("EDDF-EDDM", see ``_CODE_SEPARATOR``) can, exactly one as
    well. A standardized single airport name is never a route. A name
    without any code splits at its only " - ".
    """
    if not name:
        return None
    name = _ROUTE_DATE_SUFFIX.sub("", name).strip()

    if not extract_icao_codes_from_name(name):
        parts = [part.strip() for part in name.split(" - ")]
        if len(parts) == 2 and all(parts):
            return parts[0], parts[1]
        return None

    icao_code = airport_icao_code(name)
    if icao_code is not None and database_airport_name(icao_code) == name:
        return None

    separators = [
        match
        for match in _ROUTE_SEPARATOR.finditer(name)
        if _starts_with_icao_code(name[match.end() :])
    ]
    # One between two codes only where no separator with spaces is: in
    # "EDDS - EDDF/EDDM" the arrival is "EDDF/EDDM", as it always was
    if not separators:
        separators = [
            match
            for match in _CODE_SEPARATOR.finditer(name)
            if _starts_with_icao_code(name[match.start() - 4 :])
            and _starts_with_icao_code(name[match.end() :])
        ]
    if len(separators) != 1:
        return None
    # The name is stripped, and a separator starts with whitespace or after
    # a code, so neither side can be empty
    return name[: separators[0].start()], name[separators[0].end() :]


class AirportNames(NamedTuple):
    """A standardized placemark name and, for a route, its two airports."""

    name: str | None
    start_airport: str | None = None
    end_airport: str | None = None


def _standardize_single_airport(name: str) -> str:
    icao_code = airport_icao_code(name)
    standardized = database_airport_name(icao_code) if icao_code else None
    if standardized is None:
        return name
    logger.debug("Standardized airport: %s -> %s", name, standardized)
    return standardized


def standardize_route(departure: str, arrival: str) -> AirportNames:
    """Standardize both airports of a route and build its display name."""
    start = _standardize_single_airport(departure)
    end = _standardize_single_airport(arrival)
    return AirportNames(f"{start} - {end}", start, end)


def standardize_airport_names(airport_name: str | None) -> AirportNames:
    """Standardize a placemark name using the OurAirports database.

    ICAO codes become "CODE Name". A route also returns its departure and
    arrival airport, so that nothing downstream has to split the display
    name (``split_route_name`` explains why that is ambiguous).
    """
    if not airport_name:
        return AirportNames(airport_name)

    route = split_route_name(airport_name)
    if route is not None:
        return standardize_route(*route)

    single = _ROUTE_DATE_SUFFIX.sub("", airport_name).strip() or airport_name
    return AirportNames(_standardize_single_airport(single))
