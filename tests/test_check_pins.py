"""Tests for scripts/check_pins.py.

The script is a CI gate: it is the thing that notices when the build pin,
the uv releases, the Playwright and gitleaks images, the package version and
the toolchain versions drift apart. A gate that
silently stops checking fails open, and every check below therefore starts
from a consistent fixture repository and breaks exactly one thing.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent / "scripts" / "check_pins.py"


def _load_module():
    """Import check_pins.py, which lives outside any package."""
    spec = importlib.util.spec_from_file_location("check_pins", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


check_pins = _load_module()

VERSION = "1.0.0"
RUFF = "0.16.4"
UV = "0.13.0"
PLAYWRIGHT = "1.63.0"
DIGEST = "sha256:" + "ab" * 32
IMAGE = f"mcr.microsoft.com/playwright:v{PLAYWRIGHT}-noble@{DIGEST}"
PYTHON = "3.14"
NODE = "26.12.0"
NODE_MAJOR = "26"
# The steps of the setup-toolchain action around its setup-uv step
ACTION = """runs:
  steps:
    - name: Set up Python
      uses: actions/setup-python@abc # v7.0.0
    - name: Set up uv
      uses: astral-sh/setup-uv@def # v10.2.0
      with:
        version: "{uv}"
        activate-environment: true
    - name: Set up Node.js
      uses: actions/setup-node@ghi # v7.1.0
"""
GITLEAKS = "v8.30.1"
# The gitleaks image of the secrets job and the hook of the same release
GITLEAKS_STEP = (
    f"          GITLEAKS_IMAGE: ghcr.io/gitleaks/gitleaks@{DIGEST} # {GITLEAKS}\n"
)
PRE_COMMIT = (
    "repos:\n"
    "  - repo: https://github.com/gitleaks/gitleaks\n"
    f"    rev: {'cd' * 20} # frozen: {GITLEAKS}\n"
    "    hooks:\n"
    "      - id: gitleaks\n"
)
# The tool sections of pyproject.toml that name the Python version
TOOLCHAIN = (
    f'[tool.mypy]\npython_version = "{PYTHON}"\n'
    f'[tool.ruff]\ntarget-version = "py{PYTHON.replace(".", "")}"\n'
)


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A minimal repository in which every check passes."""
    (tmp_path / "pyproject.toml").write_text(
        "[project]\n"
        f'requires-python = ">={PYTHON}"\n'
        'dependencies = ["lxml>=6.0.2"]\n'
        "[project.optional-dependencies]\n"
        'test = ["pytest>=9.0.2"]\n'
        f'dev = ["ruff>={RUFF}"]\n' + TOOLCHAIN,
        encoding="utf-8",
    )
    (tmp_path / ".python-version").write_text(f"{PYTHON}\n", encoding="utf-8")
    (tmp_path / ".nvmrc").write_text(f"{NODE}\n", encoding="utf-8")
    (tmp_path / "Dockerfile").write_text(
        f"FROM ghcr.io/astral-sh/uv:{UV}@{DIGEST} AS uv\n"
        f"FROM docker.io/library/node:{NODE}-slim@{DIGEST} AS js-builder\n"
        f"FROM docker.io/library/python:{PYTHON}-slim@{DIGEST} AS package\n"
        f"FROM docker.io/library/python:{PYTHON}-slim@{DIGEST}\n",
        encoding="utf-8",
    )
    action = tmp_path / ".github" / "actions" / "setup-toolchain"
    action.mkdir(parents=True)
    (action / "action.yml").write_text(ACTION.format(uv=UV), encoding="utf-8")
    (tmp_path / "package.json").write_text(
        json.dumps(
            {
                "name": "flown",
                "version": VERSION,
                "engines": {"node": f">={NODE_MAJOR}"},
            }
        ),
        encoding="utf-8",
    )
    (tmp_path / "package-lock.json").write_text(
        json.dumps(
            {
                "name": "flown",
                "version": VERSION,
                "packages": {
                    "": {"name": "flown", "version": VERSION},
                    "node_modules/@playwright/test": {"version": PLAYWRIGHT},
                },
            }
        ),
        encoding="utf-8",
    )
    workflow = tmp_path / ".github" / "workflows"
    workflow.mkdir()
    (workflow / "test.yml").write_text(
        f"      image: {IMAGE}\n" + GITLEAKS_STEP,
        encoding="utf-8",
    )
    (tmp_path / ".pre-commit-config.yaml").write_text(PRE_COMMIT, encoding="utf-8")
    # The documents that quote the image for the visual tests
    for name in check_pins.PLAYWRIGHT_IMAGE_DOCS:
        doc = tmp_path / name
        doc.parent.mkdir(parents=True, exist_ok=True)
        doc.write_text(
            f"```sh\npodman run {IMAGE} npx playwright test\n```\n",
            encoding="utf-8",
        )
    package = tmp_path / "flown"
    package.mkdir()
    (package / "__init__.py").write_text(
        f'__version__ = "{VERSION}"\n', encoding="utf-8"
    )

    monkeypatch.setattr(check_pins, "ROOT", tmp_path)
    check_pins.read_package_lock.cache_clear()
    yield tmp_path
    check_pins.read_package_lock.cache_clear()


def edit_json(path: Path, **changes):
    """Rewrite selected top-level keys of a JSON file."""
    data = json.loads(path.read_text(encoding="utf-8"))
    data.update(changes)
    path.write_text(json.dumps(data), encoding="utf-8")


class TestPassingRepository:
    def test_reports_success(self, repo, capsys):
        assert check_pins.main() == 0

        captured = capsys.readouterr()
        assert "the same uv" in captured.out
        assert captured.err == ""


class TestUvRelease:
    """CI and the container image install from uv.lock with the same uv."""

    def test_an_image_on_another_release_fails(self, repo, capsys):
        dockerfile = repo / "Dockerfile"
        text = dockerfile.read_text(encoding="utf-8")
        dockerfile.write_text(text.replace(f"uv:{UV}@", "uv:0.14.0@"), encoding="utf-8")

        assert check_pins.main() == 1

        err = capsys.readouterr().err
        assert (
            f"the Dockerfile takes uv 0.14.0, {check_pins.UV_ACTION} installs {UV}"
        ) in err
        assert "Set the same uv release" in err

    def test_an_image_without_a_digest_fails(self, repo, capsys):
        dockerfile = repo / "Dockerfile"
        text = dockerfile.read_text(encoding="utf-8")
        dockerfile.write_text(
            text.replace(f"uv:{UV}@{DIGEST}", f"uv:{UV}"), encoding="utf-8"
        )

        assert check_pins.main() == 1

        assert f"does not pin the uv image {UV} by its @sha256 digest" in (
            capsys.readouterr().err
        )

    def test_a_dockerfile_without_uv_fails(self, repo, capsys):
        dockerfile = repo / "Dockerfile"
        lines = dockerfile.read_text(encoding="utf-8").splitlines(keepends=True)
        dockerfile.write_text("".join(lines[1:]), encoding="utf-8")

        assert check_pins.main() == 1

        assert "takes uv from no ghcr.io/astral-sh/uv image" in capsys.readouterr().err

    def test_an_action_without_a_version_fails(self, repo, capsys):
        """setup-uv without a version installs whatever release is newest."""
        path = repo / check_pins.UV_ACTION
        text = path.read_text(encoding="utf-8")
        path.write_text(
            text.replace(f'        version: "{UV}"\n', ""), encoding="utf-8"
        )

        assert check_pins.main() == 1

        assert "installs no uv release by version" in capsys.readouterr().err

    @pytest.mark.parametrize("version", [UV, f"'{UV}'", f"{UV} # the release"])
    def test_an_unquoted_or_commented_version_is_read(self, repo, version):
        path = repo / check_pins.UV_ACTION
        text = path.read_text(encoding="utf-8")
        path.write_text(text.replace(f'"{UV}"', version), encoding="utf-8")

        assert check_pins.main() == 0

    def test_a_missing_action_is_a_problem_not_a_crash(self, repo, capsys):
        (repo / check_pins.UV_ACTION).unlink()

        assert check_pins.main() == 1

        assert f"{check_pins.UV_ACTION} cannot be read" in capsys.readouterr().err

    def test_a_version_of_another_step_is_not_read(self, repo, capsys):
        """The version input belongs to the setup-uv step, not to the one
        after it."""
        path = repo / check_pins.UV_ACTION
        text = path.read_text(encoding="utf-8")
        path.write_text(
            text.replace(f'        version: "{UV}"\n', "")
            + f'      with:\n        version: "{UV}"\n',
            encoding="utf-8",
        )

        assert check_pins.main() == 1

        assert "installs no uv release by version" in capsys.readouterr().err


class TestPlaywrightImage:
    def test_an_image_ahead_of_the_library_fails(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8").replace(
                f"v{PLAYWRIGHT}-noble", "v1.70.0-noble"
            ),
            encoding="utf-8",
        )

        assert check_pins.main() == 1

        assert (
            "runs the Playwright image v1.70.0, package-lock.json pins 1.63.0"
            in capsys.readouterr().err
        )

    def test_an_image_without_a_digest_fails(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8").replace(f"@{DIGEST}", ""),
            encoding="utf-8",
        )

        assert check_pins.main() == 1

        assert "by its @sha256 digest" in capsys.readouterr().err

    def test_a_malformed_digest_is_no_digest(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8").replace(DIGEST, "sha256:abc"),
            encoding="utf-8",
        )

        assert check_pins.main() == 1

        assert "by its @sha256 digest" in capsys.readouterr().err

    def test_a_second_job_on_the_same_image_passes(self, repo):
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8") + f"      image: {IMAGE}\n",
            encoding="utf-8",
        )

        assert check_pins.main() == 0

    def test_a_second_job_on_another_image_fails(self, repo, capsys):
        """The e2e jobs run in the image as well; one left behind on a bump
        would test other browsers than the visual job without a word."""
        stale = f"mcr.microsoft.com/playwright:v1.62.0-noble@{DIGEST}"
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8") + f"      image: {stale}\n",
            encoding="utf-8",
        )

        assert check_pins.main() == 1

        err = capsys.readouterr().err
        assert f"runs different Playwright images: {IMAGE}, {stale}" in err
        assert "runs the Playwright image v1.62.0, package-lock.json pins" in err

    def test_a_document_quoting_the_same_image_passes(self, repo):
        (repo / "CONTRIBUTING.md").write_text(
            f"Build it first.\n\n```sh\npodman run {IMAGE} npx playwright "
            "test --project=visual\n```\n",
            encoding="utf-8",
        )

        assert check_pins.main() == 0

    @pytest.mark.parametrize("name", check_pins.PLAYWRIGHT_IMAGE_DOCS)
    def test_a_missing_document_fails(self, repo, capsys, name):
        # A document moved or renamed left its command unchecked
        (repo / name).unlink()

        assert check_pins.main() == 1

        assert f"{name} is missing" in capsys.readouterr().err

    @pytest.mark.parametrize("name", check_pins.PLAYWRIGHT_IMAGE_DOCS)
    def test_a_document_quoting_no_image_fails(self, repo, capsys, name):
        (repo / name).write_text("See the testing guide.\n", encoding="utf-8")

        assert check_pins.main() == 1

        assert f"{name} quotes no Playwright image" in capsys.readouterr().err

    def test_a_document_quoting_another_image_fails(self, repo, capsys):
        stale = f"mcr.microsoft.com/playwright:v{PLAYWRIGHT}-noble"
        doc = repo / "doc/development/testing.md"
        doc.write_text(
            f"Run `podman run {stale} npx playwright test`.\n", encoding="utf-8"
        )

        assert check_pins.main() == 1

        assert (
            f"doc/development/testing.md quotes the Playwright image {stale}, "
            f".github/workflows/test.yml runs {IMAGE}"
        ) in capsys.readouterr().err

    def test_a_workflow_without_the_image_fails(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text("jobs:\n", encoding="utf-8")

        assert check_pins.main() == 1

        assert "runs no Playwright image" in capsys.readouterr().err

    def test_an_unpinned_library_fails(self, repo, capsys):
        lock = json.loads((repo / "package-lock.json").read_text(encoding="utf-8"))
        del lock["packages"]["node_modules/@playwright/test"]
        (repo / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        check_pins.read_package_lock.cache_clear()

        assert check_pins.main() == 1

        assert "does not pin @playwright/test" in capsys.readouterr().err


class TestPackageVersion:
    def test_package_json_out_of_step_fails(self, repo, capsys):
        edit_json(repo / "package.json", version="1.1.0")

        assert check_pins.main() == 1

        err = capsys.readouterr().err
        assert "flown/__init__.py is 1.0.0, package.json 1.1.0" in err
        assert "npm install" in err

    def test_the_top_level_lock_version_out_of_step_fails(self, repo, capsys):
        edit_json(repo / "package-lock.json", version="1.1.0")
        check_pins.read_package_lock.cache_clear()

        assert check_pins.main() == 1

        assert 'package-lock.json "version" 1.1.0' in capsys.readouterr().err

    def test_the_root_package_entry_out_of_step_fails(self, repo, capsys):
        lock = json.loads((repo / "package-lock.json").read_text(encoding="utf-8"))
        lock["packages"][""]["version"] = "1.1.0"
        (repo / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        check_pins.read_package_lock.cache_clear()

        assert check_pins.main() == 1

        assert 'package-lock.json packages[""] 1.1.0' in capsys.readouterr().err

    def test_a_missing_python_version_fails(self, repo, capsys):
        (repo / "flown/__init__.py").write_text("", encoding="utf-8")

        assert check_pins.main() == 1

        assert "declares no __version__" in capsys.readouterr().err

    def test_a_missing_npm_version_fails(self, repo, capsys):
        path = repo / "package.json"
        path.write_text(json.dumps({"name": "flown"}), encoding="utf-8")

        assert check_pins.main() == 1

        assert "package.json declares no version" in capsys.readouterr().err


class TestToolchainVersions:
    def test_a_python_version_file_ahead_of_the_image_fails(self, repo, capsys):
        (repo / ".python-version").write_text("3.15\n", encoding="utf-8")

        assert check_pins.main() == 1

        err = capsys.readouterr().err
        assert (
            "the Dockerfile builds on python:3.14, the version file asks for 3.15"
            in err
        )
        assert 'requires-python is ">=3.14"' in err
        assert 'python_version is "3.14"' in err
        assert 'target-version is "py314"' in err
        assert "Move .python-version, .nvmrc" in err

    def test_one_stage_on_another_python_fails(self, repo, capsys):
        dockerfile = repo / "Dockerfile"
        text = dockerfile.read_text(encoding="utf-8")
        dockerfile.write_text(
            text.replace(
                f"python:{PYTHON}-slim@{DIGEST}\n", f"python:3.13-slim@{DIGEST}\n"
            ),
            encoding="utf-8",
        )

        assert check_pins.main() == 1

        assert "builds on python:3.13" in capsys.readouterr().err

    def test_a_node_image_behind_nvmrc_fails(self, repo, capsys):
        (repo / ".nvmrc").write_text("27.0.0\n", encoding="utf-8")

        assert check_pins.main() == 1

        err = capsys.readouterr().err
        assert "builds on node:26.12.0, the version file asks for 27.0.0" in err
        assert 'package.json engines "node" is ">=26"' in err
        assert 'ask for ">=27"' in err

    def test_a_new_patch_release_moves_the_image_alone(self, repo, capsys):
        (repo / ".nvmrc").write_text("26.12.1\n", encoding="utf-8")

        assert check_pins.main() == 1

        err = capsys.readouterr().err
        assert "builds on node:26.12.0, the version file asks for 26.12.1" in err
        assert "engines" not in err.split("Move ")[0]

    @pytest.mark.parametrize("version", ["26", "26.12", "lts/*"])
    def test_a_node_version_that_is_no_exact_release_fails(self, repo, capsys, version):
        """The gzipped size budgets depend on the zlib of the release."""
        (repo / ".nvmrc").write_text(f"{version}\n", encoding="utf-8")

        assert check_pins.main() == 1

        assert f".nvmrc names Node.js {version}, not an exact release" in (
            capsys.readouterr().err
        )

    def test_a_dockerfile_without_a_node_image_fails(self, repo, capsys):
        dockerfile = repo / "Dockerfile"
        lines = dockerfile.read_text(encoding="utf-8").splitlines(keepends=True)
        dockerfile.write_text("".join(lines[:1] + lines[2:]), encoding="utf-8")

        assert check_pins.main() == 1

        assert "builds on no node image" in capsys.readouterr().err

    def test_a_from_line_with_options_is_read(self, repo, capsys):
        """A multi-arch build adds --platform before the image."""
        dockerfile = repo / "Dockerfile"
        text = dockerfile.read_text(encoding="utf-8")
        dockerfile.write_text(
            text.replace("FROM ", "FROM --platform=$BUILDPLATFORM "), encoding="utf-8"
        )

        assert check_pins.main() == 0

    def test_a_from_line_with_options_on_another_node_fails(self, repo, capsys):
        dockerfile = repo / "Dockerfile"
        text = dockerfile.read_text(encoding="utf-8")
        dockerfile.write_text(
            text.replace(
                f"FROM docker.io/library/node:{NODE}",
                "FROM --platform=$BUILDPLATFORM docker.io/library/node:25",
            ),
            encoding="utf-8",
        )

        assert check_pins.main() == 1

        assert "builds on node:25, the version file asks for" in (
            capsys.readouterr().err
        )

    @pytest.mark.parametrize("file", [".nvmrc", ".python-version"])
    def test_a_missing_version_file_is_a_problem_not_a_crash(self, repo, capsys, file):
        (repo / file).unlink()

        assert check_pins.main() == 1

        assert f"{file} cannot be read" in capsys.readouterr().err

    def test_an_empty_version_file_is_a_problem(self, repo, capsys):
        (repo / ".nvmrc").write_text("\n", encoding="utf-8")

        assert check_pins.main() == 1

        assert ".nvmrc is empty" in capsys.readouterr().err

    def test_missing_engines_fail(self, repo, capsys):
        edit_json(repo / "package.json", engines={})

        assert check_pins.main() == 1

        assert 'package.json engines "node" is "None"' in capsys.readouterr().err


class TestGitleaks:
    """The secrets job runs the gitleaks release the pre-commit hook pins."""

    def test_a_hook_bumped_alone_fails(self, repo, capsys):
        """Dependabot bumps the hook and leaves the image's digest behind."""
        path = repo / ".pre-commit-config.yaml"
        path.write_text(PRE_COMMIT.replace(GITLEAKS, "v8.31.0"), encoding="utf-8")

        assert check_pins.main() == 1

        err = capsys.readouterr().err
        assert f"runs gitleaks {GITLEAKS}, the pre-commit hook pins v8.31.0" in err
        assert "Set GITLEAKS_IMAGE" in err

    def test_a_hook_on_a_tag_is_read(self, repo):
        path = repo / ".pre-commit-config.yaml"
        path.write_text(
            PRE_COMMIT.replace(f"{'cd' * 20} # frozen: {GITLEAKS}", GITLEAKS[1:]),
            encoding="utf-8",
        )

        assert check_pins.main() == 0

    def test_an_image_without_its_release_fails(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        text = path.read_text(encoding="utf-8")
        path.write_text(text.replace(f" # {GITLEAKS}", ""), encoding="utf-8")

        assert check_pins.main() == 1

        assert "names no release in the comment of its gitleaks image" in (
            capsys.readouterr().err
        )

    def test_an_image_without_a_digest_fails(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        text = path.read_text(encoding="utf-8")
        path.write_text(
            text.replace(f"gitleaks@{DIGEST}", f"gitleaks:{GITLEAKS}"),
            encoding="utf-8",
        )

        assert check_pins.main() == 1

        assert "runs no gitleaks image pinned by its digest" in (
            capsys.readouterr().err
        )

    def test_a_config_without_the_hook_fails(self, repo, capsys):
        (repo / ".pre-commit-config.yaml").write_text("repos: []\n", encoding="utf-8")

        assert check_pins.main() == 1

        assert ".pre-commit-config.yaml has no gitleaks hook" in (
            capsys.readouterr().err
        )

    def test_a_missing_config_is_a_problem_not_a_crash(self, repo, capsys):
        (repo / ".pre-commit-config.yaml").unlink()

        assert check_pins.main() == 1

        assert ".pre-commit-config.yaml cannot be read" in capsys.readouterr().err


SETUPTOOLS = "84.0.0"
LOCK = """version = 1
requires-python = ">=3.14"

[[package]]
name = "flown"
source = {{ virtual = "." }}

[[package]]
name = "{name}"
version = "{version}"
source = {{ registry = "https://pypi.org/simple" }}
"""


def write_lock(root, version=SETUPTOOLS, name="setuptools"):
    """A uv.lock that pins one package besides the project."""
    (root / "uv.lock").write_text(
        LOCK.format(name=name, version=version), encoding="utf-8"
    )


@pytest.fixture
def build_repo(repo):
    """The fixture repository with a build system, its group and uv.lock."""
    pyproject = repo / "pyproject.toml"
    pyproject.write_text(
        '[build-system]\nrequires = ["setuptools>=82.0.1"]\n'
        + pyproject.read_text(encoding="utf-8")
        + '[dependency-groups]\nbuild = ["setuptools>=84.0.0"]\n',
        encoding="utf-8",
    )
    write_lock(repo)
    return repo


class TestBuildPins:
    """uv.lock against build-system.requires.

    CI builds the wheel without build isolation, from the build dependency
    group uv.lock pins, so a range in build-system.requires that the pin no
    longer meets would build with the old setuptools while claiming the new
    one. Dependabot raises both ranges together; a range raised by hand may
    not. These tests add a build system to the passing fixture repository.
    """

    def test_a_satisfied_build_pin_passes(self, build_repo):
        assert check_pins.main() == 0

    def test_a_build_pin_below_the_requirement_fails(self, build_repo, capsys):
        write_lock(build_repo, "80.0.0")

        assert check_pins.main() == 1
        err = capsys.readouterr().err
        assert (
            "uv.lock pins setuptools==80.0.0, build-system.requires asks for "
            '"setuptools>=82.0.1"'
        ) in err
        assert "then run `uv lock`" in err

    def test_every_version_of_a_split_pin_is_checked(self, build_repo, capsys):
        """uv.lock pins a package twice where markers resolve it apart."""
        lock = build_repo / "uv.lock"
        lock.write_text(
            lock.read_text(encoding="utf-8")
            + '\n[[package]]\nname = "setuptools"\nversion = "80.0.0"\n',
            encoding="utf-8",
        )

        assert check_pins.main() == 1
        err = capsys.readouterr().err
        assert "uv.lock pins setuptools==80.0.0" in err
        assert f"setuptools=={SETUPTOOLS}" not in err

    def test_a_lock_without_setuptools_fails(self, build_repo, capsys):
        write_lock(build_repo, name="wheel")

        assert check_pins.main() == 1
        assert "uv.lock does not pin setuptools" in capsys.readouterr().err

    def test_a_build_requirement_left_out_of_the_group_fails(self, build_repo, capsys):
        pyproject = build_repo / "pyproject.toml"
        text = pyproject.read_text(encoding="utf-8")
        pyproject.write_text(
            text.replace('build = ["setuptools>=84.0.0"]\n', ""), encoding="utf-8"
        )

        assert check_pins.main() == 1
        assert (
            "the build dependency group of pyproject.toml does not ask for "
            "setuptools, "
            "which build-system.requires does"
        ) in capsys.readouterr().err

    def test_a_name_is_matched_regardless_of_its_spelling(self, build_repo):
        """uv.lock normalises names; build-system.requires may not."""
        pyproject = build_repo / "pyproject.toml"
        text = pyproject.read_text(encoding="utf-8")
        pyproject.write_text(
            text.replace(
                'requires = ["setuptools>=82.0.1"]', 'requires = ["SetupTools>=82.0.1"]'
            ),
            encoding="utf-8",
        )

        assert check_pins.main() == 0

    def test_a_missing_lock_fails(self, build_repo, capsys):
        (build_repo / "uv.lock").unlink()

        assert check_pins.main() == 1
        assert "uv.lock is missing" in capsys.readouterr().err

    def test_a_requirement_for_another_platform_is_skipped(self, build_repo):
        """The build here never installs it, so uv.lock need not pin it."""
        pyproject = build_repo / "pyproject.toml"
        text = pyproject.read_text(encoding="utf-8")
        tomli = "\"tomli>=2; python_version < '3.11'\""
        pyproject.write_text(
            text.replace(
                'requires = ["setuptools>=82.0.1"]',
                f'requires = ["setuptools>=82.0.1", {tomli}]',
            ),
            encoding="utf-8",
        )

        assert check_pins.main() == 0

    def test_an_included_group_is_no_requirement(self, build_repo):
        """{include-group = ...} names no package of its own."""
        pyproject = build_repo / "pyproject.toml"
        text = pyproject.read_text(encoding="utf-8")
        pyproject.write_text(
            text.replace(
                'build = ["setuptools>=84.0.0"]',
                'build = ["setuptools>=84.0.0", {include-group = "other"}]\nother = []',
            ),
            encoding="utf-8",
        )

        assert check_pins.main() == 0


class TestAgainstTheRealRepository:
    def test_the_checked_in_files_pass(self, capsys):
        """The repository itself is consistent, the way the CI job checks it."""
        check_pins.read_package_lock.cache_clear()

        assert check_pins.main() == 0

        check_pins.read_package_lock.cache_clear()
