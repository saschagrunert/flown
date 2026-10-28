# Flown runtime image
#
# Base images carry both the tag and the digest of the multi-arch index, so
# Dependabot bumps the two together and the version stays readable in the FROM
# line itself. Do not restate the tag in a comment: it drifts silently.

# uv, which installs the Python dependencies from uv.lock below. Only its
# binary is used, mounted into the step that runs it, so it never becomes a
# layer of the image. The same release as CI (scripts/check_pins.py).
FROM ghcr.io/astral-sh/uv:0.13.5@sha256:32a7bb39b496babbd997b0a39a4d66c126bdaf5661b302bf6f06abda8deca6ff AS uv

# Stage 1: build the JavaScript bundles
FROM docker.io/library/node:26.12.1-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS js-builder

WORKDIR /build

# Install dependencies first so that source changes do not invalidate this
# layer. The build needs the runtime dependencies (vendored or bundled into
# the page, and the country flags scripts/vendor.js copies) and three of the
# development ones: esbuild, which runs it, and @babel/parser and
# @babel/types, which find the shaders and the popup markup it tightens. The
# rest of the development tools (Playwright, Vitest, jsdom, ESLint,
# TypeScript) only test and lint, so the development dependencies are cut
# down to those three before installing.
# npm ci would refuse the edited package.json; npm install takes every
# version and integrity hash from the unchanged package-lock.json and
# --no-save leaves it as it is. A package build.js starts to import without
# being listed here fails the image build, not the site.
COPY package.json package-lock.json ./
RUN node -e ' \
      const fs = require("node:fs"); \
      const manifest = JSON.parse(fs.readFileSync("package.json", "utf8")); \
      const build = ["esbuild", "@babel/parser", "@babel/types"]; \
      manifest.devDependencies = Object.fromEntries( \
        build.map((name) => [name, manifest.devDependencies[name]])); \
      fs.writeFileSync("package.json", JSON.stringify(manifest, null, 2)); \
    ' \
    && npm install --no-save --no-audit --no-fund

# Only what build.js reads: its own scripts, the compiler options, the
# TypeScript sources and the stylesheets that are part of the source hash
# (scripts/source-hash.js). A change to the Python side or the templates then
# reuses the bundles of the last build.
COPY build.js tsconfig.json ./
COPY scripts/*.js ./scripts/
COPY flown/frontend/ ./flown/frontend/
COPY flown/static/*.css ./flown/static/
RUN npm run build

# Stage 2: the Python package without the TypeScript sources. A stage of its
# own so the sources never become a layer of the image; they are dropped here
# rather than in .dockerignore, which would hide them from the build as well.
FROM docker.io/library/python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS package
COPY flown/ /package/flown/
RUN rm -rf /package/flown/frontend

# Stage 3: the runtime dependencies uv.lock pins, with their hashes, as a
# requirements file. A stage of its own so that the install below only runs
# again when the pins change: it copies this file alone, and an edit to
# pyproject.toml that leaves them as they were (a ruff or mypy setting)
# writes the same file. --locked fails the build when uv.lock no longer
# matches pyproject.toml instead of resolving again.
FROM docker.io/library/python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170 AS requirements
WORKDIR /build
COPY pyproject.toml uv.lock ./
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    UV_PYTHON_DOWNLOADS=never \
    uv export --locked --no-emit-project --no-header --format requirements-txt \
      --quiet --output-file requirements.txt

# Stage 4: Python runtime
FROM docker.io/library/python:3.14-slim@sha256:a2b82f3c48559aa0a8446d9af49826b6e2b2016f4cd2afabfe6013ec53729170

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install those pins into a virtual environment, on the Python of the base
# image, checking every hash. A venv uv creates has no pip, so nothing in it
# can install anything once built. The bytecode is compiled here for the
# reason given for the package below.
COPY --from=requirements /build/requirements.txt ./
RUN --mount=from=uv,source=/uv,target=/usr/local/bin/uv \
    UV_PYTHON_DOWNLOADS=never uv venv --quiet /opt/venv \
    && uv pip install --python /opt/venv --require-hashes --no-cache \
      --compile-bytecode -r requirements.txt \
    && rm requirements.txt
ENV PATH="/opt/venv/bin:$PATH"

# The Python package with its templates and static assets, then the built
# bundles (and their source maps), the vendored files and the flags over its
# static directory
COPY --from=package /package/flown/ ./flown/
COPY --from=js-builder /build/flown/static/ ./flown/static/
COPY serve.py ./
# The bytecode, compiled once here: the unprivileged user cannot write it
# next to the sources, and PYTHONDONTWRITEBYTECODE keeps any run from trying,
# so every run would compile every module again otherwise
RUN python -m compileall -q /app/flown /app/serve.py

# Run as an unprivileged user; /data is the work directory for input and
# output mounts, /cache holds the OurAirports database, the elevation tiles
# and the parse cache.
RUN useradd --system --uid 10001 --user-group --no-create-home \
      --home-dir /nonexistent --shell /usr/sbin/nologin app \
    && mkdir -p /data /cache \
    && chown app:app /data /cache

ENV PYTHONPATH=/app \
    FLOWN_CACHE_DIR=/cache

USER app
WORKDIR /data

ENTRYPOINT ["python", "-m", "flown"]
# Default command: show the help text
CMD ["--help"]
