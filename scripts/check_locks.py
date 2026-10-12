#!/usr/bin/env python3
"""Check that the hashed lock files still satisfy pyproject.toml (and the
pip-tools lock its requirements-tools.in), that the Playwright image is
pinned by digest and matches the pinned library (in every job of the
workflow and in the commands the documentation quotes), that the package
version is the same on both sides of the project, and that every file that
names the Python or Node.js version names the same one.

Dependabot raises the ranges in pyproject.toml but cannot recompile the
lock files, and CI installs the lock files. Without this check such a pull
request passes CI while testing the old versions. The version in
flown/__init__.py is what `--version` and the wheel report, and
package.json and package-lock.json carry it again for the npm side; nothing
reads all of them, so they drift apart unnoticed until the two sides name
two different versions. The pre-commit hooks are not checked here: the
linters and formatters run from the project environment, so they have no
revision of their own to drift. Run by `make lint` and the CI lint job.
"""

import functools
import json
import re
import sys
import tomllib
from pathlib import Path
from typing import Any

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOT = Path(__file__).resolve().parent.parent
PIN = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s\\;]+)", re.MULTILINE)
# The __version__ assignment at the top of flown/__init__.py
PACKAGE_VERSION = re.compile(r'^__version__\s*=\s*"([^"]+)"', re.MULTILINE)
# Any reference to the Playwright image, in a job of the test workflow or in
# a documented command
PLAYWRIGHT_IMAGE_REFERENCE = re.compile(r"mcr\.microsoft\.com/playwright:[^\s`]+")
# One of them in full, a tag and a digest (v1.2.3-noble@sha256:...). The
# groups are the version and the digest; the digest is optional here so that
# a missing or malformed one is reported as such.
PLAYWRIGHT_IMAGE = re.compile(
    r"mcr\.microsoft\.com/playwright:v(\S+?)-[a-z]+(?:@(sha256:[0-9a-f]{64}))?"
)
# The documents that quote the image for running the visual tests locally
PLAYWRIGHT_IMAGE_DOCS = ("CONTRIBUTING.md", "doc/development/testing.md")
# A base image of the Dockerfile and the version of its tag, the part before
# the first hyphen: python of "FROM docker.io/library/python:3.14-slim@...",
# also after options such as "FROM --platform=$BUILDPLATFORM"
DOCKER_BASE_IMAGE = re.compile(
    r"^FROM\s+(?:--\S+\s+)*(?:\S+/)?(python|node):([0-9][0-9.]*)", re.MULTILINE
)


@functools.cache
def read_package_lock() -> dict[str, Any]:
    """package-lock.json, parsed once. Two checks below read it, and it is
    the largest file this script opens. Callers only read the result."""
    with open(ROOT / "package-lock.json", encoding="utf-8") as f:
        lock: dict[str, Any] = json.load(f)
    return lock


def read_npm_version(name: str) -> str | None:
    """The version of a package pinned in package-lock.json."""
    packages = read_package_lock()["packages"]
    version = packages.get(f"node_modules/{name}", {}).get("version")
    return str(version) if version else None


def read_python_version() -> str | None:
    """The version flown/__init__.py declares."""
    text = (ROOT / "flown/__init__.py").read_text(encoding="utf-8")
    match = PACKAGE_VERSION.search(text)
    return match.group(1) if match else None


def npm_versions() -> dict[str, str | None]:
    """The package version the npm files declare, by where it is written.

    package-lock.json carries it twice, at the top level and in the entry of
    the root package. npm writes both, so a bump by hand that only edits
    package.json leaves them behind until the next install rewrites the lock,
    where the change then turns up as noise in an unrelated pull request.
    """
    with open(ROOT / "package.json", encoding="utf-8") as f:
        package = json.load(f)
    lock = read_package_lock()
    root_entry = lock.get("packages", {}).get("", {})
    return {
        "package.json": package.get("version"),
        'package-lock.json "version"': lock.get("version"),
        'package-lock.json packages[""]': root_entry.get("version"),
    }


def version_mismatches() -> list[str]:
    """Describe every place the package version differs from __init__.py.

    flown/__init__.py is the one pyproject.toml reads (its version is
    dynamic), so it is what the others have to agree with.
    """
    expected = read_python_version()
    if expected is None:
        return ["flown/__init__.py declares no __version__"]

    problems = []
    for source, version in npm_versions().items():
        if version is None:
            problems.append(f"{source} declares no version")
        elif version != expected:
            problems.append(f"flown/__init__.py is {expected}, {source} {version}")
    return problems


def playwright_image_mismatches() -> list[str]:
    """Check the Playwright container against the pinned @playwright/test.

    The visual job compares screenshots inside that image, and the committed
    snapshots were generated in it; the e2e jobs run in it too. An image a
    version ahead of the library renders differently, which reads as a page
    regression rather than as the version drift it is, and two jobs on two
    images would no longer test the same browsers.
    """
    text = (ROOT / ".github/workflows/test.yml").read_text(encoding="utf-8")
    images = list(dict.fromkeys(PLAYWRIGHT_IMAGE_REFERENCE.findall(text)))
    if not images:
        return [".github/workflows/test.yml runs no Playwright image"]
    problems = []
    if len(images) > 1:
        problems.append(
            ".github/workflows/test.yml runs different Playwright images: "
            + ", ".join(images)
        )
    pinned = read_npm_version("@playwright/test")
    if pinned is None:
        problems.append("package-lock.json does not pin @playwright/test")
    for image in images:
        match = PLAYWRIGHT_IMAGE.fullmatch(image)
        # A tag alone can be moved to another build; the digest cannot
        if match is None or match.group(2) is None:
            problems.append(
                f".github/workflows/test.yml does not pin the Playwright image "
                f"{image} by its @sha256 digest"
            )
        if match is not None and pinned is not None and match.group(1) != pinned:
            problems.append(
                f".github/workflows/test.yml runs the Playwright image "
                f"v{match.group(1)}, package-lock.json pins {pinned}"
            )
    # The documented commands are how the snapshots get regenerated, so an
    # image other than the one CI compares in produces snapshots that fail.
    # A document that is gone, or no longer quotes the image, is reported
    # too: skipped, a move of the command to another page left it unchecked.
    for name in PLAYWRIGHT_IMAGE_DOCS:
        path = ROOT / name
        if not path.is_file():
            problems.append(f"{name} is missing")
            continue
        quoted_images = PLAYWRIGHT_IMAGE_REFERENCE.findall(
            path.read_text(encoding="utf-8")
        )
        if not quoted_images:
            problems.append(f"{name} quotes no Playwright image")
        problems.extend(
            f"{name} quotes the Playwright image {quoted}, "
            f".github/workflows/test.yml runs {images[0]}"
            for quoted in quoted_images
            if quoted != images[0]
        )
    return problems


def toolchain_mismatches(pyproject: dict[str, Any]) -> list[str]:
    """Check every place that names the Python or Node.js version.

    CI sets up the versions of .python-version and .nvmrc, the container
    image builds on the tags of its FROM lines, and pyproject.toml and
    package.json state the oldest version the code is written for. A bump
    of one of them alone passes every job that does not read the others
    (the image kept building on the old Python), so they are compared here.
    """
    problems: list[str] = []
    versions: dict[str, str] = {}
    for name, file in (("python", ".python-version"), ("node", ".nvmrc")):
        try:
            version = (ROOT / file).read_text(encoding="utf-8").strip()
        except OSError as e:
            problems.append(f"{file} cannot be read ({e.strerror or e})")
            continue
        if not version:
            problems.append(f"{file} is empty")
            continue
        versions[name] = version
    python = versions.get("python")
    node = versions.get("node")
    tool = pyproject.get("tool", {})
    with open(ROOT / "package.json", encoding="utf-8") as f:
        engines = json.load(f).get("engines", {})
    expected: dict[str, tuple[Any, str]] = {}
    if python is not None:
        expected["pyproject.toml requires-python"] = (
            pyproject["project"].get("requires-python"),
            f">={python}",
        )
        expected["pyproject.toml [tool.mypy] python_version"] = (
            tool.get("mypy", {}).get("python_version"),
            python,
        )
        expected["pyproject.toml [tool.ruff] target-version"] = (
            tool.get("ruff", {}).get("target-version"),
            "py" + python.replace(".", ""),
        )
    if node is not None:
        expected['package.json engines "node"'] = (engines.get("node"), f">={node}")
    problems.extend(
        f'{source} is "{actual}", .python-version and .nvmrc ask for "{wanted}"'
        for source, (actual, wanted) in expected.items()
        if actual != wanted
    )
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")
    images = DOCKER_BASE_IMAGE.findall(dockerfile)
    for name, wanted in versions.items():
        tags = [tag for image, tag in images if image == name]
        if not tags:
            problems.append(f"the Dockerfile builds on no {name} image")
        problems.extend(
            f"the Dockerfile builds on {name}:{tag}, the version file asks for {wanted}"
            for tag in tags
            if tag != wanted
        )
    return problems


def read_pins(lock: str) -> dict[str, str]:
    """Map each package pinned in a pip-compile output to its version."""
    text = (ROOT / lock).read_text(encoding="utf-8")
    return {canonicalize_name(name): version for name, version in PIN.findall(text)}


def read_requirements(path: str) -> list[str]:
    """The requirements of a pip-compile input, without comments and options."""
    text = (ROOT / path).read_text(encoding="utf-8")
    lines = (line.split("#", 1)[0].strip() for line in text.splitlines())
    return [line for line in lines if line and not line.startswith("-")]


def unsatisfied(
    requirements: list[str],
    pins: dict[str, str],
    lock: str,
    source: str = "pyproject.toml",
) -> list[str]:
    """Describe every requirement the pins of a lock file do not meet."""
    problems = []
    for line in requirements:
        requirement = Requirement(line)
        if requirement.marker is not None and not requirement.marker.evaluate():
            continue
        pinned = pins.get(canonicalize_name(requirement.name))
        if pinned is None:
            problems.append(f"{lock} does not pin {requirement.name}")
        elif not requirement.specifier.contains(pinned, prereleases=True):
            problems.append(
                f'{lock} pins {requirement.name}=={pinned}, {source} asks for "{line}"'
            )
    return problems


def main() -> int:
    """Print the mismatches and return the exit status."""
    with open(ROOT / "pyproject.toml", "rb") as f:
        pyproject = tomllib.load(f)
    project = pyproject["project"]
    # What building the wheel needs; CI installs it from its own lock file to
    # build without isolation (see `make lock`)
    build: list[str] = pyproject.get("build-system", {}).get("requires", [])
    runtime: list[str] = project["dependencies"]
    extras: dict[str, list[str]] = project["optional-dependencies"]
    tooling = extras["test"] + extras["dev"]

    runtime_pins = read_pins("requirements.lock")
    test_pins = read_pins("requirements-test.lock")

    problems = unsatisfied(runtime, runtime_pins, "requirements.lock")
    problems += unsatisfied(runtime + tooling, test_pins, "requirements-test.lock")
    if build and not (ROOT / "requirements-build.lock").is_file():
        problems.append("requirements-build.lock is missing")
    elif build:
        problems += unsatisfied(
            build, read_pins("requirements-build.lock"), "requirements-build.lock"
        )
    # What `make lock` itself runs, installed with --require-hashes
    missing = [
        name
        for name in ("requirements-tools.in", "requirements-tools.lock")
        if not (ROOT / name).is_file()
    ]
    problems += [f"{name} is missing" for name in missing]
    if not missing:
        problems += unsatisfied(
            read_requirements("requirements-tools.in"),
            read_pins("requirements-tools.lock"),
            "requirements-tools.lock",
            "requirements-tools.in",
        )
    # CI installs requirements-test.lock alone where it needs both, which is
    # only the same as installing both while the shared pins agree
    problems += [
        f"requirements.lock pins {name}=={version}, "
        f"requirements-test.lock {name}=={test_pins.get(name)}"
        for name, version in runtime_pins.items()
        if test_pins.get(name) != version
    ]

    image_problems = playwright_image_mismatches()
    version_problems = version_mismatches()
    toolchain_problems = toolchain_mismatches(pyproject)

    if not (problems or image_problems or version_problems or toolchain_problems):
        print(
            "The lock files satisfy pyproject.toml and requirements-tools.in, "
            "the Playwright image matches, the package version agrees and "
            "the Python and Node.js versions agree."
        )
        return 0
    for problem in problems + image_problems + version_problems + toolchain_problems:
        print(f"error: {problem}", file=sys.stderr)
    if problems:
        print(
            "The lock files are out of date; run `make lock` and commit "
            "requirements.lock, requirements-test.lock, "
            "requirements-build.lock and requirements-tools.lock.",
            file=sys.stderr,
        )
    if image_problems:
        print(
            "The Playwright image in .github/workflows/test.yml (tag and "
            "digest), the image CONTRIBUTING.md and doc/development/testing.md "
            "quote and "
            "the @playwright/test version in package-lock.json have to agree.",
            file=sys.stderr,
        )
    if version_problems:
        print(
            "Set the same version in flown/__init__.py and package.json, "
            "then run `npm install` to carry it into package-lock.json.",
            file=sys.stderr,
        )
    if toolchain_problems:
        print(
            "Move .python-version, .nvmrc, the FROM lines of the Dockerfile, "
            "requires-python, the mypy and ruff target versions and the "
            "engines of package.json together.",
            file=sys.stderr,
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
