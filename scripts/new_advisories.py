#!/usr/bin/env python3
"""Fail on the advisories a pull request adds, not on those its base has.

The security job of .github/workflows/test.yml audits the lock files of a
pull request that changes them. An advisory published for a version the base
already pins turned such pull requests red although they had nothing to do
with it: a bump of hypothesis failed three runs on advisories for filelock
and setuptools that main had as well. There the job audits the lock files of
the base too, and this script compares the two reports: it prints every
advisory of the head that the base does not have, and fails on any. A push
to main and the weekly run still audit the whole lock files, so an advisory
of the base shows there.

An advisory is matched by the package and its id, or any alias of it, not
by the version: a pull request that moves a package to another release with
the same advisory adds nothing new. Usage:

    new_advisories.py pip BASE.json HEAD.json   # reports of pip-audit -f json
    new_advisories.py npm BASE.json HEAD.json   # reports of npm audit --json

For npm only the advisories of high and critical severity count, as
`npm audit --audit-level=high` does on a push. A report that cannot be read
fails the script, and so does the one npm writes when its audit fails: the
audit it stands for did not run.
"""

import json
import sys
from pathlib import Path
from typing import Any

# The npm severities `npm audit --audit-level=high` fails on
NPM_FAILING = frozenset({"high", "critical"})


def pip_advisories(report: dict[str, Any]) -> dict[tuple[str, str], set[str]]:
    """Each advisory of a pip-audit report, by package and id, with the id
    and its aliases."""
    advisories = {}
    for dependency in report["dependencies"]:
        name = dependency["name"].lower()
        for vuln in dependency.get("vulns", []):
            ids = {vuln["id"], *vuln.get("aliases", [])}
            advisories[(name, vuln["id"])] = ids
    return advisories


def npm_advisories(
    report: dict[str, Any], failing_only: bool
) -> dict[tuple[str, str], set[str]]:
    """Each advisory of an npm audit report, by package and URL. The entries
    of a package list the advisories of its own, or the names of the
    packages it is vulnerable through, which have entries of their own.

    A report without the vulnerabilities is no audit: npm writes one that
    holds only the error (and exits with 1, which the job lets through) when
    the registry cannot be reached, and a clean audit still has the key."""
    if "error" in report:
        raise ValueError(
            f"npm audit failed: {report.get('message') or report['error']}"
        )
    advisories = {}
    for entry in report["vulnerabilities"].values():
        for via in entry.get("via", []):
            if not isinstance(via, dict):
                continue
            if failing_only and via.get("severity") not in NPM_FAILING:
                continue
            key = str(via.get("url") or via.get("source"))
            advisories[(str(via.get("name", entry["name"])), key)] = {key}
    return advisories


def new_advisories(kind: str, base: dict[str, Any], head: dict[str, Any]) -> list[str]:
    """The advisories of the head report that the base report does not have."""
    if kind == "pip":
        known, found = pip_advisories(base), pip_advisories(head)
    else:
        known, found = npm_advisories(base, False), npm_advisories(head, True)
    known_ids: dict[str, set[str]] = {}
    for (name, _), ids in known.items():
        known_ids.setdefault(name, set()).update(ids)
    return sorted(
        f"{name}: {advisory}"
        for (name, advisory), ids in found.items()
        if not ids & known_ids.get(name, set())
    )


def read_report(path: str) -> dict[str, Any]:
    """A JSON report, or an exit naming the one that cannot be read."""
    try:
        report: dict[str, Any] = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        sys.exit(f"error: the audit report {path} cannot be read ({e})")
    return report


def main(argv: list[str]) -> int:
    """Print the new advisories and return the exit status."""
    if len(argv) != 3 or argv[0] not in ("pip", "npm"):
        print(__doc__, file=sys.stderr)
        return 2
    kind, base, head = argv
    try:
        found = new_advisories(kind, read_report(base), read_report(head))
    except (KeyError, TypeError, AttributeError) as e:
        print(f"error: an audit report is not one of {kind} ({e!r})", file=sys.stderr)
        return 1
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    if not found:
        print(f"The {kind} audit finds no advisory that the base does not have.")
        return 0
    for advisory in found:
        print(f"error: new advisory {advisory}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
