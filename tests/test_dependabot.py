"""Tests for .github/dependabot.yml.

The npm catch-all group repeats the patterns of the named groups as its
exclude-patterns, which only a comment keeps in step: a package added to a
named group and not there came in the catch-all again. A pattern of a uv
group is matched against the dependency as pyproject.toml writes it, extras
and all: "coverage" never matched "coverage[toml]", and the testing group
went without it.
"""

import re
import tomllib
from fnmatch import fnmatchcase
from pathlib import Path

from packaging.requirements import Requirement

ROOT = Path(__file__).parent.parent
CONFIG = ROOT / ".github" / "dependabot.yml"

CATCH_ALL = "dev-dependencies"


def _group_lists(ecosystem: str) -> dict[str, dict[str, list[str]]]:
    """The pattern lists of each group of an ecosystem: {group: {key: [pattern]}}.

    Read line by line, as no YAML parser is among the test dependencies:
    the groups are the keys indented under ``groups:``, their lists the
    ``patterns:`` and ``exclude-patterns:`` under them.
    """
    groups: dict[str, dict[str, list[str]]] = {}
    in_ecosystem = in_groups = False
    group_indent = 0
    group = ""
    key: str | None = None
    for line in CONFIG.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- package-ecosystem:"):
            in_ecosystem = stripped.endswith(f'"{ecosystem}"')
            in_groups = False
            continue
        if not in_ecosystem:
            continue
        indent = len(line) - len(line.lstrip())
        if stripped == "groups:":
            in_groups = True
            group_indent = indent + 2
            continue
        if not in_groups:
            continue
        if indent < group_indent:
            in_groups = False
        elif indent == group_indent and stripped.endswith(":"):
            group = stripped[:-1]
            groups[group] = {}
            key = None
        elif stripped in ("patterns:", "exclude-patterns:"):
            key = stripped[:-1]
            groups[group][key] = []
        elif stripped.endswith(":"):
            key = None
        elif key and (item := re.fullmatch(r'- "([^"]+)"', stripped)):
            groups[group][key].append(item.group(1))
    return groups


def _python_dependencies() -> list[str]:
    """Every dependency of pyproject.toml as Dependabot names it: the name
    with its extras, from the runtime dependencies, the extras, the
    dependency groups and build-system.requires"""
    with open(ROOT / "pyproject.toml", "rb") as f:
        pyproject = tomllib.load(f)
    project = pyproject["project"]
    lines = [
        *project.get("dependencies", []),
        *(
            line
            for extra in project.get("optional-dependencies", {}).values()
            for line in extra
        ),
        *(
            line
            for group in pyproject.get("dependency-groups", {}).values()
            for line in group
            if isinstance(line, str)
        ),
        *pyproject.get("build-system", {}).get("requires", []),
    ]
    names = []
    for line in lines:
        requirement = Requirement(line)
        extras = ",".join(sorted(requirement.extras))
        names.append(requirement.name + (f"[{extras}]" if extras else ""))
    return names


def test_every_uv_group_pattern_matches_a_dependency():
    groups = _group_lists("uv")
    dependencies = _python_dependencies()
    patterns = [
        pattern for lists in groups.values() for pattern in lists.get("patterns", [])
    ]
    assert len(groups) > 2
    assert patterns
    unmatched = [
        pattern
        for pattern in patterns
        if not any(fnmatchcase(name, pattern) for name in dependencies)
    ]
    assert unmatched == []


def test_the_catch_all_excludes_every_named_group():
    groups = _group_lists("npm")
    assert CATCH_ALL in groups
    named = {
        pattern
        for name, lists in groups.items()
        if name != CATCH_ALL
        for pattern in lists.get("patterns", [])
    }
    assert len(groups) > 2
    assert set(groups[CATCH_ALL].get("exclude-patterns", [])) == named
