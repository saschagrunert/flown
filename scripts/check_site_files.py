#!/usr/bin/env python3
"""Check that a generated site, or the installed package, has every file the page loads.

The packaging job of .github/workflows/test.yml installs the wheel and runs
this twice: with --package against the package it installed, and against the
site that package generates, and then against the sites the image generates.
A file the wheel or the image leaves out fails all of them at once, from the
one list below, rather than from one copy of it per build.

--package has to run with the Python of the environment the wheel went into,
outside the checkout: run as a script, only scripts/ is put in front of the
import path, so `flown` is the installed package and not the sources.
"""

import argparse
import importlib.resources
import sys
from pathlib import Path

# The bundles build.js writes, the stylesheets and the vendored files the
# page imports, by their paths in the package's static/ and in a generated
# site alike: BUNDLE_FILES, CSS_FILES and VENDOR_FILES of
# flown/site_assets.py, which tests/test_scripts.py holds this list
# to. Written out rather than imported, since the builds of the image run
# this with a Python that does not have the package.
ASSETS = (
    "mapApp.bundle.js",
    "features.bundle.js",
    "wrapped.bundle.js",
    "search.bundle.js",
    "extras.bundle.js",
    "shared.bundle.js",
    "yearWorker.bundle.js",
    "styles.css",
    "features.css",
    "wrapped.css",
    "search.css",
    "vendor/maplibre-gl.mjs",
    "vendor/maplibre-gl-shared.mjs",
    "vendor/maplibre-gl-worker.mjs",
    "vendor/maplibre-gl.css",
    "vendor/html-to-image.mjs",
)

SITE_FILES = ("index.html", "map_config.js", *ASSETS, "data/metadata.json")

PACKAGE_FILES = (
    "templates/map_template.html",
    *(f"static/{asset}" for asset in ASSETS),
)


def site_problems(site: Path) -> list[str]:
    """The files of SITE_FILES that are missing from the site, or empty."""
    return [
        f"{site / name} was not generated"
        for name in SITE_FILES
        if not (site / name).is_file() or (site / name).stat().st_size == 0
    ]


def package_problems() -> list[str]:
    """The files of PACKAGE_FILES the installed package lacks, and its source maps.

    The bundle is the shipped artifact; its source map (mappings and file
    names, build.js keeps the sources out) stays with the site and the
    container and out of the wheel.
    """
    package = importlib.resources.files("flown")
    problems = [
        f"{name} is not shipped"
        for name in PACKAGE_FILES
        if not package.joinpath(name).is_file()
    ]
    problems += [
        f"static/{entry.name} is shipped"
        for entry in package.joinpath("static").iterdir()
        if entry.name.endswith(".map")
    ]
    return problems


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check that a site or the installed package has every file"
    )
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("site", nargs="?", type=Path, help="a generated site")
    target.add_argument(
        "--package", action="store_true", help="the installed flown package"
    )
    args = parser.parse_args(argv)

    if args.package:
        print(f"Checking the package at {importlib.resources.files('flown')}")
        problems = package_problems()
        checked = len(PACKAGE_FILES)
    else:
        print(f"Checking the site in {args.site}")
        problems = site_problems(args.site)
        checked = len(SITE_FILES)

    for problem in problems:
        print(f"::error::{problem}")
    if problems:
        return 1
    print(f"All {checked} files are there")
    return 0


if __name__ == "__main__":
    sys.exit(main())
