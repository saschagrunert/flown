#!/usr/bin/env python3
"""Build the site the visual snapshots are compared against.

The snapshots of tests/e2e/visual.spec.ts are compared pixel for pixel, so
nothing they show may depend on when or where the site was built. data/
grows with every flight, which used to move the figures of the statistics
rail and of Wrapped; this builds tests/fixtures/visual/ instead, a handful of
flights that only change on purpose, into visual-site/.

Everything else that varies between builds is pinned here as well: the build
stamp of the statistics panel, the airport and runway databases and the tile
API key. The ground under the flights is left out (--no-terrain): sampling it
would fetch elevation tiles, and the one snapshot of the 3D view it is for,
the heat cloud's, is as fixed without it, with each flight on a line between
its airfields over the flat elevation tiles of the e2e fixture. Run
`npm run build` first; the generator needs the bundles.
"""

import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "visual"
AIRPORTS = ROOT / "tests" / "fixtures" / "airports.csv"
RUNWAYS = ROOT / "tests" / "fixtures" / "runways.csv"
SITE_DIR = ROOT / "visual-site"
# Where the build leaves the hash of what the site is made of besides the
# generator (fixture_hash), which the e2e site check compares
FIXTURE_HASH_FILE = "fixture.sha1"

# The statistics panel prints the day and the commit the site was built from.
# Both are fixed, to values that are obviously not real: the first day of
# the year the spec pins, and a hash no commit has.
BUILD_ENVIRONMENT = {
    "SOURCE_DATE_EPOCH": "1735689600",
    "FLOWN_COMMIT": "0000000",
    "FLOWN_REPOSITORY": "",
    # Without the airport database the build still succeeds, with other
    # airport names in the rail
    "FLOWN_REQUIRE_AIRPORT_DB": "1",
    # A key in the environment of whoever runs this adds the keyed layers
    "CARTO_API_KEY": "",
}


def fixture_inputs() -> list[Path]:
    """What only the fixture site is made of: the flights and aircraft of
    the fixture, the two databases and this script."""
    flights = [
        path
        for path in FIXTURE_DIR.iterdir()
        if path.is_file() and not path.name.startswith(".")
    ]
    return [*flights, AIRPORTS, RUNWAYS, Path(__file__).resolve()]


def fixture_hash() -> str:
    """The SHA-1 of the path, relative to the checkout, and the content of
    each of ``fixture_inputs`` in path order, as ``hashFiles`` in
    scripts/source-hash.js computes it.

    tests/e2e/site-check.ts compares it with the one the build left in the
    site: the modification times it compared before are those of the build
    day, or of 2025 (SOURCE_DATE_EPOCH below), and said nothing about which
    is newer.
    """
    digest = hashlib.sha1(usedforsecurity=False)
    for name, path in sorted(
        (path.relative_to(ROOT).as_posix(), path) for path in fixture_inputs()
    ):
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def main() -> int:
    # A site left over from another fixture or generator would keep files
    # this build no longer writes
    shutil.rmtree(SITE_DIR, ignore_errors=True)
    # The cache directory holds the airport database and the parser cache. A
    # fresh one with fresh copies of the fixture databases keeps the build
    # offline (a copy older than 30 days would be downloaded again) and
    # independent of what earlier builds left in the user's cache.
    with tempfile.TemporaryDirectory(prefix="flown-visual-") as cache_dir:
        shutil.copy(AIRPORTS, cache_dir)
        shutil.copy(RUNWAYS, cache_dir)
        env = {**os.environ, **BUILD_ENVIRONMENT, "FLOWN_CACHE_DIR": cache_dir}
        # Hashed before the build: a fixture that changes while it runs
        # leaves a site the check refuses
        inputs = fixture_hash()
        status = subprocess.run(  # noqa: S603
            [
                sys.executable,
                "-m",
                "flown",
                str(FIXTURE_DIR),
                "--output-dir",
                str(SITE_DIR),
                "--no-terrain",
            ],
            cwd=ROOT,
            env=env,
            check=False,
        ).returncode
    if status == 0:
        (SITE_DIR / FIXTURE_HASH_FILE).write_text(f"{inputs}\n", encoding="ascii")
    return status


if __name__ == "__main__":
    sys.exit(main())
