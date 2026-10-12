# Contributing

Thanks for taking the time to contribute. This document describes the local
setup, the checks that run in CI and the conventions used in this repository.

## Setup

- Python 3.14 (`.python-version`) and Node.js 26 (`.nvmrc`). CI and the
  container image use Node.js 26, and that is the only release the tests run on,
  so `engines` in `package.json` asks for 26 or newer. Python 3.14 is required,
  not merely recommended: the code uses its syntax. On a distribution that ships
  an older Python, `uv venv --python 3.14 .venv` or pyenv (`pyenv install 3.14`)
  provides it, in place of the `python -m venv` below.
- podman or docker for `make build` and `make serve` (optional)
- `.editorconfig` tells editors the indentation, line endings and final newline
  that Prettier and ruff write.

```bash
git clone https://github.com/saschagrunert/flown.git
cd flown

python -m venv .venv && source .venv/bin/activate
pip install --require-hashes -r requirements-test.lock -r requirements-build.lock
pip install --no-deps --no-build-isolation -e .
npm ci
npm run build                 # frontend bundles (gitignored)

pip install pre-commit
make hooks                    # the pre-commit hooks and the pre-push check for real flight dates
```

The lock files are what CI installs: `requirements-test.lock` pins the test and
development tools together with the runtime dependencies, each with its hashes,
and `requirements-build.lock` the setuptools that builds the package. The
package itself is then installed on top without resolving anything again, so the
virtual environment has exactly CI's versions. `pip install -e '.[test,dev]'`
would resolve the ranges in `pyproject.toml` anew and can pick newer releases
than CI tests with.

The pre-commit hooks run ruff (check and format), prettier, typos, gitleaks, the
whitespace fixers and the checks for merge conflict markers and for valid TOML
and YAML on every commit. When a commit touches `data/`, they also check that
the KML files are obfuscated. Apart from gitleaks and the hooks of
`pre-commit-hooks`, the hooks run the tools from your own environment rather
than from a pinned mirror, so no hook revision can drift on its own. ruff, typos
and the obfuscation check are resolved off `$PATH` and prettier out of
`node_modules`, so commit with the virtual environment active and after `npm ci`
to get the versions CI installs.

npm 11 skips the install scripts of dependencies that `allowScripts` in
`package.json` does not list. esbuild's is listed, so `npm ci` runs it. The only
other one is fsevents, an optional dependency of vite that npm installs on macOS
alone: its script compiles the native module anew (`node-gyp rebuild`), which
needs a compiler, and the package ships that module prebuilt, so it is left
unlisted and npm skips it with a warning there. A new dependency that needs its
install script has to be added on purpose (`npm install-scripts approve <pkg>`).

### First build

A site built from the fixture flights of the visual snapshots finishes offline
in under a minute and shows that the setup works:

```bash
npm run build && python -m flown --no-terrain tests/fixtures/visual --output-dir out
python -m http.server 8000 --bind 127.0.0.1 -d out   # then open http://127.0.0.1:8000/
```

`out/` is gitignored. `--no-terrain` skips the elevation tiles, and offline the
airport database cannot be downloaded, so the log warns and the airports keep
the names the files spell.

### Windows

The Makefile, the hooks and the scripts are POSIX (`sh`, `make`, `id`). On
Windows use WSL, where the setup above works as on Linux, or the container
commands in [Docker usage](doc/usage.md#docker-usage).

## Checks

Run the same checks as CI before opening a pull request. They use the tools from
your virtual environment and `node_modules`, the same way CI does, so no
container is involved:

```bash
make lint            # lock files and version pins, ruff (check and format), mypy, zizmor, TypeScript 7 (npm run typecheck and typecheck:tests), eslint, knip, prettier, the obfuscation of data/ and the visual fixtures, typos
make format          # ruff format, prettier
make test            # npm run build and the site in docs/, then vitest (shuffled) and pytest with coverage; pytest flags are in doc/development/testing.md
npm run test:e2e     # Playwright: desktop, mobile and WebKit (see doc/development/testing.md)
make obfuscate       # after adding flights to data/ (see doc/adding-flights.md); rewrites them in place, irreversibly
make check-obfuscation
make lock            # regenerates the Python lock files after changing pyproject.toml or requirements-tools.in
```

`make help` lists all targets and the current variable values.

The type checks run TypeScript 7 through `npm run typecheck`. A bare `tsc`
(`node_modules/.bin/tsc`), an editor's workspace TypeScript and the type-aware
ESLint rules still run TypeScript 6.0.3 until typescript-eslint supports 7 (see
[Frontend](doc/development/frontend.md)).

Because the project targets Python 3.14, `ruff format` writes multi-exception
handlers in the PEP 758 style without parentheses
(`except ValueError, TypeError:`). That is the formatter's canonical output
here, not an oversight: adding the parentheses back is undone on the next
`make format`.

## Repository rules

- **The generated site is not tracked.** `docs/` is only the default output
  directory of a local `make build`. On every push to `main` the `test` workflow
  builds the site from the sources and `data/` and publishes it to GitHub Pages,
  in its `site` and `deploy` jobs. The site is built alongside the tests, and
  `deploy` publishes it only once every test job has passed and only while the
  commit is still the head of `main` (a re-run of an older run does not
  publish). The `unit` job builds its own copy, and the `e2e-sites` job the two
  the e2e jobs test: one with a dummy tile API key and, for the specs that
  depend on it, one without. The repository's Pages source has to be "GitHub
  Actions" (Settings > Pages). Set it by hand: the workflow token is not allowed
  to change it.
- **The other settings made by hand.** A ruleset on `main` (Settings > Rules)
  requires the `checks` status, the last job of the `test` workflow, which
  passes only when every test job a pull request runs did; it blocks force
  pushes, and it sends pull requests through the merge queue (the workflow runs
  on `merge_group` for it) or, where the merge queue is not available, requires
  a branch to be up to date with `main` before it merges. Settings > Actions >
  General requires every action to be pinned to a full commit SHA and allows
  only the actions of GitHub, of verified creators, `codecov/*` and
  `crate-ci/*`; a workflow that uses any other action fails until it is allowed
  there.
- **Never commit un-obfuscated KML files.** Generating a site no longer rewrites
  them: run `make obfuscate` after adding flights to `data/` (or pass
  `--obfuscate-inputs`). The pre-commit hook, `make check-obfuscation` and the
  CI lint job verify that every committed file is obfuscated, but only the hooks
  run before the dates would be public. The pre-push hook (install it with
  `make hooks`) checks every commit being pushed, needs nothing beyond Python
  3.14 and refuses the push when it cannot check. The published site carries no
  flight date finer than the year either way; this is about the KML files this
  repository commits.
- The frontend build output in `flown/static/` is gitignored: the bundles with
  their `.map` files (listed in
  [Frontend](doc/development/frontend.md#architecture)), `vendor/` (the
  third-party code copied out of `node_modules`) and `flags/` (the country flags
  of `flag-icons`). It is built by `npm run build` and, for the image, inside
  the Dockerfile; `make clean` removes it.
- The Python dependencies are declared once, in `pyproject.toml` (runtime
  dependencies plus the `test` and `dev` extras). `requirements.lock`,
  `requirements-test.lock` and `requirements-build.lock` are compiled from it
  with `make lock` (pip-compile with hashes), and `requirements-tools.lock`, the
  pip-tools `make lock` runs with its dependencies, from
  `requirements-tools.in`. Edit `pyproject.toml`, then regenerate the locks; the
  CI lint job fails while the locks no longer satisfy `pyproject.toml`. A
  Dependabot `pip` pull request fails it only when its new range leaves out the
  version the locks pin, and tests the old versions either way until `make lock`
  is pushed on top. `make lock` compiles the test lock with the runtime lock as
  a constraint, so the pins both files share cannot drift apart. Nothing
  regenerates them on a schedule: run `make lock` yourself to pick up new
  releases, and push it on top of a Dependabot `pip` pull request. Like
  Dependabot it skips releases younger than seven days;
  `make lock LOCK_COOLDOWN=` takes the newest ones, for a range raised by hand
  to a release that is younger.
- The published page carries MapLibre GL JS and html-to-image itself:
  `scripts/vendor.js` takes them out of `node_modules` at build time, so
  `package-lock.json` is the only place their versions are pinned and Dependabot
  can bump them like anything else. Nothing loads from a CDN, and the e2e
  fixture fails any test whose page reaches a third-party origin.
- AI assistant files (`AGENTS.md`, `.claude/`) are ignored by git and the
  container build context; keep them local.

## Commits and pull requests

- Use conventional prefixes as seen in the history: `fix:`, `feat:`, `perf:`,
  `refactor:`, `build:`, `ui:`, `test:`, `docs:`, `chore:`, `ci:` (Dependabot
  uses `npm`, `pip`, `docker`, `pre-commit` and `ci`).
- Sign off every commit: `git commit -s`. The Developer Certificate of Origin
  applies.
- Keep one commit per branch. Amend it when addressing review feedback and keep
  the message in sync with the final state of the change.
- Keep messages concise and describe what changed and why. Do not reference
  issue or pull request numbers in the commit message; GitHub links them in the
  pull request.
- Write in a plain, direct style. Do not use em dashes or en dashes.

## Visual snapshots

`tests/e2e/visual.spec.ts` compares the page's chrome against committed
screenshots. Pixel comparisons only mean anything where the rendering is fixed,
so they run inside the Playwright image rather than against whatever browser is
on the machine, in CI and locally alike. The project only exists there (or with
`VISUAL_SNAPSHOTS=1`, for an equivalent setup), so a plain `npm run test:e2e`
leaves it out instead of failing on font rendering that was never going to
match:

```bash
podman run --rm --ipc=host --network host --userns=keep-id --user "$(id -u):$(id -g)" \
  --security-opt label=disable -v "$PWD:/work" -w /work -e HOME=/tmp \
  mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27 \
  npx playwright test --project=visual
```

The snapshots are not taken of `docs/`. The statistics rail and the Wrapped
dialog print figures computed from the flights, and `data/` grows all the time,
so the project has a site of its own: `visual-site/`, built from the few flights
in `tests/fixtures/visual/` (obfuscated like the ones in `data/`, which the
hooks, `make check-obfuscation` and the CI lint job check too), with
`tests/fixtures/airports.csv` and `runways.csv` in place of the OurAirports
downloads and a fixed build time and commit. Build it before running the command
above, outside the container, since the image has no Python the package runs on:

```bash
npm run build && python scripts/build_visual_site.py
```

The run refuses a `visual-site/` built from other sources, another generator,
another fixture or another version of that script, and names this command: the
script leaves the hash of the fixture in `visual-site/fixture.sha1`, and
`map_config.js` carries the hash of the generator.

Nothing in that site changes on its own and the pinned image renders it the same
on every run, so every snapshot is compared exactly (`maxDiffPixels: 0`). An
earlier tolerance of 1% for the rail and the dialog let a missing control row
and three stale snapshots pass. `PINNED_YEAR` in the spec picks the earlier of
the fixture's two years through the URL.

When a change is meant to alter the look, or the fixture changes, add
`--update-snapshots=all` to the command above and commit the new screenshots.
The plain `--update-snapshots` only rewrites a snapshot whose comparison fails,
and the comparison still ignores a small difference in the colour of a pixel
(Playwright's `threshold`), so a snapshot can be stale and pass; `=all` rewrites
every snapshot that is not identical. The diff of a failing CI run is in the
`visual-diff` artifact.

The image is pinned by tag and digest, in the `visual` and `e2e` jobs of
`.github/workflows/test.yml` and in the command above alike. The tag has to
match the `@playwright/test` version in `package-lock.json`, and
`scripts/check_locks.py` fails the lint job when the workflow, this file,
[`doc/development/testing.md`](doc/development/testing.md#running-them-locally)
and the lock file disagree. Dependabot opens the `@playwright/test` bump as a
pull request of its own and does not touch the image: on that branch, set the
new tag with the digest of its multi-arch index in the two jobs and the two
documents. Until you push that, the `visual` and `e2e` jobs skip Dependabot's
own pushes to the branch rather than fail against the old image, and the lint
job is the one that fails. The registry returns the digest in the
`Docker-Content-Digest` header:

```bash
curl -sI -H "Accept: application/vnd.oci.image.index.v1+json" \
  https://mcr.microsoft.com/v2/playwright/manifests/v1.64.0-noble |
  grep -i docker-content-digest
```

A new image may render differently; regenerate the snapshots on that branch if
the visual job says so.

## Version

There are no releases: the site is deployed from `main` (see the `site` and
`deploy` jobs of `.github/workflows/test.yml`). The version is declared once, in
`flown/__init__.py`; `package.json` and `package-lock.json` repeat it and
`scripts/check_locks.py` fails the lint job when the three disagree.
