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
# Every container runs without capabilities and cannot gain privileges (a
# setuid binary in the image gets none), and under SELinux confinement where
# the host has it: the bind mounts are relabeled for it (see MOUNT_RW) rather
# than the confinement turned off.
IS_PODMAN := $(shell $(CONTAINER_RUNTIME) --version 2>/dev/null | grep -qi podman && echo yes)
ifeq ($(IS_PODMAN),yes)
RUN_AS_USER = --userns=keep-id --user "$(shell id -u):$(shell id -g)"
else
RUN_AS_USER = --user "$(shell id -u):$(shell id -g)"
endif
CONFINED = $(RUN_AS_USER) --cap-drop=ALL --security-opt=no-new-privileges
# The options of a bind mount. z relabels it for SELinux with a label the
# containers that mount it at the same time share (`make serve` reads
# OUTPUT_DIR while `make build` writes it), Z with one private to its
# container, for the cache only the build mounts; podman and docker skip
# both on a host without SELinux, and neither relabels the home directory
# itself. Variables, as the comma of "ro,z" would split the arguments of
# $(call in_image) otherwise.
MOUNT_RW := z
MOUNT_RO := ro,z
MOUNT_CACHE := Z
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
	@echo "  LINT_BASE=$(LINT_BASE)"
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
	$(CONTAINER_RUNTIME) run --rm $(CONFINED) -e HOME=/tmp \
	  -e CARTO_API_KEY -e FLOWN_SITE_URL \
	  -e FLOWN_COMMIT -e FLOWN_REPOSITORY -e SOURCE_DATE_EPOCH \
	  -e FLOWN_STABLE_MTIMES -e FLOWN_REQUIRE_AIRPORT_DB \
	  -e FLOWN_REQUIRE_TERRAIN \
	  -v "$(abspath $(INPUT_DIR)):$(INPUT_MOUNT):$(MOUNT_RO)" \
	  -v "$(abspath $(OUTPUT_DIR)):$(OUTPUT_MOUNT):$(MOUNT_RW)" \
	  -v "$(CACHE_MOUNT):/cache:$(MOUNT_CACHE)" \
	  $(IMAGE_NAME) "$(INPUT_MOUNT)" --output-dir "$(OUTPUT_MOUNT)"

serve: require-runtime ## Serve OUTPUT_DIR on http://HOST_BIND:PORT (run 'make build' first)
	@test -f "$(OUTPUT_DIR)/index.html" || { \
	  echo "error: '$(OUTPUT_DIR)/index.html' not found; run 'make build' first"; \
	  exit 1; }
	$(CONTAINER_RUNTIME) run --rm $(TTY_FLAG) $(CONFINED) --read-only -e HOME=/tmp \
	  -p "$(HOST_BIND):$(PORT):8000" -e BIND_HOST=0.0.0.0 \
	  -e OPEN_URL="http://$(if $(filter 0.0.0.0,$(HOST_BIND)),localhost,$(HOST_BIND)):$(PORT)/" \
	  -v "$(abspath $(OUTPUT_DIR)):/data:$(MOUNT_RO)" \
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
  $(CONTAINER_RUNTIME) run --rm $(CONFINED) -e HOME=/tmp $(2) \
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
	  $(call in_image,python -m flown.obfuscate "$(INPUT_MOUNT)",-v "$(abspath $(INPUT_DIR)):$(INPUT_MOUNT):$(MOUNT_RW)"); \
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
	    python -m flown.obfuscate "$(VISUAL_MOUNT)" --check,-v "$(abspath $(INPUT_DIR)):$(INPUT_MOUNT):$(MOUNT_RO)" \
	    -v "$(CURDIR)/tests/fixtures/visual:$(VISUAL_MOUNT):$(MOUNT_RO)"); \
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

# Every check of the CI lint job. The file checks are the fixers of the
# pre-commit hooks, which fix what they find (as the hooks do) and fail
# naming the file, over every tracked text file but the flights of data/ and
# INPUT_DIR. The commits of the branch that main (LINT_BASE) does not have
# are checked one by one with their messages, as the pre-push hook and CI
# check them (scripts/pre_push.py --range).
LINT_BASE ?= origin/main

lint: ## Run the linters, formatters (check only), type checkers, file checks and typos of the CI lint job
	$(UV) lock --check
	python scripts/check_pins.py
	ruff check .
	ruff format --check .
	mypy .
	npm run typecheck
	npm run typecheck:tests
	npm run lint
	npm run lint:unused
	npm run format:check
	zizmor --min-severity medium .github
	@files=$$(mktemp) || exit 1; status=0; \
	  git grep -Izl -e '' -- ':(exclude)data/' ':(exclude,glob,icase)**/*.km[lz]' > "$$files" || status=1; \
	  xargs -0 end-of-file-fixer < "$$files" || status=1; \
	  xargs -0 trailing-whitespace-fixer --markdown-linebreak-ext=md < "$$files" || status=1; \
	  git grep -Izl -e '' | xargs -0 check-merge-conflict --assume-in-merge || status=1; \
	  git ls-files -z -- '*.toml' | xargs -0 check-toml || status=1; \
	  git ls-files -z -- '*.yml' '*.yaml' | xargs -0 check-yaml || status=1; \
	  rm -f "$$files"; exit $$status
	python -m flown.obfuscate data --check
	test "$(INPUT_DIR)" = data || python -m flown.obfuscate "$(INPUT_DIR)" --check
	python -m flown.obfuscate tests/fixtures/visual --check
	python scripts/pre_push.py --range "$(LINT_BASE)" HEAD
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

# The dependencies are declared once, in pyproject.toml, and uv.lock pins
# all of them, the extras among them, with their hashes. --upgrade moves every
# package to its newest release past the cooldown of [tool.uv] exclude-newer;
# Dependabot moves one package at a time between runs of it. uv is the
# release CI and the container image run (scripts/check_pins.py checks that
# the two agree), installed on its own: see CONTRIBUTING.md.
UV ?= uv

lock: ## Regenerate uv.lock from pyproject.toml, moving every package to its newest release
	$(UV) lock --upgrade

clean: ## Remove the container image (when a runtime is available) and local build artifacts, including the frontend build output in flown/static/ and the fixture site of the visual snapshots
	-@test -z "$(CONTAINER_RUNTIME)" || $(CONTAINER_RUNTIME) rmi $(IMAGE_NAME) 2>/dev/null
	rm -rf htmlcov coverage coverage.xml .coverage .coverage.* test-results* playwright-report* \
	  visual-site e2e-sites bundle-meta.json \
	  dist build *.egg-info .mypy_cache .ruff_cache .pytest_cache .hypothesis \
	  .playwright-mcp \
	  flown/static/*.bundle.js flown/static/*.map \
	  flown/static/vendor flown/static/flags
	find . \( -path ./node_modules -o -path ./.git -o -path ./.claude \
	  -o -path ./.venv -o -path ./venv \) -prune -o \
	  -type d -name __pycache__ -prune -exec rm -rf {} +
