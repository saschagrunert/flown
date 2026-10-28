"""The build of the flights someone drops on the page, in the browser.

The page runs this package in a Web Worker with Pyodide (see
``frontend/services/localWorker.ts``) and calls ``build`` with the files the
visitor dropped, written into Pyodide's file system. The result is the data
files ``export_flight_data`` writes, which the page then serves to itself
from the browser's storage, and nothing leaves the browser.

Two things a browser has not, the build gets from here: sockets, and threads.
The airport database is fetched with the worker's synchronous
``XMLHttpRequest`` instead (``install_network``), which is what a worker may
do; every pool of the build runs in the worker's one thread
(``configure_workers`` tells the pools). The elevation tiles, some hundred
of them, the worker fetches itself, several at a time, between two runs of
a build (see ``build``).

The cache directory is read when ``flown.cache`` is imported, so the worker
sets ``FLOWN_CACHE_DIR`` before it imports anything of the package, this
module among it.
"""

from __future__ import annotations

import contextlib
import io
import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .cache import atomic_bytes_write
from .exceptions import FlownError, InvalidInputError
from .logger import logger
from .terrain_fetch import MAX_TILE_BYTES, TILE_URL, TerrariumTiles
from .terrain_pixels import (
    TileKey,
    drop_decoded_png,
    has_current_pixels,
    is_tile_png,
    keep_decoded_planes,
)
from .validation import find_kml_files

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Iterator

__all__ = [
    "MAX_INPUT_BYTES",
    "MAX_KML_BYTES",
    "BuildOutcome",
    "TilesWantedError",
    "build",
    "install_network",
    "xhr_get",
]

#: What ``build`` answers the worker with, as a plain dict for the page
type BuildOutcome = dict[str, Any]

# The aircraft files of a drop, as the page names them (input_files)
_AIRCRAFT_FILE = re.compile(r"aircraft(?:-([1-9]\d*))?\.json")


# How long a download may take before it counts as failed: the airport
# database is 16 MB, which a slow line takes a while over
DATABASE_TIMEOUT_SECONDS = 120.0

# The largest KML a build in the page reads, a file's or the document of a
# KMZ inflated (MAX_FILE_BYTES in ui/localMessages.ts): a third of what the
# site build reads (validation.MAX_KML_FILE_SIZE). The parse takes some
# twenty times the document's size at its peak (a 73 MB file took 1.46 GB
# natively), and the runtime in the page has 4 GB at most, a phone's tab far
# less. 32 MB of a track is more than a hundred hours of fixes once a second.
MAX_KML_BYTES = 32 * 1024 * 1024

# The most KML a build in the page reads in all (MAX_KEPT_BYTES in
# ui/localMessages.ts, which holds the files kept to it): the page counts a
# KMZ as it is kept, compressed ten to twenty times, and the memory a build
# takes follows the documents inside
MAX_INPUT_BYTES = 200 * 1024 * 1024


def xhr_get(
    url: str, timeout: float = DATABASE_TIMEOUT_SECONDS
) -> tuple[int, bytes, str]:
    """GET ``url`` with the worker's synchronous XMLHttpRequest.

    Answers with the status, the body and the URL the response came from
    (after redirects, which the browser follows). A request that gets no
    answer at all (offline, a host that does not exist, a CORS refusal) or
    none within ``timeout`` seconds raises ``OSError``, which is what the
    callers degrade on; a worker may set the timeout of a synchronous
    request, a window may not.
    """
    from js import XMLHttpRequest  # type: ignore[import-not-found]  # noqa: PLC0415

    request = XMLHttpRequest.new()
    request.open("GET", url, False)
    request.responseType = "arraybuffer"
    request.timeout = int(timeout * 1000)
    try:
        request.send()
    # Pyodide raises a JsException for a request that gets no answer, which
    # is no OSError and is only importable there
    except Exception as e:  # noqa: BLE001
        raise OSError(f"{url}: {e}") from None
    status = int(request.status)
    if status == 0:
        raise OSError(f"{url}: no response")
    response = request.response
    body = bytes(response.to_py()) if response is not None else b""
    return status, body, str(request.responseURL or url)


class _XhrResponse:
    """What ``urlopen`` answers, as far as ``airport_lookup`` reads it."""

    def __init__(self, status: int, body: bytes, url: str) -> None:
        self.status = status
        self.url = url
        self._body = body
        self.headers = {"Content-Length": str(len(body))}

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            data, self._body = self._body, b""
        else:
            data, self._body = self._body[:size], self._body[size:]
        return data

    def __enter__(self) -> _XhrResponse:
        return self

    def __exit__(self, *exc: object) -> None:
        return None


def _xhr_urlopen(
    url: str, timeout: float = DATABASE_TIMEOUT_SECONDS, **_kwargs: Any
) -> _XhrResponse:
    """``urlopen`` over ``xhr_get``: a status other than 200 is an error."""
    from urllib.error import HTTPError  # noqa: PLC0415

    status, body, final_url = xhr_get(url, timeout)
    if status != 200:
        raise HTTPError(url, status, f"HTTP {status}", {}, io.BytesIO(body))  # type: ignore[arg-type]
    return _XhrResponse(status, body, final_url)


def install_network() -> None:
    """Route the package's downloads through the worker's XMLHttpRequest."""
    from . import airport_lookup  # noqa: PLC0415

    # The name the module calls, as the tests replace it (see conftest)
    airport_lookup.urlopen = _xhr_urlopen  # type: ignore[attr-defined,assignment]


# The steps of a build the page says, by the log line each starts with:
# the visitor is told these, not the lines themselves, which are the
# command line's (sizes, checksums, timings) and a screen reader read out
# one by one
PHASES = {
    "Parsing %d KML file(s)...": "Reading your files…",
    "📥 Downloading the OurAirports %s...": "Fetching the airport names…",
    "\nProcessing %d start points...": "Finding the airports…",
    "\n  Exporting data to JSON files...": "Writing your flights…",
}
# The most warnings a build hands back, for the panel to show, besides
# those of DEGRADED and a line that counts the rest
MAX_WARNINGS = 10

# The warnings of a build that went on without what it could not fetch,
# by the line each is logged with: what it went without (``degraded`` of
# the outcome, which the page offers to build again once the connection is
# back), and what the page says instead of the command line's line, which
# gives its way out (an environment variable) or guesses at the cause
DEGRADED: dict[str, tuple[str, str]] = {
    "Airport database unavailable: the airports keep the names the files "
    "give them (set %s=1 to stop instead)": (
        "airports",
        (
            "The airport names could not be fetched: the airports keep the "
            "names your files give them, and no landings are counted"
        ),
    ),
    "Runway database unavailable - touchdowns get no runway": (
        "runways",
        (
            "The runways could not be fetched: the landings are counted "
            "without their runways"
        ),
    ),
    "Terrain: %d of %d elevation tile(s) are unavailable (offline?); "
    "%d flight(s) keep the ground between their airfields": (
        "terrain",
        (
            "The ground under some of your flights could not be fetched: the "
            "3D view draws it as a straight line between their airfields"
        ),
    ),
}
# Warnings of the command line's that say nothing in the page: of the names
# a site would publish, which nothing of a build in the browser is; the
# downloads that failed, with their URLs, of a database the page then says
# is missing in its own words (DEGRADED); and the landings not counted
# without the airports, which those words say already
UNSAID = frozenset(
    {
        (
            "Cannot check the published airport names for free text: the "
            "airport database is empty"
        ),
        "✗ Failed to download the %s: %s",
        "✗ Refusing the %s from %s: redirected off %s",
        "✗ The %s exceeds %d MB, refusing to cache it",
        "✗ The %s download is incomplete (%d of %s bytes)",
        "✗ The %s download has only %d rows, expected at least %d",
        "✗ The downloaded %s is empty or invalid",
        "No airport database: the landings are not counted",
    }
)


class _Relay(logging.Handler):
    """Tells the page the steps of the build, and keeps its warnings.

    A line of ``PHASES`` is reported as its step; a warning is kept, without
    the directory the files were written into, for the page to show once the
    build is done (``warnings``), in the page's words where ``DEGRADED`` has
    them, and what the build went without in ``degraded``. Up to
    ``MAX_WARNINGS`` of them, and those of ``DEGRADED`` whenever they come
    (the ground's is logged late, after the warnings of every file); the
    others are counted, and the count said last. Errors are not: a build
    that fails raises, and a file it skips is named with its reason (see
    ``build``).
    """

    #: What the page says of the runways missing (DEGRADED)
    RUNWAYS_SAID = DEGRADED["Runway database unavailable - touchdowns get no runway"][1]

    def __init__(self, report: Callable[[str, str], None], input_dir: str) -> None:
        super().__init__(logging.INFO)
        self._report = report
        self._prefix = input_dir.rstrip("/") + "/"
        self._phase: str | None = None
        self.warnings: list[str] = []
        self.degraded: set[str] = set()
        # The warnings past MAX_WARNINGS, which are only counted
        self._unsaid: set[str] = set()

    def emit(self, record: logging.LogRecord) -> None:
        with contextlib.suppress(Exception):
            if record.levelno == logging.WARNING:
                template = str(record.msg)
                if template in UNSAID:
                    return
                missing, said = DEGRADED.get(template, (None, None))
                if missing:
                    self.degraded.add(missing)
                message = said or record.getMessage().replace(self._prefix, "").strip()
                if message in self.warnings:
                    return
                if said or len(self.warnings) < MAX_WARNINGS:
                    self.warnings.append(message)
                else:
                    self._unsaid.add(message)
                return
            phase = PHASES.get(str(record.msg))
            if phase is not None and phase != self._phase:
                self._phase = phase
                self._report("info", phase)

    def outcome(self) -> dict[str, list[str]]:
        """The warnings and what the build went without, as ``build`` answers.

        Without the airports no landing is counted at all: that the runways
        are missing too says nothing more, and seemed to say that some were.
        """
        degraded = set(self.degraded)
        warnings = self.warnings
        if "airports" in degraded and "runways" in degraded:
            degraded.discard("runways")
            warnings = [w for w in warnings if w != self.RUNWAYS_SAID]
        if unsaid := len(self._unsaid):
            warnings = [
                *warnings,
                f"{unsaid} more warning{'' if unsaid == 1 else 's'} not shown",
            ]
        return {"warnings": warnings, "degraded": sorted(degraded)}


@contextlib.contextmanager
def _relayed(
    report: Callable[[str, str], None] | None, input_dir: str
) -> Iterator[_Relay]:
    from .logger import logger  # noqa: PLC0415

    handler = _Relay(report or (lambda _level, _message: None), input_dir)
    logger.addHandler(handler)
    try:
        yield handler
    finally:
        logger.removeHandler(handler)


def input_files(input_dir: str | Path) -> tuple[list[str], list[Path]]:
    """The flights in ``input_dir`` and the aircraft files next to them.

    The files keep the names they were dropped with, which the aircraft of
    a flight is read from (see ``aircraft``; the year comes from the times
    in the file), listed as the site build lists them
    (``validation.find_kml_files``): by the number a name starts with, as
    the page has no order of its own to hand on and ``10_`` plays after
    ``2_`` there, without the AppleDouble files of a folder from macOS
    (``._1_x.kml``).

    The aircraft files are ``aircraft.json`` and those the page numbers
    after it, ``aircraft-2.json`` and on, for every one dropped: on from
    the ones kept, and in a drop each folder's after those of the folders
    around it (aircraftName in ui/localMessages.ts). All of them, the
    highest number first, which ``merge_aircraft_data`` lets win: the one
    dropped last, so a changed aircraft.json dropped again wins over the
    one before, and of a drop the one nearest the flights, as the site
    build merges those of its directories.
    """
    root = Path(input_dir)
    files = [path for path in root.iterdir() if path.is_file()]
    kml_files = [str(path) for path in find_kml_files(root)]
    numbered = {
        path: int(match[1] or 1)
        for path in files
        if (match := _AIRCRAFT_FILE.fullmatch(path.name))
    }
    return kml_files, sorted(numbered, key=numbered.__getitem__, reverse=True)


class TilesWantedError(Exception):
    """The elevation tiles a build needs that the cache has not yet."""

    def __init__(self, tiles: list[TileKey]) -> None:
        super().__init__(f"{len(tiles)} elevation tile(s) to fetch")
        self.tiles = tiles


class _PageTiles(TerrariumTiles):
    """The elevation tiles of a build in the page, which fetches them itself.

    The worker's one thread fetched them one after the other, a synchronous
    request each: 400 tiles took a minute, nearly all of it waiting on the
    host. So the first run of a build stops at the tiles the cache has not
    (``TilesWantedError``, with ``wanting``), the worker fetches those
    several at a time and hands them in (``_take_tiles``), and the build
    runs again without ``wanting``: a tile the worker could not get is
    missing then, as it is offline.
    """

    def __init__(self, *, wanting: bool) -> None:
        super().__init__(workers=1, keep_ground=False, attempts=1)
        self.wanting = wanting

    def cached(self, tile: TileKey) -> bool:
        # Its pixels alone, once a build dropped its PNG (drop_decoded_pngs)
        return super().cached(tile) or has_current_pixels(self.path(tile))

    def fetch(self, tiles: Iterable[TileKey]) -> None:
        missing = [tile for tile in tiles if not self.cached(tile)]
        if missing and self.wanting:
            raise TilesWantedError(missing)

    def drop_decoded_pngs(self) -> None:
        """Keep only the pixels of the tiles asked for, where they are kept.

        The worker reads the whole cache into the page's memory at every
        start, and keeps it there (services/localWorker.ts): the PNG of a
        tile took as much room again as its pixels, which are all a build
        reads of it once kept (``drop_decoded_png``).
        """
        for tile in self.asked:
            drop_decoded_png(self.path(tile))


# A tile the worker hands in (see _take_tiles): its PNG, and its pixels where
# it decoded them
_TAKEN_TILE = re.compile(r"(\d+)-(\d+)-(\d+)\.png")
_TAKEN_PLANES_SUFFIX = ".planes"


def _take_tiles(tiles: TerrariumTiles, directory: Path) -> int:
    """Keep the tiles the worker fetched into ``directory`` in the cache.

    Each as ``z-x-y.png``, checked as a download is (``MAX_TILE_BYTES``,
    ``is_tile_png``), and with its pixels where the worker decoded them
    (``z-x-y.planes``, see ``keep_decoded_planes``): decoding a tile in
    Python takes the page some 50 ms. Each leaves ``directory`` once taken,
    kept or not: the worker's file system holds it in the page's memory,
    some 300 KB a tile with its pixels, for the rest of the build. Returns
    how many tiles it kept.
    """
    try:
        entries = sorted(directory.iterdir())
    except OSError:
        return 0
    kept = 0
    for entry in entries:
        match = _TAKEN_TILE.fullmatch(entry.name)
        if match is None:
            continue
        tile = TileKey(*map(int, match.groups()))
        planes_file = entry.with_suffix(_TAKEN_PLANES_SUFFIX)
        try:
            if _keep_taken_tile(tiles, tile, entry, planes_file):
                kept += 1
        finally:
            for taken in (entry, planes_file):
                with contextlib.suppress(OSError):
                    taken.unlink()
    return kept


def _keep_taken_tile(
    tiles: TerrariumTiles, tile: TileKey, png_file: Path, planes_file: Path
) -> bool:
    """Keep one tile of ``_take_tiles``, with its pixels; whether it was."""
    try:
        data = png_file.read_bytes()
        if len(data) > MAX_TILE_BYTES or not is_tile_png(data):
            logger.debug("Elevation tile %s is not a PNG tile", png_file.name)
            return False
        tiles.cache_dir.mkdir(parents=True, exist_ok=True)
        atomic_bytes_write(tiles.path(tile), data)
    except OSError as e:
        logger.debug("Cannot keep elevation tile %s: %s", png_file.name, e)
        return False
    with contextlib.suppress(OSError):
        keep_decoded_planes(tiles.path(tile), data, planes_file.read_bytes())
    return True


def _check_input_size(kml_files: list[str]) -> None:
    """Refuse inputs of more KML than ``MAX_INPUT_BYTES`` once unpacked.

    A file larger than ``MAX_KML_BYTES`` counts for nothing: it is left out.
    The error names the files that unpack the most, KMZ archives most often.
    """
    from .parser import parse_size  # noqa: PLC0415

    sizes = {
        path: size for path in kml_files if (size := parse_size(path)) <= MAX_KML_BYTES
    }
    total = sum(sizes.values())
    if total <= MAX_INPUT_BYTES:
        return
    largest = sorted(sizes, key=sizes.__getitem__, reverse=True)[:3]
    # Rounded up: never "200 MB, more than the 200 MB"
    raise InvalidInputError(
        f"Your files come to {-(-total // (1024 * 1024))} MB of KML once the KMZ "
        f"files are unpacked, more than the {MAX_INPUT_BYTES // (1024 * 1024)} "
        "MB a build in the browser reads; remove some, such as "
        + ", ".join(
            f"{Path(path).name} ({sizes[path] // (1024 * 1024)} MB)" for path in largest
        )
    )


@contextlib.contextmanager
def _kml_size_capped() -> Iterator[None]:
    """Read no KML larger than ``MAX_KML_BYTES`` while the build runs."""
    from . import parser, validation  # noqa: PLC0415

    # The parser reads the limit under the name it imported it as
    limits = (validation.__dict__, parser.__dict__)
    before = [limit["MAX_KML_FILE_SIZE"] for limit in limits]
    for limit in limits:
        limit["MAX_KML_FILE_SIZE"] = MAX_KML_BYTES
    try:
        yield
    finally:
        for limit, value in zip(limits, before, strict=True):
            limit["MAX_KML_FILE_SIZE"] = value


def build(
    input_dir: str,
    output_dir: str,
    report: Callable[[str, str], None] | None = None,
    terrain: bool = True,
    flags: list[str] | None = None,
    retry: bool = False,
    tiles_dir: str | None = None,
) -> BuildOutcome:
    """Build the data files of the flights in ``input_dir`` into ``output_dir``.

    ``report`` is told the steps of the build (see ``PHASES``), which the
    page shows as progress. ``terrain`` samples the ground under the flights
    from the elevation tiles kept in the cache directory. ``flags`` are the
    country codes the page has a flag for (its own ``available_flags``): the
    package in the page has none.

    A build that needs tiles the cache has not stops at them, and answers
    with ``tiles``, the URL of each and the name it is handed in under. The
    worker fetches them into a directory, and builds again with that as
    ``tiles_dir``: the tiles in it are kept in the cache (``_take_tiles``),
    and none is asked for again, so one the worker could not get is missing
    (``degraded``).

    A file that makes no flight is left out, and named with the reason in
    ``skipped``: the visitor sees the rest, and which file to look at. A
    file larger than ``MAX_KML_BYTES`` is one. Answers with the years, the
    extent the map opens on, what was found, the warnings of the build and
    what it went without for want of a connection (``degraded``:
    "airports", "runways", "terrain"); raises the errors of
    ``export_flight_data`` for inputs that make no site at all (naming
    the files without ``input_dir``, as the rest is said), and a
    ``MemoryError`` for one that ran out of memory on the way, which a failed
    year says only as its cause.

    A database the last build could not fetch is loaded again, and said
    again to be missing; ``retry`` downloads it again at once (see
    ``retry_missing_databases``), for the page's Build again once the
    connection may be back.

    What the cache holds of files no longer among the inputs leaves it:
    their parses, with the real dates and times, whether the build got
    through or not, and the elevation tiles under them, which show roughly
    where they went. A tile no flight of a build that got through asked for
    goes, all of them in a build without the ground, which the next one with
    it fetches again. A build that failed may not have got to the ground,
    and keeps the tiles for the next.
    """
    from .airport_lookup import retry_missing_databases  # noqa: PLC0415
    from .parser_cache import prune_cache_entries_except  # noqa: PLC0415
    from .pipeline import export_flight_data  # noqa: PLC0415
    from .workers import configure_workers  # noqa: PLC0415

    install_network()
    retry_missing_databases(download=retry)
    # No processes in the page: every pool works here, without trying
    configure_workers(1, processes=False)
    kml_files, aircraft_files = input_files(input_dir)
    tiles = _PageTiles(wanting=tiles_dir is None)
    if terrain and tiles_dir is not None:
        _take_tiles(tiles, Path(tiles_dir))
    prefix = input_dir.rstrip("/") + "/"
    built = False
    try:
        # In here: the cache lets go of the files removed all the same
        _check_input_size(kml_files)
        with _relayed(report, input_dir) as relay, _kml_size_capped():
            result = export_flight_data(
                kml_files,
                output_dir,
                aircraft_files=aircraft_files,
                terrain=tiles if terrain else None,
                skip_unusable=True,
                flags=flags,
            )
        built = True
    except TilesWantedError as e:
        return {
            "tiles": [
                {
                    "url": TILE_URL.format(z=tile.z, x=tile.x, y=tile.y),
                    "name": f"{tile.z}-{tile.x}-{tile.y}",
                }
                for tile in e.tiles
            ]
        }
    except Exception as e:
        # Said as what it is, for the page to start a runtime of its own
        if not isinstance(e, MemoryError) and _out_of_memory(e):
            raise MemoryError from e
        # The page says it: without the directory the files were written
        # into, as the warnings and the files skipped are said
        if isinstance(e, FlownError) and e.args and isinstance(e.args[0], str):
            e.args = (e.args[0].replace(prefix, ""), *e.args[1:])
        raise
    finally:
        prune_cache_entries_except(kml_files)
        if built or not terrain:
            tiles.prune_except(tiles.asked)
        # Every tile asked for was read, its pixels kept of the PNG it has
        if built:
            tiles.drop_decoded_pngs()
    extent = result.extent
    return {
        "years": list(result.years),
        "flights": result.flights,
        "airports": result.airports,
        "bounds": [
            [extent.min_lat, extent.min_lon],
            [extent.max_lat, extent.max_lon],
        ],
        "skipped": [
            {
                "file": Path(entry.kml_file).name,
                # Without the directory the files were written into, as
                # the warnings are said
                "reason": entry.reason.replace(prefix, ""),
            }
            for entry in result.skipped
        ],
        **relay.outcome(),
    }


def _out_of_memory(error: BaseException) -> bool:
    """Whether ``error`` is a ``MemoryError``, or was raised for one."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        if isinstance(current, MemoryError):
            return True
        seen.add(id(current))
        current = current.__cause__ or current.__context__
    return False
