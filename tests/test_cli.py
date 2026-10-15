"""Tests for CLI module."""

import json
import logging
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import TYPE_CHECKING, cast
from unittest.mock import MagicMock, patch

import pytest

from flown import workers
from flown.aircraft import merge_aircraft_data
from flown.cli import format_listing, main
from flown.data_exporter import ExportSelection
from flown.exceptions import (
    ExportError,
    FlownError,
    InvalidInputError,
    OutputRefusedError,
)
from flown.listing import FlightListing, _skip_reason
from flown.logger import logger, set_info_stream, set_log_level
from flown.terrain import TerrariumTiles

if TYPE_CHECKING:
    from flown.types import PathMetadata

MINIMAL_KML = "<?xml version='1.0'?><kml></kml>"


@pytest.fixture
def workspace(tmp_path):
    """Input directory with a KML file and a separate output directory."""
    input_dir = tmp_path / "input"
    input_dir.mkdir()
    kml = input_dir / "test.kml"
    kml.write_text(MINIMAL_KML)
    return input_dir, kml, tmp_path / "out"


@pytest.fixture(autouse=True)
def bundle(tmp_path, monkeypatch):
    """A stand-in for the bundle, which the Python tests do not build."""
    path = tmp_path / "static" / "mapApp.bundle.js"
    path.parent.mkdir()
    path.write_text("/* bundle */")
    monkeypatch.setattr("flown.site_assets.BUNDLE_FILE", path)
    monkeypatch.setattr("flown.site_assets.BUNDLE_FILES", (path,))
    return path


def _run(argv, create_return=True):
    mock_create = MagicMock(return_value=create_return)
    with (
        patch("sys.argv", ["flown", *argv]),
        patch("flown.pipeline.build_site", mock_create),
    ):
        main()
    return mock_create


class TestArgumentParsing:
    def test_no_arguments_shows_usage(self):
        with patch("sys.argv", ["flown"]), pytest.raises(SystemExit) as exc_info:
            main()
        assert exc_info.value.code == 2

    @pytest.mark.parametrize("flag", ["-h", "--help"])
    def test_help(self, capsys, flag):
        with patch("sys.argv", ["flown", flag]), pytest.raises(SystemExit) as e:
            main()
        assert e.value.code == 0
        out = capsys.readouterr().out
        assert "--output-dir" in out
        assert "(default: docs)" in out
        assert "--debug" in out
        assert "IN PLACE" in out

    def test_version(self, capsys):
        with (
            patch("sys.argv", ["flown", "--version"]),
            pytest.raises(SystemExit) as e,
        ):
            main()
        assert e.value.code == 0
        assert "flown 1.0.0" in capsys.readouterr().out

    def test_output_dir_without_argument_exits(self):
        with (
            patch("sys.argv", ["flown", "file.kml", "--output-dir"]),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 2

    def test_unknown_option_exits(self):
        with (
            patch("sys.argv", ["flown", "--unknown-option"]),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 2


class TestTerrain:
    def test_samples_the_ground_from_the_elevation_tiles(self, workspace):
        _, kml, out = workspace

        mock_create = _run([str(kml), "--output-dir", str(out)])

        assert isinstance(mock_create.call_args.kwargs["terrain"], TerrariumTiles)

    def test_no_terrain_leaves_it_out(self, workspace):
        _, kml, out = workspace

        mock_create = _run([str(kml), "--output-dir", str(out), "--no-terrain"])

        assert mock_create.call_args.kwargs["terrain"] is None

    def test_the_switch_is_in_the_help(self, capsys):
        with patch("sys.argv", ["flown", "--help"]), pytest.raises(SystemExit):
            main()
        assert "--no-terrain" in capsys.readouterr().out


class TestOldNames:
    def test_warns_about_a_variable_of_kml_heatmap(
        self, workspace, monkeypatch, capsys
    ):
        """KML_HEATMAP_REQUIRE_AIRPORT_DB=1 no longer stops a build."""
        _, kml, out = workspace
        monkeypatch.setenv("KML_HEATMAP_REQUIRE_AIRPORT_DB", "1")

        _run([str(kml), "--output-dir", str(out)])

        assert (
            "rename KML_HEATMAP_REQUIRE_AIRPORT_DB to FLOWN_REQUIRE_AIRPORT_DB"
            in capsys.readouterr().err
        )

    def test_warns_about_the_cache_of_kml_heatmap(
        self, workspace, monkeypatch, tmp_path, capsys
    ):
        _, kml, out = workspace
        old_cache = tmp_path / "kml-heatmap"
        (old_cache / "kml").mkdir(parents=True)
        monkeypatch.setattr("flown.cli._old_cache_dir", lambda: old_cache)

        _run([str(kml), "--output-dir", str(out)])

        err = capsys.readouterr().err
        assert f"{old_cache} is the cache of kml-heatmap" in err

    def test_quiet_without_either(self, workspace, capsys):
        _, kml, out = workspace

        _run([str(kml), "--output-dir", str(out)])

        assert "kml-heatmap" not in capsys.readouterr().err


class TestTrimEnds:
    def test_off_by_default(self, workspace):
        _, kml, out = workspace

        mock_create = _run([str(kml), "--output-dir", str(out)])

        assert mock_create.call_args.kwargs["trim_ends"] == 0

    def test_the_distance_is_passed_on(self, workspace):
        _, kml, out = workspace

        mock_create = _run([str(kml), "--output-dir", str(out), "--trim-ends", "300"])

        assert mock_create.call_args.kwargs["trim_ends"] == 300

    @pytest.mark.parametrize("value", ["-1", "far", "nan", "inf"])
    def test_refuses_what_is_no_distance(self, workspace, value, capsys):
        _, kml, out = workspace
        with pytest.raises(SystemExit) as exited:
            _run([str(kml), "--output-dir", str(out), "--trim-ends", value])
        assert exited.value.code == 2
        assert "--trim-ends" in capsys.readouterr().err


class TestSiteUrl:
    def test_unset_is_passed_as_none_of_its_own(self, workspace):
        _, kml, out = workspace

        mock_create = _run([str(kml), "--output-dir", str(out)])

        # Resolved here, so the environment is not read a second time
        assert mock_create.call_args.kwargs["site_url"] == ""

    def test_the_option_is_normalized(self, workspace, monkeypatch):
        _, kml, out = workspace
        monkeypatch.setenv("FLOWN_SITE_URL", "https://other.example")

        mock_create = _run(
            [str(kml), "--output-dir", str(out), "--site-url", "https://a.example/b/"]
        )

        assert mock_create.call_args.kwargs["site_url"] == "https://a.example/b"

    def test_the_environment_is_the_default(self, workspace, monkeypatch):
        _, kml, out = workspace
        monkeypatch.setenv("FLOWN_SITE_URL", "https://a.example")

        mock_create = _run([str(kml), "--output-dir", str(out)])

        assert mock_create.call_args.kwargs["site_url"] == "https://a.example"

    def test_a_relative_url_stops_before_any_work(self, workspace, capsys):
        _, kml, out = workspace

        with pytest.raises(SystemExit) as exc_info:
            _run([str(kml), "--output-dir", str(out), "--site-url", "/flights"])

        assert exc_info.value.code == 2
        assert "absolute http(s) address" in capsys.readouterr().err
        assert not out.exists()


class TestFileCollection:
    def test_single_kml_file(self, workspace):
        _, kml, out = workspace
        mock_create = _run([str(kml), "--output-dir", str(out)])
        assert mock_create.call_args[0][0] == [str(kml)]

    def test_multiple_kml_files(self, workspace):
        input_dir, kml, out = workspace
        kml2 = input_dir / "test2.kml"
        kml2.write_text(MINIMAL_KML)
        mock_create = _run([str(kml), str(kml2), "--output-dir", str(out)])
        assert mock_create.call_args[0][0] == [str(kml), str(kml2)]

    def test_directory_with_kml_files_sorted_numerically(self, tmp_path):
        kml_dir = tmp_path / "kml_files"
        kml_dir.mkdir()
        for name in ("10_a_b.kml", "2_a_b.kml", "flight3.KML", "readme.txt"):
            (kml_dir / name).write_text(MINIMAL_KML)

        mock_create = _run([str(kml_dir), "--output-dir", str(tmp_path / "out")])

        names = [Path(f).name for f in mock_create.call_args[0][0]]
        assert names == ["2_a_b.kml", "10_a_b.kml", "flight3.KML"]

    def test_directory_is_searched_with_its_subdirectories(self, tmp_path):
        """The obfuscation check sees the same files as the generator."""
        kml_dir = tmp_path / "kml_files"
        (kml_dir / "2025").mkdir(parents=True)
        (kml_dir / "2_a_b.kml").write_text(MINIMAL_KML)
        (kml_dir / "2025" / "1_a_b.kml").write_text(MINIMAL_KML)

        mock_create = _run([str(kml_dir), "--output-dir", str(tmp_path / "out")])

        files = [
            Path(f).relative_to(kml_dir).as_posix() for f in mock_create.call_args[0][0]
        ]
        assert files == ["2_a_b.kml", "2025/1_a_b.kml"]

    def test_directory_without_kml_files_exits(self, tmp_path, capsys):
        empty_dir = tmp_path / "empty"
        empty_dir.mkdir()
        with (
            patch("sys.argv", ["flown", str(empty_dir)]),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 2
        assert "No KML files specified or found" in capsys.readouterr().err

    def test_nonexistent_input_is_an_error(self, workspace, capsys):
        """A mistyped input must not publish a site without its flights."""
        input_dir, kml, out = workspace
        missing = input_dir / "nonexistent.kml"
        mock_create = MagicMock(return_value=True)
        with (
            patch(
                "sys.argv",
                ["flown", str(kml), str(missing), "--output-dir", str(out)],
            ),
            patch("flown.pipeline.build_site", mock_create),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 2
        assert f"File or directory not found: {missing}" in capsys.readouterr().err
        mock_create.assert_not_called()
        assert not out.exists()

    def test_duplicate_inputs_are_processed_once(self, tmp_path, capsys):
        kml_dir = tmp_path / "flights"
        kml_dir.mkdir()
        (kml_dir / "1_a_b.kml").write_text(MINIMAL_KML)
        (kml_dir / "2_a_b.kml").write_text(MINIMAL_KML)

        mock_create = _run(
            [
                str(kml_dir),
                str(kml_dir / "1_a_b.kml"),
                str(kml_dir / ".." / "flights" / "2_a_b.kml"),
                "--output-dir",
                str(tmp_path / "out"),
            ]
        )

        names = [Path(f).name for f in mock_create.call_args[0][0]]
        assert names == ["1_a_b.kml", "2_a_b.kml"]
        assert capsys.readouterr().err.count("Ignoring duplicate input") == 2

    def test_mixed_files_and_directories(self, tmp_path):
        standalone = tmp_path / "one" / "standalone.kml"
        standalone.parent.mkdir()
        standalone.write_text(MINIMAL_KML)
        kml_dir = tmp_path / "many"
        kml_dir.mkdir()
        (kml_dir / "a.kml").write_text(MINIMAL_KML)
        (kml_dir / "b.kml").write_text(MINIMAL_KML)

        mock_create = _run(
            [str(standalone), str(kml_dir), "--output-dir", str(tmp_path / "out")]
        )
        assert len(mock_create.call_args[0][0]) == 3


class TestOutputHandling:
    def test_output_dir_option_and_creation(self, workspace):
        _, kml, out = workspace
        assert not out.exists()

        mock_create = _run([str(kml), "--output-dir", str(out)])

        assert out.is_dir()
        args = mock_create.call_args[0]
        assert args[1] == str(out / "index.html")
        assert args[2] == str(out / "data")

    def test_processing_failure_exits_with_stderr_message(self, workspace, capsys):
        _, kml, out = workspace
        with (
            patch("sys.argv", ["flown", str(kml), "--output-dir", str(out)]),
            patch(
                "flown.pipeline.build_site",
                side_effect=ExportError("Export failed: disk full"),
            ),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 1
        assert capsys.readouterr().err == "Error: Export failed: disk full\n"

    @pytest.mark.parametrize(
        ("error", "status"),
        [
            (InvalidInputError("1 of 2 file(s) hold no flight"), 2),
            (OutputRefusedError("Refusing"), 2),
            (ExportError("Export failed"), 1),
            (FlownError("bundle"), 1),
            (KeyboardInterrupt(), 130),
        ],
    )
    def test_the_exit_status_tells_the_failures_apart(
        self, workspace, capsys, error, status
    ):
        _, kml, out = workspace
        with (
            patch("sys.argv", ["flown", str(kml), "--output-dir", str(out)]),
            patch("flown.pipeline.build_site", side_effect=error),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == status
        err = capsys.readouterr().err
        assert err.count("\n") == 1
        assert err.startswith("Error: ")
        assert "Traceback" not in err

    def test_a_usage_error_exits_with_2(self, capsys):
        with (
            patch("sys.argv", ["flown", "--jobs", "0", "x.kml"]),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 2
        assert "must be at least 1" in capsys.readouterr().err

    def test_overlapping_output_dir_refused_before_processing(self, tmp_path, capsys):
        # The output data directory (<output-dir>/data) would be the input dir
        input_dir = tmp_path / "data"
        input_dir.mkdir()
        kml = input_dir / "test.kml"
        kml.write_text(MINIMAL_KML)
        with pytest.raises(SystemExit) as exc_info:
            _run([str(kml), "--output-dir", str(tmp_path)])
        assert exc_info.value.code == 2
        assert "Refusing" in capsys.readouterr().err
        assert not (tmp_path / "index.html").exists()

    def test_output_dir_equal_to_input_dir_refused(self, workspace, capsys):
        """The tool would replace and remove its own files next to the inputs."""
        input_dir, kml, _ = workspace
        with pytest.raises(SystemExit) as exc_info:
            _run([str(kml), "--output-dir", str(input_dir)])
        assert exc_info.value.code == 2
        assert "Refusing to use output directory" in capsys.readouterr().err
        assert not (input_dir / "index.html").exists()

    @pytest.mark.parametrize("dangerous", ["/", "~"])
    def test_dangerous_output_dir_refused(self, workspace, capsys, dangerous):
        _, kml, _ = workspace
        with pytest.raises(SystemExit) as exc_info:
            _run([str(kml), "--output-dir", os.path.expanduser(dangerous)])
        assert exc_info.value.code == 2
        assert "dangerous" in capsys.readouterr().err

    def test_default_output_dir_next_to_input_is_accepted(self, workspace, monkeypatch):
        """``flown flight.kml`` in the file's directory is the documented use."""
        input_dir, kml, _ = workspace
        monkeypatch.chdir(input_dir)
        mock_create = _run([kml.name])
        args = mock_create.call_args[0]
        # Not the current directory, whose index.html it would overwrite
        assert args[1] == str(Path("docs") / "index.html")
        assert args[2] == str(Path("docs") / "data")
        assert (input_dir / "docs").is_dir()

    def test_a_site_of_its_own_is_refused_before_processing(self, workspace, capsys):
        _, kml, out = workspace
        out.mkdir()
        (out / "index.html").write_text("my own page")

        with pytest.raises(SystemExit) as exc_info:
            _run([str(kml), "--output-dir", str(out)])

        assert exc_info.value.code == 2
        assert "--force" in capsys.readouterr().err
        assert (out / "index.html").read_text() == "my own page"

    def test_force_replaces_a_site_of_its_own(self, workspace):
        _, kml, out = workspace
        out.mkdir()
        (out / "index.html").write_text("my own page")

        mock_create = _run([str(kml), "--output-dir", str(out), "--force"])

        assert mock_create.call_args.kwargs["force"] is True

    def test_unusable_output_dir_is_one_line(self, workspace, capsys):
        _, kml, out = workspace
        out.write_text("a file, not a directory")
        with pytest.raises(SystemExit) as exc_info:
            _run([str(kml), "--output-dir", str(out)])
        assert exc_info.value.code == 1
        err = capsys.readouterr().err
        assert err.startswith("Error: [Errno")
        assert "Traceback" not in err

    @pytest.mark.parametrize(
        "error",
        [
            FlownError("Airport database unavailable"),
            PermissionError(13, "Permission denied"),
        ],
    )
    def test_pipeline_errors_are_one_line(self, workspace, capsys, error):
        _, kml, out = workspace
        with (
            patch("sys.argv", ["flown", str(kml), "--output-dir", str(out)]),
            patch("flown.pipeline.build_site", side_effect=error),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 1
        err = capsys.readouterr().err
        assert f"Error: {error}" in err
        assert "Traceback" not in err


class TestDebugFlag:
    def test_debug_flag_enables_debug_mode(self, workspace):
        _, kml, out = workspace
        with patch("flown.cli.set_debug_mode") as mock_set_debug:
            _run(["--debug", str(kml), "--output-dir", str(out)])
        mock_set_debug.assert_called_once_with(True)


class TestAircraftFiles:
    def test_aircraft_json_from_every_input_directory(self, tmp_path):
        dir_a = tmp_path / "a"
        dir_b = tmp_path / "b"
        dir_c = tmp_path / "c"
        for d in (dir_a, dir_b, dir_c):
            d.mkdir()
            (d / "flight.kml").write_text(MINIMAL_KML)
        (dir_a / "aircraft.json").write_text(json.dumps({"D-EAGJ": "A"}))
        (dir_b / "aircraft.json").write_text(json.dumps({"D-EHYL": "B"}))

        mock_create = _run(
            [
                str(dir_a / "flight.kml"),
                str(dir_b / "flight.kml"),
                str(dir_c / "flight.kml"),
                str(dir_a / "flight.kml"),
                "--output-dir",
                str(tmp_path / "out"),
            ]
        )

        aircraft_files = mock_create.call_args.kwargs["aircraft_files"]
        assert aircraft_files == [dir_a / "aircraft.json", dir_b / "aircraft.json"]

    def test_no_aircraft_json(self, workspace):
        _, kml, out = workspace
        mock_create = _run([str(kml), "--output-dir", str(out)])
        assert mock_create.call_args.kwargs["aircraft_files"] == []


class TestInputsAreLeftAloneByDefault:
    """Without --obfuscate-inputs the user's KML files are never written to.

    The rewrite cannot be undone, and the generated site carries no flight date
    finer than the year either way (tests/test_pipeline_golden.py pins that), so it
    has to be asked for.
    """

    def test_input_file_is_not_rewritten(self, tmp_path):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "flight.kml"
        original = (
            "<kml><Placemark><gx:Track>"
            "<when>2025-03-03T08:25:15Z</when><gx:coord>12.0 51.5 100</gx:coord>"
            "</gx:Track></Placemark></kml>"
        )
        kml.write_text(original)

        _run([str(kml), "--output-dir", str(tmp_path / "out")])

        assert kml.read_text() == original

    def test_charterware_file_is_not_renamed(self, tmp_path):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "2025-03-03_0825h_OE-AKI_LOAV-LOAV.kml"
        kml.write_text(
            "<kml><Placemark><gx:Track>"
            "<when>2025-03-03T08:25:15Z</when><gx:coord>12.0 51.5 100</gx:coord>"
            "</gx:Track></Placemark></kml>"
        )

        mock_create = _run([str(input_dir), "--output-dir", str(tmp_path / "out")])

        assert kml.exists()
        assert mock_create.call_args.args[0] == [str(kml)]

    def test_obfuscation_is_not_even_attempted(self, workspace):
        _, kml, out = workspace

        with patch("flown.obfuscate.obfuscate_kml_files") as mock_obfuscate:
            _run([str(kml), "--output-dir", str(out)])

        mock_obfuscate.assert_not_called()

    def test_a_file_that_keeps_its_dates_does_not_fail_the_run(self, tmp_path):
        """The fail-closed check belongs to the rewrite, not to the export."""
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        # A date in a place the rewrite does not reach, which would abort a
        # run with --obfuscate-inputs (see TestObfuscationFailsClosed)
        kml = input_dir / "2024-03-14 EDAQ.kml"
        kml.write_text(
            '<?xml version="1.0"?><kml><when>2024-03-14T10:00:00Z</when></kml>',
            encoding="utf-8",
        )

        mock_create = _run([str(kml), "--output-dir", str(tmp_path / "out")])

        assert mock_create.called


class TestObfuscateFlag:
    def test_obfuscate_runs_before_processing(self, workspace):
        _, kml, out = workspace
        calls: list[object] = []

        def create(*args, **kwargs):
            calls.append("create")
            return True

        def obfuscate(paths):
            calls.append(("obfuscate", list(paths)))
            return 1

        mock_create = MagicMock(side_effect=create)
        with (
            patch(
                "sys.argv",
                [
                    "flown",
                    "--obfuscate-inputs",
                    str(kml),
                    "--output-dir",
                    str(out),
                ],
            ),
            patch("flown.pipeline.build_site", mock_create),
            patch("flown.obfuscate.obfuscate_kml_files", side_effect=obfuscate),
        ):
            main()
        assert calls == [("obfuscate", [kml]), "create"]

    def test_obfuscate_skips_files_failing_validation(self, workspace):
        input_dir, kml, out = workspace
        link = input_dir / "link.kml"
        os.symlink(kml, link)
        empty = input_dir / "empty.kml"
        empty.write_text("")

        with patch("flown.obfuscate.obfuscate_kml_files") as mock_obfuscate:
            _run(
                [
                    "--obfuscate-inputs",
                    str(link),
                    str(empty),
                    str(kml),
                    "--output-dir",
                    str(out),
                ]
            )

        mock_obfuscate.assert_called_once_with([kml])

    def test_obfuscate_rewrites_input_in_place(self, tmp_path):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "flight.kml"
        kml.write_text(
            "<kml><Placemark><gx:Track>"
            "<when>2025-03-03T08:25:15Z</when><gx:coord>12.0 51.5 100</gx:coord>"
            "</gx:Track></Placemark></kml>"
        )

        _run(["--obfuscate-inputs", str(kml), "--output-dir", str(tmp_path / "out")])

        assert "2025-01-01T00:00:00Z" in kml.read_text()

    def test_renamed_charterware_files_are_processed_under_their_new_name(
        self, tmp_path
    ):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "2025-03-03_0825h_OE-AKI_LOAV-LOAV.kml"
        kml.write_text(
            "<kml><Placemark><gx:Track>"
            "<when>2025-03-03T08:25:15Z</when><gx:coord>12.0 51.5 100</gx:coord>"
            "</gx:Track></Placemark></kml>"
        )

        mock_create = _run(
            [
                "--obfuscate-inputs",
                str(input_dir),
                "--output-dir",
                str(tmp_path / "out"),
            ]
        )

        renamed = input_dir / "2025-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        assert not kml.exists()
        assert "2025-01-01T00:00:00Z" in renamed.read_text()
        assert mock_create.call_args.args[0] == [str(renamed)]

    def test_a_charterware_kmz_is_refused_under_its_own_name(self, tmp_path, capsys):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kmz = input_dir / "2025-03-03_0825h_OE-AKI_LOAV-LOAV.kmz"
        with zipfile.ZipFile(kmz, "w") as archive:
            archive.writestr(
                "doc.kml",
                "<kml><Placemark><gx:Track><when>2025-03-03T08:25:15Z</when>"
                "<gx:coord>12.0 51.5 100</gx:coord></gx:Track></Placemark></kml>",
            )

        with pytest.raises(SystemExit) as exc_info:
            _run(["--obfuscate-inputs", str(kmz), "--output-dir", str(tmp_path / "o")])

        assert exc_info.value.code != 0
        assert list(input_dir.iterdir()) == [kmz]
        assert f"Not obfuscated: {kmz}" in capsys.readouterr().err


class TestMissingBundle:
    def test_stops_before_touching_the_inputs(self, tmp_path, bundle, capsys):
        bundle.unlink()
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "2025-03-03_0825h_OE-AKI_LOAV-LOAV.kml"
        original = (
            "<kml><Placemark><gx:Track><when>2025-03-03T08:25:15Z</when>"
            "<gx:coord>12.0 51.5 100</gx:coord></gx:Track></Placemark></kml>"
        )
        kml.write_text(original)

        with pytest.raises(SystemExit) as excinfo:
            _run(
                [
                    "--obfuscate-inputs",
                    str(input_dir),
                    "--output-dir",
                    str(tmp_path / "out"),
                ]
            )

        assert excinfo.value.code == 1
        assert "npm run build" in capsys.readouterr().err
        assert kml.read_text() == original
        assert not (tmp_path / "out").exists()


class TestObfuscationFailsClosed:
    def test_exits_when_a_file_still_contains_dates(self, tmp_path, monkeypatch):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "1_DEAGJ_DA20.kml"
        kml.write_text(
            '<?xml version="1.0"?><kml><when>2024-03-14T10:00:00Z</when></kml>',
            encoding="utf-8",
        )

        # Simulate a rewrite that leaves the real date in place
        monkeypatch.setattr("flown.obfuscate.obfuscate_kml_files", lambda _: 0)

        with pytest.raises(SystemExit) as excinfo:
            _run(
                ["--obfuscate-inputs", str(kml), "--output-dir", str(tmp_path / "out")]
            )
        assert excinfo.value.code == 1

    def test_names_the_dates_it_could_not_remove(self, tmp_path, capsys):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        # A date in a place the obfuscation does not rewrite
        kml = input_dir / "flight.kml"
        kml.write_text(
            '<?xml version="1.0"?><kml><when>2024-01-01T00:00:00Z</when>'
            "<ExtendedData>2024-03-14</ExtendedData></kml>",
            encoding="utf-8",
        )

        with pytest.raises(SystemExit):
            _run(
                ["--obfuscate-inputs", str(kml), "--output-dir", str(tmp_path / "out")]
            )

        err = capsys.readouterr().err
        assert "Not obfuscated: " in err
        assert "Date not on Jan 1: 2024-03-14" in err
        assert "removed by hand" in err

    def test_lists_a_few_dates_and_counts_the_rest(self, tmp_path, capsys):
        input_dir = tmp_path / "input"
        input_dir.mkdir()
        kml = input_dir / "flight.kml"
        dates = " ".join(f"2024-03-{day:02d}" for day in range(10, 20))
        kml.write_text(
            "<kml><when>2024-01-01T00:00:00Z</when>"
            f"<ExtendedData>{dates}</ExtendedData></kml>",
            encoding="utf-8",
        )

        with pytest.raises(SystemExit):
            _run(
                ["--obfuscate-inputs", str(kml), "--output-dir", str(tmp_path / "out")]
            )

        err = capsys.readouterr().err
        assert "2024-03-14" in err
        assert "... and 5 more" in err


FIXTURE_FLIGHTS = Path(__file__).parent / "fixtures" / "visual"

# EDAW and EDBA are not in the small airport database of the tests, so their
# names count as free text there
LISTING = """\
    file               year  aircraft  airports                                                   points  timed  note
ok  1_DEAGJ_DA20.kml   2025  D-EAGJ    EDAQ Halle-Oppin - EDAQ Halle-Oppin                        612     yes    published
--  2_DEAGJ_DA20.kml   2025  D-EAGJ    EDAQ Halle-Oppin - EDAQ Halle-Oppin                        612     yes    an exact copy of another file's flight
ok  49_DEHYL_DA40.kml  2025  D-EHYL    EDDH Hamburg Helmut Schmidt - EDDH Hamburg Helmut Schmidt  697     yes    published
ok  55_DEAGJ_DA20.kml  2025  D-EAGJ    EDAW Roitzschjora - EDAQ Halle-Oppin                       423     yes    published
ok  61_DELGD_C182.kml  2025  D-ELGD    EDBA Arnstadt-Alkersleben - EDAQ Halle-Oppin               779     yes    published
ok  75_DEHYL_DA40.kml  2026  D-EHYL    EDAQ Halle-Oppin - EDAQ Halle-Oppin                        469     yes    published
!!  90_DEAGJ_DA20.kml  -     -         -                                                          0       no     fails the build: File is empty: <dir>/90_DEAGJ_DA20.kml
A build would fail on 1 file(s) and publish nothing: fix or remove them
Airport names not from the airport database that would be published, as the route names give them: 'EDAW Roitzschjora', 'EDBA Arnstadt-Alkersleben'
"""  # noqa: E501


@pytest.mark.usefixtures("restore_log_level")
class TestList:
    def test_prints_every_flight_and_why_one_is_left_out(self, tmp_path, capsys):
        flights = tmp_path / "flights"
        shutil.copytree(FIXTURE_FLIGHTS, flights)
        shutil.copy(flights / "1_DEAGJ_DA20.kml", flights / "2_DEAGJ_DA20.kml")
        (flights / "90_DEAGJ_DA20.kml").write_text("")
        before = sorted(path.name for path in flights.iterdir())

        with (
            patch("sys.argv", ["flown", "--list", "-q", str(flights)]),
            patch("flown.terrain.TerrariumTiles") as tiles,
            pytest.raises(SystemExit) as exit_info,
        ):
            main()

        # The status of the build it lists, which the empty file would fail
        assert exit_info.value.code == 2
        captured = capsys.readouterr()
        assert captured.out.replace(str(flights), "<dir>") == LISTING
        assert captured.err.endswith(
            "Error: 1 of 7 input file(s) would fail the build (see the list)\n"
        )
        # Nothing is written, and no tile is asked for
        tiles.assert_not_called()
        assert not (tmp_path / "docs").exists()
        assert sorted(path.name for path in flights.iterdir()) == before

    def test_a_copy_in_another_year_is_an_exact_copy(self):
        """drop_duplicate_paths compares the copies across the years."""
        selection = ExportSelection({2025: [0]}, {0: b"same", 1: b"same"})
        metadata = cast("PathMetadata", {"year": 2026})
        reason = _skip_reason(1, True, selection, {0}, metadata)
        assert reason == "an exact copy of another file's flight"

    def test_names_the_airports_without_a_code(self):
        text = format_listing([FlightListing("a.kml", 2025)], ["Anna", "Bob Smith"])
        assert text.splitlines()[-1] == (
            "Airport names not from the airport database that would be published, "
            "as the route names give them: 'Anna', 'Bob Smith'"
        )
        assert "airport database" not in format_listing([FlightListing("a.kml", 2025)])

    def test_the_symbols_on_a_terminal(self, monkeypatch):
        monkeypatch.setattr("sys.stdout.isatty", lambda: True)
        text = format_listing(
            [
                FlightListing("a.kml", 2025),
                FlightListing("b.kml", skipped="why"),
                FlightListing("c.kml", skipped="why", fails_build=True),
            ]
        )
        assert [line[:1] for line in text.splitlines()[1:4]] == ["✓", "⚠", "✗"]

    def test_names_the_airports_as_the_site_does(self, tmp_path, capsys):
        """Without the dates the site takes out of them."""
        flights = tmp_path / "flights"
        flights.mkdir()
        source = (FIXTURE_FLIGHTS / "1_DEAGJ_DA20.kml").read_text(encoding="utf-8")
        route = "<name>EDAQ Halle-Oppin - EDAQ Halle-Oppin</name>"
        assert route in source
        dated = source.replace(route, "<name>Aunt farm 16.VII.2026 - Home strip</name>")
        (flights / "1_DEAGJ_DA20.kml").write_text(dated, encoding="utf-8")

        with (
            patch("sys.argv", ["flown", "--list", "-q", str(flights)]),
            patch("flown.terrain.TerrariumTiles"),
        ):
            main()

        out = capsys.readouterr().out
        assert "Aunt farm - Home strip" in out
        assert "VII" not in out

    def test_the_log_goes_to_stderr_and_the_table_alone_to_stdout(
        self, tmp_path, capsys
    ):
        flights = tmp_path / "flights"
        shutil.copytree(FIXTURE_FLIGHTS, flights)

        with (
            patch("sys.argv", ["flown", "--list", str(flights)]),
            patch("flown.terrain.TerrariumTiles"),
        ):
            main()

        captured = capsys.readouterr()
        assert captured.out.splitlines()[0].split() == LISTING.splitlines()[0].split()
        assert captured.out.splitlines()[-1] == LISTING.splitlines()[-1]
        assert "5 of 5 flight(s) would be published\n" in captured.out
        assert "INFO" not in captured.out
        assert "INFO: Found 5 KML file(s)" in captured.err

        # A run without --list in the same process logs to stdout again
        _run([str(flights), "--output-dir", str(tmp_path / "out")])
        assert "INFO: Found 5 KML file(s)" in capsys.readouterr().out

    def test_trimmed_ends_are_listed_as_the_site_publishes_them(self, tmp_path, capsys):
        """--trim-ends was ignored: the list showed points the site leaves out."""
        flights = tmp_path / "flights"
        shutil.copytree(FIXTURE_FLIGHTS, flights)

        def points(*options):
            with (
                patch("sys.argv", ["flown", "--list", "-q", *options, str(flights)]),
                patch("flown.terrain.TerrariumTiles"),
            ):
                main()
            rows = capsys.readouterr().out.splitlines()[1:6]
            return {row.split()[1]: int(row.split()[-3]) for row in rows}

        whole = points()
        trimmed = points("--trim-ends", "300")
        assert whole["1_DEAGJ_DA20.kml"] == 612
        assert all(trimmed[name] < whole[name] for name in whole)

    def test_inputs_cannot_be_obfuscated_by_a_listing(self, tmp_path, capsys):
        """It writes nothing: the files kept their dates without a word."""
        flights = tmp_path / "flights"
        shutil.copytree(FIXTURE_FLIGHTS, flights)
        before = {path.name: path.read_bytes() for path in flights.iterdir()}

        with (
            patch("sys.argv", ["flown", "--list", "--obfuscate-inputs", str(flights)]),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()

        assert exc_info.value.code == 2
        assert "--list writes nothing" in capsys.readouterr().err
        assert {path.name: path.read_bytes() for path in flights.iterdir()} == before

    def test_nothing_to_list_is_a_usage_error(self, tmp_path, capsys):
        with (
            patch("sys.argv", ["flown", "--list", str(tmp_path)]),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 2
        assert "No KML files" in capsys.readouterr().err


@pytest.fixture
def restore_log_level():
    """Put the logger back at INFO, on stdout, after a test that changes it."""
    yield
    set_log_level(logging.INFO)
    set_info_stream("stdout")


@pytest.mark.usefixtures("restore_log_level")
class TestQuiet:
    def test_only_the_final_line(self, workspace, capsys):
        _, kml, out = workspace
        result = MagicMock(years=[2025, 2026])

        _run(["-q", str(kml), "--output-dir", str(out)], create_return=result)

        assert logger.getEffectiveLevel() == logging.WARNING
        assert capsys.readouterr().out == f"Wrote the site to {out} (2025, 2026)\n"

    def test_debug_wins(self, workspace, capsys):
        _, kml, out = workspace

        _run(["-q", "--debug", str(kml), "--output-dir", str(out)])

        assert logger.getEffectiveLevel() == logging.DEBUG
        assert "Flown" in capsys.readouterr().out


class TestPrivate:
    def test_is_passed_to_the_pipeline(self, workspace):
        _, kml, out = workspace
        plain = _run([str(kml), "--output-dir", str(out)])
        private = _run(["--private", str(kml), "--output-dir", str(out)])
        assert plain.call_args.kwargs["private"] is False
        assert private.call_args.kwargs["private"] is True


class TestJobs:
    def test_caps_every_pool(self, workspace, monkeypatch):
        _, kml, out = workspace
        monkeypatch.setattr(workers, "_worker_limit", None)
        monkeypatch.setattr(os, "process_cpu_count", lambda: 16)

        _run(["--jobs", "3", str(kml), "--output-dir", str(out)])

        assert workers.default_worker_count() == 3
        assert workers.parse_worker_count(["a.kml"] * 8) <= 3

    @pytest.mark.parametrize("value", ["0", "-1", "many"])
    def test_refuses_a_count_that_is_none(self, value, capsys):
        with (
            patch("sys.argv", ["flown", "--jobs", value, "x.kml"]),
            pytest.raises(SystemExit) as exc_info,
        ):
            main()
        assert exc_info.value.code == 2
        assert "--jobs" in capsys.readouterr().err


class TestCacheDir:
    def test_is_set_before_the_pipeline_is_imported(self, workspace, monkeypatch):
        input_dir, kml, out = workspace
        cache = input_dir.parent / "cache"
        monkeypatch.setenv("FLOWN_CACHE_DIR", "unchanged")

        _run(["--cache-dir", str(cache), str(kml), "--output-dir", str(out)])

        assert os.environ["FLOWN_CACHE_DIR"] == str(cache.resolve())

    def test_the_cache_module_reads_it(self, tmp_path):
        """In a fresh interpreter, as a run of the command line is one."""
        script = (
            "import sys; from flown import cli; argv = sys.argv[1:]; "
            "sys.argv = ['flown', '--cache-dir', argv[0], '--list', argv[1]]\n"
            "try:\n    cli.main()\nexcept SystemExit:\n    pass\n"
            "from flown import cache; print(cache.CACHE_DIR)"
        )
        empty = tmp_path / "empty"
        empty.mkdir()
        env = {k: v for k, v in os.environ.items() if k != "FLOWN_CACHE_DIR"}
        result = subprocess.run(  # noqa: S603
            [sys.executable, "-c", script, str(tmp_path / "c"), str(empty)],
            capture_output=True,
            text=True,
            check=False,
            env=env,
        )
        assert result.stdout.strip() == str((tmp_path / "c").resolve())


class TestRefreshAirports:
    def test_marks_the_cached_database_for_a_download_first(self, workspace, caplog):
        _, kml, out = workspace
        with (
            patch("flown.airport_lookup.refresh_airport_databases") as refresh,
            caplog.at_level(logging.INFO, logger="flown"),
        ):
            mock_create = _run(
                ["--refresh-airports", str(kml), "--output-dir", str(out)]
            )
        refresh.assert_called_once_with()
        mock_create.assert_called_once()
        # The files stay until a download replaces them
        assert (
            "Marked the cached airport database for a fresh download" in caplog.messages
        )

    def test_not_without_the_flag(self, workspace):
        _, kml, out = workspace
        with patch("flown.airport_lookup.refresh_airport_databases") as refresh:
            _run([str(kml), "--output-dir", str(out)])
        refresh.assert_not_called()


class TestAircraftFilesUpToTheRoot:
    def test_the_root_file_covers_its_subdirectories(self, tmp_path):
        root = tmp_path / "data"
        (root / "2025").mkdir(parents=True)
        (root / "2025" / "x.kml").write_text(MINIMAL_KML)
        (root / "aircraft.json").write_text(json.dumps({"D-EAGJ": "A"}))

        mock_create = _run([str(root), "--output-dir", str(tmp_path / "out")])

        assert mock_create.call_args.kwargs["aircraft_files"] == [
            (root / "aircraft.json").resolve()
        ]

    def test_the_nearest_file_comes_first(self, tmp_path):
        root = tmp_path / "data"
        (root / "2025").mkdir(parents=True)
        (root / "y.kml").write_text(MINIMAL_KML)
        (root / "2025" / "x.kml").write_text(MINIMAL_KML)
        (root / "aircraft.json").write_text(
            json.dumps({"D-EAGJ": "root", "D-EHYL": "only at the root"})
        )
        (root / "2025" / "aircraft.json").write_text(json.dumps({"D-EAGJ": "near"}))

        mock_create = _run([str(root), "--output-dir", str(tmp_path / "out")])

        files = mock_create.call_args.kwargs["aircraft_files"]
        assert files == [
            (root / "2025" / "aircraft.json").resolve(),
            (root / "aircraft.json").resolve(),
        ]
        assert merge_aircraft_data(files) == {
            "D-EAGJ": "near",
            "D-EHYL": "only at the root",
        }

    def test_not_above_the_input_root(self, tmp_path):
        root = tmp_path / "data"
        root.mkdir()
        (root / "x.kml").write_text(MINIMAL_KML)
        (tmp_path / "aircraft.json").write_text(json.dumps({"D-EAGJ": "above"}))

        mock_create = _run([str(root), "--output-dir", str(tmp_path / "out")])

        assert mock_create.call_args.kwargs["aircraft_files"] == []
