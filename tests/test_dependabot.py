"""Tests for .github/dependabot.yml.

The npm catch-all group repeats the patterns of the named groups as its
exclude-patterns, which only a comment keeps in step: a package added to a
named group and not there came in the catch-all again.
"""

import re
from pathlib import Path

CONFIG = Path(__file__).parent.parent / ".github" / "dependabot.yml"

CATCH_ALL = "dev-dependencies"


def _npm_lists() -> dict[str, dict[str, list[str]]]:
    """The pattern lists of each npm group: {group: {key: [pattern]}}.

    Read line by line, as no YAML parser is among the test dependencies:
    the groups are the keys indented under ``groups:``, their lists the
    ``patterns:`` and ``exclude-patterns:`` under them.
    """
    groups: dict[str, dict[str, list[str]]] = {}
    in_npm = in_groups = False
    group_indent = 0
    group = ""
    key: str | None = None
    for line in CONFIG.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- package-ecosystem:"):
            in_npm = stripped.endswith('"npm"')
            in_groups = False
            continue
        if not in_npm:
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


def test_the_catch_all_excludes_every_named_group():
    groups = _npm_lists()
    assert CATCH_ALL in groups
    named = {
        pattern
        for name, lists in groups.items()
        if name != CATCH_ALL
        for pattern in lists.get("patterns", [])
    }
    assert len(groups) > 2
    assert set(groups[CATCH_ALL].get("exclude-patterns", [])) == named
