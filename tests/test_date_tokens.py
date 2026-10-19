"""Tests for date_tokens module."""

from datetime import date

import pytest
from hypothesis import given
from hypothesis import strategies as st

from flown.date_tokens import (
    any_month_number,
    find_date_tokens,
    find_holiday_tokens,
    find_partial_date_tokens,
    find_possible_date_tokens,
    find_time_tokens,
    find_weekday_tokens,
    month_number,
    stray_date_spans,
    strip_dates,
    without_spans,
)
from tests.conftest import LINEAR_GROWTH, growth


class TestFindDateTokens:
    @pytest.mark.parametrize(
        "text",
        [
            "2024-03-14",
            "2024_03_14",
            "2024.03.14",
            "14.03.2024",
            "3/14/2024",
            "2026/8/16",
            "2026/08/6",
            "2026-8-16",
            "2026_8_6",
            "20240314",
            "2024-03",
            "2024-W11",
            "2024-074",
            "14 Mar 2024",
            "14 Sept 2024",
            "March 14, 2024",
            "March 2024",
            # German, the day first
            "14. März 2024",
            "14. Maerz 2024",
            "14.Mrz.2024",
            "14-Okt-2024",
            "24. Dez. 2024",
            "14 JULI 2024",
            "Mai 2024",
            "Dezember 2024",
            # With slashes, and the year first
            "16/Aug/2024",
            "Aug/16/2024",
            "2024/Aug/16",
            "2024-Aug-16",
            # A day and month name with a two-digit year
            "16 Aug 24",
            "16-AUG-24",
            "16AUG24",
            "16/Aug/24",
            "16MAI24",
            # The date of flight of an ICAO flight plan
            "DOF/240816",
            # Underscores and spaces between the numbers
            "16_08_2024",
            "16 08 2024",
            "16 - 08 - 2024",
            "8 16 2024",
            # A calendar week with its year, and the ISO week without the
            # hyphen
            "KW33 2024",
            "KW 33/2024",
            "Week 33 2024",
            "week 33/2024",
            "W33 2024",
            "2024W33",
            "2024W336",
            # "of" between the day and the month
            "16th of August 2024",
        ],
    )
    def test_every_shape_is_found(self, text):
        assert find_date_tokens(f"x {text} y") == [text]

    @pytest.mark.parametrize(
        "text",
        ["20260816143015", "flight_202608161430", "Log_20260816-1430"],
    )
    def test_a_compact_date_with_its_time_is_found(self, text):
        """The time of day right after it no longer hides the date."""
        assert find_date_tokens(text) == ["20260816"]

    @pytest.mark.parametrize(
        "text",
        [
            "2024-01-02",
            "2024_01_02",
            "01.01.2024",
            "20240101",
            "2024-01",
            "1 Jan 2024",
            "2024/1/1",
            "2024-1-3",
            "2024_01_2",
            "1. Januar 2024",
            "3. Jänner 2024",
            "Januar 2024",
            "2024/Jan/2",
            "1 JAN 24",
            "01JAN24",
            "DOF/240103",
            "01_01_2024",
            "01 01 2024",
            "KW1 2024",
            "2024W01",
            "202401010000",
        ],
    )
    def test_the_days_after_jan_first_pass_only_when_asked(self, text):
        assert find_date_tokens(text) != []
        assert find_date_tokens(text, skip_near_jan_first=True) == []

    def test_no_month_no_date(self):
        assert find_date_tokens("Runway 25 2024") == []

    @pytest.mark.parametrize(
        "text",
        [
            # Versions are written with dots, and 2024.3.1 is one as often
            "ForeFlight 2024.3.1",
            # No month 13, no century before 1900
            "2026/13/1",
            "1234-5-6",
            # Without a year the check has nothing to go by
            "16/08",
            "Runway 08/26",
            "1430Z",
            # German month names only count next to a day or a year
            "Mai 16",
            "Maier 2026",
            "Juli 7000",
            "16. Mai",
            # A letter before a German month name makes it another word,
            # an umlaut as well; an underscore does not (see below)
            "Ämai 2026",
            "Rosenmai 2026",
            # A time is no two-digit year, nor is anything after other
            # separators than those between the day and the month
            "16 Aug 14:30",
            "16-Aug 26",
            "DOF/261316",
            # Numbers in a row: not both of one digit, a real day and month,
            # and a year of this or the last century
            "1 8 2024",
            "Heading 270 15 2024",
            "16 13 2024",
            "16 08 1024",
            "KW 54 2024",
            # Twelve digits that are no date and time, a week of a
            # registration, and a calendar week without its year
            "EDDS 123456789012",
            "EDDS 202613161430",
            "N2026W33",
            "2024W54",
            "W33",
            "Week 33",
        ],
    )
    def test_not_a_date_with_a_year(self, text):
        assert find_date_tokens(text) == []

    def test_a_german_month_after_an_underscore(self):
        # File names separate their words with underscores
        assert find_date_tokens("Flug_Mai_2026") == ["Mai_2026"]

    def test_a_time_is_no_year(self):
        # The four digits of a time of day are no year: the day, the month
        # and the two-digit year are the date, and nothing else
        assert find_date_tokens("Local flight 16-AUG-26 1430L") == ["16-AUG-26"]

    def test_a_date_near_jan_first_only_when_it_is_one(self):
        assert find_date_tokens("2024-1-4", skip_near_jan_first=True) == ["2024-1-4"]
        assert find_date_tokens("2024/2/1", skip_near_jan_first=True) == ["2024/2/1"]

    @pytest.mark.parametrize(
        "text",
        [
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "SUNDAY",
            "sunday",
            "Sundays",
            "Montag",
            "Dienstag",
            "Mittwoch",
            "Donnerstag",
            "Freitag",
            "Samstag",
            "Sonnabend",
            "Sonntag",
            "sonntags",
            "Sonntagsflug",
            "Samstagnachmittag",
        ],
    )
    def test_a_weekday_in_full(self, text):
        # Reported apart from the dates: the obfuscator rewrites none
        assert find_weekday_tokens(f"x_{text} y") == [text]
        assert find_date_tokens(f"x_{text} y") == []

    @pytest.mark.parametrize(
        "text",
        [
            # Abbreviations alone are words, codes and types of their own
            "Sun n Fun",
            "SAT",
            "Do 27",
            "EDMO",
            "Mo",
            "Wed",
            # Words that begin like a weekday
            "Montage",
            "Sundance",
            "Freitagen",
            # Places named after a weekday
            "KFHR Friday Harbor",
            "Thursday Island",
            "Sunday Creek",
            # A time of day is none either (see find_time_tokens)
            "1513h",
            "14:30",
        ],
    )
    def test_no_weekday(self, text):
        assert find_weekday_tokens(text) == []
        assert find_date_tokens(text) == []


class TestFindTimeTokens:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("1_DEHYL_1513h", ["1513h"]),
            ("1_DEHYL_15h13", ["15h13"]),
            ("EDDS 0930z", ["0930z"]),
            ("EDDS_0930Z", ["0930Z"]),
            ("EDDS 0930UTC", ["0930UTC"]),
            ("EDDS 1430hrs", ["1430hrs"]),
            ("EDDS 1430L", ["1430L"]),
            ("EDDS 15:13", ["15:13"]),
            ("EDDS 1513 Uhr", ["1513 Uhr"]),
            ("1_DEHYL_1513H", ["1513H"]),
            ("EDDS 1513 hrs", ["1513 hrs"]),
            ("EDDS 15.13h", ["15.13h"]),
            ("EDDS 1513 MEZ", ["1513 MEZ"]),
            ("EDDS 15:13 CEST", ["15:13 CEST"]),
            ("EDDS T15:13", ["T15:13"]),
            ("EDDS 3pm", ["3pm"]),
            ("EDDS 3 p.m.", ["3 p.m."]),
            ("EDDS_11.30am", ["11.30am"]),
            # The morning in capitals, which German "am" never is
            ("Flight at 10 AM", ["10 AM"]),
            ("Flight at 10 A.M.", ["10 A.M."]),
            ("Flight at 10AM", ["10AM"]),
            # Both ends of a range, the second after a hyphen
            ("EDAW 10 AM-12 PM EDAQ", ["10 AM", "12 PM"]),
            ("10 pm-12 pm", ["10 pm", "12 pm"]),
            ("10am-12pm", ["10am", "12pm"]),
            ("10AM-12PM", ["10AM", "12PM"]),
            ("10 am-12 pm", ["10 am", "12 pm"]),
            ("10:30am-1:15pm", ["10:30am", "1:15pm"]),
            ("9 a.m.-5 p.m.", ["9 a.m.", "5 p.m."]),
            ("EDDS-1513Z", ["1513Z"]),
            # After a date in any form, whether or not the date counts
            ("Log_2026-01-01_1430", ["1430"]),
            ("EDDS 20260816T1430", ["T1430"]),
            ("EDDS 16.08.2026, 15.13", ["15.13"]),
            # Zones of other countries, the local time and the hours, whole
            ("Home strip - Aunt farm 1430 GMT", ["1430 GMT"]),
            ("Aunt farm 1430 EST", ["1430 EST"]),
            ("Aunt farm 14:30 BST", ["14:30 BST"]),
            ("Aunt farm 09:30 EDT", ["09:30 EDT"]),
            ("Aunt farm 14:30 AEST", ["14:30 AEST"]),
            ("Aunt farm 14:30 local", ["14:30 local"]),
            ("Aunt farm 1430 local time", ["1430 local time"]),
            ("Aunt farm 0930 hours", ["0930 hours"]),
            ("Aunt farm 14:30 UTC+2", ["14:30 UTC+2"]),
            ("Takeoff 3:15 pm EST", ["3:15 pm EST"]),
            # A fraction of a second and a UTC offset along with the time
            ("Aunt farm 14:30 +02:00", ["14:30 +02:00"]),
            ("Aunt farm 14:30:00+0200", ["14:30:00+0200"]),
            ("Aunt farm 14:30:00.123Z", ["14:30:00.123Z"]),
            ("Aunt farm 14:30:00,5Z", ["14:30:00,5Z"]),
            ("EDDS T1430+0200", ["T1430+0200"]),
            ("EDDS 1430+0200", ["1430+0200"]),
            # After a compact date without a separator, and after a date as
            # hours and minutes with hyphens
            ("20260816143015", ["143015"]),
            ("flight_202608161430", ["1430"]),
            ("log-2026-08-16-14-30", ["14-30"]),
            ("log_2026_08_16_14_30_15", ["14_30_15"]),
            # A range, whole
            ("Block 0930Z-1045Z", ["0930Z-1045Z"]),
            ("Block 0930Z-1045", ["0930Z-1045"]),
            ("EDDS 1430L-1545L", ["1430L-1545L"]),
            ("EDDS 1430 LT-1545 LT", ["1430 LT-1545 LT"]),
            ("EDDS 1430 UTC-1545 UTC", ["1430 UTC-1545 UTC"]),
            ("EDDS 1430Z - 1545Z", ["1430Z", "1545Z"]),
            ("1_DEHYL_DA40-1430Z-1545Z", ["1430Z-1545Z"]),
            # Zulu, and the other common zones
            ("EDDS 1430 Zulu", ["1430 Zulu"]),
            ("EDDS 1430 ZULU", ["1430 ZULU"]),
            ("EDDS 1430 UT", ["1430 UT"]),
            ("EDDS 1430 WET", ["1430 WET"]),
            ("EDDS 1430 WEST", ["1430 WEST"]),
            ("EDDS 1430 LOC", ["1430 LOC"]),
            ("EDDS 1430 lcl", ["1430 lcl"]),
            ("EDDS 14:30 IDT", ["14:30 IDT"]),
            ("EDDS 14:30 SAST", ["14:30 SAST"]),
            ("EDDS 14:30 JST", ["14:30 JST"]),
            ("EDDS 14:30 HKT", ["14:30 HKT"]),
            ("EDDS 14:30 SGT", ["14:30 SGT"]),
            # A dot or an "h" with a zone, the local time or the hours
            ("EDDS 14.30Z", ["14.30Z"]),
            ("EDDS 14.30 UTC", ["14.30 UTC"]),
            ("EDDS 9.30 CET", ["9.30 CET"]),
            ("EDDS 14.30L", ["14.30L"]),
            ("EDDS 14.30 hrs", ["14.30 hrs"]),
            ("EDDS 14h30Z", ["14h30Z"]),
            ("EDDS 9h30 UTC", ["9h30 UTC"]),
        ],
    )
    def test_times(self, text, expected):
        assert find_time_tokens(text) == expected

    @pytest.mark.parametrize(
        "text",
        [
            "1_DEHYL_DA40",
            "1_DEAGJ_C172",
            # Registrations: a letter, or a nationality prefix and its hyphen
            "N1430Z",
            "N1513H",
            "N0930Z",
            "1_N1513H_C172",
            "RA-1513H",
            "HB-1430L",
            "Mi-8AM",
            # Hours and minutes that are no time of day
            "TT 2500h",
            "EDDS 1h30 flight",
            "EDDS 1.5h",
            "Flug 3 am Rhein",
            "EDDS 1 AMSTERDAM",
            # After a hyphen without a time before it: a type or a registration
            "Mi-8 PM",
            "PA-1 PM",
            "Mi-8PM",
            "3 am-Treffen",
            "Squawk 7000",
            "FL100 1430",
            "2026-08-16",
            "LOAV-LOAV",
            # Frequencies, runways, codes and years, whatever follows them
            "EDDS 123.45 EST",
            "RWY 09/27 local",
            "EDDS 2026",
            "Squawk 7000 hours",
            "EDDS 1200 ist gut",
            "EDDS 1430 ESTATE",
            # "14.30" is a decimal as often (fuel, a distance)
            "Aunt farm 14.30",
            # A frequency, a version, durations and litres
            "EDDS 118.30 UTC",
            "v14.30Z",
            "EDDS 1.30 hrs",
            "Fuel 5.30L",
            "Fuel 14.30 l",
            # Registrations and types with hyphens, ranges and offsets that
            # are none
            "HB-EST",
            "OE-KLT",
            "PA-28-181",
            "A320-214",
            "B737-800",
            "EDDS 1000-2000 ft",
            "EDDS 1200-1400",
            "EDDS 1430+02",
            # Zulu and localizer without a time, METAR winds
            "ATIS Zulu",
            "ILS 27 LOC",
            "27015G25KT",
        ],
    )
    def test_no_times(self, text):
        assert find_time_tokens(text) == []


class TestStripDates:
    @pytest.mark.parametrize(
        ("text", "expected"),
        [
            ("EDDS Stuttgart", "EDDS Stuttgart"),
            # Unchanged when there is no date, separators and all
            ("Niort - Marais Poitevin.", "Niort - Marais Poitevin."),
            ("Sunday flight 16 Aug 2026", "flight"),
            ("EDDS to EDDP - 16 Aug 2026", "EDDS to EDDP"),
            ("EDDS - 16.08.2026 - EDDP", "EDDS - EDDP"),
            ("EDDS (2026-08-16) Stuttgart", "EDDS Stuttgart"),
            ("Flight 16 August", "Flight"),
            ("August 16th flight", "flight"),
            ("Log_2026_08_16", "Log"),
            ("Sept 16 flight", "flight"),
            ("EDDS 16.08.", "EDDS"),
            ("Version 1.2.3 EDDS", "Version 1.2.3 EDDS"),
            ("Runway 09/27 EDDS 25R", "Runway 09/27 EDDS 25R"),
            ("Flugplatz 2000", "Flugplatz 2000"),
            ("EDDS 08:50 Z", "EDDS"),
            # The half of the day goes with the time after a date
            ("Flight 8/16/26 2:30 PM home", "Flight home"),
            ("Flight 8/16/26 2:30 p.m. home", "Flight home"),
            ("16.08.2026 9:30am EDDS", "EDDS"),
            # " am" after it is German for "at the", and stays
            ("16.08.2026, 15.13 am Platz", "am Platz"),
            ("Takeoff 3:15 pm", "Takeoff"),
            ("Flight at 10 AM", "Flight at"),
            ("Off blocks 10 AM", "Off blocks"),
            ("Block 10am-12pm EDDS", "Block - EDDS"),
            ("Block 10 am-12 pm EDDS", "Block - EDDS"),
            ("Block 9 a.m.-5 p.m. EDDS", "Block - EDDS"),
            ("Mi-8 PM", "Mi-8 PM"),
            ("Mayfield 12", "Mayfield 12"),
            ("DA40", "DA40"),
            # A day and month without the year, in either order
            ("Aunt farm 16/08", "Aunt farm"),
            ("Home strip - Aunt farm 16/08", "Home strip - Aunt farm"),
            ("Aunt farm 08/16", "Aunt farm"),
            ("Aunt farm 16/8", "Aunt farm"),
            ("(16/08) Aunt farm", "Aunt farm"),
            # August 26th, whose day and month are 18 apart like the two
            # directions of a runway: only a name about runways has one
            ("Aunt farm 26/08", "Aunt farm"),
            ("EDDS 07/25", "EDDS"),
            # The aviation form with a two-digit year
            ("EDDS 16AUG26", "EDDS"),
            # German, with and without the year
            ("Rundflug 16. Mai 2026", "Rundflug"),
            ("EDDS 16.Mai.2026 EDDP", "EDDS EDDP"),
            ("EDDS 16-Mai-2026", "EDDS"),
            ("EDDS 16MAI26", "EDDS"),
            ("EDDS 16. Mai", "EDDS"),
            ("EDDS 3. März", "EDDS"),
            ("EDDS 24. Dez. 2026", "EDDS"),
            ("EDDS Mai 2026", "EDDS"),
            ("EDDS 16. August", "EDDS"),
            # A German month name alone is a name
            ("Mai", "Mai"),
            ("Flugplatz Juli", "Flugplatz Juli"),
            ("Juni EDDS", "Juni EDDS"),
            ("Maier 2026", "Maier 2026"),
            ("Mai 16 EDDS", "Mai 16 EDDS"),
            ("Squawk Juli 7000", "Squawk Juli 7000"),
            # A month and year without the day
            ("EDDS 03/2026", "EDDS"),
            ("EDDS 3/2026 EDDP", "EDDS EDDP"),
            ("EDDS 03.2026", "EDDS"),
            ("EDDS 2026/03", "EDDS"),
            # A year first with a month or day of one digit
            ("EDDS 2026/8/16", "EDDS"),
            ("EDDS 2026-8-6 EDDP", "EDDS EDDP"),
            # The time of day after a date, and nothing of it left behind
            ("EDDS 2026-08-16T14:30:00Z", "EDDS"),
            ("EDDS 2026-08-16T14:30:00.5+02:00 - EDDP", "EDDS - EDDP"),
            ("EDDS 20260816-1430", "EDDS"),
            ("Log_2026-08-16_1430", "Log"),
            ("16 Aug 2026 1430 EDDS", "EDDS"),
            ("Aunt farm 16/08 1430", "Aunt farm"),
            # Times of day without a colon
            ("EDDS 1430Z", "EDDS"),
            ("EDDS 1430 UTC", "EDDS"),
            ("EDDS 20260816T1430", "EDDS"),
            ("EDDS 20260816T143000Z", "EDDS"),
            ("EDDS T0850Z - EDDP", "EDDS - EDDP"),
            # Slashes around a month name, and the year first
            ("Rundflug 16/Aug/2026", "Rundflug"),
            ("EDDS Aug/16/2026", "EDDS"),
            ("EDDS 2026/Aug/16", "EDDS"),
            # A two-digit year after a separator, and a local time
            ("Local flight 16-AUG-26 1430L", "Local flight"),
            ("EDDS 16 Aug 26", "EDDS"),
            ("EDDS 1430 LT", "EDDS"),
            # German and French times, the date of an ICAO flight plan
            ("EDDS 14h30", "EDDS"),
            ("EDDS 14.30 Uhr", "EDDS"),
            ("Rundflug 9 Uhr EDDS", "Rundflug EDDS"),
            ("EDDS DOF/260816", "EDDS"),
            ("EDDS 260816", "EDDS"),
            ("EDDS 160826", "EDDS"),
            # A day and month without the last dot or with a hyphen
            ("EDDS 26.08", "EDDS"),
            ("EDDS 16-08 EDDP", "EDDS EDDP"),
            # ... with a month of one digit, and a decimal that looks like one
            ("Flight 16.8", "Flight"),
            ("Fuel 16.8 l", "Fuel l"),
            # Underscores and spaces between the numbers
            ("Flight 16_08_2026", "Flight"),
            ("Log_16_08", "Log"),
            ("EDDS 16_08 EDDP", "EDDS EDDP"),
            ("Flight 16 08 2026", "Flight"),
            ("Flight 16 - 08 - 2026 EDDS", "Flight EDDS"),
            # The German calendar week, with and without the year
            ("Flight KW33 2026", "Flight"),
            ("EDDS KW 33", "EDDS"),
            # "of" between the day and the month
            ("the 16th of August 2026 flight", "the flight"),
            ("EDDS 16th of Aug", "EDDS"),
            # A version is written with dots too
            ("Firmware 12.10 EDDS", "Firmware 12.10 EDDS"),
            ("EDDS app v 16.8", "EDDS app v 16.8"),
            # Runway directions without a word for a runway read as dates
            # ("07/25" is July 25th, and July 2025): the date goes
            ("Stuttgart 07/25", "Stuttgart"),
            ("EDDS 07-25", "EDDS"),
            # No dates: runways, frequencies, squawks, registrations, versions
            ("Runway 08/26 EDDS", "Runway 08/26 EDDS"),
            ("RWY 16/34 EDDS", "RWY 16/34 EDDS"),
            ("EDDS rwy 07/25, 09/27", "EDDS rwy 07/25, 09/27"),
            ("Landebahn 08/26", "Landebahn 08/26"),
            ("EDDS 07L/25R", "EDDS 07L/25R"),
            ("EDDS 118.500", "EDDS 118.500"),
            ("EDDS 118.30", "EDDS 118.30"),
            ("EDDS 1h30 flight", "EDDS 1h30 flight"),
            ("Heading 270-15", "Heading 270-15"),
            ("RWY 08-26 EDDS", "RWY 08-26 EDDS"),
            ("EDDS 5-10 kt", "EDDS 5-10 kt"),
            ("PA-28-181 EDDS", "PA-28-181 EDDS"),
            ("EDDS 1234567", "EDDS 1234567"),
            ("EDDS 999999", "EDDS 999999"),
            ("EDDS 123.45/121.5", "EDDS 123.45/121.5"),
            ("Squawk 7000 EDDS", "Squawk 7000 EDDS"),
            ("EDDS FL100 1430", "EDDS FL100 1430"),
            ("N1430Z Cessna", "N1430Z Cessna"),
            ("D-EAGJ EDDS", "D-EAGJ EDDS"),
            ("Half 1/2 tank", "Half 1/2 tank"),
            ("Wind 270/15 EDDS", "Wind 270/15 EDDS"),
            ("Dortmund/Wickede EDLW", "Dortmund/Wickede EDLW"),
            ("ForeFlight 2024.3.1", "ForeFlight 2024.3.1"),
            ("ForeFlight 2026.03", "ForeFlight 2026.03"),
            ("Circuit 3 of 45/60", "Circuit 3 of 45/60"),
            ("Circuits 3-2026", "Circuits 3-2026"),
            ("EDDS 2026 7000 ft", "EDDS 2026 7000 ft"),
            ("EDDS 1 8 2026", "EDDS 1 8 2026"),
            ("EDDS kW 100", "EDDS kW 100"),
            ("16_34_DA40", "16_34_DA40"),
            # Compact times of day, as a file name holds them
            ("1_DEHYL_1513h", "1_DEHYL"),
            ("1_DEHYL_15h13", "1_DEHYL"),
            ("EDDS 0930z", "EDDS"),
            ("EDDS 0930utc - EDDP", "EDDS - EDDP"),
            ("EDDS 1430hrs", "EDDS"),
            ("EDDS 15:13h", "EDDS"),
            ("EDDS 08:50 z", "EDDS"),
            ("EDDS 1513 Uhr", "EDDS"),
            ("Log_2026-08-16_1430hrs", "Log"),
            ("EDDS 16.08.2026, 15.13", "EDDS"),
            ("EDDS 3pm", "EDDS"),
            # Other zones, the local time and the hours go whole, and so do
            # a fraction and an offset: nothing of the time is left behind
            ("Home strip - Aunt farm 1430 GMT", "Home strip - Aunt farm"),
            ("Aunt farm 1430 EST", "Aunt farm"),
            ("Aunt farm 14:30 BST", "Aunt farm"),
            ("Aunt farm 09:30 EDT", "Aunt farm"),
            ("Aunt farm 14:30 AEST - EDDS", "Aunt farm - EDDS"),
            ("Aunt farm 14:30 local", "Aunt farm"),
            ("Aunt farm 0930 hours", "Aunt farm"),
            ("Aunt farm 14:30 hrs", "Aunt farm"),
            ("Aunt farm 14:30 GMT+1", "Aunt farm"),
            ("Aunt farm 14:30 +02:00", "Aunt farm"),
            ("Aunt farm 14:30:00+0200", "Aunt farm"),
            ("Aunt farm 14:30:00.123Z", "Aunt farm"),
            ("EDDS 2026-08-16T14:30:00,5+02:00 - EDDP", "EDDS - EDDP"),
            ("EDDS 16.08.2026 14:30 +02:00", "EDDS"),
            ("EDDS 12:00 +10 min", "EDDS +10 min"),
            ("EDDS 1430+0200", "EDDS"),
            # A compact date with its time, and a date and time all with
            # hyphens: nothing of them is left behind
            ("20260816143015", None),
            ("Log_20260816143015", "Log"),
            ("flight_202608161430", "flight"),
            ("log-2026-08-16-14-30", "log"),
            ("Log_2026_08_16_14_30", "Log"),
            # Both ends of a range
            ("Block 0930Z-1045Z", "Block"),
            ("Block 1430 LT-1545 LT", "Block"),
            ("Block 1430 UTC-1545 UTC", "Block"),
            ("EDDS 1430L-1545L EDDP", "EDDS EDDP"),
            ("1_DEHYL_DA40-1430Z-1545Z", "1_DEHYL_DA40"),
            # Zulu and the other common zones
            ("EDDS 1430 Zulu", "EDDS"),
            ("EDDS 1430 WEST - EDDP", "EDDS - EDDP"),
            ("EDDS 14:30 JST", "EDDS"),
            ("EDDS 1430 UT", "EDDS"),
            ("EDDS 1430 LOC", "EDDS"),
            # A dot or an "h" with a zone, the local time or the hours
            ("EDDS 14.30Z", "EDDS"),
            ("EDDS 14.30 UTC - EDDP", "EDDS - EDDP"),
            ("EDDS 14.30L", "EDDS"),
            ("EDDS 14.30 hrs", "EDDS"),
            ("EDDS 14h30Z", "EDDS"),
            ("EDDS 14h30 UTC", "EDDS"),
            # Weeks: the ISO week without the hyphen, and a week with or
            # without the year
            ("Flight 2026W33", "Flight"),
            ("EDDS Week 33", "EDDS"),
            ("EDDS W33 2026", "EDDS"),
            # Kept: "W33" alone is an airport code in the US, a range is no
            # time with an offset, a frequency or a version no dotted time,
            # and a METAR wind no time either
            ("W33 Friday Harbor", "W33 Friday Harbor"),
            ("EDDS W10", "EDDS W10"),
            ("EDDS 1200-1400", "EDDS 1200-1400"),
            ("EDDS 1000-2000 ft", "EDDS 1000-2000 ft"),
            ("EDDS 118.30 UTC", "EDDS 118.30 UTC"),
            ("EDDS 1.30 hrs", "EDDS 1.30 hrs"),
            ("EDDS 27015G25KT", "EDDS 27015G25KT"),
            ("ATIS Zulu", "ATIS Zulu"),
            ("ILS 27 LOC", "ILS 27 LOC"),
            ("HB-EST EDDS", "HB-EST EDDS"),
            ("A320-214 EDDS", "A320-214 EDDS"),
            ("EDDS 123456789012", "EDDS 123456789012"),
            # A number before "hours" loses it: a time of day as often
            ("Engine 1500 hours", "Engine"),
            # Kept: a decimal is no time ("fuel 14.30"), nor a frequency
            # before a zone's letters
            ("Aunt farm 14.30", "Aunt farm 14.30"),
            ("EDDS 123.45 EST", "EDDS 123.45 EST"),
            # A year before a zone is a time as well (20:26), and the year
            # is no secret
            ("Rundflug 2026 local", "Rundflug"),
            ("1_N1513H_C172", "1_N1513H_C172"),
            ("RA-1513H EDDS", "RA-1513H EDDS"),
            ("Mi-8AM", "Mi-8AM"),
            ("1513h", None),
            # Weekdays in full, English and German, and the forms of them
            ("EDDS - EDDF Saturday", "EDDS - EDDF"),
            ("Friday flight", "flight"),
            ("Sunday's flight EDDS", "flight EDDS"),
            ("Sundays EDDS", "EDDS"),
            ("EDDS_SAMSTAG", "EDDS"),
            ("Rundflug am Sonntag", "Rundflug am"),
            ("Sonntagsflug EDDS", "EDDS"),
            ("Samstagnachmittag EDDS", "EDDS"),
            ("Flight_Saturday_2026-08-16_1430", "Flight"),
            # Abbreviated only next to a date or a time
            ("Sat 16 Aug 2026 EDDS", "EDDS"),
            ("EDDS Sa., 16.08.2026", "EDDS"),
            ("EDDS 16.08.2026 (Sa)", "EDDS"),
            ("EDDS 2026-08-16 Sat", "EDDS"),
            ("EDDS Mo 16.08.", "EDDS"),
            ("EDDS SUN 16AUG26 1430Z", "EDDS"),
            ("Do 14:30 EDDS", "EDDS"),
            # Not weekdays: places, words, types and registrations
            ("KFHR Friday Harbor", "KFHR Friday Harbor"),
            ("Thursday Island", "Thursday Island"),
            ("Sunday Creek Airpark", "Sunday Creek Airpark"),
            ("Montage EDDS", "Montage EDDS"),
            ("Sun n Fun", "Sun n Fun"),
            ("Mo EDDS", "Mo EDDS"),
            ("Do 27 EDDS", "Do 27 EDDS"),
            ("SAT EDDS", "SAT EDDS"),
            ("EDMO 16.08.2026", "EDMO"),
            ("OE-SAT 16.08.2026", "OE-SAT"),
            ("D-EFRI 16.08.2026", "D-EFRI"),
            ("C172", "C172"),
            ("PA28", "PA28"),
            ("DA20", "DA20"),
            ("SR22", "SR22"),
            ("EDMO", "EDMO"),
            ("2026-08-16", None),
            ("16 Aug 2026 08:50 Z", None),
            ("1234", None),
            ("", None),
            (None, None),
        ],
    )
    def test_strip(self, text, expected):
        assert strip_dates(text) == expected

    @given(
        hour=st.integers(min_value=0, max_value=23),
        minute=st.integers(min_value=0, max_value=59),
        form=st.sampled_from(
            [
                "{h}{m}h",
                "{h}{m}H",
                "{h}{m} hrs",
                "{h}h{m}",
                "{h}.{m}h",
                "{h}{m}z",
                "{h}{m}Z",
                "{h}{m}UTC",
                "{h}:{m}",
                "{h}{m} GMT",
                "{h}{m} EST",
                "{h}{m} local",
                "{h}{m} hours",
                "{h}:{m} PDT",
                "{h}:{m} AEST",
                "{h}:{m} local time",
                "{h}:{m}:00.5Z",
                "{h}:{m}:00+02:00",
                "{h}:{m} -0500",
                "{h}{m} Zulu",
                "{h}{m} UT",
                "{h}{m} WEST",
                "{h}{m} JST",
                "{h}{m}+0200",
                "{h}.{m}Z",
                "{h}.{m} UTC",
                "{h}.{m}L",
                "{h}.{m} hrs",
                "{h}h{m}Z",
                "{h}h{m} CET",
            ]
        ),
        separator=st.sampled_from(["_", " ", " - "]),
        head=st.sampled_from(["1_DEHYL", "1_DEAGJ_DA20", "EDDS", "EDDS - EDDP"]),
    )
    def test_no_time_of_day_is_left(self, hour, minute, form, separator, head):
        time = form.format(h=f"{hour:02d}", m=f"{minute:02d}")
        assert strip_dates(f"{head}{separator}{time}") == head
        assert find_time_tokens(f"{head}{separator}{time}") == [time]

    @given(
        weekday=st.sampled_from(
            [
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
                "Sunday",
                "Montag",
                "Dienstag",
                "Mittwoch",
                "Donnerstag",
                "Freitag",
                "Samstag",
                "Sonnabend",
                "Sonntag",
            ]
        ),
        case=st.sampled_from([str, str.upper, str.lower]),
        separator=st.sampled_from(["_", " ", " - "]),
        head=st.sampled_from(["1_DEHYL", "EDDS", "EDDS - EDDP", "Rundflug EDMO"]),
    )
    def test_no_weekday_is_left(self, weekday, case, separator, head):
        assert strip_dates(f"{head}{separator}{case(weekday)}") == head
        assert strip_dates(f"{case(weekday)}{separator}{head}") == head

    @given(
        hour=st.integers(min_value=0, max_value=23),
        minute=st.integers(min_value=0, max_value=59),
        second=st.integers(min_value=0, max_value=59),
        form=st.sampled_from(
            [
                "20260816{h}{m}",
                "20260816{h}{m}{s}",
                "2026-08-16-{h}-{m}",
                "2026_08_16_{h}_{m}_{s}",
            ]
        ),
        separator=st.sampled_from(["_", " ", " - "]),
        head=st.sampled_from(["Log", "1_DEHYL", "EDDS - EDDP"]),
    )
    def test_no_date_and_time_is_left(
        self, hour, minute, second, form, separator, head
    ):
        """A date and time written as one run of digits or with hyphens."""
        stamp = form.format(h=f"{hour:02d}", m=f"{minute:02d}", s=f"{second:02d}")
        assert strip_dates(f"{head}{separator}{stamp}") == head
        assert find_date_tokens(stamp) != []
        assert find_time_tokens(stamp) != []

    @given(
        first=st.integers(min_value=0, max_value=23 * 60 + 59),
        second=st.integers(min_value=0, max_value=23 * 60 + 59),
        zone=st.sampled_from(["Z", "L", "z", " LT", " CET", " local"]),
        head=st.sampled_from(["Block", "1_DEHYL_DA40", "EDDS"]),
    )
    def test_no_end_of_a_range_is_left(self, first, second, zone, head):
        """The second time of a range is no registration after a prefix."""
        start = f"{first // 60:02d}{first % 60:02d}{zone}"
        end = f"{second // 60:02d}{second % 60:02d}{zone}"
        assert strip_dates(f"{head} {start}-{end}") == head
        assert find_time_tokens(f"{head} {start}-{end}") == [f"{start}-{end}"]
        assert find_time_tokens(f"{head} {start} - {end}") == [start, end]

    @given(
        number=st.integers(min_value=0, max_value=9999),
        head=st.sampled_from(["HB", "D", "OE", "N", "RA"]),
        suffix=st.sampled_from(["", "Z", "H", "L"]),
    )
    def test_registrations_are_kept(self, number, head, suffix):
        """A nationality prefix and its hyphen, or a letter, before the
        digits make them a registration."""
        joined = "" if head == "N" else "-"
        registration = f"{head}{joined}{number:04d}{suffix}"
        assert strip_dates(f"{registration} EDDS") == f"{registration} EDDS"


def test_month_number():
    assert month_number("aug") == month_number("August") == 8
    assert month_number("Flight") is None


class TestTimesAndRangesThatLeftAPart:
    """Times and ranges that left a time or a day behind until 2026-10."""

    @pytest.mark.parametrize(
        ("text", "kept"),
        [
            # Hours and minutes with a hyphen or an underscore after a date,
            # after a space as well as after an underscore
            ("Aunt farm 2026-08-16 14-30", "Aunt farm"),
            ("Aunt farm 2026-08-16 14_30", "Aunt farm"),
            ("Aunt farm 2026-08-16_14-30", "Aunt farm"),
            ("Aunt farm 2026-08-16_14.30", "Aunt farm"),
            ("Aunt farm 16.08.2026 14-30 EDDS", "Aunt farm EDDS"),
            # A range with dots and Uhr, a zone or the local time, whole
            ("Aunt farm 14.30-15.45 Uhr", "Aunt farm"),
            ("Aunt farm 16.08.2026 14.30-15.45 Uhr", "Aunt farm"),
            ("Aunt farm 16.08.2026 14.30 Uhr", "Aunt farm"),
            ("Aunt farm 14.30-15.45Z", "Aunt farm"),
            ("Aunt farm 14.30 - 15.45 UTC - EDDS", "Aunt farm - EDDS"),
            ("Aunt farm 14.30-15.45L", "Aunt farm"),
            ("Rundflug 9-11 Uhr", "Rundflug"),
            ("Rundflug 1430-1545 Uhr", "Rundflug"),
            # Joined by a word or the en dash of the input, which left
            # "14.30 bis" behind
            ("Aunt farm 14.30 bis 15.45 Uhr", "Aunt farm"),
            ("Aunt farm 14.30 to 15.45Z EDDS", "Aunt farm EDDS"),
            ("Aunt farm 14.30 until 15.45 UTC", "Aunt farm"),
            ("Aunt farm 14.30\u201315.45 Uhr", "Aunt farm"),
            ("Rundflug 9 bis 11 Uhr", "Rundflug"),
            ("Aunt farm 16.08.2026 14.30 bis 15.45 Uhr EDDS", "Aunt farm EDDS"),
            # The whole hyphenated time after the T, which left "30-00Z"
            ("2026-08-16T14-30-00Z EDDS", "EDDS"),
            ("2026-08-16T14-30Z EDDS", "EDDS"),
            ("2026-08-16T14Z EDDS", "EDDS"),
            # Hours and minutes with the letter of the clock, which read as
            # a unit and stayed whole (privacy)
            ("Aunt farm 2026-08-16 14-30h", "Aunt farm"),
            ("Aunt farm 2026-08-16 14-30 h", "Aunt farm"),
            ("Aunt farm 2026-08-16_14-30h", "Aunt farm"),
            ("Aunt farm 2026-08-16 14-30 hrs", "Aunt farm"),
            ("Aunt farm 2026-08-16 14-30m EDDS", "Aunt farm EDDS"),
            ("Aunt farm 2026-08-16 14-30 s", "Aunt farm"),
            ("Aunt farm 2026-08-16 14_30H", "Aunt farm"),
            ("Aunt farm 2026-08-16-14-30-00h", "Aunt farm"),
            ("Aunt farm 2026-08-16T14-30h", "Aunt farm"),
            ("Aunt farm 16.08.2026 14-30h EDDS", "Aunt farm EDDS"),
            # A German range of days, with and without the year
            ("Aunt farm 16.-18.08.2026", "Aunt farm"),
            ("Aunt farm 16. - 18.08.26", "Aunt farm"),
            ("Aunt farm 16.-18.08.", "Aunt farm"),
        ],
    )
    def test_nothing_is_left(self, text, kept):
        assert strip_dates(text) == kept

    @pytest.mark.parametrize(
        ("text", "kept"),
        [
            ("EDDS 2026-08-16 18-24 kt", "EDDS 18-24 kt"),
            ("Leg 2026-08-16 14-30 km", "Leg 14-30 km"),
            ("Climb 2026-08-16 15-20 %", "Climb 15-20 %"),
            ("Hold 2026-08-16 14-30 min", "Hold 14-30 min"),
            ("Hold 2026-08-16 14-30 sec", "Hold 14-30 sec"),
            # No time of the clock, whatever the unit
            ("Climb 2026-08-16 18-75 m", "Climb 18-75 m"),
            ("Climb 2026-08-16 18-75m", "Climb 18-75m"),
            ("Wind 2026-08-16 30-45 kt", "Wind 30-45 kt"),
            ("Leg 2026-08-16 24-30 h", "Leg 24-30 h"),
            # A runway, which main kept as well
            ("EDDS 2026-08-16 07-25 RWY", "EDDS 07-25 RWY"),
            ("EDDS 2026-08-16 07-25 runway", "EDDS 07-25 runway"),
            ("EDDS 2026-08-16 07-25 Piste", "EDDS 07-25 Piste"),
            # The same with a zone is a time
            ("Leg 2026-08-16 14-30 MEZ", "Leg"),
        ],
    )
    def test_a_range_with_a_unit_after_a_date_stays(self, text, kept):
        assert strip_dates(text) == kept

    @pytest.mark.parametrize(
        ("text", "times"),
        [
            ("Aunt farm 2026-01-01 14-30", ["14-30"]),
            ("Aunt farm 2026-01-01_14-30", ["14-30"]),
            ("Aunt farm 2026-01-01 14_30", ["14_30"]),
            ("Aunt farm 14.30-15.45 Uhr", ["14.30-15.45 Uhr"]),
            ("Aunt farm 01.01.2026 14.30-15.45 Uhr", ["14.30-15.45 Uhr"]),
            ("Aunt farm 14.30-15.45 UTC", ["14.30-15.45 UTC"]),
            ("Aunt farm 14.30 bis 15.45 Uhr", ["14.30 bis 15.45 Uhr"]),
            ("Aunt farm 14.30 to 15.45Z EDDS", ["14.30 to 15.45Z"]),
            ("Aunt farm 2026-01-01T14-30-00Z EDDS", ["T14-30-00Z"]),
            ("Aunt farm 2026-01-01 14-30h", ["14-30h"]),
            ("Aunt farm 2026-01-01 14-30 h", ["14-30 h"]),
            ("Aunt farm 2026-01-01_14-30h", ["14-30h"]),
            ("Aunt farm 2026-01-01 14-30 hrs", ["14-30 hrs"]),
            ("Aunt farm 2026-01-01 14-30m EDDS", ["14-30m"]),
            ("Aunt farm 2026-01-01 14-30 s", ["14-30 s"]),
            ("EDDS 2026-01-01 07-25 RWY", []),
            ("Hold 2026-01-01 14-30 min", []),
            ("Climb 2026-01-01 18-75 m", []),
            ("Wind 2026-01-01 30-45 kt", []),
        ],
    )
    def test_the_check_reports_the_times(self, text, times):
        assert find_time_tokens(text) == times

    def test_the_check_reports_a_range_of_days_whole(self):
        assert find_date_tokens(
            "Aunt farm 16.-18.08.2026", skip_near_jan_first=True
        ) == ["16.-18.08.2026"]
        assert find_partial_date_tokens("Aunt farm 16.-18.08.") == ["16.-18.08."]

    @pytest.mark.parametrize(
        "text",
        [
            # Decimals and frequencies with a hyphen between them, or a
            # word without a zone or Uhr after them
            "Fuel 14.30-15.45",
            "Fuel 14.30 to 15.45 EDDS",
            "EDDS 118.30-121.50",
            # Altitudes and headings
            "EDDS 1000-2000 ft",
            "EDDS 3500-4500 ft",
            "Heading 270-15",
            # Runways, a type with numbers before a date stays a type
            "RWY 09-27 EDDS",
            "EDDS 16-34",
        ],
    )
    def test_what_stays(self, text):
        assert strip_dates(text) == text
        assert find_time_tokens(text) == []

    @pytest.mark.parametrize(
        ("text", "kept"),
        [
            # Only right after the date: a runway after a word stays
            ("EDDS 2026-08-16 RWY 09-27", "EDDS RWY 09-27"),
            ("PA-28-16.08.2026", "PA-28"),
            ("Gate 2-16.08.2026", "Gate 2"),
        ],
    )
    def test_what_stays_next_to_a_date(self, text, kept):
        assert strip_dates(text) == kept


class TestDashesAndTheYearFirst:
    """An en dash or a Unicode hyphen stands for the hyphen."""

    @pytest.mark.parametrize("dash", ["\u2010", "\u2011", "\u2012", "\u2013"])
    def test_dashes(self, dash):
        text = f"EDDS 16{dash}08{dash}2026 14:30"
        assert find_date_tokens(text) == [f"16{dash}08{dash}2026"]
        assert strip_dates(text) == "EDDS"

    def test_a_time_after_a_dashed_date_keeps_its_text(self):
        assert find_time_tokens("2026\u201308\u201316 14:30") == ["14:30"]

    @pytest.mark.parametrize(
        "text", ["Flug 2026 08 16", "Flug 2026 - 08 - 16", "Flug 2026 8 16"]
    )
    def test_the_year_first_with_spaces(self, text):
        assert find_date_tokens(text, skip_near_jan_first=True) == [text[5:]]
        assert strip_dates(text) == "Flug"

    @pytest.mark.parametrize("text", ["2026 01 01", "2026 1 2", "Flug 2026 01 03"])
    def test_the_year_first_near_jan_first(self, text):
        assert find_date_tokens(text, skip_near_jan_first=True) == []

    @pytest.mark.parametrize("text", ["2026 8 1", "FL 2026 13 40", "2026 08 1600"])
    def test_numbers_in_a_row_that_are_no_date(self, text):
        assert find_date_tokens(text) == []


class TestFindPartialDateTokens:
    """What the year of the flight completes to its date."""

    @pytest.mark.parametrize(
        ("text", "found"),
        [
            ("EDDS-EDDP 16 Aug", ["16 Aug"]),
            ("Rundflug 16.08.", ["16.08."]),
            ("1_DEHYL_16Aug", ["16Aug"]),
            ("Trip 16/08", ["16/08"]),
            ("KW33 trip", ["KW33"]),
            ("DOF 260816", ["260816"]),
            ("Season 03/2026", ["03/2026"]),
            ("Sat 16 Aug", ["Sat 16 Aug"]),
            # Next to a date of January 1st the weekday gives the day away
            ("Sat 01 Jan 2026", ["Sat"]),
        ],
    )
    def test_found(self, text, found):
        assert find_partial_date_tokens(text) == found

    @pytest.mark.parametrize(
        "text",
        [
            "EDDS 01 Jan",
            "Takeoff: 2025-01-01",
            "Rundflug 01.01.",
            "Rundflug 02.01.",
            "Trip 01/01",
            "KW1",
            "DOF 260101",
            "Season 01/2026",
            "EDAQ Halle-Oppin - EDAQ Halle-Oppin",
            "100_DEAGJ_DA20",
            "RWY 08/26",
        ],
    )
    def test_none(self, text):
        assert find_partial_date_tokens(text) == []

    @pytest.mark.parametrize(
        "text",
        [
            "KW05 Gettysburg Regional Airport - KW22 Upshur County",
            "EDDS to KW05",
            "KW05 Gettysburg Regional Airport",
            # The separators of airport_lookup's route names
            "KW05-EDDF",
            "EDDF \u2013 KW05",
            "EDDF\u2014KW05",
            "EDDF->KW05",
            "EDDF/KW05",
            "EDDF > KW05",
            "EDDS TO KW05",
        ],
    )
    def test_us_airport_codes_are_no_weeks(self, text):
        assert find_partial_date_tokens(text) == []
        assert strip_dates(text) == text

    @pytest.mark.parametrize(
        "text", ["KW33 Ausflug", "Trip KW33", "Trip KW33 - EDDS", "Trip-KW33"]
    )
    def test_weeks_outside_a_route_side(self, text):
        assert find_partial_date_tokens(text) == ["KW33"]

    def test_a_range_of_weeks_is_no_route(self):
        """Between two codes without spaces one has to be all letters."""
        assert find_partial_date_tokens("KW33-KW34") == ["KW33", "KW34"]

    def test_a_two_digit_year_needs_a_boundary(self):
        assert find_date_tokens("DA40_16_08") == []
        assert find_date_tokens("DEHYL_16_08_26") == ["16_08_26"]

    def test_dates_are_not_parts(self):
        """A date with its year is find_date_tokens' to report."""
        assert find_partial_date_tokens("EDDS 16 Aug 2026") == []


class TestStrayDateSpans:
    """What the obfuscator takes out of a name or a description."""

    @pytest.mark.parametrize(
        ("text", "left"),
        [
            ("EDDS 16 Aug 2026 14:30 Sunday", "EDDS"),
            ("EDDS-EDDP 16 Aug", "EDDS-EDDP"),
            ("Rundflug 16.08.", "Rundflug"),
            ("Flug 2026 08 16", "Flug"),
            ("EDDS 16\u201308\u20132026", "EDDS"),
            # A date of January 1st stays, what gives the day away goes
            ("Takeoff: 2025-01-01", "Takeoff: 2025-01-01"),
            ("Sat 01 Jan 2026 14:30", "01 Jan 2026"),
            ("Flight at 1430Z", "Flight at"),
            (
                "EDAQ Halle-Oppin - EDAQ Halle-Oppin",
                "EDAQ Halle-Oppin - EDAQ Halle-Oppin",
            ),
        ],
    )
    def test_left(self, text, left):
        assert without_spans(text, stray_date_spans(text)) == left

    def test_a_url_and_line_breaks_stay(self):
        text = "https://x.org/a//b on 16 Aug\n\nBob,, Carl"
        assert without_spans(text, stray_date_spans(text)) == (
            "https://x.org/a//b on\n\nBob,, Carl"
        )

    def test_nothing_to_take_out_keeps_the_text(self):
        assert without_spans("  as  it was ", []) == "  as  it was "


class TestRomanMonths:
    @pytest.mark.parametrize(
        "date",
        [
            "16.VII.2026",
            "16. VII. 2026",
            "16-VII-2026",
            "16/VII/2026",
            "16 VII 2026",
            "16 VIII 2026",
            "16.vii.2026",
            "2026. VII. 16.",
            "2026.VII.16",
        ],
    )
    def test_a_full_date(self, date):
        assert find_date_tokens(f"Trip {date} home", skip_near_jan_first=True) == [date]
        assert strip_dates(f"Aunt farm {date} - Home strip") == "Aunt farm - Home strip"

    @pytest.mark.parametrize("day_month", ["16.VII.", "16.VII", "16. VII.", "16.XII."])
    def test_without_the_year(self, day_month):
        assert find_partial_date_tokens(f"EDDS {day_month} ok") == [day_month]
        assert strip_dates(f"EDDS {day_month} ok") == "EDDS ok"

    @pytest.mark.parametrize(
        ("text", "month"),
        [
            ("EDDS XII/2026", "XII/2026"),
            ("EDDS VII.2026", "VII.2026"),
            ("EDDS 2026/VII", "2026/VII"),
            ("EDDS 2026. VII.", "2026. VII."),
        ],
    )
    def test_a_month_and_year(self, text, month):
        assert find_partial_date_tokens(text) == [month]
        assert strip_dates(text) == "EDDS"

    @pytest.mark.parametrize(
        "text",
        [
            "Section 2. IV of the AIP",
            "Leg 3. II done",
            "Trip 2026. V speeds checked",
            "SkyDemon v.2024 export",
            "Flown in 2026. I liked it",
            "EDDS 16. V.",
            "EDDS 16.v.",
            "EDDS I/2026",
            "EDDS vii/2026",
            "EDDS 2026. VII",
        ],
    )
    def test_without_the_day_or_year_only_capitals_of_two_letters(self, text):
        """A short or lowercase numeral is a date only with day, month and year."""
        assert find_date_tokens(text) == []
        assert find_partial_date_tokens(text) == []
        assert strip_dates(text) == text

    @pytest.mark.parametrize(
        "text",
        [
            "16 X 2026",
            "16 V 2026",
            "Mk II 2026",
            "C172 Mk.IV 2026",
            "Apollo 13",
            "Super Cub Model 3. V",
            "Typ 3. X",
            "Henry VIII 2026",
            "OE-VII/2026",
        ],
    )
    def test_what_is_no_date(self, text):
        assert find_date_tokens(text) == []
        assert strip_dates(text) == text

    def test_january_first_passes_the_check(self):
        assert find_date_tokens("EDDF 01.I.2026", skip_near_jan_first=True) == []
        # The site takes it out all the same
        assert strip_dates("EDDF 01.I.2026") == "EDDF"


class TestHolidays:
    @pytest.mark.parametrize(
        ("text", "holiday"),
        [
            ("Aunt farm Christmas Eve", "Christmas Eve"),
            ("Xmas flight", "Xmas"),
            ("New Year's Day EDDS", "New Year's Day"),
            ("Easter Monday trip", "Easter Monday"),
            ("Thanksgiving EDDS", "Thanksgiving"),
            ("Heiligabend bei Oma", "Heiligabend"),
            ("Weihnachtsflug EDDS", "Weihnachtsflug"),
            ("Ostermontag EDDS", "Ostermontag"),
            ("EDDS Pfingsten", "Pfingsten"),
            ("Home strip - Tag der Einheit", "Tag der Einheit"),
            ("Tag der Deutschen Einheit EDDS", "Tag der Deutschen Einheit"),
            ("Silvesterflug", "Silvesterflug"),
            ("KARFREITAG EDDS", "KARFREITAG"),
            ("Ostermontagsflug EDDS", "Ostermontagsflug"),
            ("Pfingstmontagsausflug", "Pfingstmontagsausflug"),
            ("Vorweihnachtsflug EDDS", "Vorweihnachtsflug"),
            ("Heiligabendflug", "Heiligabendflug"),
            ("Himmelfahrtswochenende EDDS", "Himmelfahrtswochenende"),
            ("Neujahrsflug", "Neujahrsflug"),
            ("X-mas flight", "X-mas"),
            ("Erster Mai EDDS", "Erster Mai"),
            ("Home strip Columbus Day", "Columbus Day"),
            ("Remembrance Day trip", "Remembrance Day"),
            ("Presidents Day EDDS", "Presidents Day"),
            ("Presidents' Day EDDS", "Presidents' Day"),
            ("MLK Day EDDS", "MLK Day"),
            ("Martin Luther King Jr. Day EDDS", "Martin Luther King Jr. Day"),
            ("Reformation Day EDDS", "Reformation Day"),
            ("All Saints' Day EDDS", "All Saints' Day"),
            ("All Souls Day EDDS", "All Souls Day"),
            ("May Day fly-in", "May Day"),
            ("Epiphany Day EDDS", "Epiphany Day"),
            ("Feast of the Epiphany EDDS", "Feast of the Epiphany"),
            ("Three Kings' Day EDDS", "Three Kings' Day"),
            ("German Unity Day EDDS", "German Unity Day"),
            ("Corpus Christi Day EDDS", "Corpus Christi Day"),
            ("Valentinstag EDDS", "Valentinstag"),
            ("Heilige Drei Könige EDDS", "Heilige Drei Könige"),
            ("Dreikoenigstag EDDS", "Dreikoenigstag"),
            ("Nikolaustag EDDS", "Nikolaustag"),
            ("Buß- und Bettag EDDS", "Buß- und Bettag"),
            ("Buss- und Bettag EDDS", "Buss- und Bettag"),
            ("Erntedankfest EDDS", "Erntedankfest"),
            ("Unabhängigkeitstag EDDS", "Unabhängigkeitstag"),
        ],
    )
    def test_found_and_stripped(self, text, holiday):
        assert find_holiday_tokens(text) == [holiday]
        assert holiday not in (strip_dates(text) or "")

    @pytest.mark.parametrize(
        "text",
        [
            "YPXM Christmas Island",
            "Christmas Creek",
            "Easter Island",
            "Pentecost Island",
            "Osterholz-Scharmbeck",
            "Osterode",
            "Osterfeld",
            "Osternienburg",
            "Pfingstberg",
            "Eastern Airways",
            "New York",
            # The airfields of OurAirports named after one
            "YBPN Proserpine Whitsunday Coast Airport",
            "YSHR Shute Harbour/Whitsunday Airport",
            "12II Pentecost Airport",
            "K62S Christmas Valley Airport",
            "High Easter Airfield",
            "Easter Field",
            "Christmas Flying Service Airport",
            "Whitsunday Islands",
            "Weihnachtsinsel",
            "Weihnachtsinseln",
            # Churches, colleges and schools, VFR reporting points as often
            "All Saints Church",
            "All Saints",
            "All Souls College",
            "Epiphany Lutheran",
            "Epiphany",
            "May Day Airfield",
            "Easter Chapel",
            "Christmas Hill School",
        ],
    )
    def test_places_keep_their_names(self, text):
        assert find_holiday_tokens(text) == []
        assert strip_dates(text) == text

    @pytest.mark.parametrize(
        ("text", "kept"),
        [
            ("Christmas flying 2026", "flying 2026"),
            ("Weihnachtsflug", None),
            # Lost on the safe side: the Scottish "Easter" (eastern) and a
            # first name
            ("Easter Nether Cabra Farm Airstrip", "Nether Cabra Farm Airstrip"),
            ("Silvester Meier flight", "Meier flight"),
        ],
    )
    def test_holidays_next_to_other_words_go(self, text, kept):
        assert strip_dates(text) == kept

    @pytest.mark.parametrize(
        ("text", "kept"),
        [("Dep SAT 1430Z", "Dep"), ("KAUS to SAT 14:30", "KAUS to")],
    )
    def test_the_san_antonio_code_goes_before_a_time(self, text, kept):
        """SAT right before a time cannot be told from Saturday."""
        assert strip_dates(text) == kept


class TestUnixTimesInNames:
    def test_a_unix_time_of_a_flight_goes(self):
        assert strip_dates("Kaffee 1755350000 - Home strip") == "Kaffee - Home strip"
        assert strip_dates("Log 1755350000123") == "Log"

    def test_other_numbers_stay(self):
        # Midnight on January 1st, as the obfuscator leaves it, and a number
        # that would be a time in the future
        assert strip_dates("Log 1767225600") == "Log 1767225600"
        assert strip_dates("Call 4915112345678") == "Call 4915112345678"


class TestWeekdaysAroundTimes:
    @pytest.mark.parametrize(
        "text",
        [
            "EDDS Sat 14:30 16 Aug 2026",
            "EDDS Sat Sat 2026-08-16",
            "EDDS 2026-08-16 Sat Sat",
            "EDDS Sa 14.30 Uhr 16.08.2026",
        ],
    )
    def test_no_abbreviation_is_left(self, text):
        assert strip_dates(text) == "EDDS"
        # The obfuscator's rewrite takes the same out
        assert without_spans(text, stray_date_spans(text)) == "EDDS"

    def test_a_long_run_of_them_takes_no_cubic_time(self):
        """Seconds per name, with a pattern searched before every date."""
        text = "EDDS " + "Sat " * 400 + "Sat 14:30 " * 400 + "16 Aug 2026"
        assert strip_dates(text) == "EDDS"
        assert without_spans(text, stray_date_spans(text)) == "EDDS"


class TestMoreDateShapes:
    """Shapes that published a month, a week or an hour until 2026-10."""

    @pytest.mark.parametrize(
        ("text", "kept"),
        [
            ("Aunt farm 08-2026", "Aunt farm"),
            ("EDDS_08_2026", "EDDS"),
            ("EDDS 2026.08", "EDDS"),
            ("EDDS 2026_08", "EDDS"),
            ("EDDS Aug '26", "EDDS"),
            ("EDDS Aug \u201926", "EDDS"),
            ("Mai '26 EDDS", "EDDS"),
            ("Lake strip Jul/Aug 2026", "Lake strip"),
            ("July-August 2026 trip", "trip"),
            ("Juli/August 2026 EDDS", "EDDS"),
            ("Jan - Mar 2026 EDDS", "EDDS"),
            ("EDDS 16-18 Aug 2026", "EDDS"),
            ("EDDS 16./17. Mai 2026", "EDDS"),
            ("EDDS Aug 16-18, 2026", "EDDS"),
            ("EDDS 2026-08-16T10Z", "EDDS"),
            ("EDDS 20260816T10Z", "EDDS"),
            ("EDDS CW33", "EDDS"),
            ("EDDS Wk 33", "EDDS"),
            ("EDDS 2026/W33", "EDDS"),
            ("EDDS CW 33 2026", "EDDS"),
            ("Q3 2026 trip", "trip"),
            ("EDDS 2026-Q3", "EDDS"),
            ("EDDS H2 2026", "EDDS"),
            ("Summer 2026 EDDS", "EDDS"),
            ("EDDS summer of 2026", "EDDS"),
            ("Sommer 2026 EDDS", "EDDS"),
            ("Frühjahr 2026 EDDS", "EDDS"),
            ("Winter 2025/26 EDDS", "EDDS"),
        ],
    )
    def test_stripped(self, text, kept):
        assert strip_dates(text) == kept

    @pytest.mark.parametrize(
        "text",
        [
            "Aunt farm 08-2026",
            "EDDS 2026.08",
            "EDDS 2026_08",
            "EDDS CW33",
            "EDDS Wk 33",
            "Q3 2026",
            "Summer 2026",
            "Sommer 2026",
        ],
    )
    def test_the_check_reports_the_parts(self, text):
        assert find_partial_date_tokens(text)

    @pytest.mark.parametrize(
        ("text", "date"),
        [
            ("EDDS Aug '26", "Aug '26"),
            ("EDDS Jul/Aug 2026", "Jul/Aug 2026"),
            ("EDDS 16-18 Aug 2026", "16-18 Aug 2026"),
            ("EDDS 2026/W33", "2026/W33"),
            # A range passes only when all of it is near January 1st
            ("EDDS Dec/Jan 2026", "Dec/Jan 2026"),
            ("EDDS Nov-Jan 2026", "Nov-Jan 2026"),
            ("EDDS Dezember/Januar 2026", "Dezember/Januar 2026"),
            ("EDDS Jan 1-20, 2026", "Jan 1-20, 2026"),
            ("EDDS Jan 1 and 20 2026", "Jan 1 and 20 2026"),
            ("EDDS 1-20 Jan 2026", "1-20 Jan 2026"),
        ],
    )
    def test_the_check_reports_the_dates_whole(self, text, date):
        """A range whole, as the rewrite takes it out."""
        assert find_date_tokens(text, skip_near_jan_first=True) == [date]

    @pytest.mark.parametrize("text", ["1-3 Jan 2026", "Jan 1-3, 2026"])
    def test_a_range_near_january_first_passes_the_check(self, text):
        assert find_date_tokens(text, skip_near_jan_first=True) == []

    @pytest.mark.parametrize(
        ("text", "kept"),
        [
            ("PA-28-16 Aug 2026", "PA-28"),
            ("Do-28-16 Aug 2026", "Do-28"),
            ("F-16-16 Aug", "F-16"),
            ("Ju 52-16 Aug 2026", "Ju 52"),
            ("C172 16-18 Aug 2026", "C172"),
            ("EDDS Dec '80s", "EDDS Dec '80s"),
        ],
    )
    def test_numbers_before_a_date_that_are_no_range_stay(self, text, kept):
        assert strip_dates(text) == kept

    def test_a_month_and_a_year_of_the_last_century_go(self):
        """Not told from a flight's year: "Aug '98" could be one."""
        assert strip_dates("May '68 Memorial") == "Memorial"

    @pytest.mark.parametrize("unit", ["1-", "Jan/", "Mar-", "08-", "1st-", "1 to "])
    def test_a_long_run_of_range_joins_takes_no_quadratic_time(self, unit):
        def run(text):
            strip_dates(text)
            find_date_tokens(text)

        # 40 KB took about 0.2 s; quadratic, 20 KB of "1-" alone took 10 s
        ratio = growth(run, lambda size: unit * (size // len(unit)), 5_000)
        assert ratio < LINEAR_GROWTH

    def test_the_check_reports_an_hour_after_a_date(self):
        assert find_time_tokens("EDDS 2026-08-16T10Z") == ["T10Z"]

    @pytest.mark.parametrize(
        "text",
        ["Winter 2026", "Q1 2026", "H1 2026", "01-2026", "Jan '26"],
    )
    def test_january_passes_the_check(self, text):
        assert find_partial_date_tokens(text) == []
        assert find_date_tokens(text, skip_near_jan_first=True) == []

    @pytest.mark.parametrize(
        "text",
        [
            "ForeFlight 2026.03",
            "firmware 2024.10",
            "Summer camp EDDS",
            "free fall EDDS",
            "Q3 code EDDS",
            "Part 2 II",
            "Gate 12 VI",
            "Part 12 II",
            "Mk 12 IV",
            "EDDS 16 VIII",
            "Leg 2 - EDDS",
            "Circuits 3-2026",
            "Mayday EDDS",
        ],
    )
    def test_what_stays(self, text):
        assert strip_dates(text) == text


class TestCompactDatesAndSeparators:
    """Eight digits with the year last, six after a separator, refs."""

    @pytest.mark.parametrize(
        ("text", "found"),
        [
            # The day first and the month first, with the year last
            ("Home strip 16082025 - Aunt farm", ["16082025"]),
            ("Home strip 08162025 - Aunt farm", ["08162025"]),
            ("log_16082025", ["16082025"]),
            ("log.16082025.kml", ["16082025"]),
            # With the time of day right after it
            ("flight_160820251430", ["16082025"]),
            # Only January 1st passes, as with the other shapes that are no
            # ISO: 02012025 is February 1st in the US
            ("Flight 02012025", ["02012025"]),
            ("Flight 01022025", ["01022025"]),
        ],
    )
    def test_the_year_last_is_found(self, text, found):
        assert find_date_tokens(text, skip_near_jan_first=True) == found

    @pytest.mark.parametrize(
        "text",
        [
            "Flight 01012025",
            # The fraction of a longitude in a LookAt, a serial number, a
            # day or a month that does not exist, too many digits
            "11.16082025",
            "Serial 12345678",
            "Code 32082025",
            "Code 16132025",
            "Code 160820251",
            "1_DEHYL_DA40",
            "100_DEAGJ_DA20",
        ],
    )
    def test_what_passes_the_check(self, text):
        assert find_date_tokens(text, skip_near_jan_first=True) == []

    def test_the_year_first_stays_one_date(self):
        assert find_date_tokens("20240314") == ["20240314"]

    @pytest.mark.parametrize(
        ("text", "found"),
        [
            # Six digits after an underscore, a hyphen or a slash, as file
            # names, branches and refs write them
            ("log_250816", ["250816"]),
            ("1_DEAGJ_DA20_250816", ["250816"]),
            ("flights-250816", ["250816"]),
            ("refs/heads/250816", ["250816"]),
            ("250816_EDDS", ["250816"]),
            # With the time of day after it
            ("250816-1430", ["250816"]),
            ("250816_1430", ["250816"]),
            ("Log 2508161430", ["250816"]),
            # And a zone after it, or the time with a colon
            ("Add flight 250816-1430Z", ["250816"]),
            ("flights-250816-1430z", ["250816"]),
            ("log_250816_1430L.kml", ["250816"]),
            ("2508161430Z", ["250816"]),
            ("250816-14:30", ["250816"]),
            # A day and a month with a hyphen after a word
            ("refs/heads/flight-16-08", ["16-08"]),
            ("flights/16-08", ["16-08"]),
        ],
    )
    def test_parts_after_a_separator_are_found(self, text, found):
        assert find_partial_date_tokens(text) == found

    @pytest.mark.parametrize(
        "text",
        [
            # A phone number, a decimal, a version and a range
            "Call 0345-120816",
            "Fuel 1.250816",
            "v.250816",
            "250816-12",
            "250816-14301",
            # Registrations, types, headings and the numbering of SkyDemon
            "1_DEHYL_DA40",
            "100_DEAGJ_DA20",
            "1_D-EHYL_DA40",
            "PA-28-181 EDDS",
            "Heading 270-15",
            "Wind 270/15 EDDS",
            "RWY 08/26",
            # January 1st, and the ten digits of a Unix time of the past
            # (January 3rd, 2024, at midnight), which read as 170424 and 0000
            "refs/heads/250101",
            "x_010125",
            "Log 1704240000",
        ],
    )
    def test_what_stays_no_part_of_a_date(self, text):
        assert find_partial_date_tokens(text) == []

    @pytest.mark.parametrize(
        ("text", "stripped"),
        [
            ("Home strip 16082025 - Aunt farm", "Home strip - Aunt farm"),
            ("1_DEAGJ_DA20_250816", "1_DEAGJ_DA20"),
            ("flight 250816-1430", "flight"),
            ("Log 2508161430 EDDS", "Log EDDS"),
            ("flights-16-08", "flights"),
        ],
    )
    def test_strip_dates_takes_them_out(self, text, stripped):
        assert strip_dates(text) == stripped

    @given(
        st.dates(min_value=date(1900, 1, 1), max_value=date(2099, 12, 31)).filter(
            lambda day: day.month > 1
        ),
        st.sampled_from(["%d%m%Y", "%m%d%Y"]),
        st.sampled_from(["Flight ", "log_", "x-", ""]),
    )
    def test_every_date_with_the_year_last_is_found(self, day, shape, before):
        text = day.strftime(shape)
        assert text in find_date_tokens(before + text, skip_near_jan_first=True)

    @given(
        st.dates(min_value=date(2000, 1, 1), max_value=date(2099, 12, 31)).filter(
            lambda day: day.month > 1
        ),
        st.sampled_from(["%y%m%d", "%d%m%y"]),
        st.sampled_from(["_", "-", "/", " "]),
        st.sampled_from(["", "_EDDS", "-1430", "_1430"]),
    )
    def test_every_six_digit_date_after_a_separator_is_found(
        self, day, shape, separator, after
    ):
        text = day.strftime(shape)
        assert text in find_partial_date_tokens(f"log{separator}{text}{after}")

    @given(
        st.integers(min_value=1, max_value=99999),
        st.sampled_from(["DEHYL", "D-EHYL", "DEAGJ", "OE-AKI", "N12345", "HB-1234"]),
        st.sampled_from(["DA40", "DA20", "C172", "C182", "PA-28-181", "GLID"]),
    )
    def test_numbered_file_names_hold_no_date(self, number, registration, kind):
        stem = f"{number}_{registration}_{kind}"
        assert find_date_tokens(stem, skip_near_jan_first=True) == []
        assert find_partial_date_tokens(stem) == []
        assert strip_dates(stem) == stem


@given(
    st.lists(
        st.sampled_from(
            [
                "EDDS",
                "-",
                "Bob",
                "Sat",
                "Sa",
                "14:30",
                "16 Aug",
                "2026",
                "2026-08-16",
                "16.VII.2026",
                "16.VII.",
                "Christmas",
                "Eve",
                "1755350000",
                "(",
                ")",
                "KW33",
                "VII/2026",
                "Easter",
                "Field",
                "Jul/Aug",
                "08-2026",
                "CW33",
                "Summer",
                "Q3",
                "T10Z",
                "16-18",
                "250816",
                "16082026",
                "1430",
            ]
        ),
        max_size=8,
    ),
    st.sampled_from([" ", "_", "-"]),
)
def test_strip_dates_is_idempotent(words, separator):
    once = strip_dates(separator.join(words))
    assert once is None or strip_dates(once) == once


class TestOtherLanguages:
    """Dates of the languages of the countries the flights reach passed the
    check, the rewrite and the names the site publishes (regression)."""

    @pytest.mark.parametrize(
        ("text", "date"),
        [
            ("LKPR - LFPG 16 août 2026", "16 août 2026"),
            ("le 1er aout 2026", "1er aout 2026"),
            ("Lot 16. srpna 2026", "16. srpna 2026"),
            ("16. září 2026", "16. září 2026"),
            ("lot 16 sierpnia 2026", "16 sierpnia 2026"),
            ("16 października 2026", "16 października 2026"),
            ("let 16. avgusta 2026", "16. avgusta 2026"),
            ("16. augusta 2026", "16. augusta 2026"),
            ("2026. augusztus 16.", "2026. augusztus 16."),
            ("vuelo 16 de agosto de 2026", "16 de agosto de 2026"),
            ("voo 16 de dezembro de 2026", "16 de dezembro de 2026"),
            ("volo 16 agosto 2026", "16 agosto 2026"),
            ("vlucht 16 augustus 2026", "16 augustus 2026"),
            ("agosto 2026", "agosto 2026"),
            ("16 mei 26", "16 mei 26"),
        ],
    )
    def test_the_check_reports_them(self, text, date):
        assert find_date_tokens(text, skip_near_jan_first=True) == [date]
        assert [text[a:b] for a, b in stray_date_spans(text)] == [date]

    @pytest.mark.parametrize(
        ("text", "kept"),
        [
            ("LKPR - LFPG 16 août 2026", "LKPR - LFPG"),
            ("3_DEAGJ_DA20 16 sierpnia", "3_DEAGJ_DA20"),
            ("Lot 16. srpna", "Lot"),
            ("vuelo 16 de agosto", "vuelo"),
        ],
    )
    def test_names_lose_them(self, text, kept):
        assert strip_dates(text) == kept

    @pytest.mark.parametrize(
        ("name", "number"),
        [
            ("janvier", 1),
            ("Février", 2),
            ("marzo", 3),
            ("kwiecień", 4),
            ("května", 5),
            ("giugno", 6),
            ("lipca", 7),
            ("srpna", 8),
            ("września", 9),
            ("októbra", 10),
            ("listopadu", 11),
            ("grudnia", 12),
            ("december", 12),
        ],
    )
    def test_their_month_numbers(self, name, number):
        assert any_month_number(name) == number

    def test_first_names_are_no_months(self):
        assert any_month_number("Marc") is None
        assert any_month_number("Julius") is None

    def test_january_first_passes_the_check(self):
        assert find_date_tokens("1 janvier 2026", skip_near_jan_first=True) == []
        assert find_date_tokens("1. ledna 2026", skip_near_jan_first=True) == []

    @pytest.mark.parametrize(
        "weekday", ["samedi", "Sobota", "domingo", "zaterdag", "szombat", "nedeľa"]
    )
    def test_their_weekdays(self, weekday):
        assert find_weekday_tokens(f"Lot {weekday} EDDS") == [weekday]
        assert strip_dates(f"EDDS {weekday}") == "EDDS"

    @pytest.mark.parametrize(
        "text",
        [
            "LJMS Murska Sobota",
            "Rimavska Sobota",
            "MDSD Santo Domingo",
            "Sroda Slaska",
            "Środa Wielkopolska",
            # Regression: the obfuscation check refused these
            "EDAQ Halle-Oppin - LZDS Dunajská Streda",
            "Dunajska Streda-Male Blahovo Airfield",
            "Streda nad Bodrogom Airstrip",
            "Sto. Domingo Zanatepec",
            "SANU Domingo Faustino Sarmiento Airport",
            "YMDZ Mardi Station Airport",
        ],
    )
    def test_towns_named_after_a_weekday_keep_it(self, text):
        assert find_weekday_tokens(text) == []
        assert strip_dates(text) == text
        assert strip_dates(text) == text

    @pytest.mark.parametrize(
        "text",
        [
            # A month name of those languages alone is a word or a name
            "Mars mission",
            "Maja Novak",
            "Agosto",
            # As the German ones: a number before one is no day
            "Gate 16 mars",
        ],
    )
    def test_words_alone_stay(self, text):
        assert find_date_tokens(text) == []


class TestPossibleDates:
    @pytest.mark.parametrize(
        ("text", "found"),
        [
            ("Flug 16 setyembre 2026", ["16 setyembre 2026"]),
            ("16. augusti 2026", ["16. augusti 2026"]),
            ("16_kesäkuuta_2026", ["16_kesäkuuta_2026"]),
            ("16 SETYEMBRE 2026", ["16 SETYEMBRE 2026"]),
            # With hyphens, dots or nothing between, as file names have them
            ("16-augusti-2026", ["16-augusti-2026"]),
            ("16.augusti.2026", ["16.augusti.2026"]),
            ("16augusti2026", ["16augusti2026"]),
        ],
    )
    def test_a_day_a_word_and_a_year(self, text, found):
        assert find_possible_date_tokens(text) == found

    @pytest.mark.parametrize(
        "text",
        [
            "Flight 3 from 2019",
            "2 Platzrunden 2026",
            "4 landings 2026",
            # The singular forms and words of a flight log (regression)
            "1 flight 2026",
            "1 landing 2026",
            "1 Flug 2026",
            "1 Platzrunde 2026",
            "1 hour 2026",
            "Day 3 Tour 2026",
            # An airport code, a height
            "Fly-in 3 EDNY 2025",
            "Rwy 25 elevation 1950 ft",
            "Platz 12 Elev 1950 m",
            # Month names the patterns know report their own date
            "16 August 2026",
            "16 août 2026",
            "16 VII 2026",
            "16 août",
        ],
    )
    def test_what_is_none(self, text):
        assert find_possible_date_tokens(text) == []


class TestHolidayGaps:
    @pytest.mark.parametrize(
        "holiday",
        [
            "July Fourth",
            "July 4th",
            "Nikolausflug",
            "3. Advent",
            "zweiter Advent",
            "Adventssonntag",
            "Walpurgisnacht",
            "Walpurgis Night",
            "Groundhog Day",
        ],
    )
    def test_found_and_stripped(self, holiday):
        assert find_holiday_tokens(f"Flight {holiday} EDDS") == [holiday]
        assert strip_dates(f"EDDS {holiday}") == "EDDS"

    def test_nikolaus_alone_is_a_name(self):
        assert find_holiday_tokens("Flight with Nikolaus") == []


class TestUnicodeForms:
    @pytest.mark.parametrize(
        "text",
        [
            "2026\u221208\u221216",  # minus signs
            "2026\uff0f08\uff0f16",  # fullwidth slashes
            "\uff12\uff10\uff12\uff16-08-16",  # fullwidth digits
            "2026\u204408\u204416",  # fraction slashes
        ],
    )
    def test_the_check_reports_them(self, text):
        assert find_date_tokens(text, skip_near_jan_first=True) == [text]

    def test_a_character_that_shows_nothing_splits_no_date(self):
        """A zero-width space left "16." of the date behind (regression)."""
        text = "Flight 16.\u200b08.2026 EDDS"

        assert find_date_tokens(text, skip_near_jan_first=True) == ["16.08.2026"]
        spans = stray_date_spans(text)
        assert [text[a:b] for a, b in spans] == ["16.\u200b08.2026"]
        assert strip_dates(text) == "Flight EDDS"
        assert find_partial_date_tokens("Flight 16.\u00ad08.") == ["16.08."]
        assert find_time_tokens("Flight 14:\u200b30") == ["14:30"]

    def test_a_roman_month_with_a_hyphen_or_a_slash(self):
        assert find_partial_date_tokens("Flug 16-VIII") == ["16-VIII"]
        assert strip_dates("EDDS 16/VIII") == "EDDS"
        # After a hyphen it is part of a type
        assert strip_dates("Mk-16-II") == "Mk-16-II"


class TestDatesThatPassedTheCheck:
    """Dates the check, the rewrite and the site's names let through
    (regression): DIN 5008 spaces, the abbreviations of other languages,
    weeks with the number first, a weekday stuck to the day, bare hours."""

    @pytest.mark.parametrize(
        "date", ["16. 8. 26", "1. 9. 26", "16. 08. 26", "16.8. 2026", "16. 8.2026"]
    )
    def test_spaces_after_the_dots(self, date):
        text = f"Home strip {date} EDDS"
        assert find_date_tokens(text, skip_near_jan_first=True) == [date]
        assert strip_dates(f"Home strip Sa. {date}") == "Home strip"

    @pytest.mark.parametrize("day_month", ["16. 8.", "16. 08.", "1. 9."])
    def test_spaces_after_the_dots_without_the_year(self, day_month):
        assert find_partial_date_tokens(f"Flug {day_month}") == [day_month]
        assert strip_dates(f"Flug {day_month} EDDS") == "Flug EDDS"

    def test_spaces_after_the_dots_of_january_first_pass(self):
        assert find_date_tokens("1. 1. 26", skip_near_jan_first=True) == []
        assert find_partial_date_tokens("Flug 1. 1.") == []

    @pytest.mark.parametrize(
        "text", ["firmware 12. 10.", "Leg 2. 3", "Seite 2.3", "COM 118. 30"]
    )
    def test_spaces_after_the_dots_of_no_date(self, text):
        assert find_partial_date_tokens(text) == []
        assert strip_dates(text) == text

    @pytest.mark.parametrize(
        ("text", "date"),
        [
            ("Casa 16 ago 2026", "16 ago 2026"),
            ("vuelo 16 dic 2026", "16 dic 2026"),
            ("vuelo 16 ene 2026", "16 ene 2026"),
            ("voo 16 fev 2026", "16 fev 2026"),
            ("volo 16 ott 2026", "16 ott 2026"),
            ("vlucht 16 mrt 2026", "16 mrt 2026"),
            ("lot 16 kwi 2026", "16 kwi 2026"),
            ("let 16 srp 2026", "16 srp 2026"),
            # The words of English and German as well, with a day and a year
            ("voo 16 out 2026", "16 out 2026"),
            ("voo 16 de out de 2026", "16 de out de 2026"),
            ("volo 16 set 2026", "16 set 2026"),
            ("volo 16 mag 2026", "16 mag 2026"),
            ("lot 16 sie 2026", "16 sie 2026"),
        ],
    )
    def test_abbreviated_months_of_other_languages(self, text, date):
        assert find_date_tokens(text, skip_near_jan_first=True) == [date]
        assert strip_dates(text) == text.split(" ", 1)[0]

    @pytest.mark.parametrize(
        "day_month", ["16 ago", "16 lug", "16 mrt", "16 kwi", "16 sie", "16 srp"]
    )
    def test_abbreviated_months_without_the_year(self, day_month):
        assert find_partial_date_tokens(f"Lot {day_month}") == [day_month]
        assert strip_dates(f"Lot {day_month}") == "Lot"

    @pytest.mark.parametrize(
        "text",
        [
            "3 out of 5",
            "2 mag check",
            "L mag 2000 rpm",
            "4 LED lights",
            "set 2000 rpm",
            "Kommen Sie 2026 wieder",
            "Sie 2026",
            "Gen 2026",
            "out 2026",
        ],
    )
    def test_abbreviations_that_are_words(self, text):
        assert find_date_tokens(text) == []
        assert find_partial_date_tokens(text) == []
        assert strip_dates(text) == text

    @pytest.mark.parametrize(
        "week",
        [
            "33. KW",
            "33.KW",
            "33. Woche",
            "Woche 33",
            "Kalenderwoche 33",
            "semaine 33",
            "semana 33",
            "settimana 33",
            "tydzień 33",
            "týden 33",
            "teden 33",
        ],
    )
    def test_weeks(self, week):
        assert find_partial_date_tokens(f"Home strip {week}") == [week]
        assert strip_dates(f"Home strip {week}") == "Home strip"

    def test_a_week_with_its_year(self):
        assert find_date_tokens("Woche 33 2026", skip_near_jan_first=True) == [
            "Woche 33 2026"
        ]

    @pytest.mark.parametrize("text", ["Motor 50 KW", "100 kW", "1. KW", "Woche 1"])
    def test_no_week_or_the_first(self, text):
        assert find_partial_date_tokens(text) == []

    @pytest.mark.parametrize(
        ("text", "found", "kept"),
        [
            ("Trip Sat16Aug", "Sat16Aug", "Trip"),
            ("Trip FRI16AUG", "FRI16AUG", "Trip"),
            ("Flug Sa16Mai", "Sa16Mai", "Flug"),
            ("EDDS Sat16Aug EDDF", "Sat16Aug", "EDDS EDDF"),
        ],
    )
    def test_a_weekday_stuck_to_the_day(self, text, found, kept):
        assert find_partial_date_tokens(text) == [found]
        assert strip_dates(text) == kept

    def test_a_weekday_stuck_to_a_date_with_its_year(self):
        assert strip_dates("EDDS FRI16AUG26") == "EDDS"

    @pytest.mark.parametrize("text", ["Do27", "DO27", "MI8", "Thesat16Aug"])
    def test_no_weekday_before_a_day(self, text):
        assert strip_dates(text) == text

    @pytest.mark.parametrize("hour", ["14h", "14 h", "09h"])
    def test_bare_hours(self, hour):
        assert find_time_tokens(f"Oma {hour}") == [hour]
        assert strip_dates(f"1_DEHYL_{hour}") == "1_DEHYL"

    @pytest.mark.parametrize(
        "text",
        [
            "2h flight",
            "1h30",
            "1013 hPa",
            "10 hPa",
            "24h",
            "R44 heli",
            "14hPa",
            # An airport in the US
            "21H Skyline Seaplane Base",
        ],
    )
    def test_no_hours(self, text):
        assert find_time_tokens(text) == []

    @pytest.mark.parametrize(
        "holiday",
        ["Pfingstsamstag", "Bastille Day", "Nationalfeiertag", "Ferragosto", "Wigilia"],
    )
    def test_holidays(self, holiday):
        assert find_holiday_tokens(f"Oma {holiday} EDDS") == [holiday]
        assert strip_dates(f"EDDS {holiday}") == "EDDS"
