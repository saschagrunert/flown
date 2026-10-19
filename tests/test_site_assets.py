"""Tests for the site_assets module: the page, its assets and the bundle."""

import json
import os
import re
import shutil
import string
import subprocess
import time
import zipfile
from pathlib import Path
from unittest.mock import patch

import pytest

import flown.site_assets as assets_module
from flown.geometry import CoordinateExtent
from flown.site_assets import (
    BuildCommit,
    _copy_javascript_bundle,
    _generate_map_config,
    build_commit,
    build_date,
    load_template,
    minify_html,
    package_assets,
    render_html,
)
from tests.conftest import missing_frontend_build, pytest_terminal_summary


def _install_vendor_files(tmp_path, monkeypatch):
    """A static directory holding every vendored file, as the build leaves it."""
    static = tmp_path / "static-with-vendor"
    for name in assets_module.VENDOR_FILES:
        path = static / "vendor" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name)
    monkeypatch.setattr("flown.site_assets.STATIC_DIR", static)
    return static


BOUNDS = CoordinateExtent(49.0, 51.0, 7.0, 9.0)


@pytest.fixture
def bundle(tmp_path_factory, monkeypatch):
    """Stand-ins for the built JavaScript bundles.

    Returns the main one; the feature, Wrapped, search, phone and extras
    bundles sit next to it, the way `npm run build` leaves them.
    """
    static = tmp_path_factory.mktemp("static")
    bundle = static / "mapApp.bundle.js"
    bundle.write_text("// bundle\n")
    features = static / "features.bundle.js"
    features.write_text("// features\n")
    wrapped = static / "wrapped.bundle.js"
    wrapped.write_text("// wrapped\n")
    search = static / "search.bundle.js"
    search.write_text("// search\n")
    phone = static / "phone.bundle.js"
    phone.write_text("// phone\n")
    extras = static / "extras.bundle.js"
    extras.write_text("// extras\n")
    monkeypatch.setattr("flown.site_assets.BUNDLE_FILE", bundle)
    monkeypatch.setattr("flown.site_assets.FEATURES_BUNDLE_FILE", features)
    monkeypatch.setattr("flown.site_assets.WRAPPED_BUNDLE_FILE", wrapped)
    monkeypatch.setattr("flown.site_assets.SEARCH_BUNDLE_FILE", search)
    monkeypatch.setattr("flown.site_assets.PHONE_BUNDLE_FILE", phone)
    monkeypatch.setattr("flown.site_assets.EXTRAS_BUNDLE_FILE", extras)
    monkeypatch.setattr(
        "flown.site_assets.BUNDLE_FILES",
        (bundle, features, wrapped, search, phone, extras),
    )
    return bundle


def _map_config(path):
    """The object map_config.js assigns to window.MAP_CONFIG."""
    text = path.read_text(encoding="ascii")
    assert text.startswith("window.MAP_CONFIG=")
    assert text.endswith(";")
    return json.loads(text.removeprefix("window.MAP_CONFIG=").removesuffix(";"))


class TestMapConfig:
    @pytest.mark.parametrize(
        "key",
        [
            "it's",
            'say "hi"',
            "path\\to",
            "line1\nline2",
            "'; alert('xss'); //",
            "</script><script>alert(1)</script>",
            "Flughafen München",
        ],
    )
    def test_any_value_stays_a_string(self, tmp_path, key):
        """JSON, not a JavaScript literal the value could end early."""
        with patch.dict(os.environ, {"CARTO_API_KEY": key}):
            _generate_map_config(tmp_path, BOUNDS, "data")

        assert _map_config(tmp_path / "map_config.js")["cartoApiKey"] == key

    def test_the_fields_the_page_reads(self, tmp_path):
        _generate_map_config(tmp_path, BOUNDS, 'da"ta')

        config = _map_config(tmp_path / "map_config.js")
        assert set(config) == {
            "bounds",
            "cartoApiKey",
            "dataDir",
            "builtOn",
            "commit",
            "commitUrl",
            "generator",
        }
        assert config["bounds"] == [[49.0, 7.0], [51.0, 9.0]]
        assert config["dataDir"] == 'da"ta'


class TestLoadTemplate:
    def test_template_content(self):
        template = load_template()
        assert "<html" in template.lower()
        assert "</html>" in template.lower()
        assert "$data_dir_name" in template

    def test_template_has_no_inline_styles_or_scripts(self):
        """minify_html only minifies the markup."""
        template = load_template()
        assert "<style" not in template
        assert all(
            'src="' in tag for tag in re.findall(r"<script[^>]*>", template, re.DOTALL)
        )


class TestMinifyHtml:
    def test_minifies_markup(self):
        html = """<html>
          <body>
            <div id="test">   Content   </div>
          </body>
        </html>"""
        minified = minify_html(html)
        assert "Content" in minified
        assert len(minified) < len(html)

    def test_keeps_script_sources(self):
        minified = minify_html(
            '<script src="a.js" defer></script>\n<script src="b.js" defer></script>'
        )
        assert minified.count("<script") == 2
        assert "a.js" in minified
        assert "b.js" in minified


class TestRenderHtml:
    def test_renders_minified_html_with_data_dir(self, tmp_path):
        output_file = tmp_path / "index.html"
        render_html(output_file, "my_data_dir")
        content = output_file.read_text()
        assert "<!doctype html>" in content.lower()
        assert "my_data_dir" in content
        assert "$data_dir_name" not in content
        substituted = string.Template(load_template()).substitute(
            data_dir_name="my_data_dir",
            year_preload="",
            year_option="",
            base_style_preload="",
            link_preview="",
            robots="",
        )
        assert len(content) < len(substituted)
        # Indexable unless asked otherwise (--private)
        assert "noindex" not in content

    def test_a_private_page_asks_not_to_be_indexed(self, tmp_path):
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        render_html(output_file, "data", private=True)

        robots = [
            meta.get("content")
            for meta in lxml_html.fromstring(output_file.read_text()).iter("meta")
            if meta.get("name") == "robots"
        ]
        assert robots == ["noindex, nofollow"]

    def test_data_dir_name_is_html_escaped(self, tmp_path):
        """A quote in the name must not end the href attribute early."""
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        render_html(output_file, 'da"ta<x>')
        content = output_file.read_text()
        assert 'href="da"' not in content
        preloads = [
            link.get("href")
            for link in lxml_html.fromstring(content).iter("link")
            if link.get("rel") == "preload"
            and not str(link.get("href")).startswith("https:")
        ]
        assert preloads == ['da"ta<x>/metadata.json', 'da"ta<x>/airports.json']

    def test_preloads_the_latest_year(self, tmp_path):
        """The first year the page shows starts downloading with the page."""
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        render_html(output_file, 'da"ta', 2026)
        preloads = [
            (link.get("as"), link.get("crossorigin"), link.get("href"))
            for link in lxml_html.fromstring(output_file.read_text()).iter("link")
            if link.get("rel") == "preload"
        ]
        # The same URL and the same mode the loader's fetch requests, so the
        # preload is what it gets. CARTO's files come after the site's own.
        assert preloads[-3] == ("fetch", "", 'da"ta/2026/data.json')
        # After the page's own scripts and styles, which start the map
        year_file = next(
            link
            for link in lxml_html.fromstring(output_file.read_text()).iter("link")
            if str(link.get("href")).endswith("/2026/data.json")
        )
        assert year_file.get("fetchpriority") == "low"
        assert {preload[:2] for preload in preloads} == {("fetch", "")}

    @pytest.mark.parametrize(
        ("key", "query"),
        [
            ("", ""),
            # encoded as encodeURIComponent does it, which the page uses
            ("k'y (1)&x", "?key=k'y%20(1)%26x"),
        ],
    )
    def test_preloads_the_base_style_as_the_page_asks_for_it(
        self, tmp_path, key, query
    ):
        """CARTO's style and tile index, with the site's key or without."""
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        with patch.dict(os.environ, {"CARTO_API_KEY": key}):
            render_html(output_file, "data", 2026)
        preloads = [
            (link.get("as"), link.get("crossorigin"), link.get("href"))
            for link in lxml_html.fromstring(output_file.read_text()).iter("link")
            if link.get("rel") == "preload"
        ]
        assert preloads[-2:] == [
            ("fetch", "", assets_module.CARTO_STYLE_URL + query),
            ("fetch", "", assets_module.CARTO_TILEJSON_URL + query),
        ]
        # The style is the one the page fetches
        app = (
            Path(__file__).parents[1] / "flown" / "frontend" / "baseStyle.ts"
        ).read_text()
        assert f'"{assets_module.CARTO_STYLE_URL}"' in app

    def test_preloads_no_year_without_one(self, tmp_path):
        output_file = tmp_path / "index.html"
        render_html(output_file, "data")
        content = output_file.read_text()
        assert "/data.json" not in content
        assert "$year_preload" not in content

    def test_year_filter_names_the_latest_year_from_the_start(self, tmp_path):
        """It said "All years" until the metadata was in, then the year."""
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        render_html(output_file, "data", 2026)
        select = lxml_html.fromstring(output_file.read_text()).find(
            ".//select[@id='year-select']"
        )
        assert select is not None
        options = [(o.get("value"), o.text, "selected" in o.attrib) for o in select]
        # The page adds the other years, and puts them in order
        assert options == [("all", "All years", False), ("2026", "2026", True)]

    def test_year_filter_offers_all_years_without_a_year(self, tmp_path):
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        render_html(output_file, "data")
        content = output_file.read_text()
        select = lxml_html.fromstring(content).find(".//select[@id='year-select']")
        assert select is not None
        assert [o.get("value") for o in select] == ["all"]
        assert "$year_option" not in content

    def test_loads_the_bundle_as_a_module(self, tmp_path):
        """The bundles are ES modules, and the shared chunk is on its way
        before the app bundle asks for it."""
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        render_html(output_file, "data")
        page = lxml_html.fromstring(output_file.read_text())
        modules = [
            s.get("src") for s in page.iter("script") if s.get("type") == "module"
        ]
        assert modules == ["./mapApp.bundle.js"]
        assert [
            link.get("href")
            for link in page.iter("link")
            if link.get("rel") == "modulepreload"
        ] == [
            "./shared.bundle.js",
            "./vendor/maplibre-gl.mjs",
            "./yearWorker.bundle.js",
            "./vendor/maplibre-gl-worker.mjs",
        ]

    def test_preloads_only_files_the_site_has(self, tmp_path):
        """Every module the page preloads is one the build publishes next
        to it, so a renamed bundle or vendored file cannot leave a preload
        of a file that is not there."""
        from lxml import html as lxml_html

        output_file = tmp_path / "index.html"
        render_html(output_file, "data")
        page = lxml_html.fromstring(output_file.read_text())
        published = {f"./{path.name}" for path in assets_module.BUNDLE_FILES} | {
            f"./vendor/{name}" for name in assets_module.VENDOR_FILES
        }
        preloaded = [
            link.get("href")
            for link in page.iter("link")
            if link.get("rel") == "modulepreload"
        ]
        assert preloaded
        assert set(preloaded) <= published

    @staticmethod
    def _policy(page):
        from lxml import html as lxml_html

        (content,) = [
            str(meta.get("content"))
            for meta in lxml_html.fromstring(page).iter("meta")
            if meta.get("http-equiv") == "Content-Security-Policy"
        ]
        directives = (part.split() for part in content.split(";"))
        return {name: sources for name, *sources in directives}

    @pytest.mark.parametrize("site_url", [None, "https://user.github.io/flights"])
    def test_scripts_come_from_the_origin(self, tmp_path, site_url):
        """With the site's URL too, so the build also runs under make serve."""
        output_file = tmp_path / "index.html"
        render_html(output_file, "data", 2026, site_url)
        policy = self._policy(output_file.read_text())
        assert policy["script-src"] == policy["worker-src"] == ["'self'"]
        # Every sink takes what a policy made of it (utils/trustedHtml.ts)
        assert policy["require-trusted-types-for"] == ["'script'"]
        assert policy["trusted-types"] == ["flown", "default"]

    def test_output_is_world_readable(self, tmp_path):
        previous = os.umask(0o022)
        try:
            output_file = tmp_path / "index.html"
            render_html(output_file, "data")
            assert oct(output_file.stat().st_mode & 0o777) == "0o644"
        finally:
            os.umask(previous)


class TestPackageAssets:
    def test_generates_config_css_and_favicons(self, tmp_path, bundle):
        with patch.dict(os.environ, {"CARTO_API_KEY": "test-carto's"}):
            package_assets(tmp_path, BOUNDS, "data")

        config = _map_config(tmp_path / "map_config.js")
        assert config["bounds"][0] == [BOUNDS.min_lat, BOUNDS.min_lon]
        assert config["cartoApiKey"] == "test-carto's"
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", config["builtOn"])
        assert re.fullmatch(r"([0-9a-f]{7})?", config["commit"])
        assert re.fullmatch(r"(https://\S+)?", config["commitUrl"])
        assert (tmp_path / "styles.css").stat().st_size > 0
        assert (tmp_path / "mapApp.bundle.js").read_text() == bundle.read_text()
        assert not (tmp_path / "mapApp.bundle.js.map").exists()
        # Replay, Wrapped, the search, the phone's bar and the extras are
        # fetched on demand, each from a bundle and a stylesheet of its own,
        # so the page needs them next to it as well
        assert (tmp_path / "features.bundle.js").read_text() == "// features\n"
        assert (tmp_path / "wrapped.bundle.js").read_text() == "// wrapped\n"
        assert (tmp_path / "search.bundle.js").read_text() == "// search\n"
        assert (tmp_path / "phone.bundle.js").read_text() == "// phone\n"
        assert (tmp_path / "extras.bundle.js").read_text() == "// extras\n"
        assert (tmp_path / "features.css").stat().st_size > 0
        assert (tmp_path / "wrapped.css").stat().st_size > 0
        assert (tmp_path / "search.css").stat().st_size > 0
        assert (tmp_path / "phone.css").stat().st_size > 0
        assert (tmp_path / "extras.css").stat().st_size > 0
        for fname in ("favicon.svg", "manifest.json"):
            assert (tmp_path / fname).exists()
        # The package's Python, for the build in the browser
        assert (tmp_path / "flown-src.zip").stat().st_size > 0
        # The library bundle was removed; it must not reappear in the output
        assert not (tmp_path / "bundle.js").exists()
        # The server's own business, see test_a_robots_txt_of_its_own_is_left_alone
        assert not (tmp_path / "robots.txt").exists()

    def test_python_sources_are_zipped_the_same_every_time(self, tmp_path):
        package = tmp_path / "pkg"
        package.mkdir()
        (package / "b.py").write_text("B = 2\n")
        (package / "a.py").write_text("A = 1\n")
        (package / "notes.txt").write_text("not python")
        (package / "static").mkdir()
        (package / "static" / "c.py").write_text("nested")
        first = tmp_path / "one"
        second = tmp_path / "two"
        first.mkdir()
        second.mkdir()

        assets_module._write_python_sources(first, package)
        time.sleep(0.01)
        assets_module._write_python_sources(second, package)

        with zipfile.ZipFile(first / "flown-src.zip") as archive:
            assert archive.namelist() == ["pkg/a.py", "pkg/b.py"]
            assert archive.read("pkg/a.py") == b"A = 1\n"
            assert {info.date_time for info in archive.infolist()} == {
                (1980, 1, 1, 0, 0, 0)
            }
        assert (first / "flown-src.zip").read_bytes() == (
            second / "flown-src.zip"
        ).read_bytes()
        assert not list(first.glob(".flown-src.zip.*"))

    def test_python_sources_are_world_readable(self, tmp_path):
        previous = os.umask(0o022)
        try:
            with patch("flown.cache.REGULAR_FILE_MODE", 0o644):
                assets_module._write_python_sources(tmp_path)
            mode = (tmp_path / "flown-src.zip").stat().st_mode & 0o777
            assert oct(mode) == "0o644"
        finally:
            os.umask(previous)

    def test_the_sources_zipped_are_this_package(self, tmp_path):
        assets_module._write_python_sources(tmp_path)

        with zipfile.ZipFile(tmp_path / "flown-src.zip") as archive:
            names = archive.namelist()
        assert "flown/browser.py" in names
        assert "flown/pipeline.py" in names
        assert not any(name.startswith("flown/frontend") for name in names)
        assert "flown/cli.py" not in names
        assert "flown/obfuscate.py" not in names

    def test_the_build_in_the_page_imports_only_what_is_zipped(self, tmp_path):
        """Every module flown.browser imports, at the top or in a function."""
        import ast

        assets_module._write_python_sources(tmp_path)
        with zipfile.ZipFile(tmp_path / "flown-src.zip") as archive:
            zipped = {Path(name).stem for name in archive.namelist()}
        package = Path(assets_module.__file__).parent
        seen: set[str] = set()
        pending = ["__init__", "browser"]
        while pending:
            module = pending.pop()
            if module in seen:
                continue
            seen.add(module)
            tree = ast.parse((package / f"{module}.py").read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.level == 1:
                    names = (
                        [node.module.split(".")[0]]
                        if node.module
                        else [alias.name for alias in node.names]
                    )
                    pending.extend(
                        name for name in names if (package / f"{name}.py").is_file()
                    )
                elif isinstance(node, ast.ImportFrom | ast.Import):
                    modules = (
                        [node.module or ""]
                        if isinstance(node, ast.ImportFrom)
                        else [alias.name for alias in node.names]
                    )
                    pending.extend(
                        name.split(".")[1]
                        for name in modules
                        if name.startswith("flown.")
                    )

        assert "pipeline" in seen
        assert seen <= zipped
        assert not seen & assets_module.NOT_IN_THE_PAGE

    def test_bundle_and_source_map_are_copied(self, tmp_path):
        static_dir = tmp_path / "static"
        static_dir.mkdir()
        (static_dir / "mapApp.bundle.js").write_text("bundle")
        (static_dir / "mapApp.bundle.js.map").write_text("{}")
        out = tmp_path / "out"
        out.mkdir()
        _copy_javascript_bundle(out, static_dir / "mapApp.bundle.js")
        assert (out / "mapApp.bundle.js").read_text() == "bundle"
        assert (out / "mapApp.bundle.js.map").read_text() == "{}"


class TestBuildDate:
    def test_is_the_current_day_in_utc(self, monkeypatch):
        monkeypatch.delenv("SOURCE_DATE_EPOCH", raising=False)
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", build_date())

    def test_honours_source_date_epoch_without_the_time(self, monkeypatch):
        # 2026-09-21T14:13:20Z
        monkeypatch.setenv("SOURCE_DATE_EPOCH", "1790000000")
        assert build_date() == "2026-09-21"

    def test_ignores_a_source_date_epoch_that_is_not_one(self, monkeypatch):
        monkeypatch.setenv("SOURCE_DATE_EPOCH", "yesterday")
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", build_date())


COMMIT_ENV = (
    "FLOWN_COMMIT",
    "FLOWN_REPOSITORY",
    "GITHUB_SHA",
    "GITHUB_REPOSITORY",
    "GITHUB_SERVER_URL",
)
PACKAGE_ROOT = str(Path(assets_module.__file__).parent.parent)


@pytest.fixture
def no_commit_env(monkeypatch):
    for name in COMMIT_ENV:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


def _fake_git(**outputs):
    """subprocess.run answering each git command from ``outputs``.

    Keys are the git arguments joined with underscores; a missing key or an
    exception value fails the command.
    """

    def run(args, **_kwargs):
        answer = outputs.get("_".join(args[1:]).replace("-", "_"))
        if answer is None:
            raise subprocess.CalledProcessError(128, args)
        if isinstance(answer, BaseException):
            raise answer
        return subprocess.CompletedProcess(args, 0, stdout=answer + "\n")

    return run


@pytest.fixture
def fake_git(no_commit_env):
    """Installs a git on PATH that answers from the given outputs."""

    def install(**outputs):
        no_commit_env.setattr(
            "flown.site_assets.shutil.which", lambda _name: "/usr/bin/git"
        )
        no_commit_env.setattr("flown.site_assets.subprocess.run", _fake_git(**outputs))

    return install


class TestBuildCommit:
    def test_prefers_the_explicit_commit(self, no_commit_env):
        no_commit_env.setenv("FLOWN_COMMIT", "5B3AB4048d1c")
        no_commit_env.setenv("FLOWN_REPOSITORY", "git@github.com:me/kmls.git")
        no_commit_env.setenv("GITHUB_SHA", "a" * 40)
        no_commit_env.setenv("GITHUB_REPOSITORY", "someone/else")
        assert build_commit() == BuildCommit(
            "5b3ab40", "https://github.com/me/kmls/commit/5b3ab4048d1c"
        )

    @pytest.mark.parametrize(
        "remote",
        [
            "git@github.com:me/kmls.git",
            "git@github.com:me/kmls",
            "https://github.com/me/kmls.git",
            "https://github.com/me/kmls/",
            "ssh://git@github.com/me/kmls.git",
        ],
    )
    def test_links_github_remotes(self, no_commit_env, remote):
        no_commit_env.setenv("FLOWN_COMMIT", "c" * 40)
        no_commit_env.setenv("FLOWN_REPOSITORY", remote)
        assert build_commit().url == f"https://github.com/me/kmls/commit/{'c' * 40}"

    @pytest.mark.parametrize(
        "remote",
        ["", "git@gitlab.com:me/kmls.git", "https://github.com.evil/me/kmls"],
    )
    def test_does_not_link_other_remotes(self, no_commit_env, remote):
        no_commit_env.setenv("FLOWN_COMMIT", "c" * 40)
        no_commit_env.setenv("FLOWN_REPOSITORY", remote)
        assert build_commit() == BuildCommit("ccccccc", "")

    def test_links_github_sha_to_the_repository_the_workflow_runs_in(
        self, no_commit_env
    ):
        no_commit_env.setenv("GITHUB_SHA", "b" * 40)
        no_commit_env.setenv("GITHUB_REPOSITORY", "someone/their-flights")
        no_commit_env.setenv("GITHUB_SERVER_URL", "https://github.com")
        assert build_commit() == BuildCommit(
            "bbbbbbb", f"https://github.com/someone/their-flights/commit/{'b' * 40}"
        )

    def test_does_not_link_an_unexpected_server(self, no_commit_env):
        no_commit_env.setenv("GITHUB_SHA", "b" * 40)
        no_commit_env.setenv("GITHUB_REPOSITORY", "me/kmls")
        no_commit_env.setenv("GITHUB_SERVER_URL", "javascript:alert(1)//")
        assert build_commit() == BuildCommit("bbbbbbb", "")

    def test_asks_git_in_the_checkout_of_the_package(self, fake_git):
        fake_git(
            rev_parse___show_toplevel=PACKAGE_ROOT,
            rev_parse_HEAD="c" * 40,
            remote_get_url_origin="https://github.com/me/kmls.git",
        )
        assert build_commit() == BuildCommit(
            "ccccccc", f"https://github.com/me/kmls/commit/{'c' * 40}"
        )

    def test_shows_the_hash_of_a_checkout_without_a_remote(self, fake_git):
        fake_git(rev_parse___show_toplevel=PACKAGE_ROOT, rev_parse_HEAD="c" * 40)
        assert build_commit() == BuildCommit("ccccccc", "")

    def test_ignores_a_repository_the_package_is_merely_inside(
        self, fake_git, tmp_path
    ):
        # A virtual environment inside someone else's checkout
        fake_git(rev_parse___show_toplevel=str(tmp_path), rev_parse_HEAD="c" * 40)
        assert build_commit() == BuildCommit()

    def test_is_empty_without_git(self, no_commit_env):
        no_commit_env.setattr("flown.site_assets.shutil.which", lambda _: None)
        assert build_commit() == BuildCommit()

    @pytest.mark.parametrize(
        "error", [PermissionError(), subprocess.CalledProcessError(128, "git")]
    )
    def test_is_empty_outside_a_repository(self, fake_git, error):
        fake_git(rev_parse___show_toplevel=error)
        assert build_commit() == BuildCommit()

    @pytest.mark.parametrize("value", ["abc", "'; alert(1)//", "zzzzzzzz"])
    def test_rejects_anything_that_is_not_a_hash(self, no_commit_env, value):
        no_commit_env.setenv("FLOWN_COMMIT", value)
        no_commit_env.setenv("FLOWN_REPOSITORY", "git@github.com:me/kmls.git")
        assert build_commit() == BuildCommit()


class TestMissingBuildFiles:
    """A forgotten `npm run build` has to be caught before any work."""

    def test_nothing_when_the_bundles_and_the_vendored_files_are_there(
        self, tmp_path, monkeypatch, bundle
    ):
        _install_vendor_files(tmp_path, monkeypatch)

        assert assets_module.missing_build_files() == []

    def test_a_missing_bundle_is_named(self, tmp_path, monkeypatch, bundle):
        _install_vendor_files(tmp_path, monkeypatch)
        bundle.unlink()

        assert assets_module.missing_build_files() == [str(bundle)]

    def test_a_missing_vendored_file_is_named(self, tmp_path, monkeypatch, bundle):
        """The page has no map without them, so they are part of the gate."""
        static = _install_vendor_files(tmp_path, monkeypatch)
        (static / "vendor" / "maplibre-gl-worker.mjs").unlink()

        assert assets_module.missing_build_files() == ["vendor/maplibre-gl-worker.mjs"]


class TestMissingFrontendBuild:
    """Without `npm run build` every test that builds a site fails."""

    def test_nothing_is_missing_after_a_build(self, tmp_path, monkeypatch, bundle):
        _install_vendor_files(tmp_path, monkeypatch)

        assert missing_frontend_build() == []

    def test_names_what_is_missing(self, tmp_path, monkeypatch, bundle):
        static = _install_vendor_files(tmp_path, monkeypatch)
        bundle.unlink()
        (static / "vendor" / "maplibre-gl-worker.mjs").unlink()

        assert missing_frontend_build() == [
            "mapApp.bundle.js",
            "vendor/maplibre-gl-worker.mjs",
        ]

    @pytest.mark.parametrize(
        ("exitstatus", "hint"),
        [(pytest.ExitCode.TESTS_FAILED, True), (pytest.ExitCode.OK, False)],
    )
    def test_a_failed_run_says_to_build_first(
        self, tmp_path, monkeypatch, bundle, exitstatus, hint
    ):
        _install_vendor_files(tmp_path, monkeypatch)
        bundle.unlink()
        lines = []

        class Reporter:
            def write_sep(self, sep, title, **markup):
                lines.append(title)

            def write_line(self, line):
                lines.append(line)

        pytest_terminal_summary(Reporter(), exitstatus, None)

        assert bool(lines) is hint
        if hint:
            assert "mapApp.bundle.js" in lines[-1]
            assert "npm run build" in lines[-1]


class TestStaleBundleWarning:
    def _frontend(self, tmp_path, monkeypatch):
        """A checkout the hash can be computed from: sources and build files."""
        frontend = tmp_path / "flown" / "frontend"
        (frontend / "ui").mkdir(parents=True)
        (frontend / "mapApp.ts").write_text("export {};")
        (frontend / "ui" / "a.ts").write_text("export const a = 1;")
        for name in assets_module.BUILD_HASH_FILES:
            # Some of them sit in subdirectories (the stylesheets)
            path = tmp_path / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("{}")
        (tmp_path / "package-lock.json").write_text(json.dumps(self._lock()))
        monkeypatch.setattr(assets_module, "FRONTEND_DIR", frontend)
        return frontend

    @staticmethod
    def _lock(**versions):
        """A package-lock.json that pins every package the hash reads"""
        pinned = dict.fromkeys(assets_module.BUILD_HASH_PACKAGES, "1.0.0")
        pinned.update(versions)
        return {
            "packages": {
                f"node_modules/{name}": {"version": version}
                for name, version in pinned.items()
            }
        }

    def test_warns_about_a_bundle_of_other_sources(
        self, tmp_path, monkeypatch, bundle, capsys
    ):
        self._frontend(tmp_path, monkeypatch)
        bundle.write_text("/* flown build 000000000000 */\n")

        assets_module.warn_about_a_stale_bundle()

        assert "npm run build" in capsys.readouterr().err

    def test_quiet_for_a_current_bundle(self, tmp_path, monkeypatch, bundle, capsys):
        self._frontend(tmp_path, monkeypatch)
        current = assets_module._frontend_source_hash()
        bundle.write_text(f"/* flown build {current} */\n")

        assets_module.warn_about_a_stale_bundle()

        assert capsys.readouterr().err == ""

    def test_quiet_without_the_sources(self, tmp_path, monkeypatch, bundle, capsys):
        monkeypatch.setattr(assets_module, "FRONTEND_DIR", tmp_path / "missing")
        bundle.write_text("no banner")

        assets_module.warn_about_a_stale_bundle()

        assert capsys.readouterr().err == ""

    def test_quiet_when_the_bundle_cannot_be_read(
        self, tmp_path, monkeypatch, bundle, capsys
    ):
        self._frontend(tmp_path, monkeypatch)
        bundle.unlink()

        assets_module.warn_about_a_stale_bundle()

        assert capsys.readouterr().err == ""

    @pytest.mark.parametrize("name", assets_module.BUILD_HASH_FILES)
    def test_the_build_files_are_part_of_the_hash(
        self, tmp_path, monkeypatch, bundle, name
    ):
        """Every file outside the sources that shapes a built site counts.

        The stylesheets are in there because the site renders them: without
        them a stylesheet-only change left a built `docs/` looking current,
        and the visual snapshots compared the old one.
        """
        self._frontend(tmp_path, monkeypatch)
        before = assets_module._frontend_source_hash()

        (tmp_path / name).write_text("/* something else */")

        assert assets_module._frontend_source_hash() != before

    @pytest.mark.parametrize("name", assets_module.BUILD_HASH_PACKAGES)
    def test_the_package_versions_are_part_of_the_hash(
        self, tmp_path, monkeypatch, bundle, name
    ):
        """The bundler and what it bundles from node_modules shape the bundle"""
        self._frontend(tmp_path, monkeypatch)
        before = assets_module._frontend_source_hash()

        (tmp_path / "package-lock.json").write_text(
            json.dumps(self._lock(**{name: "2.0.0"}))
        )

        assert assets_module._frontend_source_hash() != before

    @pytest.mark.parametrize(
        ("name", "content"),
        [
            ("package-lock.json", None),
            ("package-lock.json", "not json"),
            ("package-lock.json", "{}"),
            ("build.js", None),
        ],
        ids=["no-lock", "broken-lock", "lock-without-esbuild", "no-build-script"],
    )
    def test_quiet_without_a_complete_checkout(
        self, tmp_path, monkeypatch, bundle, capsys, name, content
    ):
        """An incomplete checkout says nothing rather than warning every time."""
        self._frontend(tmp_path, monkeypatch)
        if content is None:
            (tmp_path / name).unlink()
        else:
            (tmp_path / name).write_text(content)
        bundle.write_text("/* flown build 000000000000 */\n")

        assets_module.warn_about_a_stale_bundle()

        assert assets_module._frontend_source_hash() is None
        assert capsys.readouterr().err == ""


class TestGeneratorHash:
    """The hash map_config.js carries, which the e2e site check compares."""

    @pytest.fixture
    def package(self, tmp_path, monkeypatch):
        """A package of a module, a template and static files, as hashed."""
        package = tmp_path / "flown"
        (package / "templates").mkdir(parents=True)
        (package / "static" / "vendor").mkdir(parents=True)
        (package / "site_assets.py").write_text("code")
        (package / "templates" / "map_template.html").write_text("<html>")
        (package / "static" / "styles.css").write_text("body {}")
        monkeypatch.setattr(assets_module, "__file__", str(package / "site_assets.py"))
        return package

    def test_holds_no_date(self, tmp_path):
        _generate_map_config(tmp_path, BOUNDS, "data")
        config = _map_config(tmp_path / "map_config.js")
        assert re.fullmatch(r"[0-9a-f]{12}", config["generator"])
        assert config["generator"] == assets_module.generator_hash()

    @pytest.mark.parametrize(
        "change",
        [
            "site_assets.py",
            "pipeline.py",
            "templates/map_template.html",
            "static/styles.css",
            "static/favicon.svg",
        ],
    )
    def test_changes_with_what_the_generator_publishes(self, package, change):
        before = assets_module.generator_hash()
        (package / change).write_text("changed")
        assert assets_module.generator_hash() != before

    @pytest.mark.parametrize(
        "change",
        [
            "static/mapApp.bundle.js",
            "static/mapApp.bundle.js.map",
            "static/vendor/maplibre-gl.mjs",
            "static/.styles.css.swp",
            "notes.txt",
            "frontend.ts",
        ],
    )
    def test_ignores_the_bundles_and_what_is_no_source(self, package, change):
        """The bundles have a hash of their own (TestSourceHashParity)."""
        before = assets_module.generator_hash()
        (package / change).write_text("changed")
        assert assets_module.generator_hash() == before

    def test_an_unreadable_package_gives_none(self, package, monkeypatch):
        def unreadable(_self):
            raise PermissionError("denied")

        monkeypatch.setattr(Path, "read_bytes", unreadable)
        assert assets_module.generator_hash() == ""


class TestGeneratorHashParity:
    """generator_hash and computeGeneratorHash in scripts/source-hash.js agree.

    The site check compares the JavaScript one with what the Python one put
    into map_config.js; two that disagreed would refuse every site.
    """

    def test_matches_the_javascript_implementation(self):
        repo_root = assets_module.FRONTEND_DIR.parent.parent
        if not (repo_root / "scripts" / "source-hash.js").is_file():
            pytest.skip("not running from a checkout")
        node = shutil.which("node")
        if node is None:
            if os.environ.get("CI"):
                pytest.fail("node is required to check the generator hash parity")
            pytest.skip("node is not installed")

        result = subprocess.run(  # noqa: S603
            [
                node,
                "-e",
                (
                    'import("./scripts/source-hash.js")'
                    ".then((m) => console.log(m.computeGeneratorHash()))"
                ),
            ],
            capture_output=True,
            text=True,
            cwd=repo_root,
            check=True,
        )

        assert result.stdout.strip() == assets_module.generator_hash()


class TestSourceHashParity:
    """The Python mirror of scripts/source-hash.js has to stay a mirror.

    build.js stamps the JavaScript hash into the bundle banner, and
    ``warn_about_a_stale_bundle`` compares that banner against the Python
    one. Two implementations that disagree turn the warning into noise on
    every build, so this checks them against each other rather than letting
    each confirm itself.
    """

    def test_matches_the_javascript_implementation(self):
        repo_root = assets_module.FRONTEND_DIR.parent.parent
        if not (repo_root / "scripts" / "source-hash.js").is_file():
            pytest.skip("not running from a checkout")
        node = shutil.which("node")
        if node is None:
            # CI sets up Node.js for this job, so a missing one there is a
            # broken workflow rather than a reason to pass silently
            if os.environ.get("CI"):
                pytest.fail("node is required to check the source hash parity")
            pytest.skip("node is not installed")

        result = subprocess.run(  # noqa: S603
            [
                node,
                "-e",
                (
                    'import("./scripts/source-hash.js")'
                    ".then((m) => console.log(m.computeSourceHash()))"
                ),
            ],
            capture_output=True,
            text=True,
            cwd=repo_root,
            check=True,
        )

        assert result.stdout.strip() == assets_module._frontend_source_hash()

    def test_covers_the_build_files_the_javascript_side_covers(self):
        """BUILD_HASH_FILES and BUILD_FILES in source-hash.js list the same files."""
        repo_root = assets_module.FRONTEND_DIR.parent.parent
        source_hash_js = repo_root / "scripts" / "source-hash.js"
        if not source_hash_js.is_file():
            pytest.skip("not running from a checkout")

        listed = re.search(
            r"const BUILD_FILES = \[(.*?)\]", source_hash_js.read_text(), re.DOTALL
        )
        assert listed is not None, "BUILD_FILES is no longer a literal list"

        assert tuple(re.findall(r'"([^"]+)"', listed.group(1))) == (
            assets_module.BUILD_HASH_FILES
        )

    def test_covers_the_packages_the_javascript_side_covers(self):
        """BUILD_HASH_PACKAGES and BUILD_PACKAGES in source-hash.js agree."""
        repo_root = assets_module.FRONTEND_DIR.parent.parent
        source_hash_js = repo_root / "scripts" / "source-hash.js"
        if not source_hash_js.is_file():
            pytest.skip("not running from a checkout")

        listed = re.search(
            r"const BUILD_PACKAGES = \[(.*?)\]",
            source_hash_js.read_text(),
            re.DOTALL,
        )
        assert listed is not None, "BUILD_PACKAGES is no longer a literal list"

        assert tuple(re.findall(r'"([^"]+)"', listed.group(1))) == (
            assets_module.BUILD_HASH_PACKAGES
        )


class TestBuildOutputParity:
    """The site publishes what the build writes, under the same names.

    A bundle the build writes and the site does not publish (the year worker,
    say) leaves a page that fails to load it, and only in a generated site.
    """

    @pytest.fixture
    def repo_root(self):
        root = assets_module.FRONTEND_DIR.parent.parent
        if not (root / "build.js").is_file():
            pytest.skip("not running from a checkout")
        return root

    def test_publishes_every_bundle_the_build_writes(self, repo_root):
        """BUNDLE_FILES and the bundle names in build.js agree."""
        names = re.findall(
            r'^const \w+_BUNDLE = "([^"]+)";$',
            (repo_root / "build.js").read_text(),
            re.MULTILINE,
        )
        assert names, "build.js no longer names its bundles as constants"

        assert sorted(names) == sorted(path.name for path in assets_module.BUNDLE_FILES)

    def test_publishes_every_file_vendor_js_writes(self, repo_root):
        """VENDOR_FILES here and VENDOR_FILES and VENDOR_MODULES there agree."""
        text = (repo_root / "scripts" / "vendor.js").read_text()
        written = []
        for name in ("VENDOR_FILES", "VENDOR_MODULES"):
            listed = re.search(rf"export const {name} = \{{(.*?)\}};", text, re.DOTALL)
            assert listed is not None, f"{name} is no longer a literal object"
            written += re.findall(r'^\s*"([^"]+)":', listed.group(1), re.MULTILINE)

        assert sorted(written) == sorted(assets_module.VENDOR_FILES)


class TestCountryFlags:
    """Publishing a flag per country the export visited, and no other."""

    @pytest.fixture
    def flags(self, tmp_path, monkeypatch):
        """A checkout whose static/flags holds two of the three asked for"""
        static = tmp_path / "static"
        (static / assets_module.FLAGS_DIR_NAME).mkdir(parents=True)
        for code in ("de", "at"):
            (static / assets_module.FLAGS_DIR_NAME / f"{code}.svg").write_text(
                f'<svg xmlns="http://www.w3.org/2000/svg" data-code="{code}"/>'
            )
        monkeypatch.setattr(assets_module, "STATIC_DIR", static)
        return static

    def test_lists_only_the_flags_the_checkout_has(self, flags):
        assert assets_module.available_country_flags(["DE", "AT", "XX"]) == [
            "at",
            "de",
        ]

    def test_lists_nothing_without_the_directory(self, tmp_path, monkeypatch):
        # A wheel leaves the flags out; the frontend falls back to the code
        monkeypatch.setattr(assets_module, "STATIC_DIR", tmp_path)
        assert assets_module.available_country_flags(["DE"]) == []

    def test_publishes_the_flags_of_the_countries_given(self, flags, tmp_path):
        output = tmp_path / "site"
        output.mkdir()

        assets_module._copy_country_flags(output, ["DE", "XX"])

        published = sorted(
            path.name for path in (output / assets_module.FLAGS_DIR_NAME).iterdir()
        )
        assert published == ["de.svg"]

    def test_writes_no_directory_when_nothing_matches(self, flags, tmp_path):
        output = tmp_path / "site"
        output.mkdir()

        assets_module._copy_country_flags(output, ["XX"])

        assert not (output / assets_module.FLAGS_DIR_NAME).exists()
