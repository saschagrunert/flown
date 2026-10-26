"""Tests for cache module."""

import atexit
import contextlib
import fnmatch
import importlib
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import pytest

import flown.cache as cache_module
from flown.cache import (
    CACHE_DIR,
    ENTRY_MAX_AGE_DAYS,
    TOUCH_AFTER_SECONDS,
    atomic_bytes_write,
    atomic_data_write,
    atomic_text_write,
    atomic_write,
    load_bytes,
    load_entry,
    prune_entries,
    source_fingerprint,
    store_bytes,
    store_entry,
)


@pytest.fixture
def umask_022():
    """Run a test under the common 022 umask and restore the previous one."""
    previous = os.umask(0o022)
    try:
        yield
    finally:
        os.umask(previous)


class TestCacheDir:
    def test_cache_dir_follows_environment_setting(self):
        assert Path(os.environ["FLOWN_CACHE_DIR"]) == CACHE_DIR

    def test_cache_dir_is_absolute(self):
        assert CACHE_DIR.is_absolute()

    def test_cache_dir_can_be_created(self):
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        assert CACHE_DIR.is_dir()

    def test_default_cache_dir_below_home(self, monkeypatch, tmp_path):
        monkeypatch.delenv("FLOWN_CACHE_DIR")
        with patch.object(Path, "home", return_value=tmp_path):
            assert cache_module._default_cache_dir() == (tmp_path / ".cache" / "flown")

    @pytest.fixture
    def no_home(self, monkeypatch, tmp_path):
        """No home directory, and a temp directory of the test's own."""

        def home():
            raise RuntimeError("no home")

        monkeypatch.setattr(Path, "home", home)
        monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
        # A refused directory hands the fresh one on through the environment
        monkeypatch.setenv("FLOWN_CACHE_DIR", "unchanged")
        return tmp_path

    def test_default_cache_dir_without_home_uses_tempdir(self, no_home):
        result = cache_module._default_cache_dir()
        assert result == no_home / f"flown-cache-{os.getuid()}"
        assert result.is_dir()
        assert result.stat().st_mode & 0o777 == 0o700
        # Used again by the next run, and by the workers of this one
        assert cache_module._default_cache_dir() == result
        assert os.environ["FLOWN_CACHE_DIR"] == "unchanged"

    @pytest.mark.parametrize("mode", [0o770, 0o777, 0o722])
    def test_a_temp_cache_others_can_write_to_is_refused(self, no_home, mode):
        """Another user could put parse results of their own into it."""
        shared = no_home / f"flown-cache-{os.getuid()}"
        shared.mkdir()
        shared.chmod(mode)

        result = cache_module._default_cache_dir()

        assert result != shared
        assert result.parent == no_home
        assert result.stat().st_mode & 0o777 == 0o700
        assert os.environ["FLOWN_CACHE_DIR"] == str(result)

    @pytest.mark.parametrize("mode", [0o755, 0o750, 0o705])
    def test_a_temp_cache_others_can_read_is_made_private(self, no_home, mode):
        """The parse cache holds the raw flights, real dates among them."""
        shared = no_home / f"flown-cache-{os.getuid()}"
        shared.mkdir()
        shared.chmod(mode)

        result = cache_module._default_cache_dir()

        assert result == shared
        assert result.stat().st_mode & 0o777 == 0o700
        assert os.environ["FLOWN_CACHE_DIR"] == "unchanged"

    def test_the_cache_of_a_run_alone_goes_as_it_exits(self, no_home, monkeypatch):
        """Not a copy of the raw flights left in the temp directory per run."""
        registered = []
        monkeypatch.setattr(
            atexit, "register", lambda *args, **kwargs: registered.append(args)
        )
        shared = no_home / f"flown-cache-{os.getuid()}"
        shared.mkdir()
        shared.chmod(0o777)

        result = cache_module._default_cache_dir()
        (result / "parse.json").write_text("raw")
        for function, *args in registered:
            function(*args)

        assert not result.exists()
        assert shared.is_dir()

    def test_a_temp_cache_of_another_user_is_refused(self, no_home, monkeypatch):
        monkeypatch.setattr(os, "getuid", lambda: 4242)
        result = cache_module._default_cache_dir()
        assert result.name != "flown-cache-4242"
        assert (no_home / "flown-cache-4242").is_dir()

    def test_a_symlinked_temp_cache_is_refused(self, no_home, tmp_path_factory):
        target = tmp_path_factory.mktemp("elsewhere")
        target.chmod(0o700)
        (no_home / f"flown-cache-{os.getuid()}").symlink_to(target)
        result = cache_module._default_cache_dir()
        assert result.parent == no_home
        assert not result.is_symlink()

    def test_module_reads_environment_at_import(self, monkeypatch, tmp_path):
        monkeypatch.setenv("FLOWN_CACHE_DIR", str(tmp_path / "elsewhere"))
        try:
            reloaded = importlib.reload(cache_module)
            assert tmp_path / "elsewhere" == reloaded.CACHE_DIR
        finally:
            monkeypatch.undo()
            importlib.reload(cache_module)
        assert cache_module.CACHE_DIR == CACHE_DIR


MAKE = shutil.which("make")
MAKEFILE = Path(__file__).parent.parent / "Makefile"


@pytest.mark.skipif(MAKE is None, reason="needs make")
class TestMakeBuildCache:
    """The cache directory `make build` mounts into the container."""

    def _build_commands(self, directory: Path, *variables: str) -> str:
        (directory / "data").mkdir(exist_ok=True)
        assert MAKE is not None
        return subprocess.run(  # noqa: S603
            [
                MAKE,
                *("-n", "-s", "-f", str(MAKEFILE), "-C", str(directory)),
                *("build", "CONTAINER_RUNTIME=podman", *variables),
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout

    def test_a_relative_cache_directory_is_mounted_from_where_make_runs(self, tmp_path):
        """Not a volume of the runtime named after it, which a bind mount is."""
        commands = self._build_commands(tmp_path, "FLOWN_CACHE_DIR=cache")
        assert f'-v "{tmp_path}/cache:/cache:Z"' in commands
        assert f'mkdir -p "{tmp_path}/cache"' in commands

    def test_an_absolute_one_with_spaces_stays_as_it_is(self, tmp_path):
        commands = self._build_commands(tmp_path, "CACHE_DIR=/a b/cache")
        assert '-v "/a b/cache:/cache:Z"' in commands


@pytest.mark.skipif(MAKE is None, reason="needs make")
class TestMakeContainersAreConfined:
    """No container of the Makefile runs unconfined, with podman or docker."""

    @pytest.fixture(params=["podman", "docker"])
    def runtime(self, request, tmp_path):
        """A runtime that only says which one it is, as `--version` does."""
        name = "podman version 5.8.8" if request.param == "podman" else "Docker 28"
        path = tmp_path / request.param
        path.write_text(f"#!/bin/sh\necho '{name}'\n")
        path.chmod(0o755)
        return path

    def _commands(self, directory: Path, runtime: Path, target: str) -> str:
        (directory / "data").mkdir(exist_ok=True)
        (directory / "docs").mkdir(exist_ok=True)
        (directory / "docs" / "index.html").write_text("")
        assert MAKE is not None
        return subprocess.run(  # noqa: S603
            [
                MAKE,
                *("-n", "-s", "-f", str(MAKEFILE), "-C", str(directory), target),
                f"CONTAINER_RUNTIME={runtime}",
                # The fallback to the image, whatever Python the host has
                "HOST_PYTHON_OK=false",
            ],
            capture_output=True,
            text=True,
            check=True,
        ).stdout

    @pytest.mark.parametrize(
        "target", ["build", "serve", "obfuscate", "check-obfuscation"]
    )
    def test_every_run_drops_its_privileges(self, tmp_path, runtime, target):
        commands = self._commands(tmp_path, runtime, target)
        runs = [line for line in commands.splitlines() if f"{runtime} run " in line]
        assert runs
        for run in runs:
            assert "--cap-drop=ALL" in run
            assert "--security-opt=no-new-privileges" in run
        assert "label=disable" not in commands
        # Every bind mount is relabeled for SELinux rather than unconfined
        mounts = re.findall(r'-v "[^"]*"', commands)
        assert mounts
        assert all(re.search(r":(?:ro,)?[zZ]\"$", mount) for mount in mounts)
        assert ("--userns=keep-id" in commands) == (runtime.name == "podman")

    def test_serve_runs_read_only(self, tmp_path, runtime):
        commands = self._commands(tmp_path, runtime, "serve")
        assert "--read-only" in commands
        assert f'-v "{tmp_path}/docs:/data:ro,z"' in commands


class TestAtomicWrite:
    @pytest.mark.parametrize(
        "name",
        [
            "a" * 251 + ".kml",
            "\u00e4" * 125 + ".kml",
            "a" * 242 + ".KML",
            "b" * 255,
            "c" * 10 + "." + "d" * 244,
        ],
        ids=["ascii", "two-byte", "capitals", "no-extension", "long-extension"],
    )
    def test_a_name_of_up_to_255_bytes(self, tmp_path, name):
        """The temp file adds 14 bytes, which a long name has no room for.

        Its prefix is shortened instead, before the extension, so a leftover
        of an interrupted obfuscation still matches the patterns it is found
        and ignored by.
        """
        from flown.obfuscate import TEMP_FILE_PATTERN

        path = tmp_path / name
        path.write_text("old")
        temp_names = []

        def write(tmp):
            temp_names.append(Path(tmp.name).name)
            tmp.write("new")

        atomic_write(path, write, keep_mode=True)

        assert path.read_text() == "new"
        assert [p.name for p in tmp_path.iterdir()] == [name]
        (temp_name,) = temp_names
        assert len(os.fsencode(temp_name)) <= 255
        assert fnmatch.fnmatchcase(temp_name, ".*.tmp")
        if name.lower().endswith(".kml"):
            assert TEMP_FILE_PATTERN.match(temp_name)

    def test_result_has_regular_file_mode(self, tmp_path, umask_022):
        path = tmp_path / "site.html"
        atomic_write(path, lambda tmp: tmp.write("<html/>"))
        assert oct(path.stat().st_mode & 0o777) == "0o644"

    def test_umask_is_read_once_at_import(self, tmp_path):
        """Reading the umask means setting it, which must not happen while
        other threads create files; the mode is taken at import."""
        previous = os.umask(0o077)
        try:
            path = tmp_path / "as-imported.txt"
            atomic_text_write(path, "x")
            assert path.stat().st_mode & 0o777 == 0o666 & ~previous

            reloaded = importlib.reload(cache_module)
            assert reloaded.REGULAR_FILE_MODE == 0o600
            path = tmp_path / "private.txt"
            atomic_text_write(path, "x")
            assert oct(path.stat().st_mode & 0o777) == "0o600"
        finally:
            os.umask(previous)
            importlib.reload(cache_module)
        assert 0o666 & ~previous == cache_module.REGULAR_FILE_MODE

    def test_replaces_existing_file(self, tmp_path):
        path = tmp_path / "file.txt"
        path.write_text("old")
        atomic_text_write(path, "new")
        assert path.read_text() == "new"

    def test_temp_file_removed_when_writer_fails(self, tmp_path):
        path = tmp_path / "file.txt"

        def boom(_tmp):
            raise ValueError("writer failed")

        with pytest.raises(ValueError, match="writer failed"):
            atomic_write(path, boom)
        assert list(tmp_path.iterdir()) == []

    def test_writer_error_leaves_existing_file_intact(self, tmp_path):
        path = tmp_path / "file.txt"
        path.write_text("keep")

        def boom(_tmp):
            raise OSError("disk full")

        with pytest.raises(OSError, match="disk full"):
            atomic_write(path, boom)
        assert path.read_text() == "keep"
        assert [p.name for p in tmp_path.iterdir()] == ["file.txt"]

    def test_newline_keeps_line_endings(self, tmp_path):
        path = tmp_path / "flight.kml"
        atomic_write(path, lambda tmp: tmp.write("a\r\nb\n"), newline="")
        assert path.read_bytes() == b"a\r\nb\n"

    def test_keep_mode_takes_the_mode_of_the_replaced_file(self, tmp_path):
        path = tmp_path / "flight.kml"
        path.write_text("old")
        path.chmod(0o640)
        atomic_write(path, lambda tmp: tmp.write("new"), keep_mode=True)
        assert path.read_text() == "new"
        assert oct(path.stat().st_mode & 0o777) == "0o640"

    def test_keep_mode_needs_a_file_to_replace(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            atomic_write(
                tmp_path / "missing.kml", lambda tmp: tmp.write("x"), keep_mode=True
            )
        assert list(tmp_path.iterdir()) == []

    def test_durable_flushes_the_file_then_its_directory(self, tmp_path):
        path = tmp_path / "flight.kml"
        synced = []
        real_fsync = os.fsync

        def fsync(fd):
            synced.append(os.fstat(fd))
            real_fsync(fd)

        with patch("flown.cache.os.fsync", side_effect=fsync):
            atomic_write(path, lambda tmp: tmp.write("x"), durable=True)
        assert path.read_text() == "x"
        # The data before the rename, the directory entry after it
        assert [stat.st_ino for stat in synced] == [
            path.stat().st_ino,
            tmp_path.stat().st_ino,
        ]

    def test_a_directory_that_cannot_be_flushed_is_no_failure(self, tmp_path):
        path = tmp_path / "flight.kml"
        calls = 0
        real_fsync = os.fsync

        def fsync(fd):
            nonlocal calls
            calls += 1
            if calls > 1:
                raise OSError("not supported")
            real_fsync(fd)

        with patch("flown.cache.os.fsync", side_effect=fsync):
            atomic_write(path, lambda tmp: tmp.write("x"), durable=True)
        assert path.read_text() == "x"

    def test_directory_fsync_tolerates_errors(self, tmp_path):
        with patch("flown.cache.os.fsync") as fsync:
            cache_module._fsync_directory(tmp_path / "missing")
        fsync.assert_not_called()
        closed = []
        real_close = os.close

        def recording_close(fd):
            closed.append(fd)
            real_close(fd)

        with (
            patch("flown.cache.os.fsync", side_effect=OSError("nope")),
            patch("flown.cache.os.close", side_effect=recording_close),
        ):
            cache_module._fsync_directory(tmp_path)
        # The directory is closed again although the flush failed
        assert len(closed) == 1

    def test_not_durable_by_default(self, tmp_path):
        with patch("flown.cache.os.fsync") as fsync:
            atomic_text_write(tmp_path / "file.txt", "x")
        fsync.assert_not_called()

    def test_a_temp_file_that_cannot_be_removed_is_no_second_error(self, tmp_path):
        path = tmp_path / "test.json"

        with (
            patch("flown.cache.os.replace", side_effect=OSError("replace")),
            patch("flown.cache.os.unlink", side_effect=OSError("unlink")),
            pytest.raises(OSError, match="replace"),
        ):
            atomic_write(path, lambda tmp: tmp.write("{}"))

        assert not path.exists()


class TestAtomicBytesWrite:
    def test_writes_bytes_with_regular_file_mode(self, tmp_path, umask_022):
        path = tmp_path / "tile.png"
        atomic_bytes_write(path, b"\x89PNG")
        assert path.read_bytes() == b"\x89PNG"
        assert oct(path.stat().st_mode & 0o777) == "0o644"
        assert [p.name for p in tmp_path.iterdir()] == ["tile.png"]

    def test_failed_replace_leaves_no_temp_file(self, tmp_path):
        path = tmp_path / "tile.png"
        path.write_bytes(b"old")
        with (
            patch("flown.cache.os.replace", side_effect=OSError("boom")),
            pytest.raises(OSError, match="boom"),
        ):
            atomic_bytes_write(path, b"new")
        assert path.read_bytes() == b"old"
        assert [p.name for p in tmp_path.iterdir()] == ["tile.png"]


class TestAtomicDataWrite:
    def test_writes_compact_json(self, tmp_path):
        path = tmp_path / "data.json"
        atomic_data_write(path, {"key": "value"})

        content = path.read_text()
        assert content == '{"key":"value"}'

    def test_sort_keys(self, tmp_path):
        path = tmp_path / "data.json"
        atomic_data_write(path, {"b": 2, "a": 1}, sort_keys=True)

        content = path.read_text()
        assert content == '{"a":1,"b":2}'

    def test_no_temp_files_left_behind(self, tmp_path):
        atomic_data_write(tmp_path / "data.json", [1, 2])
        assert [p.name for p in tmp_path.iterdir()] == ["data.json"]

    def test_readable_by_others(self, tmp_path, umask_022):
        path = tmp_path / "data.json"
        atomic_data_write(path, [1])
        assert path.stat().st_mode & 0o044 == 0o044

    def test_cleans_up_temp_on_replace_failure(self, tmp_path):
        path = tmp_path / "data.json"
        with (
            patch("flown.cache.os.replace", side_effect=OSError("boom")),
            contextlib.suppress(OSError),
        ):
            atomic_data_write(path, {"a": 1})

        assert not path.exists()
        assert list(tmp_path.iterdir()) == []


class TestEntries:
    """The entries of the build caches (see store_entry and load_entry)."""

    def test_an_entry_is_read_back(self, tmp_path):
        path = tmp_path / "kept" / "entry.json.zst"
        store_entry(path, {"pairs": [[1, 0]]})
        assert load_entry(path) == {"pairs": [[1, 0]]}
        assert oct(path.parent.stat().st_mode & 0o777) == "0o700"
        assert oct(path.stat().st_mode & 0o777) == "0o600"

    def test_none_without_an_entry_or_with_a_broken_one(self, tmp_path):
        path = tmp_path / "entry.json.zst"
        assert load_entry(path) is None
        path.write_bytes(b"not zstd")
        assert load_entry(path) is None

    def test_a_directory_that_is_not_this_users_own_is_not_used(self, tmp_path):
        """A symlink to a directory anybody may write to."""
        shared = tmp_path / "shared"
        shared.mkdir()
        store_entry(shared / "entry.json.zst", [1])
        link = tmp_path / "link"
        link.symlink_to(shared)
        assert load_entry(link / "entry.json.zst") is None
        store_entry(link / "other.json.zst", [2])
        assert not (shared / "other.json.zst").exists()

    def test_entries_not_used_for_a_month_go_when_one_is_stored(self, tmp_path):
        old = time.time() - (ENTRY_MAX_AGE_DAYS + 1) * 24 * 3600
        directory = tmp_path / "kept"
        store_entry(directory / "unused.json.zst", [1])
        store_entry(directory / "used.json.zst", [2])
        leftover = directory / ".unused.json.zst.abcdefgh.tmp"
        leftover.write_bytes(b"")
        for name in ("unused.json.zst", "used.json.zst", leftover.name):
            os.utime(directory / name, (old, old))
        assert load_entry(directory / "used.json.zst") == [2]

        store_entry(directory / "new.json.zst", [3])

        assert sorted(entry.name for entry in directory.iterdir()) == [
            "new.json.zst",
            "used.json.zst",
        ]

    def test_a_failed_write_costs_nothing_but_the_entry(self, tmp_path):
        path = tmp_path / "entry.json.zst"
        with patch("flown.cache.os.replace", side_effect=OSError("full")):
            store_entry(path, [1])
        assert load_entry(path) is None
        assert list(tmp_path.iterdir()) == []


class TestBytesEntries:
    """Entries of bytes as they are (see store_bytes and load_bytes)."""

    def test_an_entry_is_read_back_as_it_was_stored(self, tmp_path):
        path = tmp_path / "kept" / "entry"
        store_bytes(path, b"\x00\x01")
        assert load_bytes(path) == b"\x00\x01"
        assert oct(path.stat().st_mode & 0o777) == "0o600"

    def test_none_for_an_entry_that_cannot_be_read(self, tmp_path):
        assert load_bytes(tmp_path / "missing") is None
        (tmp_path / "a directory").mkdir()
        assert load_bytes(tmp_path / "a directory") is None

    def test_a_read_touches_an_entry_once_a_day(self, tmp_path):
        """Often enough for the pruning; a build in the page writes back
        every entry whose time changed (IDBFS)."""
        path = tmp_path / "kept" / "entry"
        store_bytes(path, b"1")
        recent = time.time() - TOUCH_AFTER_SECONDS / 2
        os.utime(path, (recent, recent))
        assert load_bytes(path) == b"1"
        assert path.stat().st_mtime == recent

        old = time.time() - TOUCH_AFTER_SECONDS - 60
        os.utime(path, (old, old))
        assert load_bytes(path) == b"1"
        assert path.stat().st_mtime > time.time() - 60

    def test_many_entries_are_pruned_once(self, tmp_path):
        """A caller that stores an entry per flight prunes after the last."""
        old = time.time() - (ENTRY_MAX_AGE_DAYS + 1) * 24 * 3600
        directory = tmp_path / "kept"
        store_bytes(directory / "unused", b"1")
        os.utime(directory / "unused", (old, old))

        store_bytes(directory / "new", b"2", prune=False)
        assert (directory / "unused").exists()
        prune_entries(directory)

        assert sorted(entry.name for entry in directory.iterdir()) == ["new"]


class TestSourceFingerprint:
    def test_changes_with_the_code_of_the_modules(self, tmp_path):
        (tmp_path / "a.py").write_text("x = 1\n")
        (tmp_path / "b.py").write_text("y = 1\n")
        first = source_fingerprint(tmp_path, ("a", "b"))
        (tmp_path / "b.py").write_text("y = 2\n")
        second = source_fingerprint(tmp_path, ("a", "b"))
        (tmp_path / "a.py").unlink()
        third = source_fingerprint(tmp_path, ("a", "b"))
        assert len({first, second, third}) == 3
        assert len(first) == 8
