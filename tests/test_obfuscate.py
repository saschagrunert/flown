"""Tests for KML date and timestamp obfuscation."""

import logging
import os
import re
import zipfile
from datetime import UTC, datetime, timedelta
from itertools import pairwise
from pathlib import Path
from unittest.mock import patch

import pytest
from hypothesis import example, given, settings
from hypothesis import strategies as st

import flown.obfuscate as obfuscate_module
from flown.aircraft import parse_aircraft_from_filename
from flown.date_tokens import (
    find_date_tokens,
    find_holiday_tokens,
    find_partial_date_tokens,
    find_time_tokens,
    find_weekday_tokens,
)
from flown.helpers import DATE_PATTERN
from flown.obfuscate import (
    GENERIC_CREATOR,
    NAME_YEAR_DATE_PATTERN,
    _extract_frac,
    _find_stray_dates,
    check_directory_obfuscated,
    check_kml_obfuscated,
    find_kml_files,
    main,
    obfuscate_kml_content,
    obfuscate_kml_file,
    obfuscate_kml_files,
    rename_charterware_files,
    rename_dated_files,
)
from tests.conftest import LINEAR_GROWTH, growth, parse_kml_file

SAMPLE_KML = """\
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"
     xmlns:gx="http://www.google.com/kml/ext/2.2"
     creator="SkyDemon for iPhone v4.2.2.429">
  <Document>
    <name>SkyDemon Track Log</name>
    <Placemark>
      <name>Log Start: 03 Mar 2025 08:25 Z</name>
      <Point><coordinates>12.058459,51.550617,100</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>EDAQ Halle-Oppin - EDAQ Halle-Oppin</name>
      <gx:Track>
        <when>2025-03-03T08:25:15.5848380Z</when>
        <gx:coord>12.058459 51.550617 100</gx:coord>
        <when>2025-03-03T08:25:20.5858380Z</when>
        <gx:coord>12.060145 51.550606 105</gx:coord>
        <when>2025-03-03T08:25:25.5868380Z</when>
        <gx:coord>12.055846 51.551740 110</gx:coord>
      </gx:Track>
    </Placemark>
    <Placemark>
      <name>Takeoff: 03 Mar 2025 08:31 Z</name>
      <Point><coordinates>12.058459,51.550617,100</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Landing: 03 Mar 2025 08:50 Z</name>
      <Point><coordinates>12.058459,51.550617,100</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Log Stop: 03 Mar 2025 08:54 Z</name>
      <Point><coordinates>12.058459,51.550617,100</coordinates></Point>
    </Placemark>
  </Document>
</kml>
"""

CHARTERWARE_KML = """\
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>OE-AKI</name>
      <description>Flight Jan 12 2026 03:01PM path of OE-AKI</description>
      <TimeSpan><begin>2026-01-12T15:01:00Z</begin><end>2026-01-12T16:11:30Z</end></TimeSpan>
      <LineString><coordinates>16.25,47.96,232.8 16.26,47.97,240.0</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>
"""

ROUTE_NAME_KML = """\
<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>EDDS to EDDP - 16 Aug 2026</name>
      <LineString><coordinates>9.22,48.68,300 12.23,51.42,300</coordinates></LineString>
    </Placemark>
  </Document>
</kml>
"""


def obfuscate_kml_directory(directory):
    """Obfuscate every KML file of a directory, as the command line does."""
    return obfuscate_module._obfuscate_listed_files(find_kml_files(directory))


def _whens(content):
    return re.findall(r"<when>([^<]+)</when>", content)


def _parse_utc(ts):
    dt = datetime.fromisoformat(ts)
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


class TestObfuscateContent:
    def test_shifts_timestamps_to_midnight_on_jan_1(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        # One shift of whole seconds: each timestamp keeps its fraction
        assert _whens(result) == [
            "2025-01-01T00:00:00.5848380Z",
            "2025-01-01T00:00:05.5858380Z",
            "2025-01-01T00:00:10.5868380Z",
        ]
        assert "2025-03-03" not in result
        assert "08:" not in result

    def test_preserves_time_deltas(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        original = [_parse_utc(ts) for ts in _whens(SAMPLE_KML)]
        shifted = [_parse_utc(ts) for ts in _whens(result)]
        for (o1, o2), (s1, s2) in zip(
            pairwise(original), pairwise(shifted), strict=True
        ):
            assert (o2 - o1) == (s2 - s1)

    def test_strips_name_dates(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        for label in ("Log Start", "Takeoff", "Landing", "Log Stop"):
            assert f"<name>{label}: 2025-01-01</name>" in result

    def test_preserves_route_name_document_name_and_coordinates(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert "<name>EDAQ Halle-Oppin - EDAQ Halle-Oppin</name>" in result
        assert "<name>SkyDemon Track Log</name>" in result
        assert "12.058459 51.550617 100" in result
        assert "12.060145 51.550606 105" in result

    def test_replaces_creator_attribute(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert f'creator="{GENERIC_CREATOR}"' in result
        assert "SkyDemon for iPhone" not in result

    def test_returns_none_for_no_timestamps(self):
        assert (
            obfuscate_kml_content("<kml><Document><name>t</name></Document></kml>")
            is None
        )

    def test_returns_none_for_already_obfuscated(self):
        result = obfuscate_kml_content(SAMPLE_KML)
        assert result is not None
        assert obfuscate_kml_content(result) is None

    def test_returns_none_for_unparsable_first_timestamp(self):
        assert obfuscate_kml_content("<kml><when>not-valid</when></kml>") is None

    def test_preserves_unparsable_inner_timestamps(self):
        kml = (
            "<kml><when>2025-03-03T08:25:15.0000000Z</when>"
            "<when>bad-timestamp</when>"
            "<when>2025-03-03T08:30:00.0000000Z</when></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert "<when>bad-timestamp</when>" in result
        assert "<when>2025-01-01T00:04:45.0000000Z</when>" in result


class TestTimezoneHandling:
    def test_naive_when_is_treated_as_utc(self):
        kml = (
            "<kml><when>2025-03-03T08:25:15</when>"
            "<when>2025-03-03T08:26:15</when></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == ["2025-01-01T00:00:00Z", "2025-01-01T00:01:00Z"]

    def test_offset_when_is_converted_to_utc_z(self):
        kml = (
            "<kml><when>2025-03-03T10:25:15+02:00</when>"
            "<when>2025-03-03T10:30:15+02:00</when></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == ["2025-01-01T00:00:00Z", "2025-01-01T00:05:00Z"]

    def test_fraction_kept_with_offset(self):
        kml = "<kml><when>2025-03-03T10:25:15.25+02:00</when></kml>"
        result = obfuscate_kml_content(kml)
        assert _whens(result) == ["2025-01-01T00:00:00.25Z"]

    def test_comma_fractions_are_kept(self):
        """ISO 8601 allows a comma: dropping its fraction changed the
        intervals of the flight."""
        kml = (
            "<kml><Placemark><when>2025-03-03T10:25:15,5Z</when>"
            "<when>2025-03-03T10:25:16,5Z</when>"
            "<when>2025-03-03T10:25:17Z</when></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert _whens(result) == [
            "2025-01-01T00:00:00.5Z",
            "2025-01-01T00:00:01.5Z",
            "2025-01-01T00:00:02Z",
        ]
        assert obfuscate_kml_content(result) is None

    def test_timestamps_with_a_comment_inside_are_rewritten(self, tmp_path):
        """The parser reads past the comment, so the rewrite does too."""
        kml = (
            "<kml><Placemark><when>2025-03-03T10:<!-- local -->25:15Z</when>"
            "<when>2025-03-03T10:30:15Z</when></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == ["2025-01-01T00:00:00Z", "2025-01-01T00:05:00Z"]
        kml_file = tmp_path / "comment.kml"
        kml_file.write_text(kml.replace("2025-03-03", "2025-01-01"), encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == [
            "Flight does not start at 00:00:00 on Jan 1: 2025-01-01T10:25:15Z"
        ]

    def test_timestamps_with_a_processing_instruction_inside_are_rewritten(self):
        """The parser drops processing instructions like comments."""
        kml = (
            '<?xml version="1.0"?><kml><Placemark>'
            "<when>2025-03-03T10:<?x?>25:15Z</when>"
            "<when>2025-03-03T10:30:15Z</when></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert _whens(result) == ["2025-01-01T00:00:00Z", "2025-01-01T00:05:00Z"]
        assert result.startswith('<?xml version="1.0"?>')

    def test_unshifted_offset_timestamp_is_written_in_utc(self, tmp_path):
        """Its local date would otherwise stay a day past the accepted window."""
        kml = (
            "<kml><Placemark><when>2025-01-01T00:00:00Z</when>"
            "<when>2025-01-04T01:00:00+02:00</when></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == ["2025-01-01T00:00:00Z", "2025-01-03T23:00:00Z"]
        kml_file = tmp_path / "offset.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_obfuscated_timestamps_are_left_as_written(self):
        kml = (
            "<kml><when>2025-01-01T00:00:00.50Z</when>"
            "<when>2025-01-01T00:01:00</when></kml>"
        )
        assert obfuscate_kml_content(kml) is None

    def test_mixed_naive_and_aware_keep_deltas(self):
        kml = (
            "<kml><when>2025-03-03T08:25:15Z</when>"
            "<when>2025-03-03T08:30:15</when></kml>"
        )
        result = obfuscate_kml_content(kml)
        first, second = (_parse_utc(ts) for ts in _whens(result))
        assert second - first == timedelta(minutes=5)


class TestExtendedPatterns:
    def test_timespan_begin_end_shifted(self):
        result = obfuscate_kml_content(CHARTERWARE_KML)
        assert result is not None
        assert "<begin>2026-01-01T00:00:00Z</begin>" in result
        assert "<end>2026-01-01T01:10:30Z</end>" in result

    def test_description_date_lands_on_jan_1_at_midnight(self):
        result = obfuscate_kml_content(CHARTERWARE_KML)
        assert result is not None
        assert "Flight Jan 01 2026 12:00AM path of OE-AKI" in result
        assert "Jan 12" not in result
        assert "03:01PM" not in result

    def test_description_without_full_timestamps(self):
        kml = (
            "<kml><description>Flight Aug 16 2026 11:45PM path of D-EXYZ"
            "</description></kml>"
        )
        result = obfuscate_kml_content(kml)
        expected = (
            "<kml><description>Flight Jan 01 2026 12:00AM path of D-EXYZ"
            "</description></kml>"
        )
        assert result == expected

    def test_description_long_month_name_preserved(self):
        kml = "<kml><description>Flight August 16 2026 12:05PM x</description></kml>"
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert "Flight January 01 2026 12:00AM x" in result

    def test_route_name_date_shifted(self):
        result = obfuscate_kml_content(ROUTE_NAME_KML)
        assert result is not None
        assert "<name>EDDS to EDDP - 01 Jan 2026</name>" in result
        assert "16 Aug 2026" not in result

    def test_local_route_date_lands_on_jan_1_of_its_year(self, tmp_path):
        """A local date a day after the UTC <when> used to stay on Jan 2."""
        kml = (
            "<kml><name>EDDS to EDDP - 17 Aug 2026</name>"
            "<when>2026-08-16T23:30:00Z</when></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert "<name>EDDS to EDDP - 01 Jan 2026</name>" in result
        assert "<when>2026-01-01T00:00:00Z</when>" in result
        assert obfuscate_kml_content(result) is None
        kml_file = tmp_path / "route.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_local_description_date_lands_on_jan_1_of_its_year(self):
        kml = (
            "<kml><description>Flight Jan 13 2026 12:30AM path of OE-AKI"
            "</description><TimeSpan><begin>2026-01-12T23:30:00Z</begin>"
            "</TimeSpan></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert "Flight Jan 01 2026 12:00AM" in result
        assert "<begin>2026-01-01T00:00:00Z</begin>" in result

    def test_namespace_prefixed_elements(self):
        kml = (
            '<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2"><kml:Placemark>'
            "<kml:name>Log Start: 14 Jun 2025 09:12 Z</kml:name>"
            "<kml:name>EDDS to EDDP - 14 Jun 2025</kml:name>"
            '<kml:TimeSpan><kml:begin id="b">2025-06-14T09:12:00Z</kml:begin>'
            "<kml:end>2025-06-14T10:12:00Z</kml:end></kml:TimeSpan>"
            "</kml:Placemark></kml:kml>"
        )
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert '<kml:begin id="b">2025-01-01T00:00:00Z</kml:begin>' in result
        assert "<kml:end>2025-01-01T01:00:00Z</kml:end>" in result
        assert "<kml:name>Log Start: 2025-01-01</kml:name>" in result
        assert "<kml:name>EDDS to EDDP - 01 Jan 2025</kml:name>" in result
        assert "06-14" not in result

    def test_flights_on_different_dates_each_land_on_jan_1(self, tmp_path):
        """One offset for the file turned the second flight into 2024-03-15."""
        kml = (
            "<kml><Placemark><TimeSpan><begin>2024-12-30T10:00:00Z</begin>"
            "<end>2024-12-30T11:00:00Z</end></TimeSpan></Placemark>"
            "<Placemark><TimeSpan><begin>2025-03-14T10:00:00Z</begin>"
            "<end>2025-03-14T11:30:00Z</end></TimeSpan></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert re.findall(r"<(?:begin|end)>([^<]+)<", result) == [
            "2024-01-01T00:00:00Z",
            "2024-01-01T01:00:00Z",
            "2025-01-01T00:00:00Z",
            "2025-01-01T01:30:00Z",
        ]
        assert obfuscate_kml_content(result) is None
        kml_file = tmp_path / "two.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_the_tracks_of_one_flight_keep_their_gaps(self, tmp_path):
        """One offset for the whole flight: its tracks keep order and gaps."""
        kml = (
            "<kml><Placemark><gx:Track><when>2025-06-14T09:40:10.5Z</when>"
            "<when>2025-06-14T10:05:00Z</when></gx:Track></Placemark>"
            "<Placemark><gx:Track><when>2025-06-14T10:50:00Z</when>"
            "<when>2025-06-14T11:30:30Z</when></gx:Track></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert _whens(result) == [
            "2025-01-01T00:00:00.5Z",
            "2025-01-01T00:24:50Z",
            "2025-01-01T01:09:50Z",
            "2025-01-01T01:50:20Z",
        ]
        assert obfuscate_kml_content(result) is None
        kml_file = tmp_path / "tracks.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_a_flight_keeps_its_intervals_across_days(self):
        kml = (
            "<kml><Placemark><when>2025-06-14T22:00:00Z</when>"
            "<when>2025-06-15T09:00:00Z</when>"
            "<when>2025-06-16T21:00:00Z</when></Placemark></kml>"
        )
        assert _whens(obfuscate_kml_content(kml)) == [
            "2025-01-01T00:00:00Z",
            "2025-01-01T11:00:00Z",
            "2025-01-02T23:00:00Z",
        ]

    def test_a_track_with_a_long_pause_never_runs_backwards(self, tmp_path):
        """Splitting it into two flights put the end before the start."""
        kml = (
            "<kml><Placemark><gx:Track>"
            "<when>2025-06-14T10:00:00Z</when><when>2025-06-14T11:00:00Z</when>"
            "<when>2025-06-18T08:00:00Z</when><when>2025-06-18T09:00:00Z</when>"
            "</gx:Track></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == [
            "2025-01-01T00:00:00Z",
            "2025-01-01T01:00:00Z",
            "2025-01-04T22:00:00Z",
            "2025-01-04T23:00:00Z",
        ]
        # Too long for the days after January 1st: the check fails closed
        kml_file = tmp_path / "paused.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file)

    def test_a_clock_wrong_at_the_start_does_not_hold_the_flight(self, tmp_path):
        """A logger's clock sits at its default date until the GPS fix.

        Those stamps are clock errors, as the parser has them, and the
        flight moves to January 1st without them.
        """
        kml = (
            "<kml><Placemark><gx:Track>"
            "<when>2000-01-01T00:00:00Z</when><when>2000-01-01T00:00:01Z</when>"
            "<when>2026-08-16T10:00:00Z</when><when>2026-08-16T10:01:00Z</when>"
            "<when>2026-08-16T10:02:00Z</when>"
            "</gx:Track></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == [
            "2000-01-01T00:00:00Z",
            "2000-01-01T00:00:01Z",
            "2026-01-01T00:00:00Z",
            "2026-01-01T00:01:00Z",
            "2026-01-01T00:02:00Z",
        ]
        kml_file = tmp_path / "clock.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_a_flight_on_new_years_day_stays_in_its_year(self, tmp_path):
        """Eight hours after a flight across midnight it still is 2026's."""

        def placemark(*whens):
            return (
                "<Placemark><gx:Track>"
                + "".join(f"<when>{when}</when>" for when in whens)
                + "</gx:Track></Placemark>"
            )

        kml = (
            "<kml>"
            + placemark("2025-12-30T14:00:00Z", "2025-12-30T15:00:00Z")
            + placemark("2025-12-31T23:40:00Z", "2026-01-01T00:40:00Z")
            + placemark("2026-01-01T09:00:00Z", "2026-01-01T10:00:00Z")
            + placemark("2026-01-03T12:00:00Z")
            + "</kml>"
        )
        result = obfuscate_kml_content(kml)
        assert result is not None
        # Four flights, each at midnight on January 1st of its year; the
        # two of each year overlap now and count as one on the next run
        assert _whens(result) == [
            "2025-01-01T00:00:00Z",
            "2025-01-01T01:00:00Z",
            "2025-01-01T00:00:00Z",
            "2025-01-01T01:00:00Z",
            "2026-01-01T00:00:00Z",
            "2026-01-01T01:00:00Z",
            "2026-01-01T00:00:00Z",
        ]
        assert obfuscate_kml_content(result) is None
        kml_file = tmp_path / "new_year.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_one_recording_across_new_year_is_not_split(self):
        kml = (
            "<kml><when>2025-12-31T23:59:50Z</when>"
            "<when>2026-01-01T00:00:05Z</when></kml>"
        )
        assert _whens(obfuscate_kml_content(kml)) == [
            "2025-01-01T00:00:00Z",
            "2025-01-01T00:00:15Z",
        ]

    @pytest.mark.parametrize(
        "body",
        [
            # Two Placemarks, 20 minutes apart
            (
                "<Placemark><gx:Track>{first}</gx:Track></Placemark>"
                "<Placemark><gx:Track>{second}</gx:Track></Placemark>"
            ),
            # Two tracks of one Placemark, each a path of its own
            (
                "<Placemark><gx:Track>{first}</gx:Track>"
                "<gx:Track>{second}</gx:Track></Placemark>"
            ),
            # Tracks outside a Placemark are paths too
            "<gx:Track>{first}</gx:Track><gx:Track>{second}</gx:Track>",
        ],
    )
    def test_every_track_keeps_the_year_the_parser_gives_it(self, tmp_path, body):
        """A track that starts after New Year must not move into the year before."""

        def track(*whens):
            return "".join(
                f"<when>{when}</when><gx:coord>{12 + i * 0.01} 51 300</gx:coord>"
                for i, when in enumerate(whens)
            )

        kml = (
            '<kml xmlns="http://www.opengis.net/kml/2.2" '
            'xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>'
            + body.format(
                first=track("2024-12-31T23:30:00Z", "2024-12-31T23:50:00Z"),
                second=track("2025-01-01T00:10:00Z", "2025-01-01T00:30:00Z"),
            )
            + "</Document></kml>"
        )
        kml_file = tmp_path / "new_year.kml"
        kml_file.write_text(kml, encoding="utf-8")
        before = [meta["year"] for meta in parse_kml_file(str(kml_file))[2]]

        result = obfuscate_kml_content(kml)
        assert result is not None
        kml_file.write_text(result, encoding="utf-8")

        assert before == [2024, 2025]
        assert [meta["year"] for meta in parse_kml_file(str(kml_file))[2]] == before
        assert _whens(result) == [
            "2024-01-01T00:00:00Z",
            "2024-01-01T00:20:00Z",
            "2025-01-01T00:00:00Z",
            "2025-01-01T00:20:00Z",
        ]
        assert check_kml_obfuscated(kml_file) == []

    def test_line_strings_across_new_year_keep_their_years(self, tmp_path):
        """A LineString takes the year of its Placemark's TimeSpan."""

        def line(begin, end, lon):
            return (
                f"<Placemark><name>EDAQ - EDDC</name><TimeSpan><begin>{begin}"
                f"</begin><end>{end}</end></TimeSpan><LineString><coordinates>"
                f"{lon},51,300 {lon + 0.1},51.1,400</coordinates></LineString>"
                "</Placemark>"
            )

        kml = (
            '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
            + line("2024-12-31T23:30:00Z", "2024-12-31T23:50:00Z", 12)
            + line("2025-01-01T00:10:00Z", "2025-01-01T00:30:00Z", 13)
            + "</Document></kml>"
        )
        kml_file = tmp_path / "lines.kml"
        kml_file.write_text(kml, encoding="utf-8")
        before = [meta["year"] for meta in parse_kml_file(str(kml_file))[2]]

        result = obfuscate_kml_content(kml)
        assert result is not None
        kml_file.write_text(result, encoding="utf-8")

        assert before == [2024, 2025]
        assert [meta["year"] for meta in parse_kml_file(str(kml_file))[2]] == before
        assert check_kml_obfuscated(kml_file) == []

    def test_a_multi_track_then_a_track_across_new_year(self, tmp_path):
        """The tracks of a gx:MultiTrack are one track, the one after another."""
        kml = (
            '<kml xmlns="http://www.opengis.net/kml/2.2" '
            'xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>'
            "<Placemark><gx:MultiTrack>"
            "<gx:Track><when>2024-12-31T23:00:00Z</when>"
            "<gx:coord>12 51 300</gx:coord><when>2024-12-31T23:10:00Z</when>"
            "<gx:coord>12.1 51 400</gx:coord></gx:Track>"
            "<gx:Track><when>2024-12-31T23:30:00Z</when>"
            "<gx:coord>12.2 51 400</gx:coord><when>2024-12-31T23:40:00Z</when>"
            "<gx:coord>12.3 51 300</gx:coord></gx:Track>"
            "</gx:MultiTrack></Placemark>"
            "<Placemark><gx:Track><when>2025-01-01T00:10:00Z</when>"
            "<gx:coord>13 51 300</gx:coord><when>2025-01-01T00:30:00Z</when>"
            "<gx:coord>13.1 51 400</gx:coord></gx:Track></Placemark>"
            "</Document></kml>"
        )
        kml_file = tmp_path / "multi.kml"
        kml_file.write_text(kml, encoding="utf-8")
        before = [meta["year"] for meta in parse_kml_file(str(kml_file))[2]]

        result = obfuscate_kml_content(kml)
        assert result is not None
        kml_file.write_text(result, encoding="utf-8")

        assert before == [2024, 2025]
        assert [meta["year"] for meta in parse_kml_file(str(kml_file))[2]] == before
        assert _whens(result) == [
            "2024-01-01T00:00:00Z",
            "2024-01-01T00:10:00Z",
            "2024-01-01T00:30:00Z",
            "2024-01-01T00:40:00Z",
            "2025-01-01T00:00:00Z",
            "2025-01-01T00:20:00Z",
        ]
        assert check_kml_obfuscated(kml_file) == []

    def test_a_marker_after_new_year_joins_the_flight_before(self, tmp_path):
        """A point marker's TimeStamp is no track: it moves with its flight."""
        kml = (
            '<kml xmlns="http://www.opengis.net/kml/2.2" '
            'xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>'
            "<Placemark><gx:Track><when>2024-12-31T22:00:00Z</when>"
            "<gx:coord>12 51 300</gx:coord><when>2024-12-31T23:55:00Z</when>"
            "<gx:coord>13 51 300</gx:coord></gx:Track></Placemark>"
            "<Placemark><name>Landing</name>"
            "<TimeStamp><when>2025-01-01T00:05:00Z</when></TimeStamp>"
            "<Point><coordinates>13,51,300</coordinates></Point></Placemark>"
            "</Document></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == [
            "2024-01-01T00:00:00Z",
            "2024-01-01T01:55:00Z",
            "2024-01-01T02:05:00Z",
        ]
        kml_file = tmp_path / "marker.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_a_multi_track_across_new_year_stays_in_one_piece(self):
        """The parser makes one path of it, in the year it started in."""
        kml = (
            "<kml><Placemark><gx:MultiTrack>"
            "<gx:Track><when>2024-12-31T23:30:00Z</when></gx:Track>"
            "<gx:Track><when>2025-01-01T00:10:00Z</when></gx:Track>"
            "</gx:MultiTrack></Placemark></kml>"
        )
        assert _whens(obfuscate_kml_content(kml)) == [
            "2024-01-01T00:00:00Z",
            "2024-01-01T00:40:00Z",
        ]

    def test_a_flight_past_utc_midnight_stays_in_one_piece(self, tmp_path):
        kml = (
            "<kml><Placemark><gx:Track><when>2025-06-14T18:00:00Z</when>"
            "<when>2025-06-14T19:00:00Z</when></gx:Track></Placemark>"
            "<Placemark><gx:Track><when>2025-06-16T23:30:00Z</when>"
            "<when>2025-06-16T23:59:00Z</when><when>2025-06-17T00:10:00Z</when>"
            "<when>2025-06-17T00:30:00Z</when></gx:Track></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert _whens(result) == [
            "2025-01-01T00:00:00Z",
            "2025-01-01T01:00:00Z",
            "2025-01-01T00:00:00Z",
            "2025-01-01T00:29:00Z",
            "2025-01-01T00:40:00Z",
            "2025-01-01T01:00:00Z",
        ]
        assert obfuscate_kml_content(result) is None
        kml_file = tmp_path / "evening.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_timestamps_beyond_the_window_start_a_new_flight(self):
        kml = (
            "<kml><when>2025-06-14T22:00:00Z</when>"
            "<when>2025-06-17T00:00:00Z</when></kml>"
        )
        assert _whens(obfuscate_kml_content(kml)) == [
            "2025-01-01T00:00:00Z",
            "2025-01-01T00:00:00Z",
        ]

    def test_date_only_first_when_does_not_block_the_track(self, tmp_path):
        kml = (
            "<kml><Placemark><TimeStamp><when>2025-06-14</when></TimeStamp>"
            "</Placemark><Placemark><gx:Track><when>2025-06-14T09:12:00Z</when>"
            "<gx:coord>9 48 300</gx:coord></gx:Track></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert _whens(result) == ["2025-01-01", "2025-01-01T00:00:00Z"]
        kml_file = tmp_path / "date_only.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    @pytest.mark.parametrize(
        "when,expected",
        [
            ("2025-06-14+02:00", "2025-01-01+02:00"),
            ("2025-06", "2025-01"),
            ("2025-06Z", "2025-01Z"),
            ("2025", "2025"),
        ],
    )
    def test_dates_without_time(self, when, expected):
        result = obfuscate_kml_content(f"<kml><when>{when}</when></kml>")
        assert _whens(result or f"<when>{when}</when>") == [expected]

    def test_creator_is_replaced_without_any_date(self):
        result = obfuscate_kml_content('<kml creator="SkyDemon"><name>x</name></kml>')
        assert result == f'<kml creator="{GENERIC_CREATOR}"><name>x</name></kml>'

    def test_single_quoted_creator_is_replaced(self):
        result = obfuscate_kml_content("<kml creator='SkyDemon'><name>x</name></kml>")
        assert result == f"<kml creator='{GENERIC_CREATOR}'><name>x</name></kml>"

    def test_all_patterns_are_idempotent(self):
        for kml in (SAMPLE_KML, CHARTERWARE_KML, ROUTE_NAME_KML):
            once = obfuscate_kml_content(kml)
            assert once is not None
            assert obfuscate_kml_content(once) is None


class TestRewriteGaps:
    """Shapes the check flagged but the rewrite used to leave to the user."""

    @pytest.mark.parametrize(
        "name",
        [
            "Takeoff: 14 Mar 2024 09:12:05 Z",
            "Takeoff: 4 Mar 2024 09:12 Z",
            "Log Stop: 4 Mar 2024 09:12:05 Z",
        ],
    )
    def test_marker_names_with_seconds_or_a_single_digit_day(self, name):
        result = obfuscate_kml_content(f"<kml><name>{name}</name></kml>")
        label = name.split(":")[0]
        assert result == f"<kml><name>{label}: 2024-01-01</name></kml>"

    @pytest.mark.parametrize(
        "when,expected",
        [
            ("2024-03-14 09:12:00", "2024-01-01T00:00:00Z"),
            ("2024-03-14T09:12:00z", "2024-01-01T00:00:00Z"),
            ("<![CDATA[2024-03-14T09:12:00Z]]>", "2024-01-01T00:00:00Z"),
            ("<![CDATA[ 2024-03-14 09:12:00.5z ]]>", "2024-01-01T00:00:00.5Z"),
        ],
    )
    def test_loose_timestamps_are_rewritten_in_the_canonical_form(
        self, tmp_path, when, expected
    ):
        result = obfuscate_kml_content(f"<kml><when>{when}</when></kml>")
        assert result == f"<kml><when>{expected}</when></kml>"
        kml_file = tmp_path / "t.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_loose_timestamp_at_midnight_on_jan_1_is_normalized(self):
        """The parsers read the canonical form; the time does not move."""
        result = obfuscate_kml_content(
            "<kml><when>2025-01-01 00:00:00</when>"
            "<when>2025-01-01 00:10:00</when></kml>"
        )
        assert result == (
            "<kml><when>2025-01-01T00:00:00Z</when>"
            "<when>2025-01-01T00:10:00Z</when></kml>"
        )

    def test_route_name_with_a_single_digit_day(self):
        result = obfuscate_kml_content(
            "<kml><name>EDDS to EDDP - 6 Aug 2026</name></kml>"
        )
        assert result == "<kml><name>EDDS to EDDP - 01 Jan 2026</name></kml>"

    def test_description_with_a_single_digit_hour(self):
        result = obfuscate_kml_content(
            "<kml><description>Flight Jan 12 2026 3:01PM path</description></kml>"
        )
        assert result == (
            "<kml><description>Flight Jan 01 2026 12:00AM path</description></kml>"
        )


class TestObfuscateFile:
    def test_a_cut_off_track_moves_like_a_whole_one(self, tmp_path):
        """A logger whose battery ran out: the parser reads what comes
        before the cut (see parser._parse_kml_tree), which starts at
        midnight on January 1st like the flight of a whole file."""
        whens = "".join(
            f"<when>2025-06-01T10:{i // 60:02d}:{i % 60:02d}Z</when>\n"
            for i in range(100)
        )
        coords = "".join(
            f"<gx:coord>8.{i:04d} 50.0 {500 + i}</gx:coord>\n" for i in range(60)
        )
        kml_file = tmp_path / "cut.kml"
        kml_file.write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<kml xmlns="http://www.opengis.net/kml/2.2" '
            'xmlns:gx="http://www.google.com/kml/ext/2.2">\n'
            f"<Placemark><gx:Track>\n{whens}{coords}<gx:coord>8.00",
            encoding="utf-8",
        )

        assert obfuscate_kml_file(kml_file) is True

        assert check_kml_obfuscated(kml_file) == []
        _, paths, _ = parse_kml_file(str(kml_file))
        assert len(paths[0]) == 60
        assert paths[0][0].ts == datetime(2025, 1, 1, tzinfo=UTC).timestamp()

    def test_crlf_line_endings_are_kept(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_bytes(SAMPLE_KML.replace("\n", "\r\n").encode())
        assert obfuscate_kml_file(kml_file) is True
        content = kml_file.read_bytes()
        assert b"2025-01-01T00:00:00.5848380Z</when>\r\n" in content
        assert content.count(b"\r\n") == SAMPLE_KML.count("\n")

    @pytest.mark.skipif(
        hasattr(os, "geteuid") and os.geteuid() == 0,
        reason="root may write read-only files",
    )
    def test_read_only_file_is_reported_not_replaced(self, tmp_path, capsys):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        kml_file.chmod(0o444)
        try:
            assert obfuscate_kml_file(kml_file) is False
            assert kml_file.read_text(encoding="utf-8") == SAMPLE_KML
            assert kml_file.stat().st_mode & 0o777 == 0o444
        finally:
            kml_file.chmod(0o644)
        assert "not writable" in capsys.readouterr().err

    def test_symlink_is_not_replaced(self, tmp_path, capsys):
        target = tmp_path / "flight.kml.orig"
        target.write_text(SAMPLE_KML, encoding="utf-8")
        link = tmp_path / "flight.kml"
        link.symlink_to(target)

        assert obfuscate_kml_file(link) is False

        assert link.is_symlink()
        assert target.read_text(encoding="utf-8") == SAMPLE_KML
        assert "symlinks are not allowed" in capsys.readouterr().err

    def test_modifies_file_in_place_atomically(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        kml_file.chmod(0o640)

        with patch("flown.cache.os.replace", wraps=os.replace) as mock_replace:
            assert obfuscate_kml_file(kml_file) is True

        mock_replace.assert_called_once()
        tmp_name, target = mock_replace.call_args[0]
        assert Path(tmp_name).parent == tmp_path
        assert Path(target) == kml_file
        assert "2025-01-01T00:00:00" in kml_file.read_text(encoding="utf-8")
        assert sorted(p.name for p in tmp_path.iterdir()) == ["test.kml"]
        assert kml_file.stat().st_mode & 0o777 == 0o640

    def test_idempotent(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        assert obfuscate_kml_file(kml_file) is True
        first_content = kml_file.read_text(encoding="utf-8")
        assert obfuscate_kml_file(kml_file) is False
        assert kml_file.read_text(encoding="utf-8") == first_content

    def test_invalid_utf8_is_skipped_with_warning(self, tmp_path, caplog):
        kml_file = tmp_path / "test.kml"
        kml_file.write_bytes(b"\xff\xfe<when>2025-03-03T08:25:15Z</when>")
        with caplog.at_level(logging.WARNING, logger="flown"):
            assert obfuscate_kml_file(kml_file) is False
        assert "not valid UTF-8" in caplog.text

    def test_write_failure_leaves_original(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        with patch("flown.cache.os.replace", side_effect=OSError("disk")):
            assert obfuscate_kml_file(kml_file) is False
        assert kml_file.read_text(encoding="utf-8") == SAMPLE_KML
        assert sorted(p.name for p in tmp_path.iterdir()) == ["test.kml"]

    def test_missing_file(self, tmp_path):
        assert obfuscate_kml_file(tmp_path / "missing.kml") is False


class TestObfuscateFiles:
    def test_one_bad_file_does_not_abort_the_run(self, tmp_path):
        good1 = tmp_path / "a.kml"
        good2 = tmp_path / "c.kml"
        bad = tmp_path / "b.kml"
        good1.write_text(SAMPLE_KML, encoding="utf-8")
        good2.write_text(SAMPLE_KML, encoding="utf-8")
        bad.write_text(SAMPLE_KML, encoding="utf-8")

        with patch(
            "flown.obfuscate.obfuscate_kml_content",
            side_effect=[
                obfuscate_kml_content(SAMPLE_KML),
                RuntimeError("boom"),
                obfuscate_kml_content(SAMPLE_KML),
            ],
        ):
            assert obfuscate_kml_files([good1, bad, good2]) == 2

        assert "2025-01-01" in good2.read_text(encoding="utf-8")
        assert "2025-03-03" in bad.read_text(encoding="utf-8")

    def test_directory_skips_symlinks(self, tmp_path, capsys):
        """The generator rejects symlinks; the standalone tool must agree."""
        target = tmp_path / "real.txt"
        target.write_text(SAMPLE_KML, encoding="utf-8")
        (tmp_path / "link.kml").symlink_to(target)
        (tmp_path / "flight.KML").write_text(SAMPLE_KML, encoding="utf-8")

        assert [p.name for p in find_kml_files(tmp_path)] == ["flight.KML"]
        assert obfuscate_kml_directory(tmp_path) == 1
        assert (tmp_path / "link.kml").is_symlink()
        assert target.read_text(encoding="utf-8") == SAMPLE_KML
        assert "link.kml: symlinks are not allowed" in capsys.readouterr().err

    def test_directory_processes_only_kml(self, tmp_path):
        (tmp_path / "data.json").write_text("{}", encoding="utf-8")
        for i in range(3):
            (tmp_path / f"flight_{i}.kml").write_text(SAMPLE_KML, encoding="utf-8")
        assert obfuscate_kml_directory(tmp_path) == 3
        assert obfuscate_kml_directory(tmp_path) == 0


class TestTimestampsNotUnderstood:
    """A timestamp the rewrite cannot read is one it cannot move either."""

    @pytest.mark.parametrize(
        "text", ["1710406320", "14.03.2024 09:12", "not-a-timestamp"]
    )
    def test_the_check_reports_it(self, tmp_path, text):
        kml_file = tmp_path / "t.kml"
        kml_file.write_text(f"<kml><when>{text}</when></kml>", encoding="utf-8")
        assert f"Timestamp not understood, remove or fix it: {text}" in (
            check_kml_obfuscated(kml_file)
        )

    def test_a_unix_time_in_a_when_makes_the_rewrite_refuse(
        self, tmp_path, monkeypatch, capsys
    ):
        """It used to pass the check and stay in the file as it was."""
        kml_file = tmp_path / "1_DEAGJ_DA20.kml"
        original = (
            "<kml><Placemark><gx:Track><when>1710406320</when>"
            "<gx:coord>12.0 51.5 100</gx:coord></gx:Track></Placemark></kml>"
        )
        kml_file.write_text(original, encoding="utf-8")
        monkeypatch.setattr("sys.argv", ["obfuscate", str(tmp_path)])

        with pytest.raises(SystemExit) as exc_info:
            obfuscate_module.main()

        assert exc_info.value.code == 1
        out = capsys.readouterr().out
        assert "Timestamp not understood" in out
        assert "1710406320" in out
        assert kml_file.read_text(encoding="utf-8") == original


class TestKmz:
    """The obfuscator cannot rewrite inside a zip, and says so."""

    @pytest.fixture
    def kmz(self, tmp_path):
        path = tmp_path / "1_DEAGJ_DA20.kmz"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("doc.kml", SAMPLE_KML)
        return path

    def test_is_listed_like_the_generator_lists_it(self, tmp_path, kmz):
        assert find_kml_files(tmp_path) == [kmz]

    def test_is_not_rewritten(self, kmz, capsys):
        before = kmz.read_bytes()
        assert obfuscate_kml_file(kmz) is False
        assert kmz.read_bytes() == before
        assert "unzip it" in capsys.readouterr().err

    def test_the_check_reports_it(self, tmp_path, kmz):
        assert check_directory_obfuscated(tmp_path) == {
            kmz.name: [f"KMZ archive: {obfuscate_module.KMZ_REFUSAL}"]
        }

    def test_a_charterware_name_is_left_as_it_is(self, tmp_path, capsys):
        """Refused as it is: renamed first, the refusal would name a file the
        user never had."""
        path = tmp_path / "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kmz"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("doc.kml", SAMPLE_KML)

        assert obfuscate_module._obfuscate_listed_files([path]) == 0
        assert list(tmp_path.iterdir()) == [path]
        assert path.name in capsys.readouterr().err

    def test_the_check_fails_on_it(self, tmp_path, kmz, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["obfuscate", str(tmp_path), "--check"])
        with pytest.raises(SystemExit) as exc_info:
            obfuscate_module.main()
        assert exc_info.value.code == 1
        assert "KMZ archive" in capsys.readouterr().out


class TestCheckObfuscated:
    def test_detects_unobfuscated_timestamps_and_names(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        violations = check_kml_obfuscated(kml_file)
        assert any("Name element" in v for v in violations)
        assert any(
            "Flight does not start at 00:00:00 on Jan 1" in v for v in violations
        )

    def test_detects_description_and_route_dates(self, tmp_path):
        (tmp_path / "c.kml").write_text(CHARTERWARE_KML, encoding="utf-8")
        (tmp_path / "r.kml").write_text(ROUTE_NAME_KML, encoding="utf-8")
        assert any(
            "Description date" in v for v in check_kml_obfuscated(tmp_path / "c.kml")
        )
        assert any(
            "Route name date" in v for v in check_kml_obfuscated(tmp_path / "r.kml")
        )

    @pytest.mark.parametrize("kml", [SAMPLE_KML, CHARTERWARE_KML, ROUTE_NAME_KML])
    def test_passes_after_obfuscation(self, tmp_path, kml):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(kml, encoding="utf-8")
        obfuscate_kml_file(kml_file)
        assert check_kml_obfuscated(kml_file) == []

    def test_real_creator_is_a_violation(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            '<kml creator="SkyDemon"><when>2025-01-01T00:00:00Z</when></kml>',
            encoding="utf-8",
        )
        violations = check_kml_obfuscated(kml_file)
        assert len(violations) == 1
        assert "SkyDemon" in violations[0]

    def test_generic_creator_is_not_a_violation(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            '<kml creator="flown"><when>2025-01-01T00:00:00Z</when></kml>',
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == []

    @pytest.mark.parametrize(
        "kml",
        [
            "<kml><when>2025-01-01T00:00:00.0000000Z</when></kml>",
            "<kml><when>2025-01-01T00:00:00.25Z</when></kml>",
            "<kml><name>test</name></kml>",
            # A year alone, or nothing, gives nothing away
            "<kml><when>2025</when><when></when></kml>",
        ],
    )
    def test_clean_edge_cases(self, tmp_path, kml):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(kml, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    @pytest.mark.parametrize(
        "extra",
        [
            "<ExtendedData><value>2025-06-14T09:12:00Z</value></ExtendedData>",
            "<description>logged 2025-06-14T09:12:00.123Z</description>",
            "<description>14.06.2025</description>",
            "<description>June 14, 2025</description>",
            "<when>2025-06</when>",
        ],
    )
    def test_dates_anywhere_are_violations(self, tmp_path, extra):
        """A full timestamp has no word boundary between the date and "T"."""
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            f"<kml><when>2025-01-01T00:00:00Z</when>{extra}</kml>", encoding="utf-8"
        )
        assert check_kml_obfuscated(kml_file) != []

    def test_prefixed_timestamps_are_checked(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            '<kml:kml xmlns:kml="http://www.opengis.net/kml/2.2">'
            "<kml:when>2025-06-14T09:12:00Z</kml:when></kml:kml>",
            encoding="utf-8",
        )
        assert any(
            "Flight does not start at 00:00:00 on Jan 1" in v
            for v in check_kml_obfuscated(kml_file)
        )

    def test_date_only_timestamps_must_be_on_jan_1(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            "<kml><when>2025-01-02</when><when>2025-01-01</when></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == ["Timestamp not on Jan 1: 2025-01-02"]

    def test_second_flight_on_another_date_is_a_violation(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            "<kml><when>2025-01-01T00:00:00Z</when>"
            "<when>2025-03-14T10:00:00Z</when></kml>",
            encoding="utf-8",
        )
        violations = check_kml_obfuscated(kml_file)
        assert violations == [
            "Flight does not start at 00:00:00 on Jan 1: 2025-03-14T10:00:00Z",
            "Date not on Jan 1: 2025-03-14",
        ]

    @pytest.mark.parametrize(
        "text,stray",
        [
            ("2025-01-01T23:55:00Z 2025-01-02T00:15:00Z", []),
            ("2025-01-03T21:00:00Z", []),
            ("2025-01-04T00:00:00Z", ["2025-01-04"]),
            ("x2025-06-14y", ["2025-06-14"]),
            ("12025-06-145", []),
            ("12.058459 51.550617", []),
            ("02 Jan 2026 and Jan 3 2026", []),
            ("04 Jan 2026", ["04 Jan 2026"]),
            # Only 01.01 passes in the shapes the tool never writes: 02/01 is
            # February 1st in the US
            ("01/01/2026 01.01.2026", []),
            ("02/01/2026", ["02/01/2026"]),
            ("2026/03/10 2026.03.10", ["2026/03/10", "2026.03.10"]),
            ("2026/01/01", []),
            # A year first with a month or day of one digit
            ("2026/8/16 2026-8-16", ["2026/8/16", "2026-8-16"]),
            ("2026/1/1 2026-1-3", []),
            ("2024.3.1", []),
            ("10 MAR 2026", ["10 MAR 2026"]),
            ("10-Mar-2026", ["10-Mar-2026"]),
            ("SkyDemon for iPhone v4.2.2.429", []),
            ("2026&#45;03&#45;10T10:00:00Z", ["2026-03-10"]),
            # Dash-separated, single-digit and two-digit-year numeric dates
            ("14-03-2024", ["14-03-2024"]),
            ("3/14/2024", ["3/14/2024"]),
            ("1/1/2026 01-01-2026", []),
            ("14.03.24", ["14.03.24"]),
            ("01.01.26", []),
            ("track_14-03-2024.kml", ["14-03-2024"]),
            # Compact dates, with a real month and day only
            ("20240314", ["20240314"]),
            ("flight_20240314.kml", ["20240314"]),
            ("20260101 20260103 20261301 12345678", []),
            ("20260104", ["20260104"]),
            # A year and month, an ISO week and an ordinal date
            ("2024-03", ["2024-03"]),
            ("2026-01 2023-2024", []),
            ("2024-W11 2024-W11-3", ["2024-W11", "2024-W11-3"]),
            ("2026-W01", []),
            ("2024-074", ["2024-074"]),
            ("2026-002", []),
            # Month names with ordinals, without a day, and in file names
            ("14th March 2024", ["14th March 2024"]),
            ("March 2024", ["March 2024"]),
            ("January 2026", []),
            ("N123AB_Mar14_2024.kml", ["Mar14_2024"]),
            ("Cessna 172 2024", []),
            # German, like the English ones
            ("Rundflug 16. Mai 2026", ["16. Mai 2026"]),
            ("16.Mrz.2026 Mai 2026", ["16.Mrz.2026", "Mai 2026"]),
            ("1. Januar 2026 Jänner 2026", []),
            ("Flugplatz Mai", []),
            ("Log Start: 2025-01-01", []),
            ("Flight Jan 01 2026 03:01PM", []),
            # Unix time in a data value
            ("<value>1710406320</value>", ["1710406320"]),
            ("<gx:value>1710406320000</gx:value>", ["1710406320000"]),
            ('<SimpleData name="t">1710406320</SimpleData>', ["1710406320"]),
            ("<value>1735689600</value>", []),
            # Noon on January 1st: the date passes, the time of day does not
            ("<value>1735732800</value>", ["1735732800"]),
            # Anywhere, not only in a data value
            ("<value>12345</value> 1710406320", ["1710406320"]),
            ("<name>Flight 1710406320</name>", ["1710406320"]),
            ("<description>at 1710406320123 ms</description>", ["1710406320123"]),
            # Part of a longer number, which is none
            ("<value>17104063201</value>", []),
            # The fraction of a decimal number is none either
            ("<value>12.1710406320</value>", []),
            # A dot after a word only separates it
            ("<name>log.1710406320</name>", ["1710406320"]),
            # Ten digits, but not a time of this era
            ("<value>9999999999</value>", []),
            # Numbers that read as a time after today: a phone number (2037),
            # a serial number (2093)
            ("<description>Call 2125551234</description>", []),
            ("<value>3912345678</value>", []),
            # An attribute value is an id or a reference, not text
            ('<Style id="1712345678901"/><styleUrl>#s</styleUrl>', []),
            # So is the id a reference points to, which the obfuscator
            # cannot rewrite either
            (
                '<Style id="1712345678901"/><styleUrl>#1712345678901</styleUrl>',
                [],
            ),
            ("<kml:styleUrl>styles.kml#1712345678901</kml:styleUrl>", []),
            ("<Icon><href>icons.kml#1712345678901</href></Icon>", []),
            ("<Update><targetHref>a.kml#1712345678901</targetHref></Update>", []),
            ("<Alias><sourceHref>m.dae#1712345678901</sourceHref></Alias>", []),
            # The path before the id is read
            ("<styleUrl>flight_1710406320.kml#s</styleUrl>", ["1710406320"]),
            # A "#" elsewhere is no reference
            ("<name>#1710406320</name>", ["1710406320"]),
            (
                "<description>&lt;td data-t='1710406320'&gt;&lt;/td&gt;</description>",
                [],
            ),
            # The dates in an attribute are still found by their shape
            ('<Placemark id="2024-03-14"/>', ["2024-03-14"]),
            # A view is 1234567890 m away (2009-02-13 23:31:30 as a time)
            ("<LookAt><gx:range>1234567890</gx:range></LookAt>", []),
            ("<Camera><altitude>1234567890</altitude></Camera>", []),
            # The same number where a time may be is one
            ("<name>1234567890</name>", ["1234567890"]),
            ("<!-- recorded 1710406320 -->", ["1710406320"]),
        ],
    )
    def test_stray_dates_tolerate_the_days_after_jan_1(self, text, stray):
        assert _find_stray_dates(text) == stray

    def test_a_unix_time_after_today_is_no_flight(self):
        # Noon: never the midnight that passes
        noon = int(datetime.now(UTC).timestamp()) // 86400 * 86400 + 43200
        week_ago = str(noon - 7 * 86400)
        in_a_week = str(noon + 7 * 86400)
        assert _find_stray_dates(f"<name>{week_ago} {in_a_week}</name>") == [week_ago]

    @pytest.mark.parametrize(
        "name",
        [
            "flight_20240314.kml",
            "track_14-03-2024.kml",
            "N123AB_Mar14_2024.kml",
            "log 2024-03.kml",
            "flight 2024W33.kml",
        ],
    )
    def test_other_file_name_shapes_are_violations(self, tmp_path, name):
        kml_file = tmp_path / name
        kml_file.write_text("<kml/>", encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == [
            f"File name contains a date: {_find_stray_dates(name)[0]}"
        ]

    def test_leftover_temp_file_is_a_violation(self, tmp_path):
        """A rewrite killed before the rename leaves the original dates in a
        file the KML listing ignores."""
        (tmp_path / "a.kml").write_text(
            "<kml><when>2025-01-01T00:00:00Z</when></kml>", encoding="utf-8"
        )
        leftover = tmp_path / ".a.kml.x1y2z3.tmp"
        leftover.write_text(SAMPLE_KML, encoding="utf-8")

        violations = check_directory_obfuscated(tmp_path)

        assert list(violations) == [".a.kml.x1y2z3.tmp"]
        assert "Leftover temporary file" in violations[".a.kml.x1y2z3.tmp"][0]

    def test_directory_check_sees_hidden_files(self, tmp_path):
        """A hidden file would be published by a build all the same."""
        (tmp_path / ".old").mkdir()
        (tmp_path / ".2_y.kml").write_text(SAMPLE_KML, encoding="utf-8")
        (tmp_path / ".old" / "1_x.kml").write_text(SAMPLE_KML, encoding="utf-8")
        (tmp_path / "._1_x.kml").write_bytes(b"\x00\x05\x16\x07 macOS metadata")

        assert set(check_directory_obfuscated(tmp_path)) == {".2_y.kml", ".old/1_x.kml"}

    def test_directory_check_includes_subdirectories(self, tmp_path):
        """The generator reads subdirectories, so the check has to see them."""
        (tmp_path / "sub" / "deeper").mkdir(parents=True)
        (tmp_path / "a.kml").write_text(SAMPLE_KML, encoding="utf-8")
        (tmp_path / "sub" / "b.kml").write_text(SAMPLE_KML, encoding="utf-8")
        (tmp_path / "sub" / "deeper" / "c.kml").write_text(SAMPLE_KML, encoding="utf-8")

        assert set(check_directory_obfuscated(tmp_path)) == {
            "a.kml",
            "sub/b.kml",
            "sub/deeper/c.kml",
        }
        assert obfuscate_kml_directory(tmp_path) == 3
        assert check_directory_obfuscated(tmp_path) == {}

    @pytest.mark.parametrize(
        ("name", "violations"),
        [
            (
                "20260816143015.kml",
                [
                    "File name contains a date: 20260816",
                    "File name contains a time of day: 143015",
                ],
            ),
            (
                "flight_202608161430.kml",
                [
                    "File name contains a date: 20260816",
                    "File name contains a time of day: 1430",
                ],
            ),
            (
                "log-2026-08-16-14-30.kml",
                [
                    "File name contains a date: 2026-08-16",
                    "File name contains a date: 08-16-14",
                    "File name contains a time of day: 14-30",
                ],
            ),
        ],
    )
    def test_file_name_with_a_date_and_time_in_one_run(
        self, tmp_path, name, violations
    ):
        """A time of day right after a date no longer hides either."""
        kml_file = tmp_path / name
        kml_file.write_text("<kml/>", encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == violations

    def test_charterware_file_name_with_date_is_a_violation(self, tmp_path):
        kml_file = tmp_path / "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml"
        kml_file.write_text(
            "<kml><when>2026-01-01T00:00:00Z</when></kml>", encoding="utf-8"
        )
        assert check_kml_obfuscated(kml_file) == [
            "File name contains the flight date: 2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml"
        ]
        renamed = tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        kml_file.rename(renamed)
        assert check_kml_obfuscated(renamed) == []

    def test_other_file_name_with_date_is_a_violation(self, tmp_path):
        kml_file = tmp_path / "flight 14.06.2025.kml"
        kml_file.write_text("<kml/>", encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == [
            "File name contains a date: 14.06.2025"
        ]

    @pytest.mark.parametrize(
        ("name", "violation"),
        [
            ("1_DEHYL_1513h.kml", "a time of day: 1513h"),
            ("1_DEHYL_15h13.kml", "a time of day: 15h13"),
            ("1_DEHYL_0930z.kml", "a time of day: 0930z"),
            ("EDDS 0930UTC.kml", "a time of day: 0930UTC"),
            ("EDDS 15:13.kml", "a time of day: 15:13"),
            ("Log_2026-01-01_1430.kml", "a time of day: 1430"),
            ("2026-01-01_0000h_OE-AKI_LOAV-LOAV_1513h.kml", "a time of day: 1513h"),
            ("1_DEHYL_1513H.kml", "a time of day: 1513H"),
            ("EDDS 3pm.kml", "a time of day: 3pm"),
            ("Aunt farm 1430 GMT.kml", "a time of day: 1430 GMT"),
            ("EDDS 0930 hours.kml", "a time of day: 0930 hours"),
            ("Block 0930Z-1045Z.kml", "a time of day: 0930Z-1045Z"),
            ("EDDS 1430 Zulu.kml", "a time of day: 1430 Zulu"),
            ("EDDS 14.30Z.kml", "a time of day: 14.30Z"),
            ("EDDS 14h30 UTC.kml", "a time of day: 14h30 UTC"),
            ("EDDS 1430+0200.kml", "a time of day: 1430+0200"),
            ("Aunt farm 2026-01-01 14-30.kml", "a time of day: 14-30"),
            ("Aunt farm 2026-01-01_14-30.kml", "a time of day: 14-30"),
            ("Aunt farm 2026-01-01 14_30.kml", "a time of day: 14_30"),
            ("Aunt farm 2026-01-01 14-30h.kml", "a time of day: 14-30h"),
            ("Aunt farm 2026-01-01 14-30 h.kml", "a time of day: 14-30 h"),
            ("Aunt farm 2026-01-01_14-30h.kml", "a time of day: 14-30h"),
            ("Aunt farm 2026-01-01 14-30 hrs.kml", "a time of day: 14-30 hrs"),
            ("Aunt farm 14.30-15.45 Uhr.kml", "a time of day: 14.30-15.45 Uhr"),
            ("Aunt farm 14.30-15.45Z.kml", "a time of day: 14.30-15.45Z"),
            ("Aunt farm 14.30 bis 15.45 Uhr.kml", "a time of day: 14.30 bis 15.45 Uhr"),
            ("EDDS - EDDF Saturday.kml", "a weekday: Saturday"),
            ("1_DEHYL_Sonntag.kml", "a weekday: Sonntag"),
        ],
    )
    def test_file_name_with_a_time_or_weekday_is_a_violation(
        self, tmp_path, name, violation
    ):
        """The export takes them out, but the file itself is public."""
        kml_file = tmp_path / name
        kml_file.write_text("<kml/>", encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == [f"File name contains {violation}"]

    @pytest.mark.parametrize(
        "name",
        [
            "1_DEHYL_DA40.kml",
            "12_DEAGJ_C172.kml",
            "3_N1430Z_PA28.kml",
            "4_N1513H_C172.kml",
            "5_DO27.kml",
            "2026-01-01_0003h_RA-1513H_UUBW-UUBW.kml",
        ],
    )
    def test_file_name_without_a_time_passes(self, tmp_path, name):
        kml_file = tmp_path / name
        kml_file.write_text("<kml/>", encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    @settings(max_examples=100)
    @given(slot=st.integers(min_value=0, max_value=24 * 60 - 1))
    def test_only_the_charterware_slot_may_look_like_a_time(
        self, tmp_path_factory, slot
    ):
        """The slot of a renamed Charterware file is a sequence number."""
        time = f"{slot // 60:02d}{slot % 60:02d}h"
        directory = tmp_path_factory.mktemp("slot")
        charterware = directory / f"2026-01-01_{time}_OE-AKI_LOAV-LOAV.kml"
        numbered = directory / f"1_DEHYL_{time}.kml"
        for kml_file in (charterware, numbered):
            kml_file.write_text("<kml/>", encoding="utf-8")
        assert check_kml_obfuscated(charterware) == []
        assert check_kml_obfuscated(numbered) == [
            f"File name contains a time of day: {time}"
        ]

    @pytest.mark.parametrize(
        ("element", "violation"),
        [
            ("<name>Flight 16<!-- -->.08.2026</name>", "Date not on Jan 1: 16.08.2026"),
            ("<name>Flight 16<?x?>.08.2026</name>", "Date not on Jan 1: 16.08.2026"),
            (
                "<name>Flight 14:<!-- -->30</name>",
                "Time of day gives the flight away, remove it: 14:30",
            ),
            (
                "<name>Sun<!-- -->day flight</name>",
                "Weekday gives the day of the flight away, remove it: Sunday",
            ),
            # A date in the comment itself counts as well
            (
                "<!-- logged 2026-08-16 --><name>EDDS</name>",
                "Date not on Jan 1: 2026-08-16",
            ),
        ],
    )
    def test_a_comment_does_not_hide_a_date(self, tmp_path, element, violation):
        """A reader sees the text of an element without its comments and
        processing instructions, and so does the check."""
        kml_file = tmp_path / "1_DEHYL_DA40.kml"
        kml_file.write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            f"<kml><Placemark>{element}"
            "<when>2026-01-01T00:00:00Z</when></Placemark></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == [violation]

    def test_the_xml_declaration_and_a_comment_pass(self, tmp_path):
        kml_file = tmp_path / "1_DEHYL_DA40.kml"
        kml_file.write_text(
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            "<kml><!-- exported --><Placemark><name>EDDS</name>"
            "<when>2026-01-01T00:00:00Z</when></Placemark></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == []

    def test_weekday_in_a_file_is_a_violation(self, tmp_path):
        """The timestamps moved to January 1st, the weekday of the flight
        did not."""
        kml_file = tmp_path / "1_DEHYL_DA40.kml"
        kml_file.write_text(
            "<kml><Placemark><name>Saturday flight</name>"
            "<when>2026-01-01T00:00:00Z</when></Placemark></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == [
            "Weekday gives the day of the flight away, remove it: Saturday"
        ]

    @pytest.mark.parametrize(
        ("element", "time"),
        [
            ("<name>EDDS 1513h</name>", "1513h"),
            ("<name>Evening flight 18:30</name>", "18:30"),
            ("<description>Off blocks 0930Z</description>", "0930Z"),
            ("<description>logged 2026-01-01T09:12:00Z</description>", "T09:12:00Z"),
            # Zones other than UTC and the German ones, the local time and
            # the hours, with the fraction and the offset along
            ("<name>Home strip - Aunt farm 1430 GMT</name>", "1430 GMT"),
            ("<name>Aunt farm 1430 EST</name>", "1430 EST"),
            ("<name>Aunt farm 14:30 BST</name>", "14:30 BST"),
            ("<name>Aunt farm 1430 local</name>", "1430 local"),
            ("<name>Aunt farm 0930 hours</name>", "0930 hours"),
            ("<name>Aunt farm 14:30 +02:00</name>", "14:30 +02:00"),
            ("<name>Aunt farm 14:30:00.123Z</name>", "14:30:00.123Z"),
        ],
    )
    def test_time_of_day_in_a_file_is_a_violation(self, tmp_path, element, time):
        """The timestamps start at midnight, a time in a name would not."""
        kml_file = tmp_path / "1_DEHYL_DA40.kml"
        kml_file.write_text(
            f"<kml><Placemark>{element}"
            "<when>2026-01-01T00:00:00Z</when></Placemark></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == [
            f"Time of day gives the flight away, remove it: {time}"
        ]

    @pytest.mark.parametrize(
        "time",
        [
            "2026-01-01T15:13:00Z",
            "2026-01-01T00:00:01Z",
            "2026-01-01T00:01:00Z",
            "2026-01-02T00:00:00Z",
        ],
    )
    def test_a_flight_starting_at_another_time_is_a_violation(self, tmp_path, time):
        """Only midnight on January 1st gives nothing away."""
        kml_file = tmp_path / "1_DEHYL_DA40.kml"
        kml_file.write_text(
            f"<kml><Placemark><when>{time}</when>"
            "<when>2026-01-03T00:00:00Z</when></Placemark></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == [
            f"Flight does not start at 00:00:00 on Jan 1: {time}"
        ]

    def test_description_time_must_be_midnight(self, tmp_path):
        kml_file = tmp_path / "c.kml"
        kml_file.write_text(
            "<kml><description>Flight Jan 01 2026 03:01PM path of OE-AKI"
            "</description></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == [
            "Description date not on Jan 1 at 12:00AM: Flight Jan 01 2026 03:01PM"
        ]
        kml_file.write_text(
            "<kml><description>Flight Jan 01 2026 12:00AM path of OE-AKI"
            "</description></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == []

    def test_unreadable_file_is_a_violation(self, tmp_path):
        # A file that cannot be read must not be certified as obfuscated
        violations = check_kml_obfuscated(tmp_path / "missing.kml")
        assert len(violations) == 1
        assert "Cannot read file" in violations[0]

    def test_directory_check(self, tmp_path):
        (tmp_path / "a.kml").write_text(SAMPLE_KML, encoding="utf-8")
        (tmp_path / "b.kml").write_text(SAMPLE_KML, encoding="utf-8")
        assert set(check_directory_obfuscated(tmp_path)) == {"a.kml", "b.kml"}
        obfuscate_kml_directory(tmp_path)
        assert check_directory_obfuscated(tmp_path) == {}


class TestDifferentYearsAndMidnight:
    def test_preserves_different_years(self, tmp_path):
        kml_2026 = SAMPLE_KML.replace("2025-03-03", "2026-06-15").replace(
            "03 Mar 2025", "15 Jun 2026"
        )
        result = obfuscate_kml_content(kml_2026)
        assert result is not None
        assert "2026-01-01T00:00:00.5848380Z" in result
        assert "2026-06-15" not in result

    def test_midnight_crossover(self, tmp_path):
        """A flight across midnight starts at midnight and keeps its length."""
        kml = (
            "<kml><Placemark><name>Log Start: 03 Mar 2025 23:55 Z</name></Placemark>"
            "<when>2025-03-03T23:55:00.0000000Z</when>"
            "<when>2025-03-04T00:15:00.0000000Z</when>"
            "<Placemark><name>Log Stop: 04 Mar 2025 00:15 Z</name></Placemark></kml>"
        )
        result = obfuscate_kml_content(kml)
        assert result is not None
        assert _whens(result) == [
            "2025-01-01T00:00:00.0000000Z",
            "2025-01-01T00:20:00.0000000Z",
        ]
        assert "<name>Log Stop: 2025-01-01</name>" in result
        kml_file = tmp_path / "late.kml"
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []


class TestExtractFrac:
    @pytest.mark.parametrize(
        "ts,expected",
        [
            ("2025-03-03T08:25:15.5848385Z", ".5848385"),
            ("2025-03-03T08:25:15.123", ".123"),
            ("2025-03-03T08:25:15.5+02:00", ".5"),
            ("2025-03-03T08:25:15,5Z", ".5"),
            ("2025-03-03T08:25:15,123456+02:00", ".123456"),
            ("2025-03-03T08:25:15Z", ""),
        ],
    )
    def test_extract(self, ts, expected):
        assert _extract_frac(ts) == expected


class TestProperties:
    @settings(max_examples=100)
    @given(
        st.datetimes(
            # Hypothesis takes naive bounds and adds the time zone itself
            min_value=datetime(2000, 1, 2),  # noqa: DTZ001
            max_value=datetime(2099, 12, 30),  # noqa: DTZ001
            timezones=st.just(UTC),
        ),
        st.lists(st.integers(min_value=0, max_value=3600), min_size=1, max_size=8),
    )
    def test_idempotent_and_deltas_preserved(self, start, gaps):
        start = start.replace(microsecond=0)
        times = [start]
        for gap in gaps:
            times.append(times[-1] + timedelta(seconds=gap))
        content = (
            "<kml>"
            + "".join(f"<when>{t.strftime('%Y-%m-%dT%H:%M:%S')}Z</when>" for t in times)
            + "</kml>"
        )

        once = obfuscate_kml_content(content)
        if once is None:
            # Already at midnight on Jan 1
            assert (start.month, start.day) == (1, 1)
            assert start.time() == datetime.min.time()
            return

        shifted = [_parse_utc(ts) for ts in _whens(once)]
        assert shifted[0] == start.replace(month=1, day=1, hour=0, minute=0, second=0)
        for original_gap, (a, b) in zip(gaps, pairwise(shifted), strict=True):
            assert (b - a) == timedelta(seconds=original_gap)
        assert obfuscate_kml_content(once) is None

    @given(st.text(alphabet="0123456789 -\tAugMai.", max_size=40))
    @example("EDDS 16 Aug 2026")
    @example("116 Aug 2026")
    @example("6 Aug 2026-08-16")
    @example("12026-08-16")
    def test_the_rewrite_knows_every_date_shape_the_parser_reads(self, text):
        """A date DATE_PATTERN finds is one NAME_YEAR_DATE_PATTERN moves."""
        for match in DATE_PATTERN.finditer(text):
            assert NAME_YEAR_DATE_PATTERN.fullmatch(match.group(0)), match.group(0)


class TestCLI:
    def test_check_mode_exits_1_on_violations(self, tmp_path, capsys):
        (tmp_path / "test.kml").write_text(SAMPLE_KML, encoding="utf-8")
        with (
            patch("sys.argv", ["obfuscate", str(tmp_path), "--check"]),
            pytest.raises(SystemExit) as e,
        ):
            main()
        assert e.value.code == 1
        out = capsys.readouterr().out
        assert "violations" in out
        # The way out, for a file an earlier version left at its time of day
        assert "make obfuscate" in out

    def test_check_mode_exits_0_on_clean(self, tmp_path, capsys):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        obfuscate_kml_file(kml_file)
        with patch("sys.argv", ["obfuscate", str(tmp_path), "--check"]):
            main()
        assert "All 1 KML file(s) are properly obfuscated" in capsys.readouterr().out

    def test_check_mode_reports_leftover_temp_files(self, tmp_path, capsys):
        (tmp_path / ".test.kml.abcd.tmp").write_text(SAMPLE_KML, encoding="utf-8")
        with (
            patch("sys.argv", ["obfuscate", str(tmp_path), "--check"]),
            pytest.raises(SystemExit) as e,
        ):
            main()
        assert e.value.code == 1
        assert ".test.kml.abcd.tmp: Leftover temporary file" in capsys.readouterr().out

    def test_nested_files_are_obfuscated_and_named_by_their_path(
        self, tmp_path, capsys
    ):
        (tmp_path / "sub").mkdir()
        (tmp_path / "sub" / "test.kml").write_text(SAMPLE_KML, encoding="utf-8")
        with patch("sys.argv", ["obfuscate", str(tmp_path)]):
            main()
        assert "Obfuscated 1 of 1" in capsys.readouterr().out
        (tmp_path / "sub" / "test.kml").write_text(SAMPLE_KML, encoding="utf-8")
        with (
            patch("sys.argv", ["obfuscate", str(tmp_path), "--check"]),
            pytest.raises(SystemExit),
        ):
            main()
        assert "  sub/test.kml: " in capsys.readouterr().out

    def test_obfuscate_mode(self, tmp_path, capsys):
        (tmp_path / "test.kml").write_text(SAMPLE_KML, encoding="utf-8")
        with patch("sys.argv", ["obfuscate", str(tmp_path)]):
            main()
        assert "Obfuscated 1 of 1" in capsys.readouterr().out

    def test_obfuscate_mode_exits_1_for_a_file_it_could_not_fix(self, tmp_path, capsys):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        kml_file.chmod(0o444)
        try:
            with (
                patch("sys.argv", ["obfuscate", str(tmp_path)]),
                pytest.raises(SystemExit) as e,
            ):
                main()
        finally:
            kml_file.chmod(0o644)
        assert e.value.code == 1
        assert "test.kml: " in capsys.readouterr().out

    def test_each_date_is_reported_once(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            "<kml><Placemark><when>2025-01-01T00:00:00Z</when></Placemark>"
            "<ExtendedData>2025-09-21 2025-09-21 2025-09-21</ExtendedData></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == ["Date not on Jan 1: 2025-09-21"]

    def test_numbers_that_are_no_time_pass_the_check(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            '<kml><Style id="1712345678901"/>'
            "<Placemark><styleUrl>#1712345678901</styleUrl>"
            "<when>2025-01-01T00:00:00Z</when>"
            "<description>Call 2125551234, serial 3912345678</description>"
            "<LookAt><range>1234567890</range></LookAt></Placemark></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == []

    def test_a_past_unix_time_in_a_name_fails_the_check(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            "<kml><Placemark><when>2025-01-01T00:00:00Z</when>"
            "<name>Flight 1710406320</name></Placemark></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == [
            "Unix time not at midnight on Jan 1, remove it: 1710406320"
        ]

    def test_a_past_unix_time_next_to_a_style_reference_fails(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(
            '<kml><Style id="1712345678901"/>'
            "<Placemark><styleUrl>#1712345678901</styleUrl>"
            "<when>2025-01-01T00:00:00Z</when>"
            "<description>Landed 1710406320</description></Placemark></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == [
            "Unix time not at midnight on Jan 1, remove it: 1710406320"
        ]

    def test_a_unix_time_of_day_is_reported_as_one(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        # Noon on January 1st: on the right day, at a time of day
        kml_file.write_text(
            "<kml><Placemark><when>2025-01-01T00:00:00Z</when></Placemark>"
            "<ExtendedData><value>1735732800</value></ExtendedData></kml>",
            encoding="utf-8",
        )
        assert check_kml_obfuscated(kml_file) == [
            "Unix time not at midnight on Jan 1, remove it: 1735732800"
        ]

    def test_exits_1_for_invalid_directory(self, tmp_path, capsys):
        with (
            patch("sys.argv", ["obfuscate", str(tmp_path / "nonexistent")]),
            pytest.raises(SystemExit) as e,
        ):
            main()
        assert e.value.code == 1
        assert "not a directory" in capsys.readouterr().err


class TestUnparsableDates:
    """Dates the patterns match but the calendar rejects.

    In a name they move to January 1st, since the parser reads their year;
    elsewhere they stay as they are.
    """

    def test_description_with_unknown_month(self):
        content = (
            "<kml><when>2025-03-03T08:00:00Z</when>"
            "<description>Flight Foo 12 2025 03:01PM</description></kml>"
        )
        result = obfuscate_module.obfuscate_kml_content(content)
        assert result is not None
        assert "Flight Foo 12 2025 03:01PM" in result
        assert "2025-01-01T00:00:00Z" in result

    def test_description_with_invalid_day(self):
        content = (
            "<kml><when>2025-03-03T08:00:00Z</when>"
            "<description>Flight Feb 31 2025 03:01PM</description></kml>"
        )
        result = obfuscate_module.obfuscate_kml_content(content)
        assert result is not None
        assert "Flight Feb 31 2025 03:01PM" in result

    def test_route_name_with_unknown_month(self):
        content = (
            "<kml><when>2025-03-03T08:00:00Z</when>"
            "<name>EDDS to EDDP - 16 Foo 2025</name></kml>"
        )
        result = obfuscate_module.obfuscate_kml_content(content)
        assert result is not None
        assert "16 Foo 2025" in result

    def test_route_name_with_invalid_day(self):
        """The parser reads the year of a day that does not exist as well."""
        content = (
            "<kml><when>2025-03-03T08:00:00Z</when>"
            "<name>EDDS to EDDP - 31 Feb 2025</name></kml>"
        )
        result = obfuscate_module.obfuscate_kml_content(content)
        assert result == (
            "<kml><when>2025-01-01T00:00:00Z</when>"
            "<name>EDDS to EDDP - 01 Jan 2025</name></kml>"
        )

    def test_route_only_document(self):
        content = "<kml><name>EDDS to EDDP - 16 Aug 2026</name></kml>"
        result = obfuscate_module.obfuscate_kml_content(content)
        assert result == "<kml><name>EDDS to EDDP - 01 Jan 2026</name></kml>"

    def test_an_iso_route_date(self, tmp_path):
        """The parser reads it as the date of the route, as it reads 16 Aug 2026."""
        content = "<kml><name>EDDS to EDDP - 2026-08-16</name></kml>"
        result = obfuscate_module.obfuscate_kml_content(content)
        assert result == "<kml><name>EDDS to EDDP - 2026-01-01</name></kml>"
        kml_file = tmp_path / "route.kml"
        kml_file.write_text(content, encoding="utf-8")
        assert any("Route name date" in v for v in check_kml_obfuscated(kml_file))
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []
        # A day that does not exist moves, as in the other form
        assert (
            obfuscate_kml_content("<kml><name>X - 2026-02-31</name></kml>")
            == "<kml><name>X - 2026-01-01</name></kml>"
        )

    def test_unparsable_dates_alone_give_none(self):
        assert obfuscate_kml_content("<kml><name>X - 31 Foo 2026</name></kml>") is None
        assert (
            obfuscate_kml_content(
                "<kml><description>Flight Foo 12 2026 03:01PM</description></kml>"
            )
            is None
        )


CHARTERWARE_NAME = "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml"


class TestRenameCharterwareFiles:
    def _write(self, directory, name):
        path = directory / name
        path.write_text(CHARTERWARE_KML, encoding="utf-8")
        return path

    def test_date_and_time_are_removed(self, tmp_path):
        path = self._write(tmp_path, CHARTERWARE_NAME)
        other = self._write(tmp_path, "1_DEAGJ_DA20.kml")

        result = rename_charterware_files([other, path])

        renamed = tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        assert result == [other, renamed]
        assert renamed.read_text(encoding="utf-8") == CHARTERWARE_KML
        assert not path.exists()
        info = parse_aircraft_from_filename(renamed.name)
        assert info is not None
        assert info.route == "LOAV-LOAV"

    def test_numbers_follow_the_flight_order_per_year(self, tmp_path):
        names = [
            "2026-03-05_0830h_OE-AKI_LOAV-LOAV.kml",
            "2025-07-01_1200h_D-EXYZ_EDDF-EDDM.kml",
            "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml",
            "2026-02-01_0900h_D-EXYZ_EDDF-EDDM.KML",
        ]
        paths = [self._write(tmp_path, name) for name in names]

        result = rename_charterware_files(paths)

        assert [p.name for p in result] == [
            "2026-01-01_0002h_OE-AKI_LOAV-LOAV.kml",
            "2025-01-01_0000h_D-EXYZ_EDDF-EDDM.kml",
            "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml",
            "2026-01-01_0001h_D-EXYZ_EDDF-EDDM.KML",
        ]
        assert sorted(p.name for p in tmp_path.iterdir()) == sorted(
            p.name for p in result
        )

    def test_new_files_continue_after_existing_numbers(self, tmp_path):
        self._write(tmp_path, "2026-01-01_0059h_OE-AKI_LOAV-LOAV.kml")
        path = self._write(tmp_path, CHARTERWARE_NAME)

        assert rename_charterware_files([path])[0].name == (
            "2026-01-01_0100h_OE-AKI_LOAV-LOAV.kml"
        )

    def test_existing_files_are_never_replaced(self, tmp_path):
        """A file the scan missed or a dangling symlink still takes the name."""
        (tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml").symlink_to(
            tmp_path / "missing"
        )
        taken = tmp_path / "2026-01-01_0001h_OE-AKI_LOAV-LOAV.kml"
        taken.write_text("other flight", encoding="utf-8")
        path = self._write(tmp_path, CHARTERWARE_NAME)

        with patch.object(
            obfuscate_module, "_used_charterware_slots", return_value=set()
        ):
            result = rename_charterware_files([path])

        assert result[0].name == "2026-01-01_0002h_OE-AKI_LOAV-LOAV.kml"
        assert taken.read_text(encoding="utf-8") == "other flight"

    def test_free_numbers_below_the_highest_are_used_last(self, tmp_path):
        self._write(tmp_path, "2026-01-01_2359h_OE-AKI_LOAV-LOAV.kml")
        path = self._write(tmp_path, CHARTERWARE_NAME)

        assert rename_charterware_files([path])[0].name == (
            "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        )

    def test_no_free_number_keeps_the_file(self, tmp_path, capsys):
        path = self._write(tmp_path, CHARTERWARE_NAME)
        with patch.object(
            obfuscate_module,
            "_used_charterware_slots",
            return_value=set(range(obfuscate_module.MINUTES_PER_DAY)),
        ):
            assert rename_charterware_files([path]) == [path]
        assert path.exists()
        assert "no free January 1st name" in capsys.readouterr().err

    def test_rename_failure_keeps_the_file(self, tmp_path, capsys):
        path = self._write(tmp_path, CHARTERWARE_NAME)
        with (
            patch("flown.obfuscate.os.link", side_effect=OSError("denied")),
            patch("flown.obfuscate.os.rename", side_effect=OSError("denied")),
        ):
            assert rename_charterware_files([path]) == [path]
        assert "Cannot rename" in capsys.readouterr().err
        assert path.exists()

    def test_a_name_taken_after_the_scan_is_not_overwritten(self, tmp_path):
        """Another run renaming into the directory must not lose a flight."""
        path = self._write(tmp_path, CHARTERWARE_NAME)
        taken = tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        real_link = os.link

        def link_after_other_run(src, dst, **kwargs):
            if Path(dst) == taken and not taken.exists():
                taken.write_text("other flight", encoding="utf-8")
            return real_link(src, dst, **kwargs)

        with patch("flown.obfuscate.os.link", side_effect=link_after_other_run):
            renamed = rename_charterware_files([path])

        assert taken.read_text(encoding="utf-8") == "other flight"
        assert renamed == [tmp_path / "2026-01-01_0001h_OE-AKI_LOAV-LOAV.kml"]
        assert not path.exists()

    def test_renames_without_hard_link_support(self, tmp_path):
        path = self._write(tmp_path, CHARTERWARE_NAME)
        with patch("flown.obfuscate.os.link", side_effect=OSError("no links")):
            renamed = rename_charterware_files([path])
        assert renamed == [tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"]
        assert renamed[0].exists()
        assert not path.exists()

    def test_obfuscated_names_and_symlinks_are_left_alone(self, tmp_path):
        done = self._write(tmp_path, "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml")
        target = self._write(tmp_path, "target.txt")
        link = tmp_path / CHARTERWARE_NAME
        link.symlink_to(target)

        assert rename_charterware_files([done, link]) == [done, link]
        assert link.is_symlink()

    def test_unlistable_directory_has_no_used_numbers(self, tmp_path):
        with patch.object(Path, "iterdir", side_effect=OSError("denied")):
            assert obfuscate_module._used_charterware_slots(tmp_path, "2026") == set()

    def test_directory_obfuscation_renames_and_rewrites(self, tmp_path, capsys):
        self._write(tmp_path, CHARTERWARE_NAME)
        (tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml").write_text(
            obfuscate_kml_content(CHARTERWARE_KML), encoding="utf-8"
        )
        with patch("sys.argv", ["obfuscate", str(tmp_path)]):
            main()
        assert "Obfuscated 1 of 2" in capsys.readouterr().out
        assert sorted(p.name for p in tmp_path.iterdir()) == [
            "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml",
            "2026-01-01_0001h_OE-AKI_LOAV-LOAV.kml",
        ]
        assert check_directory_obfuscated(tmp_path) == {}
        assert obfuscate_kml_directory(tmp_path) == 0


class TestErrorBranches:
    def test_exception_in_one_file_is_logged_and_the_rest_continue(
        self, tmp_path, capsys
    ):
        first = tmp_path / "1.kml"
        second = tmp_path / "2.kml"
        for path in (first, second):
            path.write_text(SAMPLE_KML, encoding="utf-8")

        original = obfuscate_module.obfuscate_kml_file

        def flaky(path):
            if path == first:
                raise RuntimeError("boom")
            return original(path)

        with patch.object(obfuscate_module, "obfuscate_kml_file", side_effect=flaky):
            assert obfuscate_module.obfuscate_kml_files([first, second]) == 1
        assert "Failed to obfuscate" in capsys.readouterr().err
        assert "2025-01-01" in second.read_text(encoding="utf-8")

    def test_os_error_is_logged_without_a_traceback(self, tmp_path, capsys):
        path = tmp_path / "1.kml"
        path.write_text(SAMPLE_KML, encoding="utf-8")

        with patch.object(
            obfuscate_module,
            "obfuscate_kml_file",
            side_effect=PermissionError("read-only"),
        ):
            assert obfuscate_module.obfuscate_kml_files([path]) == 0
        err = capsys.readouterr().err
        assert "Failed to obfuscate" in err
        assert "read-only" in err
        assert "Traceback" not in err

    def test_unlistable_directory_yields_no_files(self, tmp_path):
        with patch.object(Path, "iterdir", side_effect=OSError("denied")):
            assert obfuscate_module.find_kml_files(tmp_path) == []

    def test_write_flushes_to_disk_before_replacing(self, tmp_path):
        kml_file = tmp_path / "test.kml"
        kml_file.write_text(SAMPLE_KML, encoding="utf-8")
        calls = []
        real_fsync = os.fsync

        def recording_fsync(fd):
            calls.append(fd)
            return real_fsync(fd)

        with patch("flown.cache.os.fsync", side_effect=recording_fsync):
            assert obfuscate_module.obfuscate_kml_file(kml_file) is True
        # Once for the temp file, once for the directory entry
        assert len(calls) == 2


def _kml(body):
    return f"<kml><when>2026-01-01T00:00:00Z</when>{body}</kml>"


class TestNamesAndDescriptions:
    """What the check reports in a name or a description, the rewrite fixes."""

    @pytest.mark.parametrize(
        ("body", "violation", "fixed"),
        [
            (
                "<name>EDDS-EDDP 16 Aug</name>",
                "Name or description contains part of a date: 16 Aug",
                "<name>EDDS-EDDP</name>",
            ),
            (
                "<name>Rundflug 16.08.</name>",
                "Name or description contains part of a date: 16.08.",
                "<name>Rundflug</name>",
            ),
            (
                "<name>Flug 2026 08 16</name>",
                "Date not on Jan 1: 2026 08 16",
                "<name>Flug</name>",
            ),
            (
                "<name>EDDS 16\u201308\u20132026</name>",
                "Date not on Jan 1: 16\u201308\u20132026",
                "<name>EDDS</name>",
            ),
            (
                "<name>EDDS 16 Aug 2026</name>",
                "Date not on Jan 1: 16 Aug 2026",
                "<name>EDDS 01 Jan 2026</name>",
            ),
            (
                "<name>Sunday 14:30 local</name>",
                "Weekday gives the day of the flight away, remove it: Sunday",
                "<name></name>",
            ),
            (
                "<name>log 1710406320</name>",
                "Unix time not at midnight on Jan 1, remove it: 1710406320",
                "<name>log</name>",
            ),
            (
                "<name>EDAW 10am-12pm EDAQ</name>",
                "Time of day gives the flight away, remove it: 12pm",
                "<name>EDAW EDAQ</name>",
            ),
            (
                "<description>Off blocks 10 AM, on blocks 11 PM</description>",
                "Time of day gives the flight away, remove it: 10 AM",
                "<description>Off blocks, on blocks</description>",
            ),
            (
                "<description>Flown on 16 Aug, back by 18:00</description>",
                "Name or description contains part of a date: 16 Aug",
                "<description>Flown on, back by</description>",
            ),
            (
                "<name><![CDATA[Trip 16/08 <b>]]></name>",
                "Name or description contains part of a date: 16/08",
                "<name><![CDATA[Trip <b>]]></name>",
            ),
            (
                "<name>Trip 16<!-- -->.08.2026 &amp; back</name>",
                "Date not on Jan 1: 16.08.2026",
                "<name>Trip &amp; back</name>",
            ),
            # Times after a date with hyphens or underscores, ranges with a
            # dot and German ranges of days, which left a part behind
            (
                "<name>Aunt farm 2026-01-01 14-30</name>",
                "Time of day gives the flight away, remove it: 14-30",
                "<name>Aunt farm 2026-01-01</name>",
            ),
            (
                "<name>Aunt farm 2026-01-01 14_30</name>",
                "Time of day gives the flight away, remove it: 14_30",
                "<name>Aunt farm 2026-01-01</name>",
            ),
            # With the letter of the clock, which read as a unit
            (
                "<name>Aunt farm 2026-01-01 14-30h</name>",
                "Time of day gives the flight away, remove it: 14-30h",
                "<name>Aunt farm 2026-01-01</name>",
            ),
            (
                "<name>Aunt farm 2026-01-01_14-30 h EDDS</name>",
                "Time of day gives the flight away, remove it: 14-30 h",
                "<name>Aunt farm 2026-01-01 EDDS</name>",
            ),
            (
                "<name>Aunt farm 14.30-15.45 Uhr</name>",
                "Time of day gives the flight away, remove it: 14.30-15.45 Uhr",
                "<name>Aunt farm</name>",
            ),
            (
                "<name>Aunt farm 01.01.2026 14.30-15.45 Uhr</name>",
                "Time of day gives the flight away, remove it: 14.30-15.45 Uhr",
                "<name>Aunt farm 01.01.2026</name>",
            ),
            (
                "<name>Aunt farm 16.-18.08.2026</name>",
                "Date not on Jan 1: 16.-18.08.2026",
                "<name>Aunt farm</name>",
            ),
            # A range joined by a word, and a hyphenated time after the T
            (
                "<name>Aunt farm 14.30 bis 15.45 Uhr</name>",
                "Time of day gives the flight away, remove it: 14.30 bis 15.45 Uhr",
                "<name>Aunt farm</name>",
            ),
            (
                "<name>Aunt farm 2026-01-01T14-30-00Z EDDS</name>",
                "Time of day gives the flight away, remove it: T14-30-00Z",
                "<name>Aunt farm 2026-01-01 EDDS</name>",
            ),
        ],
    )
    def test_the_rewrite_fixes_what_the_check_reports(
        self, tmp_path, body, violation, fixed
    ):
        kml_file = tmp_path / "flight.kml"
        kml_file.write_text(_kml(body), encoding="utf-8")
        assert violation in check_kml_obfuscated(kml_file)

        assert obfuscate_kml_content(_kml(body)) == _kml(fixed)
        kml_file.write_text(_kml(fixed), encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    def test_a_name_keeps_the_year_the_parser_reads(self, tmp_path):
        kml_file = tmp_path / "flight.kml"
        kml_file.write_text(
            "<kml><Placemark><name>EDDS 16 Aug 2026</name><LineString>"
            "<coordinates>9.2,48.7,400 9.3,48.8,500 9.4,48.9,600</coordinates>"
            "</LineString></Placemark></kml>",
            encoding="utf-8",
        )
        assert [meta["year"] for meta in parse_kml_file(str(kml_file))[2]] == [2026]

        assert obfuscate_kml_file(kml_file)
        assert "<name>EDDS 01 Jan 2026</name>" in kml_file.read_text(encoding="utf-8")
        assert [meta["year"] for meta in parse_kml_file(str(kml_file))[2]] == [2026]
        assert check_kml_obfuscated(kml_file) == []

    @pytest.mark.parametrize(
        ("name", "moved"),
        [
            ("EDDS - EDDF - 16 Mai 2026", "EDDS - EDDF - 01 Jan 2026"),
            ("EDDS 16 Dez 2026", "EDDS 01 Jan 2026"),
            ("EDDS 16 aug 2026", "EDDS 01 Jan 2026"),
            ("EDDS 31 Feb 2025", "EDDS 01 Jan 2025"),
            ("EDDS 2026-02-31", "EDDS 2026-01-01"),
        ],
    )
    def test_every_date_the_parser_reads_moves(self, tmp_path, name, moved):
        """German months too: deleting the date would lose the year."""
        assert obfuscate_kml_content(f"<kml><name>{name}</name></kml>") == (
            f"<kml><name>{moved}</name></kml>"
        )

    def test_a_word_that_is_no_month_keeps_its_date(self):
        assert obfuscate_kml_content("<kml><name>X - 16 Foo 2026</name></kml>") is None

    @pytest.mark.parametrize(
        ("description", "scrubbed"),
        [
            (
                "See https://example.org/a//b, Bob,, Carl -- a () b, 16 Aug",
                "See https://example.org/a//b, Bob,, Carl -- a () b",
            ),
            ("Out 16 Aug\nback home\n\nfuel 30", "Out\nback home\n\nfuel 30"),
            ("Trip (16 Aug) home, then 18:00 tea", "Trip home, then tea"),
            ("A - 16 Aug - B", "A - B"),
        ],
    )
    def test_only_what_is_next_to_a_date_changes(self, description, scrubbed):
        content = f"<kml><description>{description}</description></kml>"
        assert obfuscate_kml_content(content) == (
            f"<kml><description>{scrubbed}</description></kml>"
        )

    def test_cdata_stays_cdata(self):
        content = (
            '<kml><description><![CDATA[<a href="https://x.org/p">log</a> '
            "16 Aug]]></description></kml>"
        )
        assert obfuscate_kml_content(content) == (
            '<kml><description><![CDATA[<a href="https://x.org/p">log</a>]]>'
            "</description></kml>"
        )

    def test_a_list_of_dates(self, tmp_path):
        content = "<kml><name>EDDS 2026-08-16 2026-08-17</name></kml>"
        result = obfuscate_kml_content(content)
        assert result == "<kml><name>EDDS 2026-01-01 2026-01-01</name></kml>"
        assert obfuscate_kml_content(result) is None

    @given(
        st.lists(
            st.sampled_from(
                [
                    "EDDS",
                    "-",
                    "16 Aug",
                    "2026-08-16",
                    "16 Mai 2026",
                    "14:30",
                    "Sunday",
                    "KW33",
                    "(",
                    ")",
                    ",",
                    "Sat",
                    "16.08.",
                    "2026",
                    "Bob",
                    "16.VII.2026",
                    "Christmas",
                    "1755350000",
                    "Sa",
                    "Jul/Aug",
                    "08-2026",
                    "CW33",
                    "Summer",
                    "T10Z",
                    "250816",
                    "16082026",
                    "1430",
                ]
            ),
            max_size=8,
        )
    )
    # Found by Hypothesis: each pass of the rewrite took one weekday or year
    # less, and three passes were not enough
    @example(["Sat", "Sat", "Sat", "14:30", "2026-08-16"])
    @example(["16 Aug", "2026", "14:30", "2026", "2026", "2026"])
    def test_the_rewrite_is_idempotent(self, words):
        content = f"<kml><name>{' '.join(words)}</name></kml>"
        once = obfuscate_kml_content(content) or content
        assert obfuscate_kml_content(once) is None

    def test_a_charterware_description_keeps_its_date(self):
        description = (
            "<description>Flight Jan 12 2026 03:01PM path of OE-AKI, Sunday"
            "</description>"
        )
        assert obfuscate_kml_content(_kml(description)) == _kml(
            "<description>Flight Jan 01 2026 12:00AM path of OE-AKI</description>"
        )

    def test_an_obfuscated_name_stays_as_it_is(self):
        assert obfuscate_kml_content(_kml("<name>Log Start: 2026-01-01</name>")) is None
        assert obfuscate_kml_content(_kml("<name>EDDS 01 Jan 2026</name>")) is None


class TestPartsOfDatesInEveryElement:
    """The repository publishes all of a file, not only its names."""

    @pytest.mark.parametrize(
        ("body", "violation", "fixed"),
        [
            (
                "<Snippet>Flown 16 August</Snippet>",
                "Element Snippet contains part of a date: 16 August",
                "<Snippet>Flown</Snippet>",
            ),
            (
                '<Snippet maxLines="2">Sat 16 Aug</Snippet>',
                "Element Snippet contains part of a date: Sat 16 Aug",
                '<Snippet maxLines="2"></Snippet>',
            ),
            (
                "<address>Trip KW33</address>",
                "Element address contains part of a date: KW33",
                "<address>Trip</address>",
            ),
            (
                '<Data name="d"><value>On 16 Aug</value></Data>',
                "Element value contains part of a date: 16 Aug",
                '<Data name="d"><value>On</value></Data>',
            ),
            (
                '<SimpleData name="d">Flug 16.08.</SimpleData>',
                "Element SimpleData contains part of a date: 16.08.",
                '<SimpleData name="d">Flug</SimpleData>',
            ),
            (
                "<kml:value>log_250816</kml:value>",
                "Element kml:value contains part of a date: 250816",
                "<kml:value>log</kml:value>",
            ),
            # The weekdays and times of day there, which the check reports
            # anywhere, go with them
            (
                "<Snippet>Sunday 16 Aug</Snippet>",
                "Weekday gives the day of the flight away, remove it: Sunday",
                "<Snippet></Snippet>",
            ),
            (
                "<Snippet>Back 14:30</Snippet>",
                "Time of day gives the flight away, remove it: 14:30",
                "<Snippet>Back</Snippet>",
            ),
        ],
    )
    def test_the_rewrite_fixes_the_free_text(self, tmp_path, body, violation, fixed):
        kml_file = tmp_path / "flight.kml"
        kml_file.write_text(_kml(body), encoding="utf-8")
        assert violation in check_kml_obfuscated(kml_file)

        assert obfuscate_kml_content(_kml(body)) == _kml(fixed)
        kml_file.write_text(_kml(fixed), encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []

    @pytest.mark.parametrize(
        ("body", "violation"),
        [
            (
                "<sd:notes>16 Aug</sd:notes>",
                "Element sd:notes contains part of a date, remove it: 16 Aug",
            ),
            (
                "<styleUrl>notes_16Aug.kml#a</styleUrl>",
                "Element styleUrl contains part of a date, remove it: 16Aug",
            ),
            (
                "<Placemark>Flown 16 Aug<name>EDDS</name></Placemark>",
                "Text contains part of a date, remove it: 16 Aug",
            ),
            # The value of a point of a track is no free text: the rewrite
            # leaves it alone, but text in it is reported all the same
            (
                "<gx:SimpleArrayData><gx:value>On 16.8</gx:value></gx:SimpleArrayData>",
                "Element gx:value contains part of a date, remove it: 16.8",
            ),
        ],
    )
    def test_anywhere_else_it_goes_by_hand(self, tmp_path, body, violation):
        kml_file = tmp_path / "flight.kml"
        kml_file.write_text(_kml(body), encoding="utf-8")
        assert violation in check_kml_obfuscated(kml_file)
        assert obfuscate_kml_content(_kml(body)) is None

    @pytest.mark.parametrize(
        "body",
        [
            # A number alone outside a name or a description is a number:
            # the speed of a point, the heading of a view
            '<Data name="speed"><value>16.8</value></Data>',
            "<gx:SimpleArrayData><gx:value>16.8</gx:value></gx:SimpleArrayData>",
            "<gx:SimpleArrayData><gx:value>26.08</gx:value></gx:SimpleArrayData>",
            "<SimpleData name='n'>260816</SimpleData>",
            "<LookAt><heading>12.10</heading><tilt>16.08</tilt></LookAt>",
            "<LookAt><longitude>11.16082025</longitude></LookAt>",
            # The id after the "#" of a reference, which an attribute declares
            "<styleUrl>#style_16Aug</styleUrl>",
            # What a SkyDemon log holds
            "<Style id='a'/><styleUrl>#downArrowIcon</styleUrl>",
            "<altitudeMode>relativeToGround</altitudeMode><extrude>1</extrude>",
            "<color>7f00ffff</color><width>4</width>",
            "<href>http://maps.google.com/mapfiles/kml/pal4/icon28.png</href>",
            # January 1st
            "<Snippet>Flown 01 Jan</Snippet><address>KW1</address>",
        ],
    )
    def test_what_passes(self, tmp_path, body):
        kml_file = tmp_path / "flight.kml"
        kml_file.write_text(_kml(body), encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []
        assert obfuscate_kml_content(_kml(body)) is None

    def test_a_number_alone_in_a_name_is_still_scrubbed(self):
        assert obfuscate_kml_content(_kml("<name>16.8</name>")) == _kml("<name></name>")

    def test_the_text_of_a_balloon_style_is_scrubbed(self):
        body = "<text><![CDATA[<b>$[name]</b> 16 Aug]]></text>"
        assert obfuscate_kml_content(_kml(body)) == _kml(
            "<text><![CDATA[<b>$[name]</b>]]></text>"
        )

    @pytest.mark.parametrize(
        "make",
        [
            lambda size: "<a " * size,
            lambda size: "> " * size + "x",
            lambda size: "<a>" + " " * size + "x",
            lambda size: '<a b="' + "c" * size,
        ],
    )
    def test_the_scan_takes_linear_time(self, make):
        ratio = growth(obfuscate_module._partial_date_violations, make, 5_000)
        assert ratio < LINEAR_GROWTH


class TestCreators:
    def test_every_creator_is_checked_and_replaced(self, tmp_path):
        content = (
            '<kml creator="flown"><Document creator="SkyDemon Mobile">'
            "<when>2026-01-01T00:00:00Z</when></Document></kml>"
        )
        kml_file = tmp_path / "flight.kml"
        kml_file.write_text(content, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == [
            "Creator identifies the recording device: SkyDemon Mobile"
        ]

        result = obfuscate_kml_content(content)
        assert result is not None
        assert "SkyDemon" not in result
        kml_file.write_text(result, encoding="utf-8")
        assert check_kml_obfuscated(kml_file) == []


class TestFlightsOfSeveralDays:
    def test_legs_on_several_days_have_to_be_split(self, tmp_path):
        # Every leg starts less than twelve hours after the one before ends
        legs = "".join(
            f"<Placemark><gx:Track><when>{start}</when><when>{end}</when>"
            "</gx:Track></Placemark>"
            for start, end in (
                ("2026-08-16T08:00:00Z", "2026-08-16T20:00:00Z"),
                ("2026-08-17T06:00:00Z", "2026-08-17T18:00:00Z"),
                ("2026-08-18T04:00:00Z", "2026-08-18T16:00:00Z"),
                ("2026-08-19T02:00:00Z", "2026-08-19T10:00:00Z"),
            )
        )
        content = f'<kml xmlns:gx="http://www.google.com/kml/ext/2.2">{legs}</kml>'
        kml_file = tmp_path / "trip.kml"
        kml_file.write_text(obfuscate_kml_content(content) or content, encoding="utf-8")
        violations = check_kml_obfuscated(kml_file)
        assert (
            "Flight runs over 4 days, more than the 3 from Jan 1 the check lets "
            "pass: split the file into one per day of flying"
        ) in violations


class TestRenameDatedFiles:
    def test_a_date_leaves_the_name(self, tmp_path):
        dated = tmp_path / "1_DEHYL_DA40_16Aug.kml"
        dated.write_text(_kml(""), encoding="utf-8")
        assert check_kml_obfuscated(dated) == [
            "File name contains part of a date: 16Aug"
        ]

        assert rename_dated_files([dated]) == [tmp_path / "1_DEHYL_DA40.kml"]
        assert not dated.exists()
        assert check_kml_obfuscated(tmp_path / "1_DEHYL_DA40.kml") == []

    @pytest.mark.parametrize(
        ("name", "renamed"),
        [
            ("Flight 2026-08-16 1430Z.kml", "Flight.kml"),
            ("EDDS_Sunday_16.08.kml", "EDDS.kml"),
            ("trip-KW33.KML", "trip.KML"),
        ],
    )
    def test_names(self, tmp_path, name, renamed):
        path = tmp_path / name
        path.write_text(_kml(""), encoding="utf-8")
        assert rename_dated_files([path]) == [tmp_path / renamed]

    def test_a_name_without_a_date_stays(self, tmp_path):
        path = tmp_path / "1_DEHYL_DA40.kml"
        path.write_text(_kml(""), encoding="utf-8")
        assert rename_dated_files([path]) == [path]

    def test_no_file_is_replaced(self, tmp_path, caplog):
        taken = tmp_path / "1_DEHYL_DA40.kml"
        taken.write_text("mine", encoding="utf-8")
        dated = tmp_path / "1_DEHYL_DA40_16Aug.kml"
        dated.write_text(_kml(""), encoding="utf-8")

        assert rename_dated_files([dated]) == [dated]
        assert taken.read_text(encoding="utf-8") == "mine"
        assert "Cannot rename" in caplog.text

    def test_a_name_that_is_only_a_date_stays(self, tmp_path, caplog):
        path = tmp_path / "16Aug.kml"
        path.write_text(_kml(""), encoding="utf-8")
        assert rename_dated_files([path]) == [path]
        assert "nothing is left" in caplog.text

    def test_charterware_names_move_to_jan_first(self, tmp_path):
        path = tmp_path / CHARTERWARE_NAME
        path.write_text(_kml(""), encoding="utf-8")
        assert rename_dated_files([path]) == [
            tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        ]

    @pytest.mark.parametrize(
        ("name", "renamed"),
        [
            ("1_DEHYL_DA40_16_08.kml", "1_DEHYL_DA40.kml"),
            ("1_D-EHYL_DA40-16-08-2026.kml", "1_D-EHYL_DA40.kml"),
        ],
    )
    def test_a_type_with_digits_stays(self, tmp_path, name, renamed):
        path = tmp_path / name
        path.write_text(_kml(""), encoding="utf-8")
        assert rename_dated_files([path]) == [tmp_path / renamed]

    def test_no_rename_changes_the_aircraft(self, tmp_path, caplog):
        # Without its date the third part would be a type of its own
        path = tmp_path / "1_DEHYL_16Aug_DA40.kml"
        path.write_text(_kml(""), encoding="utf-8")
        assert rename_dated_files([path]) == [path]
        assert "the aircraft it names would change" in caplog.text

    def test_the_rest_of_a_charterware_name_loses_its_dates(self, tmp_path):
        path = tmp_path / "2026-01-12_1513h_OE-AKI_LOAV-LOAV_Sunday.kml"
        path.write_text(_kml(""), encoding="utf-8")
        renamed = tmp_path / "2026-01-01_0000h_OE-AKI_LOAV-LOAV.kml"
        assert rename_dated_files([path]) == [renamed]
        assert check_kml_obfuscated(renamed) == []

    def test_make_obfuscate_fixes_the_name(self, tmp_path):
        (tmp_path / "3_DEAGJ_DA20_Sat_16.08.kml").write_text(_kml(""), encoding="utf-8")
        with patch("sys.argv", ["obfuscate", str(tmp_path)]):
            main()
        assert [path.name for path in tmp_path.iterdir()] == ["3_DEAGJ_DA20.kml"]
        assert check_directory_obfuscated(tmp_path) == {}


class TestRenamedNamesAreClean:
    """The renamer leaves nothing the check would report, however it nests."""

    @pytest.mark.parametrize(
        ("name", "renamed"),
        [
            ("EDDS Sat 14:30 16 Aug 2026.kml", "EDDS.kml"),
            ("LOWW_Fri_0930Z_2026-08-14.kml", "LOWW.kml"),
            ("Sa 14.30 Uhr 16.08.2026 EDDS.kml", "EDDS.kml"),
            ("EDDS Sat Sat 2026-08-16.kml", "EDDS.kml"),
            ("EDDS Heiligabend.kml", "EDDS.kml"),
            ("EDDS 16.VII.2026.kml", "EDDS.kml"),
            ("Aunt farm 2026-08-16 14-30.kml", "Aunt farm.kml"),
            ("Aunt farm 2026-08-16_14-30.kml", "Aunt farm.kml"),
            ("Aunt farm 2026-08-16 14-30h.kml", "Aunt farm.kml"),
            ("Aunt farm 2026-08-16 14-30 h.kml", "Aunt farm.kml"),
            ("Aunt farm 2026-08-16_14-30h.kml", "Aunt farm.kml"),
            ("Aunt farm 2026-08-16 14-30 hrs.kml", "Aunt farm.kml"),
            ("Aunt farm 16.08.2026 14.30-15.45 Uhr.kml", "Aunt farm.kml"),
            ("Aunt farm 16.-18.08.2026.kml", "Aunt farm.kml"),
        ],
    )
    def test_names(self, tmp_path, name, renamed):
        path = tmp_path / name
        path.write_text(_kml(""), encoding="utf-8")
        assert rename_dated_files([path]) == [tmp_path / renamed]
        assert check_kml_obfuscated(tmp_path / renamed) == []

    @given(
        st.lists(
            st.sampled_from(
                [
                    "EDDS",
                    "Bob",
                    "Sat",
                    "Fri",
                    "Sa",
                    "14:30",
                    "0930Z",
                    "14.30 Uhr",
                    "16 Aug 2026",
                    "2026-08-16",
                    "16.08.2026",
                    "16.VII.2026",
                    "16Aug",
                    "Sunday",
                    "Christmas",
                    "1755350000",
                    "250816",
                    "16082026",
                    "16-08",
                ]
            ),
            min_size=1,
            max_size=7,
        ),
        st.sampled_from([" ", "_", "-"]),
    )
    def test_a_rename_is_final(self, words, separator):
        stem = separator.join(words)
        undated = obfuscate_module._undated_stem(stem)
        if undated is None:
            # Nothing to take out: the check finds nothing either
            undated = stem
        elif undated:
            assert obfuscate_module._undated_stem(undated) is None
        for found in (
            find_date_tokens(undated, skip_near_jan_first=True),
            find_partial_date_tokens(undated),
            find_time_tokens(undated),
            find_weekday_tokens(undated),
            find_holiday_tokens(undated),
        ):
            assert found == [], (stem, undated)


class TestCheckSkipsCanonicalTimestamps:
    """The catch-all scan skips the timestamps the rewrite writes (speed)."""

    @pytest.mark.parametrize(
        "when",
        [
            "<when>2026-01-01T00:00:00Z</when>",
            "<gx:when>2026-01-03T23:59:59.8171100Z</gx:when>",
            "\n        <begin>2026-01-02T12:00:00Z</begin>",
        ],
    )
    def test_skipped(self, when):
        assert obfuscate_module.CANONICAL_TIMESTAMP_PATTERN.fullmatch(when)

    @pytest.mark.parametrize(
        "when",
        [
            # A day the catch-all fails, a zone, a comment, another tag
            "<when>2026-01-04T00:00:00Z</when>",
            "<when>2026-01-01T00:00:00+02:00</when>",
            "<when>2026-01-01T00:00<!-- -->:00Z</when>",
            "<when>2026-01-01T00:00:00Z</begin>",
        ],
    )
    def test_scanned(self, when):
        assert not obfuscate_module.CANONICAL_TIMESTAMP_PATTERN.fullmatch(when)

    @pytest.mark.parametrize(
        "pattern",
        [
            obfuscate_module.COORDINATES_PATTERN,
            obfuscate_module.CANONICAL_TIMESTAMP_PATTERN,
        ],
    )
    def test_a_long_blank_run_takes_no_quadratic_time(self, pattern):
        """The indent is matched from the start of its run, once."""
        # 80 K took a millisecond; scanned again from each blank, 11.7 s
        ratio = growth(
            lambda text: pattern.sub("", text),
            lambda size: " " * size + "x",
            10_000,
        )
        assert ratio < LINEAR_GROWTH

    def test_the_indent_still_goes_with_the_tag(self):
        text = (
            "<a>\n    <coordinates>1,2</coordinates>"
            "\n  <when>2026-01-01T00:00:00Z</when></a>"
        )
        stripped = obfuscate_module.CANONICAL_TIMESTAMP_PATTERN.sub(
            "", obfuscate_module.COORDINATES_PATTERN.sub("", text)
        )
        assert stripped == "<a></a>"


class TestCheckSeesThroughMarkup:
    def test_a_date_split_by_cdata(self, tmp_path):
        path = tmp_path / "1_DEHYL_DA40.kml"
        path.write_text(
            _kml("<description>Flight 16.<![CDATA[08]]>.2026</description>"),
            encoding="utf-8",
        )
        assert "Date not on Jan 1: 16.08.2026" in check_kml_obfuscated(path)

    def test_cdata_around_a_whole_text_is_scanned_once(self):
        content = "<description><![CDATA[EDDS 2026-01-01]]></description>"
        assert obfuscate_module._with_markup_dropped(content) == content

    def test_a_holiday(self, tmp_path):
        path = tmp_path / "1_DEHYL_DA40.kml"
        path.write_text(_kml("<name>Heiligabend bei Oma</name>"), encoding="utf-8")
        assert check_kml_obfuscated(path) == [
            "Holiday gives the day of the flight away, remove it: Heiligabend"
        ]
        assert obfuscate_kml_content(path.read_text(encoding="utf-8")) == _kml(
            "<name>bei Oma</name>"
        )

    @pytest.mark.parametrize(
        ("name", "kept"),
        [
            ("Home strip Columbus Day", "Home strip"),
            ("Aunt farm CW33", "Aunt farm"),
            ("Aunt farm 08-2026", "Aunt farm"),
            ("Lake strip Jul/Aug 2026", "Lake strip"),
            ("Lake strip Sommer 2026", "Lake strip"),
            ("Lake strip Q3 2026", "Lake strip"),
            ("Lake strip 2026-01-01T10Z", "Lake strip 2026-01-01"),
        ],
    )
    def test_the_shapes_of_2026_10_fail_and_go(self, tmp_path, name, kept):
        """They passed the check and were published until 2026-10."""
        path = tmp_path / "1_DEHYL_DA40.kml"
        path.write_text(_kml(f"<name>{name}</name>"), encoding="utf-8")
        assert check_kml_obfuscated(path)
        rewritten = obfuscate_kml_content(path.read_text(encoding="utf-8"))
        assert rewritten == _kml(f"<name>{kept}</name>")
        path.write_text(rewritten, encoding="utf-8")
        assert check_kml_obfuscated(path) == []

    def test_a_holiday_in_the_file_name(self, tmp_path):
        path = tmp_path / "1_DEHYL_DA40_Christmas.kml"
        path.write_text(_kml(""), encoding="utf-8")
        assert check_kml_obfuscated(path) == ["File name contains a holiday: Christmas"]

    def test_a_place_named_after_a_holiday(self, tmp_path):
        path = tmp_path / "1_DEHYL_DA40.kml"
        path.write_text(_kml("<name>YPXM Christmas Island</name>"), encoding="utf-8")
        assert check_kml_obfuscated(path) == []

    def test_a_roman_month(self, tmp_path):
        path = tmp_path / "1_DEHYL_DA40.kml"
        path.write_text(
            _kml("<name>Aunt farm 16.VII.2026 - Home strip</name>"), encoding="utf-8"
        )
        assert check_kml_obfuscated(path) == ["Date not on Jan 1: 16.VII.2026"]

    @pytest.mark.parametrize(
        "text",
        [
            "Section 2. IV of the AIP",
            "Leg 3. II done",
            "Trip 2026. V speeds checked",
            "SkyDemon v.2024 export",
            "Flown in 2026. I liked it",
        ],
    )
    def test_text_that_only_looks_like_a_roman_month(self, tmp_path, text):
        content = _kml(f"<description>{text}</description>")
        path = tmp_path / "1_DEHYL_DA40.kml"
        path.write_text(content, encoding="utf-8")
        assert check_kml_obfuscated(path) == []
        assert obfuscate_kml_content(content) is None


@pytest.mark.skipif(os.geteuid() == 0, reason="root lists any directory")
class TestUnlistedDirectories:
    def test_a_directory_that_cannot_be_listed_fails_the_check(self, tmp_path):
        (tmp_path / "1_DEHYL_DA40.kml").write_text(_kml(""), encoding="utf-8")
        locked = tmp_path / "locked"
        locked.mkdir()
        (locked / "2_DEHYL_DA40.kml").write_text(_kml(""), encoding="utf-8")
        locked.chmod(0)
        try:
            assert check_directory_obfuscated(tmp_path) == {
                "locked/": [
                    (
                        "Cannot list the directory, so its files are not "
                        "checked: fix its permissions"
                    )
                ]
            }
        finally:
            locked.chmod(0o755)

    def test_the_check_of_an_unlistable_directory_fails(self, tmp_path, capsys):
        locked = tmp_path / "locked"
        locked.mkdir()
        locked.chmod(0)
        try:
            with (
                patch("sys.argv", ["obfuscate", str(locked), "--check"]),
                pytest.raises(SystemExit) as exit_info,
            ):
                main()
        finally:
            locked.chmod(0o755)
        assert exit_info.value.code == 1
        assert "Cannot list the directory" in capsys.readouterr().out
