"""Tests for helpers module."""

from datetime import UTC, datetime

import pytest

from flown.helpers import (
    calculate_duration_seconds,
    normalize_timestamp_text,
    numeric_filename_key,
    parse_iso_timestamp,
    parse_timestamp_epoch,
)


class TestParseIsoTimestamp:
    def test_valid_zulu_time(self):
        result = parse_iso_timestamp("2025-03-15T14:30:00Z")
        assert result == datetime(2025, 3, 15, 14, 30, tzinfo=UTC)

    def test_valid_timezone_offset(self):
        result = parse_iso_timestamp("2025-03-15T14:30:00+01:00")
        assert result is not None
        offset = result.utcoffset()
        assert offset is not None
        assert offset.total_seconds() == 3600

    def test_seven_digit_fraction(self):
        result = parse_iso_timestamp("2025-03-03T08:25:15.5848380Z")
        assert result is not None
        assert result.microsecond == 584838

    @pytest.mark.parametrize(
        "value",
        [
            "not a timestamp",
            "2025-03-15",
            "",
            "15/03/2025",
            None,
            "2025-13-45T25:99:99Z",
        ],
    )
    def test_invalid_returns_none(self, value):
        assert parse_iso_timestamp(value) is None

    @pytest.mark.parametrize(
        "value",
        [
            "2025-03-03 08:58:01Z",
            "2025-03-03T08:58:01z",
            "2025-03-03 08:58:01z",
            " 2025-03-03T08:58:01Z ",
            "2025-03-03t08:58:01z",
        ],
    )
    def test_loose_forms_the_obfuscator_accepts(self, value):
        assert parse_iso_timestamp(value) == datetime(2025, 3, 3, 8, 58, 1, tzinfo=UTC)


class TestNormalizeTimestampText:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("2025-03-03 08:58:01Z", "2025-03-03T08:58:01Z"),
            ("2025-03-03T08:58:01z", "2025-03-03T08:58:01Z"),
            ("2025-03-03t08:58:01z", "2025-03-03T08:58:01Z"),
            ("2025-03-03T08:58:01Z", "2025-03-03T08:58:01Z"),
            ("2025-03-03", "2025-03-03"),
            ("Log Start: 03 Mar 2025", "Log Start: 03 Mar 2025"),
        ],
    )
    def test_canonical_form(self, value, expected):
        assert normalize_timestamp_text(value) == expected


class TestParseTimestampEpoch:
    def test_zulu(self):
        assert parse_timestamp_epoch("1970-01-01T00:01:00Z") == 60.0

    def test_offset_is_applied(self):
        assert parse_timestamp_epoch("1970-01-01T01:00:00+01:00") == 0.0

    def test_naive_is_treated_as_utc(self):
        assert parse_timestamp_epoch("1970-01-01T00:00:10") == 10.0

    @pytest.mark.parametrize("value", ["invalid", "", None])
    def test_invalid_returns_none(self, value):
        assert parse_timestamp_epoch(value) is None


class TestCalculateDurationSeconds:
    def test_valid_duration(self):
        assert (
            calculate_duration_seconds("2025-03-15T14:00:00Z", "2025-03-15T16:30:00Z")
            == 9000
        )

    def test_same_timestamp(self):
        assert (
            calculate_duration_seconds("2025-03-15T14:00:00Z", "2025-03-15T14:00:00Z")
            == 0
        )

    def test_negative_duration(self):
        assert (
            calculate_duration_seconds("2025-03-15T16:00:00Z", "2025-03-15T14:00:00Z")
            == -7200
        )

    def test_naive_and_aware_mixed(self):
        assert (
            calculate_duration_seconds("2025-03-15T14:00:00", "2025-03-15T15:00:00Z")
            == 3600
        )

    @pytest.mark.parametrize(
        "start,end",
        [
            ("invalid", "2025-03-15T14:00:00Z"),
            ("2025-03-15T14:00:00Z", "invalid"),
            ("invalid", "also invalid"),
            (None, None),
            ("2025-03-15T14:00:00Z", None),
            (None, "2025-03-15T14:00:00Z"),
        ],
    )
    def test_invalid_inputs_give_zero(self, start, end):
        assert calculate_duration_seconds(start, end) == 0

    def test_one_day_duration(self):
        assert (
            calculate_duration_seconds("2025-03-15T00:00:00Z", "2025-03-16T00:00:00Z")
            == 86400
        )


class TestNumericFilenameKey:
    def test_numeric_prefix_sorts_numerically(self):
        names = ["10_a.kml", "2_a.kml", "1_a.kml"]
        assert sorted(names, key=numeric_filename_key) == [
            "1_a.kml",
            "2_a.kml",
            "10_a.kml",
        ]

    def test_non_numeric_names_sort_after_numeric(self):
        names = ["b.kml", "3_a.kml", "a.kml"]
        assert sorted(names, key=numeric_filename_key) == ["3_a.kml", "a.kml", "b.kml"]

    def test_uses_basename(self):
        assert numeric_filename_key("/some/dir/7_x.kml") == (0, 7, "7_x.kml")
