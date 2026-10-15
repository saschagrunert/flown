<!--
The developer guide. README.md is the user-facing manual and links here, with
the user documentation in doc/; CONTRIBUTING.md covers the setup, the checks
and the commit conventions. The pages of this guide are in doc/development/.
-->

# Development

The developer guide: how the frontend and the Python pipeline are built, how the
map draws the flights and their heat, how the code is tested, and the size
budgets the build enforces. The [README](README.md) is the user-facing manual,
with the user documentation in [doc/](doc/), and
[CONTRIBUTING.md](CONTRIBUTING.md) covers the setup, the checks and the commit
conventions.

## Setup

Set up the virtual environment, `node_modules` and the hooks as
[CONTRIBUTING.md](CONTRIBUTING.md#setup) describes. `make help` lists all
targets. `make test`, `make lint`, `make format` and `make lock` run locally
(Python, uv and Node required); `make lock` regenerates the hashed Python lock
file `uv.lock` from `pyproject.toml`.

## Commands

### Frontend

```bash
npm run build            # Build the production bundle (minified, size budget checked)
npm run build:dev        # Build the development bundle (unminified)
npm run build:watch      # Watch mode for development (no build hash: the e2e tests want `npm run build`)
npm run test             # Run unit tests
npm run test:watch       # Watch mode for tests
npm run test:ui          # Run tests with UI
npm run test:coverage    # Generate coverage report
npm run test:e2e         # Run E2E tests (Playwright; visual only in its image, see CONTRIBUTING.md)
npm run test:e2e:mobile  # Run E2E tests with the mobile project
npm run test:e2e:webkit  # Run E2E tests with the WebKit projects (iPhone and desktop Safari)
npm run test:e2e:ui      # Run E2E tests with interactive UI
npm run typecheck        # Type-check the frontend and the Node.js scripts
npm run typecheck:node   # Type-check build.js, scripts/*.js and the tool configs only
npm run typecheck:tests  # Type-check the unit and e2e tests
npm run lint             # Lint TypeScript code
npm run lint:fix         # Auto-fix linting issues
npm run lint:unused      # Files, exports and dependencies nothing reaches, and files only tests reach (knip)
npm run format           # Format code with Prettier
npm run format:check     # Check code formatting
```

### Python

```bash
pytest                                  # Run all tests (see Testing for the CI flags)
python scripts/check_locks.py           # Lock files, Playwright image, version and toolchain pins
ruff check . && ruff format --check .   # Lint and formatting
mypy .                                  # Type checking
typos                                   # Spell check (config in _typos.toml)
gitleaks dir .                          # Secret scan (config in .gitleaks.toml)
make check-obfuscation                  # data/ and visual fixtures obfuscated
```

## Contents

- [Frontend](doc/development/frontend.md): the TypeScript modules, the bundles
  and what they load, the stylesheets and the build output
  - [Architecture](doc/development/frontend.md#architecture),
    [State and links](doc/development/frontend.md#state-and-links),
    [Bundles](doc/development/frontend.md#bundles),
    [Stylesheets](doc/development/frontend.md#stylesheets),
    [Build output](doc/development/frontend.md#build-output)
- [Rendering](doc/development/rendering.md): the replay camera and its chase
  view, the relief of the 3D view and its ribbons, the satellite imagery
  - [Replay camera](doc/development/rendering.md#replay-camera),
    [The relief of the 3D view](doc/development/rendering.md#the-relief-of-the-3d-view),
    [Selection ribbons](doc/development/rendering.md#selection-ribbons),
    [Satellite imagery](doc/development/rendering.md#satellite-imagery)
- [Heat](doc/development/heat.md): the flat heatmap and its heat lines, the heat
  sources, the legend, the heat cloud of the 3D view with Wrapped's intro, the
  replay of all flights and the readout of the cloud
  - [The flat heatmap](doc/development/heat.md#the-flat-heatmap),
    [The heat sources and the year worker](doc/development/heat.md#the-heat-sources-and-the-year-worker),
    [The heat legend and the heat scale](doc/development/heat.md#the-heat-legend-and-the-heat-scale),
    [The heat cloud of the 3D view](doc/development/heat.md#the-heat-cloud-of-the-3d-view),
    [The cloud in Wrapped's intro](doc/development/heat.md#the-cloud-in-wrappeds-intro),
    [The replay of all flights](doc/development/heat.md#the-replay-of-all-flights),
    [The readout of the heat cloud](doc/development/heat.md#the-readout-of-the-heat-cloud)
- [Data](doc/development/data.md): the Python package and its dependencies,
  parsing, the year file format, the elevation tiles and the year worker
  - [Python package and dependencies](doc/development/data.md#python-package-and-dependencies),
    [Split tracks and recordings of one flight](doc/development/data.md#split-tracks-and-recordings-of-one-flight),
    [Year file format](doc/development/data.md#year-file-format),
    [Elevation tiles at build time](doc/development/data.md#elevation-tiles-at-build-time),
    [The year worker](doc/development/data.md#the-year-worker)
- [Testing](doc/development/testing.md): unit, Python and end-to-end tests, CI
  and deployment, test data generation
  - [Python tests](doc/development/testing.md#python-tests),
    [End-to-end tests](doc/development/testing.md#end-to-end-tests),
    [CI and deployment](doc/development/testing.md#ci-and-deployment),
    [Test data generation](doc/development/testing.md#test-data-generation)
- [Size budgets](doc/development/budgets.md): the bundle and stylesheet budgets,
  how to raise one and where their history is kept
- [Visual snapshots](CONTRIBUTING.md#visual-snapshots), in CONTRIBUTING.md
- [Scripts](scripts/README.md): the build helpers, the lock check, the pre-push
  hook, the test data generator and the builder of the visual site
