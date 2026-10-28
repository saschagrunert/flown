"""Tests for scripts/check_pins.py.

The script is a CI gate: it is the thing that notices when the build pin,
the uv releases, the Playwright and gitleaks images, the package version and
the toolchain versions drift apart. A gate that
silently stops checking fails open, and every check below therefore starts
from a consistent fixture repository and breaks exactly one thing.
"""

import email.message
import http.client
import importlib.util
import io
import json
import sys
import urllib.error
from datetime import UTC, date, datetime
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
GITLEAKS_IMAGE = f"ghcr.io/gitleaks/gitleaks:{GITLEAKS}@{DIGEST}"
# The steps of the workflow that read the two image files
WORKFLOW = (
    "      - run: |\n"
    "          image=$(sed -n 's/^FROM //p' .github/images/playwright/Dockerfile)\n"
    "      - run: |\n"
    "          image=$(sed -n 's/^FROM //p' .github/images/gitleaks/Dockerfile)\n"
)
# The command of the documents, which reads the Playwright image file
DOC_COMMAND = (
    "```sh\npodman run \"$(sed -n 's/^FROM //p' "
    '.github/images/playwright/Dockerfile)" npx playwright test\n```\n'
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
    (workflow / "test.yml").write_text(WORKFLOW, encoding="utf-8")
    for dockerfile, image in (
        (check_pins.PLAYWRIGHT_DOCKERFILE, IMAGE),
        (check_pins.GITLEAKS_DOCKERFILE, GITLEAKS_IMAGE),
    ):
        path = tmp_path / dockerfile
        path.parent.mkdir(parents=True)
        path.write_text(f"# The image of a job\nFROM {image}\n", encoding="utf-8")
    (tmp_path / ".pre-commit-config.yaml").write_text(PRE_COMMIT, encoding="utf-8")
    # The documents that run the image for the visual tests
    for name in check_pins.PLAYWRIGHT_IMAGE_DOCS:
        doc = tmp_path / name
        doc.parent.mkdir(parents=True, exist_ok=True)
        doc.write_text(DOC_COMMAND, encoding="utf-8")
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


class TestUvRequirement:
    """--uv-requirement hands the uv release to pip-audit in the security
    job, which reads it from the action of the head and of the base."""

    def test_prints_the_release_of_the_action(self, repo, capsys):
        assert check_pins.main(["--uv-requirement"]) == 0

        assert capsys.readouterr().out == f"uv=={UV}\n"

    def test_reads_a_copy_of_the_action(self, repo, tmp_path, capsys):
        copy = tmp_path / "base-action.yml"
        copy.write_text(ACTION.format(uv="0.12.9"), encoding="utf-8")

        assert check_pins.main(["--uv-requirement", str(copy)]) == 0

        assert capsys.readouterr().out == "uv==0.12.9\n"

    def test_checks_nothing_else(self, repo, capsys):
        """The security job runs it on a base whose other pins may be stale."""
        dockerfile = repo / "Dockerfile"
        edit(dockerfile, f"uv:{UV}@", "uv:0.14.0@")

        assert check_pins.main(["--uv-requirement"]) == 0

        assert capsys.readouterr().err == ""

    def test_an_action_without_a_version_fails(self, repo, capsys):
        """An empty requirement would have pip-audit audit nothing."""
        edit(repo / check_pins.UV_ACTION, f'        version: "{UV}"\n', "")

        assert check_pins.main(["--uv-requirement"]) == 1

        captured = capsys.readouterr()
        assert captured.out == ""
        assert "installs no uv release by version" in captured.err

    def test_a_missing_action_fails(self, repo, tmp_path, capsys):
        assert check_pins.main(["--uv-requirement", str(tmp_path / "gone.yml")]) == 1

        captured = capsys.readouterr()
        assert captured.out == ""
        assert "gone.yml cannot be read" in captured.err


def edit(path: Path, old: str, new: str):
    """Replace text in a file of the fixture repository."""
    path.write_text(
        path.read_text(encoding="utf-8").replace(old, new), encoding="utf-8"
    )


class TestPlaywrightImage:
    def test_an_image_ahead_of_the_library_fails(self, repo, capsys):
        edit(
            repo / check_pins.PLAYWRIGHT_DOCKERFILE,
            f"v{PLAYWRIGHT}-noble",
            "v1.70.0-noble",
        )
        for name in check_pins.PLAYWRIGHT_IMAGE_DOCS:
            (repo / name).write_text(DOC_COMMAND, encoding="utf-8")

        assert check_pins.main() == 1

        err = capsys.readouterr().err
        assert (
            "names the Playwright image v1.70.0, package-lock.json pins 1.63.0" in err
        )
        assert "check_pins.py --fix" in err

    def test_an_image_without_a_digest_fails(self, repo, capsys):
        edit(repo / check_pins.PLAYWRIGHT_DOCKERFILE, f"@{DIGEST}", "")

        assert check_pins.main() == 1

        assert "by its @sha256 digest" in capsys.readouterr().err

    def test_a_malformed_digest_is_no_digest(self, repo, capsys):
        edit(repo / check_pins.PLAYWRIGHT_DOCKERFILE, DIGEST, "sha256:abc")

        assert check_pins.main() == 1

        assert "by its @sha256 digest" in capsys.readouterr().err

    def test_a_second_image_in_the_file_fails(self, repo, capsys):
        path = repo / check_pins.PLAYWRIGHT_DOCKERFILE
        path.write_text(
            path.read_text(encoding="utf-8") + f"FROM {IMAGE}\n", encoding="utf-8"
        )

        assert check_pins.main() == 1

        assert "has 2 FROM lines, not the one image" in capsys.readouterr().err

    def test_a_missing_file_is_a_problem_not_a_crash(self, repo, capsys):
        (repo / check_pins.PLAYWRIGHT_DOCKERFILE).unlink()

        assert check_pins.main() == 1

        assert f"{check_pins.PLAYWRIGHT_DOCKERFILE} cannot be read" in (
            capsys.readouterr().err
        )

    def test_a_workflow_naming_the_image_itself_fails(self, repo, capsys):
        """A second place to bump, which Dependabot and --fix do not know"""
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8") + f"      image: {IMAGE}\n",
            encoding="utf-8",
        )

        assert check_pins.main() == 1

        assert f"names the image {IMAGE} itself instead of reading" in (
            capsys.readouterr().err
        )

    def test_a_workflow_not_reading_the_file_fails(self, repo, capsys):
        (repo / ".github/workflows/test.yml").write_text("jobs:\n", encoding="utf-8")

        assert check_pins.main() == 1

        assert (
            f"does not read its image from {check_pins.PLAYWRIGHT_DOCKERFILE}"
            in capsys.readouterr().err
        )

    def test_a_document_quoting_the_same_image_passes(self, repo):
        (repo / "CONTRIBUTING.md").write_text(
            DOC_COMMAND + f"\nIt is `{IMAGE}` today.\n", encoding="utf-8"
        )

        assert check_pins.main() == 0

    @pytest.mark.parametrize("name", check_pins.PLAYWRIGHT_IMAGE_DOCS)
    def test_a_missing_document_fails(self, repo, capsys, name):
        # A document moved or renamed left its command unchecked
        (repo / name).unlink()

        assert check_pins.main() == 1

        assert f"{name} is missing" in capsys.readouterr().err

    @pytest.mark.parametrize("name", check_pins.PLAYWRIGHT_IMAGE_DOCS)
    def test_a_document_not_running_the_file_fails(self, repo, capsys, name):
        (repo / name).write_text("See the testing guide.\n", encoding="utf-8")

        assert check_pins.main() == 1

        assert (
            f"{name} does not run the image of {check_pins.PLAYWRIGHT_DOCKERFILE}"
            in capsys.readouterr().err
        )

    def test_a_document_quoting_another_image_fails(self, repo, capsys):
        stale = f"mcr.microsoft.com/playwright:v{PLAYWRIGHT}-noble"
        doc = repo / "doc/development/testing.md"
        doc.write_text(DOC_COMMAND + f"Or `podman run {stale}`.\n", encoding="utf-8")

        assert check_pins.main() == 1

        assert (
            f"doc/development/testing.md quotes the Playwright image {stale}, "
            f"{check_pins.PLAYWRIGHT_DOCKERFILE} names {IMAGE}"
        ) in capsys.readouterr().err

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
        """A hand edit of the hook leaves the image behind."""
        path = repo / ".pre-commit-config.yaml"
        path.write_text(PRE_COMMIT.replace(GITLEAKS, "v8.31.0"), encoding="utf-8")

        assert check_pins.main() == 1

        err = capsys.readouterr().err
        assert f"runs gitleaks {GITLEAKS}, the pre-commit hook pins v8.31.0" in err
        assert f"Set the image of {check_pins.GITLEAKS_DOCKERFILE}" in err

    def test_a_hook_on_a_tag_is_read(self, repo):
        path = repo / ".pre-commit-config.yaml"
        path.write_text(
            PRE_COMMIT.replace(f"{'cd' * 20} # frozen: {GITLEAKS}", GITLEAKS[1:]),
            encoding="utf-8",
        )

        assert check_pins.main() == 0

    def test_an_image_without_a_digest_fails(self, repo, capsys):
        edit(repo / check_pins.GITLEAKS_DOCKERFILE, f"@{DIGEST}", "")

        assert check_pins.main() == 1

        assert "by its tag and @sha256 digest" in capsys.readouterr().err

    def test_an_image_by_its_digest_alone_fails(self, repo, capsys):
        """Without its tag the release cannot be compared with the hook's"""
        edit(repo / check_pins.GITLEAKS_DOCKERFILE, f":{GITLEAKS}@", "@")

        assert check_pins.main() == 1

        assert "by its tag and @sha256 digest" in capsys.readouterr().err

    def test_a_workflow_naming_the_image_itself_fails(self, repo, capsys):
        path = repo / ".github/workflows/test.yml"
        path.write_text(
            path.read_text(encoding="utf-8")
            + f"          GITLEAKS_IMAGE: {GITLEAKS_IMAGE}\n",
            encoding="utf-8",
        )

        assert check_pins.main() == 1

        assert f"names the image {GITLEAKS_IMAGE} itself" in capsys.readouterr().err

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


NOW = datetime(2026, 10, 27, 12, tzinfo=UTC)


def uv_settings(window, **entries):
    """The [tool.uv] table of pyproject.toml as tomllib reads it"""
    uv = {"exclude-newer": window}
    if entries:
        uv["exclude-newer-package"] = entries
    return {"tool": {"uv": uv}}


class TestExcludeNewer:
    """An exclude-newer-package entry the global cutoff has passed holds its
    package back for good, without an error anywhere."""

    def test_an_entry_younger_than_the_cutoff_passes(self):
        settings = uv_settings("7 days", certifi="2026-10-21T00:00:00Z")

        assert check_pins.exclude_newer_mismatches(settings, NOW) == []

    def test_an_entry_the_cutoff_has_passed_fails(self):
        settings = uv_settings("7 days", setuptools="2026-10-20T00:00:00Z")

        problems = check_pins.exclude_newer_mismatches(settings, NOW)

        assert len(problems) == 1
        assert "holds setuptools at 2026-10-20T00:00:00Z" in problems[0]
        assert "now 2026-10-20 12:00 UTC" in problems[0]

    @pytest.mark.parametrize(
        "window", ["7 days", "1 week", "168 hours", "P7D", "P1W", "PT168H"]
    )
    def test_every_spelling_of_the_span_is_read(self, window):
        settings = uv_settings(window, a="2026-10-20T11:00:00Z", b="2026-10-20T13:00Z")

        problems = check_pins.exclude_newer_mismatches(settings, NOW)

        assert [problem.split(" at ")[0] for problem in problems] == [
            "pyproject.toml: exclude-newer-package holds a"
        ]

    def test_a_cutoff_given_as_a_date_is_read(self):
        settings = uv_settings("2026-10-22", old="2026-10-21", new="2026-10-23")

        problems = check_pins.exclude_newer_mismatches(settings, NOW)

        assert len(problems) == 1
        assert "holds old" in problems[0]

    def test_toml_dates_are_read_as_their_strings(self):
        """exclude-newer = 2026-10-22 without quotes is a TOML date"""
        settings = uv_settings(
            date(2026, 10, 22),
            old=datetime(2026, 10, 21, tzinfo=UTC),
            new=date(2026, 10, 23),
        )

        problems = check_pins.exclude_newer_mismatches(settings, NOW)

        assert len(problems) == 1
        assert "holds old at 2026-10-21T00:00:00+00:00" in problems[0]

    def test_an_entry_without_a_date_is_left_alone(self):
        settings = uv_settings("7 days", pip=False)

        assert check_pins.exclude_newer_mismatches(settings, NOW) == []

    def test_no_global_cutoff_checks_nothing(self):
        settings = {"tool": {"uv": {"exclude-newer-package": {"a": "2020-01-01"}}}}

        assert check_pins.exclude_newer_mismatches(settings, NOW) == []

    def test_an_unreadable_cutoff_fails(self):
        settings = uv_settings("a while", a="2026-10-21")

        assert check_pins.exclude_newer_mismatches(settings, NOW) == [
            'pyproject.toml: [tool.uv] exclude-newer "a while" cannot be read'
        ]

    def test_an_unreadable_entry_fails(self):
        settings = uv_settings("7 days", a="next week")

        assert check_pins.exclude_newer_mismatches(settings, NOW) == [
            'pyproject.toml: exclude-newer-package "a = next week" cannot be read'
        ]

    def test_main_fails_on_a_passed_entry(self, repo, capsys):
        path = repo / "pyproject.toml"
        path.write_text(
            path.read_text(encoding="utf-8")
            + '[tool.uv]\nexclude-newer = "7 days"\n'
            + 'exclude-newer-package = { certifi = "2020-01-01T00:00:00Z" }\n',
            encoding="utf-8",
        )

        assert check_pins.main() == 1

        err = capsys.readouterr().err
        assert "holds certifi at 2020-01-01T00:00:00Z" in err
        assert "Remove the exclude-newer-package entries" in err
        # The removal changes nothing else: `make lock` moved every package
        assert "then run `uv lock`, which keeps every pin" in err


NEW_DIGEST = "sha256:" + "cd" * 32


class FakeResponse:
    """What urlopen returns, as a context manager"""

    def __init__(self, headers=None, body=b""):
        self.headers = headers or {}
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self, *_):
        return self.body


def http_error(url, code, headers=None):
    message = email.message.Message()
    for name, value in (headers or {}).items():
        message[name] = value
    return urllib.error.HTTPError(url, code, "error", message, io.BytesIO())


class TestRegistryDigest:
    """The digest of a tag, asked of its registry without credentials."""

    def test_a_registry_without_tokens_answers_at_once(self, monkeypatch):
        calls = []

        def urlopen(request, timeout):
            calls.append((request.full_url, request.get_method()))
            assert "application/vnd.oci.image.index.v1+json" in request.get_header(
                "Accept"
            )
            return FakeResponse({"Docker-Content-Digest": NEW_DIGEST})

        monkeypatch.setattr(check_pins.urllib.request, "urlopen", urlopen)

        assert (
            check_pins.registry_digest("mcr.microsoft.com/playwright:v1.64.0-noble")
            == NEW_DIGEST
        )
        assert calls == [
            ("https://mcr.microsoft.com/v2/playwright/manifests/v1.64.0-noble", "HEAD")
        ]

    def test_a_registry_that_wants_a_token_gets_one(self, monkeypatch):
        challenge = (
            'Bearer realm="https://ghcr.io/token",service="ghcr.io",'
            'scope="repository:gitleaks/gitleaks:pull"'
        )
        calls = []

        def urlopen(request, timeout):
            url = request if isinstance(request, str) else request.full_url
            calls.append(url)
            if isinstance(request, str):
                return FakeResponse(body=b'{"token": "anonymous"}')
            if request.get_header("Authorization") != "Bearer anonymous":
                raise http_error(url, 401, {"WWW-Authenticate": challenge})
            return FakeResponse({"Docker-Content-Digest": NEW_DIGEST})

        monkeypatch.setattr(check_pins.urllib.request, "urlopen", urlopen)

        assert check_pins.registry_digest(f"ghcr.io/gitleaks/gitleaks:{GITLEAKS}") == (
            NEW_DIGEST
        )
        assert calls[1] == (
            "https://ghcr.io/token?service=ghcr.io&"
            "scope=repository%3Agitleaks%2Fgitleaks%3Apull"
        )

    def test_docker_hub_is_asked_at_its_registry_host(self, monkeypatch):
        urls = []

        def urlopen(request, timeout):
            urls.append(request.full_url)
            return FakeResponse({"Docker-Content-Digest": NEW_DIGEST})

        monkeypatch.setattr(check_pins.urllib.request, "urlopen", urlopen)

        check_pins.registry_digest("docker.io/library/node:26.12.1-slim")

        assert urls == [
            "https://registry-1.docker.io/v2/library/node/manifests/26.12.1-slim"
        ]

    def test_an_unknown_tag_is_a_lookup_error(self, monkeypatch):
        def urlopen(request, timeout):
            raise http_error(request.full_url, 404)

        monkeypatch.setattr(check_pins.urllib.request, "urlopen", urlopen)

        with pytest.raises(LookupError, match="has no"):
            check_pins.registry_digest("mcr.microsoft.com/playwright:v9.9.9-noble")

    @pytest.mark.parametrize(
        ("challenge", "token", "message"),
        [
            ('Bearer realm="http://ghcr.io/token"', b"{}", "asks for a token from"),
            ('Bearer realm="https://ghcr.io/token"', b"{}", "handed out no token"),
        ],
    )
    def test_a_token_that_cannot_be_had_is_an_os_error(
        self, monkeypatch, challenge, token, message
    ):
        def urlopen(request, timeout):
            if isinstance(request, str):
                return FakeResponse(body=token)
            raise http_error(request.full_url, 401, {"WWW-Authenticate": challenge})

        monkeypatch.setattr(check_pins.urllib.request, "urlopen", urlopen)

        with pytest.raises(OSError, match=message):
            check_pins.registry_digest(f"ghcr.io/gitleaks/gitleaks:{GITLEAKS}")

    def test_an_answer_without_a_digest_is_an_os_error(self, monkeypatch):
        monkeypatch.setattr(
            check_pins.urllib.request,
            "urlopen",
            lambda request, timeout: FakeResponse(),
        )

        with pytest.raises(OSError, match="without a Docker-Content-Digest"):
            check_pins.registry_digest("mcr.microsoft.com/playwright:v1.64.0-noble")

    def test_a_server_error_is_an_os_error(self, monkeypatch):
        def urlopen(request, timeout):
            raise http_error(request.full_url, 503)

        monkeypatch.setattr(check_pins.urllib.request, "urlopen", urlopen)

        with pytest.raises(OSError, match="answered 503"):
            check_pins.registry_digest("mcr.microsoft.com/playwright:v1.64.0-noble")

    def test_a_token_service_without_the_page_is_an_os_error(self, monkeypatch):
        """A 404 of the token service says nothing of the tag"""
        challenge = 'Bearer realm="https://ghcr.io/token",service="ghcr.io"'

        def urlopen(request, timeout):
            if isinstance(request, str):
                raise http_error(request, 404)
            raise http_error(request.full_url, 401, {"WWW-Authenticate": challenge})

        monkeypatch.setattr(check_pins.urllib.request, "urlopen", urlopen)

        with pytest.raises(OSError, match=r"token.* answered 404"):
            check_pins.registry_digest(f"ghcr.io/gitleaks/gitleaks:{GITLEAKS}")

    @pytest.mark.parametrize("cut_short", [False, True])
    def test_an_answer_that_cannot_be_read_is_an_os_error(self, monkeypatch, cut_short):
        """A token answer that is no JSON, or one cut short: a warning in
        main like an unreachable registry, not a traceback"""
        challenge = 'Bearer realm="https://ghcr.io/token",service="ghcr.io"'

        def urlopen(request, timeout):
            if not isinstance(request, str):
                raise http_error(request.full_url, 401, {"WWW-Authenticate": challenge})
            if cut_short:
                raise http.client.IncompleteRead(b"")
            return FakeResponse(body=b"<html>rate limited</html>")

        monkeypatch.setattr(check_pins.urllib.request, "urlopen", urlopen)

        with pytest.raises(OSError, match="cannot be read"):
            check_pins.registry_digest(f"ghcr.io/gitleaks/gitleaks:{GITLEAKS}")

    def test_a_reference_without_a_tag_is_a_lookup_error(self):
        with pytest.raises(LookupError, match="no registry/repository:tag"):
            check_pins.registry_digest("playwright")


def fake_registry(monkeypatch, digests):
    """Answer registry_digest from a map of references to digests; a value
    that is an exception is raised instead"""

    def registry_digest(reference):
        answer = digests[reference]
        if isinstance(answer, Exception):
            raise answer
        return answer

    monkeypatch.setattr(check_pins, "registry_digest", registry_digest)


PLAYWRIGHT_TAG = f"mcr.microsoft.com/playwright:v{PLAYWRIGHT}-noble"
GITLEAKS_TAG = f"ghcr.io/gitleaks/gitleaks:{GITLEAKS}"
UV_TAG = f"ghcr.io/astral-sh/uv:{UV}"


class TestOnline:
    """--online asks the registries for the digest of each tag."""

    def test_digests_of_their_tags_pass(self, repo, monkeypatch, capsys):
        fake_registry(
            monkeypatch, {PLAYWRIGHT_TAG: DIGEST, GITLEAKS_TAG: DIGEST, UV_TAG: DIGEST}
        )

        assert check_pins.main(["--online"]) == 0

        assert "each image by the digest of its tag" in capsys.readouterr().out

    def test_a_tag_edited_alone_fails(self, repo, monkeypatch, capsys):
        """The bump of 1.64.0 to 1.64.1 kept the browsers, so every check
        but this one passed on the old image"""
        fake_registry(
            monkeypatch,
            {PLAYWRIGHT_TAG: NEW_DIGEST, GITLEAKS_TAG: DIGEST, UV_TAG: DIGEST},
        )

        assert check_pins.main(["--online"]) == 1

        assert (
            f"pins {PLAYWRIGHT_TAG} by {DIGEST}, the registry gives {NEW_DIGEST}"
            in capsys.readouterr().err
        )

    def test_a_tag_the_registry_does_not_know_fails(self, repo, monkeypatch, capsys):
        fake_registry(
            monkeypatch,
            {
                PLAYWRIGHT_TAG: DIGEST,
                GITLEAKS_TAG: LookupError("ghcr.io has no tag"),
                UV_TAG: DIGEST,
            },
        )

        assert check_pins.main(["--online"]) == 1

        assert "ghcr.io has no tag" in capsys.readouterr().err

    def test_a_registry_out_of_reach_is_a_warning(self, repo, monkeypatch, capsys):
        fake_registry(
            monkeypatch,
            {
                PLAYWRIGHT_TAG: OSError("timed out"),
                GITLEAKS_TAG: DIGEST,
                UV_TAG: DIGEST,
            },
        )

        assert check_pins.main(["--online"]) == 0

        captured = capsys.readouterr()
        assert f"the digest of {PLAYWRIGHT_TAG} was not checked (timed out)" in (
            captured.err
        )
        assert "each image by the digest" not in captured.out

    def test_offline_asks_no_registry(self, repo, monkeypatch):
        fake_registry(monkeypatch, {})

        assert check_pins.main() == 0

    def test_an_image_without_a_digest_is_not_asked_about(self, repo, monkeypatch):
        """The offline check reports it already"""
        edit(repo / check_pins.GITLEAKS_DOCKERFILE, f"@{DIGEST}", "")
        fake_registry(monkeypatch, {PLAYWRIGHT_TAG: DIGEST, UV_TAG: DIGEST})

        assert check_pins.main(["--online"]) == 1

    def test_a_uv_tag_edited_alone_fails(self, repo, monkeypatch, capsys):
        """uv is moved by hand, and the image would keep building with the
        release before, which the security job no longer audits"""
        fake_registry(
            monkeypatch,
            {PLAYWRIGHT_TAG: DIGEST, GITLEAKS_TAG: DIGEST, UV_TAG: NEW_DIGEST},
        )

        assert check_pins.main(["--online"]) == 1

        err = capsys.readouterr().err
        assert (
            f"Dockerfile pins {UV_TAG} by {DIGEST}, the registry gives {NEW_DIGEST}"
            in err
        )
        # --fix moves the image files only
        assert "Set the same uv release" in err
        assert "--fix" not in err

    def test_a_uv_image_without_a_digest_is_not_asked_about(
        self, repo, monkeypatch, capsys
    ):
        """The offline check reports it already"""
        edit(repo / "Dockerfile", f"uv:{UV}@{DIGEST}", f"uv:{UV}")
        fake_registry(monkeypatch, {PLAYWRIGHT_TAG: DIGEST, GITLEAKS_TAG: DIGEST})

        assert check_pins.main(["--online"]) == 1

        assert "does not pin the uv image" in capsys.readouterr().err


class TestFix:
    """--fix writes the tags the library and the hook ask for, with digests."""

    def test_a_library_and_hook_bump_is_written(self, repo, monkeypatch, capsys):
        lock = json.loads((repo / "package-lock.json").read_text(encoding="utf-8"))
        lock["packages"]["node_modules/@playwright/test"]["version"] = "1.64.1"
        (repo / "package-lock.json").write_text(json.dumps(lock), encoding="utf-8")
        check_pins.read_package_lock.cache_clear()
        (repo / ".pre-commit-config.yaml").write_text(
            PRE_COMMIT.replace(GITLEAKS, "v8.31.0"), encoding="utf-8"
        )
        playwright = "mcr.microsoft.com/playwright:v1.64.1-noble"
        gitleaks = "ghcr.io/gitleaks/gitleaks:v8.31.0"
        fake_registry(
            monkeypatch, {playwright: NEW_DIGEST, gitleaks: NEW_DIGEST, UV_TAG: DIGEST}
        )

        assert check_pins.main(["--fix"]) == 0

        out = capsys.readouterr().out
        assert f"now runs {playwright}@{NEW_DIGEST}" in out
        assert f"now runs {gitleaks}@{NEW_DIGEST}" in out
        assert (repo / check_pins.PLAYWRIGHT_DOCKERFILE).read_text(
            encoding="utf-8"
        ) == f"# The image of a job\nFROM {playwright}@{NEW_DIGEST}\n"
        assert f"FROM {gitleaks}@{NEW_DIGEST}\n" in (
            repo / check_pins.GITLEAKS_DOCKERFILE
        ).read_text(encoding="utf-8")

    def test_files_already_right_are_left_alone(self, repo, monkeypatch, capsys):
        fake_registry(
            monkeypatch, {PLAYWRIGHT_TAG: DIGEST, GITLEAKS_TAG: DIGEST, UV_TAG: DIGEST}
        )

        assert check_pins.main(["--fix"]) == 0

        assert "now runs" not in capsys.readouterr().out

    def test_a_registry_out_of_reach_leaves_the_file(self, repo, monkeypatch, capsys):
        before = (repo / check_pins.GITLEAKS_DOCKERFILE).read_text(encoding="utf-8")
        fake_registry(
            monkeypatch,
            {
                PLAYWRIGHT_TAG: DIGEST,
                GITLEAKS_TAG: OSError("timed out"),
                UV_TAG: DIGEST,
            },
        )

        assert check_pins.main(["--fix"]) == 0

        assert (repo / check_pins.GITLEAKS_DOCKERFILE).read_text(
            encoding="utf-8"
        ) == before
        assert "was not updated (timed out)" in capsys.readouterr().err

    def test_an_unreadable_file_is_skipped(self, repo, monkeypatch, capsys):
        (repo / check_pins.PLAYWRIGHT_DOCKERFILE).unlink()
        fake_registry(monkeypatch, {GITLEAKS_TAG: DIGEST, UV_TAG: DIGEST})

        assert check_pins.main(["--fix"]) == 1

        assert "cannot be read" in capsys.readouterr().err


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
