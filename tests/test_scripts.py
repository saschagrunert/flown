"""Tests for the helper scripts in scripts/ that have no test file of their own.

The coverage floor counts scripts/ as well, so a script nobody runs in CI
still shows up when it stops doing what its docstring says.
"""

import importlib.util
import os
import shutil
import subprocess
import sys
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

from flown import site_assets
from flown.constants import KM_TO_NAUTICAL_MILES
from flown.export_pipeline import path_duration
from flown.geometry import haversine_distance
from flown.segment_calculator import calculate_fallback_groundspeed
from tests.conftest import parse_kml_file

if TYPE_CHECKING:
    from types import ModuleType

SCRIPTS = Path(__file__).parent.parent / "scripts"


def _load(name: str) -> ModuleType:
    """Import a script from scripts/, which is not a package."""
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f"{name}.py")
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


generate_test_data = _load("generate_test_data")
build_visual_site = _load("build_visual_site")
pre_push = _load("pre_push")


class TestGenerateTestData:
    def test_writes_parseable_flights_under_the_documented_names(
        self, tmp_path, monkeypatch, capsys
    ):
        output = tmp_path / "flights"
        monkeypatch.setattr(
            sys, "argv", ["generate_test_data.py", "3", "--output", str(output)]
        )

        generate_test_data.main()

        files = sorted(output.iterdir())
        assert [path.name.split("_", 1)[0] for path in files] == ["1", "2", "3"]
        for path in files:
            _, registration, aircraft_type = path.stem.split("_")
            assert (registration[:1] + "-" + registration[1:], aircraft_type) in (
                generate_test_data.AIRCRAFT
            )
            coordinates, _, metadata = parse_kml_file(str(path))
            assert len(coordinates) == 50
            assert len(metadata) == 1
        out = capsys.readouterr().out
        assert "Successfully generated 3 KML files" in out
        assert f"make build INPUT_DIR={output}" in out

    def test_flights_have_an_end_and_so_a_speed(self, tmp_path):
        # A <TimeStamp> alone gave every flight a start and no end, so no
        # duration, and the speed layer had no path average to fall back on
        name = generate_test_data.generate_kml_file(
            1, "EDDF", "EDDM", "D-ABCD", "DA40", tmp_path, "linestring"
        )

        _, paths, metadata = parse_kml_file(str(tmp_path / name))
        path = paths[0]
        seconds = path_duration(metadata[0])
        assert seconds > 0
        distance_nm = (
            sum(
                haversine_distance(a.lat, a.lon, b.lat, b.lon)
                for a, b in pairwise(path)
            )
            * KM_TO_NAUTICAL_MILES
        )
        low, high = generate_test_data.GROUNDSPEED_KNOTS
        # The file keeps whole seconds
        assert low - 1 <= distance_nm / (seconds / 3600) <= high + 1
        middle = haversine_distance(
            path[24].lat, path[24].lon, path[25].lat, path[25].lon
        )
        assert calculate_fallback_groundspeed(
            middle, distance_nm / KM_TO_NAUTICAL_MILES, seconds
        ) == pytest.approx(distance_nm / (seconds / 3600))

    def test_a_gx_track_has_a_time_for_every_point(self, tmp_path):
        """The default format, as SkyDemon writes it."""
        name = generate_test_data.generate_kml_file(
            1, "EDDF", "EDDM", "D-ABCD", "DA40", tmp_path
        )

        coordinates, paths, metadata = parse_kml_file(str(tmp_path / name))
        assert len(coordinates) == 50
        [path] = paths
        times = [point.ts for point in path if point.ts is not None]
        assert len(times) == len(path)
        gaps = [b - a for a, b in pairwise(times)]
        # Tens of seconds apart, at the groundspeed of a light aircraft
        assert all(0 < gap < 300 for gap in gaps)
        distance_nm = (
            sum(
                haversine_distance(a.lat, a.lon, b.lat, b.lon)
                for a, b in pairwise(path)
            )
            * KM_TO_NAUTICAL_MILES
        )
        low, high = generate_test_data.GROUNDSPEED_KNOTS
        knots = distance_nm / ((times[-1] - times[0]) / 3600)
        assert low - 1 <= knots <= high + 1
        assert metadata[0]["year"] == 2026

    @pytest.mark.parametrize("kml_format", generate_test_data.FORMATS)
    def test_the_same_seed_writes_the_same_files(
        self, tmp_path, monkeypatch, kml_format
    ):
        contents = []
        for run, seed in enumerate(("5", "5", "6")):
            output = tmp_path / str(run)
            monkeypatch.setattr(
                sys,
                "argv",
                [
                    "generate_test_data.py",
                    "2",
                    "-o",
                    str(output),
                    "--seed",
                    seed,
                    "--format",
                    kml_format,
                ],
            )
            generate_test_data.main()
            contents.append([path.read_text() for path in sorted(output.iterdir())])
        assert contents[0] == contents[1]
        assert contents[0] != contents[2]

    def test_an_unknown_format_is_refused(self, tmp_path):
        with pytest.raises(ValueError, match="unknown format"):
            generate_test_data.generate_kml_file(
                1, "EDDF", "EDDM", "D-ABCD", "DA40", tmp_path, "csv"
            )

    def test_reports_progress_every_thousand_files(self, tmp_path, monkeypatch, capsys):
        written = []
        monkeypatch.setattr(
            generate_test_data,
            "generate_kml_file",
            lambda flight_id, *_: written.append(flight_id),
        )
        monkeypatch.setattr(
            sys, "argv", ["generate_test_data.py", "1000", "-o", str(tmp_path)]
        )

        generate_test_data.main()

        assert len(written) == 1000
        assert "Generated 1,000 files..." in capsys.readouterr().out

    def test_the_default_directory_is_named_after_the_count(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(sys, "argv", ["generate_test_data.py", "1"])

        generate_test_data.main()

        assert [path.name for path in (tmp_path / "kml_test_1").iterdir()]

    def test_the_altitude_climbs_cruises_and_descends(self):
        path = generate_test_data.generate_flight_path(
            generate_test_data.AIRPORTS["EDDF"], generate_test_data.AIRPORTS["EDDM"]
        )

        altitudes = [alt for _, _, alt in path]
        assert altitudes[0] == 0
        assert altitudes[-1] == 0
        assert min(altitudes[15:35]) >= 1800


class TestBuildVisualSite:
    def test_builds_the_fixture_flights_offline_with_a_fixed_stamp(
        self, tmp_path, monkeypatch
    ):
        site = tmp_path / "visual-site"
        (site / "stale").mkdir(parents=True)
        monkeypatch.setattr(build_visual_site, "SITE_DIR", site)
        monkeypatch.setenv("CARTO_API_KEY", "from-the-user")
        calls = []

        def run(command, *, cwd, env, check):
            cache = Path(env["FLOWN_CACHE_DIR"])
            calls.append(
                {
                    "command": command,
                    "cwd": cwd,
                    "env": env,
                    "check": check,
                    "cached": sorted(path.name for path in cache.iterdir()),
                }
            )
            return subprocess.CompletedProcess(command, 3)

        monkeypatch.setattr(build_visual_site.subprocess, "run", run)

        assert build_visual_site.main() == 3

        assert not site.exists()
        [call] = calls
        assert call["command"] == [
            sys.executable,
            "-m",
            "flown",
            str(build_visual_site.FIXTURE_DIR),
            "--output-dir",
            str(site),
            # Offline: no elevation tiles
            "--no-terrain",
        ]
        assert call["cwd"] == build_visual_site.ROOT
        assert call["check"] is False
        assert call["cached"] == ["airports.csv", "runways.csv"]
        env = call["env"]
        assert env["CARTO_API_KEY"] == ""
        assert env["SOURCE_DATE_EPOCH"] == "1735689600"
        assert env["FLOWN_REQUIRE_AIRPORT_DB"] == "1"
        # The rest of the environment is passed on
        assert env["PATH"] == os.environ["PATH"]

    def test_a_built_site_carries_the_hash_of_its_inputs(self, tmp_path, monkeypatch):
        """The e2e site check compares it, not modification times."""
        site = tmp_path / "visual-site"
        monkeypatch.setattr(build_visual_site, "SITE_DIR", site)

        def run(command, *, cwd, env, check):
            site.mkdir()
            return subprocess.CompletedProcess(command, 0)

        monkeypatch.setattr(build_visual_site.subprocess, "run", run)

        assert build_visual_site.main() == 0
        assert (site / "fixture.sha1").read_text() == (
            build_visual_site.fixture_hash() + "\n"
        )

    def test_the_inputs_are_hashed_with_their_names(self, tmp_path, monkeypatch):
        """A flight renamed or removed changes the hash, as an edit does."""
        fixture = tmp_path / "tests" / "fixtures" / "visual"
        fixture.mkdir(parents=True)
        (fixture / "1_DEHYL_DA40.kml").write_text("flight")
        (fixture / ".1_DEHYL_DA40.kml.swp").write_text("editor")
        monkeypatch.setattr(build_visual_site, "ROOT", tmp_path)
        monkeypatch.setattr(build_visual_site, "FIXTURE_DIR", fixture)
        for name in ("AIRPORTS", "RUNWAYS"):
            path = tmp_path / f"{name.lower()}.csv"
            path.write_text(name)
            monkeypatch.setattr(build_visual_site, name, path)
        script = tmp_path / "build_visual_site.py"
        script.write_text("script")
        monkeypatch.setattr(build_visual_site, "__file__", str(script))

        first = build_visual_site.fixture_hash()
        (fixture / ".1_DEHYL_DA40.kml.swp").write_text("edited")
        assert build_visual_site.fixture_hash() == first
        (fixture / "1_DEHYL_DA40.kml").rename(fixture / "2_DEHYL_DA40.kml")
        assert build_visual_site.fixture_hash() != first

    def test_the_hash_of_the_inputs_matches_the_site_check(self):
        """computeFixtureHash in scripts/source-hash.js, which the e2e site
        check compares with the hash this script left in the site."""
        node = shutil.which("node")
        if node is None:
            if os.environ.get("CI"):
                pytest.fail("node is required to check the fixture hash parity")
            pytest.skip("node is not installed")
        result = subprocess.run(  # noqa: S603
            [
                node,
                "-e",
                (
                    'import("./scripts/source-hash.js")'
                    ".then((m) => console.log(m.computeFixtureHash()))"
                ),
            ],
            capture_output=True,
            text=True,
            cwd=build_visual_site.ROOT,
            check=True,
        )
        assert result.stdout.strip() == build_visual_site.fixture_hash()


class TestPrePushWithoutGit:
    def test_fails_closed_when_git_is_missing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(pre_push.shutil, "which", lambda _: None)

        with pytest.raises(OSError, match="git is not on PATH"):
            pre_push.commits_to_check(tmp_path, ["--not", "--remotes"], ["a" * 40])


check_site_files = _load("check_site_files")


def _write_files(root: Path, names: tuple[str, ...]) -> None:
    for name in names:
        (root / name).parent.mkdir(parents=True, exist_ok=True)
        (root / name).write_text("x")


class TestCheckSiteFiles:
    def test_a_complete_site_passes(self, tmp_path, capsys):
        _write_files(tmp_path, check_site_files.SITE_FILES)

        assert check_site_files.main([str(tmp_path)]) == 0
        assert f"All {len(check_site_files.SITE_FILES)} files are there" in (
            capsys.readouterr().out
        )

    def test_names_every_file_that_is_missing_or_empty(self, tmp_path, capsys):
        _write_files(tmp_path, check_site_files.SITE_FILES)
        (tmp_path / "data" / "metadata.json").unlink()
        (tmp_path / "vendor" / "maplibre-gl.mjs").write_text("")

        assert check_site_files.main([str(tmp_path)]) == 1

        errors = capsys.readouterr().out.splitlines()[1:]
        assert errors == [
            f"::error::{tmp_path / 'vendor/maplibre-gl.mjs'} was not generated",
            f"::error::{tmp_path / 'data/metadata.json'} was not generated",
        ]

    def test_the_package_ships_every_asset_and_no_source_map(
        self, tmp_path, monkeypatch, capsys
    ):
        _write_files(tmp_path, check_site_files.PACKAGE_FILES)
        monkeypatch.setattr(
            check_site_files.importlib.resources, "files", lambda _: tmp_path
        )

        assert check_site_files.main(["--package"]) == 0
        assert f"All {len(check_site_files.PACKAGE_FILES)} files are there" in (
            capsys.readouterr().out
        )

        (tmp_path / "static" / "wrapped.css").unlink()
        (tmp_path / "static" / "mapApp.bundle.js.map").write_text("{}")

        assert check_site_files.main(["--package"]) == 1
        assert capsys.readouterr().out.splitlines()[1:] == [
            "::error::static/wrapped.css is not shipped",
            "::error::static/mapApp.bundle.js.map is shipped",
        ]

    def test_wants_a_site_or_the_package(self, capsys):
        with pytest.raises(SystemExit):
            check_site_files.main([])
        with pytest.raises(SystemExit):
            check_site_files.main(["site", "--package"])

    def test_lists_every_bundle_stylesheet_and_vendored_file(self):
        # The list is written out for the builds of the image, whose Python has
        # no package to import it from
        expected = {
            *(bundle.name for bundle in site_assets.BUNDLE_FILES),
            *site_assets.CSS_FILES,
            *(f"vendor/{name}" for name in site_assets.VENDOR_FILES),
        }
        assert set(check_site_files.ASSETS) == expected


smoke_site = _load("smoke_site")


class TestSmokeSite:
    def test_prepares_the_flights_the_fixtures_and_the_site(self, tmp_path):
        assert smoke_site.main(["prepare", str(tmp_path)]) == 0

        flights = sorted((smoke_site.REPO / "data").rglob("*.kml"))[:3]
        assert sorted(p.name for p in (tmp_path / "input").iterdir()) == sorted(
            p.name for p in flights
        )
        for name in smoke_site.CACHE_FIXTURES:
            assert (tmp_path / "cache" / name).read_bytes() == (
                smoke_site.FIXTURES / name
            ).read_bytes()
        assert list((tmp_path / "site").iterdir()) == []

    def test_world_writable_for_the_image_user(self, tmp_path):
        smoke_site.prepare(tmp_path, world_writable=True)

        for path in (tmp_path, *tmp_path.rglob("*")):
            expected = 0o777 if path.is_dir() else 0o666
            assert path.stat().st_mode & 0o777 == expected

    def test_a_complete_site_with_the_fixtures_passes(self, tmp_path, capsys):
        smoke_site.prepare(tmp_path)
        _write_files(tmp_path / "site", check_site_files.SITE_FILES)

        assert smoke_site.main(["check", str(tmp_path)]) == 0
        assert "nothing was fetched" in capsys.readouterr().out

    def test_names_a_missing_file_and_a_download(self, tmp_path, capsys):
        smoke_site.prepare(tmp_path)
        _write_files(tmp_path / "site", check_site_files.SITE_FILES)
        (tmp_path / "site" / "index.html").unlink()
        (tmp_path / "cache" / "runways.csv").write_text("downloaded")

        assert smoke_site.main(["check", str(tmp_path)]) == 1
        assert capsys.readouterr().out.splitlines() == [
            f"::error::{tmp_path / 'site' / 'index.html'} was not generated",
            f"::error::{tmp_path / 'cache' / 'runways.csv'} is no longer the fixture",
        ]
