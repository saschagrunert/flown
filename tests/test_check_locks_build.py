"""Tests for the build pin check of scripts/check_locks.py.

CI builds the wheel without build isolation, from the build dependency group
uv.lock pins, so a range in build-system.requires that the pin no longer
meets would build with the old setuptools while claiming the new one.
Dependabot raises both ranges together; a range raised by hand may not.
These tests start from the passing fixture repository of test_check_locks.py
and add a build system to it.
"""

import pytest

from tests.test_check_locks import check_locks, repo  # noqa: F401

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
def build_repo(repo):  # noqa: F811
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


def test_a_satisfied_build_pin_passes(build_repo):
    assert check_locks.main() == 0


def test_a_build_pin_below_the_requirement_fails(build_repo, capsys):
    write_lock(build_repo, "80.0.0")

    assert check_locks.main() == 1
    err = capsys.readouterr().err
    assert (
        "uv.lock pins setuptools==80.0.0, build-system.requires asks for "
        '"setuptools>=82.0.1"'
    ) in err
    assert "then run `uv lock`" in err


def test_every_version_of_a_split_pin_is_checked(build_repo, capsys):
    """uv.lock pins a package twice where markers resolve it apart."""
    lock = build_repo / "uv.lock"
    lock.write_text(
        lock.read_text(encoding="utf-8")
        + '\n[[package]]\nname = "setuptools"\nversion = "80.0.0"\n',
        encoding="utf-8",
    )

    assert check_locks.main() == 1
    err = capsys.readouterr().err
    assert "uv.lock pins setuptools==80.0.0" in err
    assert f"setuptools=={SETUPTOOLS}" not in err


def test_a_lock_without_setuptools_fails(build_repo, capsys):
    write_lock(build_repo, name="wheel")

    assert check_locks.main() == 1
    assert "uv.lock does not pin setuptools" in capsys.readouterr().err


def test_a_build_requirement_left_out_of_the_group_fails(build_repo, capsys):
    pyproject = build_repo / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")
    pyproject.write_text(
        text.replace('build = ["setuptools>=84.0.0"]\n', ""), encoding="utf-8"
    )

    assert check_locks.main() == 1
    assert (
        "the build dependency group of pyproject.toml does not ask for "
        "setuptools, "
        "which build-system.requires does"
    ) in capsys.readouterr().err


def test_a_name_is_matched_regardless_of_its_spelling(build_repo):
    """uv.lock normalises names; build-system.requires may not."""
    pyproject = build_repo / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")
    pyproject.write_text(
        text.replace(
            'requires = ["setuptools>=82.0.1"]', 'requires = ["SetupTools>=82.0.1"]'
        ),
        encoding="utf-8",
    )

    assert check_locks.main() == 0


def test_a_missing_lock_fails(build_repo, capsys):
    (build_repo / "uv.lock").unlink()

    assert check_locks.main() == 1
    assert "uv.lock is missing" in capsys.readouterr().err


def test_a_requirement_for_another_platform_is_skipped(build_repo):
    """The build here never installs it, so uv.lock need not pin it."""
    pyproject = build_repo / "pyproject.toml"
    text = pyproject.read_text(encoding="utf-8")
    pyproject.write_text(
        text.replace(
            'requires = ["setuptools>=82.0.1"]',
            'requires = ["setuptools>=82.0.1", "tomli>=2; python_version < \'3.11\'"]',
        ),
        encoding="utf-8",
    )

    assert check_locks.main() == 0


def test_an_included_group_is_no_requirement(build_repo):
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

    assert check_locks.main() == 0
