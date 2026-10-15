"""Smoke test for serve.py, the server `make serve` runs in the image.

It starts the script as the image does, on a free port against a temporary
directory, and fetches a file, a missing file and a directory from it.
"""

import importlib.util
import os
import re
import select
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import pytest

SERVE = Path(__file__).parent.parent / "serve.py"


@pytest.fixture
def site(tmp_path):
    """serve.py serving a small site.

    On a port the system picks (PORT=0), which the script prints once it is
    bound: a port probed free and closed again could be taken by another
    test's server before serve.py binds it.
    """
    (tmp_path / "index.html").write_text("<p>flights</p>", encoding="utf-8")
    (tmp_path / "data").mkdir()
    env = {
        **os.environ,
        "DATA_DIR": str(tmp_path),
        "PORT": "0",
        "BIND_HOST": "127.0.0.1",
    }
    server = subprocess.Popen(  # noqa: S603
        [sys.executable, str(SERVE)],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    assert server.stdout is not None
    try:
        ready, _, _ = select.select([server.stdout], [], [], 10)
        line = server.stdout.readline() if ready else ""
        match = re.fullmatch(
            r"Starting HTTP server on 127\.0\.0\.1:(\d+)\.\.\.\n", line
        )
        if match is None:
            pytest.fail(f"serve.py did not start listening: {line!r}")
        yield f"http://127.0.0.1:{match[1]}"
    finally:
        server.terminate()
        server.wait(timeout=10)
        server.stdout.close()


def test_serves_a_file_without_caching(site):
    with urllib.request.urlopen(f"{site}/index.html", timeout=5) as response:  # noqa: S310
        assert response.status == 200
        assert response.read() == b"<p>flights</p>"
        assert "no-store" in response.headers["Cache-Control"]


def test_a_missing_file_is_not_found(site):
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(f"{site}/missing.js", timeout=5)  # noqa: S310
    error.value.close()
    assert error.value.code == 404


def test_lists_no_directory(site):
    with pytest.raises(urllib.error.HTTPError) as error:
        urllib.request.urlopen(f"{site}/data/", timeout=5)  # noqa: S310
    error.value.close()
    assert error.value.code == 404


def test_sends_the_security_headers(site):
    with urllib.request.urlopen(f"{site}/index.html", timeout=5) as response:  # noqa: S310
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        # The page's own policy, which the map's worker takes from its script
        assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"


def _serve_module():
    """serve.py as a module, which is not in a package."""
    spec = importlib.util.spec_from_file_location("serve", SERVE)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_prints_the_address_it_is_reached_at(monkeypatch):
    monkeypatch.setenv("PORT", "8000")
    monkeypatch.delenv("OPEN_URL", raising=False)
    assert _serve_module().OPEN_URL == "http://localhost:8000/"

    # In the image the port is 8000 inside, and make serve maps another
    monkeypatch.setenv("OPEN_URL", "http://127.0.0.1:9000/")
    assert _serve_module().OPEN_URL == "http://127.0.0.1:9000/"


def test_refuses_to_start_without_the_directory(tmp_path):
    result = subprocess.run(  # noqa: S603
        [sys.executable, str(SERVE)],
        env={**os.environ, "DATA_DIR": str(tmp_path / "missing")},
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )

    assert result.returncode == 1
    assert "does not exist" in result.stdout
