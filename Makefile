.PHONY: all build serve serve-build test lint format lock clean help
.PHONY: check-obfuscation obfuscate hooks require-runtime

# The API key is read from the environment (or the make command line) and
# passed into the build container by name only, so its value never shows up in
# the make output or the process list.
CARTO_API_KEY ?=
export CARTO_API_KEY

# The address the site is published at; the link preview images are only
# drawn with it (see --site-url)
FLOWN_SITE_URL ?=
export FLOWN_SITE_URL

# The commit the site is stamped with and the remote it is in; the image
# carries no .git to ask. Evaluated once, not for every recipe line.
ifndef FLOWN_COMMIT
FLOWN_COMMIT := $(shell git rev-parse HEAD 2>/dev/null)
FLOWN_REPOSITORY := $(shell git remote get-url origin 2>/dev/null)
endif
export FLOWN_COMMIT FLOWN_REPOSITORY

# Container runtime: podman is preferred, docker is the fallback.
CONTAINER_RUNTIME ?= $(shell command -v podman 2>/dev/null || command -v docker 2>/dev/null)
INPUT_DIR ?= data
OUTPUT_DIR ?= docs
CACHE_DIR ?= $(or $(FLOWN_CACHE_DIR),$(HOME)/.cache/flown)
# Absolute for the bind mount: a relative one names a volume of the runtime
# instead. Not with abspath, which splits a path with spaces.
CACHE_MOUNT = $(if $(filter /%,$(CACHE_DIR)),$(CACHE_DIR),$(CURDIR)/$(CACHE_DIR))
HOST_BIND ?= 127.0.0.1
PORT ?= 8000
IMAGE_NAME := flown

# INPUT_DIR and OUTPUT_DIR are mounted below /data using their base names, so
# the defaults map to /data/data and /data/docs inside the container.
ifneq ($(words $(INPUT_DIR)),1)
$(error INPUT_DIR must not contain spaces)
endif
ifneq ($(words $(OUTPUT_DIR)),1)
$(error OUTPUT_DIR must not contain spaces)
endif

INPUT_MOUNT := /data/$(notdir $(abspath $(INPUT_DIR)))
OUTPUT_MOUNT := /data/$(notdir $(abspath $(OUTPUT_DIR)))

# Runtime specific flags. They are expanded lazily (recursive variables) so that
# targets without a container runtime keep working. Rootless podman maps the
# host user into the container with keep-id, but keeps the image's USER unless
# --user is given; docker needs --user so that files written to bind mounts are
# not owned by root. HOME is set because the mapped uid has no passwd entry.
IS_PODMAN := $(shell $(CONTAINER_RUNTIME) --version 2>/dev/null | grep -qi podman && echo yes)
ifeq ($(IS_PODMAN),yes)
RUN_AS_USER = --userns=keep-id --user "$(shell id -u):$(shell id -g)" --security-opt label=disable
else
RUN_AS_USER = --user "$(shell id -u):$(shell id -g)"
endif
TTY_FLAG = $(if $(shell test -t 0 && echo y),-it,-i)

all: build

help: ## Show available targets and variables
	@echo "Targets:"
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-24s %s\n", $$1, $$2}'
	@echo
	@echo "Variables (current values):"
	@echo "  CONTAINER_RUNTIME=$(CONTAINER_RUNTIME)"
	@echo "  INPUT_DIR=$(INPUT_DIR)"
	@echo "  OUTPUT_DIR=$(OUTPUT_DIR)"
	@echo "  CACHE_DIR=$(CACHE_DIR)"
	@echo "  HOST_BIND=$(HOST_BIND)"
	@echo "  PORT=$(PORT)"
	@echo "  CARTO_API_KEY (value is not printed)"
	@echo "  FLOWN_SITE_URL=$(FLOWN_SITE_URL)"

require-runtime:
	@test -n "$(CONTAINER_RUNTIME)" || { \
	  echo "error: no container runtime found; install podman or docker, or set CONTAINER_RUNTIME"; \
	  exit 1; }

# INPUT_DIR is mounted read-only: a build never writes its inputs
build: require-runtime ## Build the image and generate OUTPUT_DIR from INPUT_DIR (leaves the input KML files alone)
	@test -d "$(INPUT_DIR)" || { \
	  echo "error: input directory '$(INPUT_DIR)' not found; put your KML files there or run 'make build INPUT_DIR=path'"; \
	  exit 1; }
	@case "$(abspath $(OUTPUT_DIR))/" in "$(abspath $(INPUT_DIR))/"*) \
	  echo "error: OUTPUT_DIR must not be INPUT_DIR or a directory inside it"; \
	  exit 1;; esac
	@case "$(abspath $(INPUT_DIR))/" in "$(abspath $(OUTPUT_DIR))/"*) \
	  echo "error: OUTPUT_DIR must not contain INPUT_DIR, the site would be written over it"; \
	  exit 1;; esac
	@test "$(INPUT_MOUNT)" != "$(OUTPUT_MOUNT)" || { \
	  echo "error: INPUT_DIR and OUTPUT_DIR must have different base names"; \
	  exit 1; }
	$(CONTAINER_RUNTIME) build -t $(IMAGE_NAME) .
	mkdir -p "$(CACHE_MOUNT)" "$(OUTPUT_DIR)"
	$(CONTAINER_RUNTIME) run --rm $(RUN_AS_USER) -e HOME=/tmp \
	  -e CARTO_API_KEY -e FLOWN_SITE_URL \
	  -e FLOWN_COMMIT -e FLOWN_REPOSITORY -e SOURCE_DATE_EPOCH \
	  -e FLOWN_STABLE_MTIMES -e FLOWN_REQUIRE_AIRPORT_DB \
	  -e FLOWN_REQUIRE_TERRAIN \
	  -v "$(abspath $(INPUT_DIR)):$(INPUT_MOUNT):ro" \
	  -v "$(abspath $(OUTPUT_DIR)):$(OUTPUT_MOUNT)" \
	  -v "$(CACHE_MOUNT):/cache" \
	  $(IMAGE_NAME) "$(INPUT_MOUNT)" --output-dir "$(OUTPUT_MOUNT)"

serve: require-runtime ## Serve OUTPUT_DIR on http://HOST_BIND:PORT (run 'make build' first)
	@test -f "$(OUTPUT_DIR)/index.html" || { \
	  echo "error: '$(OUTPUT_DIR)/index.html' not found; run 'make build' first"; \
	  exit 1; }
	$(CONTAINER_RUNTIME) run --rm $(TTY_FLAG) $(RUN_AS_USER) -e HOME=/tmp \
	  -p "$(HOST_BIND):$(PORT):8000" -e BIND_HOST=0.0.0.0 \
	  -e OPEN_URL="http://$(if $(filter 0.0.0.0,$(HOST_BIND)),localhost,$(HOST_BIND)):$(PORT)/" \
	  -v "$(abspath $(OUTPUT_DIR)):/data:ro" \
	  --entrypoint python $(IMAGE_NAME) /app/serve.py

serve-build: build ## Run build, then serve
	$(MAKE) serve

# The obfuscation needs nothing but the Python the project requires. Without
# it as `python` on the host, it runs in the container image, which has it,
# with INPUT_DIR mounted where `make build` mounts it (and writable): the
# names it reports are those in the container then.
HOST_PYTHON_OK = python -c 'import sys; sys.exit(sys.version_info < (3, 14))' 2>/dev/null
VISUAL_MOUNT := /data/visual
# Runs the shell command $(1) in the container image, with the mounts $(2)
define in_image
( test -n "$(CONTAINER_RUNTIME)" || { \
    echo "error: needs Python 3.14 as 'python', or podman or docker to run it in the image"; \
    exit 1; }; \
  echo "No Python 3.14 as 'python': running it in the container image"; \
  $(CONTAINER_RUNTIME) build -q -t $(IMAGE_NAME) . >/dev/null && set -x && \
  $(CONTAINER_RUNTIME) run --rm $(RUN_AS_USER) -e HOME=/tmp $(2) \
    --entrypoint sh $(IMAGE_NAME) -c '$(1)' )
endef

# The generated site never carries a flight date finer than the year, so this
# is about the KML files themselves: this repository commits the ones in
# data/, and they must not carry real dates. Run it after adding new flights;
# the pre-commit hook, `make check-obfuscation` and the CI lint job fail if
# you forget.
obfuscate: ## Rewrite the KML files in INPUT_DIR in place so they carry no real dates (IRREVERSIBLE)
	@test -d "$(INPUT_DIR)" || { \
	  echo "error: input directory '$(INPUT_DIR)' not found; run 'make $@ INPUT_DIR=path'"; \
	  exit 1; }
	@if $(HOST_PYTHON_OK); then \
	  set -x; python -m flown.obfuscate "$(INPUT_DIR)"; \
	else \
	  $(call in_image,python -m flown.obfuscate "$(INPUT_MOUNT)",-v "$(abspath $(INPUT_DIR)):$(INPUT_MOUNT)"); \
	fi

# The flights of the visual snapshots are committed copies of real ones, so
# they are checked along with INPUT_DIR. `make obfuscate` leaves them alone:
# rewriting them would change the snapshots.
check-obfuscation: ## Check that the KML files in INPUT_DIR and the fixture flights of the visual snapshots are obfuscated
	@test -d "$(INPUT_DIR)" || { \
	  echo "error: input directory '$(INPUT_DIR)' not found; run 'make $@ INPUT_DIR=path'"; \
	  exit 1; }
	@if $(HOST_PYTHON_OK); then \
	  set -x; \
	  python -m flown.obfuscate "$(INPUT_DIR)" --check && \
	  python -m flown.obfuscate tests/fixtures/visual --check; \
	else \
	  $(call in_image,python -m flown.obfuscate "$(INPUT_MOUNT)" --check && \
	    python -m flown.obfuscate "$(VISUAL_MOUNT)" --check,-v "$(abspath $(INPUT_DIR)):$(INPUT_MOUNT):ro" \
	    -v "$(CURDIR)/tests/fixtures/visual:$(VISUAL_MOUNT):ro"); \
	fi

# The obfuscation check of CI only sees a real date once it is public; the hook
# refuses the push before. Copied from scripts/pre-push-hook (see there).
# The pre-commit hooks of .pre-commit-config.yaml go in along with it where
# pre-commit is installed; a missing pre-commit is said, not failed on.
hooks: ## Install the pre-push hook that refuses to push KML files with real dates, and the pre-commit hooks
	@hook="$$(git rev-parse --git-path hooks/pre-push)" && \
	  wrapper="$(CURDIR)/scripts/pre-push-hook" && \
	  if [ -e "$$hook" ] || [ -L "$$hook" ]; then \
	    case "$$(readlink "$$hook")" in \
	      */scripts/pre_push.py) ;; \
	      *) grep -qs "^# flown pre-push hook" "$$hook" || { \
	        echo "error: $$hook exists already; remove it or call $$wrapper from it"; \
	        exit 1; } ;; \
	    esac; fi && \
	  mkdir -p "$$(dirname "$$hook")" && rm -f "$$hook" && \
	  cp "$$wrapper" "$$hook" && chmod 755 "$$hook" && \
	  echo "Installed $$hook"
	@if command -v pre-commit >/dev/null 2>&1; then pre-commit install; else \
	  echo "warning: pre-commit is not installed, skipping its hooks (see CONTRIBUTING.md)" >&2; fi

lint: ## Run the linters, formatters (check only), type checkers and typos of the CI lint job
	python scripts/check_locks.py
	ruff check .
	ruff format --check .
	mypy .
	npm run typecheck
	npm run typecheck:tests
	npm run lint
	npm run lint:unused
	npm run format:check
	zizmor --min-severity medium .github
	python -m flown.obfuscate data --check
	python -m flown.obfuscate tests/fixtures/visual --check
	typos

format: ## Run formatters
	ruff format .
	npm run format

# The Python tests build whole sites, which carry the frontend bundles, so
# they are built first. The export contract tests read the data files of a
# real build in docs/, as in the CI unit job, and skip without one (a stale
# one fails them). Vitest runs in an order of its own each time, as in CI.
test: ## Build the frontend bundles and the site in docs/, then run the JavaScript and Python test suites with coverage
	npm run build
	python -m flown data --output-dir docs
	npm run test:coverage -- --sequence.shuffle
	pytest -n auto --cov --cov-report=xml:coverage/coverage.xml --cov-report=term

# The dependencies are declared once, in pyproject.toml: the runtime
# dependencies become requirements.lock, the test and dev extras
# requirements-test.lock. pip-tools is installed into a throwaway environment
# rather than added to the extras, so it cannot drift into what the lock
# files pin. It comes from requirements-tools.lock with the hashes of its
# dependencies as well, so `make lock` runs nothing it has not pinned; that
# lock is compiled last from requirements-tools.in, with the pip-tools it
# pins, and --allow-unsafe keeps pip and setuptools in it.
# The test lock is compiled against the runtime lock as a constraint, so a
# dependency both of them pin gets the same version in each: CI installs
# requirements-test.lock alone where it needs both.
# requirements-build.lock pins what build-system.requires asks for
# (setuptools), which CI installs to build the wheel without build isolation;
# with isolation pip would fetch whatever release satisfies the range, with
# no hash. setuptools is one of the packages pip-compile leaves out unless
# told otherwise, hence --allow-unsafe.
# --upgrade moves every package to its newest release, so only releases at
# least LOCK_COOLDOWN old are considered (pip's --uploaded-prior-to, which
# pip-compile hands on): the same seven days Dependabot waits (see
# dependabot.yml), which a release pulled again within days never reaches.
# `make lock LOCK_COOLDOWN=` takes the newest releases, for a pin raised by
# hand to one that is younger.
LOCK_COOLDOWN ?= P7D
LOCK_COMPILE = CUSTOM_COMPILE_COMMAND="make lock" "$$tmp/bin/pip-compile" --quiet \
	--generate-hashes --strip-extras --upgrade \
	$(if $(LOCK_COOLDOWN),--pip-args "--uploaded-prior-to=$(LOCK_COOLDOWN)")
lock: ## Regenerate the lock files from pyproject.toml and requirements-tools.in with pip-compile
	@tmp=$$(mktemp -d) && \
	  python -m venv "$$tmp" && \
	  "$$tmp/bin/pip" install --quiet --disable-pip-version-check --require-hashes -r requirements-tools.lock && \
	  $(LOCK_COMPILE) \
	    --output-file=requirements.lock pyproject.toml && \
	  $(LOCK_COMPILE) --extra test --extra dev \
	    --constraint requirements.lock \
	    --output-file=requirements-test.lock pyproject.toml && \
	  $(LOCK_COMPILE) --allow-unsafe \
	    --only-build-deps --build-deps-for wheel \
	    --output-file=requirements-build.lock pyproject.toml && \
	  $(LOCK_COMPILE) --allow-unsafe \
	    --output-file=requirements-tools.lock requirements-tools.in; \
	  status=$$?; rm -rf "$$tmp"; exit $$status

clean: ## Remove the container image (when a runtime is available) and local build artifacts, including the frontend build output in flown/static/ and the fixture site of the visual snapshots
	-@test -z "$(CONTAINER_RUNTIME)" || $(CONTAINER_RUNTIME) rmi $(IMAGE_NAME) 2>/dev/null
	rm -rf htmlcov coverage coverage.xml .coverage .coverage.* test-results playwright-report \
	  visual-site e2e-sites bundle-meta.json \
	  dist build *.egg-info .mypy_cache .ruff_cache .pytest_cache .hypothesis \
	  .playwright-mcp \
	  flown/static/*.bundle.js flown/static/*.map \
	  flown/static/vendor flown/static/flags
	find . \( -path ./node_modules -o -path ./.git -o -path ./.claude \
	  -o -path ./.venv -o -path ./venv \) -prune -o \
	  -type d -name __pycache__ -prune -exec rm -rf {} +
