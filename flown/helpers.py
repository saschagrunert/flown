"""Helper functions for common operations."""

import re
from datetime import UTC, datetime
from pathlib import Path

__all__ = [
    "DATE_PATTERN",
    "calculate_duration_seconds",
    "normalize_timestamp_text",
    "numeric_filename_key",
    "parse_iso_timestamp",
    "parse_timestamp_epoch",
]

# A date as flight logs write it into names: "16 Aug 2026", "6 Aug 2026" or
# "2026-08-16"
DATE_PATTERN = re.compile(r"(?<!\d)(\d{1,2}\s+\w{3}\s+\d{4}|\d{4}-\d{2}-\d{2})")
# "2024-03-14 09:12:00": a space instead of the "T", which some tools write
# and others read, or a lowercase "t", which RFC 3339 allows
_LOOSE_TIMESTAMP_PATTERN = re.compile(r"^(\d{4}-\d{2}-\d{2})[ t](\d)")


def normalize_timestamp_text(text: str) -> str:
    """The canonical form of a loosely written ISO timestamp.

    A space or a lowercase "t" between date and time becomes the "T" and a
    lowercase "z" the "Z"; anything else is left as it is. The parser and
    the obfuscator both read timestamps through this, so they accept the
    same ones.
    """
    text = text.strip()
    # Checked first: the parser runs this for every <when> of a track
    if text[10:11] in (" ", "t"):
        text = _LOOSE_TIMESTAMP_PATTERN.sub(r"\1T\2", text, count=1)
    if text.endswith("z"):
        text = text[:-1] + "Z"
    return text


def parse_iso_timestamp(timestamp_str: str | None) -> datetime | None:
    """Parse ISO format timestamp string to datetime object.

    Only a timestamp with a time is accepted: a date on its own is not a
    point in time. See ``normalize_timestamp_text`` for the loose forms.
    """
    if not timestamp_str:
        return None
    text = normalize_timestamp_text(timestamp_str)
    if "T" not in text:
        return None

    try:
        return datetime.fromisoformat(text)
    except ValueError, TypeError:
        return None


def parse_timestamp_epoch(timestamp_str: str | None) -> float | None:
    """Parse an ISO timestamp to Unix epoch seconds (naive values are UTC)."""
    dt = parse_iso_timestamp(timestamp_str)
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=UTC)
    return dt.timestamp()


def calculate_duration_seconds(
    start_timestamp: str | None, end_timestamp: str | None
) -> float:
    """Calculate duration in seconds between two ISO timestamp strings."""
    if not start_timestamp or not end_timestamp:
        return 0.0

    start = parse_timestamp_epoch(start_timestamp)
    end = parse_timestamp_epoch(end_timestamp)

    if start is not None and end is not None:
        return end - start

    return 0.0


def numeric_filename_key(path: str) -> tuple[int, int, str]:
    """Sort key that orders files numerically by leading digits in the filename."""
    name = Path(path).name
    match = re.match(r"(\d+)", name)
    if match:
        return (0, int(match.group(1)), name)
    return (1, 0, name)
