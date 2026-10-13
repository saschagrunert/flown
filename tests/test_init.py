"""Tests for the package itself."""

import subprocess
import sys

import flown


def test_version():
    assert flown.__version__ == "1.0.0"


def test_the_package_imports_none_of_its_modules():
    """``--help`` and ``--version`` stay quick: no lxml or numpy."""
    code = (
        "import sys, flown; "
        "print(sorted(m for m in sys.modules if m.startswith('flown.')))"
    )
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-c", code], capture_output=True, text=True, check=True
    )
    assert result.stdout.strip() == "[]"
