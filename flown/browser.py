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
(``WorkerPool`` falls back on its own, the tile fetcher is told).

The cache directory is read when ``flown.cache`` is imported, so the worker
sets ``FLOWN_CACHE_DIR`` before it imports anything of the package; the
modules that need it are imported in ``build`` for the same reason.
"""

from __future__ import annotations

import contextlib
import io
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

__all__ = ["BuildOutcome", "build", "install_network", "xhr_get"]

#: What ``build`` answers the worker with, as a plain dict for the page
type BuildOutcome = dict[str, Any]


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


class _Relay(logging.Handler):
    """Hands every log line of the build to the page."""

    def __init__(self, report: Callable[[str, str], None]) -> None:
        super().__init__(logging.INFO)
        self._report = report

    def emit(self, record: logging.LogRecord) -> None:
        with contextlib.suppress(Exception):
            self._report(record.levelname.lower(), record.getMessage())


@contextlib.contextmanager
def _relayed(report: Callable[[str, str], None] | None) -> Iterator[None]:
    from .logger import logger  # noqa: PLC0415

    if report is None:
        yield
        return
    handler = _Relay(report)
    logger.addHandler(handler)
    try:
        yield
    finally:
        logger.removeHandler(handler)


def input_files(input_dir: str | Path) -> tuple[list[str], list[Path]]:
    """The flights in ``input_dir`` and the aircraft files next to them.

    The files keep the names they were dropped with, which the aircraft and
    the year of a flight are read from (see ``aircraft``), in name order:
    the page has no order of its own to hand on.
    """
    root = Path(input_dir)
    kml_files = sorted(
        str(path)
        for path in root.iterdir()
        if path.is_file() and path.suffix.lower() in (".kml", ".kmz")
    )
    aircraft = root / "aircraft.json"
    return kml_files, [aircraft] if aircraft.is_file() else []


def build(
    input_dir: str,
    output_dir: str,
    report: Callable[[str, str], None] | None = None,
    terrain: bool = True,
) -> BuildOutcome:
    """Build the data files of the flights in ``input_dir`` into ``output_dir``.

    ``report`` is told every log line of the build (its level and its
    message), which the page shows as progress. ``terrain`` samples the
    ground under the flights from the elevation tiles, fetched through the
    worker and kept in the cache directory. Answers with the years, the
    extent the map opens on and what was found; raises the errors of
    ``export_flight_data`` for inputs that make no site.
    """
    from .renderer import export_flight_data  # noqa: PLC0415
    from .terrain_fetch import TerrariumTiles  # noqa: PLC0415
    from .workers import configure_workers  # noqa: PLC0415

    install_network()
    configure_workers(1)
    kml_files, aircraft_files = input_files(input_dir)
    source = TerrariumTiles(get=_xhr_tile_get, workers=1) if terrain else None
    with _relayed(report):
        result = export_flight_data(
            kml_files, output_dir, aircraft_files=aircraft_files, terrain=source
        )
    extent = result.extent
    return {
        "years": list(result.years),
        "flights": result.flights,
        "airports": result.airports,
        "center": [extent.center_lat, extent.center_lon],
        "bounds": [
            [extent.min_lat, extent.min_lon],
            [extent.max_lat, extent.max_lon],
        ],
    }
