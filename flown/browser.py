"""The build of the flights someone drops on the page, in the browser.

The page runs this package in a Web Worker with Pyodide (see
``frontend/services/localWorker.ts``) and calls ``build`` with the files the
visitor dropped, written into Pyodide's file system. The result is the data
files ``export_flight_data`` writes, which the page then serves to itself
from the browser's storage, and nothing leaves the browser.

Two things a browser has not, the build gets from here: sockets, and threads.
The airport database and the elevation tiles are fetched with the worker's
synchronous ``XMLHttpRequest`` instead (``install_network``), which is what
a worker may do; every pool of the build runs in the worker's one thread
(``configure_workers`` tells the pools, the tile fetcher is told).

The cache directory is read when ``flown.cache`` is imported, so the worker
sets ``FLOWN_CACHE_DIR`` before it imports anything of the package; the
modules that need it are imported in ``build`` for the same reason.
"""

from __future__ import annotations

import contextlib
import io
import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .helpers import numeric_filename_key
from .validation import KML_SUFFIXES

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

__all__ = ["BuildOutcome", "build", "install_network", "xhr_get"]

#: What ``build`` answers the worker with, as a plain dict for the page
type BuildOutcome = dict[str, Any]

# The aircraft files of a drop, as the page names them (input_files)
_AIRCRAFT_FILE = re.compile(r"aircraft(?:-([1-9]\d*))?\.json")


# How long a download may take before it counts as failed: the airport
# database is 16 MB, which a slow line takes a while over, a tile is small
DATABASE_TIMEOUT_SECONDS = 120.0
TILE_TIMEOUT_SECONDS = 30.0


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


def _xhr_tile_get(url: str) -> tuple[int, bytes]:
    """The tile fetcher's ``_get`` over ``xhr_get``."""
    status, body, _ = xhr_get(url, TILE_TIMEOUT_SECONDS)
    return status, body


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
# The most warnings a build hands back, for the panel to show
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
    them, and what the build went without in ``degraded``. Errors are not: a
    build that fails raises, and a file it skips is named with its reason
    (see ``build``).
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
                if message not in self.warnings and len(self.warnings) < MAX_WARNINGS:
                    self.warnings.append(message)
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
    in the file), in the order the site build takes them, by the number a
    name starts with (``numeric_filename_key``): the page has no order of
    its own to hand on, and ``10_`` plays after ``2_`` as it does there.
    The AppleDouble files of a folder from macOS (``._1_x.kml``) are left
    out, as the site build leaves them out (``validation.list_kml_files``).

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
    kml_files = sorted(
        (
            str(path)
            for path in files
            if path.suffix.lower() in KML_SUFFIXES and not path.name.startswith("._")
        ),
        key=numeric_filename_key,
    )
    numbered = {
        path: int(match[1] or 1)
        for path in files
        if (match := _AIRCRAFT_FILE.fullmatch(path.name))
    }
    return kml_files, sorted(numbered, key=numbered.__getitem__, reverse=True)


def build(
    input_dir: str,
    output_dir: str,
    report: Callable[[str, str], None] | None = None,
    terrain: bool = True,
    flags: list[str] | None = None,
    retry: bool = False,
) -> BuildOutcome:
    """Build the data files of the flights in ``input_dir`` into ``output_dir``.

    ``report`` is told the steps of the build (see ``PHASES``), which the
    page shows as progress. ``terrain`` samples the ground under the flights
    from the elevation tiles, fetched through the worker and kept in the
    cache directory. ``flags`` are the country codes the page has a flag
    for (its own ``available_flags``): the package in the page has none.

    A file that makes no flight is left out, and named with the reason in
    ``skipped``: the visitor sees the rest, and which file to look at.
    Answers with the years, the extent the map opens on, what was found,
    the warnings of the build and what it went without for want of a
    connection (``degraded``: "airports", "runways", "terrain"); raises the
    errors of ``export_flight_data`` for inputs that make no site at all,
    and a ``MemoryError`` for one that ran out of memory on the way, which a
    failed year says only as its cause.

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
    from .terrain_fetch import TerrariumTiles  # noqa: PLC0415
    from .workers import configure_workers  # noqa: PLC0415

    install_network()
    retry_missing_databases(download=retry)
    # No processes in the page: every pool works here, without trying
    configure_workers(1, processes=False)
    kml_files, aircraft_files = input_files(input_dir)
    # One attempt a tile: offline, the pauses before the others would hold up
    # every build, which Build again tries once the connection is back
    tiles = TerrariumTiles(get=_xhr_tile_get, workers=1, keep_ground=False, attempts=1)
    built = False
    try:
        with _relayed(report, input_dir) as relay:
            result = export_flight_data(
                kml_files,
                output_dir,
                aircraft_files=aircraft_files,
                terrain=tiles if terrain else None,
                skip_unusable=True,
                flags=flags,
            )
        built = True
    except Exception as e:
        # Said as what it is, for the page to start a runtime of its own
        if not isinstance(e, MemoryError) and _out_of_memory(e):
            raise MemoryError from e
        raise
    finally:
        prune_cache_entries_except(kml_files)
        if built or not terrain:
            tiles.prune_except(tiles.asked)
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
            {"file": Path(entry.kml_file).name, "reason": entry.reason}
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
