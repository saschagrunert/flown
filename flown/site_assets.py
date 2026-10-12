"""The files the site is made of: the page, its assets and the bundle.

Everything the tool puts next to the data, and nothing about the flights
themselves. ``renderer`` orchestrates the pipeline and calls
``package_assets`` at the end of it; splitting the two apart keeps the
template, the stylesheet, the favicons and the vendored third-party files in
one place, the way ``export_writers`` holds the data files.
"""

import hashlib
import html
import json
import os
import re
import shutil
import string
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import quote

from .cache import atomic_text_write
from .exceptions import FlownError
from .logger import logger
from .previews import PREVIEW_FILE_PATTERNS, PREVIEW_FILES, page_preview_tags

if TYPE_CHECKING:
    from collections.abc import Iterable

    from .geometry import CoordinateExtent

__all__ = [
    "BUNDLE_FILE",
    "BUNDLE_FILES",
    "CODE_FILES",
    "EXTRAS_BUNDLE_FILE",
    "FEATURES_BUNDLE_FILE",
    "FLAGS_DIR_NAME",
    "LOCAL_BUNDLE_FILE",
    "LOCAL_WORKER_BUNDLE_FILE",
    "PYTHON_SOURCES_FILE",
    "SEARCH_BUNDLE_FILE",
    "SHARED_BUNDLE_FILE",
    "SITE_FILES",
    "SITE_FILE_PATTERNS",
    "STATIC_DIR",
    "WRAPPED_BUNDLE_FILE",
    "YEAR_WORKER_BUNDLE_FILE",
    "BuildCommit",
    "available_country_flags",
    "build_commit",
    "build_date",
    "build_time",
    "generator_hash",
    "load_template",
    "minify_html",
    "missing_build_files",
    "package_assets",
    "render_html",
    "warn_about_a_stale_bundle",
]

#: Where the flags live, in the checkout and in a published site alike
FLAGS_DIR_NAME = "flags"


STATIC_DIR = Path(__file__).parent / "static"
TEMPLATES_DIR = Path(__file__).parent / "templates"
# Built by `npm run build` and not committed
BUNDLE_FILE = STATIC_DIR / "mapApp.bundle.js"
# Replay, imported by the page the first time it is opened, and Wrapped, the
# search and the extras (the phone's sheet and the export), likewise
# (frontend/services/featureLoader.ts). Built by the same `npm run build`, so
# a site without them is a site built wrong rather than a choice.
FEATURES_BUNDLE_FILE = STATIC_DIR / "features.bundle.js"
WRAPPED_BUNDLE_FILE = STATIC_DIR / "wrapped.bundle.js"
SEARCH_BUNDLE_FILE = STATIC_DIR / "search.bundle.js"
EXTRAS_BUNDLE_FILE = STATIC_DIR / "extras.bundle.js"
LOCAL_BUNDLE_FILE = STATIC_DIR / "local.bundle.js"
# The app and every module the four lazy bundles above use of it, which all
# five entry points import
SHARED_BUNDLE_FILE = STATIC_DIR / "shared.bundle.js"
# The year worker, which parses and decodes the year files off the main
# thread; the page imports the same file for what it does to year data itself
# (frontend/services/yearWorker.ts). A build of its own in build.js.
YEAR_WORKER_BUNDLE_FILE = STATIC_DIR / "yearWorker.bundle.js"
LOCAL_WORKER_BUNDLE_FILE = STATIC_DIR / "localWorker.bundle.js"
BUNDLE_FILES = (
    BUNDLE_FILE,
    FEATURES_BUNDLE_FILE,
    WRAPPED_BUNDLE_FILE,
    SEARCH_BUNDLE_FILE,
    EXTRAS_BUNDLE_FILE,
    LOCAL_BUNDLE_FILE,
    SHARED_BUNDLE_FILE,
    YEAR_WORKER_BUNDLE_FILE,
    LOCAL_WORKER_BUNDLE_FILE,
)
# The sources of the bundle; only present in a checkout, not in the image
FRONTEND_DIR = Path(__file__).parent / "frontend"
# First line of the bundle; the group is the source hash (scripts/source-hash.js)
BUNDLE_BANNER = re.compile(rb"/\* flown build ([0-9a-f]{12}) \*/")
# Files outside the sources that change what a built site renders, hashed
# after them and in this order. Keep in step with BUILD_FILES in
# scripts/source-hash.js; TestSourceHashParity checks that they agree.
BUILD_HASH_FILES = (
    "build.js",
    "scripts/build-helpers.js",
    "scripts/vendor.js",
    "tsconfig.json",
    "flown/static/styles.css",
    "flown/static/features.css",
    "flown/static/wrapped.css",
    "flown/static/search.css",
    "flown/static/local.css",
)
# Packages whose pinned version changes a built site (the bundler, what it
# bundles and what is vendored as it is), hashed after the files and in this
# order. Keep in step with BUILD_PACKAGES in the same script.
BUILD_HASH_PACKAGES = (
    "esbuild",
    "lucide",
    "maplibre-gl",
    "html-to-image",
    "flag-icons",
)
FAVICON_FILES = (
    "favicon.svg",
    "favicon.ico",
    "favicon-192.png",
    "favicon-512.png",
    "apple-touch-icon.png",
    "manifest.json",
)
# Third-party files the page loads from the site itself, copied out of
# node_modules by scripts/vendor.js and published next to the page. Keep in
# step with VENDOR_FILES there; tests/frontend/unit/vendor.test.ts checks
# that list against node_modules and tests/test_site_assets.py that a
# missing file is caught before a run does any work.
VENDOR_FILES = (
    "maplibre-gl.mjs",
    "maplibre-gl-shared.mjs",
    "maplibre-gl-worker.mjs",
    "maplibre-gl.css",
    # Bundled there from the package's module (VENDOR_MODULES), and imported
    # by the page on the first export
    "html-to-image.mjs",
)
# The stylesheets, in the order the page applies them: styles.css is linked in
# the head, features.css is fetched with the feature bundle the first time
# replay is opened, wrapped.css with the Wrapped bundle the first time
# Wrapped is and search.css with the search bundle the first time the search
# is (see services/featureLoader.ts). The order matters to the cascade, so it
# is the order they are written in; the last three style different elements,
# so which of them lands first does not.
CSS_FILES = ("styles.css", "features.css", "wrapped.css", "search.css", "local.css")
# The Python of this package, zipped, which the page fetches when a visitor
# drops flights on it and runs with Pyodide in a worker (see browser.py and
# frontend/services/localWorker.ts): the build of their flights in their
# browser is the one the site was built with
PYTHON_SOURCES_FILE = "flown-src.zip"
# Written with --private only. No robots.txt: crawlers read it only at the
# origin root, and its Disallow would keep them from fetching the page and
# ever seeing this noindex.
ROBOTS_META = '<meta name="robots" content="noindex, nofollow" />'
# The files the tool owns next to the page. Any of them that a run does not
# produce (the source map of a bundle built without one) is removed.
SITE_FILES = (
    "map_config.js",
    PYTHON_SOURCES_FILE,
    *CSS_FILES,
    *(bundle.name for bundle in BUNDLE_FILES),
    *(f"{bundle.name}.map" for bundle in BUNDLE_FILES),
    *FAVICON_FILES,
    *(f"vendor/{name}" for name in VENDOR_FILES),
    *PREVIEW_FILES,
)
# The owned files no flight decides, which keep the day they were first
# published while they do not change (see SiteOutput): not the page, the
# config or the previews, whose day would date a flight.
CODE_FILES = (
    PYTHON_SOURCES_FILE,
    *CSS_FILES,
    *(bundle.name for bundle in BUNDLE_FILES),
    *(f"{bundle.name}.map" for bundle in BUNDLE_FILES),
    *FAVICON_FILES,
    *(f"vendor/{name}" for name in VENDOR_FILES),
)
# Owned files whose names depend on the flights: the flag of every country
# the export visited, and the link preview of every year and flight (see
# previews). The ones a run does not publish are removed.
SITE_FILE_PATTERNS = (f"{FLAGS_DIR_NAME}/*.svg", *PREVIEW_FILE_PATTERNS)


def load_template() -> str:
    """Load the HTML template from file."""
    template_path = TEMPLATES_DIR / "map_template.html"
    with open(template_path, encoding="utf-8") as f:
        return f.read()


def minify_html(html_content: str) -> str:
    """Minify the HTML page.

    Only the markup: the template has no inline styles or scripts (its CSP
    blocks inline scripts). The stylesheets are minified by the build, and
    the config is written as compact JSON (see ``_generate_map_config``).

    The minifier is imported here, as the stylesheets' one is below: the
    build in the browser (see ``browser``) imports this module for the
    country flags and has neither, nor a page to write.
    """
    import minify_html as mh  # noqa: PLC0415

    minified: str = mh.minify(html_content)
    return minified


def _pinned_build_versions(package_lock: Path) -> list[str]:
    """The versions package-lock.json pins for BUILD_HASH_PACKAGES, as
    source-hash.js reads and writes them ("esbuild 0.28.2")."""
    with package_lock.open(encoding="utf-8") as lock_file:
        lock = json.load(lock_file)
    return [
        f"{name} {lock['packages'][f'node_modules/{name}']['version']}"
        for name in BUILD_HASH_PACKAGES
    ]


def _frontend_source_hash() -> str | None:
    """The hash build.js stamps into the bundle, None without the sources.

    Mirrors scripts/source-hash.js: every .ts file under the frontend
    directory in path order and then each file in BUILD_HASH_FILES, both as
    the path relative to the repository and the content, and finally the
    pinned version of each package in BUILD_HASH_PACKAGES. The build script,
    the vendoring script, the compiler options, the bundler, what it bundles
    from node_modules and what is vendored as it is (the map library, the
    export library, the country flags) shape a built site as much as the
    sources do, so a change to any of them has to invalidate the hash as
    well, and so do the stylesheets: they are not in a bundle, but they are
    part of what a built site renders.

    The two implementations have to agree or the staleness check below is
    meaningless; TestSourceHashParity in tests/test_site_assets.py runs
    the JavaScript one and compares.
    """
    if not FRONTEND_DIR.is_dir():
        return None
    root = FRONTEND_DIR.parent.parent
    digest = hashlib.sha1(usedforsecurity=False)
    try:
        package_versions = _pinned_build_versions(root / "package-lock.json")
        sources = sorted(FRONTEND_DIR.rglob("*.ts"), key=str)
        for path in [*sources, *(root / name for name in BUILD_HASH_FILES)]:
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    except OSError, KeyError, TypeError, ValueError:
        # Not a checkout the bundle could be rebuilt from, so there is
        # nothing to compare the bundle against
        return None
    for version in package_versions:
        digest.update(version.encode())
        digest.update(b"\0")
    return digest.hexdigest()[:12]


def _generator_files(package: Path) -> list[Path]:
    """The files of the generator that shape a site besides the bundles.

    The modules of the package, its templates and the files right in its
    static directory (the stylesheets, the icons, the manifest), but none of
    the bundles or their source maps, which the bundle's own hash covers, nor
    a hidden file such as an editor's swap file. Keep in step with
    ``computeGeneratorHash`` in scripts/source-hash.js.
    """

    def files_in(directory: Path, suffix: str = "") -> list[Path]:
        return [
            path
            for path in directory.iterdir()
            if path.name.endswith(suffix)
            and not path.name.startswith(".")
            and ".bundle.js" not in path.name
            and path.is_file()
        ]

    return [
        *files_in(package, ".py"),
        *files_in(package / "templates"),
        *files_in(package / "static"),
    ]


def generator_hash() -> str:
    """The hash of the generator a site is built with, "" when unreadable.

    ``map_config.js`` carries it next to the commit, and the e2e site check
    (tests/e2e/site-check.ts) compares it with the checkout's, so a site an
    older generator built is refused. It used to compare modification times
    instead, which the build sets to the build day (or older) on purpose
    and so said nothing about which is newer. The SHA-1 of the path, relative
    to the directory of the package, and the content of every file of
    ``_generator_files`` in path order; the same as scripts/source-hash.js
    computes, which TestGeneratorHashParity checks. Holds no date.
    """
    package = Path(__file__).parent
    digest = hashlib.sha1(usedforsecurity=False)
    try:
        files = sorted(
            (path.relative_to(package.parent).as_posix(), path)
            for path in _generator_files(package)
        )
        for name, path in files:
            digest.update(name.encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    except OSError:
        return ""
    return digest.hexdigest()[:12]


def _missing_vendor_files(static_dir: Path) -> list[str]:
    """The vendored third-party files that are not in ``static_dir``."""
    vendor = static_dir / "vendor"
    return [name for name in VENDOR_FILES if not (vendor / name).is_file()]


def missing_build_files() -> list[str]:
    """What `npm run build` produces that is not in place, empty for nothing.

    The bundles and the vendored third-party files: a site missing any of
    them has no map at all. Checked together and before the run does any
    work, so a forgotten build costs a message rather than a full export.

    Asked through this module rather than by reading BUNDLE_FILE elsewhere:
    a `from .site_assets import BUNDLE_FILE` binds the path at import time,
    so a caller that holds its own reference would not see a redirected one.
    """
    missing = [str(bundle) for bundle in BUNDLE_FILES if not bundle.is_file()]
    missing += [f"vendor/{name}" for name in _missing_vendor_files(STATIC_DIR)]
    return missing


def warn_about_a_stale_bundle() -> None:
    """Warn when the bundle was built from other sources than the checkout's.

    An old bundle left over from before a pull reads a data format the new
    generator no longer writes; the page then breaks in ways that are hard to
    trace back to a missing ``npm run build``.
    """
    try:
        current = _frontend_source_hash()
        with BUNDLE_FILE.open("rb") as bundle:
            match = BUNDLE_BANNER.match(bundle.readline())
    except OSError:
        return
    if current is not None and (match is None or match.group(1).decode() != current):
        logger.warning(
            "The JavaScript bundle was built from other frontend sources; "
            "run 'npm run build' to rebuild it"
        )


#: The base style the app fetches (CARTO_STYLE_URL in baseStyle.ts), and the
#: index of the vector tiles it names, which MapLibre asks for next
CARTO_STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"
CARTO_TILEJSON_URL = (
    "https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json"
)


def _carto_api_key() -> str:
    """The CARTO API key the site is built with, "" for none."""
    return os.environ.get("CARTO_API_KEY", "")


def _carto_preloads(api_key: str) -> str:
    """Preloads of CARTO's style and tile index, as the page asks for them.

    Without them each is a round trip that only starts once the one before
    has answered: the page's scripts, the map's start, the style and then
    the index. A preload is only used for the very same URL, so the key goes
    on as the page puts it on (encodeURIComponent, see cartoStyleUrl and
    cartoTransformRequest in baseStyle.ts), and none goes on without one.
    """
    # encodeURIComponent leaves these as they are, and quote() does not
    query = "?key=" + quote(api_key, safe="!*'()") if api_key else ""
    return "".join(
        '<link rel="preload" as="fetch" crossorigin '
        f'href="{html.escape(url + query)}" />'
        for url in (CARTO_STYLE_URL, CARTO_TILEJSON_URL)
    )


def render_html(
    output_file: Path,
    data_dir_name: str,
    latest_year: int | None = None,
    site_url: str | None = None,
    private: bool = False,
) -> None:
    """Render and minify the HTML template.

    ``latest_year`` is the year the page opens on, whose data file is
    preloaded and which the year filter shows from the first paint (the
    page adds the other years once it has read the metadata); None
    preloads nothing and leaves the filter on all years. CARTO's style and
    tile index are preloaded after the site's own files. ``site_url`` is
    where the site is published (see ``previews.normalize_site_url``),
    which the link preview of the page is named by; None leaves the image
    out. ``private`` asks search engines not to index the page.
    """
    logger.info("\nGenerating progressive HTML...")

    data_dir = html.escape(data_dir_name)
    # Low priority: the page's own scripts and styles decide when the map
    # starts, and the year file is only read once they have run
    year_preload = (
        f'<link rel="preload" as="fetch" crossorigin fetchpriority="low" '
        f'href="{data_dir}/{latest_year}/data.json" />'
        if latest_year is not None
        else ""
    )
    # It showed "All years" until the metadata was in, and then the year
    year_option = (
        f'<option value="{latest_year}" selected>{latest_year}</option>'
        if latest_year is not None
        else ""
    )
    tmpl = string.Template(load_template())
    html_content = tmpl.substitute(
        data_dir_name=data_dir,
        year_preload=year_preload,
        year_option=year_option,
        base_style_preload=_carto_preloads(_carto_api_key()),
        link_preview=page_preview_tags(site_url),
        robots=ROBOTS_META if private else "",
    )

    logger.info("\nMinifying HTML...")
    minified_html = minify_html(html_content)

    atomic_text_write(output_file, minified_html)

    file_size = output_file.stat().st_size
    original_size = len(html_content)
    minified_size = len(minified_html)
    reduction = (1 - minified_size / original_size) * 100

    logger.info(
        "Progressive HTML saved: %s (%.1f KB)", output_file.name, file_size / 1024
    )
    logger.info(
        "  Minification: %.1f KB -> %.1f KB (%.1f%% reduction)",
        original_size / 1024,
        minified_size / 1024,
        reduction,
    )


def build_time() -> datetime:
    """When the site is built, in UTC; SOURCE_DATE_EPOCH if it is set."""
    epoch = os.environ.get("SOURCE_DATE_EPOCH", "").strip()
    try:
        built_at = datetime.fromtimestamp(int(epoch), UTC) if epoch else None
    except ValueError, OverflowError, OSError:
        logger.warning("Ignoring SOURCE_DATE_EPOCH=%r: not a Unix timestamp", epoch)
        built_at = None
    return built_at or datetime.now(UTC)


def build_date(built_at: datetime | None = None) -> str:
    """The day the site was built, in UTC ("2026-09-21").

    Not the time: a site built right after a flight would give the time of
    day of that flight away, which the flights themselves no longer carry.
    The day of ``built_at``, else of ``build_time``, which honours
    SOURCE_DATE_EPOCH so that a build can be reproduced exactly.
    """
    return (built_at or build_time()).astimezone(UTC).strftime("%Y-%m-%d")


# A commit hash as git prints it, and the parts of a repository address
_COMMIT_HASH = re.compile(r"[0-9a-f]{7,40}")
_GITHUB_REMOTE = re.compile(
    r"(?:https://|ssh://git@|git@)github\.com[:/]"
    r"(?P<repository>[\w.-]+/[\w.-]+?)(?:\.git)?/?"
)
_SERVER_URL = re.compile(r"https://[\w.-]+(?::\d+)?")
_REPOSITORY_NAME = re.compile(r"[\w.-]+/[\w.-]+")


@dataclass(frozen=True)
class BuildCommit:
    """The commit a site was built from and where it can be looked at."""

    #: Short hash, "" when unknown
    hash: str = ""
    #: The commit's page, "" when it is not known which repository it is in
    url: str = ""


def _build_commit(commit: str, repository_url: str) -> BuildCommit:
    commit = commit.strip().lower()
    if not _COMMIT_HASH.fullmatch(commit):
        return BuildCommit()
    url = f"{repository_url}/commit/{commit}" if repository_url else ""
    return BuildCommit(commit[:7], url)


def _github_repository_url(remote: str) -> str:
    """The web address of a GitHub remote, "" for any other remote."""
    match = _GITHUB_REMOTE.fullmatch(remote.strip())
    if match is None:
        return ""
    return f"https://github.com/{match['repository']}"


def _git(git: str, *args: str) -> str:
    """Run git in the package directory and return what it printed."""
    return subprocess.run(  # noqa: S603
        [git, *args],
        cwd=Path(__file__).parent,
        capture_output=True,
        text=True,
        timeout=5,
        check=True,
    ).stdout.strip()


def _commit_from_git() -> BuildCommit:
    """HEAD of the checkout the package runs from, if it runs from one.

    Only a repository whose top level holds this package counts: an
    installed package can sit in a virtual environment inside some other
    checkout, whose HEAD says nothing about this build.
    """
    git = shutil.which("git")
    if git is None:
        return BuildCommit()
    try:
        toplevel = _git(git, "rev-parse", "--show-toplevel")
        if Path(toplevel).resolve() != Path(__file__).parent.parent.resolve():
            return BuildCommit()
        commit = _git(git, "rev-parse", "HEAD")
    except OSError, subprocess.SubprocessError:
        return BuildCommit()
    try:
        remote = _git(git, "remote", "get-url", "origin")
    except OSError, subprocess.SubprocessError:
        remote = ""
    return _build_commit(commit, _github_repository_url(remote))


def build_commit() -> BuildCommit:
    """The commit the site was built from.

    FLOWN_COMMIT wins, with FLOWN_REPOSITORY as the remote it is
    in (the container has no .git, so `make build` passes both). Then
    GITHUB_SHA on Actions, in the repository the workflow runs in, which is
    not necessarily this project's. Then git, if the package runs from a
    checkout. The hash is only linked when the repository is known.
    """
    explicit = os.environ.get("FLOWN_COMMIT", "")
    if explicit:
        remote = os.environ.get("FLOWN_REPOSITORY", "")
        return _build_commit(explicit, _github_repository_url(remote))
    sha = os.environ.get("GITHUB_SHA", "")
    repository = os.environ.get("GITHUB_REPOSITORY", "")
    if sha and repository:
        server = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
        known = _SERVER_URL.fullmatch(server) and _REPOSITORY_NAME.fullmatch(repository)
        return _build_commit(sha, f"{server}/{repository}" if known else "")
    return _commit_from_git()


def _generate_map_config(
    output_dir: Path,
    extent: CoordinateExtent,
    data_dir_name: str,
    built_at: datetime | None = None,
) -> None:
    """Write map_config.js: one statement that sets window.MAP_CONFIG to a
    JSON object, so no value can end a string literal early. ``built_at``
    gives the build date (see ``build_date``)."""
    carto_api_key = _carto_api_key()
    map_config_dst = output_dir / "map_config.js"

    commit = build_commit()
    # The fields MapConfig in the frontend's mapApp.ts reads
    config = {
        "center": [extent.center_lat, extent.center_lon],
        "bounds": [
            [extent.min_lat, extent.min_lon],
            [extent.max_lat, extent.max_lon],
        ],
        "cartoApiKey": carto_api_key,
        "dataDir": data_dir_name,
        "builtOn": build_date(built_at),
        "commit": commit.hash,
        "commitUrl": commit.url,
        # Not read by the page: the e2e site check compares it
        "generator": generator_hash(),
    }
    # ASCII only, so the file reads the same whatever charset it is served as
    config_json = json.dumps(config, ensure_ascii=True, separators=(",", ":"))
    atomic_text_write(map_config_dst, f"window.MAP_CONFIG={config_json};")

    map_config_size = map_config_dst.stat().st_size
    logger.info(
        "Configuration generated: %s (%.1f KB)",
        map_config_dst.name,
        map_config_size / 1024,
    )


def _copy_javascript_bundle(output_dir: Path, bundle: Path) -> None:
    """Copy one bundle (and its source map, if any) to the output."""
    dst = output_dir / bundle.name
    shutil.copy2(bundle, dst)
    logger.info("JavaScript copied: %s (%.1f KB)", dst.name, dst.stat().st_size / 1024)
    source_map = bundle.with_name(f"{bundle.name}.map")
    if source_map.exists():
        shutil.copy2(source_map, output_dir / source_map.name)


def _copy_and_minify_css(output_dir: Path, static_dir: Path) -> None:
    """Copy and minify every stylesheet to the output directory."""
    import rcssmin  # noqa: PLC0415

    for name in CSS_FILES:
        with open(static_dir / name, encoding="utf-8") as f:
            content = f.read()

        destination = output_dir / name
        minified: str = rcssmin.cssmin(content)
        atomic_text_write(destination, minified)

        logger.info("CSS copied: %s (%.1f KB)", name, destination.stat().st_size / 1024)


def _copy_vendor_files(output_dir: Path, static_dir: Path) -> None:
    """Copy the vendored third-party files to the output.

    They are a build output like the bundle: `npm run build` fills
    static/vendor/ from node_modules. A site generated without them has no
    map at all, so a missing directory is an error rather than a warning.
    """
    vendor_src = static_dir / "vendor"
    missing = _missing_vendor_files(static_dir)
    if missing:
        raise FlownError(
            f"The vendored third-party files are missing ({', '.join(missing)}); "
            "run 'npm run build' to copy them out of node_modules"
        )

    total = 0
    for name in VENDOR_FILES:
        dst = output_dir / "vendor" / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(vendor_src / name, dst)
        total += dst.stat().st_size
    logger.info(
        "Vendored files copied: %d files (%.1f KB)", len(VENDOR_FILES), total / 1024
    )


def _write_python_sources(output_dir: Path, package: Path | None = None) -> None:
    """Zip the package's Python modules into the site (PYTHON_SOURCES_FILE).

    Written the same for the same sources: the entries in name order, with
    one fixed time stamp, so the file keeps its day in the site while the
    package does not change (see CODE_FILES). The frontend, the template and
    the static files are not in it: the page has them already.
    """
    package = package if package is not None else Path(__file__).parent
    target = output_dir / PYTHON_SOURCES_FILE
    with tempfile.NamedTemporaryFile(
        dir=output_dir, prefix=f".{PYTHON_SOURCES_FILE}.", suffix=".tmp", delete=False
    ) as handle:
        temp = Path(handle.name)
    try:
        with zipfile.ZipFile(
            temp, "w", zipfile.ZIP_DEFLATED, compresslevel=9
        ) as archive:
            for source in sorted(package.glob("*.py")):
                info = zipfile.ZipInfo(f"{package.name}/{source.name}")
                info.date_time = (1980, 1, 1, 0, 0, 0)
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, source.read_bytes())
        temp.replace(target)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise
    logger.info(
        "Python sources packed: %s (%.1f KB)",
        PYTHON_SOURCES_FILE,
        target.stat().st_size / 1024,
    )


def _copy_favicon_files(output_dir: Path, static_dir: Path) -> None:
    """Copy favicon and manifest files to output directory."""
    for favicon_file in FAVICON_FILES:
        src = static_dir / favicon_file
        if src.exists():
            shutil.copy2(src, output_dir / favicon_file)

    logger.info("Favicon files copied")


def available_country_flags(codes: Iterable[str]) -> list[str]:
    """The given country codes that this checkout can publish a flag for.

    `npm run build` fills ``static/flags/`` from node_modules, and the wheel
    leaves it out: two megabytes of flags for the handful of countries any
    one export visits would be a poor trade. A site built without them shows
    the country code instead, so this returns what is actually there rather
    than what was asked for.
    """
    flag_dir = STATIC_DIR / FLAGS_DIR_NAME
    return sorted(
        {code.lower() for code in codes if (flag_dir / f"{code.lower()}.svg").is_file()}
    )


def _copy_country_flags(output_dir: Path, codes: Iterable[str]) -> None:
    """Publish the flag of every country the export visited, and no other."""
    published = available_country_flags(codes)
    if not published:
        return

    destination = output_dir / FLAGS_DIR_NAME
    destination.mkdir(parents=True, exist_ok=True)
    total = 0
    for code in published:
        target = destination / f"{code}.svg"
        shutil.copy2(STATIC_DIR / FLAGS_DIR_NAME / f"{code}.svg", target)
        total += target.stat().st_size
    logger.info("Country flags copied: %d (%.1f KB)", len(published), total / 1024)


def package_assets(
    output_dir: Path,
    extent: CoordinateExtent,
    data_dir_name: str,
    country_codes: Iterable[str] = (),
    built_at: datetime | None = None,
) -> None:
    """Generate config and copy static assets (pre-built JS bundles, CSS, icons).

    ``extent`` is what the map opens on (see ``geometry.CoordinateExtent``),
    ``built_at`` the time of the build, ``build_time`` by default.
    """
    _generate_map_config(output_dir, extent, data_dir_name, built_at)
    for bundle in BUNDLE_FILES:
        _copy_javascript_bundle(output_dir, bundle)
    _copy_and_minify_css(output_dir, STATIC_DIR)
    _copy_vendor_files(output_dir, STATIC_DIR)
    _write_python_sources(output_dir)
    _copy_favicon_files(output_dir, STATIC_DIR)
    _copy_country_flags(output_dir, country_codes)
