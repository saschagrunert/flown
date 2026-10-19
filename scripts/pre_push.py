#!/usr/bin/env python3
"""Git pre-push hook: refuse to push KML files that carry real dates.

The repository is public, so the obfuscation check of CI only notices a real
date once it has been published. This hook runs the same check before the
push, on every KML file that the commits about to be pushed add or change,
including commits whose files a later commit fixes again: the history is
published, not just its tip. Commits the remote already has are skipped:
those of its remote-tracking branches, and those of the refs being pushed to
where they are in the clone. Not those of another remote, a fork or a mirror
whose commits the public remote may never have had: a private remote may hold
the raw flights. A push to a URL or to a remote never fetched from has no
remote-tracking branches of its own, so only the refs being pushed to count,
and a first push to a new remote checks the whole history. When that history
is already public elsewhere and clean, `git push --no-verify` skips it.

The lint job of CI runs the same check over the commits a push or a pull
request adds (``--range BASE HEAD``, see ``check_range``): a push made with
`--no-verify`, or a file uploaded on GitHub, fails there, if only once it is
public.

Install it once per clone with `make hooks`. It needs nothing but the
Python the project requires, and it fails closed: when it cannot run the
check, the push is refused. `git push --no-verify` skips it.

The messages of the commits that add or change a KML file are published
with it (a copy keeps its flights in a directory of its own, see
doc/hosting.md): one that names a date or a weekday ("Add flight 16 Aug
2026") is refused as well.

So are the names of the refs pushed to: a branch named after the day of
its flights ("flights-2026-08-16") is refused when its commits add or
change one.

A push that adds the flights of one trip gets a warning, not a refusal:
the files carry no date, but the push does, and dates the trip to about the
day it was pushed. One trip is up to three flights (a day's flying), or legs
that each start where the one before ended and come back to the field of
the first only at the end (see ``one_trip``). A flight is a KML file
anywhere but under tests/: in data/, or in the directory a copy keeps its
own in (FLOWN_INPUT_DIR, doc/hosting.md), which the hook cannot know.

The pre-commit hook runs the obfuscation check on the KML files a commit
stages, wherever they are (``--files NAME...``, see ``check_files``), so a
real date is not even committed.
"""

import re
import shutil
import subprocess
import sys
import tempfile
from itertools import pairwise
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Every KML file, wherever it is and however its extension is spelled, and
# every KMZ archive, which the check reports as one it cannot read (the
# generator reads both, see flown.validation.find_kml_files)
KML_PATHSPECS = (":(glob,icase)**/*.kml", ":(glob,icase)**/*.kmz")
# The flights the trip warning reads: every KML file but those of the
# tests. A copy keeps its flights where FLOWN_INPUT_DIR says, which the hook
# cannot know (doc/hosting.md), so not only those of data/
FLIGHT_PATHSPECS = (*KML_PATHSPECS, ":(exclude,glob)tests/**")
# What git sends for a ref that is deleted rather than pushed
ZERO_SHA = "0" * 40
# As many flights as a day of flying has, which a push dates together
TRIP_MAX_FLIGHTS = 3
# Two ends of flights this close (km) are at one field: a leg starts where
# the one before it ended
SAME_FIELD_KM = 3.0
# The first and the last point of a track: a <gx:coord>, or the first and
# the last tuple of a <coordinates>
_GX_COORD = re.compile(r"<(?:[\w.-]+:)?coord>\s*(\S+)\s+(\S+)")
_COORDINATES = re.compile(r"<(?:[\w.-]+:)?coordinates>([^<]*)<")
# Said by a refusal of a push to a remote the clone has no tracking branches
# of, which counts as having only what the refs pushed to point at there
# (see published): its first push checks history that may be public
# elsewhere already. Not "the whole history", which it was not where the
# clone has the commit of such a ref.
SKIP_HINT = (
    "\nThis remote was never fetched from, so every commit was checked that\n"
    "the refs pushed to there do not already have. If it has these commits\n"
    "anyway, `git push --no-verify` skips the check."
)


def _git(repo: Path, *args: str) -> bytes:
    git = shutil.which("git")
    if git is None:
        raise OSError("git is not on PATH")
    return subprocess.run(  # noqa: S603
        [git, *args],
        cwd=repo,
        capture_output=True,
        check=True,
    ).stdout


def _text(output: bytes) -> str:
    """Output of git as text, whatever the encoding of its file names.

    git hands over names and messages as the bytes they are. A name that is
    no UTF-8 keeps its bytes as surrogates, which turn back into the same
    bytes as an argument of the next git command or as a path, rather than
    failing the hook with a UnicodeDecodeError it would not explain.
    """
    return output.decode(errors="surrogateescape")


def _has_commit(repo: Path, sha: str) -> bool:
    """Whether the commit ``sha`` is in the clone."""
    try:
        _git(repo, "cat-file", "-e", f"{sha}^{{commit}}")
    except subprocess.CalledProcessError:
        return False
    return True


def _is_tracked(repo: Path, remote: str) -> bool:
    """Whether the clone has remote-tracking branches of ``remote``."""
    return bool(
        _git(
            repo,
            "for-each-ref",
            "--count=1",
            "--format=%(refname)",
            f"refs/remotes/{remote}/",
        ).strip()
    )


def published(repo: Path, remote: str, lines: list[str], tracked: bool) -> list[str]:
    """The revisions whose commits the remote already has, for rev-list.

    The remote-tracking branches of ``remote`` and the commit each ref being
    pushed to points at on the remote, where the clone has it: a push that
    only updates a branch does not check everything before it again. A push
    to a URL or to a remote not fetched from has no tracking branches, and
    then only those commits count, never the branches of another remote: a
    private one may hold commits with the raw flights that this remote never
    had, and counting them as published would let them through. The hook
    fails closed, so such a push checks everything else. ``tracked`` is
    whether the remote has tracking branches (``_is_tracked``).
    """
    known = []
    for line in lines:
        fields = line.split()
        if len(fields) == 4 and fields[3] != ZERO_SHA and _has_commit(repo, fields[3]):
            known.append(fields[3])
    remotes = [f"--remotes={remote}"] if tracked else []
    revisions = [*remotes, *dict.fromkeys(known)]
    return ["--not", *revisions] if revisions else []


def commits_to_check(
    repo: Path, exclude: list[str], pushed_shas: list[str]
) -> list[str]:
    """The commits being pushed that add or change a KML file, oldest first.

    --full-history keeps a side branch that adds a file and a later merge
    that drops it again; history simplification would skip exactly that.
    """
    if not pushed_shas:
        return []
    output = _git(
        repo,
        "rev-list",
        "--reverse",
        "--full-history",
        *pushed_shas,
        *exclude,
        "--",
        *KML_PATHSPECS,
    )
    return _text(output).split()


def changed_kml_files(repo: Path, commit: str) -> list[str]:
    """The KML files a commit adds or changes (against each parent of a merge)."""
    output = _git(
        repo,
        "diff-tree",
        "-r",
        "-m",
        "--root",
        "-z",
        "--no-commit-id",
        "--name-only",
        "--diff-filter=d",
        commit,
        "--",
        *KML_PATHSPECS,
    )
    names = [name for name in _text(output).split("\0") if name]
    return list(dict.fromkeys(names))


def added_flights(repo: Path, exclude: list[str], pushed_shas: list[str]) -> list[str]:
    """The flight files (FLIGHT_PATHSPECS) that the commits being pushed add."""
    if not pushed_shas:
        return []
    output = _git(
        repo,
        "log",
        "--diff-filter=A",
        "--name-only",
        "--format=",
        "-z",
        *pushed_shas,
        *exclude,
        "--",
        *FLIGHT_PATHSPECS,
    )
    names = (name.strip("\n") for name in _text(output).split("\0"))
    return list(dict.fromkeys(name for name in names if name))


def _where(lon: str, lat: str) -> tuple[float, float] | None:
    try:
        return float(lat), float(lon)
    except ValueError:
        return None


def flight_ends(
    content: str,
) -> tuple[tuple[float, float], tuple[float, float]] | None:
    """Where the track of a flight file starts and ends, as (lat, lon).

    Read from the text, not parsed: the hook needs nothing but the Python
    the project requires. None for a file without a point it can read.
    """
    points: list[tuple[int, tuple[float, float] | None]] = [
        (match.start(), _where(match[1], match[2]))
        for match in _GX_COORD.finditer(content)
    ]
    for match in _COORDINATES.finditer(content):
        tuples = match[1].split()
        if tuples:
            first, last = tuples[0].split(","), tuples[-1].split(",")
            if len(first) >= 2 and len(last) >= 2:
                points.append((match.start(), _where(first[0], first[1])))
                points.append((match.start() + 1, _where(last[0], last[1])))
    if not points:
        return None
    points.sort(key=lambda point: point[0])
    start, end = points[0][1], points[-1][1]
    return None if start is None or end is None else (start, end)


def one_trip(ends: list[tuple[tuple[float, float], tuple[float, float]]]) -> bool:
    """Whether flights, in the order of their files, are the legs of one trip.

    Each starts where the one before it ended, and none but the first
    starts at the field the first started at: a trip away from home, or
    under way, rather than the flights of weeks at home with a trip among
    them, which come back to that field in between.
    """
    from flown.geometry import haversine_distance  # noqa: PLC0415

    def near(first: tuple[float, float], second: tuple[float, float]) -> bool:
        return haversine_distance(*first, *second) <= SAME_FIELD_KM

    home = ends[0][0]
    return all(
        near(before[1], after[0]) and not near(after[0], home)
        for before, after in pairwise(ends)
    )


def _blob(repo: Path, commits: list[str], name: str) -> str | None:
    """The content of ``name`` in the first of ``commits`` that has it."""
    for commit in commits:
        try:
            return _text(_git(repo, "cat-file", "blob", f"{commit}:{name}"))
        except subprocess.CalledProcessError:
            continue
    return None


def trip_of(repo: Path, pushed: list[str], added: list[str]) -> bool:
    """Whether the flights a push adds date one trip (see the module).

    ``pushed`` are the commits pushed, which hold them; ``added`` is in the
    order of their numbers, the order they were flown in.
    """
    if len(added) <= TRIP_MAX_FLIGHTS:
        return True
    ends = []
    for name in added:
        content = _blob(repo, pushed, name)
        found = None if content is None else flight_ends(content)
        if found is None:
            return False
        ends.append(found)
    return one_trip(ends)


def dated_refs(lines: list[str]) -> list[str]:
    """The dates, times of day, weekdays and holidays in the names of the refs."""
    # Imported here: main() puts the checkout on the path first
    from flown.date_tokens import (  # noqa: PLC0415
        find_date_tokens,
        find_holiday_tokens,
        find_partial_date_tokens,
        find_time_tokens,
        find_weekday_tokens,
    )

    found: list[str] = []
    for line in lines:
        fields = line.split()
        if len(fields) != 4 or fields[1] == ZERO_SHA:
            continue
        name = fields[2]
        found.extend(
            f"{name}: {token}"
            for token in find_date_tokens(name, skip_near_jan_first=True)
            + find_partial_date_tokens(name)
            + find_weekday_tokens(name)
            + find_holiday_tokens(name)
            + find_time_tokens(name)
        )
    return list(dict.fromkeys(found))


def touches_flights(repo: Path, exclude: list[str], pushed_shas: list[str]) -> bool:
    """Whether a commit being pushed adds or changes a KML file."""
    if not pushed_shas:
        return False
    output = _git(
        repo,
        "rev-list",
        "--max-count=1",
        "--full-history",
        *pushed_shas,
        *exclude,
        "--",
        *KML_PATHSPECS,
    )
    return bool(output.strip())


def dated_messages(
    repo: Path, exclude: list[str], pushed_shas: list[str]
) -> list[tuple[str, str]]:
    """The dates and times of day in the messages of commits to KML files.

    The weekdays and holidays as well, each with the commit it is in, oldest
    commit first: a message is published with the flight its commit adds
    ("Add flight 16 Aug 2026", "Add flight EDDS-EDDF 1430Z").
    """
    if not pushed_shas:
        return []
    # Imported here: main() puts the checkout on the path first
    from flown.date_tokens import (  # noqa: PLC0415
        find_date_tokens,
        find_holiday_tokens,
        find_partial_date_tokens,
        find_time_tokens,
        find_weekday_tokens,
    )

    output = _git(
        repo,
        "log",
        "--reverse",
        "--format=%H%x00%B%x1e",
        *pushed_shas,
        *exclude,
        "--",
        *KML_PATHSPECS,
    )
    found: list[tuple[str, str]] = []
    for record in _text(output).split("\x1e"):
        commit, _, message = record.strip("\n").partition("\0")
        if not commit:
            continue
        found.extend(
            (commit, token)
            for token in find_date_tokens(message, skip_near_jan_first=True)
            + find_partial_date_tokens(message)
            + find_weekday_tokens(message)
            + find_holiday_tokens(message)
            + find_time_tokens(message)
        )
    return found


def violations_in(
    repo: Path, commit: str, warned: list[str] | None = None
) -> dict[str, list[str]]:
    """The obfuscation violations of the KML files a commit adds or changes.

    What may be a date only for a person to tell refuses nothing
    (``check_kml``): it goes to ``warned``, as the lines to print.
    """
    # Imported here: main() puts the checkout on the path first
    from flown.obfuscate import check_directory  # noqa: PLC0415

    with tempfile.TemporaryDirectory(prefix="kml-pre-push-") as tmp:
        directory = Path(tmp)
        for name in changed_kml_files(repo, commit):
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(_git(repo, "cat-file", "blob", f"{commit}:{name}"))
        violations, warnings = check_directory(directory)
    if warned is not None:
        warned.extend(_lines(warnings, f"{commit[:7]} "))
    return violations


def _lines(found: dict[str, list[str]], prefix: str = "") -> list[str]:
    """One line per issue of each file, as the hooks print them."""
    return [
        f"  {prefix}{name}: {issue}"
        for name, issues in found.items()
        for issue in issues
    ]


def _report_warnings(lines: list[str]) -> None:
    """What may be a date, for a person to look at, in a block of its own
    after any refusal: it refuses nothing."""
    if not lines:
        return
    print("\nPossible dates to look at (not refused):", file=sys.stderr)
    for line in lines:
        _report(line)


def pushed_shas(lines: list[str]) -> list[str]:
    """The local commits of the refs being pushed, from the hook's input."""
    shas = []
    for line in lines:
        fields = line.split()
        if len(fields) == 4 and fields[1] != ZERO_SHA:
            shas.append(fields[1])
    return shas


def _report(line: str) -> None:
    """Print a line naming a file or a message, with any byte no UTF-8 escaped."""
    shown = line.encode(errors="surrogateescape").decode(errors="backslashreplace")
    print(shown, file=sys.stderr)


def _refuse_dated_commits(
    repo: Path, exclude: list[str], shas: list[str], hint: str
) -> bool:
    """Report the commits that date their flights; whether there were any.

    Every commit of ``shas`` but those of ``exclude`` that adds or changes a
    KML file is checked on its own, then the messages of those commits.
    """
    warned: list[str] = []
    refused = _refuse_dated(repo, exclude, shas, hint, warned)
    _report_warnings(warned)
    return refused


def _refuse_dated(
    repo: Path, exclude: list[str], shas: list[str], hint: str, warned: list[str]
) -> bool:
    """``_refuse_dated_commits``, with what may be a date put in ``warned``."""
    found = False
    for commit in commits_to_check(repo, exclude, shas):
        for line in _lines(violations_in(repo, commit, warned), f"{commit[:7]} "):
            found = True
            _report(line)
    if found:
        print(
            "\nPush refused: the commits above carry real flight dates, and the\n"
            "repository is public. Run `make obfuscate`, then rewrite the\n"
            f"commits (amend or rebase) so none of them holds the originals.{hint}",
            file=sys.stderr,
        )
        return True
    messages = dated_messages(repo, exclude, shas)
    for commit, token in messages:
        _report(f"  {commit[:7]} commit message: {token}")
    if messages:
        print(
            "\nPush refused: the messages of the commits above date the flights\n"
            "they add or change, and the repository is public. Reword them\n"
            "without the dates and weekdays: `git commit --amend` for the last\n"
            f"commit, `git rebase -i` with `reword` for an earlier one.{hint}",
            file=sys.stderr,
        )
        return True
    return False


def check_range(repo: Path, base: str, head: str) -> int:
    """The check of CI: the commits ``head`` has and ``base`` has not.

    Each of them on its own, as the hook checks a push, and their messages:
    a push made with `git push --no-verify`, or a file uploaded on GitHub,
    publishes every commit, also one whose files a later commit fixes, and
    the obfuscation check of CI only reads the last. ``base`` is what the
    branch had before (the commit before a push, the base of a pull
    request); with ``ZERO_SHA`` (the first push of a branch) every commit
    of ``head`` is checked. The names of the refs are left to the hook: by
    the time CI runs, the ref has been pushed.
    """
    exclude = [] if base == ZERO_SHA else ["--not", base]
    return 1 if _refuse_dated_commits(repo, exclude, [head], "") else 0


def check_files(names: list[str]) -> int:
    """The check of the pre-commit hook: the KML files a commit stages.

    pre-commit passes their names and has the unstaged changes put aside,
    so the files hold what is committed. Each is checked from a copy, as
    ``violations_in`` checks those of a commit: the tool takes a directory,
    and the copies are all it reads, wherever the files are.
    """
    # Imported here: main() puts the checkout on the path first
    from flown.obfuscate import check_directory  # noqa: PLC0415

    with tempfile.TemporaryDirectory(prefix="kml-pre-commit-") as tmp:
        directory = Path(tmp)
        for name in names:
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(name, target)
        violations, warnings = check_directory(directory)
    for line in _lines(violations):
        _report(line)
    if violations:
        print(
            "\nCommit refused: the files above carry real flight dates, and the\n"
            "repository is public. Run `python -m flown.obfuscate DIRECTORY`\n"
            "(`make obfuscate INPUT_DIR=DIRECTORY`) to rewrite the timestamps,\n"
            "dates and names it knows; remove the rest by hand.",
            file=sys.stderr,
        )
    _report_warnings(_lines(warnings))
    return 1 if violations else 0


def check(repo: Path, lines: list[str], remote: str = "origin") -> int:
    """Print what is wrong and return the hook's exit status."""
    tracked = _is_tracked(repo, remote)
    exclude = published(repo, remote, lines, tracked)
    hint = "" if tracked else SKIP_HINT
    if _refuse_dated_commits(repo, exclude, pushed_shas(lines), hint):
        return 1
    shas = pushed_shas(lines)
    # Each ref by its own commits: a dated branch of code pushed together
    # with flights on another branch dates none of them
    refs = [
        ref
        for line in lines
        if touches_flights(repo, exclude, pushed_shas([line]))
        for ref in dated_refs([line])
    ]
    for ref in refs:
        _report(f"  ref {ref}")
    if refs and not tracked:
        # Every commit the remote has not been seen to have counts as
        # pushed here, the flights of long ago among them, so a branch of
        # code would be refused for them: a warning, not a refusal
        print(
            "pre-push: warning: the names of the refs above may date the\n"
            "flights their commits add or change. This remote was never\n"
            "fetched from, so the hook cannot tell new flights from published\n"
            "ones; if the push adds flights, push them to a branch named\n"
            "without the dates and weekdays.",
            file=sys.stderr,
        )
    elif refs:
        print(
            "\nPush refused: the names of the refs above date the flights their\n"
            "commits add or change, and the repository is public. Push them to\n"
            "a branch named without the dates and weekdays.",
            file=sys.stderr,
        )
        return 1
    # Imported here: main() puts the checkout on the path first
    from flown.helpers import numeric_filename_key  # noqa: PLC0415

    added = sorted(added_flights(repo, exclude, shas), key=numeric_filename_key)
    if added and trip_of(repo, shas, added):
        print(
            f"pre-push: warning: this push adds the flights of one trip "
            f"({', '.join(added)}); a push dates the flights it adds to about "
            "the day it was made, so consider adding them together with "
            "others, some time after the last of them.",
            file=sys.stderr,
        )
    return 0


def main() -> int:
    # The remote's name, or the URL a push names in its place; CI passes
    # `--range BASE HEAD` instead (see check_range), the pre-commit hook
    # `--files NAME...` (see check_files)
    args = sys.argv[1:]
    in_ci = args[:1] == ["--range"]
    if in_ci and len(args) != 3:
        print("usage: pre_push.py --range BASE HEAD", file=sys.stderr)
        return 2
    staged = args[:1] == ["--files"]
    try:
        sys.path.insert(0, str(ROOT))
        if in_ci:
            return check_range(Path.cwd(), args[1], args[2])
        if staged:
            return check_files(args[1:])
        remote = args[0] if args else "origin"
        return check(Path.cwd(), sys.stdin.read().splitlines(), remote)
    except (ImportError, SyntaxError) as e:
        reason = f"{e}; needs Python 3.14 as python3"
    except subprocess.CalledProcessError as e:
        stderr = e.stderr.decode(errors="replace").strip() if e.stderr else ""
        reason = f"git failed: {stderr or e}"
    except OSError as e:
        reason = str(e)
    except UnicodeError as e:
        reason = f"unexpected text: {e}"
    if in_ci:
        print(f"pre_push: cannot check the commits ({reason}).", file=sys.stderr)
        return 1
    if staged:
        print(f"pre-commit: cannot check the KML files ({reason}).", file=sys.stderr)
        return 1
    print(
        f"pre-push: cannot check the KML files ({reason}). Refusing the push; "
        "`git push --no-verify` skips the check.",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
