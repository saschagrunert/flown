"""Tests for scripts/check_locks.py.

The script is a CI gate: it is the thing that notices when the lock files,
the Playwright image and the package version drift apart. A gate that
silently stops checking fails open, and every check below therefore starts
from a consistent fixture repository and breaks exactly one thing.
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent / "scripts" / "check_locks.py"


def _load_module():
    """Import check_locks.py, which lives outside any package."""
    spec = importlib.util.spec_from_file_location("check_locks", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


check_locks = _load_module()

VERSION = "1.0.0"
RUFF = "0.16.4"
PIP_TOOLS = "7.6.1"
PLAYWRIGHT = "1.63.0"
DIGEST = "sha256:" + "ab" * 32
IMAGE = f"mcr.microsoft.com/playwright:v{PLAYWRIGHT}-noble@{DIGEST}"
PYTHON = "3.14"
NODE = "26"
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
        f"FROM docker.io/library/node:{NODE}-slim@{DIGEST} AS js-builder\n"
        f"FROM docker.io/library/python:{PYTHON}-slim@{DIGEST} AS package\n"
        f"FROM docker.io/library/python:{PYTHON}-slim@{DIGEST}\n",
        encoding="utf-8",
    )
    (tmp_path / "requirements.lock").write_text(
        "lxml==6.0.2 \\\n    --hash=sha256:abc\n", encoding="utf-8"
    )
    (tmp_path / "requirements-test.lock").write_text(
        "lxml==6.0.2 \\\n    --hash=sha256:abc\n"
        "pytest==9.0.2 \\\n    --hash=sha256:def\n"
        f"ruff=={RUFF} \\\n    --hash=sha256:ghi\n",
        encoding="utf-8",
    )
    (tmp_path / "requirements-tools.in").write_text(
        f"# The pip-tools of make lock\npip-tools=={PIP_TOOLS}\n", encoding="utf-8"
    )
    (tmp_path / "requirements-tools.lock").write_text(
        "click==8.5.0 \\\n    --hash=sha256:abc\n"
        f"pip-tools=={PIP_TOOLS} \\\n    --hash=sha256:def\n",
        encoding="utf-8",
    )
    (tmp_path / "package.json").write_text(
        json.dumps(
            {
                "name": "flown",
                "version": VERSION,
                "engines": {"node": f">={NODE}"},
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
    workflow.mkdir(parents=True)
    (workflow / "test.yml").write_text(
        f"      image: {IMAGE}\n",
        encoding="utf-8",
    )
    # The documents that quote the image for the visual tests
    for name in check_locks.PLAYWRIGHT_IMAGE_DOCS:
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

    monkeypatch.setattr(check_locks, "ROOT", tmp_path)
    check_locks.read_package_lock.cache_clear()
    yield tmp_path
    check_locks.read_package_lock.cache_clear()


def edit_json(path: Path, **changes):
    """Rewrite selected top-level keys of a JSON file."""
    data = json.loads(path.read_text(encoding="utf-8"))
    data.update(changes)
    path.write_text(json.dumps(data), encoding="utf-8")


class TestPassingRepository:
    def test_reports_success(self, repo, capsys):
        assert check_locks.main() == 0

        captured = capsys.readouterr()
        assert "satisfy pyproject.toml" in captured.out
        assert captured.err == ""


class TestLockFiles:
    def test_a_pin_below_the_requirement_fails(self, repo, capsys):
        (repo / "requirements.lock").write_text("lxml==6.0.1\n", encoding="utf-8")

        assert check_locks.main() == 1

        err = capsys.readouterr().err
        assert "requirements.lock pins lxml==6.0.1" in err
        assert "make lock" in err

    def test_a_missing_pin_fails(self, repo, capsys):
        (repo / "requirements.lock").write_text("", encoding="utf-8")

        assert check_locks.main() == 1

        assert "requirements.lock does not pin lxml" in capsys.readouterr().err

    def test_a_missing_tool_pin_fails(self, repo, capsys):
        text = (repo / "requirements-test.lock").read_text(encoding="utf-8")
        (repo / "requirements-test.lock").write_text(
            text.replace(f"ruff=={RUFF} \\\n    --hash=sha256:ghi\n", ""),
            encoding="utf-8",
        )

        assert check_locks.main() == 1

        assert "requirements-test.lock does not pin ruff" in capsys.readouterr().err

    def test_the_two_locks_disagreeing_fails(self, repo, capsys):
        """CI installs requirements-test.lock alone where it needs both."""
        (repo / "requirements.lock").write_text("lxml==6.0.3\n", encoding="utf-8")

        assert check_locks.main() == 1

        assert (
            "requirements.lock pins lxml==6.0.3, requirements-test.lock lxml==6.0.2"
            in capsys.readouterr().err
        )

    def test_a_requirement_for_another_platform_is_skipped(self, repo):
        (repo / "pyproject.toml").write_text(
            f'[project]\nrequires-python = ">={PYTHON}"\n'
            'dependencies = ["lxml>=6.0.2", "pywin32>=1; sys_platform == \'win32\'"]\n'
            "[project.optional-dependencies]\n"
            'test = ["pytest>=9.0.2"]\n'
            f'dev = ["ruff>={RUFF}"]\n' + TOOLCHAIN,
            encoding="utf-8",
        )

        assert check_locks.main() == (0 if sys.platform != "win32" else 1)

    def test_a_pin_is_matched_regardless_of_name_spelling(self, repo):
        """pip-compile normalises names; the requirement may not be normalised."""
        (repo / "pyproject.toml").write_text(
            f'[project]\nrequires-python = ">={PYTHON}"\n'
            'dependencies = ["LXML>=6.0.2"]\n'
            "[project.optional-dependencies]\n"
            'test = ["pytest>=9.0.2"]\n'
            f'dev = ["ruff>={RUFF}"]\n' + TOOLCHAIN,
            encoding="utf-8",
        )

        assert check_locks.main() == 0


class TestToolsLock:
    """make lock installs pip-tools from requirements-tools.lock, so the lock
    has to pin what the .in file asks for."""

    def test_a_pin_other_than_the_input_fails(self, repo, capsys):
        (repo / "requirements-tools.in").write_text(
            "pip-tools==7.7.0\n", encoding="utf-8"
        )

        assert check_locks.main() == 1

        err = capsys.readouterr().err
        assert (
            f"requirements-tools.lock pins pip-tools=={PIP_TOOLS}, "
            'requirements-tools.in asks for "pip-tools==7.7.0"'
        ) in err
        assert "requirements-tools.lock." in err

    def test_a_lock_without_pip_tools_fails(self, repo, capsys):
        (repo / "requirements-tools.lock").write_text(
            "click==8.5.0 \\\n    --hash=sha256:abc\n", encoding="utf-8"
        )

        assert check_locks.main() == 1

        assert "requirements-tools.lock does not pin pip-tools" in (
            capsys.readouterr().err
        )

    @pytest.mark.parametrize(
        "name", ["requirements-tools.in", "requirements-tools.lock"]
    )
    def test_a_missing_file_fails(self, repo, capsys, name):
        (repo / name).unlink()

        assert check_locks.main() == 1

        assert f"{name} is missing" in capsys.readouterr().err


class TestPlaywrightImage:
    def test_an_image_ahead_of_the_library_fails(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8").replace(
                f"v{PLAYWRIGHT}-noble", "v1.70.0-noble"
            ),
            encoding="utf-8",
        )

        assert check_locks.main() == 1

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

        assert check_locks.main() == 1

        assert "by its @sha256 digest" in capsys.readouterr().err

    def test_a_malformed_digest_is_no_digest(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8").replace(DIGEST, "sha256:abc"),
            encoding="utf-8",
        )

        assert check_locks.main() == 1

        assert "by its @sha256 digest" in capsys.readouterr().err

    def test_a_second_job_on_the_same_image_passes(self, repo):
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8") + f"      image: {IMAGE}\n",
            encoding="utf-8",
        )

        assert check_locks.main() == 0

    def test_a_second_job_on_another_image_fails(self, repo, capsys):
        """The e2e jobs run in the image as well; one left behind on a bump
        would test other browsers than the visual job without a word."""
        stale = f"mcr.microsoft.com/playwright:v1.62.0-noble@{DIGEST}"
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8") + f"      image: {stale}\n",
            encoding="utf-8",
        )

        assert check_locks.main() == 1

        err = capsys.readouterr().err
        assert f"runs different Playwright images: {IMAGE}, {stale}" in err
        assert "runs the Playwright image v1.62.0, package-lock.json pins" in err

    def test_a_document_quoting_the_same_image_passes(self, repo):
        (repo / "CONTRIBUTING.md").write_text(
            f"Build it first.\n\n```sh\npodman run {IMAGE} npx playwright "
            "test --project=visual\n```\n",
            encoding="utf-8",
        )

        assert check_locks.main() == 0

    @pytest.mark.parametrize("name", check_locks.PLAYWRIGHT_IMAGE_DOCS)
    def test_a_missing_document_fails(self, repo, capsys, name):
        # A document moved or renamed left its command unchecked
        (repo / name).unlink()

        assert check_locks.main() == 1

        assert f"{name} is missing" in capsys.readouterr().err

    @pytest.mark.parametrize("name", check_locks.PLAYWRIGHT_IMAGE_DOCS)
    def test_a_document_quoting_no_image_fails(self, repo, capsys, name):
        (repo / name).write_text("See the testing guide.\n", encoding="utf-8")

        assert check_locks.main() == 1

        assert f"{name} quotes no Playwright image" in capsys.readouterr().err

    def test_a_document_quoting_another_image_fails(self, repo, capsys):
        stale = f"mcr.microsoft.com/playwright:v{PLAYWRIGHT}-noble"
        doc = repo / "doc/development/testing.md"
        doc.write_text(
            f"Run `podman run {stale} npx playwright test`.\n", encoding="utf-8"
        )

        assert check_locks.main() == 1

        assert (
            f"doc/development/testing.md quotes the Playwright image {stale}, "
            f".github/workflows/test.yml runs {IMAGE}"
        ) in capsys.readouterr().err

    def test_a_workflow_without_the_image_fails(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text("jobs:\n", encoding="utf-8")

        assert check_locks.main() == 1

        assert "runs no Playwright image" in capsys.readouterr().err

    def test_an_unpinned_library_fails(self, repo, capsys):
        lock = json.loads((repo / "package-lock.json").read_text(encoding="utf-8"))
        del lock["packages"]["node_modules/@playwright/test"]
        (repo / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        check_locks.read_package_lock.cache_clear()

        assert check_locks.main() == 1

        assert "does not pin @playwright/test" in capsys.readouterr().err


class TestPackageVersion:
    def test_package_json_out_of_step_fails(self, repo, capsys):
        edit_json(repo / "package.json", version="1.1.0")

        assert check_locks.main() == 1

        err = capsys.readouterr().err
        assert "flown/__init__.py is 1.0.0, package.json 1.1.0" in err
        assert "npm install" in err

    def test_the_top_level_lock_version_out_of_step_fails(self, repo, capsys):
        edit_json(repo / "package-lock.json", version="1.1.0")
        check_locks.read_package_lock.cache_clear()

        assert check_locks.main() == 1

        assert 'package-lock.json "version" 1.1.0' in capsys.readouterr().err

    def test_the_root_package_entry_out_of_step_fails(self, repo, capsys):
        lock = json.loads((repo / "package-lock.json").read_text(encoding="utf-8"))
        lock["packages"][""]["version"] = "1.1.0"
        (repo / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        check_locks.read_package_lock.cache_clear()

        assert check_locks.main() == 1

        assert 'package-lock.json packages[""] 1.1.0' in capsys.readouterr().err

    def test_a_missing_python_version_fails(self, repo, capsys):
        (repo / "flown/__init__.py").write_text("", encoding="utf-8")

        assert check_locks.main() == 1

        assert "declares no __version__" in capsys.readouterr().err

    def test_a_missing_npm_version_fails(self, repo, capsys):
        path = repo / "package.json"
        path.write_text(json.dumps({"name": "flown"}), encoding="utf-8")

        assert check_locks.main() == 1

        assert "package.json declares no version" in capsys.readouterr().err


class TestToolchainVersions:
    def test_a_python_version_file_ahead_of_the_image_fails(self, repo, capsys):
        (repo / ".python-version").write_text("3.15\n", encoding="utf-8")

        assert check_locks.main() == 1

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

        assert check_locks.main() == 1

        assert "builds on python:3.13" in capsys.readouterr().err

    def test_a_node_image_behind_nvmrc_fails(self, repo, capsys):
        (repo / ".nvmrc").write_text("27\n", encoding="utf-8")

        assert check_locks.main() == 1

        err = capsys.readouterr().err
        assert "builds on node:26, the version file asks for 27" in err
        assert 'package.json engines "node" is ">=26"' in err

    def test_a_dockerfile_without_a_node_image_fails(self, repo, capsys):
        dockerfile = repo / "Dockerfile"
        lines = dockerfile.read_text(encoding="utf-8").splitlines(keepends=True)
        dockerfile.write_text("".join(lines[1:]), encoding="utf-8")

        assert check_locks.main() == 1

        assert "builds on no node image" in capsys.readouterr().err

    def test_a_from_line_with_options_is_read(self, repo, capsys):
        """A multi-arch build adds --platform before the image."""
        dockerfile = repo / "Dockerfile"
        text = dockerfile.read_text(encoding="utf-8")
        dockerfile.write_text(
            text.replace("FROM ", "FROM --platform=$BUILDPLATFORM "), encoding="utf-8"
        )

        assert check_locks.main() == 0

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

        assert check_locks.main() == 1

        assert "builds on node:25, the version file asks for" in (
            capsys.readouterr().err
        )

    @pytest.mark.parametrize("file", [".nvmrc", ".python-version"])
    def test_a_missing_version_file_is_a_problem_not_a_crash(self, repo, capsys, file):
        (repo / file).unlink()

        assert check_locks.main() == 1

        assert f"{file} cannot be read" in capsys.readouterr().err

    def test_an_empty_version_file_is_a_problem(self, repo, capsys):
        (repo / ".nvmrc").write_text("\n", encoding="utf-8")

        assert check_locks.main() == 1

        assert ".nvmrc is empty" in capsys.readouterr().err

    def test_missing_engines_fail(self, repo, capsys):
        edit_json(repo / "package.json", engines={})

        assert check_locks.main() == 1

        assert 'package.json engines "node" is "None"' in capsys.readouterr().err


class TestAgainstTheRealRepository:
    def test_the_checked_in_files_pass(self, capsys):
        """The repository itself is consistent, the way the CI job checks it."""
        check_locks.read_package_lock.cache_clear()

        assert check_locks.main() == 0

        check_locks.read_package_lock.cache_clear()
