# Testing

How the code is tested: the Vitest unit and contract tests, the pytest suite,
the Playwright end-to-end tests with the sites they run against, and what CI
runs before it publishes the site. The commands are listed in
[DEVELOPMENT.md](../../DEVELOPMENT.md#commands), and the visual snapshots, which
run in the Playwright image only, in
[CONTRIBUTING.md](../../CONTRIBUTING.md#visual-snapshots).

## Layout

- Unit tests: `tests/frontend/unit/` (Vitest)
- Contract tests of the exported data files: `tests/frontend/contract/` (Vitest)
- E2E tests: `tests/e2e/` (Playwright)
- Python tests: `tests/` (pytest)

## Contract tests

`tests/frontend/contract/exportContract.test.ts` checks the data files the
generator writes against the types the frontend reads them with: its own
fixtures, and the `data/` of a site built from this checkout in `docs/`. A local
`npm test` skips that second half when `docs/` is missing or was built from
other sources (Vitest counts its tests as skipped, and gives the reason for a
stale site). `make test` builds the site first, as the CI unit job does; to run
it with `npm test`, build it yourself:

```bash
npm run build && python -m flown data --output-dir docs
```

In CI the unit job builds it first, and a missing build fails there.

## Python tests

pytest no longer forces coverage or parallel execution, so a plain `pytest` run
is fast and readable. The tests that build a whole site (the renderer and the
golden pipeline among them) need the frontend bundles, so run `npm run build`
first; `make test` does, and a run that fails without them says so above its
summary. The flags used by CI and `make test` are:

```bash
pytest                                          # Run all tests
pytest tests/test_parser.py                     # Run specific test file
pytest -x                                       # Stop on first failure
pytest -n auto --cov --cov-report=xml:coverage/coverage.xml --cov-report=term
pytest --cov --cov-report=html                  # HTML coverage report (htmlcov/)
```

A bare `--cov` measures what `[tool.coverage.run]` in `pyproject.toml` names:
the package and `scripts/`, whose pre-push hook and lock check are gates of
their own. A run with `--cov` fails below the `fail_under` floor there, which is
kept one to three points below what the suite reaches. Property-based tests use
[Hypothesis](https://hypothesis.readthedocs.io/).

The tests run in another order every time (pytest-randomly), so a test that only
passes after another one fails sooner or later rather than never. The header of
a run names its seed; `pytest --randomly-seed=<seed>` repeats that order, and
`-p no:randomly` turns the shuffling off. CI runs the Vitest suite shuffled as
well (`--sequence.shuffle`; repeat an order with `--sequence.seed=<seed>`).

A test that reads named flights of `data/` is marked `repo_data`, and
`FLOWN_OWN_FLIGHTS=1` skips it, for a copy of the repository with flights of its
own (see [Hosting](../hosting.md#your-own-site-on-github-pages)).

No test touches the network: `tests/conftest.py` fails any download of a tile
loudly, the pipeline tests pass a tile source of their own
(`build_site(..., terrain=...)`, see `TileSource`), such as the flat model of
`FlatTiles` in `tests/conftest.py`. A decoding pool that dies or cannot start
makes the build decode the remaining tiles in its own process, with one warning;
only a `MemoryError` there leaves the ground out, and that does not fail the
build either.

## End-to-end tests

End-to-end tests use [Playwright](https://playwright.dev/). They verify the full
map rendering pipeline including map initialization, layer toggles, filters,
statistics panel, flight list, wrapped modal, airport markers and replay. Tests
are located in `tests/e2e/` and configured via `playwright.config.ts`.

### Projects

The `desktop` project runs every spec but `mobile.spec.ts` and `visual.spec.ts`
in Chromium. The `mobile` project runs `mobile.spec.ts` and the viewport
independent specs (`core`, `layers`, `state`) on a phone viewport. The `webkit`
project runs the same specs as `mobile` on an emulated iPhone, and
`webkit-desktop` runs `3d-relief`, `error-free`, `orientation` and `replay`,
which drive the desktop controls, in a desktop Safari viewport. The `visual`
project compares screenshots of a fixture site and only exists inside the
Playwright image (or with `VISUAL_SNAPSHOTS=1`), so a plain run leaves it out
(see [Visual snapshots](../../CONTRIBUTING.md#visual-snapshots)). Every page is
scanned for accessibility violations with axe.

### No network

The suite does not reach the network: the page carries its own JavaScript and
CSS, CARTO's base style is answered with a stub that draws a background and asks
for no glyphs or sprite, every map tile with a transparent pixel, and any other
cross-origin request fails the test that made it (see `tests/e2e/fixtures.ts`,
which every spec imports `test` and `expect` from). What the specs know about
the map library is in `tests/e2e/map.ts`: a spec asks it for the map's locators,
zoom, layers and popups instead of naming a `.maplibregl-*` class or reaching
into `window.mapApp.map`. Its zoom levels are the ones of shared links, one
higher than MapLibre's own (see `ZOOM_OFFSET` in `utils/constants.ts`).

### In CI

A few specs depend on whether the site was built with `CARTO_API_KEY` (any value
works) and skip otherwise; CI tests a site with a dummy key and, for the tests
about the base map requests (tagged `@keys` at the end of their titles; tag a
new one that depends on the key the same way) on the desktop, one without. It
builds both once, in the `e2e-sites` job, and runs every e2e job in the
Playwright image the visual job uses (pulled by a step with a time limit and run
with `docker run`), with a browser per core of the runner. The `desktop` project
is split into three shards (`--shard`), the `mobile` and `webkit` projects into
two each; Playwright splits by the number of tests, not their time, so the
`desktop` and `mobile` shards are weighted (`PWTEST_SHARD_WEIGHTS` in the
workflow), since the slow specs sort last. The tests without a key run after the
others in the `webkit-heavy` job, the shortest. The tests tagged `@heavy`
(`HEAVY` in `tests/e2e/fixtures.ts`: the 3D view with its relief, heat cloud or
chase view, and the globe turned with the flights loaded) of the `desktop` and
`webkit-desktop` projects run in jobs of their own with two browsers
(`--grep @heavy --workers=2`), since software WebGL takes seconds per frame of
them; the other jobs of those projects leave them out (`--grep-invert @heavy`).
Tag a new spec that waits on frames of either, a describe with `HEAVY` and a
single test with `@heavy` at the end of its title. The relief tests run one
after the other in one browser and take the longest, so they are in
`3d-relief.spec.ts`, which sorts first and starts them at once, and in the
`desktop` project the last two of them (`HEAVY_SECOND`, tagged `@heavy-2`) run
in a second heavy job. The real build of Your flights with Pyodide
(`local-flights-pyodide.spec.ts`, `FLOWN_E2E_PYODIDE=1`) runs in the weekly run
only. In CI a failed test of the `desktop` project is retried once, which only
tells a flaky failure from a steady one: `failOnFlakyTests` fails the run either
way. The `mobile`, `visual`, `webkit` and `webkit-desktop` projects do not
retry, and neither do the heavy tests, where one attempt takes minutes.

### The site under test

The tests run against `docs/` (the `visual` project against `visual-site/`, with
the same checks), which must be built from the current sources first. A fixture
every spec gets (`tests/e2e/site-check.ts`) compares the build hash in
`docs/mapApp.bundle.js` with the checkout (the frontend sources, the
stylesheets, the build configuration and the pinned versions of esbuild, Lucide
and the vendored maplibre-gl, html-to-image and flag-icons, see
[`scripts/README.md`](../../scripts/README.md#source-hashjs)) and fails the
tests with a hint when they differ. It also fails them when the hash of the
generator in `docs/map_config.js` (`generator`: the Python package, its
templates and the static files besides the bundles) differs from the checkout's,
when the hash of the fixture in `visual-site/fixture.sha1` does, and when
`E2E_API_KEYS` (`dummy` or `none`, set by CI) does not match whether
`docs/map_config.js` carries a key. Hashes, not modification times: the build
dates its files to the day, or to 2025 for the fixture site, so their times
cannot tell an old site from a new one.

### Running them locally

```bash
# Install Playwright browsers (first time only)
npx playwright install --with-deps chromium webkit

# Build the site from the current sources
npm run build && python -m flown data --output-dir docs

# Run E2E tests
npm run test:e2e
npm run test:e2e:mobile

# On NixOS, use the system Chromium; Playwright's WebKit build does not run
# there, but the Playwright container image carries it (the image the e2e
# and visual jobs of .github/workflows/test.yml run; scripts/check_locks.py
# keeps the reference here in step with it)
nix-shell -p chromium python3 --run 'CHROMIUM_PATH=$(which chromium) npm run test:e2e -- --project=desktop --project=mobile'
podman run --rm --ipc=host --network host --userns=keep-id --user "$(id -u):$(id -g)" \
  --security-opt label=disable -v "$PWD:/work" -w /work -e HOME=/tmp \
  mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f \
  npx playwright test --project=webkit --project=webkit-desktop
```

### Test server and reports

The test server starts `python3 -m http.server` serving `docs/` on port 8000, or
on `E2E_PORT` when that is set, and the fixture site of the visual project on
the port after it: two checkouts tested at the same time (git worktrees, for
one) need a port each, or the second would reuse the first one's server and test
the wrong site. The visual project runs in a container; with `--network host`,
as in [CONTRIBUTING.md](../../CONTRIBUTING.md#visual-snapshots), it shares the
host's ports and needs the variable passed in (`-e E2E_PORT`). Failed tests keep
their traces in `test-results/`, and every run writes an HTML report to
`playwright-report/` (`npx playwright show-report`).

In CI every e2e job also uploads the duration of each test, as the
`e2e-timings-<job>` artifact of every run and not only of a failed one: a test
that creeps up on its timeout shows there before it times out.
`node scripts/e2e_durations.js <file>` lists the 20 slowest attempts with the
share of their timeout they took (see
[`scripts/README.md`](../../scripts/README.md#e2e_durationsjs)).

## CI and deployment

The published site is built on every push to `main` by the `site` and `deploy`
jobs of the `test` workflow, which wait for every test job but `security` to
pass (a new advisory for a test dependency must not hold back new flights, and
the weekly run reports it anyway) and skip a commit that is no longer the head
of `main`: they run the same steps as `make build` (frontend bundle, then
`python -m flown data`) and upload the result to GitHub Pages (see
[Repository rules](../../CONTRIBUTING.md#repository-rules) for what is not
committed). The `checks` job is the one status a merge needs (the ruleset on
`main` requires it, see
[Repository rules](../../CONTRIBUTING.md#repository-rules)), because it needs
every job a pull request runs and fails when any of them failed, was cancelled
or was skipped where its own condition does not skip it.

## Test data generation

`scripts/generate_test_data.py` generates realistic test KML files for
performance testing: curved flight paths using Bezier curves, realistic altitude
profiles and random deviations across Germany, up to 100k+ flights. Build a site
from them as from `data/`:

```bash
python3 scripts/generate_test_data.py 10000
make build INPUT_DIR=kml_test_10000
```

See [`scripts/README.md`](../../scripts/README.md#generate_test_datapy) for its
options and the measured processing times.
