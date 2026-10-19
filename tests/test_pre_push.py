"""Tests for scripts/pre_push.py, the hook that keeps real dates unpublished.

Every test builds a real repository: what the hook has to get right is which
commits and files git hands it, and a mocked git would only repeat the
assumptions the script makes.
"""

import importlib.util
import io
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parent.parent / "scripts" / "pre_push.py"

GIT = shutil.which("git")
pytestmark = pytest.mark.skipif(GIT is None, reason="needs git")

CLEAN_KML = (
    "<kml><when>2025-01-01T00:00:00Z</when><when>2025-01-01T00:01:00Z</when></kml>"
)
REAL_KML = (
    "<kml><when>2025-03-03T08:25:15Z</when><when>2025-03-03T08:26:15Z</when></kml>"
)


def _load_module():
    """Import pre_push.py, which lives outside any package."""
    spec = importlib.util.spec_from_file_location("pre_push", SCRIPT)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


pre_push = _load_module()


@pytest.fixture(autouse=True)
def isolated_git(monkeypatch, tmp_path):
    """Keep the user's git configuration (signing, hooks) out of the tests."""
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for name in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{name}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{name}_EMAIL", "test@example.com")


def git(repo: Path, *args: str) -> str:
    assert GIT is not None
    return subprocess.run(  # noqa: S603
        [GIT, *args], cwd=repo, capture_output=True, text=True, check=True
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path):
    """A repository whose first commit (a clean flight) the remote already has."""
    repo = tmp_path / "repo"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    commit(repo, {"data/1.kml": CLEAN_KML})
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    return repo


def commit(repo: Path, files: dict[str, str | None], message: str = "c") -> str:
    """Write (or with None, remove) files and commit them; returns the sha."""
    for name, content in files.items():
        path = repo / name
        if content is None:
            git(repo, "rm", "-q", name)
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        git(repo, "add", name)
    git(repo, "commit", "-q", "-m", message)
    return git(repo, "rev-parse", "HEAD")


def push_of(sha: str, remote_sha: str = pre_push.ZERO_SHA) -> list[str]:
    """The hook's input for pushing ``sha`` to main."""
    return [f"refs/heads/main {sha} refs/heads/main {remote_sha}"]


def run_check(repo: Path, lines: list[str]) -> int:
    status: int = pre_push.check(repo, lines)
    return status


class TestCheck:
    def test_passes_clean_flights(self, repo):
        sha = commit(repo, {"data/2.kml": CLEAN_KML})
        assert run_check(repo, push_of(sha)) == 0

    def test_refuses_a_real_date(self, repo, capsys):
        sha = commit(repo, {"data/2.kml": REAL_KML})
        assert run_check(repo, push_of(sha)) == 1
        err = capsys.readouterr().err
        assert f"{sha[:7]} data/2.kml" in err
        assert "2025-03-03" in err
        assert "Push refused" in err
        # Only a remote never fetched from is offered the way round
        assert "--no-verify" not in err

    def test_refuses_a_date_with_a_one_digit_month(self, repo, capsys):
        """The shapes of date_tokens: the hook checks what the export strips."""
        kml = CLEAN_KML.replace("</kml>", "<name>Trip 2025/3/3</name></kml>")
        sha = commit(repo, {"data/2.kml": kml})
        assert run_check(repo, push_of(sha)) == 1
        assert "2025/3/3" in capsys.readouterr().err

    def test_refuses_a_real_date_a_later_commit_fixes(self, repo, capsys):
        bad = commit(repo, {"data/2.kml": REAL_KML})
        fixed = commit(repo, {"data/2.kml": CLEAN_KML})
        assert run_check(repo, push_of(fixed)) == 1
        assert f"{bad[:7]} data/2.kml" in capsys.readouterr().err

    def test_refuses_a_real_date_a_merge_drops_again(self, repo):
        # History simplification would skip the side branch: the merge
        # result matches main, which never had the file
        git(repo, "switch", "-q", "-c", "side")
        commit(repo, {"data/2.kml": REAL_KML})
        commit(repo, {"data/2.kml": None})
        git(repo, "switch", "-q", "main")
        commit(repo, {"notes.txt": "x"})
        git(repo, "merge", "-q", "--no-edit", "side")
        assert run_check(repo, push_of(git(repo, "rev-parse", "HEAD"))) == 1

    def test_checks_kml_files_anywhere_and_in_any_case(self, repo):
        sha = commit(repo, {"elsewhere/Flight.KML": REAL_KML})
        assert run_check(repo, push_of(sha)) == 1

    def test_skips_what_the_remote_already_has(self, repo):
        commit(repo, {"data/2.kml": REAL_KML})
        git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
        sha = commit(repo, {"data/3.kml": CLEAN_KML})
        assert run_check(repo, push_of(sha)) == 0

    def test_a_remote_without_tracking_branches_checks_the_rest(self, repo, capsys):
        """A push to a URL or an unfetched remote has no tracking branches.

        The commits of another remote do not count then: a private remote
        may hold the raw flights, and a first push to a new public remote
        would publish them. The refusal says how to skip the check.
        """
        commit(repo, {"data/2.kml": REAL_KML})
        git(repo, "update-ref", "-d", "refs/remotes/origin/main")
        git(repo, "update-ref", "refs/remotes/private/main", "HEAD")
        sha = commit(repo, {"data/3.kml": CLEAN_KML})
        assert pre_push.check(repo, push_of(sha), "public") == 1
        err = capsys.readouterr().err
        assert "data/2.kml" in err
        assert "--no-verify" in err

    def test_the_hint_says_what_was_checked(self, repo, capsys, monkeypatch):
        """Not the whole history: the remote's side of a ref did not count.

        Whether the remote has tracking branches is asked once a push.
        """
        commit(repo, {"data/2.kml": CLEAN_KML})
        before = commit(repo, {"data/3.kml": CLEAN_KML})
        git(repo, "update-ref", "-d", "refs/remotes/origin/main")
        sha = commit(repo, {"data/4.kml": REAL_KML})
        asked = []
        is_tracked = pre_push._is_tracked

        def counted(*args):
            asked.append(args)
            return is_tracked(*args)

        monkeypatch.setattr(pre_push, "_is_tracked", counted)
        assert run_check(repo, push_of(sha, before)) == 1
        err = capsys.readouterr().err
        assert "whole history" not in err
        assert "the refs pushed to there do not already have" in err
        assert len(asked) == 1

    def test_a_remote_without_tracking_branches_passes_clean_history(self, repo):
        git(repo, "update-ref", "-d", "refs/remotes/origin/main")
        sha = commit(repo, {"data/2.kml": CLEAN_KML})
        assert pre_push.check(repo, push_of(sha), "https://example.com/r") == 0

    def test_checks_what_only_another_remote_has(self, repo, capsys):
        """A fork or a mirror may have commits the public remote never had."""
        commit(repo, {"data/2.kml": REAL_KML})
        git(repo, "update-ref", "refs/remotes/fork/main", "HEAD")
        sha = commit(repo, {"data/3.kml": CLEAN_KML})
        assert run_check(repo, push_of(sha)) == 1
        assert "data/2.kml" in capsys.readouterr().err
        # Pushed to the fork, they are its own already
        assert pre_push.check(repo, push_of(sha), "fork") == 0

    def test_skips_what_the_ref_pushed_to_already_has(self, repo):
        """Without any tracking branch, the remote's side of the ref counts."""
        published = commit(repo, {"data/2.kml": REAL_KML})
        git(repo, "update-ref", "-d", "refs/remotes/origin/main")
        sha = commit(repo, {"data/3.kml": CLEAN_KML})
        assert run_check(repo, push_of(sha, published)) == 0
        # Not what the remote's ref does not reach
        assert run_check(repo, push_of(sha, git(repo, "rev-parse", "HEAD~2"))) == 1

    def test_a_remote_commit_the_clone_lacks_checks_the_rest(self, repo):
        commit(repo, {"data/2.kml": REAL_KML})
        sha = commit(repo, {"data/3.kml": CLEAN_KML})
        assert run_check(repo, push_of(sha, "1" * 40)) == 1

    def test_a_file_name_that_is_no_utf_8(self, repo, capsys):
        """git hands over names as bytes; the hook still checks the file."""
        name = os.fsdecode(b"data/Fl\xfcg.kml")
        (repo / name).write_text(REAL_KML)
        git(repo, "add", "--", name)
        git(repo, "commit", "-q", "-m", "c")
        sha = git(repo, "rev-parse", "HEAD")
        assert run_check(repo, push_of(sha)) == 1
        assert "2025-03-03" in capsys.readouterr().err

    def test_ignores_commits_without_kml_files(self, repo):
        sha = commit(repo, {"README.md": "2025-03-03"})
        assert run_check(repo, push_of(sha)) == 0

    def test_ignores_a_deleted_ref(self, repo):
        lines = [f"(delete) {pre_push.ZERO_SHA} refs/heads/old {'a' * 40}"]
        assert run_check(repo, lines) == 0


# Fields a leg flies between, (lon, lat)
HOME, AWAY, FURTHER = "12.05,51.55", "13.76,51.13", "11.79,50.32"


def leg(start: str, end: str) -> str:
    """A clean flight from ``start`` to ``end``."""
    return CLEAN_KML.replace(
        "</kml>",
        f"<Placemark><LineString><coordinates>{start},300 {end},400"
        "</coordinates></LineString></Placemark></kml>",
    )


class TestTripWarning:
    """A push dates the flights it adds to about the day it was made."""

    def test_warns_when_one_flight_is_added(self, repo, capsys):
        sha = commit(repo, {"data/2.kml": CLEAN_KML})
        assert run_check(repo, push_of(sha)) == 0
        err = capsys.readouterr().err
        assert err.count("\n") == 1
        assert "adds the flights of one trip (data/2.kml)" in err

    def test_warns_for_the_flights_of_a_day(self, repo, capsys):
        commit(repo, {"data/2.kml": CLEAN_KML})
        sha = commit(repo, {"data/3.kml": CLEAN_KML, "data/4.kml": CLEAN_KML})
        assert run_check(repo, push_of(sha)) == 0
        assert "(data/2.kml, data/3.kml, data/4.kml)" in capsys.readouterr().err

    def test_warns_for_the_legs_of_one_trip(self, repo, capsys):
        """Each leg starts where the one before ended, away from home."""
        sha = commit(
            repo,
            {
                "data/2.kml": leg(HOME, AWAY),
                "data/10.kml": leg(FURTHER, HOME),
                "data/3.kml": leg(AWAY, FURTHER),
                "data/4.kml": leg(FURTHER, FURTHER),
            },
        )
        assert run_check(repo, push_of(sha)) == 0
        assert "flights of one trip" in capsys.readouterr().err

    def test_no_warning_for_flights_that_come_home_in_between(self, repo, capsys):
        """Weeks of flights at home, with a trip among them."""
        sha = commit(
            repo,
            {
                "data/2.kml": leg(HOME, HOME),
                "data/3.kml": leg(HOME, AWAY),
                "data/4.kml": leg(AWAY, HOME),
                "data/5.kml": leg(HOME, HOME),
            },
        )
        assert run_check(repo, push_of(sha)) == 0
        assert capsys.readouterr().err == ""

    def test_no_warning_for_flights_that_do_not_follow_on(self, repo, capsys):
        files: dict[str, str | None] = {
            f"data/{n}.kml": leg(HOME, AWAY) for n in range(2, 6)
        }
        sha = commit(repo, files)
        assert run_check(repo, push_of(sha)) == 0
        assert capsys.readouterr().err == ""

    def test_no_warning_for_a_flight_the_push_removes_again(self, repo, capsys):
        commit(
            repo,
            {
                "data/2.kml": leg(HOME, AWAY),
                "data/3.kml": leg(AWAY, FURTHER),
                "data/4.kml": leg(FURTHER, AWAY),
                "data/5.kml": leg(AWAY, FURTHER),
            },
        )
        sha = commit(repo, {"data/5.kml": None})
        assert run_check(repo, push_of(sha)) == 0
        assert capsys.readouterr().err == ""

    def test_no_warning_for_flights_without_a_point_to_read(self, repo, capsys):
        files: dict[str, str | None] = {f"data/{n}.kml": CLEAN_KML for n in range(2, 6)}
        sha = commit(repo, files)
        assert run_check(repo, push_of(sha)) == 0
        assert capsys.readouterr().err == ""

    def test_no_warning_for_a_changed_flight_or_one_elsewhere(self, repo, capsys):
        commit(repo, {"data/1.kml": CLEAN_KML.replace("00:01", "00:02")})
        sha = commit(repo, {"tests/fixtures/x.kml": CLEAN_KML})
        assert run_check(repo, push_of(sha)) == 0
        assert capsys.readouterr().err == ""

    def test_warns_for_the_flights_of_a_copy_outside_data(self, repo, capsys):
        """A copy keeps its flights where FLOWN_INPUT_DIR says (doc/hosting.md)."""
        sha = commit(repo, {"flights/2025/2.KML": CLEAN_KML})
        assert run_check(repo, push_of(sha)) == 0
        assert "flights of one trip (flights/2025/2.KML)" in capsys.readouterr().err

    def test_a_kmz_is_checked_and_refused(self, repo, capsys):
        """The check cannot read into the archive, so it cannot pass it."""
        sha = commit(repo, {"data/2.kmz": "PK"})
        assert run_check(repo, push_of(sha)) == 1
        assert "KMZ archive" in capsys.readouterr().err


class TestCommitMessages:
    """A message is published with the flight its commit adds."""

    def test_refuses_a_dated_message(self, repo, capsys):
        sha = commit(
            repo,
            {"data/2.kml": CLEAN_KML, "data/3.kml": CLEAN_KML},
            "Add the flights of 16 Aug 2026, Sunday",
        )
        assert run_check(repo, push_of(sha)) == 1
        err = capsys.readouterr().err
        assert f"{sha[:7]} commit message: 16 Aug 2026" in err
        assert f"{sha[:7]} commit message: Sunday" in err
        assert "git commit --amend" in err

    @pytest.mark.parametrize(
        "message",
        [
            "Flights of 16 Aug",
            "Trip KW33",
            "Heiligabend bei Oma",
            # Compact dates with the year last, and six digits after a
            # separator or with the time after them
            "Add flight 16082026",
            "Add flight 08162026",
            "Add log_260816",
            "Add flight 260816-1430",
            # The time of day of a flight (regression: only the dates were
            # looked for)
            "Add flight EDDS-EDDF 1430Z",
            "Add flight 14:30",
            "Flug 33. KW",
            # Midnight with an offset is no midnight UTC
            "Add flight 00:00 +02:00",
        ],
    )
    def test_refuses_what_dates_a_flight(self, repo, message):
        sha = commit(repo, {"data/2.kml": CLEAN_KML, "data/3.kml": CLEAN_KML}, message)
        assert run_check(repo, push_of(sha)) == 1

    def test_passes_an_airport_code_that_looks_like_a_week(self, repo):
        sha = commit(
            repo,
            {"data/2.kml": CLEAN_KML, "data/3.kml": CLEAN_KML},
            "KW05 Gettysburg - KW22 Upshur",
        )
        assert run_check(repo, push_of(sha)) == 0

    @pytest.mark.parametrize(
        "message",
        [
            "Obfuscate: every flight starts at 00:00:00 UTC",
            "Charterware descriptions at 12:00AM",
            "Move the flights to 2026-01-01T00:00:00Z",
        ],
    )
    def test_passes_midnight(self, repo, message):
        """The time of every obfuscated flight gives none away."""
        sha = commit(repo, {"data/2.kml": CLEAN_KML, "data/3.kml": CLEAN_KML}, message)
        assert run_check(repo, push_of(sha)) == 0

    def test_passes_an_undated_message(self, repo):
        sha = commit(
            repo,
            {"data/2.kml": CLEAN_KML, "data/3.kml": CLEAN_KML},
            "Add two flights to EDDS",
        )
        assert run_check(repo, push_of(sha)) == 0

    def test_refuses_a_dated_message_of_flights_outside_data(self, repo):
        """A copy keeps its flights where FLOWN_INPUT_DIR says (hosting.md)."""
        sha = commit(repo, {"flights/2.kml": CLEAN_KML}, "Add flight 16 Aug 2026")
        assert run_check(repo, push_of(sha)) == 1

    def test_ignores_messages_of_commits_without_flights(self, repo):
        sha = commit(repo, {"README.md": "x"}, "Docs of 16 Aug 2026")
        assert run_check(repo, push_of(sha)) == 0

    def test_refuses_a_dated_message_that_is_no_utf_8(self, repo, capsys):
        """A Latin-1 message git does not convert says what it holds."""
        (repo / "data" / "2.kml").write_text(CLEAN_KML)
        git(repo, "add", "data/2.kml")
        message = repo.parent / "message"
        message.write_bytes(b"Flug am 16. Aug 2026 \xfcber Ulm\n")
        git(repo, "-c", "i18n.commitEncoding=bogus", "commit", "-q", "-F", str(message))
        sha = git(repo, "rev-parse", "HEAD")
        assert run_check(repo, push_of(sha)) == 1
        assert "16. Aug 2026" in capsys.readouterr().err

    def test_skips_messages_the_remote_already_has(self, repo):
        sha = commit(
            repo,
            {"data/2.kml": CLEAN_KML, "data/3.kml": CLEAN_KML},
            "Flights of 2026-08-16",
        )
        git(repo, "update-ref", "refs/remotes/origin/main", sha)
        later = commit(repo, {"README.md": "x"})
        assert run_check(repo, push_of(later)) == 0


class TestRefNames:
    """The name of a branch pushed to is published with its flights."""

    def test_refuses_a_dated_branch_with_flights(self, repo, capsys):
        sha = commit(repo, {"data/2.kml": CLEAN_KML, "data/3.kml": CLEAN_KML})
        lines = [
            f"refs/heads/x {sha} refs/heads/flights-2026-08-16 {pre_push.ZERO_SHA}"
        ]
        assert run_check(repo, lines) == 1
        err = capsys.readouterr().err
        assert "ref refs/heads/flights-2026-08-16: 2026-08-16" in err
        assert "named without the dates" in err

    @pytest.mark.parametrize(
        "branch",
        [
            "refs/heads/flights-260816",
            "refs/heads/260816",
            "refs/heads/flight-16-08",
            "refs/heads/flights-16082026",
            "refs/heads/flight-1430z",
        ],
    )
    def test_refuses_a_branch_with_a_compact_date(self, repo, branch, capsys):
        sha = commit(repo, {"data/2.kml": CLEAN_KML, "data/3.kml": CLEAN_KML})
        lines = [f"refs/heads/x {sha} {branch} {pre_push.ZERO_SHA}"]
        assert run_check(repo, lines) == 1
        assert f"ref {branch}: " in capsys.readouterr().err

    def test_refuses_a_dated_branch_with_flights_outside_data(self, repo):
        sha = commit(repo, {"flights/2.kml": CLEAN_KML})
        branch = "refs/heads/flights-2026-08-16"
        lines = [f"refs/heads/x {sha} {branch} {pre_push.ZERO_SHA}"]
        assert run_check(repo, lines) == 1

    def test_refuses_a_branch_named_after_a_weekday(self, repo):
        sha = commit(repo, {"data/2.kml": CLEAN_KML, "data/3.kml": CLEAN_KML})
        lines = [f"refs/heads/x {sha} refs/heads/sunday-trip {pre_push.ZERO_SHA}"]
        assert run_check(repo, lines) == 1

    def test_passes_a_dated_branch_without_flights(self, repo):
        sha = commit(repo, {"README.md": "x"})
        lines = [f"refs/heads/x {sha} refs/heads/fix-2026-10-06 {pre_push.ZERO_SHA}"]
        assert run_check(repo, lines) == 0

    def test_passes_a_dated_branch_of_code_pushed_with_flights(self, repo):
        """Each ref by its own commits, not by those of the whole push."""
        git(repo, "switch", "-q", "-c", "fix")
        code = commit(repo, {"README.md": "x"})
        git(repo, "switch", "-q", "main")
        flights = commit(repo, {"data/2.kml": CLEAN_KML})
        lines = [
            *push_of(flights),
            f"refs/heads/fix {code} refs/heads/fix-2026-10-09 {pre_push.ZERO_SHA}",
        ]
        assert run_check(repo, lines) == 0

    def test_warns_of_a_dated_branch_to_a_remote_never_fetched_from(self, repo, capsys):
        """Its whole history counts as pushed there, old flights and all."""
        sha = commit(repo, {"README.md": "x"})
        lines = [f"refs/heads/x {sha} refs/heads/fix-2026-10-09 {pre_push.ZERO_SHA}"]
        assert pre_push.check(repo, lines, remote="fork") == 0
        err = capsys.readouterr().err
        assert "ref refs/heads/fix-2026-10-09: 2026-10-09" in err
        assert "warning" in err
        assert "never\nfetched from" in err

    def test_a_dated_branch_deleted_along_with_a_push_of_flights(self, repo):
        sha = commit(repo, {"data/2.kml": CLEAN_KML, "data/3.kml": CLEAN_KML})
        head = git(repo, "rev-parse", "HEAD~1")
        lines = [
            *push_of(sha),
            f"(delete) {pre_push.ZERO_SHA} refs/heads/flights-2026-08-16 {head}",
        ]
        assert run_check(repo, lines) == 0

    def test_passes_the_deletion_of_a_dated_branch(self, repo):
        head = git(repo, "rev-parse", "HEAD")
        lines = [f"(delete) {pre_push.ZERO_SHA} refs/heads/flights-2026-08-16 {head}"]
        assert run_check(repo, lines) == 0


class TestFlightEnds:
    def test_of_a_track_and_of_lines(self):
        content = (
            "<kml><gx:Track><gx:coord>8.5 50.0 300</gx:coord>"
            "<gx:coord>9.0 51.0 400</gx:coord></gx:Track>"
            "<LineString><coordinates>9.0,51.0,400 10.0,52.0,500</coordinates>"
            "</LineString></kml>"
        )
        assert pre_push.flight_ends(content) == ((50.0, 8.5), (52.0, 10.0))

    @pytest.mark.parametrize(
        "content",
        [CLEAN_KML, "<coordinates>x,y</coordinates>", "<coordinates> </coordinates>"],
    )
    def test_none_without_a_point(self, content):
        assert pre_push.flight_ends(content) is None


class TestMain:
    def test_fails_closed_when_it_cannot_check(self, monkeypatch, capsys):
        def broken(*_args):
            raise ImportError("no module named flown")

        monkeypatch.setattr(pre_push, "check", broken)
        monkeypatch.setattr(sys, "argv", ["pre-push", "origin"])
        monkeypatch.setattr(sys, "stdin", io.StringIO(""))
        assert pre_push.main() == 1
        err = capsys.readouterr().err
        assert "--no-verify" in err
        assert "Python 3.14" in err

    def test_a_git_failure_says_what_git_said(self, monkeypatch, capsys):
        def broken(*_args):
            raise subprocess.CalledProcessError(
                128, ["git"], stderr=b"fatal: bad object deadbeef\n"
            )

        monkeypatch.setattr(pre_push, "check", broken)
        monkeypatch.setattr(sys, "argv", ["pre-push", "origin"])
        monkeypatch.setattr(sys, "stdin", io.StringIO(""))
        assert pre_push.main() == 1
        err = capsys.readouterr().err
        assert "fatal: bad object deadbeef" in err
        assert "Python 3.14" not in err
        assert "--no-verify" in err

    def test_text_it_cannot_read_fails_closed(self, monkeypatch, capsys):
        def broken(*_args):
            raise UnicodeDecodeError("utf-8", b"\xfc", 0, 1, "invalid start byte")

        monkeypatch.setattr(pre_push, "check", broken)
        monkeypatch.setattr(sys, "stdin", io.StringIO(""))
        assert pre_push.main() == 1
        assert "cannot check" in capsys.readouterr().err


class TestCheckRange:
    """CI checks every commit a push or a pull request adds, not the tip."""

    def test_refuses_a_real_date_a_later_commit_fixes(self, repo, capsys):
        base = git(repo, "rev-parse", "HEAD")
        dated = commit(repo, {"data/2.kml": REAL_KML})
        fixed = commit(repo, {"data/2.kml": CLEAN_KML})
        assert pre_push.check_range(repo, base, fixed) == 1
        err = capsys.readouterr().err
        assert f"{dated[:7]} data/2.kml" in err
        assert "never\nfetched from" not in err

    def test_refuses_a_dated_message(self, repo, capsys):
        base = git(repo, "rev-parse", "HEAD")
        sha = commit(repo, {"data/2.kml": CLEAN_KML}, "Add flight 16082026")
        assert pre_push.check_range(repo, base, sha) == 1
        assert f"{sha[:7]} commit message: 16082026" in capsys.readouterr().err

    def test_lists_possible_dates_apart_after_the_refusal(self, repo, capsys):
        """A warning is no refusal: its own block, after the refusal, with
        the commit shortened as the refused files' are."""
        base = git(repo, "rev-parse", "HEAD")
        possible = CLEAN_KML.replace(
            "</kml>", "<name>Flyg 16 augusti 2026</name></kml>"
        )
        warned = commit(repo, {"data/3.kml": possible})
        dated = commit(repo, {"data/2.kml": REAL_KML})
        assert pre_push.check_range(repo, base, dated) == 1
        err = capsys.readouterr().err
        refused = err.index("Push refused")
        block = err.index("Possible dates to look at (not refused):")
        assert err.index(f"  {dated[:7]} data/2.kml: ") < refused < block
        assert err.index(f"  {warned[:7]} data/3.kml: May be a date") > block

    def test_a_possible_date_alone_passes(self, repo, capsys):
        base = git(repo, "rev-parse", "HEAD")
        possible = CLEAN_KML.replace(
            "</kml>", "<name>Flyg 16 augusti 2026</name></kml>"
        )
        sha = commit(repo, {"data/3.kml": possible})
        assert pre_push.check_range(repo, base, sha) == 0
        err = capsys.readouterr().err
        assert f"  {sha[:7]} data/3.kml: May be a date" in err
        assert "refused:" not in err.replace("(not refused):", "")

    def test_skips_what_the_base_has(self, repo):
        commit(repo, {"data/2.kml": REAL_KML})
        base = commit(repo, {"data/2.kml": CLEAN_KML})
        sha = commit(repo, {"data/3.kml": CLEAN_KML})
        assert pre_push.check_range(repo, base, sha) == 0

    def test_checks_the_whole_history_without_a_base(self, repo):
        commit(repo, {"data/2.kml": REAL_KML})
        sha = commit(repo, {"data/2.kml": CLEAN_KML})
        assert pre_push.check_range(repo, pre_push.ZERO_SHA, sha) == 1

    def test_the_command_line(self, repo, monkeypatch):
        base = git(repo, "rev-parse", "HEAD")
        sha = commit(repo, {"data/2.kml": REAL_KML})
        monkeypatch.chdir(repo)
        monkeypatch.setattr(sys, "argv", ["pre_push.py", "--range", base, sha])
        assert pre_push.main() == 1
        monkeypatch.setattr(sys, "argv", ["pre_push.py", "--range", base, base])
        assert pre_push.main() == 0

    def test_a_base_it_does_not_have_fails(self, repo, monkeypatch, capsys):
        """A shallow clone without the base commit cannot pass for clean."""
        monkeypatch.chdir(repo)
        monkeypatch.setattr(sys, "argv", ["pre_push.py", "--range", "1" * 40, "HEAD"])
        assert pre_push.main() == 1
        assert "cannot check the commits" in capsys.readouterr().err

    def test_the_range_needs_both_ends(self, monkeypatch):
        monkeypatch.setattr(sys, "argv", ["pre_push.py", "--range", "HEAD"])
        assert pre_push.main() == 2


class TestCheckFiles:
    """The pre-commit hook checks the KML files a commit stages, anywhere."""

    def test_passes_clean_files(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "flights").mkdir()
        (tmp_path / "flights" / "2.kml").write_text(CLEAN_KML)
        assert pre_push.check_files(["flights/2.kml"]) == 0

    def test_refuses_a_real_date_outside_data(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "flights" / "2025").mkdir(parents=True)
        (tmp_path / "flights" / "2025" / "2.KML").write_text(REAL_KML)
        (tmp_path / "3.kml").write_text(CLEAN_KML)
        assert pre_push.check_files(["flights/2025/2.KML", "3.kml"]) == 1
        err = capsys.readouterr().err
        assert "flights/2025/2.KML: " in err
        assert "3.kml" not in err
        assert "Commit refused" in err

    def test_warns_of_a_possible_date_and_passes(self, tmp_path, monkeypatch, capsys):
        """A day, a word and a year the patterns do not know refuses nothing."""
        monkeypatch.chdir(tmp_path)
        (tmp_path / "2.kml").write_text(
            CLEAN_KML.replace("</kml>", "<name>Flyg 16 augusti 2026</name></kml>")
        )
        assert pre_push.check_files(["2.kml"]) == 0
        err = capsys.readouterr().err
        assert "not refused" in err
        assert "2.kml: May be a date in another language" in err

    def test_lists_possible_dates_after_the_refusal(
        self, tmp_path, monkeypatch, capsys
    ):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "2.kml").write_text(REAL_KML)
        (tmp_path / "3.kml").write_text(
            CLEAN_KML.replace("</kml>", "<name>Flyg 16 augusti 2026</name></kml>")
        )
        assert pre_push.check_files(["2.kml", "3.kml"]) == 1
        err = capsys.readouterr().err
        refused = err.index("Commit refused")
        block = err.index("Possible dates to look at (not refused):")
        assert err.index("  2.kml: ") < refused < block < err.index("  3.kml: May be")

    def test_refuses_a_kmz(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "2.kmz").write_bytes(b"PK")
        assert pre_push.check_files(["2.kmz"]) == 1
        assert "KMZ archive" in capsys.readouterr().err

    def test_the_command_line(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        (tmp_path / "2.kml").write_text(REAL_KML)
        (tmp_path / "3.kml").write_text(CLEAN_KML)
        monkeypatch.setattr(sys, "argv", ["pre_push.py", "--files", "2.kml"])
        assert pre_push.main() == 1
        monkeypatch.setattr(sys, "argv", ["pre_push.py", "--files", "3.kml"])
        assert pre_push.main() == 0

    def test_the_hook_shows_its_warnings_when_it_passes(self):
        """pre-commit prints a hook's output only when it fails, unless it is
        verbose: the possible dates fail nothing."""
        config = (SCRIPT.parent.parent / ".pre-commit-config.yaml").read_text()
        hook = config.split("- id: check-obfuscation", 1)[1].split("- id:", 1)[0]
        assert "entry: python scripts/pre_push.py --files" in hook
        assert "\n        verbose: true\n" in hook

    def test_a_file_it_cannot_read_fails_closed(self, tmp_path, monkeypatch, capsys):
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(sys, "argv", ["pre_push.py", "--files", "gone.kml"])
        assert pre_push.main() == 1
        assert "pre-commit: cannot check" in capsys.readouterr().err


WRAPPER = SCRIPT.parent / "pre-push-hook"
MAKEFILE = SCRIPT.parent.parent / "Makefile"
MAKE = shutil.which("make")


def _with_remote(repo: Path, tmp_path: Path) -> Path:
    """Give ``repo`` a bare remote that has its commits; returns its hook."""
    remote = tmp_path / "remote.git"
    git(tmp_path, "init", "-q", "--bare", str(remote))
    git(repo, "remote", "add", "origin", str(remote))
    git(repo, "push", "-q", "origin", "main")
    hook = Path(git(repo, "rev-parse", "--git-path", "hooks/pre-push"))
    hook = hook if hook.is_absolute() else repo / hook
    hook.parent.mkdir(parents=True, exist_ok=True)
    return hook


def _push(
    repo: Path, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    assert GIT is not None
    return subprocess.run(  # noqa: S603
        [GIT, "push", "-q", "origin", "main"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
        env=env,
    )


def _old_pythons(tmp_path: Path) -> dict[str, str]:
    """An environment whose python3.14, python3 and python are all too old,
    as outside the virtual environment on macOS: each fails the version
    check the wrapper asks it"""
    shims = tmp_path / "old-pythons"
    shims.mkdir()
    for name in ("python3.14", "python3", "python"):
        shim = shims / name
        shim.write_text("#!/bin/sh\nexit 1\n", encoding="utf-8")
        shim.chmod(0o755)
    return {**os.environ, "PATH": f"{shims}{os.pathsep}{os.environ['PATH']}"}


class TestInstalledHook:
    def test_git_push_is_refused(self, repo, tmp_path):
        hook = _with_remote(repo, tmp_path)
        hook.symlink_to(SCRIPT)

        commit(repo, {"data/2.kml": REAL_KML})
        refused = _push(repo)
        assert refused.returncode != 0
        assert "Push refused" in refused.stderr

        # Rewritten without the original, the same flight goes through
        git(repo, "reset", "-q", "--hard", "origin/main")
        commit(repo, {"data/2.kml": CLEAN_KML})
        git(repo, "push", "-q", "origin", "main")


class TestHookWrapper:
    """The hook `make hooks` installs runs the check of the pushing worktree."""

    def test_runs_the_check_of_the_worktree(self, repo, tmp_path):
        hook = _with_remote(repo, tmp_path)
        shutil.copy(WRAPPER, hook)
        (repo / "scripts").mkdir()
        (repo / "scripts" / "pre_push.py").symlink_to(SCRIPT)

        commit(repo, {"data/2.kml": REAL_KML})
        refused = _push(repo)
        assert refused.returncode != 0
        assert "Push refused" in refused.stderr

    def test_refuses_the_push_without_a_check_to_run(self, repo, tmp_path):
        """The worktree that installed the hook is gone: no silent pass."""
        hook = _with_remote(repo, tmp_path)
        shutil.copy(WRAPPER, hook)

        commit(repo, {"data/2.kml": CLEAN_KML})
        refused = _push(repo)
        assert refused.returncode != 0
        assert "is missing" in refused.stderr

    def test_refuses_the_push_without_a_python_new_enough(self, repo, tmp_path):
        hook = _with_remote(repo, tmp_path)
        shutil.copy(WRAPPER, hook)
        (repo / "scripts").mkdir()
        (repo / "scripts" / "pre_push.py").symlink_to(SCRIPT)

        commit(repo, {"data/2.kml": CLEAN_KML})
        refused = _push(repo, _old_pythons(tmp_path))
        assert refused.returncode != 0
        assert "no Python 3.14 or newer" in refused.stderr

    def test_runs_the_check_with_the_python_of_the_worktree(self, repo, tmp_path):
        """A Git GUI runs the hook outside the virtual environment."""
        hook = _with_remote(repo, tmp_path)
        shutil.copy(WRAPPER, hook)
        (repo / "scripts").mkdir()
        (repo / "scripts" / "pre_push.py").symlink_to(SCRIPT)
        venv = repo / ".venv" / "bin"
        venv.mkdir(parents=True)
        (venv / "python").symlink_to(sys.executable)

        commit(repo, {"data/2.kml": REAL_KML})
        refused = _push(repo, _old_pythons(tmp_path))
        assert refused.returncode != 0
        assert "Push refused" in refused.stderr

    @pytest.mark.skipif(MAKE is None, reason="needs make")
    def test_make_hooks_replaces_the_link_of_an_earlier_install(self, repo, tmp_path):
        hook = _with_remote(repo, tmp_path)
        # Into a worktree that was removed since: git skips it silently
        hook.symlink_to(tmp_path / "gone" / "scripts" / "pre_push.py")
        (repo / "scripts").mkdir()
        shutil.copy(WRAPPER, repo / "scripts" / WRAPPER.name)

        assert MAKE is not None
        subprocess.run(  # noqa: S603
            [MAKE, "-s", "-f", str(MAKEFILE), "-C", str(repo), "hooks"],
            capture_output=True,
            check=True,
        )

        assert not hook.is_symlink()
        assert hook.read_bytes() == WRAPPER.read_bytes()
        assert os.access(hook, os.X_OK)

    @pytest.mark.skipif(MAKE is None, reason="needs make")
    def test_make_hooks_updates_an_older_copy_of_the_wrapper(self, repo, tmp_path):
        hook = _with_remote(repo, tmp_path)
        hook.write_text("#!/bin/sh\n# flown pre-push hook: older\nexit 1\n")
        (repo / "scripts").mkdir()
        shutil.copy(WRAPPER, repo / "scripts" / WRAPPER.name)

        assert MAKE is not None
        subprocess.run(  # noqa: S603
            [MAKE, "-s", "-f", str(MAKEFILE), "-C", str(repo), "hooks"],
            capture_output=True,
            check=True,
        )

        assert hook.read_bytes() == WRAPPER.read_bytes()

    @pytest.mark.skipif(MAKE is None, reason="needs make")
    def test_make_hooks_keeps_a_hook_of_its_own(self, repo, tmp_path):
        hook = _with_remote(repo, tmp_path)
        hook.write_text("#!/bin/sh\nexit 0\n")
        (repo / "scripts").mkdir()
        shutil.copy(WRAPPER, repo / "scripts" / WRAPPER.name)

        assert MAKE is not None
        failed = subprocess.run(  # noqa: S603
            [MAKE, "-s", "-f", str(MAKEFILE), "-C", str(repo), "hooks"],
            capture_output=True,
            text=True,
            check=False,
        )

        assert failed.returncode != 0
        assert "exists already" in failed.stdout + failed.stderr
        assert hook.read_text() == "#!/bin/sh\nexit 0\n"
