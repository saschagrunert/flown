"""Dates written into free text: finding them and taking them out.

The obfuscator's check looks for dates that give a flight away
(``find_date_tokens`` with ``skip_near_jan_first``), and the export takes
every date out of the names it publishes (``strip_dates``): placemark names
and file names are free text, and "Sunday flight 16 Aug 2026" would publish
the day of the flight.

Numeric dates: 2024-03-14, 2024.03.14, 14.03.2024, 14/03/2024, 14-03-2024,
14_03_2024, 14 03 2024, 14 - 03 - 2024, 3/14/2024, 14.03.24, 2024/3/14,
2024-3-4, the compact 20240314 (with the time right after it as well,
202403141430), the year and month 2024-03, the ISO week 2024-W11 and 2024W11
and 2024/W11, a calendar week with its year (KW11 2024, CW11 2024, Week 11
2024, Wk 11 2024, W11 2024), the ordinal date 2024-074 and the year first
with spaces (2024 03 14). An en dash or a Unicode hyphen may stand for the
hyphen. With a month name: "14 Mar 2024", "14th March 2024", "the 14th of
March 2024", "14-MAR-2024", "14/Mar/2024", "March 14, 2024", "Mar/14/2024",
"Mar14_2024", "2024/Mar/14" and "March 2024", a range of days or months
("14-16 Mar 2024", "Mar 14-16, 2024", "Feb/Mar 2024") whole, with a
two-digit year "14 Mar 24", "14-MAR-24", "14MAR24" and "Mar '24", and in
German, day first: "14. März 2024", "14.Mrz.2024", "14-Okt-2024" and "Mai
2024". With the month in Roman numerals: "14.III.2024", "14. III. 2024" and
"2024. III. 14.". And the date of flight of an ICAO flight plan,
"DOF/240314". A weekday named in full ("Sunday", "Sonntag") gives the day
away as well (``find_weekday_tokens``), and so do a holiday ("Christmas
Eve", "Ostermontag", ``find_holiday_tokens``) and a Unix time
(``epoch_spans``).

Names lose more than that (``strip_dates``): a day and month without the
year ("16 Aug", "16. Mai", "16.08.", "26.08", "16.8", "16/08", "16-08",
"16_08", "16.III.", "16 III") and a calendar week without it ("KW33",
"CW33", "Week 33", "Wk 33"), which the year of the flight completes, six
digits that are a date ("260816"), a month and year ("03/2026", "03.2026",
"2026/03", "08-2026", "2026_08", "2026.08", "VII/2026"), a season, quarter
or half of a year with it ("Summer 2026", "Sommer 2026", "Q3 2026", "H2
2026"), a weekday abbreviated next to a date or a time ("Sat 16 Aug", "Sa.,
16.08.2026", "Sat 14:30") and a time of day ("14:30", "1430Z", "0930z",
"1430L", "1513h" as in a Charterware file name, "14h30", "14.30 Uhr", "3pm",
"0930Z-1045Z", the time after a date as in 20260816T1430, 20260816T14Z,
2026-08-16_1430, 2026-08-16-14-30, 2026-08-16T14-30-00Z or "2026-08-16
14-30" but not "2026-08-16 07-25 RWY" or "2026-08-16 14-30 min", and a range
such as "14.30-15.45 Uhr" or "14.30 bis 15.45 Uhr" whole), with the zone,
the fraction or the offset after it ("1430 GMT", "1430 Zulu", "09:30 EDT",
"1430 local", "0930 hours", "14:30:00.5Z", "14:30 +02:00", "1430+0200"). The
common zones count, not every one there is. "14.30" alone stays: it is a
decimal as often ("fuel 14.30"), and only goes with a zone, the local time
or the hours ("14.30Z", "14.30L", "14.30 hrs"). The obfuscator's check
reports the times of day in names, the descriptions and the file names
(``find_time_tokens``), the weekdays and holidays anywhere, and in names,
descriptions and file names the parts of a date as well
(``find_partial_date_tokens``): the year of the flight completes them. The
obfuscator takes all of it out of names and descriptions
(``stray_date_spans``).

Where a name could hold a date or something else, it loses the date: a
decimal such as "fuel 16.8" goes with the dates it looks like. Two numbers
18 apart are a runway ("RWY 07/25") only in a name that says it speaks of
runways: "EDDS 07/25" reads as July 25th and as July 2025 as well, and an
airport code or a place name before them says nothing about which it is.
Two numbers with a dot after a word that names a version ("firmware
12.10") are the version. Four digits before "hours" go even where they
count the hours of an engine ("Engine 1500 hours"): they are a time of day
as often.
"""

import re
from bisect import bisect_left, bisect_right
from datetime import UTC, datetime, time, timedelta
from itertools import pairwise
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Callable, Iterable

__all__ = [
    "CHARTERWARE_DATE_PATTERN",
    "EPOCH_PATTERN",
    "MAX_DAYS_AFTER_JAN_1",
    "MONTHS_LONG",
    "MONTHS_SHORT",
    "any_month_number",
    "charterware_datetime",
    "epoch_is_obfuscated",
    "epoch_spans",
    "find_date_tokens",
    "find_holiday_tokens",
    "find_partial_date_tokens",
    "find_time_tokens",
    "find_weekday_tokens",
    "month_number",
    "near_jan_first",
    "stray_date_spans",
    "strip_dates",
    "without_spans",
]

# The obfuscator moves a flight to midnight on January 1st, and a flight
# keeps its intervals, so after the shift its timestamps may run into the
# following days. Dates up to this many days after January 1st are no
# giveaway.
MAX_DAYS_AFTER_JAN_1 = 2

MONTHS_SHORT = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)
MONTHS_LONG = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
_MONTH_NUMBERS = {name.lower(): i + 1 for i, name in enumerate(MONTHS_LONG)}
_MONTH_NUMBERS.update({name.lower(): i + 1 for i, name in enumerate(MONTHS_SHORT)})
# The four-letter abbreviation that is common in English as well
_MONTH_NUMBERS["sept"] = 9
# The German names that English does not share (Aug, Nov and the like it
# does), with the Austrian Jänner. Only read in the shapes German writes a
# date in, the day first ("16. Mai 2026") or a month and year ("Mai 2026"):
# "Mai" or "Juli" alone is a name as often.
_GERMAN_MONTH_NUMBERS = {
    "januar": 1,
    "jänner": 1,
    "jaenner": 1,
    "jän": 1,
    "februar": 2,
    "märz": 3,
    "maerz": 3,
    "mär": 3,
    "mrz": 3,
    "mai": 5,
    "juni": 6,
    "juli": 7,
    "oktober": 10,
    "okt": 10,
    "dezember": 12,
    "dez": 12,
}

_DAYS_AFTER_JAN_1 = "|".join(f"{day:02d}" for day in range(1, MAX_DAYS_AFTER_JAN_1 + 2))

# The words a calendar week is written with: the German "KW33", the English
# "CW33", "Week 33" and "Wk 33"
_WEEK_WORD = r"(?:(?i:[KC]W)\s?|(?i:week|wk\.?)\s*)"
# A day and a month of the numeric shapes, and a week of the year
_DAY = r"(?:0?[1-9]|[12]\d|3[01])"
_MONTH = r"(?:0?[1-9]|1[0-2])"
_WEEK = r"(?:0?[1-9]|[1-4]\d|5[0-3])"
# A time of day of four digits, or six with the seconds: 1430, 143015
_HHMM = r"(?:[01]\d|2[0-3])[0-5]\d(?:[0-5]\d)?"
# What stands between the day and the month of a date written with spaces
_SPACED = r"(?:\s+(?:[./_-]\s*)?|[./_-]\s+)"
# The first day of a range of days in German notation, which goes with the
# date after it: the "16.-" of "16.-18.08.2026", which left "16" behind
_DAYS_BEFORE_DOTTED = r"(?:(?:0?[1-9]|[12]\d|3[01])\.\s?-\s?)?"
# The dashes a date is written with besides the hyphen: the hyphen and the
# non-breaking hyphen of Unicode, the figure dash and the en dash. The
# patterns read them as the hyphen; each is a single character, so the
# positions of what they find stay those of the text.
_DASHES = str.maketrans(dict.fromkeys("\u2010\u2011\u2012\u2013", "-"))


def _numeric_patterns(skip_near_jan_first: bool) -> tuple[re.Pattern[str], ...]:
    """The numeric date shapes, with or without the days after January 1st.

    The obfuscator's check leaves those days out in the patterns themselves:
    every timestamp holds such a date, and testing each one in Python
    doubled the time of the check. The shapes other than ISO only pass as
    01.01, since the tool never writes them and 02/01 is February 1st in the
    US.
    """

    def unless(lookahead: str) -> str:
        return f"(?!{lookahead})" if skip_near_jan_first else ""

    days = _DAYS_AFTER_JAN_1
    short_days = "|".join(str(day) for day in range(1, MAX_DAYS_AFTER_JAN_1 + 2))
    return (
        # 2024-03-14, and 2024_03_14 from a file name
        re.compile(
            r"(?<!\d)\d{4}(?P<sep>[-_])"
            + unless(rf"01(?P=sep)(?:{days})(?!\d)")
            + r"\d{2}(?P=sep)\d{2}(?!\d)"
        ),
        re.compile(
            r"(?<![\d.])\d{4}(?P<sep>[./])"
            + unless(r"01(?P=sep)01(?!\d)")
            + r"\d{2}(?P=sep)\d{2}(?!\d|\.\d)"
        ),
        # 2024/3/14 and 2024-3-4: a year first and a month or day of one
        # digit (two of each are the shapes above). Only a real month and
        # day of this or the last century, and not with dots: 2024.3.1 is a
        # version number as often as a date.
        re.compile(
            r"(?<![\d.])(?:19|20)\d{2}(?P<sep>[-_/])"
            + unless(rf"0?1(?P=sep)0?(?:{short_days})(?!\d)")
            + r"(?=\d(?!\d)|\d{2}(?P=sep)\d(?!\d))"
            + r"(?:0?[1-9]|1[0-2])(?P=sep)(?:0?[1-9]|[12]\d|3[01])(?!\d|\.\d)"
        ),
        # Day first or month first, with a four-digit year, and 16_08_2026
        # from a file name; the German range of days "16.-18.08.2026" whole
        re.compile(
            rf"(?<![\d.]){_DAYS_BEFORE_DOTTED}"
            + unless(r"0?1(?P<skip>[./_-])0?1(?P=skip)\d{4}(?!\d|\.\d)")
            + r"\d{1,2}(?P<sep>[./_-])\d{1,2}(?P=sep)\d{4}(?!\d|\.\d)"
        ),
        # The same with a two-digit year, not right after a letter: in
        # "DA40_16_08" or "DA40-16-08-2026" the type ends in 40
        re.compile(
            rf"(?<![^\W_]|\.){_DAYS_BEFORE_DOTTED}"
            + unless(r"0?1(?P<skip>[./_-])0?1(?P=skip)\d{2}(?!\d|\.\d)")
            + r"\d{1,2}(?P<sep>[./_-])\d{1,2}(?P=sep)\d{2}(?!\d|\.\d)"
        ),
        # The same with spaces, "16 08 2026" and "16 - 08 - 2026": only a
        # real day and month, not both of one digit, and a year of this or
        # the last century, since numbers in a row are anything as often
        re.compile(
            r"(?<![\w.])"
            + unless(r"0?1\s*[./_-]?\s*0?1\s*[./_-]?\s*\d")
            + rf"(?=(?:{_DAY}{_SPACED}{_MONTH}|{_MONTH}{_SPACED}{_DAY})(?!\d))"
            + r"(?!\d\D+\d(?!\d))"
            + r"\d{1,2}(?P<sep>\s+(?:[./_-]\s*)?|[./_-]\s+)\d{1,2}(?P=sep)"
            + r"(?:19|20)\d{2}(?!\d|[.,]\d)"
        ),
        # The year first with spaces, "2026 08 16" and "2026 - 08 - 16": the
        # same shape the other way round
        re.compile(
            r"(?<![\w.])(?:19|20)\d{2}(?P<sep>\s+(?:[./_-]\s*)?|[./_-]\s+)"
            + unless(r"0?1\s*[./_-]?\s*0?(?:" + short_days + r")(?!\d)")
            + r"(?!\d(?P=sep)\d(?!\d))"
            + rf"{_MONTH}(?P=sep){_DAY}(?!\d|[.,]\d)"
        ),
        # 2024-03 (a year and month), 2024-W11 and 2024W11 (an ISO week) and
        # 2024-074 (an ordinal date); January, the first week and the first
        # days pass. Without the hyphen only a year of this or the last
        # century, and no letter before it.
        re.compile(
            r"(?<!\d)\d{4}-" + unless(r"01(?![\d-])") + r"(?:0[1-9]|1[0-2])(?![\d-])"
        ),
        re.compile(
            r"(?:(?<!\d)\d{4}[-/]|(?<![A-Za-z\d])(?:19|20)\d{2})W"
            + unless(r"01(?!\d)")
            + r"(?:0[1-9]|[1-4]\d|5[0-3])(?:-?[1-7])?(?!\d)"
        ),
        # A calendar week with its year, "KW33 2026", "KW 33/2026", "CW33
        # 2026", "Week 33 2026", "Wk 33 2026" and "W33 2026"
        re.compile(
            rf"(?:(?<![A-Za-z\d]){_WEEK_WORD}|(?<![A-Za-z\d-])W)"
            + unless(r"0?1(?!\d)")
            + rf"{_WEEK}[\s/._-]*(?:19|20)\d{{2}}(?!\d|[.,]\d)"
        ),
        re.compile(
            r"(?<!\d)\d{4}-"
            + unless(rf"0(?:{days})(?!\d)")
            + r"(?:00[1-9]|0[1-9]\d|[12]\d\d|3[0-5]\d|36[0-6])(?![\d-])"
        ),
        # 20240314: only years of this and the last century, and a real month
        # and day, so that a serial number rarely passes as a date. A time of
        # day may follow right away (202403141430, 20240314143015), which
        # _TIME_AFTER_DATE takes along.
        re.compile(
            r"(?<!\d)(?:19|20)\d{2}"
            + unless(rf"01(?:{days})(?:{_HHMM})?(?!\d)")
            + r"(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])"
            + rf"(?=(?:{_HHMM})?(?!\d))"
        ),
    )


_NUMERIC_STRAY = _numeric_patterns(skip_near_jan_first=True)
_NUMERIC_ALL = _numeric_patterns(skip_near_jan_first=False)


def _first_letters(names: Iterable[str]) -> str:
    """A lookahead for the first letters of ``names``, in either case.

    Put up front, as for _WEEKDAY: the obfuscator's check runs the patterns
    over whole files, and case-insensitive names are slow to try at every
    character.
    """
    letters = {c for name in names for c in (name[0], name[0].upper())}
    return "(?=[" + "".join(sorted(letters)) + "])"


# Only the month names themselves: a word that merely looks like one would
# take the place of a date after it ("EDDS 2026/Aug/16" is no "EDDS 2026")
_MONTH_NAME_RE = (
    _first_letters(_MONTH_NUMBERS)
    + "(?i:"
    + "|".join(sorted(_MONTH_NUMBERS, key=len, reverse=True))
    + ")"
)
_MONTH_RE = rf"{_MONTH_NAME_RE}(?![A-Za-z])"
_GERMAN_MONTH_RE = (
    _first_letters(_GERMAN_MONTH_NUMBERS)
    + "(?i:"
    + "|".join(sorted(_GERMAN_MONTH_NUMBERS, key=len, reverse=True))
    + ")"
)
_DAY_RE = r"\d{1,2}(?:st|nd|rd|th)?"
# A slash as well: "16/Aug/2026" and "2026/Aug/16"
_SEP_RE = r"[\s_.,/-]"
# Only years of this and the last century: "Juli 7000" is a squawk, and in
# "16-AUG-26 1430L" the time is no year
_YEAR_RE = r"(?:19|20)\d{2}"
# "16th of August" as well
_OF_RE = rf"(?:(?i:of){_SEP_RE}+)?"
# What joins the first of a range of days or months to the next ("16-18
# Aug 2026", "16./17. Mai", "Jul/Aug 2026", "July to August 2026"), which
# goes with the date: the first would be left behind otherwise. No comma
# and no spaced hyphen between days: "Leg 2 - 16 Aug" is no range.
# At most three before the last, which keeps a scan linear: a repeat
# without a bound started again at every one of a long run of "1-" or
# "Jan/". In a group of their own, so that _text_month_spans can check the
# days go up ("PA-28-16 Aug" is the type, not a range) and that all of a
# range is near January 1st.
_DAY_JOIN = r"\.?(?:[/&+-]|\s+(?i:to|and|bis|und|&)\s+)"
_DAYS_BEFORE = rf"(?P<range_days>(?:{_DAY_RE}{_DAY_JOIN}){{0,3}})"
_DAYS_AFTER = rf"(?P<range_days_after>(?:{_DAY_JOIN}{_DAY_RE}(?!\d)){{0,3}})"
_MONTH_JOIN = r"\.?\s*(?:[/&+,-]|\s(?i:to|and|bis|und)\s)\s*"
# Any month name, English or German, as the first of a range
_MONTHS_BEFORE = (
    rf"(?P<range_months>(?:(?:{_MONTH_NAME_RE}|{_GERMAN_MONTH_RE})"
    rf"(?![^\W\d_]){_MONTH_JOIN}){{0,3}})"
)
# A two-digit year with an apostrophe, "Aug '26", but no decade ("Dec
# '80s"). "May '68" goes as well: it could be a flight of 1968 or 2068 as
# "Aug '98" one of 1998.
_APOSTROPHE_YEAR = (
    r"\s*['\u2018\u2019](?P<year5>\d{2})(?![\d'\u2018\u2019]|s(?![^\W\d_]))"
)
_TEXT_MONTH = re.compile(
    rf"(?<![A-Za-z\d]){_DAYS_BEFORE}(?P<day1>{_DAY_RE}){_SEP_RE}*{_OF_RE}"
    rf"(?P<month1>{_MONTH_RE}){_SEP_RE}*(?P<year1>{_YEAR_RE})(?!\d)|"
    rf"(?<![A-Za-z])(?P<month2>{_MONTH_RE}){_SEP_RE}*(?P<day2>{_DAY_RE}){_DAYS_AFTER}"
    rf"{_SEP_RE}*(?P<year2>{_YEAR_RE})(?!\d)|"
    rf"(?<![A-Za-z]){_MONTHS_BEFORE}(?P<month3>{_MONTH_RE})"
    rf"(?:{_SEP_RE}+(?P<year3>{_YEAR_RE})(?!\d)|{_APOSTROPHE_YEAR})|"
    # The year first, "2026-Aug-16" and "2026/Aug/16"
    rf"(?<![\w.])(?P<year4>{_YEAR_RE}){_SEP_RE}*(?P<month4>{_MONTH_RE})"
    rf"{_SEP_RE}*(?P<day4>{_DAY_RE})(?![A-Za-z\d])"
)
# Only taken out of names: a day and a month without the year ("16 Aug",
# "August 16th"), which the year of the flight completes, and a time of day
# ("Flight 16 August" must not match "Flight 16" first, so only month names)
# The day-first form takes a two-digit year written right after the month
# along ("16AUG26", "16-AUG-26"), or the year would be left behind on its
# own. A time of day is no year ("16 Aug 14:30").
_TEXT_MONTH_WITHOUT_YEAR = re.compile(
    rf"(?<![A-Za-z\d]){_DAYS_BEFORE}(?P<day1>{_DAY_RE}){_SEP_RE}*{_OF_RE}"
    rf"(?P<month1>{_MONTH_NAME_RE})"
    rf"(?![A-Za-z])(?:{_SEP_RE}?\d{{2}}(?![\d:]))?|"
    rf"(?<![A-Za-z])(?P<month2>{_MONTH_NAME_RE}){_SEP_RE}*(?P<day2>{_DAY_RE})"
    rf"{_DAYS_AFTER}(?![A-Za-z\d])"
)
# The same in German: a day and month with a year ("16. Mai 2026",
# "16.Mai.2026", "16-Mai-2026") or without one ("16. Mai", "16MAI26" with its
# two-digit year), and a month with a year ("Mai 2026"). No letter may touch
# the name on either side, umlauts included ("Maier 2026" is no date).
_GERMAN_MONTH = rf"(?<![^\W\d_])(?:{_GERMAN_MONTH_RE})(?![^\W\d_])"
_TEXT_MONTH_GERMAN = re.compile(
    rf"(?<![^\W_]){_DAYS_BEFORE}(?P<day1>\d{{1,2}}){_SEP_RE}*(?P<month1>{_GERMAN_MONTH})"
    rf"{_SEP_RE}*(?P<year1>{_YEAR_RE})(?!\d)|"
    rf"(?<![^\W\d_]){_MONTHS_BEFORE}(?P<month3>{_GERMAN_MONTH})"
    rf"(?:{_SEP_RE}+(?P<year3>{_YEAR_RE})(?!\d)|{_APOSTROPHE_YEAR})"
)
_TEXT_MONTH_GERMAN_WITHOUT_YEAR = re.compile(
    rf"(?<![^\W_]){_DAYS_BEFORE}(?P<day1>\d{{1,2}}){_SEP_RE}*(?P<month1>{_GERMAN_MONTH})"
    rf"(?:{_SEP_RE}?\d{{2}}(?![\d:]))?"
)
# A day, a month name and a two-digit year: "16 Aug 26", "16-AUG-26",
# "16AUG26" (the aviation form) and "16. Mai 26". The separators after the
# month have to be those before it, which keeps "3 May 10 minutes" out: the
# obfuscator's check reports these, where a day and month alone say too
# little to fail a file on.
_TEXT_MONTH_SHORT_YEAR = re.compile(
    rf"(?<![A-Za-z\d])(?P<day1>{_DAY_RE})(?P<sep>{_SEP_RE}*)"
    rf"(?P<month1>{_MONTH_NAME_RE}|{_GERMAN_MONTH_RE})(?![^\W\d_])"
    r"(?P=sep)(?P<year1>\d{2})(?![\d:]|\.\d)"
)
# The month in Roman numerals, as Poland, Czechia, Hungary and others write
# it: "16.VII.2026", "16. VII. 2026", "16-VII-2026", "16/VII/2026", the year
# first as in Hungary ("2026. VII. 16."), and in lowercase ("16.vii.2026").
# With spaces alone only a numeral of two letters or more: "16 X 2026" is a
# product or a multiplication as often. Without the day or without the
# year only a numeral in capitals of two letters or more, and a space after
# the dot only with a dot after the numeral as well: "16.VII.", "16.VII",
# "16. VII.", "VII/2026", "VII.2026", "2026/VII" and "2026. VII." are dates,
# "Section 2. IV", "Leg 3. II", "Model 3. V", "2026. I liked it" and
# "v.2024" are not. Nor is a day and a numeral with a space alone ("16
# VIII"), as "Gate 12 VI", "Part 12 II" and "Mk 12 IV" are written too.
_ROMAN_MONTHS = (
    "I",
    "II",
    "III",
    "IV",
    "V",
    "VI",
    "VII",
    "VIII",
    "IX",
    "X",
    "XI",
    "XII",
)
_ROMAN_MONTH_NUMBERS = {name: i + 1 for i, name in enumerate(_ROMAN_MONTHS)}
_ROMAN_MONTH_NUMBERS.update(
    {name.lower(): i + 1 for i, name in enumerate(_ROMAN_MONTHS)}
)
_ROMAN_RE = "(?:" + "|".join(sorted(_ROMAN_MONTH_NUMBERS, key=len, reverse=True)) + ")"
_ROMAN_LONG_RE = (
    "(?:"
    + "|".join(
        sorted((n for n in _ROMAN_MONTH_NUMBERS if len(n) > 1), key=len, reverse=True)
    )
    + ")"
)
_ROMAN_CAPITALS_RE = (
    "(?:"
    + "|".join(sorted((n for n in _ROMAN_MONTHS if len(n) > 1), key=len, reverse=True))
    + ")"
)
_ROMAN_SEP = r"\.\s?|[/_-]"
_ROMAN_DATE = re.compile(
    rf"(?<![\w.])(?P<day1>{_DAY})(?P<sep1>{_ROMAN_SEP})(?P<month1>{_ROMAN_RE})"
    rf"(?P=sep1)(?P<year1>{_YEAR_RE})(?![\w]|[.,]\d)|"
    rf"(?<![\w.])(?P<day2>{_DAY})\s+(?P<month2>{_ROMAN_LONG_RE})\s+"
    rf"(?P<year2>{_YEAR_RE})(?![\w]|[.,]\d)|"
    rf"(?<![\w.])(?P<year3>{_YEAR_RE})(?P<sep3>{_ROMAN_SEP})(?P<month3>{_ROMAN_RE})"
    rf"(?P=sep3)(?P<day3>{_DAY})\.?(?![\w]|[.,]?\d)"
)
_ROMAN_DAY_MONTH = re.compile(
    rf"(?<![\w.])(?:(?P<day1>{_DAY})"
    rf"(?:\.(?P<month1>{_ROMAN_CAPITALS_RE})\.?|\.\s(?P<month2>{_ROMAN_CAPITALS_RE})\.))"
    r"(?![\w]|\.?\d)"
)
_ROMAN_MONTH_YEAR = re.compile(
    rf"(?<![\w./-])(?P<month1>{_ROMAN_CAPITALS_RE})[/.](?P<year1>{_YEAR_RE})"
    r"(?![\w/]|[.,]\d)|"
    rf"(?<![\w./-])(?P<year2>{_YEAR_RE})"
    rf"(?:[/.](?P<month2>{_ROMAN_CAPITALS_RE})\.?|\.\s(?P<month3>{_ROMAN_CAPITALS_RE})\.)"
    r"(?![\w/]|[.,]?\d)"
)
# A day and month in German notation, "16.08.", with the year left out, and
# "26.08" or "16.8" without the last dot when the day has two digits, with
# an underscore around it as in a file name ("EDDS_16.08"): 118.30 is a
# frequency and 1.2 a version, which the digits and dots around keep out.
# After a word that says it is a version ("firmware 12.10", or an app that
# numbers its versions by year and month, "ForeFlight 2026.03") it is one
# (see _day_month_dotted_spans and _month_year_spans).
_DAY_MONTH_DOTTED = re.compile(
    rf"(?<![\d.]){_DAYS_BEFORE_DOTTED}(?:0?[1-9]|[12]\d|3[01])\.(?:0?[1-9]|1[0-2])"
    r"\.(?![\d.])|"
    r"(?<![^\W_]|\.)(?:(?:0[1-9]|[12]\d|3[01])\.(?:0[1-9]|1[0-2])|"
    r"(?:[12]\d|3[01])\.[1-9])(?![^\W_]|\.|,\d)"
)
_VERSION_WORD = re.compile(
    r"(?i:\b(?:v|ver|version|firmware|fw|software|sw|release|build|update|app"
    r"|ios|android|foreflight|skydemon|garmin\s+pilot|easyvfr))\.?\s*$"
)
# A day and month with a slash, "16/08" or "08/16", or with a hyphen or an
# underscore and two digits each, "16-08" and the "16_08" of a file name (a
# range such as 5-10 has a single digit more often), with the year left
# out; which of them is a date is up to _is_day_month
_DAY_MONTH_SLASHED = re.compile(
    r"(?<![^\W_]|[./-])(?:(?P<first>\d{1,2})/(?P<second>\d{1,2})|"
    r"(?P<first_h>\d{2})[-_](?P<second_h>\d{2}))(?![^\W_]|[/-]|\.\d)"
)
# Six digits that are a date with a two-digit year, the year first as in the
# DOF/260816 of an ICAO flight plan or last as in 160826. Only taken out of
# names: a number of six digits is rarely anything else there.
_SIX_DIGIT_DATE = re.compile(
    r"(?<![\w./-])(?:\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])|"
    r"(?:0[1-9]|[12]\d|3[01])(?:0[1-9]|1[0-2])\d{2})(?![\w/-]|\.\d)"
)
# The date of flight of an ICAO flight plan, which the obfuscator's check
# reports in any document: "DOF/260816", YYMMDD
_FLIGHT_PLAN_DATE = re.compile(
    r"\bDOF/(?P<year>\d{2})(?P<month>0[1-9]|1[0-2])(?P<day>0[1-9]|[12]\d|3[01])"
    r"(?!\d)"
)
# A runway is named by its two directions, which are 180 degrees apart:
# 08/26, 16/34. 26/08 is August 26th as well, so such a pair only counts as
# a runway in a name that says it speaks of one.
_RUNWAY_DIFFERENCE = 18
_RUNWAY_WORD = re.compile(r"(?i:\b(?:rwys?|rw|runways?|piste|(?:lande)?bahn)\b)")
# A month and a year without the day: "03/2026", "3/2026", "03.2026",
# "2026/03", "08-2026", "08_2026", "2026_08" and "2026.08" (2026-03 is one
# of the numeric shapes above). With a dot or a hyphen or an underscore only
# a month of two digits: 2026.3 is a version number and 3.2026 a decimal. A
# decimal such as 12.2026 or 2026.12 goes as well, which a name rarely has.
_MONTH_YEAR = re.compile(
    r"(?<![\w./])(?:(?:0?[1-9]|1[0-2])/|(?:0[1-9]|1[0-2])\.)(?:19|20)\d{2}"
    r"(?![\w/]|\.\d)|"
    r"(?<![\w./])(?:19|20)\d{2}/(?:0?[1-9]|1[0-2])(?![\w/]|\.\d)|"
    # "08-2026" and the "08_2026" of a file name, two digits for the month
    r"(?<![^\W_]|[./-])(?:0[1-9]|1[0-2])[-_](?:19|20)\d{2}(?![^\W_]|[/-]|\.\d)|"
    # "2026.08" and "2026_08", two digits as well; with the dot not after a
    # word that names a version (see _month_year_spans)
    r"(?<![^\W_]|[./-])(?P<year_first>(?:19|20)\d{2})(?P<sep>[._])(?:0[1-9]|1[0-2])"
    r"(?![^\W_]|[./-]|,\d)"
)
# A season, a quarter or a half of a year with its year: "Summer 2026",
# "summer of 2026", "Sommer 2026", "Frühjahr 2026", "Winter 2025/26", "Q3
# 2026", "Q3/2026", "2026 Q3", "2026-Q3" and "H2 2026". Without the year
# they stay: a "Summer camp" or the "Q3" of a code is no date.
_SEASONS = (
    "spring",
    "summer",
    "autumn",
    "fall",
    "winter",
    "frühling",
    "fruehling",
    "frühjahr",
    "fruehjahr",
    "sommer",
    "herbst",
)
_SEASON_RE = "(?i:" + "|".join(sorted(_SEASONS, key=len, reverse=True)) + ")"
_PART_OF_YEAR = r"(?:(?i:q)[1-4]|H[12])"
_AFTER_A_YEAR = r"(?![^\W_]|[/-]|[.,]\d)"
_SEASON_YEAR = re.compile(
    rf"(?<![^\W\d_]){_SEASON_RE}[\s_/-]+(?:(?i:of)\s+)?{_YEAR_RE}"
    rf"(?:/(?:\d{{2}}){{1,2}})?{_AFTER_A_YEAR}|"
    rf"(?<![^\W_]){_PART_OF_YEAR}[\s_/'-]+{_YEAR_RE}{_AFTER_A_YEAR}|"
    rf"(?<![^\W_]|[./-]){_YEAR_RE}[\s_/-]?{_PART_OF_YEAR}(?![^\W_])"
)
# The first quarter and half, and the winter, hold January 1st
_SEASON_NEAR_JAN_FIRST = re.compile(r"(?i:winter|[qh]1(?!\d))")


def _month_year_spans(text: str) -> list[tuple[int, int]]:
    """The months with their year (``_MONTH_YEAR``), but no version numbers.

    "2026.08" is a date, "firmware 2024.10" a version (see _VERSION_WORD).
    """
    return [
        match.span()
        for match in _MONTH_YEAR.finditer(text)
        if match["sep"] != "." or not _VERSION_WORD.search(text, 0, match.start())
    ]


def _season_spans(text: str) -> list[tuple[int, int]]:
    """The seasons, quarters and halves of a year with it (``_SEASON_YEAR``)."""
    return [match.span() for match in _SEASON_YEAR.finditer(text)]


# The zones a time of day is given in: UTC, UT and GMT, with an offset of up
# to 14 hours or without ("UTC+2", "GMT-05:00"), Zulu, the local time ("LT",
# "LCL", "LOC", "local" and "local time"), the common zones of Europe (WET,
# WEST, CET, CEST, the German MEZ and MESZ, BST, IST, EET, EEST, MSK), of
# North America (EST, EDT, CST, CDT, MST, MDT, PST, PDT, AKST, AKDT, HST,
# AST, ADT, NST, NDT), of Australia and New Zealand (AEST, AEDT, ACST, ACDT,
# AWST, NZST, NZDT) and a few more (IDT, SAST, JST, HKT, SGT). The
# abbreviations count in capitals only: "est" and "ist" are words.
_ZONE_NAME = (
    r"(?:[Zz]|(?i:utc|gmt)(?:[+-](?:1[0-4]|0?\d)(?::?[0-5]\d)?)?|UT|(?i:zulu)"
    r"|LT|(?i:lcl)|LOC|(?i:local)(?:\s+(?i:time))?|WES?T|CES?T|MES?Z|EES?T|BST"
    r"|IST|MSK|[ACEMNP][SD]T|AK[SD]T|HST|A[CE][SD]T|AWST|NZ[SD]T|IDT|SAST|JST"
    r"|HKT|SGT)"
)
# A UTC offset right after a time, "+02:00", "+0200" and "+02", and with a
# space before it only with its minutes, "14:30 +02:00" ("12:00 +10 min" is
# no offset)
_OFFSET = (
    r"(?:[+-](?:[01]\d|2[0-3])(?::?[0-5]\d)?"
    r"|\s+[+-](?:[01]\d|2[0-3]):?[0-5]\d)"
)
# "1430h", "1430hrs", "1430 hrs" and the military "0930 hours"
_HOURS = r"(?:(?i:h(?:rs|ours)?)|\s+(?i:hrs|hours))"
# A zone after a time, and the "L" of "1430L"
_ZONE = rf"(?:\s*{_ZONE_NAME}|L)"
# "14:30h" and "14:30 hours" take their hours along, "14:30:00.5" and
# "14:30:00,5" their fraction, "3:15 pm EST" and "14:30+02:00" their zone,
# and the T of an ISO time "T14:30" its T
_TIME_OF_DAY = re.compile(
    r"(?:(?<![A-Za-z\d])T)?(?<![\d:])(?:[01]?\d|2[0-3]):[0-5]\d"
    r"(?::[0-5]\d)?(?:[.,]\d+)?"
    r"(?:\s*[AaPp]\.?[Mm]\.?(?![A-Za-z]))?"
    rf"(?:{_OFFSET}|\s*{_ZONE_NAME}(?![A-Za-z])|{_HOURS}(?![A-Za-z]))?"
    r"(?![\d:])"
)
# The French and German forms: "14h30" and "14.30" with the hours or the
# "L" of the local time ("14.30h", "14.30 hrs", "14.30L"; two digits for
# the hour, "1h30" and "1.30 hrs" are durations), either with a zone
# ("14h30Z", "9h30 UTC", "14.30Z", "9.30 CET"), anything with "Uhr" ("14.30
# Uhr", "1430 Uhr", "14 Uhr"), and the English "3pm", "3 p.m.", "10 AM" and
# "11.30am" ("3 am" is German for "3 at the", while "10 AM" in capitals is
# the time, and so is a German "2 AM RHEIN" written in capitals, which
# cannot be told from one). After a hyphen it is a type or a registration
# ("Mi-8AM", "PA-1 PM"), unless a time stands before the hyphen: then it is
# the end of a range ("10am-12pm", "10 AM-12 PM", "9 a.m.-5 p.m."), and a
# lowercase "am" at either end of one is the time as well ("10 am-12 pm").
# An underscore may stand before them, as in a file name ("1_DEHYL_14h30").
# An hour of the clock with a half of the day ("3", "11.30")
_HOUR_12 = r"(?:1[0-2]|0?[1-9])(?:\.[0-5]\d)?"
# A hyphen with a time before it ("10am-", "9 a.m.-"), which makes the time
# after it the end of a range rather than part of a name ("Mi-8AM")
_AFTER_A_TIME = r"(?:(?<=[AaPp][Mm]-)|(?<=[AaPp]\.[Mm]\.-))"
_NOT_AFTER_A_NAME = rf"(?:(?<!-)|{_AFTER_A_TIME})"
# What ends a range after a time ("-12 pm", "-1:15pm")
_RANGE_END = r"-(?:1[0-2]|0?[1-9])(?:[.:][0-5]\d)?\s?(?i:[ap]\.?m)"
# A range of times with a dot ("14.30-15.45 Uhr", "14.30-15.45Z", "9-11
# Uhr", "14.30 bis 15.45 Uhr", "14.30 to 15.45Z") goes whole when its end
# makes it one, as "0930Z-1045Z" does: "14.30" alone stays, and taking out
# its end alone left the start behind ("14.30 bis"). The other dashes read
# as the hyphen (see _DASHES).
_TIME_JOIN = r"(?:\s?-\s?|\s+(?i:bis|to|until|till)\s+)"
_TIME_RANGE_WORDS = (
    rf"(?:[01]?\d|2[0-3])(?:[.:]?[0-5]\d)?{_TIME_JOIN}"
    r"(?:[01]?\d|2[0-3])(?:[.:]?[0-5]\d)?\s*Uhr|"
    rf"(?:[01]?\d|2[0-3])\.[0-5]\d{_TIME_JOIN}(?:[01]?\d|2[0-3])\.[0-5]\d"
    rf"(?:\s*{_ZONE_NAME}|L|{_HOURS})(?![A-Za-z])"
)
_TIME_OF_DAY_WORDS = re.compile(
    r"(?<![^\W_]|[.:])"
    rf"(?:{_TIME_RANGE_WORDS}|"
    rf"(?:[01]?\d|2[0-3])[h.][0-5]\d\s*{_ZONE_NAME}(?![A-Za-z])|"
    rf"(?:[01]\d|2[0-3])(?:h[0-5]\d|\.[0-5]\d(?:L|{_HOURS})(?![A-Za-z]))|"
    r"(?:[01]?\d|2[0-3])(?:[.:]?[0-5]\d)?\s*Uhr|"
    rf"{_NOT_AFTER_A_NAME}{_HOUR_12}(?i:p\.?m\.?|a\.m\.|am)|"
    rf"{_NOT_AFTER_A_NAME}{_HOUR_12}(?:\s(?i:p\.?m\.?|a\.m\.)|\sA\.?M\.?)|"
    rf"{_AFTER_A_TIME}{_HOUR_12}\s(?i:am)|"
    rf"{_NOT_AFTER_A_NAME}{_HOUR_12}\s(?i:am)(?={_RANGE_END}))"
    r"(?![^\W_])"
)
# A calendar week without the year, "KW33", "CW33", "Week 33" and "Wk 33", which the
# year of the flight completes ("Week 3" of a course goes as well). "W33"
# alone stays: it is the code of an airport in the US as often.
_WEEK_ONLY = re.compile(rf"(?<![A-Za-z\d]){_WEEK_WORD}{_WEEK}(?![\w])")
# "KW05" is an airport in the US as well (Gettysburg), where a route side
# starts: at the start of a route name or after its separator, or at the
# start of a name that says it is an airport
_AIRPORT_KW = re.compile(r"KW\d{2}")
_ROUTE_SEPARATOR = re.compile(r"\s+(?:-|to)\s+")
_SIDE_START = re.compile(r"\s(?:-|to)\s+\Z")
_AIRPORT_WORD = re.compile(r"\b(?:Airport|Airfield|Airpark|Field|Strip|Heliport)\b")


def _week_only_spans(text: str) -> list[tuple[int, int]]:
    """The calendar weeks without a year (``_WEEK_ONLY``), no airport codes."""
    spans = []
    for match in _WEEK_ONLY.finditer(text):
        if _AIRPORT_KW.fullmatch(match.group(0)):
            before = text[: match.start()]
            starts_side = not before.strip() or _SIDE_START.search(before)
            is_route = _ROUTE_SEPARATOR.search(text) is not None
            if starts_side and (is_route or _AIRPORT_WORD.search(text)):
                continue
        spans.append(match.span())
    return spans


# A time of day without a colon: "1430Z" (and "1430z"), "1430 UTC", "1430
# GMT", "1430 EST" and the other zones, the local "1430L", "1430 LT" and
# "1430 local", the "1430h" of a Charterware file name, "1430hrs" and "0930
# hours", a UTC offset ahead of UTC ("1430+0200": "1200-1400" is a range),
# and the "T1430" an ISO basic timestamp (20260816T1430) leaves once its
# date is out. Four digits alone are an altitude or a squawk as often, so
# only these forms. A letter before them makes them a part of a registration
# ("N1430Z", "N1513H"), and so does a nationality prefix with its hyphen
# ("RA-1513H", but not "EDDS-1513H", nor the second time of a range,
# "0930Z-1045Z"); aircraft types start with a letter as well. A range goes
# whole ("1430 LT-1545 LT", "0930Z-1045").
_BARE_OFFSET = r"\+(?:0\d|1[0-4]):?(?:00|30|45)"
_COMPACT_TIME = re.compile(
    r"(?<![A-Za-z\d])(?<!(?<![A-Za-z\d])[A-Z]-)(?<!(?<![A-Za-z\d])[A-Z]{2}-)"
    rf"(?:T{_HHMM}(?:[.,]\d+)?(?:[Zz]|(?i:utc)|{_OFFSET})?"
    rf"|{_HHMM}(?:{_ZONE}|{_HOURS}|{_BARE_OFFSET})"
    rf"(?:-{_HHMM}(?:{_ZONE}|{_HOURS}|{_BARE_OFFSET})?)?)"
    r"(?![A-Za-z\d])"
)
# The time of day right after a date is one in any form: the "T14:30:00Z"
# of an ISO timestamp, whose T would be left behind otherwise, the "1430" of
# 20260816-1430, 2026-08-16_1430 and 202608161430, the "14-30" of
# 2026-08-16-14-30, 2026-08-16_14-30 and "2026-08-16 14-30" (and "14_30"),
# the "15.13" of "16.08.2026, 15.13" and the hour alone of an ISO
# timestamp, "T14Z", with fractions of a second, the half of the day
# ("8/16/26 2:30 PM"; a lowercase "am" only right after the time, since
# " am" is German for "at the"), a UTC offset and "Uhr". A range goes whole
# ("16.08.2026 14.30-15.45 Uhr", "16.08.2026 14.30 bis 15.45 Uhr"), or the
# "-15" of its end would pass for an offset. Only a date that ends in a
# digit has a time right after it. The hyphenated form ("T14-30-00Z" too,
# whose hour alone left "30-00Z") is no time before a unit or a runway: the
# "18-24 kt" of a wind, the "11-22 km" of a leg, the "14-30 min" of a wait
# and the "07-25 RWY" of a runway after a date are no times. A bare "h",
# "m" or "s" is the time's own, as "hrs" is: hours and minutes of the
# clock after a date are the time of the flight ("2026-08-16 14-30h",
# "14-30 h", "_14-30m"), and read as a unit they were left in the name and
# passed the check. A range that is no time of the clock ("18-75 m") never
# matched the hours and minutes and stays.
_RANGE_AFTER = (
    r"\s*(?i:kts?|kn|km|nm|mi|mph|ft|kg|lbs?|gal|%|mins?|secs?)"
    r"(?![A-Za-z])|\s*(?i:rwys?|rw|runways?|piste|(?:lande)?bahn)\b"
)
# The letter of the clock after hyphenated hours and minutes ("14-30h")
_CLOCK_LETTER = r"\s*(?i:[hms])(?![A-Za-z])"
_TIME_AFTER_DATE = re.compile(
    rf"(?:(?:[-_]|,?\s+|T|(?<=\d))(?:{_HHMM}|"
    r"(?:[01]?\d|2[0-3])(?P<tsep>[:.])[0-5]\d(?:(?P=tsep)[0-5]\d)?"
    rf"(?:{_TIME_JOIN}(?:[01]?\d|2[0-3])(?P=tsep)[0-5]\d(?:(?P=tsep)[0-5]\d)?)?)|"
    r"(?:[-_T]|,?\s+)(?:[01]\d|2[0-3])(?P<dsep>[-_])[0-5]\d(?:(?P=dsep)[0-5]\d)?"
    rf"(?:{_CLOCK_LETTER}|(?!{_RANGE_AFTER}))|"
    r"T(?:[01]\d|2[0-3]))"
    r"(?:[.,]\d+)?(?:(?:\s*(?:[AP]\.?M\.?|[ap]\.m\.|pm)|am)(?![A-Za-z]))?"
    rf"{_HOURS}?(?:{_ZONE}|{_OFFSET}|\s*Uhr)?"
    r"(?![A-Za-z\d:])"
)
# A weekday gives the day of a flight away along with its year and the
# order of the files. Only the full names, in English and German, go
# wherever they stand, with the forms made of them: "Sundays", "Sunday's",
# "sonntags", "Sonntagsflug" and "Sonntagabend" ("Montage" is no Monday).
# The places OurAirports names after one keep it: Friday Harbor (KFHR, the
# only airport with an ICAO code among them), Thursday Island and Sunday
# Creek. Other names lose it, family names (Freitag, Sonntag) and "1WA9
# Friday West" among them: a name kept whole would publish the day.
_WEEKDAYS_ENGLISH = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)
_PLACE_AFTER_WEEKDAY = r"[\s_-]+(?:harbou?r|island|creek)(?![^\W\d_])"
_WEEKDAYS_GERMAN = (
    "montag",
    "dienstag",
    "mittwoch",
    "donnerstag",
    "freitag",
    "samstag",
    "sonnabend",
    "sonntag",
)
_PARTS_OF_THE_DAY_GERMAN = "morgen|vormittag|nachmittag|mittag|abend|nacht"
# The first letter up front: the obfuscator's check runs this over whole
# files, and the case-insensitive names are slow to try at every character
_WEEKDAY = re.compile(
    r"(?=[DdFfMmSsTtWw])(?<![^\W\d_])(?i:"
    rf"(?:{'|'.join(_WEEKDAYS_ENGLISH)})(?!{_PLACE_AFTER_WEEKDAY})(?:'?s)?|"
    rf"(?:{'|'.join(_WEEKDAYS_GERMAN)})"
    rf"(?:s[^\W\d_]*|(?:{_PARTS_OF_THE_DAY_GERMAN})s?)?"
    r")(?![^\W\d_])"
)
# A holiday names the day of a flight as well, with the year of the flight
# even the movable ones ("Easter Monday 2026"). The common ones of the
# English and German speaking countries, each in both languages where it has
# a name in both, and the forms made of the German ones ("Weihnachtsflug",
# "Vorweihnachtsflug", "Ostermontagsflug"). The places named after one keep
# it, as those of the weekdays do, and so do the airfields: Christmas
# Island, Christmas Creek, Christmas Valley, Easter Island, Easter Field,
# High Easter Airfield, Pentecost Island, Pentecost Airport and Proserpine
# Whitsunday Coast have airports, as have the Whitsunday Islands and the
# Christmas Flying Service; Weihnachtsinsel is Christmas Island in German.
# Churches, chapels and schools keep theirs as well ("Easter Chapel",
# often a VFR reporting point). "Oster" alone starts town names
# (Osterholz, Osterode, Osterfeld), so only its holidays go.
_PLACE_AFTER_HOLIDAY = (
    r"[\s_/-]+(?:harbou?r|island|creek|valley|coast|hill|township|province"
    r"|field|airfield|airport|airstrip"
    r"|church|chapel|cathedral|college|parish|school)s?(?![^\W\d_])"
    r"|[\s_/-]+flying[\s_/-]+service\b"
)
_HOLIDAYS_ENGLISH = (
    r"christmas(?:\s+(?:eve|day))?",
    r"x-?mas(?:\s+(?:eve|day))?",
    r"boxing\s+day",
    r"new\s+year'?s?(?:\s+(?:eve|day))?",
    r"easter(?:\s+(?:sunday|monday))?",
    r"good\s+friday",
    r"maundy\s+thursday",
    r"whit(?:sun(?:day)?|\s+(?:sunday|monday))",
    "pentecost",
    r"ascension\s+day",
    # With their day: All Saints and All Souls name churches and colleges
    r"all\s+saints'?\s+day",
    r"all\s+souls'?\s+day",
    r"st\.?\s+patrick'?s\s+day",
    "thanksgiving",
    "halloween",
    r"valentine'?s\s+day",
    r"independence\s+day",
    r"(?:fourth|4th)\s+of\s+july",
    "juneteenth",
    r"labou?r\s+day",
    r"memorial\s+day",
    r"veterans'?\s+day",
    r"(?:mother|father)'?s\s+day",
    "hogmanay",
    # The English names of the German ones below, and more of the US, the
    # UK and the Commonwealth
    r"holy\s+saturday",
    r"palm\s+sunday",
    r"ash\s+wednesday",
    r"shrove\s+tuesday",
    r"pancake\s+day",
    r"mardi\s+gras",
    # As Corpus Christi below: Epiphany alone names churches
    r"epiphany\s+day",
    r"feast\s+of\s+(?:the\s+)?epiphany",
    r"three\s+kings'?(?:\s+day)?",
    r"twelfth\s+night",
    r"st\.?\s+nicholas'?\s+day",
    r"st\.?\s+stephen'?s\s+day",
    r"reformation\s+day",
    r"may\s+day",
    r"(?:german\s+unity\s+day|day\s+of\s+german\s+unity)",
    # Not the city in Texas
    r"corpus\s+christi\s+day",
    r"feast\s+of\s+corpus\s+christi",
    r"repentance\s+day",
    r"columbus\s+day",
    r"presidents'?\s+day",
    r"(?:mlk|martin\s+luther\s+king(?:\s+jr\.?)?)\s+day",
    r"remembrance\s+(?:day|sunday)",
    r"armistice\s+day",
    r"victoria\s+day",
    r"canada\s+day",
    r"australia\s+day",
    r"anzac\s+day",
)
# The German ones that make words of their own take the forms made of them
# along, such as "Ostermontagsflug" and "Himmelfahrtswochenende"
_COMPOUND = r"(?:s[^\W\d_]*)?"
_HOLIDAYS_GERMAN = (
    r"heilig(?:abend[^\W\d_]*|er\s+abend)",
    r"(?:vor)?weihnacht(?:en|s(?!insel)[^\W\d_]*)",
    r"silvester[^\W\d_]*",
    r"neujahr[^\W\d_]*",
    "ostern",
    rf"oster(?:sonntag|montag|samstag|feiertage?|flug|ferien|wochenende){_COMPOUND}",
    rf"karfreitag{_COMPOUND}",
    rf"karsamstag{_COMPOUND}",
    rf"palmsonntag{_COMPOUND}",
    rf"gründonnerstag{_COMPOUND}",
    rf"gruendonnerstag{_COMPOUND}",
    "pfingsten",
    rf"pfingst(?:sonntag|montag|feiertage?|flug|ferien|wochenende){_COMPOUND}",
    rf"(?:christi\s+)?himmelfahrt{_COMPOUND}",
    rf"vatertag{_COMPOUND}",
    rf"muttertag{_COMPOUND}",
    rf"fronleichnam{_COMPOUND}",
    rf"rosenmontag{_COMPOUND}",
    rf"faschingsdienstag{_COMPOUND}",
    rf"aschermittwoch{_COMPOUND}",
    "allerheiligen",
    "allerseelen",
    rf"totensonntag{_COMPOUND}",
    rf"reformationstag{_COMPOUND}",
    rf"maifeiertag{_COMPOUND}",
    r"erste[nr]?\s+mai",
    r"tag\s+der\s+arbeit",
    r"tag\s+der\s+(?:deutschen\s+)?einheit",
    # The German names of the English ones above
    rf"dreik(?:ö|oe)nigs(?:tag|fest){_COMPOUND}",
    r"heilige[n]?\s+drei\s+k(?:ö|oe)nige",
    rf"nikolaustag{_COMPOUND}",
    rf"stephanstag{_COMPOUND}",
    rf"valentinstag{_COMPOUND}",
    rf"patrickstag{_COMPOUND}",
    rf"martinstag{_COMPOUND}",
    rf"erntedank(?:fest|sonntag|tag)?{_COMPOUND}",
    rf"volkstrauertag{_COMPOUND}",
    rf"unabh(?:ä|ae)ngigkeitstag{_COMPOUND}",
    r"bu(?:ß|ss)-?\s*und\s+bettag",
)
_HOLIDAY = re.compile(
    r"(?=[ABCDEFGHIJKLMNOPRSTUVWXabcdefghijklmnoprstuvwx4])(?<![^\W_])(?i:(?:"
    + "|".join(_HOLIDAYS_ENGLISH + _HOLIDAYS_GERMAN)
    + rf")(?!{_PLACE_AFTER_HOLIDAY}))(?![^\W\d_])"
)
# The abbreviations are words, codes and types of their own: "Sun" and
# "Sat" are words, SAT and THU airports (IATA), "Do 27" a Dornier and "Mo"
# a name. They only go right before a date or a time ("Sat 16 Aug 2026",
# "Sa., 16.08.2026", "Sat 14:30") or after a date in brackets or at the end
# of a name ("16.08.2026 (Sa)", "2026-08-16 Sat"); not after a letter or a
# hyphen, as in the registrations D-EFRI and OE-SAT. Next to a time the
# airport code goes as well ("KAUS to SAT 14:30" keeps "KAUS to"): it
# cannot be told from a weekday there, and a weekday with a time is a leak.
_WEEKDAY_ABBREVIATIONS = (
    "Mon",
    "Tue",
    "Tues",
    "Wed",
    "Thu",
    "Thur",
    "Thurs",
    "Fri",
    "Sat",
    "Sun",
    "Mo",
    "Di",
    "Mi",
    "Do",
    "Fr",
    "Sa",
    "So",
)
_WEEKDAY_ABBREVIATION = (
    "(?:"
    + "|".join(
        sorted(
            {form for name in _WEEKDAY_ABBREVIATIONS for form in (name, name.upper())},
            key=len,
            reverse=True,
        )
    )
    + r")\.?"
)
# One of them right before a date, searched for backwards from the date one
# at a time (see _weekday_start_before): "Sat Sat 16 Aug 2026" keeps no
# "Sat" once the first one is gone. The longest one is "THURS." with a comma.
_WEEKDAY_BEFORE_DATE = re.compile(rf"(?<![^\s_,(\[]){_WEEKDAY_ABBREVIATION},?\Z")
_WEEKDAY_ABBREVIATION_LENGTH = 7
_WEEKDAY_AFTER_DATE = re.compile(
    rf",?[\s_]*\(\s*{_WEEKDAY_ABBREVIATION}\s*\)|"
    rf"(?:,?[\s_]+{_WEEKDAY_ABBREVIATION})+(?=\s*\Z|[_,;])"
)
# What is left around a removed date: separators at either end, a separator
# that now stands next to another one, and empty brackets
_EDGE_SEPARATORS = re.compile(r"^[\s\-_,.:;/|]+|[\s\-_,.:;/|]+$")
_DOUBLE_SEPARATORS = re.compile(r"\s*([-_,;/|])(?:\s*[-_,;/|])+\s*")
_EMPTY_BRACKETS = re.compile(r"\(\s*\)|\[\s*\]")
_SPACES = re.compile(r"\s+")


def month_number(name: str) -> int | None:
    """The number of an English month name, long or short, in any case."""
    return _MONTH_NUMBERS.get(name.lower())


# Charterware description: "Flight Jan 12 2026 03:01PM path of OE-AKI", the
# month short or long ("January", "Sept") and the hour with one digit or two.
# The parser reads the time of a flight from it and the obfuscator moves it,
# so both read it the same way.
CHARTERWARE_DATE_PATTERN = re.compile(
    r"(Flight\s+)([A-Za-z]{3,9})\s+(\d{1,2})\s+(\d{4})\s+(\d{1,2}):(\d{2})(AM|PM)"
)


def charterware_datetime(match: re.Match[str]) -> datetime | None:
    """The time a ``CHARTERWARE_DATE_PATTERN`` match names, as UTC.

    The description has no time zone; it is read as UTC, as the parser
    reads every time without one. None when it is no date.
    """
    _, month_name, day, year, hour_text, minute, meridiem = match.groups()
    month = month_number(month_name)
    if month is None:
        return None
    hour = int(hour_text)
    if meridiem == "PM" and hour != 12:
        hour += 12
    elif meridiem == "AM" and hour == 12:
        hour = 0
    try:
        return datetime(int(year), month, int(day), hour, int(minute), tzinfo=UTC)
    except ValueError:
        return None


def near_jan_first(month: int, day: int) -> bool:
    """Whether a date is one of the days a flight moved to January 1st spans."""
    return month == 1 and 1 <= day <= 1 + MAX_DAYS_AFTER_JAN_1


# Unix time, in seconds or milliseconds, in a data value
# ("<value>1710406320</value>"), a name ("Flight 1710406320") or anywhere
# else in the text: ten or thirteen digits that are no part of a longer
# number. The fraction of a decimal number (12.1710406320) is none either,
# but a dot after a word ("log.1710406320") is only a separator.
EPOCH_PATTERN = re.compile(r"(?<!\d)(?<!\d\.)(\d{13}|\d{10})(?:\.\d+)?(?!\d)")
# Before 2000 a ten-digit number is no time a flight log would hold
_EPOCH_START = datetime(2000, 1, 1, tzinfo=UTC).timestamp()
# The latest a recorded flight can be: its time is never in the future. A
# day of slack covers a clock ahead of UTC.
_EPOCH_SLACK = timedelta(days=1)


def epoch_is_obfuscated(value: str) -> bool:
    """Whether a Unix time gives neither a date nor a time of day away.

    The rewrite leaves data values alone, so only midnight passes, on
    January 1st or the days a flight runs into after it.
    """
    seconds = int(value) / (1000 if len(value) == 13 else 1)
    latest = (datetime.now(UTC) + _EPOCH_SLACK).timestamp()
    if not _EPOCH_START <= seconds < latest:
        # Not the time of a past flight: a phone number, a serial number
        return True
    dt = datetime.fromtimestamp(seconds, tz=UTC)
    return near_jan_first(dt.month, dt.day) and dt.time() == time()


def epoch_spans(text: str) -> list[tuple[int, int]]:
    """The Unix times of past flights in a text that give the flight away.

    Those ``epoch_is_obfuscated`` does not let pass: the obfuscator's check
    reports them, the rewrite takes them out of names and descriptions and
    ``strip_dates`` out of what the site publishes.
    """
    return [
        match.span()
        for match in EPOCH_PATTERN.finditer(text)
        if not epoch_is_obfuscated(match.group(1))
    ]


def _is_day_month(first: str, second: str, runways: bool) -> bool:
    """Whether two numbers around a slash are a day and a month.

    Either order, since "08/16" is August 16th in the US. Two numbers of
    one digit are more often a fraction ("1/2"), and in a name that speaks
    of runways (``runways``) a pair of runway directions is a runway (see
    ``_RUNWAY_DIFFERENCE``).
    """
    if len(first) == len(second) == 1:
        return False
    a, b = int(first), int(second)
    if runways and abs(a - b) == _RUNWAY_DIFFERENCE:
        return False
    return (1 <= a <= 31 and 1 <= b <= 12) or (1 <= a <= 12 and 1 <= b <= 31)


def _day_month_slashed_spans(text: str) -> list[tuple[int, int]]:
    runways = _RUNWAY_WORD.search(text) is not None
    return [
        match.span()
        for match in _DAY_MONTH_SLASHED.finditer(text)
        if _is_day_month(
            match["first"] or match["first_h"],
            match["second"] or match["second_h"],
            runways,
        )
    ]


def _day_month_dotted_spans(text: str) -> list[tuple[int, int]]:
    """The days and months with dots, but none of a version ("v 12.10")."""
    return [
        match.span()
        for match in _DAY_MONTH_DOTTED.finditer(text)
        if not _VERSION_WORD.search(text, 0, match.start())
    ]


def _with_time_after(text: str, spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """The spans of dates, each with the time of day that follows it.

    The year of the next date in a list ("2026-08-16 2026-08-17") is no time
    of the one before it.
    """
    starts = sorted({start for start, _ in spans})
    extended = []
    for start, end in spans:
        time = _TIME_AFTER_DATE.match(text, end)
        # Whether another date starts after this one ends, before the time
        # does
        overlaps = time is not None and (
            bisect_left(starts, time.end()) > bisect_right(starts, end)
        )
        extended.append((start, time.end() if time and not overlaps else end))
    return extended


def _weekday_start_before(text: str, start: int) -> int:
    """Where the abbreviated weekdays right before ``start`` begin, if any.

    One or more of them, with spaces or underscores between them and before
    ``start``; ``start`` without one. Each is looked for in the few
    characters before the last: a pattern for all of them, searched in all
    of the text before every date, took cubic time on a long run of them.
    """
    found = start
    end = start
    while True:
        position = end
        while position > 0 and (
            text[position - 1].isspace() or text[position - 1] == "_"
        ):
            position -= 1
        if found != start and position == end:
            # Two of them with nothing between are no two weekdays
            return found
        match = _WEEKDAY_BEFORE_DATE.search(
            text, max(0, position - _WEEKDAY_ABBREVIATION_LENGTH), position
        )
        if match is None:
            return found
        found = end = match.start()


def _with_weekday_around(
    text: str, spans: list[tuple[int, int]]
) -> list[tuple[int, int]]:
    """The spans of dates, each with the abbreviated weekday next to it."""
    extended = []
    for start, end in spans:
        after = _WEEKDAY_AFTER_DATE.match(text, end)
        extended.append(
            (_weekday_start_before(text, start), after.end() if after else end)
        )
    return extended


def _day_number(day_text: str | None) -> int:
    # A month with a year but no day gives the month away as well
    return int(re.sub(r"[a-z]+$", "", day_text)) if day_text else 1


def _german_month_number(name: str) -> int | None:
    return _GERMAN_MONTH_NUMBERS.get(name.lower())


def any_month_number(name: str) -> int | None:
    """The number of an English or German month name, in any case."""
    return month_number(name) or _german_month_number(name)


def _text_month_spans(
    pattern: re.Pattern[str],
    text: str,
    skip_near_jan_first: bool,
    months: Callable[[str], int | None] = month_number,
) -> list[tuple[int, int]]:
    """The dates with a month name that ``pattern`` finds in a text.

    ``months`` gives the number of a month name, None for a word that is no
    month name.
    """
    spans = []
    for match in pattern.finditer(text):
        groups = match.groupdict()
        month_name = next(
            (value for key, value in groups.items() if key[:5] == "month" and value),
            "",
        )
        month = months(month_name)
        if month is None:
            continue
        day_key, day_text = next(
            (
                (key, value)
                for key, value in groups.items()
                if key[:3] == "day" and value
            ),
            ("", None),
        )
        day = _day_number(day_text)
        start = match.start()
        days = [day]
        before = groups.get("range_days")
        if before:
            first = _numbers(before)
            if _ascending_days([*first, day]):
                days[:0] = first
            else:
                # No range: the numbers before are a type ("PA-28-16 Aug
                # 2026"), a route or a leg, and stay
                start = match.start(day_key)
        after = groups.get("range_days_after")
        if after:
            days.extend(_numbers(after))
        dates = [(month, day) for day in days]
        dates.extend(
            (number, 1)
            for name in _MONTH_WORD.findall(groups.get("range_months") or "")
            if (number := any_month_number(name)) is not None
        )
        # A range passes only when all of it does: "Dec/Jan 2026" and "Jan
        # 1-20, 2026" give away more than January 1st
        if skip_near_jan_first and all(near_jan_first(*date) for date in dates):
            continue
        spans.append((start, match.end()))
    return spans


# The words of a range of months (_MONTHS_BEFORE), umlauts included
_MONTH_WORD = re.compile(r"[^\W\d_]+")


def _ascending_days(days: list[int]) -> bool:
    """Whether numbers are the days of a range: days that go up."""
    return all(1 <= day <= 31 for day in days) and all(a < b for a, b in pairwise(days))


def _roman_month_number(name: str) -> int | None:
    return _ROMAN_MONTH_NUMBERS.get(name)


def _date_spans(text: str) -> list[tuple[int, int]]:
    """The dates of ``find_date_tokens`` in a text, January 1st included."""
    spans = [
        match.span() for pattern in _NUMERIC_ALL for match in pattern.finditer(text)
    ]
    spans.extend(_text_month_spans(_TEXT_MONTH, text, skip_near_jan_first=False))
    spans.extend(
        _text_month_spans(_TEXT_MONTH_GERMAN, text, False, _german_month_number)
    )
    spans.extend(_text_month_spans(_ROMAN_DATE, text, False, _roman_month_number))
    spans.extend(match.span() for match in _FLIGHT_PLAN_DATE.finditer(text))
    return spans


def _full_date_spans(text: str, skip_near_jan_first: bool) -> list[tuple[int, int]]:
    """The spans of ``find_date_tokens`` in a text whose dashes are hyphens."""
    numeric = _NUMERIC_STRAY if skip_near_jan_first else _NUMERIC_ALL
    spans = [match.span() for pattern in numeric for match in pattern.finditer(text)]
    spans.extend(
        _text_month_spans(_TEXT_MONTH, text, skip_near_jan_first)
        + _text_month_spans(
            _TEXT_MONTH_GERMAN, text, skip_near_jan_first, _german_month_number
        )
        + _text_month_spans(
            _TEXT_MONTH_SHORT_YEAR, text, skip_near_jan_first, any_month_number
        )
        + _text_month_spans(_ROMAN_DATE, text, skip_near_jan_first, _roman_month_number)
    )
    spans.extend(
        match.span()
        for match in _FLIGHT_PLAN_DATE.finditer(text)
        if not skip_near_jan_first
        or not near_jan_first(int(match["month"]), int(match["day"]))
    )
    return spans


def find_date_tokens(text: str, *, skip_near_jan_first: bool = False) -> list[str]:
    """The date-like tokens of a text, in the order of the patterns.

    With ``skip_near_jan_first`` the dates within ``MAX_DAYS_AFTER_JAN_1``
    days after January 1st are left out: those of an obfuscated file.
    """
    return [
        text[start:end]
        for start, end in _full_date_spans(text.translate(_DASHES), skip_near_jan_first)
    ]


def _numbers(text: str) -> list[int]:
    return [int(number) for number in re.findall(r"\d+", text)]


def _partial_near_jan_first(kind: str, text: str) -> bool:
    """Whether a part of a date (``_partial_date_spans``) is of January 1st.

    As with the numeric shapes of a full date, those without a month name
    only pass as January 1st itself: "02/01" is February 1st in the US.
    """
    numbers = _numbers(text)
    if kind == "dotted":
        return near_jan_first(numbers[1], numbers[0])
    if kind == "slashed":
        return numbers[:2] == [1, 1]
    if kind == "week":
        return numbers[-1] == 1
    if kind == "season":
        return _SEASON_NEAR_JAN_FIRST.search(text) is not None
    if kind == "six":
        digits = "".join(str(number) for number in numbers).zfill(6)
        return near_jan_first(int(digits[2:4]), int(digits[4:])) or near_jan_first(
            int(digits[2:4]), int(digits[:2])
        )
    # A month and a year, either way round
    return 1 in numbers


def _partial_date_spans(text: str, skip_near_jan_first: bool) -> list[tuple[int, int]]:
    """The parts of dates that ``strip_dates`` takes out besides the dates.

    A day and a month without the year, a calendar week without it, six
    digits that are a date, a month with its year and a season, quarter or
    half of a year with it, found in ``text``
    (whose dashes are hyphens) once its dates are out. With
    ``skip_near_jan_first`` those of January 1st are left out.
    """
    rest = _blank(text, _with_time_after(text, _date_spans(text)))
    spans = (
        _text_month_spans(_TEXT_MONTH_WITHOUT_YEAR, rest, skip_near_jan_first)
        + _text_month_spans(
            _TEXT_MONTH_GERMAN_WITHOUT_YEAR,
            rest,
            skip_near_jan_first,
            _german_month_number,
        )
        + _text_month_spans(
            _ROMAN_DAY_MONTH, rest, skip_near_jan_first, _roman_month_number
        )
        + _text_month_spans(
            _ROMAN_MONTH_YEAR, rest, skip_near_jan_first, _roman_month_number
        )
    )
    for kind, found in (
        ("dotted", _day_month_dotted_spans(rest)),
        ("slashed", _day_month_slashed_spans(rest)),
        ("week", _week_only_spans(rest)),
        ("six", [match.span() for match in _SIX_DIGIT_DATE.finditer(rest)]),
        ("month", _month_year_spans(rest)),
        ("season", _season_spans(rest)),
    ):
        spans.extend(
            (start, end)
            for start, end in found
            if not (
                skip_near_jan_first and _partial_near_jan_first(kind, rest[start:end])
            )
        )
    return spans


def find_partial_date_tokens(text: str) -> list[str]:
    """The parts of dates in a name that are no January 1st.

    "16 Aug", "16.08.", "16/08", "KW33", "260816" and "03/2026" name the day
    or the month of a flight once the year of the flight completes them,
    and so does an abbreviated weekday next to a date ("Sat" in "Sat 01 Jan
    2026"). The obfuscator's check reports them in names, descriptions and
    file names, which the site and the repository publish.
    """
    plain = text.translate(_DASHES)
    dates = _date_spans(plain)
    partial = _partial_date_spans(plain, skip_near_jan_first=True)
    found = [text[start:end] for start, end in _with_weekday_around(plain, partial)]
    for (start, end), (before, after) in zip(
        dates, _with_weekday_around(plain, dates), strict=True
    ):
        found.extend(
            text[low:high].strip(" ,_.()[]")
            for low, high in ((before, start), (end, after))
            if high > low
        )
    return found


def stray_date_spans(text: str) -> list[tuple[int, int]]:
    """Where a name or a description gives the day of a flight away.

    Everything the obfuscator's check reports in it: the dates that are no
    January 1st (``find_date_tokens`` with ``skip_near_jan_first``), the
    parts of dates (``find_partial_date_tokens``), the times of day, those
    after a date of January 1st included, the weekdays and the abbreviated
    weekdays next to a date or a time of day, and the holidays. The dates
    of January 1st stay: the parser may read the year of a flight from
    them. The Unix times are the caller's (``epoch_spans``).
    """
    plain = text.translate(_DASHES)
    dates = _date_spans(plain)
    stray = set(_full_date_spans(plain, skip_near_jan_first=True))
    with_times = _with_time_after(plain, dates)
    spans: list[tuple[int, int]] = []
    for (start, end), (before, after) in zip(
        dates, _with_weekday_around(plain, with_times), strict=True
    ):
        if (start, end) in stray:
            spans.append((before, after))
        else:
            # The date of January 1st stays, what stands around it goes
            spans.extend(
                span for span in ((before, start), (end, after)) if span[1] > span[0]
            )
    partial = _partial_date_spans(plain, skip_near_jan_first=True)
    spans.extend(_with_weekday_around(plain, _with_time_after(plain, partial)))
    rest = _blank(
        plain,
        with_times + _partial_date_spans(plain, skip_near_jan_first=False),
    )
    # An abbreviated weekday goes with a time next to it as well: in "Sat
    # 14:30 16 Aug 2026" it is next to the date once the time is out
    spans.extend(
        _with_weekday_around(
            plain,
            [
                match.span()
                for pattern in (_TIME_OF_DAY, _TIME_OF_DAY_WORDS, _COMPACT_TIME)
                for match in pattern.finditer(rest)
            ],
        )
    )
    spans.extend(
        match.span()
        for pattern in (_WEEKDAY, _HOLIDAY)
        for match in pattern.finditer(rest)
    )
    return spans


def find_holiday_tokens(text: str) -> list[str]:
    """The holidays named in a text ("Christmas Eve", "Ostermontag").

    The obfuscator's check reports them anywhere, as it does the weekdays:
    with the year of the flight they name its day.
    """
    return [match.group(0) for match in _HOLIDAY.finditer(text)]


def find_weekday_tokens(text: str) -> list[str]:
    """The weekdays named in full in a text ("Sunday", "Sonntagsflug").

    The obfuscator's check reports them anywhere: the timestamps of a file
    move to January 1st, its weekdays would not.
    """
    return [match.group(0) for match in _WEEKDAY.finditer(text)]


def find_time_tokens(text: str) -> list[str]:
    """The times of day of a text, those ``strip_dates`` takes out.

    The obfuscator's check reports them in file names, which it keeps free
    of the time of a flight as it does of the date (the time of a
    Charterware name becomes a sequence number), and in the content of a
    file without its timestamps, which start every flight at midnight.
    """
    plain = text.translate(_DASHES)
    dates = _date_spans(plain)
    with_times = _with_time_after(plain, dates)
    found = []
    for (_, end), (_, stop) in zip(dates, with_times, strict=True):
        if stop > end:
            time = plain[end:stop]
            found.append(text[stop - len(time.lstrip("-_, \t")) : stop])
    rest = _blank(plain, with_times)
    found.extend(
        text[match.start() : match.end()].strip()
        for pattern in (_TIME_OF_DAY, _TIME_OF_DAY_WORDS, _COMPACT_TIME)
        for match in pattern.finditer(rest)
    )
    return found


def strip_dates(text: str | None) -> str | None:
    """A name without its dates and times of day, None when nothing is left.

    Every date shape of ``find_date_tokens`` is taken out, and so are a day
    and month without a year ("16 Aug", "16/08", "16-08", "26.08",
    "16.VII."), six digits that are a date ("260816"), a time of day
    ("14:30", "1430Z", "1430L", "1430h", "14h30", "14.30 Uhr", "1430 GMT",
    "0930 hours") with its zone, fraction and offset, a weekday ("Sunday",
    "Sonntag", and "Sat" or "Sa." next to a date or a time), a holiday
    ("Christmas Eve", "Ostermontag") and a Unix time of a flight
    (``epoch_spans``). The separators the date stood between go with it
    ("EDDS to EDDP - 16 Aug 2026" is "EDDS to EDDP"). A name without a
    single letter left says nothing and is None. A dash other than the
    hyphen comes out as one where the name changes. What is left holds
    nothing of this either: the result is stripped again until it stays
    the same ("Sat Sat 16 Aug" loses both).

    Runway designators (RWY 08/26, 07L/25R), frequencies (118.500),
    altitudes and squawks (7000, FL100) are no dates and stay, and so are
    aircraft types and registrations (C172, DA20, N1430Z).
    """
    stripped = _stripped_once(text)
    # Every pass that changes the name makes it shorter but for the dashes,
    # which the first pass replaces already
    for _ in range(len(text or "")):
        if stripped is None:
            break
        again = _stripped_once(stripped)
        if again == stripped:
            break
        stripped = again
    return stripped


def _stripped_once(text: str | None) -> str | None:
    """One pass of ``strip_dates``."""
    if not text:
        return None
    plain = text.translate(_DASHES)
    spans = _date_spans(plain)
    # The common case, and the one that keeps a name exactly as it was
    if (
        not spans
        and not _TEXT_MONTH_WITHOUT_YEAR.search(plain)
        and not _TEXT_MONTH_GERMAN_WITHOUT_YEAR.search(plain)
        and not _day_month_dotted_spans(plain)
        and not _day_month_slashed_spans(plain)
        and not _week_only_spans(plain)
        and not _SIX_DIGIT_DATE.search(plain)
        and not _month_year_spans(plain)
        and not _season_spans(plain)
        and not _TIME_OF_DAY.search(plain)
        and not _TIME_OF_DAY_WORDS.search(plain)
        and not _COMPACT_TIME.search(plain)
        and not _WEEKDAY.search(plain)
        and not _HOLIDAY.search(plain)
        and not _ROMAN_DAY_MONTH.search(plain)
        and not _ROMAN_MONTH_YEAR.search(plain)
        and not EPOCH_PATTERN.search(plain)
    ):
        return text if any(c.isalpha() for c in text) else None

    stripped = _blank(
        plain,
        _with_weekday_around(plain, _with_time_after(plain, spans))
        + epoch_spans(plain),
    )
    stripped = _blank(
        stripped,
        _with_weekday_around(
            stripped,
            _with_time_after(
                stripped,
                _text_month_spans(_TEXT_MONTH_WITHOUT_YEAR, stripped, False)
                + _text_month_spans(
                    _TEXT_MONTH_GERMAN_WITHOUT_YEAR,
                    stripped,
                    False,
                    _german_month_number,
                )
                + _day_month_dotted_spans(stripped)
                + _day_month_slashed_spans(stripped)
                + _week_only_spans(stripped)
                + _text_month_spans(
                    _ROMAN_DAY_MONTH, stripped, False, _roman_month_number
                )
                + _text_month_spans(
                    _ROMAN_MONTH_YEAR, stripped, False, _roman_month_number
                )
                + [match.span() for match in _SIX_DIGIT_DATE.finditer(stripped)]
                + _month_year_spans(stripped)
                + _season_spans(stripped),
            )
            + [match.span() for match in _TIME_OF_DAY.finditer(stripped)]
            + [match.span() for match in _TIME_OF_DAY_WORDS.finditer(stripped)]
            + [match.span() for match in _COMPACT_TIME.finditer(stripped)],
        )
        + [match.span() for match in _WEEKDAY.finditer(stripped)]
        + [match.span() for match in _HOLIDAY.finditer(stripped)],
    )
    stripped = _tidy(stripped)
    return stripped if any(c.isalpha() for c in stripped) else None


def _tidy(text: str) -> str:
    """What is left around removed dates, without the separators they left."""
    # The spaces first: the separators around a long run of them took
    # quadratic time to find
    text = _SPACES.sub(" ", _EMPTY_BRACKETS.sub(" ", text))
    text = _DOUBLE_SEPARATORS.sub(lambda m: f" {m.group(1)} ", text)
    text = _SPACES.sub(" ", text)
    return _EDGE_SEPARATORS.sub("", text)


# What stands between the words around a removed date, which goes with it
_JOINT = re.compile(r"[ \t\r\n,;:/|_-]*")


def _merged(text: str, spans: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Spans sorted and joined where only separators stand between them."""
    merged: list[tuple[int, int]] = []
    for start, end in sorted(span for span in spans if span[1] > span[0]):
        if merged and _JOINT.fullmatch(text, merged[-1][1], start):
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    return merged


def _joint(before: str, after: str) -> str:
    """What joins the text around a removed date: one of the separators.

    A line break where one stood ("16 Aug\nback"), else a separator other
    than a space where one stood (" - ", ", "), else a space where one
    stood, else nothing.
    """
    for joint in (before, after):
        if "\n" in joint:
            return joint[joint.index("\n") :].rstrip(" \t") or "\n"
    for joint in (before, after):
        if joint.strip():
            return joint
    return " " if before or after else ""


def without_spans(text: str, spans: list[tuple[int, int]]) -> str:
    """``text`` without ``spans``, with the separators around each joined.

    Only what stands right next to a removed span changes: the separators
    on its two sides become one ("EDDS - 16 Aug 2026 - EDDF" is "EDDS -
    EDDF"), and brackets left empty go. A URL, a line break or a double
    comma elsewhere stays as it was. The text itself where there is
    nothing to take out.
    """
    if not spans:
        return text
    kept = ""
    position = 0
    for span_start, span_end in _merged(text, spans):
        if span_end <= position:
            continue
        head = text[position : max(span_start, position)]
        tail = _JOINT.match(text, span_end)
        assert tail is not None  # noqa: S101 - the pattern matches empty
        resume = tail.end()
        core = head.rstrip(" \t\r\n,;:/|_-")
        joint_after = text[span_end:resume]
        # Brackets around nothing but the date go with it: "Trip (16 Aug)"
        if core.endswith(("(", "[")) and text[resume : resume + 1] in (")", "]"):
            head = core[:-1]
            core = head.rstrip(" \t\r\n,;:/|_-")
            after = _JOINT.match(text, resume + 1)
            assert after is not None  # noqa: S101 - the pattern matches empty
            joint_after = text[resume + 1 : after.end()]
            resume = after.end()
        joint_before = head[len(core) :]
        at_an_end = not (kept or core) or resume >= len(text)
        kept += core + ("" if at_an_end else _joint(joint_before, joint_after))
        position = resume
    return kept + text[position:]


def _blank(text: str, spans: list[tuple[int, int]]) -> str:
    """``text`` with every span replaced by a space."""
    if not spans:
        return text
    parts: list[str] = []
    position = 0
    for start, end in sorted(spans):
        if end <= position:
            continue
        begin = max(start, position)
        parts += (text[position:begin], " " * (end - begin))
        position = end
    parts.append(text[position:])
    return "".join(parts)
