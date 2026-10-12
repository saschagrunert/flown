"""Publishing a site all at once.

``SiteOutput`` has every file written into staging directories and moves them
into place only once all of them were written, so a run that fails while
writing leaves the previous site as it was. One run at a time writes to an
output directory.
"""

import contextlib
import errno
import filecmp
import hashlib
import os
import re
import shutil
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Self

from .exceptions import FlownError, OutputRefusedError
from .logger import logger
from .validation import is_protected_directory

try:
    import fcntl
except ImportError:  # pragma: no cover - Windows has no fcntl
    # Without file locks two runs on one output directory are not detected;
    # the export itself works
    fcntl = None  # type: ignore[assignment]

if TYPE_CHECKING:
    from collections.abc import Iterable

__all__ = [
    "STABLE_MTIMES_ENV",
    "STAGING_PREFIX",
    "YEAR_FILE",
    "SiteOutput",
    "content_mtime",
    "day_mtime",
    "day_start",
]

YEAR_DIR_PATTERN = re.compile(r"^\d{4}$")
YEAR_FILE = "data.json"
TOOL_OWNED_FILES = ("airports.json", "metadata.json")
# Hidden directories a run writes its files into before publishing them
STAGING_PREFIX = ".flown-staging-"
# Published last: they reference the other files, so a page loaded while the
# files are moved never points at one that is not in place yet
ENTRY_POINT_FILES = ("metadata.json", "index.html")
# Set to "1", every published file gets a modification time derived from
# its content (see content_mtime)
STABLE_MTIMES_ENV = "FLOWN_STABLE_MTIMES"
# The content-derived modification times lie this many seconds after
# 2001-09-09 at most: in the past, where no tool warns about them
_CONTENT_MTIME_EPOCH = 1_000_000_000
_CONTENT_MTIME_RANGE = 1 << 28


def _refuse_symlink(path: Path) -> OutputRefusedError:
    return OutputRefusedError(
        f"Refusing to write through the symlink {path}; "
        "remove it or choose a different output directory"
    )


def _check_target(root: Path, relative: Path) -> None:
    """Refuse a destination that a staged file cannot safely be moved to.

    Symlinks are neither written through nor replaced, and nothing but a
    regular file (or a directory on the way to one) is replaced. The
    permission to create the file is checked as well, so that a read-only
    directory stops the run before the first file was moved.
    """
    directory = root
    for part in relative.parts[:-1]:
        child = directory / part
        if child.is_symlink():
            raise _refuse_symlink(child)
        if not child.exists():
            break
        if not child.is_dir():
            raise OutputRefusedError(f"Refusing to write into {child}: not a directory")
        directory = child
    else:
        target = root / relative
        if target.is_symlink():
            raise _refuse_symlink(target)
        if target.exists() and not target.is_file():
            raise OutputRefusedError(
                f"Refusing to replace {target}: not a regular file"
            )
    if not os.access(directory, os.W_OK | os.X_OK):
        raise PermissionError(errno.EACCES, os.strerror(errno.EACCES), str(directory))


def content_mtime(path: Path) -> int:
    """A modification time for a file that only its content decides.

    GitHub Pages derives the ETag of a file from its modification time and
    size, and a site built afresh on every deploy gives every file the time
    of the build: every deploy made every browser download every file again,
    changed or not. A time taken from a hash of the content keeps the ETag
    of a file that did not change. It is no real time, only a label, and
    only for a server that compares it for equality (nginx, GitHub Pages)
    and sends a Cache-Control of its own: ``python -m http.server`` answers
    304 to an older time and sends none, so browsers would cache a file of
    2005 for years. Hence only on request, see ``STABLE_MTIMES_ENV``.
    """
    digest = hashlib.blake2b(digest_size=8)
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            digest.update(chunk)
    offset = int.from_bytes(digest.digest(), "big") % _CONTENT_MTIME_RANGE
    return _CONTENT_MTIME_EPOCH + offset


# How many seconds after midnight a time a build dated a file to may be: a
# file a build changes again on the same day gets a second more each time.
# Beyond, the time is taken for one of a build before files were dated to
# the day, or of another tool, which can hold the time of day of a build.
# A file changed by more than 600 builds on one UTC day would fall back to
# midnight, and http.server could answer 304 for it; no site is built that
# often.
_DAY_MTIME_STEPS = 600


def _is_day_mtime(mtime: int) -> bool:
    """Whether a modification time is one ``day_mtime`` gives."""
    return mtime % 86400 < _DAY_MTIME_STEPS


def day_mtime(staged: Path, target: Path, day_start: int, keep: bool = True) -> int:
    """The modification time a published file gets without content times.

    Not the time of the build, which a server sends as Last-Modified and
    which would give away the time of day of a build right after a flight:
    00:00 UTC of the build day (``day_start``), the day ``map_config.js``
    shows as well. A file whose content did not change keeps the time it
    has, and so its ETag; one that changed on the day it was last published
    gets one second more than before, so that a server comparing times
    (``python -m http.server`` answers 304 to a time no newer than the
    browser's) never hands out the old file for it. A time that is no such
    day, as an older build or another tool left it, is replaced however
    the file changed: it may hold the time of day of a build.

    ``keep`` false is for a file the flights decide (a year file, the page
    of a flight, a flag): one dated to an earlier day gets the build day
    even when it did not change, or it would keep the day of the build that
    first published it, the day after its flight, for as long as the site
    exists.
    """
    try:
        previous = int(target.stat().st_mtime)
    except OSError:
        return day_start
    if not _is_day_mtime(previous) or (not keep and previous < day_start):
        return day_start
    if target.stat().st_size == staged.stat().st_size and filecmp.cmp(
        staged, target, shallow=False
    ):
        return previous
    return max(day_start, previous + 1)


def day_start(when: datetime | None = None) -> int:
    """The Unix time of 00:00 UTC on the day of ``when`` (now by default)."""
    moment = when or datetime.now(UTC)
    return int(
        moment.astimezone(UTC)
        .replace(hour=0, minute=0, second=0, microsecond=0)
        .timestamp()
    )


def _staged_files(stage: Path) -> list[Path]:
    """The files of a staging directory, relative to it, in publishing order.

    Files in subdirectories (the year files) come first and the entry points
    last, see ``ENTRY_POINT_FILES``.
    """
    files = [path.relative_to(stage) for path in stage.rglob("*") if path.is_file()]
    return sorted(
        files,
        key=lambda relative: (
            len(relative.parts) == 1,
            relative.name in ENTRY_POINT_FILES,
            relative.as_posix(),
        ),
    )


def _remove_stale_file(path: Path) -> None:
    """Remove a tool-owned file that the published run did not produce.

    The new site is already in place at this point, so a file that cannot be
    removed only gets a warning; a symlink is somebody else's and left alone.
    """
    if path.is_symlink():
        logger.warning("Leaving symlink in output directory: %s", path)
    elif path.is_file():
        try:
            path.unlink()
        except OSError as e:
            logger.warning("Could not remove stale output %s: %s", path, e)


def _remove_stale_data(data_dir: Path, years: set[str]) -> None:
    """Remove year files that are not part of the site any more.

    Anything the tool does not own is left in place with a warning.
    """
    for child in sorted(data_dir.iterdir()):
        if child.name in TOOL_OWNED_FILES or child.name.startswith(STAGING_PREFIX):
            continue
        if (
            child.is_dir()
            and not child.is_symlink()
            and YEAR_DIR_PATTERN.match(child.name)
        ):
            if child.name not in years:
                _remove_stale_file(child / YEAR_FILE)
                try:
                    child.rmdir()
                except OSError:
                    logger.warning("Leaving non-empty year directory: %s", child)
            continue
        logger.warning("Leaving unexpected item in output directory: %s", child)


def _directories_on_the_way(root: Path, parts: tuple[str, ...]) -> list[Path]:
    """``root / parts[0]``, ``root / parts[0] / parts[1]`` and so on."""
    return [root.joinpath(*parts[:depth]) for depth in range(1, len(parts) + 1)]


def _lock_directory(directory: Path) -> int:
    """Take the lock of an output directory, or fail when a run holds it.

    Two runs writing one site would delete each other's staging directories.
    The lock is on the directory itself, so no lock file ends up published
    with the site. It is released when the returned descriptor is closed.
    """
    fd = os.open(directory, os.O_RDONLY)
    if fcntl is None:
        return fd
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise FlownError(
            f"Another run is writing to {directory}; wait for it to finish"
        ) from None
    except OSError:
        # A file system without locks: run unguarded, as before
        pass
    return fd


def _remove_leftover_stages(directory: Path) -> None:
    """Remove the staging directories of runs that were killed.

    Only called with the directory's lock held, so no stage of a running
    run is among them.
    """
    for child in directory.iterdir():
        if (
            child.name.startswith(STAGING_PREFIX)
            and child.is_dir()
            and not child.is_symlink()
        ):
            shutil.rmtree(child, ignore_errors=True)


class SiteOutput:
    """Write a site into staging directories and publish it all at once.

    Every file is written into a hidden staging directory inside its
    destination, which keeps the final renames on one filesystem, and moved
    into place only once all files were written. A failed run leaves the
    previous site untouched instead of deleting it or mixing two versions.
    Files the tool does not own are never touched.

    Use it as a context manager: write the data files into ``data_stage`` and
    the page and its assets into ``site_stage``, then call ``publish``. The
    staging directories are removed on exit, published or not.
    """

    site_stage: Path
    data_stage: Path

    def __init__(
        self,
        output_dir: str | Path,
        data_dir: str | Path,
        site_files: Iterable[str] = (),
        site_patterns: Iterable[str] = (),
        stable_mtimes: bool = False,
        build_day: int | None = None,
        code_files: Iterable[str] = (),
    ) -> None:
        """Prepare the output of a site.

        ``site_files`` are the paths the tool owns in ``output_dir``, each
        relative to it and with forward slashes; the ones a run does not
        produce are removed when it is published. ``site_patterns`` are glob
        patterns of owned files whose names are not known in advance, such
        as the flag of each country visited: every match that a run does
        not produce is removed as well, or a flight removed from the input
        would still give away its country. ``stable_mtimes`` gives every
        published file a modification time derived from its content (see
        ``content_mtime``); without it a file is dated to the build day,
        ``build_day`` (the Unix time of its midnight in UTC, today's by
        default), see ``day_mtime``. Only ``code_files``, paths in
        ``output_dir`` as ``site_files`` names them that no flight decides
        (bundles, stylesheets, icons), keep an earlier day when they did not
        change; every other file gets the build day.
        """
        self.output_dir = Path(output_dir).resolve()
        self.data_dir = Path(data_dir).resolve()
        for given, resolved in (
            (output_dir, self.output_dir),
            (data_dir, self.data_dir),
        ):
            if is_protected_directory(resolved):
                raise OutputRefusedError(
                    f"Refusing to use dangerous output directory: {given}"
                )
        self.site_files = tuple(site_files)
        self.site_patterns = tuple(site_patterns)
        self.stable_mtimes = stable_mtimes
        self.build_day = build_day
        self.code_files = frozenset(code_files)
        self._cleanup = contextlib.ExitStack()

    def __enter__(self) -> Self:
        try:
            for destination in dict.fromkeys((self.output_dir, self.data_dir)):
                destination.mkdir(parents=True, exist_ok=True)
                self._cleanup.callback(os.close, _lock_directory(destination))
                _remove_leftover_stages(destination)
            self.site_stage = self._stage(self.output_dir)
            self.data_stage = self._stage(self.data_dir)
        except BaseException:
            self._cleanup.close()
            raise
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._cleanup.close()

    def _stage(self, destination: Path) -> Path:
        stage = Path(tempfile.mkdtemp(prefix=STAGING_PREFIX, dir=destination))
        self._cleanup.callback(shutil.rmtree, stage, ignore_errors=True)
        return stage

    def publish(self, years: Iterable[int]) -> None:
        """Move the staged files into place, then remove stale outputs.

        Every destination is checked before the first file moves, so that a
        refusal leaves the previous site as it was. The data files move
        first and the page last. ``years`` are the years of the new site.
        """
        for stage, required in (
            (self.site_stage, "index.html"),
            (self.data_stage, "metadata.json"),
        ):
            # A stage that lost its page or metadata is a bug or a stage
            # removed from under the run; publishing it would break the site
            if not (stage / required).is_file():
                raise FlownError(f"Staged site is incomplete: {required} missing")
        site_files = _staged_files(self.site_stage)
        moves = [
            (self.data_stage, self.data_dir, relative)
            for relative in _staged_files(self.data_stage)
        ] + [(self.site_stage, self.output_dir, relative) for relative in site_files]

        for _, destination, relative in moves:
            _check_target(destination, relative)
        midnight = self.build_day if self.build_day is not None else day_start()
        for stage, destination, relative in moves:
            mtime = (
                content_mtime(stage / relative)
                if self.stable_mtimes
                else day_mtime(
                    stage / relative,
                    destination / relative,
                    midnight,
                    keep=stage == self.site_stage
                    and relative.as_posix() in self.code_files,
                )
            )
            os.utime(stage / relative, (mtime, mtime))
        for stage, destination, relative in moves:
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(stage / relative, target)

        # Compared as relative paths, not base names: the vendored files sit
        # in a subdirectory, and two of them could share a name
        produced = {relative.as_posix() for relative in site_files}
        for name in self.site_files:
            if name not in produced:
                _remove_stale_file(self.output_dir / name)
        for pattern in self.site_patterns:
            self._remove_stale_matches(pattern, produced)
        _remove_stale_data(self.data_dir, {str(year) for year in years})

        # The stages go now rather than on exit: removing them changes the
        # time of the directory they are in once more
        for stage in (self.site_stage, self.data_stage):
            shutil.rmtree(stage, ignore_errors=True)
        directory_mtime = _CONTENT_MTIME_EPOCH if self.stable_mtimes else midnight
        for directory in self._touched_directories(moves):
            with contextlib.suppress(OSError):
                os.utime(directory, (directory_mtime, directory_mtime))

    def _touched_directories(self, moves: list[tuple[Path, Path, Path]]) -> list[Path]:
        """The directories a publish changed, the deepest first.

        Moving a file in, creating a directory and removing a stale file or a
        stage all set the time of the directory it happens in to the time of
        the build, which a server shows in a directory listing (nginx with
        autoindex) and an archive of the site keeps (the Pages artifact): the
        time of day of a build right after a flight. These are the two
        destinations, every directory on the way to a published file, the
        ones between the output and the data directory, those of the
        ``site_files`` and ``site_patterns``, where stale files are removed,
        and every year directory of the data directory: one no longer built
        that a stray file keeps loses its data file, and kept the time of
        day of that. A directory the run did not write in keeps its time,
        which says nothing about the build, and so does anything in the data
        directory that is not the tool's (see _remove_stale_data).
        """
        directories = {self.output_dir, self.data_dir}
        if self.data_dir.is_relative_to(self.output_dir):
            directories.update(
                _directories_on_the_way(
                    self.output_dir, self.data_dir.relative_to(self.output_dir).parts
                )
            )
        for _, destination, relative in moves:
            directories.update(
                _directories_on_the_way(destination, relative.parts[:-1])
            )
        # Where a stale file was removed; a symlink on the way is somebody
        # else's, and so is everything behind it
        for name in (*self.site_files, *self.site_patterns):
            for directory in _directories_on_the_way(
                self.output_dir, Path(name).parent.parts
            ):
                if directory.is_symlink() or not directory.is_dir():
                    break
                directories.add(directory)
        directories.update(
            child
            for child in self.data_dir.iterdir()
            if YEAR_DIR_PATTERN.match(child.name)
            and child.is_dir()
            and not child.is_symlink()
        )
        return sorted(
            (directory for directory in directories if directory.is_dir()),
            key=lambda directory: (-len(directory.parts), str(directory)),
        )

    def _remove_stale_matches(self, pattern: str, produced: set[str]) -> None:
        """Remove the files matching ``pattern`` that were not produced.

        A directory on the way that is a symlink is somebody else's and not
        searched; one that ends up empty is removed.
        """
        directory = self.output_dir
        for part in Path(pattern).parent.parts:
            directory = directory / part
            if directory.is_symlink() or not directory.is_dir():
                return
        for match in sorted(directory.glob(Path(pattern).name)):
            if match.relative_to(self.output_dir).as_posix() not in produced:
                _remove_stale_file(match)
        if directory != self.output_dir:
            with contextlib.suppress(OSError):
                directory.rmdir()
