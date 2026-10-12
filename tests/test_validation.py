"""Tests for validation module."""

import os
import zipfile
from pathlib import Path, PureWindowsPath
from unittest.mock import patch

import pytest

import flown.validation as val_mod
from flown.validation import (
    find_kml_files,
    foreign_site_files,
    is_protected_directory,
    list_kml_files,
    protected_directories,
    validate_kml_file,
    validate_output_dir,
)


class TestValidateKmlFile:
    def test_valid_kml_file(self, tmp_path):
        path = tmp_path / "test.kml"
        path.write_text('<?xml version="1.0"?><kml><Document></Document></kml>')
        assert validate_kml_file(str(path)) == (True, None)

    def test_uppercase_extension_accepted(self, tmp_path):
        path = tmp_path / "TEST.KML"
        path.write_text("<kml/>")
        assert validate_kml_file(str(path)) == (True, None)

    @pytest.mark.parametrize("name", ["track.kmz", "TRACK.KMZ"])
    def test_kmz_accepted(self, tmp_path, name):
        path = tmp_path / name
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("doc.kml", "<kml/>")
        assert validate_kml_file(str(path)) == (True, None)

    def test_nonexistent_file(self, tmp_path):
        is_valid, error = validate_kml_file(str(tmp_path / "missing.kml"))
        assert is_valid is False
        assert error is not None
        assert "not found" in error

    def test_symlink_rejected(self, tmp_path):
        target = tmp_path / "real.kml"
        target.write_text("<kml/>")
        link = tmp_path / "link.kml"
        os.symlink(target, link)
        is_valid, error = validate_kml_file(str(link))
        assert is_valid is False
        assert error is not None
        assert "Symlinks" in error

    def test_non_kml_extension(self, tmp_path):
        path = tmp_path / "test.txt"
        path.write_text("<kml/>")
        is_valid, error = validate_kml_file(str(path))
        assert is_valid is False
        assert error is not None
        assert ".kml" in error

    def test_empty_file(self, tmp_path):
        path = tmp_path / "test.kml"
        path.write_text("")
        is_valid, error = validate_kml_file(str(path))
        assert is_valid is False
        assert error is not None
        assert "empty" in error.lower()

    def test_directory_instead_of_file(self, tmp_path):
        is_valid, error = validate_kml_file(str(tmp_path))
        assert is_valid is False
        assert error is not None
        assert "Not a file" in error

    def test_unreadable_file(self, tmp_path):
        path = tmp_path / "test.kml"
        path.write_text("<kml/>")
        path.chmod(0o000)
        try:
            if os.access(path, os.R_OK):
                return  # running as root, permissions are not enforced
            is_valid, error = validate_kml_file(str(path))
            assert is_valid is False
            assert error is not None
            assert "not readable" in error
        finally:
            path.chmod(0o644)

    def test_file_too_large(self, tmp_path, monkeypatch):
        path = tmp_path / "test.kml"
        path.write_text('<?xml version="1.0"?><kml/>')
        monkeypatch.setattr(val_mod, "MAX_KML_FILE_SIZE", 1)
        is_valid, error = validate_kml_file(str(path))
        assert is_valid is False
        assert error is not None
        assert "too large" in error.lower()


class TestValidateOutputDir:
    def test_output_dir_equal_to_input_dir_refused(self, tmp_path):
        kml = tmp_path / "a.kml"
        is_valid, error = validate_output_dir(tmp_path, [kml])
        assert is_valid is False
        assert error is not None
        assert "Refusing to use output directory" in error

    def test_parent_of_input_dir_refused(self, tmp_path):
        kml = tmp_path / "flights" / "2025" / "a.kml"
        assert validate_output_dir(tmp_path, [kml])[0] is False

    @pytest.mark.parametrize("dangerous", ["/", "~"])
    def test_home_and_root_refused(self, tmp_path, dangerous):
        kml = tmp_path / "a.kml"
        is_valid, error = validate_output_dir(os.path.expanduser(dangerous), [kml])
        assert is_valid is False
        assert error is not None
        assert "dangerous" in error

    def test_root_refused_without_home(self, tmp_path):
        with patch.object(Path, "home", side_effect=RuntimeError("no home")):
            assert protected_directories() == (Path("/"),)
            assert validate_output_dir("/", [])[0] is False

    def test_home_behind_a_symlink_refused(self, tmp_path, monkeypatch):
        """The output is resolved, so the home it is compared with must be."""
        home = tmp_path / "real-home"
        home.mkdir()
        link = tmp_path / "home-link"
        link.symlink_to(home)
        monkeypatch.setenv("HOME", str(link))

        assert home in protected_directories()
        for given in (link, home):
            is_valid, error = validate_output_dir(given, [tmp_path / "in" / "a.kml"])
            assert is_valid is False
            assert error is not None
            assert "dangerous" in error

    @pytest.mark.parametrize(
        "root", [PureWindowsPath("D:/"), PureWindowsPath("//server/share/")]
    )
    def test_the_root_of_every_drive_is_protected(self, root):
        """On Windows "/" is the root of the current drive only."""
        assert is_protected_directory(root)
        assert not is_protected_directory(root / "site")

    def test_separate_directories_are_fine(self, tmp_path):
        kml = tmp_path / "input" / "a.kml"
        assert validate_output_dir(tmp_path / "out" / "data", [kml]) == (True, None)

    def test_sibling_of_input_dir_is_fine(self, tmp_path):
        kml = tmp_path / "input" / "a.kml"
        assert validate_output_dir(tmp_path / "input-data", [kml])[0] is True

    def test_equal_to_input_dir_refused(self, tmp_path):
        kml = tmp_path / "data" / "a.kml"
        is_valid, error = validate_output_dir(tmp_path / "data", [kml])
        assert is_valid is False
        assert error is not None
        assert "Refusing" in error
        assert str(tmp_path / "data") in error

    def test_below_input_dir_is_fine(self, tmp_path):
        """The documented ``flight.kml --output-dir out`` from the file's directory."""
        kml = tmp_path / "a.kml"
        assert validate_output_dir(tmp_path / "out" / "data", [kml]) == (True, None)

    def test_default_output_dir_next_to_input_is_fine(self, tmp_path):
        """``--output-dir .`` puts the data directory below the input directory."""
        kml = tmp_path / "a.kml"
        assert validate_output_dir(tmp_path / "data", [kml]) == (True, None)

    def test_containing_input_dir_refused(self, tmp_path):
        kml = tmp_path / "out" / "data" / "flights" / "a.kml"
        assert validate_output_dir(tmp_path / "out" / "data", [kml])[0] is False

    def test_aircraft_json_is_checked_too(self, tmp_path):
        kml = tmp_path / "input" / "a.kml"
        aircraft = tmp_path / "out" / "data" / "aircraft.json"
        assert (
            validate_output_dir(tmp_path / "out" / "data", [kml, aircraft])[0] is False
        )

    def test_relative_paths_are_resolved(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        assert validate_output_dir("data", ["data/a.kml"])[0] is False
        assert validate_output_dir("out/data", ["input/a.kml"])[0] is True

    def test_no_inputs(self, tmp_path):
        assert validate_output_dir(tmp_path / "data", []) == (True, None)


class TestForeignSiteFiles:
    OWNED = ("index.html", "styles.css", "vendor/maplibre-gl.js")

    def test_nothing_there(self, tmp_path):
        assert foreign_site_files(tmp_path, tmp_path / "data", self.OWNED) == []

    def test_the_files_a_run_would_replace(self, tmp_path):
        (tmp_path / "index.html").write_text("")
        (tmp_path / "vendor").mkdir()
        (tmp_path / "vendor" / "maplibre-gl.js").write_text("")
        (tmp_path / "flags").mkdir()
        (tmp_path / "flags" / "de.svg").write_text("")
        (tmp_path / "data" / "2025").mkdir(parents=True)
        (tmp_path / "data" / "2025" / "data.json").write_text("")
        (tmp_path / "data" / "airports.json").write_text("")
        (tmp_path / "notes.txt").write_text("")

        found = foreign_site_files(
            tmp_path, tmp_path / "data", self.OWNED, ("flags/*.svg",)
        )

        assert [path.relative_to(tmp_path).as_posix() for path in found] == [
            "index.html",
            "vendor/maplibre-gl.js",
            "flags/de.svg",
            "data/airports.json",
            "data/2025/data.json",
        ]

    def test_a_symlink_counts(self, tmp_path):
        (tmp_path / "index.html").symlink_to(tmp_path / "missing")
        assert foreign_site_files(tmp_path, tmp_path / "data", self.OWNED) == [
            tmp_path / "index.html"
        ]

    @pytest.mark.parametrize("marker", ["map_config.js", "data/metadata.json"])
    def test_an_earlier_run_is_no_foreign_site(self, tmp_path, marker):
        (tmp_path / "index.html").write_text("")
        (tmp_path / marker).parent.mkdir(exist_ok=True)
        (tmp_path / marker).write_text("")
        assert foreign_site_files(tmp_path, tmp_path / "data", self.OWNED) == []


class TestFindKmlFiles:
    def test_lists_subdirectories_in_numeric_order(self, tmp_path):
        for name in (
            "10_a.kml",
            "2_a.kml",
            "flight.KML",
            "readme.txt",
            "4_c.kmz",
            "sub/3_b.kml",
            "sub/1_b.kml",
            "sub/deeper/x.kml",
        ):
            path = tmp_path / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("<kml/>")

        found = [p.relative_to(tmp_path).as_posix() for p in find_kml_files(tmp_path)]

        assert found == [
            "2_a.kml",
            "4_c.kmz",
            "10_a.kml",
            "flight.KML",
            "sub/1_b.kml",
            "sub/3_b.kml",
            "sub/deeper/x.kml",
        ]

    def test_apple_double_files_and_git_are_left_out(self, tmp_path):
        # macOS writes an AppleDouble file next to every file on a foreign
        # disk; it is no KML and would fail the whole run. Other hidden
        # files stay listed, for the obfuscation check to see them.
        for name in (
            "1_a.kml",
            "._1_a.kml",
            ".git/x.kml",
            ".2_y.kml",
            ".old/1_x.kml",
            ".old/._1_x.kml",
        ):
            path = tmp_path / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("<kml/>")

        found = [p.relative_to(tmp_path).as_posix() for p in find_kml_files(tmp_path)]

        assert found == ["1_a.kml", ".2_y.kml", ".old/1_x.kml"]

    def test_symlinks_to_files_are_listed_but_directories_not_followed(self, tmp_path):
        target = tmp_path / "elsewhere" / "t.kml"
        target.parent.mkdir()
        target.write_text("<kml/>")
        data = tmp_path / "data"
        data.mkdir()
        (data / "link.kml").symlink_to(target)
        (data / "linked-dir").symlink_to(tmp_path / "elsewhere")
        (data / "dir.kml").mkdir()

        assert [p.name for p in find_kml_files(data)] == ["link.kml"]

    def test_unlistable_directory_yields_nothing(self, tmp_path):
        assert find_kml_files(tmp_path / "missing") == []

    def test_unlistable_directories_come_back(self, tmp_path):
        (tmp_path / "1_x.kml").touch()
        missing = tmp_path / "missing"
        real_iterdir = Path.iterdir

        def iterdir(path):
            if path == tmp_path / "sub":
                raise PermissionError("denied")
            return real_iterdir(path)

        (tmp_path / "sub").mkdir()
        with patch.object(Path, "iterdir", iterdir):
            listing = list_kml_files(tmp_path)
        assert listing.files == [tmp_path / "1_x.kml"]
        assert listing.unlisted == [tmp_path / "sub"]
        assert list_kml_files(missing).unlisted == [missing]
