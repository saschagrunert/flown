"""Tests for the build in the browser (flown.browser)."""

import ast
import json
import os
import subprocess
import sys
import types
from pathlib import Path
from typing import ClassVar
from urllib.error import HTTPError

import pytest

import flown.airport_lookup as lookup_module
from flown import browser
from flown.exceptions import InvalidInputError
from flown.logger import logger
from tests.tiles import terrarium_png

KML = """<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document><Placemark><name>EDAQ - EDDC</name><gx:Track>
    <when>2025-03-15T10:00:00Z</when><gx:coord>12.05 51.55 110</gx:coord>
    <when>2025-03-15T10:10:00Z</when><gx:coord>12.5 51.4 800</gx:coord>
    <when>2025-03-15T10:20:00Z</when><gx:coord>13.76 51.13 230</gx:coord>
  </gx:Track></Placemark></Document></kml>
"""


class _Buffer:
    """A JsProxy of an ArrayBuffer, as far as ``to_py`` goes."""

    def __init__(self, body: bytes) -> None:
        self._body = body

    def to_py(self):
        return memoryview(self._body)


class FakeXhr:
    """The worker's synchronous XMLHttpRequest, scripted per URL.

    ``answers`` maps a URL to ``(status, body)``, to an exception ``send``
    raises (the browser's network error), or to nothing: a request that
    never gets an answer, which the browser reports as status 0.
    """

    answers: ClassVar[dict[str, tuple[int, bytes] | Exception | None]] = {}
    sent: ClassVar[list[str]] = []
    timeouts: ClassVar[list[int]] = []

    @classmethod
    def new(cls):
        return cls()

    def __init__(self) -> None:
        self.status = 0
        self.response: _Buffer | None = None
        self.responseURL = ""
        self.responseType = ""
        self.timeout = 0
        self.url = ""

    def open(self, method, url, asynchronous):
        assert method == "GET"
        assert asynchronous is False
        self.url = url

    def send(self):
        type(self).sent.append(self.url)
        type(self).timeouts.append(self.timeout)
        answer = self.answers.get(self.url)
        if isinstance(answer, Exception):
            raise answer
        if answer is None:
            return
        self.status, body = answer
        self.response = _Buffer(body)
        self.responseURL = self.url


@pytest.fixture
def js(monkeypatch):
    """A ``js`` module as Pyodide has, with the fake request."""
    FakeXhr.answers = {}
    FakeXhr.sent = []
    FakeXhr.timeouts = []
    module = types.ModuleType("js")
    module.XMLHttpRequest = FakeXhr  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "js", module)
    return FakeXhr


class TestXhrGet:
    def test_answers_with_the_status_the_body_and_the_final_url(self, js):
        js.answers["https://host/a.csv"] = (200, b"id,ident\n")

        assert browser.xhr_get("https://host/a.csv") == (
            200,
            b"id,ident\n",
            "https://host/a.csv",
        )
        assert js.sent == ["https://host/a.csv"]

    def test_a_request_the_browser_refuses_is_an_os_error(self, js):
        js.answers["https://host/x"] = RuntimeError("NetworkError")

        with pytest.raises(OSError, match="NetworkError"):
            browser.xhr_get("https://host/x")

    def test_no_answer_at_all_is_an_os_error(self, js):
        with pytest.raises(OSError, match="no response"):
            browser.xhr_get("https://host/never")

    def test_gives_the_request_a_timeout(self, js):
        """A host that stalls must not hold the build for good."""
        js.answers["https://host/a"] = (200, b"")
        js.answers["https://host/b"] = (200, b"")

        browser.xhr_get("https://host/a")
        browser.xhr_get("https://host/b", 2.5)

        assert js.timeouts == [int(browser.DATABASE_TIMEOUT_SECONDS * 1000), 2500]

    def test_an_error_status_is_answered_as_such(self, js):
        js.answers["https://host/gone"] = (404, b"")

        assert browser.xhr_get("https://host/gone") == (404, b"", "https://host/gone")


class TestUrlopen:
    def test_reads_like_a_response_of_urlopen(self, js):
        js.answers["https://host/a.csv"] = (200, b"id,ident\n1,EDDF\n")

        with browser._xhr_urlopen("https://host/a.csv", timeout=5, context=None) as r:
            assert js.timeouts == [5000]
            assert r.url == "https://host/a.csv"
            assert r.headers.get("Content-Length") == "16"
            assert r.read(3) == b"id,"
            assert r.read() == b"ident\n1,EDDF\n"
            assert r.read() == b""

    def test_an_error_status_raises_as_urlopen_does(self, js):
        js.answers["https://host/a.csv"] = (503, b"")

        with pytest.raises(HTTPError) as failure:
            browser._xhr_urlopen("https://host/a.csv")
        assert failure.value.code == 503
        failure.value.close()

    def test_install_routes_the_airport_download(self, js):
        browser.install_network()

        assert lookup_module.urlopen is browser._xhr_urlopen  # type: ignore[attr-defined,comparison-overlap]


class TestInputFiles:
    def test_flights_in_name_order_and_the_aircraft_next_to_them(self, tmp_path):
        for name in ("b.kml", "a.KMZ", "notes.txt", "aircraft.json", "c.kml"):
            (tmp_path / name).write_text("x")
        (tmp_path / "sub").mkdir()

        kml_files, aircraft = browser.input_files(tmp_path)

        assert [Path(f).name for f in kml_files] == ["a.KMZ", "b.kml", "c.kml"]
        assert aircraft == [tmp_path / "aircraft.json"]

    def test_in_the_order_of_the_numbers_the_names_start_with(self, tmp_path):
        # As the site build takes them: 10 after 2, which the list, Replay
        # and the share intro play in
        for name in ["10_DEAGJ_DA20.kml", "2_DEAGJ_DA20.kml", "1_DEHYL_DA40.kml"]:
            (tmp_path / name).write_text("x")

        kml_files, _ = browser.input_files(tmp_path)

        assert [Path(f).name for f in kml_files] == [
            "1_DEHYL_DA40.kml",
            "2_DEAGJ_DA20.kml",
            "10_DEAGJ_DA20.kml",
        ]

    def test_without_an_aircraft_file(self, tmp_path):
        (tmp_path / "a.kml").write_text("x")

        assert browser.input_files(tmp_path) == ([str(tmp_path / "a.kml")], [])

    def test_leaves_the_apple_double_files_out(self, tmp_path):
        """As the site build does (validation.list_kml_files)."""
        for name in ("1_DEAGJ_DA20.kml", "._1_DEAGJ_DA20.kml"):
            (tmp_path / name).write_text("x")

        kml_files, _ = browser.input_files(tmp_path)

        assert [Path(f).name for f in kml_files] == ["1_DEAGJ_DA20.kml"]

    def test_every_aircraft_file_the_page_numbered_in_order(self, tmp_path):
        """The first wins in merge_aircraft_data, as the page kept them."""
        for name in (
            "aircraft-10.json",
            "aircraft-2.json",
            "aircraft.json",
            "aircraft-0.json",
            "my-aircraft.json",
        ):
            (tmp_path / name).write_text("{}")

        _, aircraft = browser.input_files(tmp_path)

        assert [path.name for path in aircraft] == [
            "aircraft.json",
            "aircraft-2.json",
            "aircraft-10.json",
        ]


class TestBuild:
    def test_writes_the_data_files_and_answers_with_the_extent(self, tmp_path, js):
        inputs = tmp_path / "input"
        inputs.mkdir()
        (inputs / "1_DEAGJ_DA20.kml").write_text(KML, encoding="utf-8")
        out = tmp_path / "site"
        lines = []

        outcome = browser.build(
            str(inputs),
            str(out),
            report=lambda level, message: lines.append((level, message)),
            terrain=False,
        )

        assert outcome["years"] == [2025]
        assert outcome["flights"] == 1
        assert outcome["airports"] == 2
        assert "center" not in outcome
        assert outcome["bounds"] == [[51.13, 12.05], [51.55, 13.76]]
        metadata = json.loads((out / "metadata.json").read_text())
        assert metadata["available_years"] == [2025]
        assert (out / "airports.json").is_file()
        assert (out / "2025" / "data.json").is_file()
        # The page is not written: the browser has it
        assert not (out / "index.html").exists()
        # The steps, not the lines of the command line
        assert lines[0] == ("info", "Reading your files…")
        assert {message for _, message in lines} <= set(browser.PHASES.values())
        assert outcome["skipped"] == []
        assert outcome["warnings"] == []
        assert outcome["degraded"] == []
        # Nothing of the build is left on the logger
        assert not any(isinstance(h, browser._Relay) for h in logger.handlers)

    def test_tiles_are_fetched_through_the_request_and_a_miss_is_taken(
        self, tmp_path, js, monkeypatch
    ):
        """The build goes on without the ground, as it does offline."""
        monkeypatch.setattr(
            "flown.terrain_fetch.TERRAIN_CACHE_DIR", tmp_path / "cache" / "terrain"
        )
        monkeypatch.setattr("flown.terrain_fetch.time.sleep", lambda _: None)
        inputs = tmp_path / "input"
        inputs.mkdir()
        (inputs / "1_DEAGJ_DA20.kml").write_text(KML, encoding="utf-8")

        outcome = browser.build(str(inputs), str(tmp_path / "site"), terrain=True)

        assert outcome["years"] == [2025]
        assert js.sent, "no tile was asked for"
        assert all(url.startswith("https://s3.amazonaws.com/") for url in js.sent)
        assert set(js.timeouts) == {int(browser.TILE_TIMEOUT_SECONDS * 1000)}
        data = json.loads((tmp_path / "site" / "2025" / "data.json").read_text())
        assert data["segments"]["ground"] == [None]
        # Which the page offers to build again once the connection is back
        assert outcome["degraded"] == ["terrain"]
        assert any("elevation tile" in w for w in outcome["warnings"])

    def test_an_empty_directory_is_refused(self, tmp_path, js):
        (tmp_path / "input").mkdir()

        with pytest.raises(InvalidInputError, match="No valid KML files"):
            browser.build(str(tmp_path / "input"), str(tmp_path / "site"))

    def test_needs_no_minifier(self, tmp_path):
        """Pyodide has lxml, and neither minify-html nor rcssmin: a build
        that imported one of them would fail there before it starts."""
        inputs = tmp_path / "input"
        inputs.mkdir()
        (inputs / "1_DEAGJ_DA20.kml").write_text(KML, encoding="utf-8")
        # No js module outside Pyodide either: a request that always fails
        # stands in, and the build goes on without the airport database
        script = (
            "import sys, types\n"
            "sys.modules['minify_html'] = None\n"
            "sys.modules['rcssmin'] = None\n"
            "class Request:\n"
            "    new = classmethod(lambda cls: cls())\n"
            "    def open(self, *args): pass\n"
            "    def send(self): raise RuntimeError('offline')\n"
            "sys.modules['js'] = types.SimpleNamespace(XMLHttpRequest=Request)\n"
            "from flown import browser\n"
            f"print(browser.build({str(inputs)!r}, {str(tmp_path / 'site')!r}, "
            "terrain=False)['years'])\n"
        )
        result = subprocess.run(  # noqa: S603
            [sys.executable, "-c", script],
            capture_output=True,
            text=True,
            check=False,
            env={**os.environ, "FLOWN_CACHE_DIR": str(tmp_path / "cache")},
        )
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip().endswith("[2025]")

    def test_a_file_that_makes_no_flight_is_left_out_and_named(self, tmp_path, js):
        """The rest are shown, and the panel says which file and why."""
        inputs = tmp_path / "input"
        inputs.mkdir()
        (inputs / "1_DEAGJ_DA20.kml").write_text(KML, encoding="utf-8")
        (inputs / "notes.kml").write_text("not xml", encoding="utf-8")
        (inputs / "plan.kml").write_text(
            KML.replace(" 110<", "<").replace(" 800<", "<").replace(" 230<", "<"),
            encoding="utf-8",
        )

        outcome = browser.build(str(inputs), str(tmp_path / "site"), terrain=False)

        assert outcome["flights"] == 1
        assert [entry["file"] for entry in outcome["skipped"]] == [
            "notes.kml",
            "plan.kml",
        ]
        assert all(entry["reason"] for entry in outcome["skipped"])
        assert "route plan" in outcome["skipped"][1]["reason"]
        # Named by the file alone, not the directory the worker wrote it to
        assert not any(str(inputs) in entry["reason"] for entry in outcome["skipped"])

    def test_no_file_with_a_flight_fails_with_the_reasons(self, tmp_path, js):
        inputs = tmp_path / "input"
        inputs.mkdir()
        (inputs / "notes.kml").write_text("not xml", encoding="utf-8")

        with pytest.raises(InvalidInputError) as failed:
            browser.build(str(inputs), str(tmp_path / "site"), terrain=False)
        assert str(failed.value).startswith(
            "No file holds a flight to export (notes.kml: "
        )
        assert "see above" not in str(failed.value)

    def test_no_file_with_a_flight_names_the_invalid_ones_too(self, tmp_path, js):
        """One message for every file: those the validation refused as well."""
        inputs = tmp_path / "input"
        inputs.mkdir()
        (inputs / "empty.kml").write_bytes(b"")
        (inputs / "notes.kml").write_text("not xml", encoding="utf-8")

        with pytest.raises(InvalidInputError) as failed:
            browser.build(str(inputs), str(tmp_path / "site"), terrain=False)
        assert "empty.kml: " in str(failed.value)
        assert "notes.kml: " in str(failed.value)

    def test_the_warnings_are_handed_back(self, tmp_path, js):
        """For the panel to show once the build is done."""
        inputs = tmp_path / "input"
        inputs.mkdir()
        (inputs / "export.kml").write_text(KML, encoding="utf-8")

        outcome = browser.build(str(inputs), str(tmp_path / "site"), terrain=False)

        assert any(
            "name no aircraft (export.kml)" in warning
            for warning in outcome["warnings"]
        ), outcome["warnings"]
        assert not any(str(inputs) in warning for warning in outcome["warnings"])

    def test_the_flags_are_those_of_the_page(self, tmp_path, js):
        """The package in the page has no flags of its own to look at."""
        inputs = tmp_path / "input"
        inputs.mkdir()
        (inputs / "1_DEAGJ_DA20.kml").write_text(KML, encoding="utf-8")

        browser.build(str(inputs), str(tmp_path / "one"), terrain=False, flags=["de"])
        browser.build(str(inputs), str(tmp_path / "two"), terrain=False, flags=["fr"])

        def flags(site):
            return json.loads((tmp_path / site / "metadata.json").read_text()).get(
                "available_flags"
            )

        assert flags("one") == ["de"]
        assert not flags("two")

    def test_the_parses_of_removed_files_leave_the_cache(
        self, tmp_path, js, monkeypatch
    ):
        """Their tracks, with the real dates, are not kept for a month."""
        cache = tmp_path / "cache" / "kml"
        cache.mkdir(parents=True, mode=0o700)
        monkeypatch.setattr("flown.parser_cache.KML_CACHE_DIR", cache)
        inputs = tmp_path / "input"
        inputs.mkdir()
        kml = inputs / "1_DEAGJ_DA20.kml"
        kml.write_text(KML, encoding="utf-8")
        removed = inputs / "2_DEAGJ_DA20.kml"
        removed.write_text(KML.replace("2025-", "2024-"), encoding="utf-8")
        browser.build(str(inputs), str(tmp_path / "one"), terrain=False)
        assert len(list(cache.iterdir())) == 2

        removed.unlink()
        browser.build(str(inputs), str(tmp_path / "two"), terrain=False)

        assert len(list(cache.iterdir())) == 1

    def test_the_parses_of_removed_files_leave_the_cache_of_a_failed_build(
        self, tmp_path, js, monkeypatch
    ):
        """No file left makes a flight: the removed one's parse goes still."""
        cache = tmp_path / "cache" / "kml"
        cache.mkdir(parents=True, mode=0o700)
        monkeypatch.setattr("flown.parser_cache.KML_CACHE_DIR", cache)
        inputs = tmp_path / "input"
        inputs.mkdir()
        kml = inputs / "1_DEAGJ_DA20.kml"
        kml.write_text(KML, encoding="utf-8")
        browser.build(str(inputs), str(tmp_path / "one"), terrain=False)
        assert len(list(cache.iterdir())) == 1

        kml.unlink()
        (inputs / "2_DEAGJ_DA20.kml").write_text("not a KML", encoding="utf-8")
        with pytest.raises(InvalidInputError):
            browser.build(str(inputs), str(tmp_path / "two"), terrain=False)

        assert list(cache.iterdir()) == []

    def test_the_tiles_no_flight_asks_for_leave_the_cache(
        self, tmp_path, js, monkeypatch
    ):
        """They show roughly where a removed flight went."""
        terrain = tmp_path / "cache" / "terrain"
        terrain.mkdir(parents=True)
        monkeypatch.setattr("flown.terrain_fetch.TERRAIN_CACHE_DIR", terrain)
        monkeypatch.setattr("flown.terrain_fetch.time.sleep", lambda _: None)
        far = terrain / "10-1-1.png"
        far.write_bytes(terrarium_png(lambda x, y: 250.0))
        # The one under the departure, EDAQ
        under = terrain / "10-546-340.png"
        under.write_bytes(terrarium_png(lambda x, y: 250.0))
        inputs = tmp_path / "input"
        inputs.mkdir()
        (inputs / "1_DEAGJ_DA20.kml").write_text(KML, encoding="utf-8")

        browser.build(str(inputs), str(tmp_path / "one"), terrain=True)
        assert not far.exists()
        assert under.exists()
        assert (terrain / "10-546-340.pixels").exists()

        # A build that fails before the ground keeps them for the next
        (inputs / "1_DEAGJ_DA20.kml").write_text("not a KML", encoding="utf-8")
        with pytest.raises(InvalidInputError):
            browser.build(str(inputs), str(tmp_path / "bad"), terrain=True)
        assert under.exists()

        # Without the ground no flight asks for any
        (inputs / "1_DEAGJ_DA20.kml").write_text(KML, encoding="utf-8")
        browser.build(str(inputs), str(tmp_path / "two"), terrain=False)
        assert list(terrain.iterdir()) == []

    def test_every_phase_is_a_line_the_build_logs(self):
        """A line reworded would drop its step from the panel without a word."""
        logged = set()
        for source in Path(browser.__file__).parent.glob("*.py"):
            for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "info"
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "logger"
                    and node.args
                    and isinstance(node.args[0], ast.Constant)
                ):
                    logged.add(node.args[0].value)

        assert set(browser.PHASES) <= logged
        # In the order a build takes them
        assert list(browser.PHASES.values()) == [
            "Reading your files…",
            "Fetching the airport names…",
            "Finding the airports…",
            "Writing your flights…",
        ]

    def test_every_degraded_and_unsaid_warning_is_a_line_the_build_logs(self):
        """A line reworded would say the command line's way out again."""
        logged = set()
        for source in Path(browser.__file__).parent.glob("*.py"):
            for node in ast.walk(ast.parse(source.read_text(encoding="utf-8"))):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "warning"
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "logger"
                    and node.args
                    and isinstance(node.args[0], ast.Constant)
                ):
                    logged.add(node.args[0].value)

        assert set(browser.DEGRADED) <= logged
        assert logged >= browser.UNSAID

    def test_what_a_build_went_without_is_said_in_the_page_s_words(self):
        """Offline: the airports and the ground, without the env variable."""
        with browser._relayed(None, "/input") as relay:
            airports, runways, terrain = browser.DEGRADED
            (unsaid,) = browser.UNSAID
            logger.warning(airports, "FLOWN_REQUIRE_AIRPORT_DB")
            logger.warning(runways)
            logger.warning(unsaid)
            logger.warning(terrain, 5, 5, 2)

        assert relay.degraded == {"airports", "terrain"}
        assert relay.warnings == [
            browser.DEGRADED[airports][1],
            browser.DEGRADED[runways][1],
            terrain % (5, 5, 2),
        ]
        assert not any("FLOWN_" in warning for warning in relay.warnings)

    def test_a_build_tries_again_what_the_last_could_not_fetch(
        self, tmp_path, js, monkeypatch
    ):
        """The worker keeps its process, and the cache its failure marker."""
        tried = []

        def retry(download):
            tried.append(download)

        monkeypatch.setattr("flown.airport_lookup.retry_missing_databases", retry)
        inputs = tmp_path / "input"
        inputs.mkdir()
        (inputs / "1_DEAGJ_DA20.kml").write_text(KML, encoding="utf-8")

        browser.build(str(inputs), str(tmp_path / "site"), terrain=False)
        browser.build(str(inputs), str(tmp_path / "again"), terrain=False, retry=True)

        # Downloaded again only where asked: a slow line waits for the timeout
        assert tried == [False, True]

    def test_running_out_of_memory_is_said_as_such(self, tmp_path, js, monkeypatch):
        """A failed year says so only as its cause: the page lets the runtime go."""

        def export(*_args, **_kwargs):
            raise RuntimeError("Failed to process year 2025") from MemoryError()

        monkeypatch.setattr("flown.pipeline.export_flight_data", export)
        inputs = tmp_path / "input"
        inputs.mkdir()
        (inputs / "1_DEAGJ_DA20.kml").write_text(KML, encoding="utf-8")

        with pytest.raises(MemoryError):
            browser.build(str(inputs), str(tmp_path / "site"), terrain=False)


class TestRetryMissingDatabases:
    def test_a_database_loaded_empty_is_downloaded_again(self):
        databases = lookup_module.databases
        databases.use({})
        databases.use_runways({})
        for database in (lookup_module._airports_csv(), lookup_module._runways_csv()):
            database.failed_marker.parent.mkdir(parents=True, exist_ok=True)
            database.failed_marker.touch()

        lookup_module.retry_missing_databases()

        assert databases.airports is None
        assert databases.runways is None
        assert not lookup_module._recent_download_failure()
        assert not lookup_module._recent_download_failure(lookup_module._runways_csv())

    def test_without_download_the_failed_download_holds_the_next_back(self):
        """Loaded again, to be said again to be missing, not downloaded."""
        databases = lookup_module.databases
        databases.use({})
        databases.use_runways({})
        marker = lookup_module._airports_csv().failed_marker
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()

        lookup_module.retry_missing_databases(download=False)

        assert databases.airports is None
        assert databases.runways is None
        assert lookup_module._recent_download_failure()

    def test_databases_that_loaded_are_kept(self):
        databases = lookup_module.databases
        airports = lookup_module.load_airport_database()
        runways = lookup_module.load_runway_database()
        assert airports
        assert runways

        lookup_module.retry_missing_databases()

        assert databases.airports is airports
        assert databases.runways is runways
