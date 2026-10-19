"""Tests for workers module."""

import logging
import pickle
import zipfile
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool
from unittest.mock import MagicMock, mock_open, patch

import pytest

import flown.airport_lookup as lookup_module
import flown.workers as workers_module
from flown.logger import logger, set_debug_mode
from flown.workers import init_worker, parse_worker_count

MB = 1024 * 1024


class TestInitWorker:
    def test_enables_debug(self):
        try:
            init_worker(logging.DEBUG)
            assert logger.level == logging.DEBUG
        finally:
            set_debug_mode(False)

    def test_without_debug_keeps_info_level(self):
        init_worker(logging.INFO)
        assert logger.level == logging.INFO

    def test_does_not_load_the_airport_database(self):
        """Export workers never look up airports; lookups load it lazily."""
        init_worker(logging.INFO)
        assert lookup_module.databases.airports is None

    def test_uses_the_database_of_the_parent(self, monkeypatch):
        """Parse workers must not read the 86,000 row CSV again."""
        lookup_module.databases.reset()
        record = lookup_module.AirportRecord(1.0, 2.0, "Parent Field", "DE")
        init_worker(logging.INFO, pickle.dumps({"ZZZZ": record}))
        with patch.object(lookup_module, "_read_database") as read_csv:
            assert lookup_module.lookup_airport_coordinates("ZZZZ") == (
                1.0,
                2.0,
                "Parent Field",
            )
        read_csv.assert_not_called()

    def test_uses_the_runways_of_the_parent(self):
        """Each parse worker read the runway CSV again (0.2 s)."""
        lookup_module.databases.reset()
        runways = {"ZZZZ": ()}
        init_worker(logging.INFO, None, pickle.dumps(runways))
        with patch.object(lookup_module, "_read_database") as read_csv:
            assert lookup_module.load_runway_database() == runways
        read_csv.assert_not_called()
        lookup_module.databases.reset()

    def test_uses_the_fingerprint_of_the_parent(self):
        """Not one of the files on disk, which a download may have replaced."""
        lookup_module.databases.reset()
        try:
            init_worker(logging.INFO, pickle.dumps({}), pickle.dumps({}), "0badf00d")
            assert lookup_module.database_fingerprint() == "0badf00d"
        finally:
            lookup_module.databases.reset()

    def test_a_fingerprint_without_both_databases_is_not_used(self):
        """The worker loads what it lacks itself, which the fingerprint misses."""
        lookup_module.databases.reset()
        try:
            init_worker(logging.INFO, b"not a pickle", pickle.dumps({}), "0badf00d")
            assert lookup_module.database_fingerprint() != "0badf00d"
        finally:
            lookup_module.databases.reset()

    def test_a_broken_database_is_loaded_lazily(self, monkeypatch):
        lookup_module.databases.reset()
        init_worker(logging.INFO, b"not a pickle")
        assert lookup_module.databases.airports is None


class TestParseWorkerCount:
    @pytest.fixture(autouse=True)
    def _every_byte_pays_off(self, monkeypatch):
        """The files here are a few bytes: the size limits are what counts."""
        monkeypatch.setattr(workers_module, "MIN_PARSE_BYTES_PER_WORKER", 1)

    def test_little_kml_gets_few_workers(self, tmp_path, monkeypatch):
        """A worker costs a process start and the databases before its file."""
        monkeypatch.setattr(workers_module, "MIN_PARSE_BYTES_PER_WORKER", 100)
        files = self._files(tmp_path, *[60] * 10)
        with (
            patch("os.process_cpu_count", return_value=16),
            patch.object(workers_module, "_available_memory_bytes", return_value=None),
        ):
            assert parse_worker_count(files) == 6

    def _files(self, tmp_path, *sizes):
        paths = []
        for index, size in enumerate(sizes):
            path = tmp_path / f"{index}.kml"
            path.write_bytes(b"x" * size)
            paths.append(str(path))
        return paths

    def test_one_worker_per_cpu_when_memory_suffices(self, tmp_path):
        files = self._files(tmp_path, 10, 10, 10)
        with (
            patch("os.process_cpu_count", return_value=2),
            patch.object(
                workers_module, "_available_memory_bytes", return_value=64_000 * MB
            ),
        ):
            assert parse_worker_count(files) == 2

    def test_never_more_workers_than_files(self, tmp_path):
        files = self._files(tmp_path, 10)
        with patch("os.process_cpu_count", return_value=8):
            assert parse_worker_count(files) == 1

    def test_large_files_limit_the_pool(self, tmp_path):
        """A 121 MB gx:Track took 1.68 GB; eight at once must not start."""
        files = self._files(tmp_path, 1000, 10, 10, 10)
        per_large = workers_module.WORKER_BASE_BYTES + 1000 * 15
        per_small = workers_module.WORKER_BASE_BYTES + 10 * 15
        available = per_large + per_small + per_small // 2
        with (
            patch("os.process_cpu_count", return_value=8),
            patch.object(
                workers_module, "_available_memory_bytes", return_value=available
            ),
        ):
            assert parse_worker_count(files) == 2

    def test_at_least_one_worker(self, tmp_path):
        files = self._files(tmp_path, 1000, 1000)
        with patch.object(workers_module, "_available_memory_bytes", return_value=1):
            assert parse_worker_count(files) == 1

    def test_unknown_memory_does_not_limit(self, tmp_path):
        files = self._files(tmp_path, 10, 10, 10)
        with (
            patch("os.process_cpu_count", return_value=4),
            patch.object(workers_module, "_available_memory_bytes", return_value=None),
        ):
            assert parse_worker_count(files) == 3

    def test_a_kmz_counts_with_the_kml_inside(self, tmp_path):
        """A KMZ is ten to twenty times smaller than the KML it holds."""
        kmz = tmp_path / "large.kmz"
        with zipfile.ZipFile(kmz, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("doc.kml", b" " * MB)
        assert kmz.stat().st_size < MB // 100
        files = [str(kmz), *self._files(tmp_path, 10, 10)]
        per_large = workers_module.WORKER_BASE_BYTES + MB * 15
        per_small = workers_module.WORKER_BASE_BYTES + 10 * 15
        # Room for all three if the archive counted with its own size
        available = per_large + per_small // 2
        with (
            patch("os.process_cpu_count", return_value=8),
            patch.object(
                workers_module, "_available_memory_bytes", return_value=available
            ),
        ):
            assert parse_worker_count(files) == 1

    def test_missing_file_counts_as_empty(self, tmp_path):
        with patch.object(
            workers_module, "_available_memory_bytes", return_value=64_000 * MB
        ):
            assert parse_worker_count([str(tmp_path / "missing.kml")]) == 1


class TestAvailableMemory:
    def test_reads_meminfo(self):
        meminfo = "MemTotal: 16000000 kB\nMemAvailable:    2048 kB\n"
        with patch("builtins.open", mock_open(read_data=meminfo)):
            assert workers_module._available_memory_bytes() == 2048 * 1024

    def test_falls_back_to_sysconf(self):
        with (
            patch("builtins.open", side_effect=OSError("no /proc")),
            patch(
                "os.sysconf", side_effect=lambda name: 4096 if "SIZE" in name else 10
            ),
        ):
            assert workers_module._available_memory_bytes() == 40960

    def test_unknown_without_meminfo_and_sysconf(self):
        with (
            patch("builtins.open", mock_open(read_data="MemTotal: 1 kB\n")),
            patch("os.sysconf", side_effect=ValueError("unsupported")),
        ):
            assert workers_module._available_memory_bytes() is None

    def test_container_limit_wins_over_host_memory(self, tmp_path):
        (tmp_path / "memory.max").write_text(f"{2048 * MB}\n")
        (tmp_path / "memory.current").write_text(f"{768 * MB}\n")
        # Page cache the kernel can drop counts as available
        (tmp_path / "memory.stat").write_text(
            f"anon {512 * MB}\ninactive_file {256 * MB}\nactive_file 0\n"
        )
        with (
            patch.object(workers_module, "CGROUP_DIR", str(tmp_path)),
            patch.object(
                workers_module, "_host_available_bytes", return_value=64_000 * MB
            ),
        ):
            assert workers_module._available_memory_bytes() == 1536 * MB

    def test_unlimited_cgroup_keeps_host_memory(self, tmp_path):
        (tmp_path / "memory.max").write_text("max\n")
        with (
            patch.object(workers_module, "CGROUP_DIR", str(tmp_path)),
            patch.object(workers_module, "_host_available_bytes", return_value=MB),
        ):
            assert workers_module._available_memory_bytes() == MB

    def test_container_limit_without_memory_stat(self, tmp_path):
        (tmp_path / "memory.max").write_text(f"{1024 * MB}\n")
        (tmp_path / "memory.current").write_text(f"{1024 * MB}\n")
        with (
            patch.object(workers_module, "CGROUP_DIR", str(tmp_path)),
            patch.object(workers_module, "_host_available_bytes", return_value=None),
        ):
            assert workers_module._available_memory_bytes() == 0


class TestDefaultWorkerCount:
    def _count(self, tmp_path, cpu_max, cpus=16):
        if cpu_max is not None:
            (tmp_path / "cpu.max").write_text(cpu_max)
        with (
            patch.object(workers_module, "CGROUP_DIR", str(tmp_path)),
            patch("os.process_cpu_count", return_value=cpus),
        ):
            return workers_module.default_worker_count()

    def test_a_cpu_quota_limits_the_workers(self, tmp_path):
        """docker run --cpus=2 on a host of 16 CPUs."""
        assert self._count(tmp_path, "200000 100000\n") == 2

    def test_part_of_a_cpu_counts_as_one(self, tmp_path):
        assert self._count(tmp_path, "150000 100000\n") == 2
        assert self._count(tmp_path, "10000 100000\n") == 1

    def test_no_quota_keeps_every_cpu(self, tmp_path):
        assert self._count(tmp_path, "max 100000\n") == 16
        assert self._count(tmp_path, None) == 16
        assert self._count(tmp_path, "garbage") == 16

    def test_jobs_limit_the_workers_further(self, tmp_path):
        workers_module.configure_workers(1)
        try:
            assert self._count(tmp_path, "400000 100000\n") == 1
        finally:
            workers_module.configure_workers(None)


def _double(value):
    return value * 2


def _broken_future(*_args, **_kwargs):
    future: Future[int] = Future()
    future.set_exception(BrokenProcessPool("a worker died"))
    return future


class TestWorkerPool:
    def test_without_processes_a_pool_works_here_without_trying(self, caplog):
        """The build in the page, which has none (flown.browser)."""
        pool_class = MagicMock()
        workers_module.configure_workers(1, processes=False)
        with (
            patch.object(workers_module, "ProcessPoolExecutor", pool_class),
            workers_module.WorkerPool(2, "testing") as pool,
        ):
            assert pool.submit(_double, 2).result() == 4
            assert list(pool.map(_double, [1, 2])) == [2, 4]
        pool_class.assert_not_called()
        assert "failed" not in caplog.text

    def test_a_pool_that_cannot_start_works_here(self, caplog):
        with (
            patch.object(
                workers_module,
                "ProcessPoolExecutor",
                MagicMock(side_effect=OSError("no semaphores")),
            ),
            workers_module.WorkerPool(2, "testing") as pool,
        ):
            assert pool.submit(_double, 2).result() == 4
            assert list(pool.map(_double, [1, 2])) == [2, 4]
        assert "processes for testing failed (no semaphores)" in caplog.text

    def test_a_pool_that_cannot_start_its_workers_works_here(self):
        pool_class = MagicMock()
        pool_class.return_value.submit.side_effect = OSError("no processes")
        with (
            patch.object(workers_module, "ProcessPoolExecutor", pool_class),
            workers_module.WorkerPool(2, "testing") as pool,
        ):
            assert pool.submit(_double, 3).result() == 6
            # Given up: the next task does not try the pool again
            assert pool.submit(_double, 4).result() == 8
        pool_class.return_value.submit.assert_called_once()
        pool_class.return_value.shutdown.assert_called_once()

    def test_a_broken_pool_does_the_task_again_here(self, caplog):
        pool_class = MagicMock()
        pool_class.return_value.submit.side_effect = _broken_future
        with (
            patch.object(workers_module, "ProcessPoolExecutor", pool_class),
            workers_module.WorkerPool(2, "testing") as pool,
        ):
            futures = [pool.submit(_double, value) for value in (1, 2)]
            assert [
                pool.result(f, _double, v) for f, v in zip(futures, (1, 2), strict=True)
            ] == [2, 4]
        # Once, however many tasks it broke
        assert caplog.text.count("going on in this process") == 1

    def test_a_task_that_fails_here_fails_its_future(self):
        with (
            patch.object(
                workers_module, "ProcessPoolExecutor", MagicMock(side_effect=OSError)
            ),
            workers_module.WorkerPool(1, "testing") as pool,
        ):
            future = pool.submit(int, "not a number")
            with pytest.raises(ValueError, match="not a number"):
                future.result()

    def test_the_workers_get_the_initializer(self):
        pool_class = MagicMock()
        with patch.object(workers_module, "ProcessPoolExecutor", pool_class):
            workers_module.WorkerPool(3, "testing", (logging.DEBUG,)).shutdown()
        pool_class.assert_called_once_with(
            max_workers=3, initializer=init_worker, initargs=(logging.DEBUG,)
        )
