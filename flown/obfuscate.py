"""KML date and timestamp obfuscation for privacy.

Shifts the timestamps of a file so that every flight starts at midnight
(00:00:00 UTC) on January 1st of its actual (UTC) year: neither the date nor
the time of day of a flight is kept. A flight moves by one offset of whole
seconds, so everything computed from its timestamps stays exactly as it was:
the intervals between its points, the gaps between its tracks, their order,
its durations, speeds, landings and flight time, and its year. The
timestamps are grouped into flights (see ``_timestamp_groups``); a file
usually holds one and moves by one offset, while a file with flights on
several dates puts each of them at midnight on January 1st of its own year.
Covered are ``<when>`` (gx:Track and TimeStamp) and
``<TimeSpan><begin>/<end>``, with or without a namespace prefix. The check
holds every flight to that start (see ``_timestamp_violations``).

Dates without a timestamp move to January 1st of their own year: date-only
timestamps, Charterware description dates ("Flight Jan 12 2026 03:01PM"
becomes "Flight Jan 01 2026 12:00AM"), route names with dates ("EDDS to
EDDP - 16 Aug 2026", "EDDS to EDDP - 2026-08-16") and the SkyDemon marker
names (Log Start, Takeoff, Landing, Log Stop), which lose their time. A
date in a name that the parser reads a year from ("16 Aug 2026",
"2026-08-16") moves to January 1st as well; every other date, part of a
date, time of day, weekday, holiday and Unix time in a name, a
description or another element of free text (a Snippet, an address, the
value of a Data, ``TEXT_ELEMENT_PATTERN``) is taken out
(``date_tokens.stray_date_spans``), as the check would report it, until
nothing of it is left. The check reports the parts of dates in the text
of every element, and those outside the free text have to go by hand, as
the dates, times of day and weekdays there do. Every ``creator`` attribute
is replaced with a generic value. Files are rewritten atomically and in
place; ``rename_dated_files`` removes the date and time from Charterware
file names ("2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml") and the dates from
other file names ("1_DEHYL_DA40_16Aug.kml").
"""

import argparse
import html
import os
import re
import sys
from bisect import bisect_right
from datetime import UTC, datetime, time, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

from .aircraft import parse_aircraft_from_filename
from .cache import atomic_write
from .constants import MAX_TIMESTAMP_DISTANCE_SECONDS
from .date_tokens import (
    CHARTERWARE_DATE_PATTERN,
    EPOCH_PATTERN,
    MAX_DAYS_AFTER_JAN_1,
    any_month_number,
    charterware_datetime,
    epoch_is_obfuscated,
    epoch_spans,
    find_date_tokens,
    find_holiday_tokens,
    find_partial_date_tokens,
    find_possible_date_tokens,
    find_time_tokens,
    find_weekday_tokens,
    month_number,
    stray_date_spans,
    without_spans,
)
from .date_words import MONTHS_LONG, MONTHS_SHORT
from .helpers import normalize_timestamp_text, parse_iso_timestamp
from .logger import logger
from .validation import KmlListing, list_kml_files

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

__all__ = [
    "ObfuscationCheck",
    "check_directory",
    "check_kml",
    "obfuscate_kml_content",
    "obfuscate_kml_file",
    "obfuscate_kml_files",
    "rename_charterware_files",
    "rename_dated_files",
]

# An optional namespace prefix of an element name ("kml:when")
_PREFIX = r"(?:[\w.-]+:)?"

# gx:Track/TimeStamp <when> and TimeSpan <begin>/<end>, plain or in CDATA,
# and with a comment or a processing instruction inside, which the parser
# drops as well
TIMESTAMP_PATTERN = re.compile(
    r"(<(" + _PREFIX + r"(?:when|begin|end))\b[^>]*>)"
    r"((?:<!\[CDATA\[.*?\]\]>|<!--(?s:.*?)-->|<\?(?s:.*?)\?>|[^<])*)(</\2\s*>)"
)
CDATA_PATTERN = re.compile(r"^\s*<!\[CDATA\[(.*?)\]\]>\s*$", re.DOTALL)
# Comments and processing instructions, which the parser drops
COMMENT_PATTERN = re.compile(r"<!--.*?-->|<\?.*?\?>", re.DOTALL)
# The marks around a CDATA section, and a section that stands in the middle
# of a text rather than around all of it ("16.<![CDATA[08]]>.2026"): the
# text a reader sees runs across it
CDATA_MARK_PATTERN = re.compile(r"<!\[CDATA\[|\]\]>")
_SPLIT_CDATA = re.compile(r"[^>\s]<!\[CDATA\[|\]\]>[^<\s]")
# The declaration a document starts with, the one processing instruction
# every KML file has
XML_DECLARATION_PATTERN = re.compile(r"\A\ufeff?\s*<\?xml\b.*?\?>", re.DOTALL)
# ISO 8601 writes a fraction of a second with a dot or a comma, and Python
# reads both ("09:12:00,5Z")
FRACTION_PATTERN = re.compile(r"[.,](\d+)")
UTC_OFFSET_PATTERN = re.compile(r"[+-]\d{2}:?\d{2}$")
# Valid KML timestamps without a time: xsd:date and xsd:gYearMonth
DATE_ONLY_PATTERN = re.compile(r"(\d{4})-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?")
YEAR_MONTH_PATTERN = re.compile(r"(\d{4})-(\d{2})(Z|[+-]\d{2}:\d{2})?")
# xsd:gYear: a year alone gives nothing away the export does not keep
YEAR_ONLY_PATTERN = re.compile(r"\d{4}(?:Z|[+-]\d{2}:\d{2})?")

# SkyDemon marker: "Takeoff: 03 Mar 2025 08:31 Z", with or without seconds
_MARKER_DATE_RE = r"(Log Start|Takeoff|Landing|Log Stop):\s*\d{1,2}\s+\w{3}\s+"
_MARKER_TIME_RE = r"\d{2}:\d{2}(?::\d{2})?\s+Z"
NAME_DATE_PATTERN = re.compile(
    r"(<("
    + _PREFIX
    + r"name)\b[^>]*>)\s*"
    + _MARKER_DATE_RE
    + r"(\d{4})\s+"
    + _MARKER_TIME_RE
    + r"\s*(</\2\s*>)"
)
CHECK_NAME_DATE_PATTERN = re.compile(_MARKER_DATE_RE + r"\d{4}\s+" + _MARKER_TIME_RE)

# Route name with date: "<name>EDDS to EDDP - 16 Aug 2026</name>", or in the
# ISO form the parser reads too ("EDDS to EDDP - 2026-08-16", see
# helpers.DATE_PATTERN)
ROUTE_DATE_PATTERN = re.compile(
    r"(?P<head><(?P<tag>" + _PREFIX + r"name)\b[^>]*>[^<]*?\s-\s)"
    r"(?:(?P<day>\d{1,2})\s+(?P<month>[A-Za-z]{3})\s+(?P<year>\d{4})"
    r"|(?P<iso_year>\d{4})-(?P<iso_month>\d{2})-(?P<iso_day>\d{2}))"
    r"(?P<tail>\s*</(?P=tag)\s*>)"
)
# A date in a name that the parser reads the year of a flight from: what
# helpers.DATE_PATTERN matches ("EDDS 16 Aug 2026", "16 Mai 2026", "6 Aug
# 2026", "2026-08-16"). The same two shapes (TestProperties checks that each
# date DATE_PATTERN finds is one of them), but without its lookbehind, so it
# matches after a digit too ("116 Aug 2026")
NAME_YEAR_DATE_PATTERN = re.compile(
    r"(?P<day>\d{1,2})\s+(?P<month>\w{3})\s+(?P<year>\d{4})|(?P<iso_year>\d{4})-\d{2}-\d{2}"
)
# The elements of KML whose text is free text, which the rewrite scrubs: a
# name and a description, a Snippet (snippet in KML 2.0), an address and a
# phone number, the value and the displayName of a Data, a SimpleData, the
# text of a BalloonStyle, and the linkName, linkDescription, linkSnippet and
# message of a NetworkLinkControl. Not the gx:value of a gx:SimpleArrayData,
# which holds a number for each point of a track as the coordinates do.
_FREE_TEXT_ELEMENTS = (
    "name",
    "description",
    "Snippet",
    "snippet",
    "address",
    "phoneNumber",
    "value",
    "displayName",
    "SimpleData",
    "text",
    "linkName",
    "linkDescription",
    "linkSnippet",
    "message",
)
_FREE_TEXT_TAG = (
    r"(?!gx:)" + _PREFIX + r"(" + "|".join(_FREE_TEXT_ELEMENTS) + r")(?![\w.:-])"
)
_FREE_TEXT_TAG_PATTERN = re.compile(_FREE_TEXT_TAG)
# What an element holds when it has no element inside: its text, plain, in
# CDATA or with a comment or a processing instruction inside, which a reader
# drops
_ELEMENT_BODY = r"((?:<!\[CDATA\[(?s:.*?)\]\]>|<!--(?s:.*?)-->|<\?(?s:.*?)\?>|[^<])*)"
# A free-text element (_FREE_TEXT_ELEMENTS): its start tag, its name, the
# name without the prefix, its text and its end tag
TEXT_ELEMENT_PATTERN = re.compile(
    r"(<(" + _FREE_TEXT_TAG + r")\b[^>]*>)" + _ELEMENT_BODY + r"(</\2\s*>)"
)
# Any element with text and no element inside, for the check's scan of the
# parts of dates: its name and its text. A quoted attribute value may hold a
# ">"; a start tag that closes itself has no text.
_LEAF_ELEMENT_PATTERN = re.compile(
    r"<(?P<tag>" + _PREFIX + r"[A-Za-z_][\w.-]*)"
    r"""(?:\s(?:[^<>"']|"[^"<]*"|'[^'<]*')*)?(?<!/)>"""
    + _ELEMENT_BODY
    + r"</(?P=tag)\s*>"
)
# A number and nothing else: in an element other than a name or a
# description, a decimal ("16.8", "12.10") is the speed of a point or the
# heading of a view rather than a day and a month
_PLAIN_NUMBER = re.compile(r"\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)\s*")
TEXT_PART_PATTERN = re.compile(
    r"<!\[CDATA\[(?P<cdata>(?s:.*?))\]\]>|<!--(?s:.*?)-->|<\?(?s:.*?)\?>|(?P<text>[^<]+)"
)
# Either quote: creator="SkyDemon" or creator='SkyDemon'
CREATOR_PATTERN = re.compile(r"""(\screator=(?P<quote>["']))(.*?)((?P=quote))""")
GENERIC_CREATOR = "flown"

# Charterware file name: YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE (see aircraft.py)
CHARTERWARE_NAME_PATTERN = re.compile(
    r"(?P<year>\d{4})-(?P<month>\d{2})-(?P<day>\d{2})"
    r"_(?P<hour>[01]\d|2[0-3])(?P<minute>[0-5]\d)h_(?P<rest>.+)"
)
MINUTES_PER_DAY = 24 * 60

# The temp file of _write_atomic (cache.atomic_write): ".<name>.kml.XXXXXXXX.tmp"
TEMP_FILE_PATTERN = re.compile(r"^\..*\.kml\.[^.]+\.tmp$", re.IGNORECASE)

# Timestamps further apart than this belong to different flights, unless they
# are in the same track (see _timestamp_groups)
FLIGHT_GAP = timedelta(hours=12)
# Closer than this, a timestamp outside every track joins the flight before it
# even across New Year
CONTINUOUS_GAP = timedelta(hours=2)

# Coordinate lists: most of a track's text, and numbers only, with the
# indent before each, which the catch-all scan skips as well. The indent
# starts where the blank run does, or a long run that leads to no such tag
# would be scanned again from each of its characters.
COORDINATES_PATTERN = re.compile(
    r"(?<!\s)\s*<(" + _PREFIX + r"(?:coordinates|coord))\b[^>]*>[^<]*</\1\s*>"
)

# A timestamp in the form the rewrite writes, on one of the days a flight
# moved to January 1st runs into: nothing in it fails the catch-all scan
# for dates (it passes those days) or for times of day (which leaves the
# timestamps out), and a track is little else once its coordinates are out,
# so the scan skips them, with the indent before each. _timestamp_violations
# checks them all. The indent from the start of its run, as above.
CANONICAL_TIMESTAMP_PATTERN = re.compile(
    r"(?<!\s)\s*<("
    + _PREFIX
    + r"(?:when|begin|end))>\d{4}-01-0[1-"
    + str(1 + MAX_DAYS_AFTER_JAN_1)
    + r"]T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?Z</\1>"
)

PLACEMARK_PATTERN = re.compile(r"<(" + _PREFIX + r"Placemark)\b.*?</\1\s*>", re.DOTALL)
# What the parser makes one path of: a gx:MultiTrack, else a gx:Track (see
# parser_gx_track._flights)
MULTI_TRACK_PATTERN = re.compile(
    r"<(" + _PREFIX + r"MultiTrack)\b.*?</\1\s*>", re.DOTALL
)
TRACK_PATTERN = re.compile(r"<(" + _PREFIX + r"Track)\b.*?</\1\s*>", re.DOTALL)
# A point marker: a Placemark with a Point and no path, whose TimeStamp is no
# track but joins the flight it belongs to (see _timestamp_groups)
POINT_PATTERN = re.compile(r"<" + _PREFIX + r"Point\b")
PATH_GEOMETRY_PATTERN = re.compile(
    r"<" + _PREFIX + r"(?:LineString|Track|MultiTrack)\b"
)


def _timestamp_text(raw: str) -> str:
    """The timestamp of a <when> element in the form the rewrite emits.

    A comment or a processing instruction is dropped and a CDATA section
    unwrapped, a space between date and time becomes the "T" and a
    lowercase "z" the "Z"; anything else is left as it is.
    """
    has_markup = "<!--" in raw or "<?" in raw
    text = COMMENT_PATTERN.sub("", raw).strip() if has_markup else raw.strip()
    cdata = CDATA_PATTERN.match(text)
    if cdata:
        text = cdata.group(1).strip()
    # "2024-03-14 09:12:00" and a lowercase "z" are read by the parsers of
    # some tools, so they are read here too (the same rule as the parser's);
    # the rewrite emits the canonical form
    return normalize_timestamp_text(text)


def _parse_full_timestamp(ts_str: str) -> datetime | None:
    """Parse an ISO timestamp as an aware UTC datetime (naive values are UTC)."""
    dt = parse_iso_timestamp(ts_str)
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt.astimezone(UTC)


def _extract_frac(ts_str: str) -> str:
    """The fraction of a second of a timestamp ('.5848380'), '' without one.

    With a dot, the way the rewrite writes it, also when the timestamp had
    a comma: dropping that fraction changed the intervals of the flight.
    """
    match = FRACTION_PATTERN.search(ts_str)
    return f".{match.group(1)}" if match else ""


def _format_timestamp(dt: datetime, frac: str = "") -> str:
    """Format a UTC datetime back to KML timestamp format."""
    return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}{frac}Z"


def _format_description_date(prefix: str, dt: datetime, long_month: bool) -> str:
    month = MONTHS_LONG[dt.month - 1] if long_month else MONTHS_SHORT[dt.month - 1]
    hour12 = dt.hour % 12 or 12
    meridiem = "AM" if dt.hour < 12 else "PM"
    return (
        f"{prefix}{month} {dt.day:02d} {dt.year} {hour12:02d}:{dt.minute:02d}{meridiem}"
    )


def _parse_route_date(match: re.Match[str]) -> datetime | None:
    """Parse a route name date match ("16 Aug 2026", "2026-08-16") in UTC."""
    if match["iso_year"] is not None:
        year, day = int(match["iso_year"]), int(match["iso_day"])
        month: int | None = int(match["iso_month"])
    else:
        year, day = int(match["year"]), int(match["day"])
        month = month_number(match["month"])
    if month is None:
        return None
    try:
        return datetime(year, month, day, tzinfo=UTC)
    except ValueError:
        return None


def _is_jan_first(dt: datetime | None) -> bool:
    return dt is not None and dt.month == 1 and dt.day == 1


def _is_canonical_start(dt: datetime | None) -> bool:
    """Whether a time is midnight on January 1st, the start of every flight.

    A fraction of a second may follow: the shift is one of whole seconds, so
    that every timestamp keeps the fraction it was written with.
    """
    return (
        dt is not None
        and _is_jan_first(dt)
        and dt.time().replace(microsecond=0) == time()
    )


def _timestamp_groups(
    timestamps: Iterable[datetime], tracks: Iterable[Iterable[datetime]]
) -> list[list[datetime]]:
    """Group timestamps into flights, each sorted, in the order of their start.

    A track is one piece of a flight however long it runs, and so is each
    timestamp outside one. A track is what the parser makes a path of, and
    gives the year of its start: a gx:Track, the tracks of a gx:MultiTrack
    together, and a Placemark for the timestamps of no track in it (the
    TimeSpan of a LineString); a point marker's TimeStamp (a Placemark with
    a Point and no path) is outside every track. Pieces in time order join
    the flight before them when they overlap it, or when they follow it
    within ``FLIGHT_GAP`` in the same UTC year: a track that starts on
    January 1st must not move into the year of the flight that ended the
    night before, since the parser keeps it in its own. Only a timestamp
    outside every track joins within ``CONTINUOUS_GAP`` across New Year too:
    no path takes its year from it. A flight is never split: one that runs
    past the days after January 1st keeps its intervals and fails the check
    instead of running backwards in time.

    A timestamp of a track more than ``MAX_TIMESTAMP_DISTANCE_SECONDS`` from
    the median of the track is a clock error, as the parser has it (a
    logger's clock at its default date until the GPS fix): it is a piece of
    its own, so it neither holds the flight back from moving nor stays
    behind with a date of its own.
    """
    pieces: list[list[datetime]] = []
    for track in tracks:
        piece = sorted(set(track))
        if not piece:
            continue
        median = piece[len(piece) // 2]
        limit = timedelta(seconds=MAX_TIMESTAMP_DISTANCE_SECONDS)
        pieces.append([dt for dt in piece if abs(dt - median) <= limit])
        pieces.extend([dt] for dt in piece if abs(dt - median) > limit)
    in_track = {dt for piece in pieces for dt in piece}
    loose = set(timestamps) - in_track
    pieces.extend([dt] for dt in loose)
    pieces.sort()

    groups: list[list[datetime]] = []
    group_end: datetime | None = None
    for piece in pieces:
        start = piece[0]
        if group_end is not None and (
            start <= group_end
            or (start - group_end <= FLIGHT_GAP and start.year == groups[-1][0].year)
            or (start in loose and start - group_end <= CONTINUOUS_GAP)
        ):
            groups[-1].extend(piece)
            group_end = max(group_end, piece[-1])
        else:
            groups.append(list(piece))
            group_end = piece[-1]
    return [sorted(set(group)) for group in groups]


def _timestamp_offsets(groups: list[list[datetime]]) -> dict[datetime, timedelta]:
    """Map every timestamp to the shift that starts its flight at midnight.

    The start of a flight moves to 00:00:00 on January 1st of its year, and
    the rest of the flight moves with it, so the flight keeps its intervals
    and its year and gives neither its date nor its time of day away. The
    shift is one of whole seconds (see ``_is_canonical_start``). A second
    pass finds every flight at midnight on January 1st already: the flights
    of one file may overlap in time then, and every one they form together
    still starts at midnight.
    """
    offsets: dict[datetime, timedelta] = {}
    for group in groups:
        start = group[0]
        offset = start.replace(month=1, day=1, hour=0, minute=0, second=0) - start
        for dt in group:
            offsets[dt] = offset
    return offsets


def _date_only_on_jan_first(text: str) -> str | None:
    """Move a date-only timestamp to January of its year (None if it is none)."""
    match = DATE_ONLY_PATTERN.fullmatch(text)
    if match:
        return f"{match.group(1)}-01-01{match.group(2) or ''}"
    match = YEAR_MONTH_PATTERN.fullmatch(text)
    if match:
        return f"{match.group(1)}-01{match.group(3) or ''}"
    return None


class _Timestamps(NamedTuple):
    """What one pass over the timestamp elements of a document found."""

    # Every full timestamp in UTC, with the text it first appeared as
    first_text: dict[datetime, str]
    # The flights the timestamps form (see _timestamp_groups)
    groups: list[list[datetime]]
    # A full timestamp with a UTC offset other than Z: its local date may not
    # be the UTC date that the check expects, so it is rewritten even unshifted
    has_utc_offset: bool
    # Date-only timestamps that are not on January 1st
    dates_to_move: list[str]
    # A timestamp not written the way the rewrite writes it (CDATA, a space
    # instead of the "T"): rewritten so the parsers read it like the check
    has_loose_text: bool
    # Timestamps neither a full one nor a date: the rewrite cannot move them
    # ("1710406320", "14.03.2024 09:12"), so they would keep what they hold
    not_understood: list[str]


def _is_point_marker(placemark: str) -> bool:
    """Whether a Placemark is a point marker (a Point and no path)."""
    return (
        POINT_PATTERN.search(placemark) is not None
        and PATH_GEOMETRY_PATTERN.search(placemark) is None
    )


class _Spans:
    """The spans of the matches of an element, to find the one at a position."""

    def __init__(self, matches: Iterable[re.Match[str]]) -> None:
        self.spans = [match.span() for match in matches]
        self.starts = [start for start, _ in self.spans]

    def holding(self, position: int) -> int | None:
        """The index of the span that holds ``position``, None for none."""
        index = bisect_right(self.starts, position) - 1
        if index >= 0 and position < self.spans[index][1]:
            return index
        return None


def _scan_timestamps(content: str) -> _Timestamps:
    first_text: dict[datetime, str] = {}
    has_utc_offset = False
    has_loose_text = False
    dates_to_move: list[str] = []
    not_understood: list[str] = []
    # The innermost of a gx:MultiTrack, a gx:Track and a Placemark that is no
    # point marker holds the timestamp's track (see _timestamp_groups)
    containers = [
        _Spans(MULTI_TRACK_PATTERN.finditer(content)),
        _Spans(TRACK_PATTERN.finditer(content)),
        _Spans(
            match
            for match in PLACEMARK_PATTERN.finditer(content)
            if not _is_point_marker(match.group(0))
        ),
    ]
    tracks: dict[tuple[int, int], list[datetime]] = {}
    for match in TIMESTAMP_PATTERN.finditer(content):
        text = _timestamp_text(match.group(3))
        if text != match.group(3):
            has_loose_text = True
        dt = _parse_full_timestamp(text)
        if dt is not None:
            first_text.setdefault(dt, text)
            if not has_utc_offset:
                has_utc_offset = UTC_OFFSET_PATTERN.search(text) is not None
            for kind, spans in enumerate(containers):
                index = spans.holding(match.start())
                if index is not None:
                    tracks.setdefault((kind, index), []).append(dt)
                    break
        elif (moved := _date_only_on_jan_first(text)) is not None:
            if moved != text:
                dates_to_move.append(text)
        elif text and not YEAR_ONLY_PATTERN.fullmatch(text):
            not_understood.append(text)
    groups = _timestamp_groups(first_text, tracks.values())
    return _Timestamps(
        first_text,
        groups,
        has_utc_offset,
        dates_to_move,
        has_loose_text,
        not_understood,
    )


def _real_creators(content: str) -> list[str]:
    """The creator attributes that still name the recording device.

    Every one: a Document may name the device behind a kml element that
    names this tool.
    """
    return list(
        dict.fromkeys(
            match.group(3)
            for match in CREATOR_PATTERN.finditer(content)
            if match.group(3) != GENERIC_CREATOR
        )
    )


def _element_text(raw: str) -> str:
    """What a reader sees of an element: no comments, CDATA unwrapped."""
    return "".join(
        match["cdata"] if match["cdata"] is not None else html.unescape(match["text"])
        for match in TEXT_PART_PATTERN.finditer(raw)
        if match["cdata"] is not None or match["text"] is not None
    )


def _without_charterware_dates(text: str) -> str:
    """A description with its Charterware date blanked, which the rewrite moves."""
    return CHARTERWARE_DATE_PATTERN.sub(lambda match: " " * len(match[0]), text)


def _name_date_on_jan_first(match: re.Match[str]) -> str:
    """A date of a name the parser reads, moved to January 1st of its year.

    The parser takes nothing but the year of it, so a day that does not
    exist moves as well. A word that is no month name stays, and so does
    its date: the check reports it, if it is one.
    """
    if match["iso_year"] is not None:
        return f"{match['iso_year']}-01-01"
    if any_month_number(match["month"]) is None:
        return match.group(0)
    return f"01 Jan {match['year']}"


def _until_unchanged(step: Callable[[str], str], text: str) -> str:
    """``text`` after ``step``, applied again until it changes nothing.

    What one pass leaves may read as a date of its own, or stand next to
    one now ("Sat Sat 16 Aug" once the first "Sat" is gone), so a single
    pass, or any fixed number of them, can leave something the check
    reports. A pass that changes the text takes something out of it, but
    for the first one, which may move a date to January 1st and lengthen it
    by a digit ("6 Aug 2026" is "01 Jan 2026"), so the passes end.
    """
    for _ in range(2 * len(text) + 2):
        again = step(text)
        if again == text:
            break
        text = again
    return text


def _scrubbed_once(kind: str, text: str) -> str:
    if kind == "name":
        text = NAME_YEAR_DATE_PATTERN.sub(_name_date_on_jan_first, text)
    scanned = _without_charterware_dates(text)
    return without_spans(text, stray_date_spans(scanned) + epoch_spans(scanned))


def _scrubbed_text(kind: str, text: str) -> str:
    """A free-text element without what gives the day of a flight away.

    A date of a name that the parser reads the year from moves to January
    1st (the route names of SkyDemon, "EDDS to EDDP - 16 Aug 2026"), and
    the rest goes: ``date_tokens.stray_date_spans`` and the Unix times,
    until nothing of them is left (see ``_until_unchanged``). The
    Charterware date of a description, which the rewrite has moved already,
    stays.
    """
    return _until_unchanged(lambda current: _scrubbed_once(kind, current), text)


def _is_number(kind: str, text: str) -> bool:
    """Whether the text of an element of ``kind`` is a number and no text.

    A number in a name or a description is text a person wrote, which
    loses what reads as a date ("16.8"). In any other element it is a
    number (the speed of a point, the heading of a view), which the rewrite
    leaves alone and the check's scan for parts of dates passes.
    """
    return kind not in ("name", "description") and bool(_PLAIN_NUMBER.fullmatch(text))


def _scrub_text_element(match: re.Match[str]) -> str:
    """A free-text element, scrubbed, in CDATA again where it was."""
    raw = match.group(4)
    text = _element_text(raw)
    if _is_number(match.group(3), text):
        return match.group(0)
    scrubbed = _scrubbed_text(match.group(3), text)
    if scrubbed == text:
        return match.group(0)
    if "<![CDATA[" in raw and "]]>" not in scrubbed:
        body = f"<![CDATA[{scrubbed}]]>"
    else:
        body = html.escape(scrubbed, quote=False)
    return f"{match.group(1)}{body}{match.group(5)}"


def obfuscate_kml_content(content: str) -> str | None:
    """Obfuscate dates and timestamps in KML content.

    Returns the obfuscated content, or None if nothing had to change (the
    content is already obfuscated or holds no date).
    """
    timestamps = _scan_timestamps(content)
    offsets = _timestamp_offsets(timestamps.groups)

    def shift_timestamp(match: re.Match[str]) -> str:
        ts_str = _timestamp_text(match.group(3))
        dt = _parse_full_timestamp(ts_str)
        if dt is not None:
            shifted = _format_timestamp(dt + offsets[dt], _extract_frac(ts_str))
        else:
            date_only = _date_only_on_jan_first(ts_str)
            if date_only is None:
                return match.group(0)
            shifted = date_only
        return f"{match.group(1)}{shifted}{match.group(4)}"

    def marker_on_jan_first(match: re.Match[str]) -> str:
        opening, _, label, year, closing = match.groups()
        return f"{opening}{label}: {year}-01-01{closing}"

    # Route and description dates are local dates, not UTC like the
    # timestamps, so they move to January 1st of their own year directly.
    # Shifting them with a timestamp offset could leave them on January 2nd.
    # The time of a description goes to midnight, like the start of a flight.
    def description_on_jan_first(match: re.Match[str]) -> str:
        dt = charterware_datetime(match)
        if dt is None:
            return match.group(0)
        long_month = len(match.group(2)) > 3
        return _format_description_date(
            match.group(1), dt.replace(month=1, day=1, hour=0, minute=0), long_month
        )

    def replace_creator(match: re.Match[str]) -> str:
        return f"{match.group(1)}{GENERIC_CREATOR}{match.group(4)}"

    # Rewriting every timestamp of an obfuscated file only reproduces it, and
    # the CLI checks all inputs on every run
    new_content = content
    if (
        timestamps.has_utc_offset
        or timestamps.has_loose_text
        or timestamps.dates_to_move
        or any(offsets.values())
    ):
        new_content = TIMESTAMP_PATTERN.sub(shift_timestamp, content)
    new_content = NAME_DATE_PATTERN.sub(marker_on_jan_first, new_content)
    new_content = CHARTERWARE_DATE_PATTERN.sub(description_on_jan_first, new_content)
    new_content = TEXT_ELEMENT_PATTERN.sub(_scrub_text_element, new_content)
    new_content = CREATOR_PATTERN.sub(replace_creator, new_content)

    return new_content if new_content != content else None


def _write_atomic(filepath: Path, content: str) -> bool:
    """Write content via a temp file in the same directory and os.replace.

    The file being replaced is the user's only copy of the flight, so the data
    is flushed to disk before the rename and the directory entry after it: a
    crash in between leaves either the old file or the complete new one. Line
    endings are written as they were read, and the file keeps its mode.
    """
    try:
        atomic_write(
            filepath,
            lambda tmp: tmp.write(content),
            newline="",
            durable=True,
            keep_mode=True,
        )
    except OSError as e:
        logger.warning("Skipping %s: failed to write (%s)", filepath, e)
        return False
    return True


KMZ_REFUSAL = (
    "the obfuscator cannot check or rewrite the dates inside a zip archive; "
    "unzip it and keep the .kml file instead"
)


def _is_kmz(filepath: Path) -> bool:
    return filepath.suffix.lower() == ".kmz"


def obfuscate_kml_file(filepath: Path) -> bool:
    """Obfuscate a KML file in place.

    Returns True if the file was modified, False otherwise. A symlink is
    skipped like the generator skips it, and a file the user may not write is
    reported instead of being replaced behind its read-only mode.
    """
    if filepath.is_symlink():
        logger.warning("Skipping %s: symlinks are not allowed", filepath)
        return False
    if _is_kmz(filepath):
        # Rewriting a member of a zip archive in place is not worth the risk
        # of a broken archive; the check keeps failing until it is unzipped
        logger.error("Cannot obfuscate %s: %s", filepath, KMZ_REFUSAL)
        return False

    try:
        # newline="" keeps CRLF line endings as they are
        with open(filepath, encoding="utf-8", newline="") as f:
            content = f.read()
    except UnicodeDecodeError:
        logger.warning("Skipping %s: not valid UTF-8", filepath)
        return False
    except OSError as e:
        logger.warning("Skipping %s: cannot read file (%s)", filepath, e)
        return False

    new_content = obfuscate_kml_content(content)
    if new_content is None:
        return False

    if not os.access(filepath, os.W_OK):
        logger.error("Cannot obfuscate %s: the file is not writable", filepath)
        return False

    return _write_atomic(filepath, new_content)


def obfuscate_kml_files(filepaths: Iterable[Path]) -> int:
    """Obfuscate several files; a failure on one file does not stop the run."""
    modified = 0
    for filepath in filepaths:
        try:
            if obfuscate_kml_file(filepath):
                modified += 1
        except OSError as e:
            # Expected (a read-only or vanished file): no traceback needed
            logger.error("Failed to obfuscate %s: %s", filepath, e)
        # One file's failure must not stop the others from being scrubbed;
        # the check afterwards fails on the file that is left
        except Exception:  # noqa: BLE001
            logger.exception("Failed to obfuscate %s", filepath)
    return modified


def _charterware_name(path: Path) -> re.Match[str] | None:
    return CHARTERWARE_NAME_PATTERN.fullmatch(path.stem)


def _has_jan_first_date(match: re.Match[str]) -> bool:
    return match["month"] == "01" and match["day"] == "01"


def _used_charterware_slots(directory: Path, year: str) -> set[int]:
    """The sequence numbers of the January 1st Charterware names of a year."""
    try:
        entries = list(directory.iterdir())
    except OSError:
        return set()
    slots = set()
    for entry in entries:
        match = _charterware_name(entry)
        if match and match["year"] == year and _has_jan_first_date(match):
            slots.add(int(match["hour"]) * 60 + int(match["minute"]))
    return slots


def _free_charterware_slots(used: set[int]) -> Iterable[int]:
    """Free sequence numbers, after the highest used one first."""
    start = max(used) + 1 if used else 0
    for slot in (*range(start, MINUTES_PER_DAY), *range(start)):
        if slot not in used:
            yield slot


def _rename_exclusive(path: Path, target: Path) -> None:
    """Rename ``path`` to ``target`` unless ``target`` exists.

    os.rename replaces an existing file, so a run renaming into the same
    directory at the same time could overwrite a flight between a check and
    the rename. A hard link fails atomically instead.
    """
    if target.is_symlink():
        raise FileExistsError(target)
    try:
        os.link(path, target, follow_symlinks=False)
    except FileExistsError:
        raise
    except OSError:
        # No hard links on this file system (FAT, some network shares)
        if target.exists():
            raise FileExistsError(target) from None
        os.rename(path, target)
        return
    os.unlink(path)


def rename_charterware_files(filepaths: Iterable[Path]) -> list[Path]:
    """Move Charterware file names to January 1st without their time.

    ``2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml`` becomes
    ``2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml``. The time slot turns into a
    sequence number per directory and year, written as a time (0059h is
    followed by 0100h), so the names keep the format ``aircraft.py``
    recognizes and keep sorting in flight order: files are numbered in the
    order of their original names, after the highest number already in the
    directory. No existing file is ever replaced.

    Returns the given paths in their order, with the new path of every renamed
    file. A file that could not be renamed keeps its path and fails the check.
    """
    paths = list(filepaths)
    result = {path: path for path in paths}

    # The part after the time of every file to rename, by directory and year
    groups: dict[tuple[Path, str], dict[Path, str]] = {}
    for path in paths:
        # An archive is refused with its dates inside it: a new name would
        # only hide which file the refusal is about
        if _is_kmz(path):
            continue
        match = _charterware_name(path)
        if match is None or _has_jan_first_date(match) or path.is_symlink():
            continue
        groups.setdefault((path.parent, match["year"]), {})[path] = match["rest"]

    for (directory, year), rests in groups.items():
        free_slots = iter(
            _free_charterware_slots(_used_charterware_slots(directory, year))
        )
        for path in sorted(rests):
            target = None
            error: OSError | None = None
            for slot in free_slots:
                candidate = directory / (
                    f"{year}-01-01_{slot // 60:02d}{slot % 60:02d}h_"
                    f"{rests[path]}{path.suffix}"
                )
                try:
                    _rename_exclusive(path, candidate)
                except FileExistsError:
                    continue
                except OSError as e:
                    error = e
                    break
                target = candidate
                break
            if target is None:
                logger.error(
                    "Cannot rename %s: %s",
                    path,
                    error or f"no free January 1st name left for {year}",
                )
                continue
            logger.info("Renamed %s to %s", path.name, target.name)
            result[path] = target

    return [result[path] for path in paths]


# What a file name is split into, which a removed date leaves doubled
_NAME_SEPARATORS = re.compile(r"([-_. ])[-_. ]+")


def _undated_once(stem: str) -> str:
    spans = sorted(stray_date_spans(stem) + epoch_spans(stem))
    if not spans:
        return stem
    kept = []
    position = 0
    for start, end in spans:
        kept.append(stem[position:start])
        position = max(position, end)
    kept.append(stem[position:])
    return _NAME_SEPARATORS.sub(r"\1", "".join(kept)).strip("-_. ")


def _undated_stem(stem: str) -> str | None:
    """A file name without what the check reports in it, None if unchanged.

    The dates, parts of dates, times of day, weekdays and holidays go with
    the separator they leave doubled ("1_DEHYL_DA40_16Aug" is
    "1_DEHYL_DA40"), until nothing of them is left (see
    ``_until_unchanged``): "EDDS Sat 14:30 16 Aug 2026" loses the "Sat" as
    well.
    """
    undated = _until_unchanged(_undated_once, stem)
    return None if undated == stem else undated


def _aircraft_of(name: str) -> tuple[str | None, str | None]:
    """The registration and type a file name gives, without its warnings."""
    disabled = logger.disabled
    logger.disabled = True
    try:
        info = parse_aircraft_from_filename(name)
    finally:
        logger.disabled = disabled
    return (info.registration, info.type) if info else (None, None)


def rename_dated_files(filepaths: Iterable[Path]) -> list[Path]:
    """Take the dates out of the names of KML files.

    Charterware names move to January 1st (``rename_charterware_files``);
    any other name, and the part of a Charterware name after its time slot,
    loses its dates, parts of dates, times of day and weekdays (see
    ``_undated_stem``). No existing file is ever replaced: a
    name that would be taken, one with nothing left and one whose aircraft
    would change stay and fail the check, to be renamed by hand.

    Returns the given paths in their order, with the new path of every
    renamed file.
    """
    result = []
    for path in rename_charterware_files(filepaths):
        stem = None
        if not _is_kmz(path) and not path.is_symlink():
            charterware = _charterware_name(path)
            if charterware is None:
                stem = _undated_stem(path.stem)
            elif (rest := _undated_stem(charterware["rest"])) is not None:
                # The date and time slot of a renamed Charterware name stay
                head = path.stem[: charterware.start("rest")]
                stem = head + rest if rest else None
        if stem is None:
            result.append(path)
            continue
        if not any(char.isalnum() for char in stem):
            logger.error("Cannot rename %s: nothing is left without its dates", path)
            result.append(path)
            continue
        target = path.with_name(stem + path.suffix)
        if _aircraft_of(target.name) != _aircraft_of(path.name):
            logger.error(
                "Cannot rename %s to %s: the aircraft it names would change",
                path,
                target.name,
            )
            result.append(path)
            continue
        try:
            _rename_exclusive(path, target)
        except OSError as e:
            logger.error("Cannot rename %s: %s", path, e)
            result.append(path)
            continue
        logger.info("Renamed %s to %s", path.name, target.name)
        result.append(target)
    return result


def _list_kml_files(directory: Path) -> KmlListing:
    """The KML files of a directory tree, the ones the generator reads.

    With the directories that could not be listed. The generator
    (``cli._collect_kml_files``) and this module share
    ``validation.list_kml_files``, so they agree on the extension (``.kml``
    and ``.KML`` alike) and on the subdirectories: a file in a subfolder of
    the data directory is checked like the generator publishes it. Symlinks
    are skipped with a warning, as the generator refuses them: rewriting one
    would replace the link with a regular file and leave the dates in its
    target.
    """
    listing = list_kml_files(directory)
    kml_files = []
    for path in listing.files:
        if path.is_symlink():
            logger.warning("Skipping %s: symlinks are not allowed", path)
        else:
            kml_files.append(path)
    return KmlListing(kml_files, listing.unlisted)


def _leftover_temp_files(directory: Path) -> list[Path]:
    """The temp files of rewrites that were killed before the rename.

    They hold the complete un-obfuscated file, with a name the KML listing
    ignores, so the check names them instead of certifying the directory.
    """
    leftovers: list[Path] = []
    for root, dirs, files in os.walk(directory):
        dirs[:] = sorted(d for d in dirs if not (Path(root) / d).is_symlink())
        leftovers.extend(
            Path(root) / name for name in sorted(files) if TEMP_FILE_PATTERN.match(name)
        )
    return leftovers


def _obfuscate_listed_files(kml_files: list[Path]) -> int:
    renamed = rename_dated_files(kml_files)
    modified = 0
    for original, path in zip(kml_files, renamed, strict=True):
        if obfuscate_kml_files([path]) or path != original:
            modified += 1
    return modified


# Date shapes that may appear anywhere in a document written by another tool
# are those of date_tokens, plus Unix time (``date_tokens.EPOCH_PATTERN``)
# anywhere in the text but the coordinates, which the check leaves out first.
# A start or end tag with its attributes. Attribute values are ids and
# references (a 13-digit style id), and the dates in them are checked by the
# date patterns, so the Unix time scan reads the text between the tags only.
# A quoted value may hold a ">".
_TAG_PATTERN = re.compile(
    r"""</?[A-Za-z_][^<>"']*(?:(?:"[^"]*"|'[^']*')[^<>"']*)*/?>"""
)
# The numbers of a view or an extent (a LookAt 1234567890 m away): distances,
# angles and positions, never a time
_VIEW_NUMBER_PATTERN = re.compile(
    r"<("
    + _PREFIX
    + r"(?:range|altitude|heading|tilt|roll|longitude|latitude|north|south|east"
    r"|west|rotation|minAltitude|maxAltitude))\b[^>]*>[^<]*</\1\s*>"
)
# The elements of KML 2.2 whose text is a reference (an anyURI): a style
# ("#1712345678901" or "styles.kml#1712345678901"), a link, an Update's
# target and a Model's texture. The fragment after "#" names an id, which
# the attribute strip already lets pass where it is declared and which the
# obfuscator cannot rewrite either, so the scan drops it here as well. The
# path before it is still read. targetId and schemaUrl are attributes in
# KML 2.2, so the tag strip covers them.
_REFERENCE_PATTERN = re.compile(
    r"<(" + _PREFIX + r"(?:styleUrl|href|targetHref|sourceHref))\b[^>]*>([^<]*)</\1\s*>"
)


def _with_markup_dropped(content: str) -> str:
    """The content, and after it again without comments, PIs and CDATA marks.

    A reader, the parser among them, sees the text of an element without
    them: "16<!-- -->.08.2026" reads as 16.08.2026, and so does
    "16.<![CDATA[08]]>.2026", which the patterns only find once the comment
    or the CDATA marks are out. The content itself stays, since a comment
    holds dates as well. A document whose only processing instruction is
    the XML declaration, and whose CDATA sections only wrap whole element
    texts, is scanned once.
    """
    body = XML_DECLARATION_PATTERN.sub("", content, count=1)
    if "<!--" not in body and "<?" not in body and not _SPLIT_CDATA.search(body):
        return content
    return content + "\n" + CDATA_MARK_PATTERN.sub("", COMMENT_PATTERN.sub("", body))


def _with_unescaped(content: str) -> str:
    if "&#" in content:
        # A parser reads "2024&#45;03&#45;14" as a date as well
        return content + "\n" + html.unescape(content)
    return content


def _epoch_text(content: str) -> str:
    """The text of ``content`` the Unix time scan reads.

    Without the tags and their attributes, both those of the document and
    those of an escaped HTML description, without the numbers of a view and
    without the id a reference points to.
    """
    text = _REFERENCE_PATTERN.sub(
        lambda match: " " + html.unescape(match.group(2)).partition("#")[0] + " ",
        _VIEW_NUMBER_PATTERN.sub(" ", content),
    )
    text = _TAG_PATTERN.sub(" ", text)
    if "&" in text:
        text = _TAG_PATTERN.sub(" ", html.unescape(text))
    return text


def _find_stray_epochs(content: str) -> list[str]:
    """The Unix times of past flights that are not midnight near January 1st.

    Anywhere in the text of ``content``: the caller strips the coordinates,
    whose digits are no times.
    """
    return [
        match.group(1)
        for match in EPOCH_PATTERN.finditer(_epoch_text(content))
        if not epoch_is_obfuscated(match.group(1))
    ]


def _stray_dates_of(unescaped: str, epochs: list[str]) -> list[str]:
    """The stray dates of content that ``_with_unescaped`` has prepared.

    ``epochs`` are its stray Unix times, which the caller has already
    scanned for: the scan strips the tags twice and is the slow part.
    """
    return find_date_tokens(unescaped, skip_near_jan_first=True) + epochs


def _find_stray_dates(content: str) -> list[str]:
    """Return date-like tokens that are not within the days after January 1st."""
    unescaped = _with_unescaped(content)
    return _stray_dates_of(unescaped, _find_stray_epochs(unescaped))


def _find_stray_times(content: str, stray_dates: list[str]) -> list[str]:
    """The times of day in the text of a document ("Flight 14:30").

    The rewrite takes them out of the free-text elements
    (``TEXT_ELEMENT_PATTERN``, ``stray_date_spans``); anywhere else they
    have to go by hand. The timestamps, which ``_timestamp_violations``
    checks, and the description dates of Charterware, which the rewrite
    puts at 12:00AM, are left out, and so are the dates already reported:
    the year of the next one in a list of dates ("2025-09-21 2025-09-22")
    would read as a time after it.
    """
    text = _with_unescaped(
        CHARTERWARE_DATE_PATTERN.sub("", TIMESTAMP_PATTERN.sub("", content))
    )
    for date in dict.fromkeys(stray_dates):
        text = text.replace(date, " ")
    return find_time_tokens(text)


def _timestamp_violations(content: str) -> list[str]:
    """Flights that do not start at midnight on January 1st, and dates.

    The rule of the rewrite: the first timestamp of every flight (see
    ``_timestamp_groups``) is 00:00:00 UTC on January 1st, give or take a
    fraction of a second. Any other start carries the date or the time of
    day of the flight.
    """
    timestamps = _scan_timestamps(content)
    violations = [
        (
            "Flight does not start at 00:00:00 on Jan 1: "
            f"{timestamps.first_text[group[0]]}"
        )
        for group in timestamps.groups
        if not _is_canonical_start(group[0])
    ]

    # Legs less than FLIGHT_GAP apart are one flight, which keeps its
    # intervals: one that runs for more days than the check lets pass has to
    # be split by hand
    violations.extend(
        (
            f"Flight runs over {(group[-1] - group[0]).days + 1} days, more "
            f"than the {MAX_DAYS_AFTER_JAN_1 + 1} from Jan 1 the check lets "
            "pass: split the file into one per day of flying"
        )
        for group in timestamps.groups
        if group[-1] - group[0] >= timedelta(days=MAX_DAYS_AFTER_JAN_1 + 1)
    )
    violations.extend(
        f"Timestamp not on Jan 1: {text}" for text in timestamps.dates_to_move
    )
    # Neither the parser nor the rewrite reads it, so it is left as it is:
    # a Unix time, or a local format, still holds the date and the time
    violations.extend(
        f"Timestamp not understood, remove or fix it: {text}"
        for text in timestamps.not_understood
    )
    return violations


def _partial_date_violations(scanned: str) -> list[str]:
    """The parts of dates in the text of a document, which its year completes.

    A day and month without the year and the like
    (``find_partial_date_tokens``), in the text of every element: the
    repository publishes all of the file, not only the names and the
    descriptions the site shows. Not in the coordinates and the canonical
    timestamps, which the caller has taken out (``scanned`` is the document
    without them), nor in the other timestamps, which the check reads on
    their own (``_timestamp_violations``), nor in a number alone outside a
    name or a description (``_is_number``), nor in the id after the "#" of
    a reference, which an attribute declares. What the rewrite scrubs (the
    free-text elements, ``TEXT_ELEMENT_PATTERN``) it fixes; anything else
    has to go by hand.
    """
    violations: list[str] = []
    for match in _LEAF_ELEMENT_PATTERN.finditer(scanned):
        tag = match["tag"]
        kind = tag.rpartition(":")[2]
        if kind in _TIMESTAMP_ELEMENTS:
            continue
        text = _without_charterware_dates(_element_text(match.group(2)))
        if _REFERENCE_PATTERN.fullmatch(match.group(0)):
            text = text.partition("#")[0]
        if _is_number(kind, text):
            continue
        if not _FREE_TEXT_TAG_PATTERN.fullmatch(tag):
            label = f"Element {tag} contains part of a date, remove it: "
        elif kind in ("name", "description"):
            label = "Name or description contains part of a date: "
        else:
            label = f"Element {tag} contains part of a date: "
        violations.extend(label + token for token in find_partial_date_tokens(text))
    # The text between the elements of one, which no reader shows as its own
    # but the file holds as well
    for match in _TEXT_BETWEEN_ELEMENTS.finditer(
        _LEAF_ELEMENT_PATTERN.sub(" ", scanned)
    ):
        violations.extend(
            f"Text contains part of a date, remove it: {token}"
            for token in find_partial_date_tokens(html.unescape(match.group(1)))
        )
    return violations


# The elements TIMESTAMP_PATTERN reads
_TIMESTAMP_ELEMENTS = frozenset(("when", "begin", "end"))
# The text after a tag, up to the next one
_TEXT_BETWEEN_ELEMENTS = re.compile(r">([^<]*[^<\s][^<]*)")


def check_kml(filepath: Path) -> tuple[list[str], list[str]]:
    """The violations of a KML file, and what may be a date for a person to
    look at, which fails nothing.

    The violations say what a file that is not properly obfuscated gives
    away; a clean file has none.

    A day, a word and a year in a language the patterns do not know
    (``find_possible_date_tokens``) is as often a count and a place ("Day 2
    Stuttgart 2026"): the rewrite leaves it, so refusing it would leave the
    file to be renamed by hand for nothing.
    """
    violations: list[str] = []
    warnings: list[str] = []
    if _is_kmz(filepath):
        # Its dates are inside a compressed member, which neither the
        # rewrite nor this check reads
        return [f"KMZ archive: {KMZ_REFUSAL}"], []
    try:
        content = filepath.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError) as e:
        # A file that cannot be read cannot be certified as obfuscated
        return [f"Cannot read file: {e}"], []

    # rename_charterware_files puts the date exactly on January 1st
    charterware_name = _charterware_name(filepath)
    if charterware_name and not _has_jan_first_date(charterware_name):
        violations.append(f"File name contains the flight date: {filepath.name}")
    else:
        violations.extend(
            f"File name contains a date: {text}"
            for text in _find_stray_dates(filepath.name)
        )
        violations.extend(
            f"File name contains a weekday: {text}"
            for text in find_weekday_tokens(filepath.name)
        )
        violations.extend(
            f"File name contains a holiday: {text}"
            for text in find_holiday_tokens(filepath.name)
        )
        # A name keeps no time of day either ("1_DEHYL_1513h"): the export
        # takes it out, but the file is public. The time slot of a renamed
        # Charterware name is its sequence number.
        stem = charterware_name["rest"] if charterware_name else filepath.stem
        violations.extend(
            f"File name contains a time of day: {text}"
            for text in find_time_tokens(stem)
        )
        violations.extend(
            f"File name contains part of a date: {text}"
            for text in find_partial_date_tokens(stem)
        )
        warnings.extend(
            f"File name may contain a date in another language: {text}"
            for text in find_possible_date_tokens(stem)
        )

    violations.extend(
        f"Name element contains date: {match.group(0)}"
        for match in CHECK_NAME_DATE_PATTERN.finditer(content)
    )

    violations.extend(_timestamp_violations(content))

    violations.extend(
        f"Description date not on Jan 1 at 12:00AM: {match.group(0)}"
        for match in CHARTERWARE_DATE_PATTERN.finditer(content)
        if not _is_canonical_start(charterware_datetime(match))
    )

    violations.extend(
        f"Route name date not on Jan 1: {match.group(0)}"
        for match in ROUTE_DATE_PATTERN.finditer(content)
        if not _is_jan_first(_parse_route_date(match))
    )

    violations.extend(
        f"Creator identifies the recording device: {creator}"
        for creator in _real_creators(content)
    )

    # Coordinates cannot hold a date the parser would accept, and skipping
    # them saves most of the time the patterns take on a track
    scanned = CANONICAL_TIMESTAMP_PATTERN.sub("", COORDINATES_PATTERN.sub("", content))
    violations.extend(_partial_date_violations(scanned))

    # Catch-all: any remaining date-shaped token that is not January 1st (or
    # the days a flight may run into after it). The checks above only know
    # the elements this tool writes, so scan the whole document for dates a
    # different exporter may have put anywhere.
    without_coordinates = _with_markup_dropped(scanned)
    unescaped = _with_unescaped(without_coordinates)
    epochs = _find_stray_epochs(unescaped)
    stray_dates = _stray_dates_of(unescaped, epochs)
    # A Unix time on January 1st fails for its time of day
    epoch_set = set(epochs)
    violations.extend(
        f"Unix time not at midnight on Jan 1, remove it: {text}"
        if text in epoch_set
        else f"Date not on Jan 1: {text}"
        for text in stray_dates
    )
    # The rewrite takes a weekday out of the free-text elements
    # (stray_date_spans); one anywhere else has to go by hand
    violations.extend(
        f"Weekday gives the day of the flight away, remove it: {text}"
        for text in find_weekday_tokens(unescaped)
    )
    violations.extend(
        f"Holiday gives the day of the flight away, remove it: {text}"
        for text in find_holiday_tokens(unescaped)
    )
    violations.extend(
        f"Time of day gives the flight away, remove it: {text}"
        for text in _find_stray_times(without_coordinates, stray_dates)
    )
    # A date in a language the patterns do not know, which the rewrite
    # leaves: a person has to tell
    warnings.extend(
        f"May be a date in another language, remove it if it is: {text}"
        for text in find_possible_date_tokens(unescaped)
    )

    # A track repeats its date in every timestamp; one line per date is enough
    return list(dict.fromkeys(violations)), list(dict.fromkeys(warnings))


def _relative_name(path: Path, directory: Path) -> str:
    """The name a violation is reported under: the path below ``directory``."""
    return path.relative_to(directory).as_posix()


class ObfuscationCheck(NamedTuple):
    """The violations and the warnings of the files of a directory, by the
    name below it; only files with any are included."""

    violations: dict[str, list[str]]
    warnings: dict[str, list[str]]


def _check_listed_files(
    kml_files: list[Path], unlisted: Iterable[Path], directory: Path
) -> ObfuscationCheck:
    results: dict[str, list[str]] = {}
    warned: dict[str, list[str]] = {}
    for path in unlisted:
        # Its files are neither checked nor certified
        results[_relative_name(path, directory) + "/"] = [
            (
                "Cannot list the directory, so its files are not checked: fix "
                "its permissions"
            )
        ]
    for kml_file in kml_files:
        violations, warnings = check_kml(kml_file)
        if violations:
            results[_relative_name(kml_file, directory)] = violations
        if warnings:
            warned[_relative_name(kml_file, directory)] = warnings
    for leftover in _leftover_temp_files(directory):
        results[_relative_name(leftover, directory)] = [
            (
                "Leftover temporary file of an interrupted rewrite, holds the "
                "original dates: remove it"
            )
        ]
    return ObfuscationCheck(results, warned)


def check_directory(directory: Path) -> ObfuscationCheck:
    """Check all KML files in a directory tree for obfuscation violations.

    The violations map file names (relative to ``directory``) to theirs;
    only files with violations are included. A temp file left by an
    interrupted rewrite is a violation as well, and so is a directory that
    cannot be listed. The warnings are those of ``check_kml``.
    """
    return _check_listed_files(*_list_kml_files(directory), directory)


def print_warnings(warnings: dict[str, list[str]], indent: str = "  ") -> None:
    """The warnings of a check, which refuse nothing, on stderr."""
    if not warnings:
        return
    print("Possible dates to look at (not refused):", file=sys.stderr)
    for filename, issues in warnings.items():
        for issue in issues:
            print(f"{indent}{filename}: {issue}", file=sys.stderr)


def main() -> None:
    """CLI entry point for obfuscation."""
    parser = argparse.ArgumentParser(
        description="Obfuscate (in place) or verify KML date obfuscation."
    )
    parser.add_argument(
        "directory",
        type=Path,
        help="Directory containing KML files",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Verify files are obfuscated (exit 1 if not)",
    )

    args = parser.parse_args()

    if not args.directory.is_dir():
        print(f"Error: {args.directory} is not a directory", file=sys.stderr)
        sys.exit(1)

    listing = _list_kml_files(args.directory)
    if not args.check:
        modified = _obfuscate_listed_files(listing.files)
        print(f"Obfuscated {modified} of {len(listing.files)} KML file(s).")
        # Renamed files carry new names; a file that could not be rewritten
        # (read-only, or a date in a place the tool does not touch) fails below
        listing = _list_kml_files(args.directory)

    violations, warnings = _check_listed_files(*listing, args.directory)
    print_warnings(warnings)
    if violations:
        print("Obfuscation violations found:")
        for filename, issues in violations.items():
            for issue in issues:
                print(f"  {filename}: {issue}")
        if args.check:
            # A file obfuscated by an earlier version, which kept the time of
            # day, only needs the rewrite
            print(
                "Run `python -m flown.obfuscate "
                f"{args.directory}` (`make obfuscate`) to rewrite the "
                "timestamps, dates and names it knows; remove the rest by hand."
            )
        sys.exit(1)
    if args.check:
        print(f"All {len(listing.files)} KML file(s) are properly obfuscated.")


if __name__ == "__main__":
    main()
