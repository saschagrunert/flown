"""The Terrarium tiles of the elevation model, fetched from AWS once.

The tiles are kept in the cache directory as the PNGs they arrived as, and
their pixels next to them (see ``terrain_pixels``); ``terrain`` samples the
ground under the flights from them.
"""

import base64
import contextlib
import re
import ssl
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from http.client import HTTPException, HTTPSConnection
from typing import TYPE_CHECKING
from urllib.parse import unquote, urljoin, urlsplit
from urllib.request import getproxies, proxy_bypass

from . import __version__
from .cache import CACHE_DIR, atomic_bytes_write
from .logger import logger
from .terrain_pixels import (
    DecodeFailedError,
    TileKey,
    decode_cached_tile,
    has_current_pixels,
    is_tile_png,
)
from .workers import WorkerPool, default_worker_count

if TYPE_CHECKING:
    from array import array
    from collections.abc import Callable, Iterable, Mapping, Sequence
    from pathlib import Path

__all__ = ["TERRAIN_CACHE_DIR", "TerrariumTiles"]

TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
TERRAIN_CACHE_DIR = CACHE_DIR / "terrain"
# A temp file of the cache this old is left from a write that never ended
# (see TerrariumTiles.remove_stale_temp_files)
STALE_TEMP_SECONDS = 24 * 3600

# Downloads in flight at once: S3 answers each in a fraction of a second, so
# a few overlap the latency without hammering the host
FETCH_WORKERS = 8
FETCH_TIMEOUT_SECONDS = 20
# A request that fails on the way (a dropped connection, a timeout) or that
# the host answers with a server error is tried this often, waiting
# FETCH_RETRY_SECONDS before the second attempt and twice as long before each
# one after: one glitch must not leave every other tile of the run unfetched
FETCH_ATTEMPTS = 4
FETCH_RETRY_SECONDS = 1.0
# Too many requests, and the server errors worth another attempt
_RETRIED_HTTP_CODES = frozenset({429, 500, 502, 503, 504})
# Tiles in a row, across the fetch threads, that used up their attempts on
# server errors before the host is given up for the run. One such tile
# costs only itself; a host that answers every tile so would otherwise cost
# every tile of the run its attempts and pauses, minutes for a few hundred.
SERVER_ERROR_TILES_TO_GIVE_UP = 3
# Redirects followed to the same host over https, and how many in a row: the
# tiles never move, and a redirect elsewhere would hand the request to a host
# nobody chose
_REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})
MAX_REDIRECTS = 3


def _https_proxy(host: str) -> tuple[str, int, dict[str, str]] | None:
    """The proxy the environment sets for https to ``host``, None for none.

    ``urlopen`` honours HTTPS_PROXY and NO_PROXY (and the lowercase names),
    and a build behind a mandatory proxy reaches no tile without it. The
    proxy is spoken to in plain http and asked to CONNECT to the host, as
    ``urlopen`` does; a URL without a scheme is taken as http, and one
    without a port gets that of its scheme. Credentials in the URL are sent
    as basic Proxy-Authorization.
    """
    proxy = getproxies().get("https")
    if not proxy or proxy_bypass(host):
        return None
    parts = urlsplit(proxy if "://" in proxy else f"http://{proxy}")
    if not parts.hostname:
        return None
    headers: dict[str, str] = {}
    if parts.username is not None:
        credentials = f"{unquote(parts.username)}:{unquote(parts.password or '')}"
        headers["Proxy-Authorization"] = "Basic " + base64.b64encode(
            credentials.encode()
        ).decode("ascii")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return parts.hostname, port, headers


class _RefusedURLError(ValueError):
    """A URL the fetch does not follow: not https, or a redirect elsewhere.

    The host answered, so like a status that is not tried again it costs
    only this tile, and the host stays online for the others.
    """


# A tile is about 100 KB; anything far larger is not a tile
MAX_TILE_BYTES = 4 * 1024 * 1024
# A tile as it is kept (see TerrariumTiles.path), and its pixels next to it
_TILE_FILE = re.compile(r"\d+-\d+-\d+\.(?:png|pixels)")
USER_AGENT = f"flown/{__version__} (+https://github.com/saschagrunert/flown)"
# Below this many tiles decoding them in this process beats starting a pool
DECODE_POOL_MIN_TILES = 8


class TerrariumTiles:
    """Terrarium tiles from AWS, kept in a cache directory.

    A tile is fetched once and kept as the PNG it arrived as, and its
    pixels once decoded next to it. A request that fails on the way or with
    a server error is tried again (see ``FETCH_ATTEMPTS``); the first one
    that fails every time (offline, DNS, the host down) stops the other
    downloads of the run, and so do ``SERVER_ERROR_TILES_TO_GIVE_UP`` tiles
    in a row that got server errors every time. A tile the host answers with
    another error is only missing itself. None of it fails the build on its
    own.
    """

    def __init__(
        self,
        cache_dir: Path | None = None,
        *,
        get: Callable[[str], tuple[int, bytes]] | None = None,
        workers: int | None = None,
        keep_ground: bool = True,
        attempts: int = FETCH_ATTEMPTS,
    ) -> None:
        """Keep the tiles in ``cache_dir`` (by default ``TERRAIN_CACHE_DIR``).

        ``get`` fetches a URL in place of ``http.client`` and answers with
        the status and the body, as ``_get`` does; the browser build passes
        one (see ``flown.browser``), which has no sockets. ``workers`` is how
        many tiles are fetched at once (``FETCH_WORKERS`` by default); one
        fetches them in this thread, where no other can be started. With
        ``keep_ground``, the ground sampled under each flight is kept in
        ``ground_dir`` (see ``terrain.sample_path_elevations``); the build
        in the page keeps none, which prunes the tiles of the flights it
        no longer has (see ``prune_except``). ``attempts`` is how often a
        tile is tried (``FETCH_ATTEMPTS`` by default); the build in the page
        tries each once, which is offline more often than a build of a site.
        """
        self.cache_dir = cache_dir if cache_dir is not None else TERRAIN_CACHE_DIR
        self.ground_dir = self.cache_dir / "ground" if keep_ground else None
        self._get_url = get if get is not None else self._get
        self.workers = workers
        self.attempts = max(1, attempts)
        self._offline = threading.Event()
        # Tiles in a row that used up their attempts on server errors (see
        # SERVER_ERROR_TILES_TO_GIVE_UP), across the fetch threads
        self._server_error_tiles = 0
        self._server_error_lock = threading.Lock()
        # One context for the run: building it reads the system's
        # certificates, a few milliseconds every tile would pay again
        self._ssl_context = ssl.create_default_context()
        # One connection per fetch thread, reused from tile to tile: a TLS
        # handshake with S3 takes longer than a tile does
        self._local = threading.local()
        # Every connection opened, so the ones the threads leave open are
        # closed when the downloads are done (see fetch)
        self._opened: list[HTTPSConnection] = []
        self._opened_lock = threading.Lock()
        # Every tile asked for since the instance was made (see prune_except)
        self.asked: set[TileKey] = set()

    def path(self, tile: TileKey) -> Path:
        """Where a tile is kept."""
        return self.cache_dir / f"{tile.z}-{tile.x}-{tile.y}.png"

    def remove_stale_temp_files(self) -> int:
        """Remove the temp files of writes a killed build left behind.

        A tile and its pixels are written through a temp file next to them
        (see ``cache.atomic_bytes_write``), which a build killed on the way
        leaves in the cache for good: the tiles themselves are never pruned,
        except by the build in the page (see ``prune_except``).
        One older than ``STALE_TEMP_SECONDS`` is no write still going on.
        Returns how many went.
        """
        oldest = time.time() - STALE_TEMP_SECONDS
        removed = 0
        # A missing or unreadable directory globs to nothing
        for entry in list(self.cache_dir.glob(".*.tmp")):
            with contextlib.suppress(OSError):
                if entry.stat().st_mtime < oldest:
                    entry.unlink()
                    removed += 1
        return removed

    def prune_except(self, tiles: Iterable[TileKey]) -> int:
        """Remove every tile but ``tiles``, its pixels and stale temp files.

        For a cache of one person's flights alone, the build in the page
        (see ``flown.browser``): the tiles under a flight they removed show
        roughly where it went, and every tile kept is read into the page's
        memory at each start. Returns how many files went.
        """
        kept = {self.path(tile).stem for tile in tiles}
        try:
            entries = list(self.cache_dir.iterdir())
        except OSError:
            return 0
        removed = 0
        for entry in entries:
            if entry.stem in kept or not (
                _TILE_FILE.fullmatch(entry.name)
                or (entry.name.startswith(".") and entry.name.endswith(".tmp"))
            ):
                continue
            with contextlib.suppress(OSError):
                entry.unlink()
                removed += 1
        return removed

    def _connection(self, host: str) -> HTTPSConnection:
        """This thread's connection to ``host``, opened when there is none.

        Through the proxy of the environment, when it sets one for the host
        (see ``_https_proxy``).
        """
        connection: HTTPSConnection | None = getattr(self._local, "connection", None)
        # The host the connection reaches, which through a proxy is not
        # the one it connects to
        if connection is None or getattr(self._local, "host", None) != host:
            self._close_connection()
            proxy = _https_proxy(host)
            if proxy is None:
                connection = HTTPSConnection(
                    host, timeout=FETCH_TIMEOUT_SECONDS, context=self._ssl_context
                )
            else:
                proxy_host, proxy_port, headers = proxy
                connection = HTTPSConnection(
                    proxy_host,
                    proxy_port,
                    timeout=FETCH_TIMEOUT_SECONDS,
                    context=self._ssl_context,
                )
                connection.set_tunnel(host, headers=headers)
            self._local.connection = connection
            self._local.host = host
            with self._opened_lock:
                self._opened.append(connection)
        return connection

    def _close_connection(self) -> None:
        """Drop this thread's connection; the next request opens one again."""
        connection: HTTPSConnection | None = getattr(self._local, "connection", None)
        if connection is not None:
            connection.close()
            self._local.connection = None

    def _get(self, url: str) -> tuple[int, bytes]:
        """The status and the body of ``url``, redirects on the host followed.

        A redirect that leaves https or the host is not followed: the tiles
        never move, and the request must not end up at a host nobody chose.
        Raises ``_RefusedURLError`` for such a redirect, and the errors of
        ``http.client`` for a connection that fails.
        """
        for _ in range(MAX_REDIRECTS + 1):
            parts = urlsplit(url)
            if parts.scheme != "https" or not parts.netloc:
                raise _RefusedURLError(f"refusing to fetch {url}: not https")
            connection = self._connection(parts.netloc)
            connection.request(
                "GET",
                parts.path + (f"?{parts.query}" if parts.query else ""),
                headers={"User-Agent": USER_AGENT},
            )
            response = connection.getresponse()
            data: bytes = response.read(MAX_TILE_BYTES + 1)
            if not response.isclosed():
                # The body was cut short at MAX_TILE_BYTES. Its rest would
                # stay on the connection and the next tile of this thread
                # would fail on it (ResponseNotReady), count as the host
                # unreachable and, repeated, give the host up for the run.
                # The next request opens a fresh connection instead.
                self._close_connection()
            if response.status not in _REDIRECT_CODES:
                return response.status, data
            location = response.getheader("Location") or ""
            # A Location may be relative to the URL it answers
            target = urljoin(url, location)
            target_parts = urlsplit(target)
            if (
                not location
                or target_parts.scheme != "https"
                or target_parts.netloc != parts.netloc
            ):
                raise _RefusedURLError(
                    f"refusing the redirect from {url} to {location!r}"
                )
            url = target
        raise _RefusedURLError(f"too many redirects from {url}")

    def _fetch(self, url: str) -> bytes | None:
        """The body the host answers ``url`` with, None when there is none.

        Tries again with a growing pause after a failure on the way or a
        server error, and gives the host up for the run (see ``_offline``)
        once the last attempt failed on the way as well. A server error is
        the host answering: the other tiles may well get through, unless
        ``SERVER_ERROR_TILES_TO_GIVE_UP`` tiles in a row got nothing else.
        """
        error: Exception | str | None = None
        unreachable = False
        for attempt in range(self.attempts):
            if attempt:
                time.sleep(FETCH_RETRY_SECONDS * 2 ** (attempt - 1))
            if self._offline.is_set():
                return None
            try:
                status, data = self._get_url(url)
            except _RefusedURLError as e:
                logger.debug("Elevation tile %s: %s", url, e)
                return None
            # http.client.IncompleteRead (a connection dropped mid-body) is
            # no OSError
            except (OSError, HTTPException, ValueError) as e:
                # Whatever state the connection is in, the next attempt
                # starts a fresh one
                self._close_connection()
                error = e
                unreachable = True
            else:
                if status == 200:
                    with self._server_error_lock:
                        self._server_error_tiles = 0
                    return data
                if status not in _RETRIED_HTTP_CODES:
                    # The host answered: this tile is missing, the others
                    # may not be
                    logger.debug("Elevation tile %s: HTTP %s", url, status)
                    return None
                error = f"HTTP {status}"
                unreachable = False
            logger.debug(
                "Elevation tile %s, attempt %d of %d: %s",
                url,
                attempt + 1,
                self.attempts,
                error,
            )
        if unreachable and not self._offline.is_set():
            self._offline.set()
            logger.debug("Elevation tiles unreachable: %s", error)
        elif not unreachable:
            with self._server_error_lock:
                self._server_error_tiles += 1
                given_up = self._server_error_tiles >= SERVER_ERROR_TILES_TO_GIVE_UP
            if given_up and not self._offline.is_set():
                self._offline.set()
                logger.debug(
                    "Elevation tiles: %d tiles in a row got %s, giving the host up",
                    SERVER_ERROR_TILES_TO_GIVE_UP,
                    error,
                )
        return None

    def _download(self, tile: TileKey) -> int:
        """Fetch a tile into the cache; the bytes fetched, 0 when it failed."""
        if self._offline.is_set():
            return 0
        url = TILE_URL.format(z=tile.z, x=tile.x, y=tile.y)
        data = self._fetch(url)
        if data is None:
            return 0
        if len(data) > MAX_TILE_BYTES or not is_tile_png(data):
            logger.debug("Elevation tile %s is not a PNG tile", url)
            return 0
        try:
            # Readable like a regular write, for a shared cache (a build
            # container, a CI runner)
            atomic_bytes_write(self.path(tile), data)
        except OSError as e:
            logger.debug("Cannot cache elevation tile %s: %s", url, e)
            return 0
        return len(data)

    def fetch(self, tiles: Iterable[TileKey]) -> None:
        """Download the tiles that are not in the cache yet."""
        missing = [tile for tile in tiles if not self.path(tile).is_file()]
        if not missing:
            return
        try:
            self.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            logger.debug("Cannot create %s: %s", self.cache_dir, e)
            return
        started = time.monotonic()
        workers = self.workers if self.workers is not None else FETCH_WORKERS
        try:
            if workers <= 1:
                fetched = [size for size in map(self._download, missing) if size]
            else:
                with ThreadPoolExecutor(max_workers=workers) as pool:
                    fetched = [
                        size for size in pool.map(self._download, missing) if size
                    ]
        finally:
            # The threads are gone; their connections would only wait for
            # the host to drop them
            with self._opened_lock:
                opened, self._opened = self._opened, []
            for connection in opened:
                connection.close()
        logger.info(
            "  Downloaded %d of %d elevation tile(s), %.1f MB in %.1f s",
            len(fetched),
            len(missing),
            sum(fetched) / 1024 / 1024,
            time.monotonic() - started,
        )

    def pixels(
        self, wanted: Mapping[TileKey, Sequence[int]]
    ) -> dict[TileKey, Sequence[float]]:
        """Fetch what is missing, then decode the pixels of every tile."""
        self.asked.update(wanted)
        self.remove_stale_temp_files()
        self.fetch(wanted)
        cached = [
            (tile, self.path(tile)) for tile in wanted if self.path(tile).is_file()
        ]
        paths = [path for _, path in cached]
        indices = [wanted[tile] for tile, _ in cached]
        # Decoding a tile takes a few tens of milliseconds of pure Python,
        # which adds up over hundreds of them; the cores share it. Once the
        # pixels of every tile are kept, reading them takes less time than
        # starting the pool.
        # The pixels of an older version count: after an upgrade every tile
        # is decoded again, which the pool takes a tenth of the time for
        to_decode = sum(not has_current_pixels(path) for path in paths)
        if to_decode < DECODE_POOL_MIN_TILES:
            decoded = list(map(decode_cached_tile, paths, indices, strict=True))
        else:
            workers = min(default_worker_count(), len(cached))
            # The workers log at the parent's level, so --debug names the
            # tiles they could not use. A pool that cannot start (no
            # semaphores in a sandbox) decodes here (see WorkerPool)
            with WorkerPool(
                workers, "decoding the elevation tiles", (logger.getEffectiveLevel(),)
            ) as pool:
                try:
                    decoded = list(
                        pool.map(
                            decode_cached_tile,
                            paths,
                            indices,
                            chunksize=max(1, len(cached) // (workers * 4)),
                        )
                    )
                except (BrokenProcessPool, MemoryError) as e:
                    # A worker killed for its memory, or out of it, must not
                    # fail the build: the tiles the workers got through kept
                    # their pixels, so the rest are decoded here, one after
                    # the other. That risks the parent being killed for its
                    # memory in turn, for keeping the ground; one tile at a
                    # time takes far less than the pool did
                    pool.fall_back(e)
                    decoded = self._decode_here(paths, indices)
        return {
            tile: values
            for (tile, _), values in zip(cached, decoded, strict=True)
            if values is not None
        }

    @staticmethod
    def _decode_here(
        paths: Sequence[Path], indices: Sequence[Sequence[int]]
    ) -> list[array[float] | None]:
        """Decode the tiles in this process, after the pool failed."""
        try:
            return list(map(decode_cached_tile, paths, indices, strict=True))
        except MemoryError as e:
            raise DecodeFailedError(str(e) or type(e).__name__) from e
