"""Cache directory management and atomic file writes for flown."""

import atexit
import contextlib
import hashlib
import json
import os
import shutil
import stat
import tempfile
import time
from compression import zstd
from pathlib import Path
from typing import IO, TYPE_CHECKING, Any

from .constants import CACHE_DIR_ENV
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Callable, Sequence

__all__ = [
    "CACHE_DIR",
    "ENTRY_MAX_AGE_DAYS",
    "PRIVATE_FILE_MODE",
    "REGULAR_FILE_MODE",
    "atomic_bytes_write",
    "atomic_data_write",
    "atomic_text_write",
    "atomic_write",
    "decode_entry",
    "encode_entry",
    "load_bytes",
    "load_entry",
    "prune_entries",
    "source_fingerprint",
    "store_bytes",
    "store_entry",
]


def _is_private_directory(path: Path, uid: int) -> bool:
    """Create ``path`` for this user alone, or check one that is there.

    Fine only as a directory of its own (no symlink) that ``uid`` owns and
    nobody else may write to: the temp directory is shared with every user
    of the machine, and one who created the cache directory first could put
    a parse result, an airport database or a preview image of their own
    into every site built from it. Nor may anybody else read it: the parse
    cache holds the raw flights, real dates and times among them, so one
    of this user's that others may read or enter (0755, as a umask of 022
    or an older version left it) is made this user's alone first.
    """
    try:
        path.mkdir(mode=0o700, exist_ok=True)
        status = path.lstat()
    except OSError:
        return False
    if (
        not stat.S_ISDIR(status.st_mode)
        or status.st_uid != uid
        or status.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
    ):
        return False
    if stat.S_IMODE(status.st_mode) & 0o077:
        try:
            path.chmod(0o700)
        except OSError:
            return False
    return True


def private_directory(path: Path) -> bool:
    """Create ``path`` for this user alone, or make one of this user's so.

    For a directory of the raw flights, the parse cache: created with mode
    0700 (as is the directory above it, when that is missing too), and one
    of this user's that others may read, enter or write to (0755, as a
    umask of 022 or an older version left it) is made 0700. One that is no
    directory of this user's own (a symlink, another user's) is not used:
    whoever owns it could read the flights or put parse results of their
    own into it.
    """
    try:
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.mkdir(mode=0o700, exist_ok=True)
        status = path.lstat()
    except OSError:
        return False
    getuid = getattr(os, "getuid", None)
    if not stat.S_ISDIR(status.st_mode) or (
        getuid is not None and status.st_uid != getuid()
    ):
        return False
    if stat.S_IMODE(status.st_mode) & 0o077:
        try:
            path.chmod(0o700)
        except OSError:
            return False
    return True


def _default_cache_dir() -> Path:
    """~/.cache/flown, or one in the temp directory when there is no home.

    The temp directory is shared with every other user, so the one there
    carries the user id in its name and is only used when it belongs to this
    user and nobody else can write to it (nor read it, once it is checked).
    Otherwise the run gets a fresh one of its own, which it passes on to its
    workers through the environment and removes as it exits; nothing is
    cached across runs then.
    """
    try:
        return Path.home() / ".cache" / "flown"
    except RuntimeError:  # no HOME and no passwd entry (containers)
        pass
    getuid = getattr(os, "getuid", None)
    if getuid is None:  # pragma: no cover - Windows has a temp dir per user
        return Path(tempfile.gettempdir()) / "flown-cache"
    uid = getuid()
    shared = Path(tempfile.gettempdir()) / f"flown-cache-{uid}"
    if _is_private_directory(shared, uid):
        return shared
    private = Path(tempfile.mkdtemp(prefix="flown-cache-"))
    # Gone with the run, which nothing after it uses, rather than a copy of
    # the raw flights left in the temp directory for every run. Its workers
    # leave without running this, and find it through the environment.
    atexit.register(shutil.rmtree, private, ignore_errors=True)
    logger.warning(
        "Not using the cache directory %s: it is not a directory of this user "
        "alone; caching in %s for this run",
        shared,
        private,
    )
    os.environ[CACHE_DIR_ENV] = str(private)
    return private


_cache_dir_env = os.environ.get(CACHE_DIR_ENV)
CACHE_DIR = Path(_cache_dir_env) if _cache_dir_env else _default_cache_dir()

# The longest file name, in bytes, that most file systems take
_NAME_MAX = 255
# What NamedTemporaryFile puts after the prefix: eight random characters, and
# the suffix _replace_through_temp gives it
_TEMP_RANDOM_LENGTH = 8
_TEMP_SUFFIX = ".tmp"


def _temp_prefix(name: str) -> str:
    """The prefix of the temp file that replaces the file ``name``.

    ``.<name>.``, so a leftover is hidden and says which file it was for, and
    the name of the temp file as a whole still fits the file system: a file
    name of 242 bytes or more would not, with the random part and the suffix
    after it. The extension is kept and the part before it shortened (by
    whole characters), so a leftover still matches the patterns that look
    for one (``obfuscate.TEMP_FILE_PATTERN``, ``data/**/.*.tmp`` in
    .gitignore).
    """
    room = _NAME_MAX - len("..") - _TEMP_RANDOM_LENGTH - len(_TEMP_SUFFIX)
    stem, extension = os.path.splitext(name)
    while stem and len(os.fsencode(stem + extension)) > room:
        stem = stem[:-1]
    shortened = stem + extension
    while len(os.fsencode(shortened)) > room:
        shortened = shortened[:-1]
    return f".{shortened}."


def _regular_file_mode() -> int:
    """The mode a plain ``open(path, "w")`` would give a new file.

    Reading the umask means setting it, which briefly changes the mode of
    every file another thread creates in the meantime. It is therefore read
    once at import, before any pool or thread exists.
    """
    umask = os.umask(0)
    os.umask(umask)
    return 0o666 & ~umask


REGULAR_FILE_MODE = _regular_file_mode()
# The mode of a file of the raw flights, which nobody else may read
PRIVATE_FILE_MODE = 0o600


def _fsync_directory(directory: Path) -> None:
    """Flush a directory entry to disk (best effort, not every FS supports it)."""
    try:
        fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _replace_through_temp(
    path: Path,
    write: Callable[[IO[Any]], object],
    *,
    binary: bool,
    newline: str | None = None,
    durable: bool = False,
    keep_mode: bool = False,
    mode: int | None = None,
) -> None:
    """Write ``path`` through a temp file in the same directory, see atomic_write."""
    tmp_path: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb" if binary else "w",
            dir=path.parent,
            prefix=_temp_prefix(path.name),
            suffix=_TEMP_SUFFIX,
            delete=False,
            encoding=None if binary else "utf-8",
            newline=newline,
        ) as tmp:
            tmp_path = tmp.name
            write(tmp)
            if durable:
                tmp.flush()
                os.fsync(tmp.fileno())
        if keep_mode:
            shutil.copymode(path, tmp_path)
        else:
            os.chmod(tmp_path, REGULAR_FILE_MODE if mode is None else mode)
        os.replace(tmp_path, path)
        tmp_path = None
    finally:
        if tmp_path is not None:
            with contextlib.suppress(OSError):
                os.unlink(tmp_path)
    if durable:
        _fsync_directory(path.parent)


def atomic_write(
    path: Path,
    write: Callable[[IO[str]], object],
    *,
    newline: str | None = None,
    durable: bool = False,
    keep_mode: bool = False,
) -> None:
    """Write a text file atomically through a temp file in the same directory.

    ``write`` receives the open temp file. The temp file is created with mode
    0600, which is what NamedTemporaryFile does; the finished file gets the
    mode a regular write would have produced, so a generated site stays
    readable for a web server running as another user. The temp file is
    removed when anything fails.

    ``newline`` is passed to ``open`` (``""`` writes line endings as they
    are). ``durable`` flushes the data to disk before the rename and the
    directory entry after it, for a file that is the only copy of something:
    a crash in between leaves either the old file or the complete new one.
    ``keep_mode`` gives the new file the mode of the one it replaces, which
    has to exist.
    """
    _replace_through_temp(
        path,
        write,
        binary=False,
        newline=newline,
        durable=durable,
        keep_mode=keep_mode,
    )


def atomic_bytes_write(path: Path, data: bytes, *, mode: int | None = None) -> None:
    """Write ``data`` to ``path`` atomically, like ``atomic_write`` does text.

    ``mode`` is the mode of the finished file, the regular one by default.
    """
    _replace_through_temp(path, lambda tmp: tmp.write(data), binary=True, mode=mode)


def atomic_text_write(path: Path, content: str) -> None:
    """Write ``content`` to ``path`` atomically."""
    atomic_write(path, lambda tmp: tmp.write(content))


def atomic_data_write(path: Path, data: Any, *, sort_keys: bool = False) -> None:
    """Write a data file of the site as compact JSON atomically."""
    # One dumps call uses the C encoder; dump streams through the much
    # slower pure-Python one
    content = json.dumps(data, separators=(",", ":"), sort_keys=sort_keys)
    atomic_write(path, lambda tmp: tmp.write(content))


# How hard an entry is compressed: level 3 is zstd's default, most of the
# saving at a fraction of the time of the higher ones
_ZSTD_LEVEL = 3
# The entries of a directory of ``store_entry`` not read or written for this
# long are removed
ENTRY_MAX_AGE_DAYS = 30


def source_fingerprint(package: Path, modules: Sequence[str]) -> str:
    """A short token that changes whenever the code of ``modules`` does.

    The modules of ``package`` whose code decides what a cache entry holds,
    for its key: an entry computed before a change is never read after it.
    """
    digest = hashlib.sha256()
    for module in modules:
        digest.update(module.encode())
        try:
            digest.update((package / f"{module}.py").read_bytes())
        except OSError:
            # No sources (a bytecode-only install): the format version
            # still invalidates entries on structural changes
            continue
    return digest.hexdigest()[:8]


def encode_entry(data: Any) -> bytes:
    """An entry as it is stored: compact JSON, compressed."""
    content = json.dumps(data, separators=(",", ":")).encode()
    return zstd.compress(content, level=_ZSTD_LEVEL)


def decode_entry(data: bytes) -> Any:
    """The data of a stored entry (see ``encode_entry``)."""
    return json.loads(zstd.decompress(data))


def load_bytes(path: Path) -> bytes | None:
    """The bytes ``store_bytes`` kept at ``path``, None when there are none.

    Only from a directory of this user's alone (see ``private_directory``):
    whoever else could write to it could put what a build publishes into
    it. An entry that is read is touched, which keeps it from being pruned
    (see ``prune_entries``).
    """
    if not private_directory(path.parent):
        return None
    try:
        data = path.read_bytes()
    except OSError as e:
        if not isinstance(e, FileNotFoundError):
            logger.debug("Cache entry %s is unreadable: %s", path, e)
        return None
    with contextlib.suppress(OSError):
        os.utime(path)
    return data


def store_bytes(path: Path, data: bytes, *, prune: bool = True) -> None:
    """Keep ``data`` at ``path`` for ``load_bytes``.

    In a directory of this user's alone (see ``private_directory``), with
    mode 0600, written atomically: a run that reads it meanwhile finds the
    old entry or the new one whole. With ``prune`` the directory is pruned
    then (see ``prune_entries``); a caller that stores many entries at once
    prunes once after them. A failure to write costs the next run the time
    to compute it again, nothing else.
    """
    directory = path.parent
    if not private_directory(directory):
        return
    try:
        atomic_bytes_write(path, data, mode=PRIVATE_FILE_MODE)
    except OSError as e:
        logger.debug("Failed to write cache entry %s: %s", path, e)
        return
    if prune:
        prune_entries(directory, keep=path)


def prune_entries(directory: Path, keep: Path | None = None) -> None:
    """Remove the entries of ``directory`` unused for ``ENTRY_MAX_AGE_DAYS``.

    And the temp files an interrupted write left: what the directory holds
    is what the runs of the last month used. ``keep`` stays whatever its age.
    """
    oldest = time.time() - ENTRY_MAX_AGE_DAYS * 24 * 3600
    with contextlib.suppress(OSError):
        for entry in directory.iterdir():
            with contextlib.suppress(OSError):
                if entry != keep and entry.lstat().st_mtime < oldest:
                    entry.unlink()


def load_entry(path: Path) -> Any:
    """The data ``store_entry`` kept at ``path``, None when there is none.

    Read with ``load_bytes``; an entry that cannot be decoded counts as none.
    """
    data = load_bytes(path)
    if data is None:
        return None
    try:
        return decode_entry(data)
    except (zstd.ZstdError, ValueError) as e:
        logger.debug("Cache entry %s is unreadable: %s", path, e)
        return None


def store_entry(path: Path, data: Any) -> None:
    """Keep ``data`` at ``path`` for ``load_entry``, as compact JSON compressed.

    Written with ``store_bytes``, which prunes the directory: the entries
    not used for ``ENTRY_MAX_AGE_DAYS`` go then, and so do the temp files
    an interrupted write left.
    """
    store_bytes(path, encode_entry(data))
