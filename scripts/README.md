# Scripts

The build helpers `build.js` imports, the repository consistency check, the
pre-push hook, the test data generator, the builder of the site the visual
snapshots use, the check of the files a generated site needs and the list of the
slowest e2e tests of a CI run. The JavaScript files are type-checked with
`tsconfig.node.json` (`npm run typecheck`).

## generate_test_data.py

Generates realistic test KML files with curved flight paths between major
European airports.

### Features

- Curved flight paths using quadratic Bezier curves (not straight lines)
- Random deviations to spread data across Germany for better heatmap
  visualization
- Realistic altitude profiles (climb, cruise, descend)
- SkyDemon-style filenames (`N_REGISTRATION_TYPE.kml`)
- The same files for the same `--seed` (42 unless given)
- Two formats (`--format`), both at a groundspeed of 90 to 150 kt:
  - `gx-track` (the default): a `gx:Track` with a `<when>` for every point, as
    SkyDemon writes it, at the pace of the flight (its 50 points are one to
    three minutes apart)
  - `linestring`: a `LineString` with the start and end of the flight in a
    `<TimeSpan>` and no per-point times, so the speed layer falls back to path
    averages: the length of the path over its duration

### Usage

```bash
# Generate 1000 files (default)
python3 scripts/generate_test_data.py

# Generate 10000 files
python3 scripts/generate_test_data.py 10000

# Generate 5000 files to custom directory
python3 scripts/generate_test_data.py 5000 --output custom_test_data

# Other flights, as lines without per-point times
python3 scripts/generate_test_data.py 100 --seed 7 --format linestring

# See all options
python3 scripts/generate_test_data.py --help
```

### Testing generated data

Generating a site reads the KML files and leaves them alone; only
`--obfuscate-inputs` or `make obfuscate` rewrites them. The generated files
carry no real dates anyway.

```bash
# Build with test data
make build INPUT_DIR=kml_test_10000

# Or with Docker
mkdir -p out ~/.cache/flown
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$PWD/kml_test_10000:/data/kml_test_10000" -v "$PWD/out:/data/out" \
  -v ~/.cache/flown:/cache \
  flown kml_test_10000 --output-dir out
```

### Performance testing

Recommended test sizes:

Every file holds 50 points and takes about 6.4 KB as a `gx:Track` (3.4 KB with
`--format linestring`).

- **1k flights**: Quick test, ~6.4 MB source data
- **10k flights**: Standard test, ~64 MB source data
- **100k flights**: Stress test, ~640 MB source data (about 5M points); the 10
  minutes of parallel parsing and export were measured on the `linestring` files
  (~340 MB)

These numbers are the reference for the processing time mentioned in
[Data export](../doc/output.md#data-export). The system has been tested and
optimized to handle 100k+ flights.

## check_pins.py

Checks the versions that are written down in more than one place, which nothing
else reads together:

- `uv.lock` pins a release of every package `build-system.requires` asks for
  that the range there admits, through the `build` dependency group (the
  setuptools CI builds the wheel with). Whether `uv.lock` matches the rest of
  `pyproject.toml` is uv's to check (`uv lock --check`, `uv sync --locked`).
  Dependabot raises both ranges and the pin together; this catches a range
  raised by hand in `build-system.requires` alone.
- The setup-uv step of the setup-toolchain action and the uv image of the
  `Dockerfile` name the same uv release, and the image is pinned by its
  `@sha256` digest. Dependabot moves neither to another release.
- No `exclude-newer-package` entry of `pyproject.toml` names a date that the
  cutoff of `exclude-newer` (`7 days`) has passed. Such an entry lets a security
  fix younger than the cutoff into `uv.lock`; once the cutoff passes its date it
  holds the package further back than every other, and keeps each later release
  out without an error anywhere. Remove it then.
- The Playwright image of `.github/images/playwright/Dockerfile`, the one FROM
  line the `e2e`, `visual` and `pyodide` jobs read, is pinned by its `@sha256`
  digest and its tag matches the `@playwright/test` version in
  `package-lock.json`. The workflow names no image of its own, and
  `CONTRIBUTING.md` and `doc/development/testing.md` run the one of that file
  (and quote no other). A document that is missing, or does not name the file,
  fails the check too, rather than leaving the command it moved to unchecked.
- `__version__` in `flown/__init__.py` matches `version` in `package.json` and
  both version fields of `package-lock.json`.
- The Python version of `.python-version` is the one of the `python` base images
  in the `Dockerfile`, `requires-python`, mypy's `python_version` and ruff's
  `target-version`. The Node.js release of `.nvmrc` is exact (`26.12.1`, since
  the gzipped size budgets depend on the zlib it bundles), the tag of the `node`
  base image is the same, and `engines` in `package.json` asks for its major
  version or newer. Dependabot bumps none of them, so they move together by
  hand.
- The gitleaks image of `.github/images/gitleaks/Dockerfile`, which the secrets
  job reads, is pinned by tag and digest, and its tag is the release the
  gitleaks hook of `.pre-commit-config.yaml` pins. Dependabot bumps the two in
  one pull request; a hand edit of either still drifts. The secrets job compares
  the release the pulled image reports as well, but only once the image is
  pulled; this check names the image to update in the lint job, next to the
  other pins.

The other pre-commit hooks are not checked: the linters, formatters and file
checks run from the project environment, so they have no revision of their own
to drift.

With `--online` it also asks the registries, anonymously, for the digest of the
tag of each of the two images and of the uv image of the `Dockerfile`, and fails
when the pinned digest is another: the jobs pull by the digest, so a tag edited
alone keeps running the old image (the bump of `@playwright/test` from 1.64.0 to
1.64.1 kept the browsers, and every other check passed against the old image). A
registry that cannot be reached is a warning, not a failure. `--fix` writes the
tag the library and the hook ask for into the two files, with the digest the
registry gives for it, and then checks as `--online` does; run it on the branch
of a `@playwright/test` bump. `make lint` and the CI lint job run it with
`--online`.

`--uv-requirement [ACTION]` checks nothing: it prints the uv release of the
setup-toolchain action, or of a copy of it, as `uv==<release>`. The `security`
job audits that with `pip-audit`, the base's against the head's in a pull
request, since neither Dependabot nor the audit of `uv.lock` covers uv itself.

## new_advisories.py

Compares two reports of `pip-audit -f json`, or of `npm audit --json`, the audit
of a pull request's base and of its head, and fails on every advisory of the
head that the base does not have. The `security` job of a pull request that
changes a lock file runs it, so an advisory published for a version the base
already pins does not turn the pull request red; a push to `main` and the weekly
run audit the whole lock files. An advisory is matched by its package and its id
or any alias, and for npm only high and critical ones count, as
`npm audit --audit-level=high` does. A report that cannot be read fails it, and
so does the one npm writes when its audit fails (only the error, no advisories).

## pre_push.py

The pre-push hook, installed once per clone with `make hooks`. It runs the
obfuscation check on every KML file that the commits about to be pushed add or
change, and refuses the push when one carries a real date or when it cannot run
the check. It also refuses a commit message that dates a flight the commit adds
or changes (`Add flight 16 Aug 2026`), and the push of such commits to a branch
whose name holds a date (`flights-2026-08-16`). It warns when the push adds the
flights of one trip (up to three flights, or legs that follow on from each other
away from home), which the push then dates to about the day it was made. Commits
count as published only when the remote pushed to has them: a first push to a
remote the clone never fetched from checks all the history but what the refs
pushed to already point at there, commits of other remotes included, since a
private one may hold the raw flights. It needs nothing beyond Python;
`--no-verify` skips it.

`make hooks` installs a copy of `pre-push-hook`, which runs `pre_push.py` of the
worktree the push comes from: the worktrees of a clone share one hooks
directory, and a link into the worktree that installed it would dangle once that
worktree is removed, which git skips without a word. Without a `pre_push.py` to
run, the wrapper refuses the push. The check needs Python 3.14 or newer, which a
Git GUI or a shell outside the virtual environment may not have as `python3`
(macOS ships 3.9): the wrapper runs it with the first of the worktree's `.venv`,
`python3.14`, `python3` and `python` that is new enough, and refuses the push
without one.

## build_visual_site.py

Builds `visual-site/`, the site the visual snapshots are compared against (see
[Visual snapshots](../CONTRIBUTING.md#visual-snapshots)), from the fixture
flights in `tests/fixtures/visual/`. The snapshots allow no differing pixel, so
the script pins what would otherwise vary from build to build: the build time
and commit the statistics panel prints, the airport and runway databases
(`tests/fixtures/airports.csv` and `runways.csv` in a throwaway cache directory,
so nothing is downloaded) and the tile API key. Run `npm run build` first.

```bash
python scripts/build_visual_site.py
```

## check_site_files.py

Checks that a generated site has every file the page loads (the page, its
configuration, the bundles and stylesheets `flown/site_assets.py` lists
(`BUNDLE_FILES`, `CSS_FILES`), the vendored MapLibre and html-to-image files and
`data/metadata.json`), each of them not empty, or with `--package`, that the
installed `flown` package ships the template and the same assets and none of
their source maps. CI runs it on the wheel it installed, on the site that wheel
generates and on the sites the container image generates (all in the `packaging`
job), from the one list in the script. Run `--package` with the Python of the
environment the package is installed in, outside the checkout, so the installed
package is imported and not the sources.

```bash
python scripts/check_site_files.py docs
python scripts/check_site_files.py --package
```

## smoke_site.py

Sets up and checks the small sites the `packaging` job generates the way a user
would, from the wheel and from the image. `prepare <dir>` makes `<dir>/input`
with the first three flights of `data/`, `<dir>/cache` with the airport and
runway fixtures in place of the OurAirports downloads and an empty `<dir>/site`
(`--world-writable` for a run as the image's own user); `check <dir>` runs the
site check above and fails when the fixtures in the cache were replaced, that is
when the build downloaded something. Standard library only, since the image's
builds run it with the runner's Python.

```bash
python scripts/smoke_site.py prepare /tmp/smoke
FLOWN_CACHE_DIR=/tmp/smoke/cache \
  python -m flown --no-terrain /tmp/smoke/input --output-dir /tmp/smoke/site
python scripts/smoke_site.py check /tmp/smoke
```

The cache directory is the one the build reads: `FLOWN_CACHE_DIR` for the
installed package, the `/cache` mount for the image.

## e2e_durations.js

Lists the slowest attempts of the e2e tests from the report of Playwright's JSON
reporter, which CI writes to `test-results/e2e-timings.json` and uploads from
every e2e job as the `e2e-timings-<job>` artifact, whether the run passed or
not. Each line gives the duration, the share of the test's timeout it took, the
result, the project, the spec and the title; a retry is listed as an attempt of
its own. It needs nothing but Node.js, so it runs on a downloaded artifact:

```bash
node scripts/e2e_durations.js e2e-timings.json          # the 20 slowest
node scripts/e2e_durations.js --limit 50 */e2e-timings.json
```

## build-helpers.js

What `build.js` does without building, kept apart because `build.js` runs a
build as it is imported: the GLSL of the custom layers written as a minified
build ships it (`tightenGlsl`, `tightenShaders`), the sizes of the files, the
check that the build wrote only the bundles the site publishes
(`assertExpectedOutputs`), the composition of a bundle and the flags of the
command. `tests/frontend/unit/glsl.test.ts` holds the tightened shaders of every
`ui/*Layer.ts` and `ui/*Shaders.ts` to the same tokens as written, and
`tests/frontend/unit/buildHelpers.test.ts` the rest.

After the sizes, a production build prints what each bundle is made of, by kind
of module and its ten largest modules. `npm run build -- --metafile [path]`
keeps esbuild's metafile, the account of every module in every bundle
(`bundle-meta.json` in the checkout without a path, gitignored), and
`npm run build -- --compare <path>` prints what changed in each bundle since the
build that wrote that file, the largest change first: build `main` with
`--metafile`, then a branch with `--compare`, to see where its bytes went.

## source-hash.js

The content hash of everything that shapes a built site: the TypeScript sources
in `flown/frontend/`, the files in `BUILD_FILES` (`build.js`,
`scripts/build-helpers.js`, `scripts/vendor.js`, `tsconfig.json` and the
stylesheets) and the versions `package-lock.json` pins for `BUILD_PACKAGES`
(esbuild, Lucide as the one package bundled into the page, and MapLibre,
html-to-image and flag-icons, which are vendored next to the bundles).
`build.js` writes it into the first line of every bundle. A Playwright fixture
(`tests/e2e/site-check.ts`) compares that line in the `mapApp.bundle.js` of the
site under test (`docs/`, or `visual-site/` for the snapshots) with the
checkout, so the e2e tests refuse to run against a stale site, and the generator
warns when the bundle it is about to publish is stale. `flown/site_assets.py`
mirrors the hash in Python; `TestSourceHashParity` in
`tests/test_site_assets.py` checks that both implementations agree. Two more
hashes live there: `computeGeneratorHash`, of the Python package, its templates
and the static files besides the bundles, which `generator_hash` in
`site_assets.py` writes into `map_config.js` (`TestGeneratorHashParity`), and
`computeFixtureHash`, of what the fixture site is made of, which
`build_visual_site.py` writes into `visual-site/fixture.sha1`. The site check
compares both with the checkout.

## vendor.js

Copies the third-party files the published page loads (the two modules of
MapLibre GL JS with its stylesheet) out of `node_modules` into
`flown/static/vendor/`, bundles the module of html-to-image into one file next
to them (the package ships it as a dozen, and the page imports it with
`import()` on the first export), and copies every country flag of `flag-icons`
into `flown/static/flags/`. Both directories are generated and gitignored, and
each build replaces them, so a file dropped from the list does not linger. A
copy differs from its original in the closing `sourceMappingURL` comment, left
off because the maps (five megabytes for MapLibre) are not shipped and every
DevTools session would ask for them and get a 404, and the MapLibre modules in
six fixes of a few characters each for what the app cannot do from the outside
(`VENDOR_PATCHES` in `vendor.js`). Three are in `maplibre-gl.mjs`, for bugs:
tiles of the chase view's trail culled below the camera on the relief, the raw
data of before kept by a GeoJSON tile that loads empty, and, in WebKit on Linux
alone (WebKitGTK as in Epiphany, and WPE, Playwright's WebKit), elevation tiles
read into pixels on the main thread rather than sent to MapLibre's worker as
bitmaps, which crashed or hung the page's process there (`LINUX_WEBKIT` in
`vendor.js` tells that browser by `navigator.platform` and the user agent). The
texts of their upstream issues are with the owner and not filed yet. A fourth
there starts the worker from the URL the page preloads, without the `?v=`
version MapLibre adds. The other two, in `maplibre-gl-worker.mjs`, let
MapLibre's worker read a GeoJSON source from a `blob:` URL without the main
thread, as the heat sources are given (see
[The heat sources and the year worker](../doc/development/heat.md#the-heat-sources-and-the-year-worker)).
A fix that no longer matches exactly once fails the build, so a MapLibre bump
shows whether it is still needed. The stylesheet is copied without the styles of
the controls the app never adds (`VENDOR_CSS_STRIPS`): the navigation,
fullscreen, globe, terrain, geolocate, logo and scale controls, whose icons as
`data:` URIs were three quarters of its 83 KB. Every rule whose selectors all
name one of them is left out, and the build fails when the number of such rules
is not the one recorded, so a bump that adds or renames a control gets looked
at. Serving the files from the site keeps the page working during a CDN outage,
keeps visitors' addresses away from CDNs and leaves `package-lock.json` as the
one place their versions are pinned. `flown/site_assets.py` keeps its own list
of the files it publishes, in step with `VENDOR_FILES` and `VENDOR_MODULES`,
which `tests/test_site_assets.py` checks; `tests/frontend/unit/vendor.test.ts`
checks both against `node_modules`. The wheel ships `vendor/` but not `flags/`,
and the Python side publishes only the flags of the countries an export visited.
