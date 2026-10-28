"""Tests for parser_cache module."""

import hashlib
import json
import logging
import math
import os
import shutil
import time
from array import array
from compression import zstd
from pathlib import Path
from unittest.mock import patch

import pytest

import flown.airport_lookup as lookup_module
import flown.parser_cache as parser_cache_module
from flown.airport_lookup import database_fingerprint
from flown.landings import FlightLandings
from flown.parser_cache import (
    CACHE_FORMAT_VERSION,
    CACHE_MAX_AGE_DAYS,
    CACHE_SUFFIX,
    KML_CACHE_DIR,
    _join_entry,
    _split_entry,
    get_cache_key,
    load_cached_parse,
    parser_fingerprint,
    prune_stale_cache_entries,
    save_to_cache,
)
from flown.types import PathMetadata, TrackPoint

SHARED = TrackPoint(50.0, 8.5, 300.0, 1000.5)
COORDS = [SHARED, TrackPoint(51.0, 9.5, None, None)]
# The path point is the very object that sits in the coordinate list, as the
# parsers build it
PATHS = [[SHARED]]
METADATA: list[PathMetadata] = [
    {
        "filename": "test.kml",
        "start_point": [50.0, 8.5, 300.0],
        "airport_name": "",
        "year": 2025,
    }
]
DAY = 24 * 3600


def _expected_name(kml):
    digest = hashlib.blake2b(kml.name.encode() + b"\0", digest_size=16)
    digest.update(kml.read_bytes())
    return (
        f"{digest.hexdigest()}_v{CACHE_FORMAT_VERSION}_{parser_fingerprint()}"
        f"_{database_fingerprint()}{CACHE_SUFFIX}"
    )


def _entry(cache_dir, name, age_days=0.0):
    entry = cache_dir / name
    entry.write_text("{}")
    stamp = time.time() - age_days * DAY
    os.utime(entry, (stamp, stamp))
    return entry


class TestGetCacheKey:
    def test_nonexistent_file(self, tmp_path):
        assert get_cache_key(str(tmp_path / "missing.kml"), cache_dir=tmp_path) == (
            None,
            False,
        )

    def test_key_includes_content_version_parser_and_database(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")

        cache_path, valid = get_cache_key(str(kml), cache_dir=tmp_path / "cache")

        assert valid is False
        assert cache_path is not None
        assert cache_path.parent == tmp_path / "cache"
        assert cache_path.name == _expected_name(kml)

    def test_default_cache_dir(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_path, _ = get_cache_key(str(kml))
        assert cache_path is not None
        assert cache_path.parent == parser_cache_module.KML_CACHE_DIR

    def test_default_cache_dir_is_below_the_cache_directory(self):
        assert KML_CACHE_DIR.name == "kml"

    def test_the_cache_is_this_users_alone(self, tmp_path):
        """The entries hold the raw flights, real dates and times among them."""
        previous = os.umask(0o022)
        try:
            kml = tmp_path / "test.kml"
            kml.write_bytes(b"<kml/>")
            cache_dir = tmp_path / "cache" / "kml"
            cache_path, _ = get_cache_key(str(kml), cache_dir=cache_dir)
            assert cache_path is not None
            save_to_cache(cache_path, [], [], [])
        finally:
            os.umask(previous)
        assert cache_dir.stat().st_mode & 0o777 == 0o700
        assert cache_dir.parent.stat().st_mode & 0o777 == 0o700
        assert cache_path.stat().st_mode & 0o777 == 0o600

    @pytest.mark.parametrize("mode", [0o755, 0o775, 0o777])
    def test_a_cache_others_may_enter_is_made_private(self, tmp_path, mode):
        """As an older version or a umask of 022 left it."""
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "kml"
        cache_dir.mkdir()
        cache_dir.chmod(mode)
        cache_path, _ = get_cache_key(str(kml), cache_dir=cache_dir)
        assert cache_path is not None
        assert cache_dir.stat().st_mode & 0o777 == 0o700

    def test_a_cache_that_cannot_be_made_private_is_not_used(
        self, tmp_path, monkeypatch
    ):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "kml"
        cache_dir.mkdir()
        cache_dir.chmod(0o755)

        def refuse(self, mode):
            raise PermissionError("no")

        monkeypatch.setattr(Path, "chmod", refuse)
        assert get_cache_key(str(kml), cache_dir=cache_dir) == (None, False)

    def test_a_symlinked_cache_is_not_used(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        target = tmp_path / "elsewhere"
        target.mkdir()
        (tmp_path / "kml").symlink_to(target)
        assert get_cache_key(str(kml), cache_dir=tmp_path / "kml") == (None, False)

    def test_a_cache_of_another_user_is_not_used(self, tmp_path, monkeypatch):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        monkeypatch.setattr(os, "getuid", lambda: os.geteuid() + 4242)
        assert get_cache_key(str(kml), cache_dir=tmp_path / "kml") == (None, False)

    def test_unwritable_cache_dir_disables_cache(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        blocker = tmp_path / "file"
        blocker.write_text("not a directory")
        assert get_cache_key(str(kml), cache_dir=blocker / "cache") == (None, False)

    def test_unreadable_file_disables_cache(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        with patch("builtins.open", side_effect=OSError("denied")):
            assert get_cache_key(str(kml), cache_dir=tmp_path / "cache") == (
                None,
                False,
            )

    def test_valid_after_save(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        cache_path, _ = get_cache_key(str(kml), cache_dir=cache_dir)
        assert cache_path is not None
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        assert get_cache_key(str(kml), cache_dir=cache_dir) == (cache_path, True)

    def test_content_change_invalidates_key(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml>one</kml>")
        stat = kml.stat()
        cache_dir = tmp_path / "cache"
        first, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        # Same size and modification time: a key built from those would miss it
        kml.write_bytes(b"<kml>two</kml>")
        os.utime(kml, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        second, valid = get_cache_key(str(kml), cache_dir=cache_dir)

        assert second != first
        assert valid is False

    def test_key_survives_a_checkout(self, tmp_path):
        """A fresh clone has new modification times and another path."""
        kml = tmp_path / "a" / "1_DEAGJ_DA20.kml"
        kml.parent.mkdir()
        kml.write_bytes(b"<kml/>")
        clone = tmp_path / "b" / "1_DEAGJ_DA20.kml"
        clone.parent.mkdir()
        shutil.copyfile(kml, clone)
        stat = kml.stat()
        os.utime(clone, ns=(stat.st_atime_ns, stat.st_mtime_ns + 5_000_000_000))
        cache_dir = tmp_path / "cache"

        first, _ = get_cache_key(str(kml), cache_dir=cache_dir)
        second, _ = get_cache_key(str(clone), cache_dir=cache_dir)

        assert first == second

    def test_file_name_is_part_of_the_key(self, tmp_path):
        """The parse result carries the name and the aircraft taken from it."""
        first = tmp_path / "1_DEAGJ_DA20.kml"
        second = tmp_path / "1_DEHYL_DA40.kml"
        first.write_bytes(b"<kml/>")
        second.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"

        assert get_cache_key(str(first), cache_dir=cache_dir) != get_cache_key(
            str(second), cache_dir=cache_dir
        )

    def test_parser_change_invalidates_key(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        first, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        with patch.object(
            parser_cache_module, "parser_fingerprint", return_value="0badc0de"
        ):
            second, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        assert second != first
        assert second is not None
        assert "_0badc0de_" in second.name

    def test_airport_database_change_invalidates_key(self, tmp_path):
        """Names are standardized with the database, so it is part of the key."""
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        database = tmp_path / "airports.csv"

        with patch.object(lookup_module, "CACHE_FILE", database):
            without_db, _ = get_cache_key(str(kml), cache_dir=cache_dir)
            database.write_text("ident,name\n")
            with_db, _ = get_cache_key(str(kml), cache_dir=cache_dir)
            database.write_text("ident,name\nEDDF,Frankfurt\n")
            with_other_db, _ = get_cache_key(str(kml), cache_dir=cache_dir)

        assert without_db is not None
        assert without_db.name.endswith(f"_nodb{CACHE_SUFFIX}")
        assert len({without_db, with_db, with_other_db}) == 3


class TestParserFingerprint:
    def test_changes_with_the_parser_code(self, tmp_path):
        package = tmp_path / "flown"
        package.mkdir()
        for module in parser_cache_module._PARSER_MODULES:
            (package / f"{module}.py").write_text(f"# {module}\n")
        fake_file = str(package / "parser_cache.py")

        with patch.object(parser_cache_module, "__file__", fake_file):
            parser_fingerprint.cache_clear()
            first = parser_fingerprint()
            (package / "parser_common.py").write_text("# changed\n")
            parser_fingerprint.cache_clear()
            second = parser_fingerprint()
            (package / "parser_standard.py").unlink()
            parser_fingerprint.cache_clear()
            third = parser_fingerprint()
        parser_fingerprint.cache_clear()

        assert len({first, second, third}) == 3
        assert len(first) == 8
        assert parser_fingerprint() != first

    def test_covers_every_module_the_parser_imports(self):
        """A module the parse depends on has to change the fingerprint.

        Its code decides what a parse returns (date_tokens decides what a
        registration is), and an entry cached before a change to it would be
        read as if nothing had changed. Only the modules that cannot change
        a parse result are left out.
        """
        import ast

        package = Path(parser_cache_module.__file__).parent
        without_effect = {"__init__", "cache", "exceptions", "logger"}
        seen: set[str] = set()
        # The parse finds the landings of its paths as well
        pending = ["parser", "landings"]
        while pending:
            module = pending.pop()
            if module in seen:
                continue
            seen.add(module)
            tree = ast.parse((package / f"{module}.py").read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom) and node.level == 1:
                    pending.extend(
                        [node.module]
                        if node.module
                        else [alias.name for alias in node.names]
                    )
        imported = {m for m in seen if (package / f"{m}.py").is_file()}
        assert imported - without_effect == set(parser_cache_module._PARSER_MODULES)


class TestPruneStaleCacheEntries:
    def _current_suffix(self):
        return (
            f"_v{CACHE_FORMAT_VERSION}_{parser_fingerprint()}"
            f"_{database_fingerprint()}{CACHE_SUFFIX}"
        )

    def test_removes_entries_no_key_can_produce(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        digest = "0123456789abcdef0123456789abcdef"
        current = _entry(cache_dir, digest + self._current_suffix())
        old_version = _entry(
            cache_dir,
            f"{digest}_v{CACHE_FORMAT_VERSION - 1}_{parser_fingerprint()}"
            f"_{database_fingerprint()}{CACHE_SUFFIX}",
        )
        old_database = _entry(
            cache_dir,
            f"{digest}_v{CACHE_FORMAT_VERSION}_{parser_fingerprint()}_nodb{CACHE_SUFFIX}",
        )
        unrelated = _entry(cache_dir, "notes.txt", age_days=365)

        removed = prune_stale_cache_entries(cache_dir=cache_dir)

        assert removed == 2
        assert sorted(p.name for p in cache_dir.iterdir()) == sorted(
            [current.name, unrelated.name]
        )
        assert not any(p.exists() for p in (old_version, old_database))

    def test_removes_the_json_entries_of_version_8(self, tmp_path):
        """Version 8 wrote compressed JSON, under a .json.zst name."""
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        json_entry = _entry(
            cache_dir,
            f"{'0' * 32}_v8_{parser_fingerprint()}_{database_fingerprint()}.json.zst",
        )

        assert prune_stale_cache_entries(cache_dir=cache_dir) == 1
        assert not json_entry.exists()

    def test_entries_of_another_parser_go_by_their_age(self, tmp_path):
        """A checkout on another commit shares the directory and reads them."""
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        other = f"_v{CACHE_FORMAT_VERSION}_00000000_{database_fingerprint()}"
        recent = _entry(cache_dir, "a" * 32 + other + CACHE_SUFFIX, age_days=1)
        old = _entry(cache_dir, "b" * 32 + other + CACHE_SUFFIX, CACHE_MAX_AGE_DAYS + 1)

        assert prune_stale_cache_entries(cache_dir=cache_dir) == 1
        assert recent.exists()
        assert not old.exists()

    def test_removes_the_uncompressed_entries_of_version_5(self, tmp_path):
        """What an earlier release wrote: plain JSON, under a .json name."""
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        digest = "0123456789abcdef0123456789abcdef"
        name = f"{digest}_v5_{parser_fingerprint()}_{database_fingerprint()}"
        uncompressed = _entry(cache_dir, name + ".json")
        # The name of this version, without the suffix of a compressed entry
        plain = _entry(
            cache_dir,
            f"{digest}_v{CACHE_FORMAT_VERSION}_{parser_fingerprint()}"
            f"_{database_fingerprint()}.json",
        )

        assert prune_stale_cache_entries(cache_dir=cache_dir) == 2
        assert not uncompressed.exists()
        assert not plain.exists()

    def test_removes_entries_unused_for_too_long(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        fresh = _entry(cache_dir, "a" * 32 + self._current_suffix(), age_days=1)
        old = _entry(
            cache_dir, "b" * 32 + self._current_suffix(), CACHE_MAX_AGE_DAYS + 1
        )
        old_tmp = _entry(cache_dir, ".x.json.abc.tmp", CACHE_MAX_AGE_DAYS + 1)
        new_tmp = _entry(cache_dir, ".y.json.abc.tmp")

        assert prune_stale_cache_entries(cache_dir=cache_dir) == 2
        assert fresh.exists()
        assert new_tmp.exists()
        assert not old.exists()
        assert not old_tmp.exists()

    def test_loading_an_entry_renews_it(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        entry = cache_dir / ("c" * 32 + self._current_suffix())
        save_to_cache(entry, COORDS, PATHS, METADATA)
        stamp = time.time() - (CACHE_MAX_AGE_DAYS + 1) * DAY
        os.utime(entry, (stamp, stamp))

        assert load_cached_parse(entry) is not None
        assert prune_stale_cache_entries(cache_dir=cache_dir) == 0
        assert entry.exists()

    def test_loading_a_recent_entry_leaves_its_time(self, tmp_path):
        """A build in the page writes back every entry whose time changed."""
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        entry = cache_dir / ("c" * 32 + self._current_suffix())
        save_to_cache(entry, COORDS, PATHS, METADATA)
        stamp = time.time() - DAY / 2
        os.utime(entry, (stamp, stamp))

        assert load_cached_parse(entry) is not None
        assert entry.stat().st_mtime == stamp

    def test_get_cache_key_does_not_prune(self, tmp_path):
        kml = tmp_path / "test.kml"
        kml.write_bytes(b"<kml/>")
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        stale = _entry(cache_dir, f"{'0' * 32}_v1_00000000_nodb{CACHE_SUFFIX}")

        get_cache_key(str(kml), cache_dir=cache_dir)

        assert stale.exists()

    def test_missing_directory_is_ignored(self, tmp_path):
        assert prune_stale_cache_entries(cache_dir=tmp_path / "no") == 0

    def test_default_directory(self, tmp_path):
        with patch.object(parser_cache_module, "KML_CACHE_DIR", tmp_path):
            _entry(tmp_path, f"{'0' * 32}_v1_00000000_nodb{CACHE_SUFFIX}")
            assert prune_stale_cache_entries() == 1

    def test_vanished_entry_is_ignored(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        entry = _entry(cache_dir, "d" * 32 + self._current_suffix())
        real_stat = Path.stat

        def stat(path, *args, **kwargs):
            if path == entry:
                raise OSError("gone")
            return real_stat(path, *args, **kwargs)

        with patch.object(Path, "stat", stat):
            assert prune_stale_cache_entries(cache_dir=cache_dir) == 0

    def test_unlink_errors_are_ignored(self, tmp_path):
        cache_dir = tmp_path / "cache"
        cache_dir.mkdir()
        _entry(cache_dir, f"{'0' * 32}_v1_00000000_nodb{CACHE_SUFFIX}")

        with patch.object(Path, "unlink", side_effect=OSError("mock")):
            assert prune_stale_cache_entries(cache_dir=cache_dir) == 0


class TestSaveAndLoad:
    def test_an_entry_is_compressed(self, tmp_path):
        cache_path = tmp_path / f"entry{CACHE_SUFFIX}"
        save_to_cache(cache_path, COORDS, [], [])

        data = cache_path.read_bytes()
        # The magic number of a zstd frame
        assert data.startswith(b"\x28\xb5\x2f\xfd")
        assert _split_entry(data)[0]["version"] == CACHE_FORMAT_VERSION
        assert load_cached_parse(cache_path) is not None

    def test_an_uncompressed_entry_is_a_miss(self, tmp_path):
        cache_path = tmp_path / f"entry{CACHE_SUFFIX}"
        cache_path.write_text(json.dumps({"version": CACHE_FORMAT_VERSION}))
        assert load_cached_parse(cache_path) is None

    def test_an_entry_of_version_8_is_a_miss(self, tmp_path):
        """Compressed JSON with the points in it, as version 8 wrote them."""
        cache_path = tmp_path / f"entry{CACHE_SUFFIX}"
        cache_path.write_bytes(
            zstd.compress(
                json.dumps(
                    {
                        "version": 8,
                        "coordinates": [[50.0, 8.5, 300.0, 1000.5]],
                        "path_groups": [[0]],
                        "path_metadata": [{}],
                        "warnings": [],
                    }
                ).encode()
            )
        )
        assert load_cached_parse(cache_path) is None

    def test_round_trip_preserves_track_points_and_identity(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)

        loaded = load_cached_parse(cache_path)

        assert loaded == (COORDS, PATHS, METADATA, [], None)
        coordinates, path_groups, _, _, _ = loaded
        assert all(isinstance(p, TrackPoint) for p in coordinates)
        assert coordinates[1].alt is None
        assert coordinates[1].ts is None
        # A path point is the coordinate entry itself, as after parsing
        assert path_groups[0][0] is coordinates[0]

    def test_points_round_trip_to_the_last_bit(self, tmp_path):
        """The columns are doubles: nothing is rounded on the way."""
        cache_path = tmp_path / "cache.parse.zst"
        points = [
            TrackPoint(50.123456789012345, -8.000000000000001, 0.1 + 0.2, 1e9 / 3),
            TrackPoint(-89.99999999999999, 179.99999999999997, None, 1.5),
            TrackPoint(0.0, -0.0, -12.25, None),
        ]
        save_to_cache(cache_path, points, [points], METADATA)

        loaded = load_cached_parse(cache_path)

        assert loaded is not None
        assert [tuple(map(repr, p)) for p in loaded.coordinates] == [
            tuple(map(repr, p)) for p in points
        ]

    def test_file_format_is_explicit(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        header, rest = _split_entry(cache_path.read_bytes())
        assert header["version"] == CACHE_FORMAT_VERSION
        assert header["points"] == 2
        assert header["coordinates"] == 2
        assert header["path_lengths"] == [1]
        assert header["path_metadata"] == METADATA
        latitudes, longitudes, altitudes, times = (
            array("d", rest[n * 16 : (n + 1) * 16]).tolist() for n in range(4)
        )
        assert latitudes == [50.0, 51.0]
        assert longitudes == [8.5, 9.5]
        assert altitudes[0] == 300.0
        assert math.isnan(altitudes[1])
        assert times[0] == 1000.5
        assert math.isnan(times[1])
        assert array("i", rest[64:]).tolist() == [0]

    def test_path_point_outside_coordinates_is_stored_in_full(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        extra = TrackPoint(52.0, 10.0, 100.0, None)
        save_to_cache(cache_path, COORDS, [[SHARED, extra]], METADATA)

        header, _ = _split_entry(cache_path.read_bytes())
        assert (header["points"], header["coordinates"]) == (3, 2)
        loaded = load_cached_parse(cache_path)
        assert loaded is not None
        assert loaded.coordinates == COORDS
        assert loaded.path_groups == [[SHARED, extra]]

    def _rewrite(self, cache_path, change, rest=None):
        """Change the header of an entry (and the bytes after it)."""
        header, old_rest = _split_entry(cache_path.read_bytes())
        change(header)
        cache_path.write_bytes(_join_entry(header, old_rest if rest is None else rest))

    def test_version_mismatch_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        self._rewrite(
            cache_path, lambda header: header.update(version=CACHE_FORMAT_VERSION - 1)
        )
        assert load_cached_parse(cache_path) is None

    def test_missing_version_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        self._rewrite(cache_path, lambda header: header.pop("version"))
        assert load_cached_parse(cache_path) is None

    def test_corrupt_data_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        cache_path.write_text("invalid")
        assert load_cached_parse(cache_path) is None
        cache_path.write_bytes(zstd.compress(b"\xff\xff\xff\x7f{}"))
        assert load_cached_parse(cache_path) is None
        cache_path.write_bytes(_join_entry({"version": CACHE_FORMAT_VERSION}, b""))
        assert load_cached_parse(cache_path) is None

    def test_a_header_that_is_no_object_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        encoded = b"[1]"
        cache_path.write_bytes(
            zstd.compress(len(encoded).to_bytes(4, "little") + encoded)
        )
        assert load_cached_parse(cache_path) is None

    def test_metadata_that_is_no_list_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        self._rewrite(cache_path, lambda header: header.update(path_metadata={}))
        assert load_cached_parse(cache_path) is None

    def test_a_big_endian_machine_swaps_the_bytes_both_ways(
        self, tmp_path, monkeypatch
    ):
        """The entries are little endian: a cache moved between machines."""
        native = tmp_path / "native.parse.zst"
        swapped = tmp_path / "swapped.parse.zst"
        save_to_cache(native, COORDS, PATHS, METADATA)
        monkeypatch.setattr("sys.byteorder", "big")

        save_to_cache(swapped, COORDS, PATHS, METADATA)

        assert (
            _split_entry(swapped.read_bytes())[1]
            != (_split_entry(native.read_bytes())[1])
        )
        loaded = load_cached_parse(swapped)
        assert loaded is not None
        assert loaded.coordinates == COORDS

    @pytest.mark.parametrize(
        "change",
        [
            {"points": 3},
            {"points": "2"},
            {"coordinates": 3},
            {"coordinates": -1},
            {"path_lengths": [2]},
            {"path_lengths": "1"},
            {"path_lengths": [-1]},
        ],
        ids=[
            "more-points",
            "points-no-number",
            "more-coordinates-than-points",
            "negative-coordinates",
            "longer-path",
            "lengths-no-list",
            "negative-length",
        ],
    )
    def test_counts_that_do_not_fit_are_rejected(self, tmp_path, change):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        self._rewrite(cache_path, lambda header: header.update(change))
        assert load_cached_parse(cache_path) is None

    def test_cut_short_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        _, rest = _split_entry(cache_path.read_bytes())
        self._rewrite(cache_path, lambda header: None, rest[:-1])
        assert load_cached_parse(cache_path) is None

    def test_index_out_of_range_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        _, rest = _split_entry(cache_path.read_bytes())
        self._rewrite(
            cache_path, lambda header: None, rest[:64] + array("i", [7]).tobytes()
        )
        assert load_cached_parse(cache_path) is None

    def test_a_point_without_a_position_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        _, rest = _split_entry(cache_path.read_bytes())
        latitudes = array("d", [math.nan, 51.0]).tobytes()
        self._rewrite(cache_path, lambda header: None, latitudes + rest[16:])
        assert load_cached_parse(cache_path) is None

    def test_paths_without_their_metadata_are_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        self._rewrite(
            cache_path,
            lambda header: header.update(path_metadata=header["path_metadata"][:-1]),
        )
        assert load_cached_parse(cache_path) is None

    def test_metadata_that_is_no_object_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        self._rewrite(
            cache_path,
            lambda header: header.update(
                path_metadata=["not an object"] * len(header["path_metadata"])
            ),
        )
        assert load_cached_parse(cache_path) is None

    def test_landings_round_trip(self, tmp_path):
        """One per path, kept as the parse found them (see path_landings)."""
        cache_path = tmp_path / "cache.parse.zst"
        landings = [
            FlightLandings(
                takeoffs=1,
                landings=2,
                touch_and_goes=1,
                touchdowns=[("EDAQ", "09"), ("EDAQ", None)],
            )
        ]
        save_to_cache(cache_path, COORDS, PATHS, METADATA, landings=landings)
        loaded = load_cached_parse(cache_path)
        assert loaded is not None
        assert loaded.landings == landings
        first = loaded.landings[0]
        assert first is not None
        assert isinstance(first.touchdowns[0], tuple)

        save_to_cache(cache_path, COORDS, PATHS, METADATA, landings=[None])
        loaded = load_cached_parse(cache_path)
        assert loaded is not None
        assert loaded.landings == [None]

    def test_landings_of_other_paths_are_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA, landings=[None, None])
        assert load_cached_parse(cache_path) is None

    def test_warnings_round_trip(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        warnings = [(logging.WARNING, "a.kml: 2 line(s) without usable altitudes")]
        save_to_cache(cache_path, COORDS, PATHS, METADATA, warnings)
        loaded = load_cached_parse(cache_path)
        assert loaded is not None
        assert loaded.warnings == warnings

    def test_entry_without_warnings_is_rejected(self, tmp_path):
        cache_path = tmp_path / "cache.parse.zst"
        save_to_cache(cache_path, COORDS, PATHS, METADATA)
        self._rewrite(cache_path, lambda header: header.pop("warnings"))
        assert load_cached_parse(cache_path) is None

    def test_missing_file(self, tmp_path):
        assert load_cached_parse(tmp_path / "missing.json") is None

    @pytest.mark.skipif(
        hasattr(os, "geteuid") and os.geteuid() == 0,
        reason="root ignores directory permissions",
    )
    def test_save_error_is_swallowed(self, tmp_path):
        read_only = tmp_path / "ro"
        read_only.mkdir()
        read_only.chmod(0o555)
        try:
            save_to_cache(read_only / "cache.parse.zst", [], [], [])
            assert not (read_only / "cache.parse.zst").exists()
        finally:
            read_only.chmod(0o755)
