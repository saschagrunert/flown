"""Tests for the download and the cache of the elevation tiles.

flown.terrain_fetch fetches the Terrarium tiles from AWS, through a proxy
when one is set, and keeps them; flown.terrain_pixels keeps their decoded
pixels next to them. No test reaches the network: a fake HTTPS connection
answers every request, and conftest.py makes any other download fail loudly.
"""

import http.client
import logging
import os
import time
import zlib
from array import array
from compression import zstd
from concurrent.futures.process import BrokenProcessPool
from typing import ClassVar
from unittest.mock import MagicMock

import pytest

import flown.terrain as terrain_module
import flown.terrain_fetch as fetch_module
import flown.terrain_pixels as pixels_module
import flown.workers as workers_module
from flown.exceptions import TerrainUnavailableError
from flown.logger import logger
from flown.terrain import (
    TERRAIN_ZOOM,
    TILE_SIZE,
    TerrariumTiles,
    TileKey,
    sample_path_elevations,
)
from flown.terrain_pixels import has_current_pixels
from flown.types import TrackPoint
from flown.workers import init_worker
from tests.conftest import FlatTiles
from tests.tiles import FunctionTiles, encode_png, global_pixel, terrarium_png


class FakeResponse:
    """What ``HTTPSConnection.getresponse`` answers."""

    def __init__(self, status=200, body=b"", headers=None):
        self.status = status
        self._body = body
        self._headers = headers or {}

    def read(self, amount=None):
        if amount is None:
            amount = len(self._body)
        body, self._body = self._body[:amount], self._body[amount:]
        return body

    def isclosed(self):
        # A real response closes once its body is read to the end
        return not self._body

    def getheader(self, name, default=None):
        return self._headers.get(name, default)


class FakeConnection:
    """An ``HTTPSConnection`` whose answers a test scripts.

    ``answer`` is called with the request path and returns a
    ``FakeResponse``, or raises. ``connections`` counts the connections
    opened and ``requests`` lists every path asked for, across threads.
    """

    connections = 0
    requests: ClassVar[list[str]] = []
    closed = 0

    def __init__(self, host, timeout=None, context=None):
        self.host = host
        self.timeout = timeout
        self.context = context
        self.headers = None
        self.path = ""
        type(self).connections += 1

    def request(self, method, path, headers=None):
        assert method == "GET"
        self.path = path
        self.headers = headers
        type(self).requests.append(path)

    def getresponse(self):
        return self.answer(self.path)

    def close(self):
        type(self).closed += 1

    @staticmethod
    def answer(path):
        return FakeResponse(200, _tile_png(250.0))


@pytest.fixture
def connections(monkeypatch):
    """A ``FakeConnection`` in place of the real one, counters reset.

    Tests replace ``answer`` on the class; set here, monkeypatch puts the
    default back afterwards, or the next test would get the last one's
    answer and pass whatever the code does with a sound tile.
    """
    FakeConnection.connections = 0
    FakeConnection.closed = 0
    FakeConnection.requests = []
    monkeypatch.setattr(FakeConnection, "answer", FakeConnection.__dict__["answer"])
    monkeypatch.setattr(fetch_module, "HTTPSConnection", FakeConnection)
    return FakeConnection


def _answers(answer):
    """A connection class whose responses come from ``answer(path)``."""
    return type(
        "ScriptedConnection", (FakeConnection,), {"answer": staticmethod(answer)}
    )


def _tile_png(elevation=250.0):
    return terrarium_png(lambda x, y: elevation)


@pytest.fixture(autouse=True)
def no_retry_pauses(monkeypatch):
    """The pauses between the attempts of a fetch are skipped.

    A test that fails a tile on every attempt would otherwise sleep through
    the whole backoff, seven seconds of it; the tests of the pauses record
    them with a patch of their own.
    """
    monkeypatch.setattr("flown.terrain_fetch.time.sleep", lambda _: None)


@pytest.fixture(autouse=True)
def no_proxy_environment(monkeypatch):
    """No proxy of the machine running the tests reaches the fetch."""
    for name in ("https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY"):
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


class TestHttpsProxy:
    """The proxy settings urlopen honours, which the fetch honours as well."""

    class Tunnelled(FakeConnection):
        def __init__(self, host, port=None, timeout=None, context=None):
            super().__init__(host, timeout, context)
            self.port = port
            self.tunnel = None

        def set_tunnel(self, host, port=None, headers=None):
            self.tunnel = (host, headers)

    @pytest.fixture
    def tunnelled(self, monkeypatch):
        monkeypatch.setattr(self.Tunnelled, "connections", 0)
        monkeypatch.setattr(fetch_module, "HTTPSConnection", self.Tunnelled)
        return self.Tunnelled

    def test_a_proxy_tunnels_to_the_host(
        self, tmp_path, no_proxy_environment, tunnelled
    ):
        no_proxy_environment.setenv("HTTPS_PROXY", "http://proxy.example:3128")

        connection = TerrariumTiles(tmp_path)._connection("s3.amazonaws.com")

        assert isinstance(connection, tunnelled)
        assert (connection.host, connection.port) == ("proxy.example", 3128)
        assert connection.tunnel == ("s3.amazonaws.com", {})

    @pytest.mark.usefixtures("tunnelled")
    @pytest.mark.parametrize(
        ("proxy", "port"),
        [("proxy.example", 80), ("https://proxy.example", 443)],
    )
    def test_a_proxy_without_a_port_or_scheme(
        self, tmp_path, no_proxy_environment, proxy, port
    ):
        no_proxy_environment.setenv("https_proxy", proxy)

        connection = TerrariumTiles(tmp_path)._connection("s3.amazonaws.com")

        assert (connection.host, connection.port) == ("proxy.example", port)

    @pytest.mark.usefixtures("tunnelled")
    def test_credentials_in_the_proxy_url_authorize(
        self, tmp_path, no_proxy_environment
    ):
        no_proxy_environment.setenv(
            "HTTPS_PROXY", "http://me:p%40ss@proxy.example:8080"
        )

        connection = TerrariumTiles(tmp_path)._connection("s3.amazonaws.com")

        assert isinstance(connection, self.Tunnelled)
        assert connection.tunnel == (
            "s3.amazonaws.com",
            {"Proxy-Authorization": "Basic bWU6cEBzcw=="},
        )

    @pytest.mark.usefixtures("tunnelled")
    def test_no_proxy_for_the_host_connects_directly(
        self, tmp_path, no_proxy_environment
    ):
        no_proxy_environment.setenv("HTTPS_PROXY", "http://proxy.example:3128")
        no_proxy_environment.setenv("NO_PROXY", "amazonaws.com")

        connection = TerrariumTiles(tmp_path)._connection("s3.amazonaws.com")

        assert isinstance(connection, self.Tunnelled)
        assert connection.host == "s3.amazonaws.com"
        assert connection.tunnel is None

    def test_the_connection_is_kept_for_the_host(
        self, tmp_path, no_proxy_environment, tunnelled
    ):
        no_proxy_environment.setenv("HTTPS_PROXY", "http://proxy.example:3128")
        tiles = TerrariumTiles(tmp_path)

        first = tiles._connection("s3.amazonaws.com")

        assert tiles._connection("s3.amazonaws.com") is first
        assert tunnelled.connections == 1


class TestTerrariumTiles:
    def test_keeps_the_ground_next_to_the_tiles(self, tmp_path):
        """Not in the page, which prunes the tiles of flights it no longer has."""
        assert TerrariumTiles(tmp_path).ground_dir == tmp_path / "ground"
        assert TerrariumTiles(tmp_path, keep_ground=False).ground_dir is None

    def test_a_getter_of_its_own_replaces_the_connection(self, tmp_path, connections):
        """The browser build fetches with the worker's XMLHttpRequest."""
        asked = []

        def get(url):
            asked.append(url)
            return 200, _tile_png(250.0)

        tiles = TerrariumTiles(tmp_path / "terrain", get=get, workers=1)
        tile = TileKey(10, 546, 341)

        assert tiles.pixels({tile: [0]}) == {tile: array("d", [250.0])}
        assert asked == [
            "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/10/546/341.png"
        ]
        assert connections.connections == 0

    def test_one_worker_fetches_in_this_thread(self, tmp_path):
        """Where no thread can be started (Pyodide), none is."""
        import threading

        threads = set()

        def get(url):
            threads.add(threading.current_thread())
            return 200, _tile_png(250.0)

        tiles = TerrariumTiles(tmp_path / "terrain", get=get, workers=1)
        wanted = {TileKey(10, x, 1): [0] for x in range(3)}

        assert len(tiles.pixels(wanted)) == 3
        assert threads == {threading.main_thread()}

    def test_a_getter_that_fails_is_taken_like_a_lost_connection(self, tmp_path):
        def get(url):
            raise OSError("no network")

        tiles = TerrariumTiles(tmp_path / "terrain", get=get, workers=1)

        assert tiles.pixels({TileKey(10, 546, 341): [0]}) == {}

    def test_fetches_a_tile_once_and_reuses_the_cache(self, tmp_path, connections):
        body = _tile_png(250.0)
        tiles = TerrariumTiles(tmp_path / "terrain")
        tile = TileKey(10, 546, 341)

        first = tiles.pixels({tile: [0, 65535]})
        second = TerrariumTiles(tmp_path / "terrain").pixels({tile: [7]})

        assert first == {tile: array("d", [250.0, 250.0])}
        assert second == {tile: array("d", [250.0])}
        assert connections.requests == [
            "/elevation-tiles-prod/terrarium/10/546/341.png"
        ]
        assert connections.connections == 1
        assert tiles.path(tile).read_bytes() == body

    def test_one_connection_carries_the_tiles_of_a_thread(
        self, tmp_path, monkeypatch, connections
    ):
        """A handshake per tile would take longer than the tiles themselves."""
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        opened = []
        original = connections.__init__

        def record(self, host, timeout=None, context=None):
            original(self, host, timeout, context)
            opened.append((host, timeout, context))

        monkeypatch.setattr(connections, "__init__", record)
        wanted = {TileKey(10, x, 1): [0] for x in range(5)}

        tiles = TerrariumTiles(tmp_path)
        assert len(tiles.pixels(wanted)) == 5
        assert len(connections.requests) == 5
        # And closed once the downloads are done
        assert connections.closed == 1
        assert opened == [
            (
                "s3.amazonaws.com",
                fetch_module.FETCH_TIMEOUT_SECONDS,
                tiles._ssl_context,
            )
        ]

    def test_sends_the_user_agent(self, tmp_path, monkeypatch):
        seen = {}

        class Recording(FakeConnection):
            def request(self, method, path, headers=None):
                seen["headers"] = headers
                super().request(method, path, headers)

        monkeypatch.setattr(fetch_module, "HTTPSConnection", Recording)
        TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]})
        assert seen["headers"]["User-Agent"].startswith("flown/")

    def test_pixels_that_cannot_be_kept_are_decoded_again(self, tmp_path, caplog):
        """Keeping them is a saving for the next build, never a failure."""
        with caplog.at_level(logging.DEBUG, logger="flown"):
            pixels_module._keep_pixel_planes(
                tmp_path / "missing" / "10-546-341.png", b"png", b"planes"
            )
        assert "Cannot keep the pixels of 10-546-341.png" in caplog.text
        assert list(tmp_path.iterdir()) == []

    def test_a_tile_the_host_does_not_have_is_missing(self, tmp_path, monkeypatch):
        def answer(path):
            if path.endswith("/1/1.png"):
                return FakeResponse(403, b"Forbidden")
            return FakeResponse(200, _tile_png(10.0))

        monkeypatch.setattr(fetch_module, "HTTPSConnection", _answers(answer))
        wanted = {TileKey(10, 1, 1): [0], TileKey(10, 2, 1): [0]}

        answered = TerrariumTiles(tmp_path).pixels(wanted)

        assert answered == {TileKey(10, 2, 1): array("d", [10.0])}

    @pytest.mark.parametrize(
        "error",
        [
            ConnectionResetError("no network"),
            TimeoutError("timed out"),
            http.client.IncompleteRead(b""),
            http.client.RemoteDisconnected("closed"),
        ],
    )
    def test_offline_stops_asking_and_does_not_fail(
        self, tmp_path, monkeypatch, connections, error
    ):
        def answer(path):
            raise error

        connections.answer = staticmethod(answer)
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        monkeypatch.setattr(fetch_module, "FETCH_RETRY_SECONDS", 0.0)
        wanted = {TileKey(10, x, 1): [0] for x in range(5)}

        assert TerrariumTiles(tmp_path).pixels(wanted) == {}
        # Every attempt of the first tile, and none of the others
        assert len(connections.requests) == fetch_module.FETCH_ATTEMPTS
        # A fresh connection for every attempt: the old one is in no known
        # state after a failure on the way
        assert connections.connections == fetch_module.FETCH_ATTEMPTS

    def test_a_server_error_on_every_attempt_does_not_give_the_host_up(
        self, tmp_path, monkeypatch, connections
    ):
        """A 503 is the host answering: the other tiles may well get through."""
        seen = []

        def answer(path):
            seen.append(path)
            if path.endswith("/0/1.png"):
                return FakeResponse(503, b"later")
            return FakeResponse(200, _tile_png(10.0))

        connections.answer = staticmethod(answer)
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        wanted = {TileKey(10, x, 1): [0] for x in range(3)}

        answered = TerrariumTiles(tmp_path).pixels(wanted)

        assert set(answered) == {TileKey(10, 1, 1), TileKey(10, 2, 1)}
        assert len(seen) == fetch_module.FETCH_ATTEMPTS + 2

    def test_a_host_that_answers_every_tile_with_a_server_error_is_given_up(
        self, tmp_path, monkeypatch, connections
    ):
        """Every tile's attempts and pauses would take minutes for a run."""
        connections.answer = staticmethod(lambda path: FakeResponse(503, b"later"))
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        wanted = {TileKey(10, x, 1): [0] for x in range(10)}
        tiles = TerrariumTiles(tmp_path)

        assert tiles.pixels(wanted) == {}
        given_up_after = fetch_module.SERVER_ERROR_TILES_TO_GIVE_UP
        assert len(connections.requests) == (
            given_up_after * fetch_module.FETCH_ATTEMPTS
        )
        assert tiles._offline.is_set()

    def test_a_tile_that_gets_through_resets_the_server_errors(
        self, tmp_path, monkeypatch, connections
    ):
        """Only tiles in a row give the host up."""
        failing = {1, 2, 4, 5, 7, 8}

        def answer(path):
            x = int(path.rsplit("/", 2)[1])
            if x in failing:
                return FakeResponse(503, b"later")
            return FakeResponse(200, _tile_png(10.0))

        connections.answer = staticmethod(answer)
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        wanted = {TileKey(10, x, 1): [0] for x in range(10)}
        tiles = TerrariumTiles(tmp_path)

        answered = tiles.pixels(wanted)

        assert set(answered) == {TileKey(10, x, 1) for x in (0, 3, 6, 9)}
        assert not tiles._offline.is_set()

    @pytest.mark.parametrize(
        "glitch",
        [
            ConnectionResetError("connection reset"),
            TimeoutError("timed out"),
            FakeResponse(503, b"Unavailable"),
            FakeResponse(429, b"Too Many"),
        ],
    )
    def test_a_glitch_is_tried_again(self, tmp_path, monkeypatch, glitch):
        """One dropped connection must not leave the other tiles unfetched."""
        glitched = set()

        def answer(path):
            if path not in glitched:
                glitched.add(path)
                if isinstance(glitch, Exception):
                    raise glitch
                return glitch
            return FakeResponse(200, _tile_png(10.0))

        pauses: list[float] = []
        monkeypatch.setattr(fetch_module, "HTTPSConnection", _answers(answer))
        monkeypatch.setattr("flown.terrain_fetch.time.sleep", pauses.append)
        wanted = {TileKey(10, x, 1): [0] for x in range(3)}

        answered = TerrariumTiles(tmp_path).pixels(wanted)

        assert answered == {tile: array("d", [10.0]) for tile in wanted}
        assert pauses == [fetch_module.FETCH_RETRY_SECONDS] * 3

    def test_a_host_given_up_meanwhile_is_not_asked_again(
        self, tmp_path, monkeypatch, connections
    ):
        """Another tile's fetch may give the host up while this one pauses."""

        def answer(path):
            raise TimeoutError("slow")

        connections.answer = staticmethod(answer)
        tiles = TerrariumTiles(tmp_path)
        monkeypatch.setattr(
            "flown.terrain_fetch.time.sleep", lambda _: tiles._offline.set()
        )

        assert tiles.pixels({TileKey(10, 1, 1): [0]}) == {}
        assert len(connections.requests) == 1

    def test_the_pause_grows_with_every_attempt(self, tmp_path, monkeypatch):
        pauses: list[float] = []

        def answer(path):
            raise TimeoutError("slow")

        monkeypatch.setattr(fetch_module, "HTTPSConnection", _answers(answer))
        monkeypatch.setattr("flown.terrain_fetch.time.sleep", pauses.append)

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert pauses == [
            fetch_module.FETCH_RETRY_SECONDS * 2**attempt
            for attempt in range(fetch_module.FETCH_ATTEMPTS - 1)
        ]

    def test_a_tile_the_host_refuses_is_not_asked_again(self, tmp_path, connections):
        connections.answer = staticmethod(lambda path: FakeResponse(404, b"gone"))

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert len(connections.requests) == 1

    @pytest.mark.parametrize(
        ("location", "moved_to"),
        [
            ("https://s3.amazonaws.com/moved/1/1.png", "/moved/1/1.png"),
            # Relative to the URL it answers, on the same host
            ("/moved/1/1.png", "/moved/1/1.png"),
            ("../moved.png", "/elevation-tiles-prod/terrarium/10/moved.png"),
        ],
    )
    def test_follows_a_redirect_on_the_host(
        self, tmp_path, connections, location, moved_to
    ):
        def answer(path):
            if path.endswith("/10/1/1.png"):
                return FakeResponse(302, b"", {"Location": location})
            return FakeResponse(200, _tile_png(10.0))

        connections.answer = staticmethod(answer)

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {
            TileKey(10, 1, 1): array("d", [10.0])
        }
        assert connections.requests[-1] == moved_to

    @pytest.mark.parametrize(
        "target",
        [
            "https://evil.example/1/1.png",
            "http://s3.amazonaws.com/1/1.png",
            "",
        ],
    )
    def test_refuses_a_redirect_off_the_host_or_off_https(
        self, tmp_path, connections, target
    ):
        """The request must not end up at a host nobody chose."""
        connections.answer = staticmethod(
            lambda path: FakeResponse(301, b"", {"Location": target})
        )

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert all(path.endswith("/10/1/1.png") for path in connections.requests)
        assert "evil.example" not in "".join(connections.requests)

    def test_a_refused_redirect_costs_only_its_tile(
        self, tmp_path, monkeypatch, connections
    ):
        """The host answered: it stays online, and the tile is not asked again."""

        def answer(path):
            if path.endswith("/10/0/1.png"):
                return FakeResponse(302, b"", {"Location": "https://evil.example/"})
            return FakeResponse(200, _tile_png(10.0))

        connections.answer = staticmethod(answer)
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)
        wanted = {TileKey(10, x, 1): [0] for x in range(3)}
        tiles = TerrariumTiles(tmp_path)

        answered = tiles.pixels(wanted)

        assert set(answered) == {TileKey(10, 1, 1), TileKey(10, 2, 1)}
        assert len(connections.requests) == 3
        assert not tiles._offline.is_set()

    def test_gives_up_after_too_many_redirects(self, tmp_path, connections):
        connections.answer = staticmethod(
            lambda path: FakeResponse(
                307, b"", {"Location": "https://s3.amazonaws.com" + path + "/again"}
            )
        )

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}

    def test_refuses_a_tile_url_that_is_not_https(
        self, tmp_path, monkeypatch, connections
    ):
        monkeypatch.setattr(fetch_module, "TILE_URL", "http://host/{z}/{x}/{y}.png")

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert connections.requests == []

    @pytest.mark.parametrize(
        "body",
        [
            b"<html>not found</html>",
            b"\x89PNG\r\n\x1a\n" + b"junk",
            # Cut off after the header: the chunks up to it are intact
            _tile_png()[:33],
            # A sound PNG, but not a tile's size
            encode_png(4, 4, bytes(48)),
        ],
    )
    def test_refuses_a_body_that_is_no_tile(self, tmp_path, connections, body):
        """Nothing but a complete PNG of a tile's size reaches the cache."""
        connections.answer = staticmethod(lambda path: FakeResponse(200, body))
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)

        assert tiles.pixels({tile: [0]}) == {}
        assert not tiles.path(tile).exists()
        assert list(tmp_path.iterdir()) == []

    def test_refuses_an_oversized_body(self, tmp_path, monkeypatch, connections):
        """The default answer is a sound tile, refused only for its size."""
        monkeypatch.setattr(fetch_module, "MAX_TILE_BYTES", 10)

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert list(tmp_path.iterdir()) == []
        assert len(connections.requests) == 1

    def test_an_oversized_body_leaves_the_next_tile_a_fresh_connection(
        self, tmp_path, monkeypatch, connections
    ):
        """The rest of a body cut short would answer the next request."""
        normal = _tile_png(10.0)
        monkeypatch.setattr(fetch_module, "MAX_TILE_BYTES", len(normal) + 10)
        monkeypatch.setattr(fetch_module, "FETCH_WORKERS", 1)

        class Pipelined(FakeConnection):
            # Like http.client: an answer not read to the end blocks the next
            last: FakeResponse | None = None

            def getresponse(self):
                if self.last is not None and not self.last.isclosed():
                    raise http.client.ResponseNotReady("Idle")
                self.last = super().getresponse()
                return self.last

            @staticmethod
            def answer(path):
                if path.endswith("/1/1.png"):
                    return FakeResponse(200, b"x" * (len(normal) + 100))
                return FakeResponse(200, normal)

        monkeypatch.setattr(fetch_module, "HTTPSConnection", Pipelined)
        tiles = TerrariumTiles(tmp_path)

        answered = tiles.pixels({TileKey(10, 1, 1): [0], TileKey(10, 2, 1): [0]})

        assert Pipelined.requests == [
            "/elevation-tiles-prod/terrarium/10/1/1.png",
            "/elevation-tiles-prod/terrarium/10/2/1.png",
        ]
        assert answered == {TileKey(10, 2, 1): array("d", [10.0])}
        assert not tiles._offline.is_set()
        assert Pipelined.connections == 2

    def test_an_unwritable_cache_degrades(self, tmp_path, connections):
        blocker = tmp_path / "file"
        blocker.write_text("")

        answered = TerrariumTiles(blocker / "terrain").pixels({TileKey(10, 1, 1): [0]})

        assert answered == {}
        assert connections.requests == []

    def test_a_tile_that_cannot_be_stored_is_missing(
        self, tmp_path, monkeypatch, connections
    ):
        replace = MagicMock(side_effect=OSError("full"))
        monkeypatch.setattr(os, "replace", replace)

        assert TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]}) == {}
        assert list(tmp_path.iterdir()) == []
        # The sound tile got as far as being stored
        replace.assert_called_once()

    @pytest.mark.parametrize("version", [1, 2])
    def test_kept_pixels_of_an_older_version_are_decoded_again(self, tmp_path, version):
        """Both had the magic of before the rename, version 1 zlib as well."""
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)
        png = _tile_png(123.0)
        tiles.path(tile).write_bytes(png)
        kept = tmp_path / "10-1-1.pixels"
        planes = pixels_module._decode_planes(png)
        compressed = zlib.compress(planes, 6) if version == 1 else zstd.compress(planes)
        kept.write_bytes(
            pixels_module._PIXELS_HEADER.pack(b"KHTP", version, zlib.crc32(png))
            + compressed
        )
        assert not has_current_pixels(tiles.path(tile))

        assert tiles.pixels({tile: [0]}) == {tile: array("d", [123.0])}
        header = pixels_module._PIXELS_HEADER.unpack_from(kept.read_bytes())
        assert header == (b"FLTP", 2, zlib.crc32(png))
        assert has_current_pixels(tiles.path(tile))

    def test_the_pixels_of_a_decoded_tile_are_kept(self, tmp_path, monkeypatch):
        """The next build reads them instead of decoding the PNG again."""
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)
        tiles.path(tile).write_bytes(terrarium_png(lambda x, y: x * 3.5 - y))
        first = tiles.pixels({tile: [0, 5, 65535]})
        assert (tmp_path / "10-1-1.pixels").is_file()

        decode = MagicMock(side_effect=AssertionError("decoded again"))
        monkeypatch.setattr(pixels_module, "decode_png", decode)
        second = TerrariumTiles(tmp_path).pixels({tile: [0, 5, 65535]})

        assert second == first == {tile: array("d", [0.0, 17.5, 892.5 - 255])}

    @pytest.mark.parametrize(
        "damage",
        [
            lambda kept: kept[:-10],
            lambda kept: b"XXXX" + kept[4:],
            # The kept pixels of another PNG than the one in the cache
            lambda kept: kept[:5] + bytes(4) + kept[9:],
            lambda kept: b"",
        ],
    )
    def test_kept_pixels_that_do_not_fit_are_decoded_again(self, tmp_path, damage):
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)
        tiles.path(tile).write_bytes(_tile_png(123.0))
        tiles.pixels({tile: [0]})
        kept = tmp_path / "10-1-1.pixels"
        kept.write_bytes(damage(kept.read_bytes()))

        assert tiles.pixels({tile: [0]}) == {tile: array("d", [123.0])}
        # And kept again as they should be
        assert TerrariumTiles(tmp_path).pixels({tile: [7]}) == {
            tile: array("d", [123.0])
        }
        assert kept.read_bytes()[:4] == b"FLTP"

    def test_a_corrupt_cached_tile_is_removed(self, tmp_path):
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)
        tiles.path(tile).write_bytes(_tile_png()[:-20])

        assert tiles.pixels({tile: [0]}) == {}
        assert not tiles.path(tile).exists()

    def test_the_temp_files_of_a_killed_build_are_removed(self, tmp_path):
        tiles = TerrariumTiles(tmp_path)
        tile = TileKey(10, 1, 1)
        tiles.path(tile).write_bytes(_tile_png(3.0))
        stale = tmp_path / ".10-1-1.png.k2j3.tmp"
        stale_pixels = tmp_path / ".10-1-1.pixels.x9q1.tmp"
        fresh = tmp_path / ".10-2-1.png.a8b7.tmp"
        for path in (stale, stale_pixels, fresh):
            path.write_bytes(b"half")
        day_ago = time.time() - fetch_module.STALE_TEMP_SECONDS - 60
        for path in (stale, stale_pixels):
            os.utime(path, (day_ago, day_ago))

        assert tiles.pixels({tile: [0]}) == {tile: array("d", [3.0])}

        assert not stale.exists()
        assert not stale_pixels.exists()
        # Perhaps a write of another build still going on
        assert fresh.exists()
        assert tiles.remove_stale_temp_files() == 0
        assert TerrariumTiles(tmp_path / "none").remove_stale_temp_files() == 0

    def test_prunes_every_tile_but_those_asked_for(self, tmp_path):
        """The build in the page keeps no tile under a flight removed."""
        tiles = TerrariumTiles(tmp_path)
        kept, gone = TileKey(10, 1, 1), TileKey(10, 2, 1)
        for tile in (kept, gone):
            tiles.path(tile).write_bytes(_tile_png(1.0))
        assert tiles.pixels({kept: [0], gone: [0]})
        assert (tmp_path / "10-2-1.pixels").exists()
        temp = tmp_path / ".10-3-1.png.a8b7.tmp"
        temp.write_bytes(b"half")
        other = tmp_path / "notes.txt"
        other.write_text("not a tile")
        assert tiles.asked == {kept, gone}

        assert tiles.prune_except([kept]) == 3

        assert sorted(path.name for path in tmp_path.iterdir()) == [
            "10-1-1.pixels",
            "10-1-1.png",
            "notes.txt",
        ]
        assert TerrariumTiles(tmp_path / "none").prune_except([]) == 0

    def test_decodes_many_tiles_in_a_pool(self, tmp_path):
        tiles = TerrariumTiles(tmp_path)
        wanted = {}
        for x in range(fetch_module.DECODE_POOL_MIN_TILES):
            tile = TileKey(10, x, 1)
            tiles.path(tile).write_bytes(_tile_png(float(x)))
            wanted[tile] = [0, 1]

        answered = tiles.pixels(wanted)

        assert answered == {tile: array("d", [tile.x, tile.x]) for tile in wanted}

    @pytest.mark.parametrize(
        ("version", "pooled"), [(1, True), (2, True), (None, False)]
    )
    def test_pixels_of_an_older_version_are_decoded_in_the_pool(
        self, tmp_path, monkeypatch, version, pooled
    ):
        """After an upgrade every tile is decoded again: not one by one."""
        tiles = TerrariumTiles(tmp_path)
        wanted = {}
        for x in range(fetch_module.DECODE_POOL_MIN_TILES):
            tile = TileKey(10, x, 1)
            png = _tile_png(float(x))
            tiles.path(tile).write_bytes(png)
            wanted[tile] = [0]
            planes = pixels_module._decode_planes(png)
            if version is None:
                pixels_module._keep_pixel_planes(tiles.path(tile), png, planes)
            else:
                compressed = (
                    zlib.compress(planes, 6) if version == 1 else zstd.compress(planes)
                )
                (tmp_path / f"10-{x}-1.pixels").write_bytes(
                    pixels_module._PIXELS_HEADER.pack(b"KHTP", version, zlib.crc32(png))
                    + compressed
                )

        class InlinePool:
            started = 0

            def __init__(self, max_workers, initializer, initargs):
                InlinePool.started += 1

            def __enter__(self):
                return self

            def map(self, fn, *iterables, chunksize=1, **_kwargs):
                return map(fn, *iterables, strict=True)

            def shutdown(self, *_args, **_kwargs):
                pass

        monkeypatch.setattr(workers_module, "ProcessPoolExecutor", InlinePool)

        answered = tiles.pixels(wanted)

        assert answered == {tile: array("d", [tile.x]) for tile in wanted}
        assert InlinePool.started == (1 if pooled else 0)

    @staticmethod
    def _pooled_points(tiles):
        """A point in each of as many cached tiles as start the pool."""
        points = [
            TrackPoint(50.0, 8.0 + x * 0.5, 0.0)
            for x in range(fetch_module.DECODE_POOL_MIN_TILES)
        ]
        for point in points:
            gx, gy = global_pixel(point.lat, point.lon)
            tiles.path(
                TileKey(TERRAIN_ZOOM, int(gx) // TILE_SIZE, int(gy) // TILE_SIZE)
            ).write_bytes(_tile_png(7.0))
        return points

    def test_the_decoding_workers_log_at_the_parents_level(self, tmp_path, monkeypatch):
        """--debug names the tiles a worker could not use."""
        tiles = TerrariumTiles(tmp_path)
        points = self._pooled_points(tiles)
        pool = MagicMock(side_effect=OSError("no semaphores"))
        monkeypatch.setattr(workers_module, "ProcessPoolExecutor", pool)

        monkeypatch.setattr(logger, "getEffectiveLevel", lambda: logging.DEBUG)

        sample_path_elevations({1: points}, tiles)

        kwargs = pool.call_args.kwargs
        assert kwargs["initializer"] is init_worker
        assert kwargs["initargs"] == (logging.DEBUG,)

    @staticmethod
    def _failing_pool(at_start=None, in_map=None):
        """A process pool that cannot start, or whose workers fail."""
        if at_start is not None:
            return MagicMock(side_effect=at_start)
        pool = MagicMock()
        pool.return_value.map.side_effect = in_map
        return pool

    @pytest.mark.parametrize(
        ("at_start", "in_map"),
        [
            (None, BrokenProcessPool("a worker died")),
            # A worker out of memory raises it to the parent as it is
            (None, MemoryError()),
            (OSError("no semaphores"), None),
        ],
    )
    def test_a_decoding_pool_that_dies_decodes_the_tiles_here(
        self, tmp_path, monkeypatch, caplog, at_start, in_map
    ):
        tiles = TerrariumTiles(tmp_path)
        points = self._pooled_points(tiles)
        pool = self._failing_pool(at_start, in_map)
        monkeypatch.setattr(workers_module, "ProcessPoolExecutor", pool)

        with caplog.at_level(logging.WARNING, logger="flown"):
            by_path = sample_path_elevations({1: points}, tiles)

        assert list(by_path[1]) == [7.0] * len(points)
        pool.assert_called_once()
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert len(warnings) == 1
        message = warnings[0].getMessage()
        assert "decoding the elevation tiles" in message
        assert "going on in this process" in message

    def test_tiles_that_cannot_be_decoded_here_either_leave_the_ground_out(
        self, tmp_path, monkeypatch, caplog
    ):
        tiles = TerrariumTiles(tmp_path)
        points = self._pooled_points(tiles)
        monkeypatch.setattr(
            workers_module,
            "ProcessPoolExecutor",
            self._failing_pool(in_map=BrokenProcessPool("a worker died")),
        )
        monkeypatch.setattr(
            fetch_module, "decode_cached_tile", MagicMock(side_effect=MemoryError)
        )

        with caplog.at_level(logging.WARNING, logger="flown"):
            by_path = sample_path_elevations({1: points}, tiles)

        assert by_path == {}
        warnings = [r.getMessage() for r in caplog.records]
        assert "could not be decoded" in warnings[-1]

    def test_required_terrain_fails_without_a_tile(self, monkeypatch):
        monkeypatch.setenv(terrain_module.REQUIRE_TERRAIN_ENV, "1")
        paths = {1: [TrackPoint(50.0, 8.0, 0.0)]}
        x, y = global_pixel(50.0, 8.0)
        missing = TileKey(TERRAIN_ZOOM, int(x) // TILE_SIZE, int(y) // TILE_SIZE)

        with pytest.raises(TerrainUnavailableError, match="REQUIRE_TERRAIN"):
            sample_path_elevations(
                paths, FunctionTiles(lambda gx, gy: 5.0, missing=[missing])
            )
        # Every tile there: nothing to complain about
        assert list(sample_path_elevations(paths, FlatTiles(5.0))) == [1]

    def test_required_terrain_fails_without_a_decoder(self, tmp_path, monkeypatch):
        monkeypatch.setenv(terrain_module.REQUIRE_TERRAIN_ENV, "1")

        class Broken:
            def pixels(self, wanted):
                raise terrain_module.DecodeFailedError("a worker died")

        with pytest.raises(TerrainUnavailableError, match="could not be decoded"):
            sample_path_elevations({1: [TrackPoint(50.0, 8.0, 0.0)]}, Broken())

    def test_a_download_in_a_test_fails_loudly(self, tmp_path):
        # conftest.py refuses every download; the tile code must not swallow
        # that as an offline network
        with pytest.raises(AssertionError, match="network"):
            TerrariumTiles(tmp_path).pixels({TileKey(10, 1, 1): [0]})

    def test_the_default_cache_is_below_the_cache_directory(self):
        from flown.cache import CACHE_DIR

        assert TerrariumTiles().cache_dir == CACHE_DIR / "terrain"
