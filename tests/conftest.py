"""Pytest configuration and shared fixtures for flown tests.

The cache directory is redirected to a session-private directory through the
production ``FLOWN_CACHE_DIR`` setting, a small fixture airports.csv
and the runways.csv of its airports are installed there so no test needs the
network, and any attempt to download either database or an elevation tile
fails loudly. ``FLOWN_SITE_URL`` is cleared for every test.
"""

import json
import os
import shutil
import tempfile
import time
from pathlib import Path

import pytest
from hypothesis import settings

# The functions under property tests take microseconds, but a GC pause or a
# busy CI runner (the suite runs under xdist) can still trip the default
# 200 ms deadline and report a flaky test; without it Hypothesis only
# reports failing examples. Its own "ci" profile, which it loads on CI,
# replays the same examples on every run (derandomize): CI would never find
# a new one. So CI draws new examples on every run as well, with nothing to
# remember them in but the blob it prints to reproduce a failure, and the
# examples found that way are pinned with @example in the tests.
settings.register_profile("no-deadline", deadline=None)
settings.register_profile(
    "random-ci",
    parent=settings.get_profile("no-deadline"),
    derandomize=False,
    database=None,
    print_blob=True,
)
settings.load_profile(
    "random-ci"
    if os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS")
    else "no-deadline"
)

_TEST_CACHE_DIR: Path | None = None

FIXTURE_AIRPORTS_CSV = Path(__file__).parent / "fixtures" / "airports.csv"
FIXTURE_RUNWAYS_CSV = Path(__file__).parent / "fixtures" / "runways.csv"


def parse_kml_file(kml_file, cache_path=None):
    """Parse a KML file, without the cache, into ``(coordinates, paths, metadata)``.

    The result is stored in the cache entry ``cache_path`` with the landings
    of its paths, as a build stores it (see ``renderer._parse_with_error_handling``).
    """
    from flown.landings import path_landings
    from flown.parser import parse_and_cache

    return parse_and_cache(kml_file, cache_path, path_landings)[0]


def parse_kml_coordinates(kml_file):
    """Parse a KML file as the pipeline does, from the parse cache if it has it."""
    from flown.parser import load_cached_entry

    cached, cache_path = load_cached_entry(kml_file)
    if cached is not None:
        return cached.coordinates, cached.path_groups, cached.path_metadata
    return parse_kml_file(kml_file, cache_path)


class FlatTiles:
    """Ground at one elevation everywhere, without any tile (a TileSource).

    With a flat model the ground of a flight is the line between its fields,
    as the page draws it without a ground column.
    """

    def __init__(self, elevation_m=0.0):
        self.elevation_m = elevation_m

    def pixels(self, wanted):
        from array import array

        return {
            tile: array("d", [self.elevation_m]) * len(indices)
            for tile, indices in wanted.items()
        }


# Set by a copy of the repository whose data/ holds flights of its own (see
# doc/hosting.md): the tests written against the flights of this one are
# skipped there rather than failing its every build
OWN_FLIGHTS_ENV = "FLOWN_OWN_FLIGHTS"


def pytest_collection_modifyitems(config, items):
    """Skip the tests marked ``repo_data`` with ``FLOWN_OWN_FLIGHTS=1``."""
    if os.environ.get(OWN_FLIGHTS_ENV) != "1":
        return
    skip = pytest.mark.skip(reason=f"{OWN_FLIGHTS_ENV}=1: data/ holds other flights")
    for item in items:
        if item.get_closest_marker("repo_data"):
            item.add_marker(skip)


def pytest_configure(config):
    """Point the cache at a private directory before flown is imported."""
    # Set once per session, before any test runs, and read at its end
    global _TEST_CACHE_DIR  # noqa: PLW0603
    _TEST_CACHE_DIR = Path(tempfile.mkdtemp(prefix="flown_test_"))
    os.environ["FLOWN_CACHE_DIR"] = str(_TEST_CACHE_DIR)


def missing_frontend_build():
    """The files of `npm run build` that flown/static/ lacks.

    Read at call time, from the module, like ``missing_build_files`` does.
    """
    from flown import site_assets

    vendor = site_assets.STATIC_DIR / "vendor"
    return [
        *(bundle.name for bundle in site_assets.BUNDLE_FILES if not bundle.is_file()),
        *(
            f"vendor/{name}"
            for name in site_assets.VENDOR_FILES
            if not (vendor / name).is_file()
        ),
    ]


def pytest_terminal_summary(terminalreporter, exitstatus, config):
    """Say why a run failed when the frontend was never built.

    Every test that builds a site fails without the bundles, each with an
    error of its own (the export returns False, a fixture finds no
    index.html); one line here names the cause and the fix.
    """
    if exitstatus == pytest.ExitCode.OK:
        return
    missing = missing_frontend_build()
    if missing:
        terminalreporter.write_sep("=", "the frontend is not built", red=True)
        terminalreporter.write_line(
            f"flown/static/ lacks {', '.join(missing)}. The tests that "
            "build a site need them: run `npm run build` first (`make test` "
            "does)."
        )


def pytest_unconfigure(config):
    """Clean up the private cache directory after all tests complete."""
    if _TEST_CACHE_DIR and _TEST_CACHE_DIR.exists():
        shutil.rmtree(_TEST_CACHE_DIR, ignore_errors=True)
    os.environ.pop("FLOWN_CACHE_DIR", None)


@pytest.fixture(scope="session", autouse=True)
def airport_fixture_csv():
    """Install the fixture airports.csv and runways.csv as the (fresh) cache."""
    from flown.airport_lookup import CACHE_FILE, RUNWAYS_CACHE_FILE

    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    now = time.time()
    for fixture, cached in (
        (FIXTURE_AIRPORTS_CSV, CACHE_FILE),
        (FIXTURE_RUNWAYS_CSV, RUNWAYS_CACHE_FILE),
    ):
        shutil.copyfile(fixture, cached)
        os.utime(cached, (now, now))
    return CACHE_FILE


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    """Fail loudly if anything tries to download the airport database or tiles.

    An AssertionError is none of the errors the elevation tile download
    degrades on, so it fails the test from the download thread.
    """

    def _refuse(*args, **kwargs):
        raise AssertionError("Unexpected network access in tests")

    monkeypatch.setattr("flown.airport_lookup.urlopen", _refuse)
    # The tiles are fetched over a connection of http.client, not urlopen
    monkeypatch.setattr("flown.terrain_fetch.HTTPSConnection", _refuse)


@pytest.fixture(autouse=True)
def no_site_url(monkeypatch):
    """No site URL from the shell: with one, every build would draw images.

    The tests of the link previews set their own.
    """
    monkeypatch.delenv("FLOWN_SITE_URL", raising=False)


@pytest.fixture(autouse=True)
def private_parse_cache(monkeypatch, tmp_path_factory):
    """Give every test its own parse cache directory (in this process).

    Entries are keyed by file name and content, so two tests writing the same
    KML file would otherwise share an entry and skip the parse (and its log
    output) depending on the order they run in.
    """
    monkeypatch.setattr(
        "flown.parser_cache.KML_CACHE_DIR", tmp_path_factory.mktemp("kml")
    )


@pytest.fixture(autouse=True)
def reset_airport_cache():
    """Reset the airport cache and the download failure marker around each test.

    The marker lives in the (session private) cache directory; a test that
    exercises a failed download must not stop the next test from trying.
    """
    import flown.airport_lookup as airport_lookup_module

    def reset():
        airport_lookup_module.databases.reset()
        airport_lookup_module._clear_download_failure()
        airport_lookup_module._clear_download_failure(
            airport_lookup_module._runways_csv()
        )

    reset()
    yield
    reset()


#: How many times larger the large input of :func:`growth` is than the small one
GROWTH_FACTOR = 8

#: The most :func:`growth` may come to for work that is linear in its input.
#: Linear work comes to about GROWTH_FACTOR (constant costs bring it below),
#: quadratic work to its square, 64: a regex that backtracked from every
#: position of a long run measured 60 here.
LINEAR_GROWTH = 2.5 * GROWTH_FACTOR


def growth(run, make, small, repeats=3):
    """How much longer ``run(make(n))`` takes for a GROWTH_FACTOR times larger ``n``.

    A guard against catastrophic backtracking that holds on any machine: a
    fixed number of seconds failed on a CI runner busy with other work,
    which slows the small input and the large one alike and leaves their
    ratio as it is. Each input is timed ``repeats`` times and the fastest
    run counts, so a pause of the runner during one of them does not.
    """

    def fastest(text):
        times = []
        for _ in range(repeats):
            started = time.perf_counter()
            run(text)
            times.append(time.perf_counter() - started)
        return min(times)

    return fastest(make(small * GROWTH_FACTOR)) / fastest(make(small))


def parse_data(path):
    """The payload of a data file of the site."""
    return json.loads(Path(path).read_text(encoding="utf-8"))


@pytest.fixture(name="parse_data")
def parse_data_fixture():
    """The ``parse_data`` helper as a fixture."""
    return parse_data


def decoded_segments(entry):
    """A segments entry of a year file as the frontend reads it.

    The rows on disk are scaled integers stored as differences, column
    by column (see
    ``flown.segment_codec``). Tests that care about the values rather
    than the encoding go through here.
    """
    from flown.segment_codec import COORDINATE_SCALE, decode_rows

    start = [value / COORDINATE_SCALE for value in entry["start"]]
    return start, decode_rows(entry["start"], entry["columns"])


@pytest.fixture
def decode_entry():
    """Fixture form of :func:`decoded_segments`."""
    return decoded_segments
