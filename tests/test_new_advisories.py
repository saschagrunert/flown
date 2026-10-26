"""Tests for scripts/new_advisories.py.

The security job of a pull request fails on what this script finds, so an
advisory the head adds has to fail it, and one the base already has must
not. A report it cannot read fails too: the audit may not have run.
"""

import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

import pytest

SCRIPT = Path(__file__).parent.parent / "scripts" / "new_advisories.py"


def _load_module():
    """Import new_advisories.py, which lives outside any package."""
    spec = importlib.util.spec_from_file_location("new_advisories", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


new_advisories = _load_module()


def pip_report(*vulns):
    """A pip-audit report: (package, id, aliases) per advisory, plus a
    package without any"""
    dependencies: list[dict[str, Any]] = [
        {"name": "lxml", "version": "6.1.3", "vulns": []}
    ]
    for name, advisory, aliases in vulns:
        dependencies.append(
            {
                "name": name,
                "version": "1.0",
                "vulns": [{"id": advisory, "aliases": aliases, "fix_versions": []}],
            }
        )
    return {"dependencies": dependencies, "fixes": []}


def npm_report(*vulns):
    """An npm audit report: (package, severity, url) per advisory, plus a
    package vulnerable only through another one"""
    vulnerabilities: dict[str, dict[str, Any]] = {
        "vitest": {"name": "vitest", "severity": "moderate", "via": ["@vitest/ui"]}
    }
    for name, severity, url in vulns:
        vulnerabilities.setdefault(
            name, {"name": name, "severity": severity, "via": []}
        )["via"].append({"source": 1, "name": name, "severity": severity, "url": url})
    return {"auditReportVersion": 2, "vulnerabilities": vulnerabilities}


def write(tmp_path, name, report):
    path = tmp_path / name
    path.write_text(json.dumps(report), encoding="utf-8")
    return str(path)


class TestPip:
    def test_an_advisory_of_the_base_passes(self, tmp_path, capsys):
        base = write(tmp_path, "base.json", pip_report(("filelock", "CVE-1", [])))
        head = write(tmp_path, "head.json", pip_report(("filelock", "CVE-1", [])))

        assert new_advisories.main(["pip", base, head]) == 0
        assert "no advisory" in capsys.readouterr().out

    def test_an_advisory_the_head_adds_fails(self, tmp_path, capsys):
        base = write(tmp_path, "base.json", pip_report())
        head = write(
            tmp_path, "head.json", pip_report(("setuptools", "GHSA-x", ["CVE-2"]))
        )

        assert new_advisories.main(["pip", base, head]) == 1
        assert "setuptools: GHSA-x" in capsys.readouterr().err

    def test_an_advisory_known_by_an_alias_passes(self, tmp_path):
        base = write(
            tmp_path, "base.json", pip_report(("filelock", "PYSEC-1", ["CVE-1"]))
        )
        head = write(tmp_path, "head.json", pip_report(("filelock", "CVE-1", [])))

        assert new_advisories.main(["pip", base, head]) == 0

    def test_the_same_id_of_another_package_fails(self, tmp_path):
        base = write(tmp_path, "base.json", pip_report(("filelock", "CVE-1", [])))
        head = write(tmp_path, "head.json", pip_report(("certifi", "CVE-1", [])))

        assert new_advisories.main(["pip", base, head]) == 1

    def test_a_name_is_matched_regardless_of_its_case(self, tmp_path):
        base = write(tmp_path, "base.json", pip_report(("FileLock", "CVE-1", [])))
        head = write(tmp_path, "head.json", pip_report(("filelock", "CVE-1", [])))

        assert new_advisories.main(["pip", base, head]) == 0


class TestNpm:
    URL = "https://github.com/advisories/GHSA-mrhx-c7xc-m3w5"

    def test_a_high_advisory_the_head_adds_fails(self, tmp_path, capsys):
        base = write(tmp_path, "base.json", npm_report())
        head = write(tmp_path, "head.json", npm_report(("zod", "high", self.URL)))

        assert new_advisories.main(["npm", base, head]) == 1
        assert f"zod: {self.URL}" in capsys.readouterr().err

    def test_a_moderate_advisory_the_head_adds_passes(self, tmp_path):
        """As `npm audit --audit-level=high` lets it pass on a push"""
        base = write(tmp_path, "base.json", npm_report())
        head = write(tmp_path, "head.json", npm_report(("zod", "moderate", self.URL)))

        assert new_advisories.main(["npm", base, head]) == 0

    def test_an_advisory_of_the_base_passes_whatever_its_severity_there(self, tmp_path):
        """An advisory raised to high since is still not the pull request's"""
        base = write(tmp_path, "base.json", npm_report(("zod", "moderate", self.URL)))
        head = write(tmp_path, "head.json", npm_report(("zod", "high", self.URL)))

        assert new_advisories.main(["npm", base, head]) == 0

    def test_a_clean_report_passes(self, tmp_path):
        base = write(tmp_path, "base.json", npm_report())
        head = write(
            tmp_path, "head.json", {"auditReportVersion": 2, "vulnerabilities": {}}
        )

        assert new_advisories.main(["npm", base, head]) == 0

    @pytest.mark.parametrize("side", ["base", "head"])
    def test_the_report_of_a_failed_audit_fails(self, tmp_path, capsys, side):
        """What npm audit --json writes when the registry cannot be reached:
        valid JSON without the vulnerabilities, which must not read as none"""
        failed = {
            "message": "request to https://registry.npmjs.org/-/npm/v1/security/"
            "advisories/bulk failed, reason: getaddrinfo ENOTFOUND",
            "error": {"summary": "", "detail": ""},
        }
        reports = {"base": npm_report(), "head": npm_report()}
        reports[side] = failed
        base = write(tmp_path, "base.json", reports["base"])
        head = write(tmp_path, "head.json", reports["head"])

        assert new_advisories.main(["npm", base, head]) == 1
        assert "ENOTFOUND" in capsys.readouterr().err

    def test_a_report_without_vulnerabilities_fails(self, tmp_path):
        base = write(tmp_path, "base.json", npm_report())
        head = write(tmp_path, "head.json", {"auditReportVersion": 2})

        assert new_advisories.main(["npm", base, head]) == 1

    def test_a_pip_report_fails(self, tmp_path):
        base = write(tmp_path, "base.json", pip_report())
        head = write(tmp_path, "head.json", pip_report())

        assert new_advisories.main(["npm", base, head]) == 1


class TestReports:
    def test_a_missing_report_fails(self, tmp_path):
        head = write(tmp_path, "head.json", pip_report())

        with pytest.raises(SystemExit, match="cannot be read"):
            new_advisories.main(["pip", str(tmp_path / "base.json"), head])

    def test_a_report_that_is_no_json_fails(self, tmp_path):
        base = tmp_path / "base.json"
        base.write_text("Found 7 known vulnerabilities", encoding="utf-8")
        head = write(tmp_path, "head.json", pip_report())

        with pytest.raises(SystemExit, match="cannot be read"):
            new_advisories.main(["pip", str(base), head])

    def test_a_report_of_the_other_tool_fails(self, tmp_path, capsys):
        base = write(tmp_path, "base.json", npm_report())
        head = write(tmp_path, "head.json", npm_report())

        assert new_advisories.main(["pip", base, head]) == 1
        assert "not one of pip" in capsys.readouterr().err

    @pytest.mark.parametrize("argv", [[], ["pip", "a.json"], ["yarn", "a", "b"]])
    def test_a_wrong_call_prints_the_usage(self, argv, capsys):
        assert new_advisories.main(argv) == 2
        assert "Usage" in capsys.readouterr().err
