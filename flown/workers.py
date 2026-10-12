"""Initialization and sizing of process pool workers.

Python 3.14 starts workers with the ``forkserver`` method, so the parent's
logging configuration is not inherited. The initializer restores the log
level (debug, the default or --quiet). The export workers never look up an
airport and do not get the airport database; the parse workers get the one
the parent loaded, which takes a tenth of the time of reading the CSV again
in every worker. ``--jobs`` caps every pool (see ``configure_workers``).
"""

import contextlib
import math
import os
import pickle
from concurrent.futures import Executor, Future, ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
from typing import TYPE_CHECKING, Any

from .airport_lookup import (
    use_airport_database,
    use_database_fingerprint,
    use_runway_database,
)
from .logger import logger, set_log_level
from .parser import parse_size

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable, Iterator, Sequence

__all__ = [
    "WorkerPool",
    "configure_workers",
    "default_worker_count",
    "init_worker",
    "parse_worker_count",
]

# Peak memory of a parse worker per byte of its KML file, with the landings
# and the cache entry of the parse (an 88 MB LineString file took 1.8 GB, a
# 93 MB gx:Track file 1.6 GB: a line packs more points into a byte), and
# what the interpreter and its modules take anyway
PARSE_BYTES_PER_FILE_BYTE = 22
WORKER_BASE_BYTES = 100 * 1024 * 1024

# The most workers any pool of the run gets (--jobs), None for every CPU
_worker_limit: int | None = None


def configure_workers(jobs: int | None) -> None:
    """Cap every pool of this process at ``jobs`` workers (None lifts the cap)."""
    # One setting per process, which the command line sets before any pool
    global _worker_limit  # noqa: PLW0603
    _worker_limit = jobs if jobs is None or jobs > 0 else 1


def _cgroup_cpu_limit() -> int | None:
    """The CPUs the cgroup v2 quota allows, rounded up; None without a quota.

    ``docker run --cpus=2`` sets a quota of two CPUs' time, not an
    affinity: the process still sees every CPU of the host.
    """
    try:
        with open(f"{CGROUP_DIR}/cpu.max", encoding="ascii") as limit_file:
            quota, _, period = limit_file.read().strip().partition(" ")
        if quota == "max":
            return None
        return max(1, math.ceil(int(quota) / int(period or "100000")))
    except OSError, ValueError, ZeroDivisionError:
        return None


def default_worker_count() -> int:
    """The workers a pool gets without a better measure.

    Every CPU the process may use: ``process_cpu_count`` honors the CPU
    affinity (``cpu_count`` would start one worker per CPU of the host), and
    a container's CPU quota limits it further (see ``_cgroup_cpu_limit``).
    The ``--jobs`` limit, when that is lower.
    """
    workers = os.process_cpu_count() or 4
    quota = _cgroup_cpu_limit()
    if quota is not None:
        workers = min(workers, quota)
    if _worker_limit is not None:
        workers = min(workers, _worker_limit)
    return workers


def init_worker(
    log_level: int,
    airport_database: bytes | None = None,
    runway_database: bytes | None = None,
    database_fingerprint: str | None = None,
) -> None:
    """Configure a worker process (log level, airport and runway databases).

    ``log_level`` is the parent's (``logger.getEffectiveLevel()``).

    ``airport_database`` and ``runway_database`` are the parent's, pickled
    once by the parent: handing the pool the dictionaries themselves would
    pickle them again for every worker, in the parent, one after the other.
    Each worker read the runway CSV again otherwise, and might have read
    one that changed after the parent computed the cache keys.
    ``database_fingerprint`` is the parent's fingerprint of the two (see
    ``airport_lookup.AirportDatabases.fingerprint``), which the worker's
    cache keys take: a hash of the files on disk would describe the
    databases of a download that replaced them after the parent read them.
    It only counts with both databases, which it describes.

    Any failure here would terminate the worker and break the whole pool,
    so nothing may escape: without a database the worker loads it itself.
    """
    set_log_level(log_level)
    received = 0
    if airport_database is not None:
        with contextlib.suppress(Exception):
            database = pickle.loads(airport_database)  # noqa: S301
            use_airport_database(database)
            received += 1
    if runway_database is not None:
        with contextlib.suppress(Exception):
            runways = pickle.loads(runway_database)  # noqa: S301
            use_runway_database(runways)
            received += 1
    if database_fingerprint is not None and received == 2:
        use_database_fingerprint(database_fingerprint)


# What starting a process pool raises where it cannot start one: a sandbox
# without POSIX semaphores, or a system out of processes or memory
_CANNOT_START = (OSError, NotImplementedError, ImportError)


class WorkerPool(Executor):
    """A process pool that does the work in this process where it cannot.

    A pool that cannot start (see ``_CANNOT_START``), now or at the first
    task, runs every task here instead, one after the other, with a warning
    that names ``what`` it was for. A pool that broke on the way (a worker
    killed for its memory) is given up the same way by ``fall_back``, which
    the caller decides on, since it knows what the tasks still pending are;
    ``result`` does it for one task. Here, the tasks take far less memory
    than the workers took at once, which may still not be enough: a parent
    killed for its memory takes the run with it, where the pool's failure
    alone would have failed it as well.

    The workers are set up by ``init_worker`` with ``initargs``.
    """

    def __init__(self, max_workers: int, what: str, initargs: tuple[Any, ...] = ()):
        """Start the pool of ``max_workers`` workers, or fall back already."""
        self._what = what
        self._pool: ProcessPoolExecutor | None = None
        self._given_up = False
        try:
            self._pool = ProcessPoolExecutor(
                max_workers=max_workers, initializer=init_worker, initargs=initargs
            )
        except _CANNOT_START as e:
            self.fall_back(e)

    def fall_back(self, error: BaseException) -> None:
        """Give the pool up for this process, with a warning the first time."""
        if self._given_up:
            return
        self._given_up = True
        logger.warning(
            "The worker processes for %s failed (%s); going on in this process",
            self._what,
            str(error) or type(error).__name__,
        )
        pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=True, cancel_futures=True)

    def submit[R](
        self, fn: Callable[..., R], /, *args: Any, **kwargs: Any
    ) -> Future[R]:
        """Hand a task to a worker, or run it here once the pool is given up."""
        if self._pool is not None:
            try:
                return self._pool.submit(fn, *args, **kwargs)
            except (*_CANNOT_START, BrokenProcessPool) as e:
                self.fall_back(e)
        future: Future[R] = Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except Exception as e:  # noqa: BLE001 - handed to the caller, as a worker's
            future.set_exception(e)
        return future

    def map[R](
        self,
        fn: Callable[..., R],
        *iterables: Iterable[Any],
        timeout: float | None = None,
        chunksize: int = 1,
        buffersize: int | None = None,
    ) -> Iterator[R]:
        """``Executor.map``, in chunks to the workers, or here.

        A pool that breaks on the way raises BrokenProcessPool from the
        iterator, for the caller to decide on (see ``fall_back``).
        """
        if self._pool is not None:
            try:
                return self._pool.map(
                    fn,
                    *iterables,
                    timeout=timeout,
                    chunksize=chunksize,
                    buffersize=buffersize,
                )
            except (*_CANNOT_START, BrokenProcessPool) as e:
                self.fall_back(e)
        return map(fn, *iterables, strict=False)

    def result[R](self, future: Future[R], fn: Callable[..., R], *args: Any) -> R:
        """The result of ``future``, the task ``fn(*args)``.

        Where its worker died with the pool (BrokenProcessPool), the pool
        is given up and the task done again here; any other error of the
        task is raised, as ``future.result`` raises it.
        """
        try:
            return future.result()
        except BrokenProcessPool as e:
            self.fall_back(e)
            return self.submit(fn, *args).result()

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        """Shut the pool down; nothing to do once it was given up."""
        if self._pool is not None:
            self._pool.shutdown(wait=wait, cancel_futures=cancel_futures)


CGROUP_DIR = "/sys/fs/cgroup"


def _host_available_bytes() -> int | None:
    try:
        with open("/proc/meminfo", encoding="ascii") as meminfo:
            for line in meminfo:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
    except OSError, ValueError, IndexError:
        pass
    try:
        return os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_AVPHYS_PAGES")
    except AttributeError, ValueError, OSError:
        return None


def _cgroup_available_bytes() -> int | None:
    """What the cgroup v2 memory limit leaves, None without a limit.

    memory.current includes the page cache, which the kernel reclaims before
    it kills a process; the inactive part of it counts as available.
    """
    try:
        with open(f"{CGROUP_DIR}/memory.max", encoding="ascii") as limit_file:
            raw_limit = limit_file.read().strip()
        if raw_limit == "max":
            return None
        limit = int(raw_limit)
        with open(f"{CGROUP_DIR}/memory.current", encoding="ascii") as usage_file:
            usage = int(usage_file.read().strip())
    except OSError, ValueError:
        return None
    reclaimable = 0
    try:
        with open(f"{CGROUP_DIR}/memory.stat", encoding="ascii") as stat_file:
            for line in stat_file:
                name, _, value = line.partition(" ")
                if name == "inactive_file":
                    reclaimable = int(value)
                    break
    except OSError, ValueError:
        pass
    return max(0, limit - usage + reclaimable)


def _available_memory_bytes() -> int | None:
    """Memory available to new processes, or None when it cannot be told.

    /proc/meminfo shows the memory of the host (or VM), not the limit a
    container runs under, so the smaller of the two counts.
    """
    known = [
        value
        for value in (_host_available_bytes(), _cgroup_available_bytes())
        if value is not None
    ]
    return min(known) if known else None


def parse_worker_count(kml_files: Sequence[str]) -> int:
    """The number of parse workers: one per CPU, as far as memory allows.

    Parsing takes about 15 times the size of the KML in memory, and every
    worker may be parsing one of the largest files at the same time. The
    size is the one ``parse_size`` gives, that of the document inside a KMZ
    rather than of the archive, which is ten to twenty times smaller. The
    pool gets as many workers as the largest files fit into the available
    memory, at least one; an unknown amount of memory does not limit it.
    """
    workers = max(1, min(len(kml_files), default_worker_count()))
    available = _available_memory_bytes()
    if available is None:
        return workers

    largest = sorted((parse_size(path) for path in kml_files), reverse=True)
    needed = 0
    for count, size in enumerate(largest[:workers]):
        needed += WORKER_BASE_BYTES + size * PARSE_BYTES_PER_FILE_BYTE
        if needed > available:
            return max(1, count)
    return workers
