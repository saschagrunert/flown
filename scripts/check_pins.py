#!/usr/bin/env python3
"""Check what has to agree across files and that no one tool checks: that
uv.lock pins what build-system.requires asks for, that CI and the container
image run the same uv, that the Playwright image is pinned by digest and
matches the pinned library (in every job of the workflow and in the commands
the documentation quotes), that the package version is the same on both
sides of the project, that every file that names the Python or Node.js
version names the same one, and that the gitleaks image of CI is the
release of the pre-commit hook.

Whether uv.lock matches pyproject.toml is uv's to tell: `uv lock --check`
runs in the CI lint job and `make lint`, and `uv sync --locked` fails the
other jobs that install from it. build-system.requires is not part of that:
the build dependency group has uv.lock pin it, and nothing but this script
compares the two. The
version in flown/__init__.py is what `--version` and the wheel report, and
package.json and package-lock.json carry it again for the npm side; nothing
reads all of them, so they drift apart unnoticed until the two sides name
two different versions. Of the pre-commit hooks only gitleaks has a
revision of its own (the linters, formatters and file checks run from the
project environment): the secrets job runs the gitleaks image test.yml
pins, and checks the release it reports against the hook's, but only once
it has pulled the image, so a Dependabot bump of the hook alone fails there
without saying which pin to change. Here the release in the comment of the
image is compared with the hook's, in the lint job. Run by
`make lint` and the CI lint job.
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
# The dependency group of pyproject.toml that has uv.lock pin
# build-system.requires
BUILD_GROUP = "build"
# The composite action that installs uv in CI, and the release it installs:
# the version input of its setup-uv step, up to the next step, quoted or not
# (YAML reads a bare 0.13.0 as a string too)
UV_ACTION = ".github/actions/setup-toolchain/action.yml"
UV_ACTION_VERSION = re.compile(
    r"uses: astral-sh/setup-uv@.*\n(?:(?![ \t]*- ).*\n)*?"
    r"[ \t]+version:[ \t]*([\"']?)([^\"'\s#]+)\1[ \t]*(?:#.*)?$",
    re.MULTILINE,
)
# The uv image of the Dockerfile, with its tag and its digest; the digest is
# optional here so that a missing one is reported as such
DOCKER_UV_IMAGE = re.compile(
    r"^FROM\s+(?:--\S+\s+)*ghcr\.io/astral-sh/uv:([^\s@]+)(@sha256:[0-9a-f]{64})?",
    re.MULTILINE,
)
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
# The workflow whose jobs run the images checked here
WORKFLOW = ".github/workflows/test.yml"
# The gitleaks image of the secrets job, pinned by digest, with its release
# in the comment after it (`# v8.30.1`)
GITLEAKS_IMAGE = re.compile(
    r"^[ \t]*GITLEAKS_IMAGE:[ \t]*ghcr\.io/gitleaks/gitleaks@sha256:[0-9a-f]{64}"
    r"(?:[ \t]*#[ \t]*(\S+))?",
    re.MULTILINE,
)
# The rev of the gitleaks hook of .pre-commit-config.yaml, a commit with its
# release in a "# frozen:" comment (`pre-commit autoupdate --freeze`), or a
# tag; the release is the comment's, or the rev itself without one
PRE_COMMIT_CONFIG = ".pre-commit-config.yaml"
GITLEAKS_HOOK = re.compile(
    r"^[ \t]*-[ \t]*repo:[ \t]*https://github\.com/gitleaks/gitleaks[ \t]*\n"
    r"[ \t]*rev:[ \t]*(\S+)(?:[ \t]*#[ \t]*frozen:[ \t]*(\S+))?",
    re.MULTILINE,
)
# An exact release of Node.js, as .nvmrc names it
EXACT_RELEASE = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
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
    text = (ROOT / WORKFLOW).read_text(encoding="utf-8")
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


def gitleaks_mismatches() -> list[str]:
    """Check the gitleaks image of the secrets job against the hook's rev.

    Dependabot bumps the rev of the pre-commit hook and leaves the image
    alone, whose digest only a person can look up. The secrets job finds
    the two apart only once it has pulled the image. The comment that names
    the image's release is what is compared here, in the lint job, beside
    the other pins; that the digest is that release is still the secrets
    job's to tell.
    """
    problems = []
    image = GITLEAKS_IMAGE.search((ROOT / WORKFLOW).read_text(encoding="utf-8"))
    pinned = image.group(1) if image else None
    if image is None:
        problems.append(f"{WORKFLOW} runs no gitleaks image pinned by its digest")
    elif pinned is None:
        problems.append(
            f"{WORKFLOW} names no release in the comment of its gitleaks image"
        )
    try:
        config = (ROOT / PRE_COMMIT_CONFIG).read_text(encoding="utf-8")
    except OSError as e:
        return [*problems, f"{PRE_COMMIT_CONFIG} cannot be read ({e.strerror or e})"]
    hook = GITLEAKS_HOOK.search(config)
    if hook is None:
        problems.append(f"{PRE_COMMIT_CONFIG} has no gitleaks hook")
        return problems
    release = hook.group(2) or hook.group(1)
    if pinned is not None and pinned.removeprefix("v") != release.removeprefix("v"):
        problems.append(
            f"{WORKFLOW} runs gitleaks {pinned}, the pre-commit hook pins {release}"
        )
    return problems


def toolchain_mismatches(pyproject: dict[str, Any]) -> list[str]:
    """Check every place that names the Python or Node.js version.

    CI sets up the versions of .python-version and .nvmrc, the container
    image builds on the tags of its FROM lines, and pyproject.toml and
    package.json state the oldest version the code is written for. A bump
    of one of them alone passes every job that does not read the others
    (the image kept building on the old Python), so they are compared here.

    .nvmrc names an exact release, not a major version: the gzipped size
    budgets of build.js depend on the zlib Node.js bundles and are nearly
    full, so a new release CI picked up on its own could turn main red
    without a change. ``engines`` asks for its major version or newer.
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
        if not EXACT_RELEASE.fullmatch(node):
            problems.append(
                f".nvmrc names Node.js {node}, not an exact release such as 26.12.0"
            )
        major = node.split(".", 1)[0]
        expected['package.json engines "node"'] = (engines.get("node"), f">={major}")
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


def read_pins() -> dict[str, list[str]]:
    """Map each package uv.lock pins to its versions.

    uv.lock may pin two versions of one package where they resolve apart by
    a marker; the project itself, which it lists without a version, is left
    out.
    """
    with open(ROOT / "uv.lock", "rb") as f:
        lock = tomllib.load(f)
    pins: dict[str, list[str]] = {}
    for package in lock.get("package", []):
        if "version" in package:
            name = canonicalize_name(package["name"])
            pins.setdefault(name, []).append(package["version"])
    return pins


def build_mismatches(pyproject: dict[str, Any]) -> list[str]:
    """Check uv.lock against build-system.requires.

    CI builds the wheel without build isolation, from the build group that
    uv.lock pins. Dependabot raises the range of the group and
    build-system.requires in the same pull request, but a range raised by
    hand in build-system.requires alone that the pin no longer meets would
    build with a setuptools it claims not to work with. A requirement left
    out of the group is not pinned at all. A requirement whose marker does
    not hold here (another platform, an older Python) is skipped, as the
    build here never installs it.
    """
    requires: list[str] = pyproject.get("build-system", {}).get("requires", [])
    if not requires:
        return []
    if not (ROOT / "uv.lock").is_file():
        return ["uv.lock is missing"]
    # An entry may also be a table ({include-group = ...}), which names no
    # package of its own
    group = pyproject.get("dependency-groups", {}).get(BUILD_GROUP, [])
    in_group = {
        canonicalize_name(Requirement(line).name)
        for line in group
        if isinstance(line, str)
    }
    pins = read_pins()
    problems = []
    for line in requires:
        requirement = Requirement(line)
        if requirement.marker is not None and not requirement.marker.evaluate():
            continue
        name = canonicalize_name(requirement.name)
        if name not in in_group:
            problems.append(
                f"the {BUILD_GROUP} dependency group of pyproject.toml does not "
                f"ask for {requirement.name}, which build-system.requires does"
            )
        pinned = pins.get(name, [])
        if not pinned:
            problems.append(f"uv.lock does not pin {requirement.name}")
        problems.extend(
            f"uv.lock pins {requirement.name}=={version}, "
            f'build-system.requires asks for "{line}"'
            for version in pinned
            if not requirement.specifier.contains(version, prereleases=True)
        )
    return problems


def uv_mismatches() -> list[str]:
    """Check that CI and the container image run the same uv.

    Both install from uv.lock, and a uv a release apart may read or resolve
    it differently: the image would then fail to build, or install other
    versions, on a lock CI passed. Dependabot moves neither of the two to
    another release (see dependabot.yml), so they are moved by hand, together.
    """
    problems = []
    try:
        action = (ROOT / UV_ACTION).read_text(encoding="utf-8")
    except OSError as e:
        action = ""
        problems.append(f"{UV_ACTION} cannot be read ({e.strerror or e})")
    match = UV_ACTION_VERSION.search(action)
    ci = match.group(2) if match else None
    if ci is None and action:
        problems.append(f"{UV_ACTION} installs no uv release by version")
    images = DOCKER_UV_IMAGE.findall((ROOT / "Dockerfile").read_text(encoding="utf-8"))
    if not images:
        problems.append("the Dockerfile takes uv from no ghcr.io/astral-sh/uv image")
    for tag, digest in images:
        # A tag alone can be moved to another build; the digest cannot
        if not digest:
            problems.append(
                f"the Dockerfile does not pin the uv image {tag} by its @sha256 digest"
            )
        if ci is not None and tag != ci:
            problems.append(f"the Dockerfile takes uv {tag}, {UV_ACTION} installs {ci}")
    return problems


def main() -> int:
    """Print the mismatches and return the exit status."""
    with open(ROOT / "pyproject.toml", "rb") as f:
        pyproject = tomllib.load(f)
    build_problems = build_mismatches(pyproject)
    uv_problems = uv_mismatches()
    image_problems = playwright_image_mismatches()
    version_problems = version_mismatches()
    toolchain_problems = toolchain_mismatches(pyproject)
    gitleaks_problems = gitleaks_mismatches()

    everything = (
        build_problems
        + uv_problems
        + image_problems
        + version_problems
        + toolchain_problems
        + gitleaks_problems
    )
    if not everything:
        print(
            "uv.lock satisfies build-system.requires, CI and the image run "
            "the same uv, the Playwright image matches, the package version "
            "agrees, the Python and Node.js versions agree and CI runs the "
            "gitleaks of the pre-commit hook."
        )
        return 0
    for problem in everything:
        print(f"error: {problem}", file=sys.stderr)
    if build_problems:
        print(
            f"Ask for every package of build-system.requires in the "
            f"{BUILD_GROUP} dependency group, with a range the pin meets, then run "
            "`uv lock` and commit uv.lock.",
            file=sys.stderr,
        )
    if uv_problems:
        print(
            f"Set the same uv release in {UV_ACTION} and the uv image of the "
            "Dockerfile, with the digest of its multi-arch index.",
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
    if gitleaks_problems:
        print(
            f"Set GITLEAKS_IMAGE in {WORKFLOW} to the release the pre-commit "
            "hook pins: the digest of its multi-arch index, with the release "
            "in the comment after it (see the comment of that step).",
            file=sys.stderr,
        )
    return 1


if __name__ == "__main__":
    sys.exit(main())
