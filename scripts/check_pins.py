#!/usr/bin/env python3
"""Check what has to agree across files and that no one tool checks: that
uv.lock pins what build-system.requires asks for, that no
exclude-newer-package entry of pyproject.toml has fallen behind the cutoff
of exclude-newer, that CI and the container image run the same uv, that the
Playwright image is pinned by digest and matches the pinned library (the
workflow and the commands the documentation quotes read it from one file),
that the package version is the same on both sides of the project, that
every file that names the Python or Node.js version names the same one, and
that the gitleaks image of CI is the release of the pre-commit hook.

With --online it also asks the registries whether the digest of each of the
two images is still the one of its tag, which a tag edited by hand alone
leaves behind: docker pulls by the digest, whatever the tag next to it says.
A registry that cannot be reached is a warning, not a failure. --fix writes
the tag the library and the hook ask for into the two image files, with the
digest the registry gives for it, then checks as --online does.

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
project environment): the secrets job runs the gitleaks image of its
Dockerfile, and checks the release it reports against the hook's, but only
once it has pulled the image, so a hook edited alone fails there without
saying which pin to change. Here the tag of the image is compared
with the hook's release, in the lint job. Run by `make lint` and the CI lint
job, both with --online.
"""

import argparse
import functools
import http.client
import json
import re
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, date, datetime, timedelta
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
# The images the jobs of the test workflow run, each the FROM line of a
# Dockerfile of its own, which nothing builds: the jobs and the documented
# commands read the reference from there, so it is written in one place, and
# Dependabot's docker ecosystem can bump the tag and the digest together
# (see dependabot.yml)
PLAYWRIGHT_DOCKERFILE = ".github/images/playwright/Dockerfile"
GITLEAKS_DOCKERFILE = ".github/images/gitleaks/Dockerfile"
# The reference of such a Dockerfile, its only FROM line
IMAGE_FROM = re.compile(r"^FROM[ \t]+(\S+)[ \t]*$", re.MULTILINE)
# A reference in full, registry/repository:tag@digest; the digest is
# optional here so that a missing or malformed one is reported as such
IMAGE_REFERENCE = re.compile(
    r"(?P<registry>[^/\s]+)/(?P<repository>[^:@\s]+):(?P<tag>[^@\s]+)"
    r"(?:@(?P<digest>sha256:[0-9a-f]{64}))?"
)
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
# The gitleaks image of the secrets job, by tag and digest
GITLEAKS_IMAGE = re.compile(
    r"ghcr\.io/gitleaks/gitleaks:([^@\s]+)(?:@(sha256:[0-9a-f]{64}))?"
)
# What a registry may answer for a tag: the index of a multi-arch image, or
# the manifest of an image of one platform
MANIFEST_TYPES = ", ".join(
    (
        "application/vnd.oci.image.index.v1+json",
        "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json",
        "application/vnd.docker.distribution.manifest.v2+json",
    )
)
# How long a registry gets to answer, in seconds
REGISTRY_TIMEOUT = 15
# The challenge of a registry that wants an anonymous token first (ghcr.io,
# Docker Hub): Bearer realm="...",service="...",scope="..."
BEARER_CHALLENGE = re.compile(r'(\w+)="([^"]*)"')
# A span of [tool.uv] exclude-newer ("7 days", "1 week", "24 hours"), or
# the same as an ISO 8601 duration (P7D, P1W, PT24H)
EXCLUDE_NEWER_SPAN = re.compile(r"(\d+)\s*(hour|day|week)s?", re.IGNORECASE)
ISO_SPAN = re.compile(r"P(?:(\d+)W|(\d+)D|T(\d+)H)", re.IGNORECASE)
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


def read_image(dockerfile: str) -> tuple[str | None, list[str]]:
    """The image reference of one of the image files, and what is wrong.

    The file holds a single FROM line: a second one would leave it unclear
    which of the two the jobs run.
    """
    try:
        text = (ROOT / dockerfile).read_text(encoding="utf-8")
    except OSError as e:
        return None, [f"{dockerfile} cannot be read ({e.strerror or e})"]
    references = IMAGE_FROM.findall(text)
    if len(references) != 1:
        return None, [
            f"{dockerfile} has {len(references)} FROM lines, not the one image"
        ]
    return references[0], []


def workflow_reads(dockerfile: str, image: re.Pattern[str]) -> list[str]:
    """Check that the workflow takes an image from its file alone.

    A reference written into the workflow as well is a second place to
    bump, which Dependabot does not know about.
    """
    text = (ROOT / WORKFLOW).read_text(encoding="utf-8")
    problems = []
    if dockerfile not in text:
        problems.append(f"{WORKFLOW} does not read its image from {dockerfile}")
    problems.extend(
        f"{WORKFLOW} names the image {quoted} itself instead of reading {dockerfile}"
        for quoted in dict.fromkeys(match.group(0) for match in image.finditer(text))
    )
    return problems


def playwright_image_mismatches() -> list[str]:
    """Check the Playwright container against the pinned @playwright/test.

    The visual job compares screenshots inside that image, and the committed
    snapshots were generated in it; the e2e jobs run in it too. An image a
    version ahead of the library renders differently, which reads as a page
    regression rather than as the version drift it is.
    """
    image, problems = read_image(PLAYWRIGHT_DOCKERFILE)
    pinned = read_npm_version("@playwright/test")
    if pinned is None:
        problems.append("package-lock.json does not pin @playwright/test")
    if image is not None:
        match = PLAYWRIGHT_IMAGE.fullmatch(image)
        # A tag alone can be moved to another build; the digest cannot
        if match is None or match.group(2) is None:
            problems.append(
                f"{PLAYWRIGHT_DOCKERFILE} does not pin the Playwright image "
                f"{image} by its @sha256 digest"
            )
        if match is not None and pinned is not None and match.group(1) != pinned:
            problems.append(
                f"{PLAYWRIGHT_DOCKERFILE} names the Playwright image "
                f"v{match.group(1)}, package-lock.json pins {pinned}"
            )
    problems.extend(workflow_reads(PLAYWRIGHT_DOCKERFILE, PLAYWRIGHT_IMAGE_REFERENCE))
    # The documented commands are how the snapshots get regenerated, so an
    # image other than the one CI compares in produces snapshots that fail.
    # They read the image file as the jobs do; one that quotes the image has
    # to quote that one. A document that is gone, or no longer names the
    # file, is reported too: skipped, a move of the command to another page
    # left it unchecked.
    for name in PLAYWRIGHT_IMAGE_DOCS:
        path = ROOT / name
        if not path.is_file():
            problems.append(f"{name} is missing")
            continue
        text = path.read_text(encoding="utf-8")
        if PLAYWRIGHT_DOCKERFILE not in text:
            problems.append(f"{name} does not run the image of {PLAYWRIGHT_DOCKERFILE}")
        problems.extend(
            f"{name} quotes the Playwright image {quoted}, "
            f"{PLAYWRIGHT_DOCKERFILE} names {image}"
            for quoted in PLAYWRIGHT_IMAGE_REFERENCE.findall(text)
            if quoted != image
        )
    return problems


def read_gitleaks_release() -> tuple[str | None, list[str]]:
    """The gitleaks release the pre-commit hook pins, and what is wrong."""
    try:
        config = (ROOT / PRE_COMMIT_CONFIG).read_text(encoding="utf-8")
    except OSError as e:
        return None, [f"{PRE_COMMIT_CONFIG} cannot be read ({e.strerror or e})"]
    hook = GITLEAKS_HOOK.search(config)
    if hook is None:
        return None, [f"{PRE_COMMIT_CONFIG} has no gitleaks hook"]
    return hook.group(2) or hook.group(1), []


def gitleaks_mismatches() -> list[str]:
    """Check the gitleaks image of the secrets job against the hook's rev.

    Dependabot bumps the rev of the pre-commit hook and the image in the
    same pull request (a multi-ecosystem group, see dependabot.yml), but a
    hand edit of one of them still drifts. The secrets job finds the two
    apart only once it has pulled the image; here the tag of the image is
    compared with the hook's release, in the lint job, beside the other
    pins. That the digest is that release is --online's to tell, and the
    secrets job's.
    """
    image, problems = read_image(GITLEAKS_DOCKERFILE)
    pinned = None
    if image is not None:
        match = GITLEAKS_IMAGE.fullmatch(image)
        if match is None or match.group(2) is None:
            problems.append(
                f"{GITLEAKS_DOCKERFILE} does not pin the gitleaks image {image} "
                "by its tag and @sha256 digest"
            )
        if match is not None:
            pinned = match.group(1)
    problems.extend(workflow_reads(GITLEAKS_DOCKERFILE, GITLEAKS_IMAGE))
    release, hook_problems = read_gitleaks_release()
    problems.extend(hook_problems)
    if (
        pinned is not None
        and release is not None
        and pinned.removeprefix("v") != release.removeprefix("v")
    ):
        problems.append(
            f"{GITLEAKS_DOCKERFILE} runs gitleaks {pinned}, the pre-commit hook "
            f"pins {release}"
        )
    return problems


def parse_cutoff(value: str, now: datetime) -> datetime | None:
    """The moment an exclude-newer value stands for: a date or a timestamp
    as it is (UTC unless it says otherwise), a span counted back from now.
    None for what neither reads."""
    span = EXCLUDE_NEWER_SPAN.fullmatch(value.strip())
    if span:
        amount, unit = int(span.group(1)), span.group(2).lower()
        return now - timedelta(**{f"{unit}s": amount})
    iso = ISO_SPAN.fullmatch(value.strip())
    if iso:
        weeks, days, hours = (int(group or 0) for group in iso.groups())
        return now - timedelta(weeks=weeks, days=days, hours=hours)
    try:
        moment = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _as_text(value: object) -> str | None:
    """An exclude-newer value as text: a string as it is, a TOML date or
    timestamp in ISO 8601, anything else (false) None."""
    if isinstance(value, str):
        return value
    if isinstance(value, date):
        return value.isoformat()
    return None


def exclude_newer_mismatches(
    pyproject: dict[str, Any], now: datetime | None = None
) -> list[str]:
    """Check that every exclude-newer-package entry still lets a release in.

    An entry with a date lets its package take a release younger than the
    cutoff of exclude-newer, such as a security fix that cannot wait for it.
    Once the cutoff passes that date the entry holds the package further
    back than every other: each release after the date stays out of uv.lock
    for good, and Dependabot's bumps of it fail to lock or open nothing,
    without an error anywhere. An entry the cutoff has passed is reported
    so that it is removed.
    """
    uv = pyproject.get("tool", {}).get("uv", {})
    entries = uv.get("exclude-newer-package", {})
    if not entries or "exclude-newer" not in uv:
        return []
    now = now or datetime.now(UTC)
    # A value written as a TOML date rather than a string reads as one
    window = _as_text(uv["exclude-newer"])
    cutoff = parse_cutoff(window, now) if window is not None else None
    if cutoff is None:
        setting = uv["exclude-newer"]
        return [f'pyproject.toml: [tool.uv] exclude-newer "{setting}" cannot be read']
    problems = []
    for name, entry in entries.items():
        value = _as_text(entry)
        # false and the like take a package out of the cutoff; no date to pass
        if value is None:
            continue
        moment = parse_cutoff(value, now)
        if moment is None:
            problems.append(
                f'pyproject.toml: exclude-newer-package "{name} = {value}" '
                "cannot be read"
            )
        elif moment < cutoff:
            problems.append(
                f"pyproject.toml: exclude-newer-package holds {name} at {value}, "
                f'which the cutoff of exclude-newer ("{window}", now '
                f"{cutoff:%Y-%m-%d %H:%M} UTC) has passed: it keeps every newer "
                f"release of {name} out"
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
                f".nvmrc names Node.js {node}, not an exact release such as 26.12.1"
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


def head_digest(url: str, headers: dict[str, str]) -> str:
    """The Docker-Content-Digest a registry answers a HEAD request with.
    The URL is always https://, built by registry_digest."""
    request = urllib.request.Request(url, method="HEAD", headers=headers)  # noqa: S310
    with urllib.request.urlopen(request, timeout=REGISTRY_TIMEOUT) as response:  # noqa: S310
        digest = response.headers.get("Docker-Content-Digest")
    if not digest:
        raise OSError(f"{url} answered without a Docker-Content-Digest")
    return str(digest)


def registry_digest(reference: str) -> str:
    """The digest the registry gives for the tag of an image reference.

    Anonymous: a registry that wants a token first (ghcr.io, Docker Hub)
    names where to get one in its challenge, and hands one out for a
    public image without credentials. Raises LookupError when the registry
    does not know the tag, OSError when it cannot be reached.
    """
    match = IMAGE_REFERENCE.fullmatch(reference)
    if match is None:
        raise LookupError(f"{reference} is no registry/repository:tag reference")
    registry = match.group("registry")
    host = "registry-1.docker.io" if registry == "docker.io" else registry
    url = (
        f"https://{host}/v2/{match.group('repository')}/manifests/{match.group('tag')}"
    )
    headers = {"Accept": MANIFEST_TYPES}
    try:
        try:
            return head_digest(url, headers)
        except urllib.error.HTTPError as e:
            challenge = e.headers.get("WWW-Authenticate", "")
            if e.code != 401 or not challenge.lower().startswith("bearer"):
                raise
            e.close()
        params = dict(BEARER_CHALLENGE.findall(challenge))
        realm = params.pop("realm", "")
        if not realm.startswith("https://"):
            raise OSError(f"{registry} asks for a token from {realm or 'nowhere'}")
        token_url = f"{realm}?{urllib.parse.urlencode(params)}"
        # https:// only, checked above
        with urllib.request.urlopen(  # noqa: S310
            token_url, timeout=REGISTRY_TIMEOUT
        ) as response:
            answer = json.load(response)
        token = answer.get("token") or answer.get("access_token")
        if not token:
            raise OSError(f"{realm} handed out no token")
        return head_digest(url, {**headers, "Authorization": f"Bearer {token}"})
    except urllib.error.HTTPError as e:
        e.close()
        # The tag is unknown only when the manifest is: a token service that
        # answers 404 is the registry's trouble, not the reference's
        if e.code == 404 and e.filename == url:
            raise LookupError(f"{registry} has no {reference}") from None
        raise OSError(f"{e.filename} answered {e.code}") from None
    except (ValueError, http.client.HTTPException) as e:
        # A token answer that is no JSON, or a response cut short: the
        # registry could not be asked, as with one that cannot be reached
        raise OSError(f"{registry} answered what cannot be read ({e!r})") from None


def wanted_references() -> dict[str, str]:
    """Each image file, with the reference without a digest that it should
    name: the Playwright image of the pinned library, the gitleaks image of
    the hook's release. A file, library or hook that cannot be read is left
    out, which the other checks report."""
    wanted = {}
    image, _ = read_image(PLAYWRIGHT_DOCKERFILE)
    pinned = read_npm_version("@playwright/test")
    match = IMAGE_REFERENCE.fullmatch(image) if image else None
    suffix = re.fullmatch(r"v[^-]+(-.+)", match.group("tag")) if match else None
    if match is not None and suffix is not None and pinned is not None:
        wanted[PLAYWRIGHT_DOCKERFILE] = (
            f"{match.group('registry')}/{match.group('repository')}:"
            f"v{pinned}{suffix.group(1)}"
        )
    image, _ = read_image(GITLEAKS_DOCKERFILE)
    release, _ = read_gitleaks_release()
    match = IMAGE_REFERENCE.fullmatch(image) if image else None
    if match is not None and release is not None:
        prefix = "v" if match.group("tag").startswith("v") else ""
        wanted[GITLEAKS_DOCKERFILE] = (
            f"{match.group('registry')}/{match.group('repository')}:"
            f"{prefix}{release.removeprefix('v')}"
        )
    return wanted


def digest_mismatches() -> tuple[list[str], list[str]]:
    """Check the digest of each image file against its registry.

    The jobs pull by the digest, so a tag edited by hand alone keeps the
    old image running: in a bump of @playwright/test whose browsers did
    not change, every check passed against the release before. Returns the
    problems, and the warnings for a registry that could not be reached.
    """
    problems, warnings = [], []
    for dockerfile in (PLAYWRIGHT_DOCKERFILE, GITLEAKS_DOCKERFILE):
        image, _ = read_image(dockerfile)
        match = IMAGE_REFERENCE.fullmatch(image) if image else None
        if match is None or match.group("digest") is None:
            continue
        reference = image.split("@", 1)[0] if image else ""
        try:
            digest = registry_digest(reference)
        except LookupError as e:
            problems.append(f"{dockerfile}: {e}")
            continue
        except OSError as e:
            warnings.append(
                f"{dockerfile}: the digest of {reference} was not checked ({e})"
            )
            continue
        if digest != match.group("digest"):
            problems.append(
                f"{dockerfile} pins {reference} by {match.group('digest')}, the "
                f"registry gives {digest} for that tag"
            )
    return problems, warnings


def fix_images() -> tuple[list[str], list[str]]:
    """Write the tag each image file should name, with its digest.

    Returns what was changed, and the warnings for a registry that could
    not be reached or does not know the tag (that file is left as it was).
    """
    changed, warnings = [], []
    for dockerfile, reference in wanted_references().items():
        try:
            digest = registry_digest(reference)
        except (LookupError, OSError) as e:
            warnings.append(f"{dockerfile} was not updated ({e})")
            continue
        path = ROOT / dockerfile
        text = path.read_text(encoding="utf-8")
        pinned = f"{reference}@{digest}"
        updated = IMAGE_FROM.sub(f"FROM {pinned}", text, count=1)
        if updated != text:
            path.write_text(updated, encoding="utf-8")
            changed.append(f"{dockerfile} now runs {pinned}")
    return changed, warnings


def main(argv: list[str] | None = None) -> int:
    """Print the mismatches and return the exit status."""
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    parser.add_argument(
        "--online",
        action="store_true",
        help="also check the digest of each image against its registry",
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="write the tag the library and the hook ask for into the image "
        "files, with its digest, then check as --online does",
    )
    args = parser.parse_args([] if argv is None else argv)
    warnings: list[str] = []
    if args.fix:
        changed, warnings = fix_images()
        for line in changed:
            print(line)
    with open(ROOT / "pyproject.toml", "rb") as f:
        pyproject = tomllib.load(f)
    build_problems = build_mismatches(pyproject)
    cutoff_problems = exclude_newer_mismatches(pyproject)
    uv_problems = uv_mismatches()
    image_problems = playwright_image_mismatches()
    version_problems = version_mismatches()
    toolchain_problems = toolchain_mismatches(pyproject)
    gitleaks_problems = gitleaks_mismatches()
    digest_problems: list[str] = []
    if args.online or args.fix:
        digest_problems, digest_warnings = digest_mismatches()
        warnings += digest_warnings
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)

    everything = (
        build_problems
        + cutoff_problems
        + uv_problems
        + image_problems
        + version_problems
        + toolchain_problems
        + gitleaks_problems
        + digest_problems
    )
    if not everything:
        print(
            "uv.lock satisfies build-system.requires, the exclude-newer entries "
            "are current, CI and the image run the same uv, the Playwright "
            "image matches, the package version agrees, the Python and Node.js "
            "versions agree and CI runs the gitleaks of the pre-commit hook"
            + (
                ", each image by the digest of its tag."
                if (args.online or args.fix) and not warnings
                else "."
            )
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
    if cutoff_problems:
        print(
            "Remove the exclude-newer-package entries of pyproject.toml that the "
            "cutoff has passed, with their comment, then run `uv lock`, which "
            "keeps every pin (`make lock` would move every package as well).",
            file=sys.stderr,
        )
    if uv_problems:
        print(
            f"Set the same uv release in {UV_ACTION} and the uv image of the "
            "Dockerfile, with the digest of its multi-arch index.",
            file=sys.stderr,
        )
    if image_problems or digest_problems:
        print(
            f"The Playwright image of {PLAYWRIGHT_DOCKERFILE} (tag and digest) "
            "and the @playwright/test version in package-lock.json have to "
            "agree, and the gitleaks image of "
            f"{GITLEAKS_DOCKERFILE} and the hook's release likewise: "
            "`python scripts/check_pins.py --fix` writes the tags with their "
            "digests.",
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
            f"Set the image of {GITLEAKS_DOCKERFILE} to the release the "
            "pre-commit hook pins, with the digest of its multi-arch index "
            "(`python scripts/check_pins.py --fix`).",
            file=sys.stderr,
        )
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
