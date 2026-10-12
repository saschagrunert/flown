"""Tests for parser_common module."""

from datetime import UTC, datetime
from typing import ClassVar

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from lxml import etree

from flown.aircraft import parse_aircraft_from_filename
from flown.constants import (
    ALT_MAX_M,
    ALT_MIN_M,
    LAT_MAX,
    LAT_MIN,
    LON_MAX,
    LON_MIN,
)
from flown.parser_common import (
    build_path_metadata_dict,
    empty_placemark_metadata,
    extract_charterware_timestamp,
    extract_placemark_metadata,
    extract_year_from_timestamp,
    find_xml_element,
    find_xml_elements,
    parse_coordinate_point,
    validate_and_normalize_coordinate,
)
from flown.types import PlacemarkMetadata, TrackPoint

NS = {"kml": "http://www.opengis.net/kml/2.2"}


def _find(root: etree._Element, path: str) -> etree._Element:
    found = root.find(path)
    assert found is not None
    return found


class TestExtractYearFromTimestamp:
    @pytest.mark.parametrize(
        "value,expected",
        [
            ("2025-03-03T08:58:01Z", 2025),
            ("2026-01-15T10:30:00+02:00", 2026),
            ("2025-03-03", 2025),
            ("03 Mar 2025", 2025),
            ("Log Start: 03 Mar 2024 08:58 Z", 2024),
            ("2099-12-31T23:59:59Z", 2099),
            ("2000-01-01T00:00:00Z", 2000),
            ("not-a-date", None),
            ("03 Mar", None),
            # No ISO timestamp, but the year is there
            ("2025-99-99T99:99:99Z", 2025),
            ("Takeoff: 03 Mar 2025 08:58 Z", 2025),
            ("Takeoff T", None),
            ("", None),
            (None, None),
            # Dates without a time of day, of any plausible year
            ("1998-05-01", 1998),
            ("1998-05", 1998),
            ("1998", 1998),
            ("2026", 2026),
            ("1998-05-01Z", 1998),
            ("1998-05-01+02:00", 1998),
            ("0998-05-01", None),
            ("2150-05-01", None),
            ("03 Mar 1998", 1998),
        ],
    )
    def test_extract(self, value, expected):
        assert extract_year_from_timestamp(value) == expected

    def test_year_of_an_offset_timestamp_is_the_utc_year(self):
        """The obfuscator anchors on the UTC date; both must agree on the year."""
        assert extract_year_from_timestamp("2025-01-01T00:30:00+02:00") == 2024
        assert extract_year_from_timestamp("2024-12-31T23:30:00-02:00") == 2025
        assert extract_year_from_timestamp("2025-01-01T00:30:00") == 2025

    def test_no_utc_year_is_no_year(self):
        """Year 1 east of UTC and 9999 west of it are out of datetime's range."""
        assert extract_year_from_timestamp("0001-01-01T00:00:00+05:00") is None
        assert extract_year_from_timestamp("9999-12-31T23:59:59-14:00") is None


class TestValidateAndNormalizeCoordinate:
    def test_valid_coordinate(self):
        assert validate_and_normalize_coordinate(50.0, 8.5, 300, "test.kml") == (
            50.0,
            8.5,
            300.0,
        )

    def test_negative_altitude_is_kept(self):
        result = validate_and_normalize_coordinate(50.0, 8.5, -100, "test.kml")
        assert result == (50.0, 8.5, -100)

    def test_altitude_range_boundaries_kept(self):
        for altitude in (ALT_MIN_M, ALT_MAX_M):
            result = validate_and_normalize_coordinate(50.0, 8.5, altitude, "f")
            assert result == (50.0, 8.5, altitude)

    @pytest.mark.parametrize(
        "alt", [999999, -99999, float("nan"), float("inf"), float("-inf")]
    )
    def test_out_of_range_or_non_finite_altitude_becomes_none(self, alt):
        result = validate_and_normalize_coordinate(50.0, 8.5, alt, "test.kml")
        assert result == (50.0, 8.5, None)

    def test_none_altitude_preserved(self):
        assert validate_and_normalize_coordinate(50.0, 8.5, None, "test.kml") == (
            50.0,
            8.5,
            None,
        )

    @pytest.mark.parametrize(
        "lat,lon",
        [(-90.0, 0.0), (90.0, 0.0), (0.0, -180.0), (0.0, 180.0)],
        ids=["min-lat", "max-lat", "min-lon", "max-lon"],
    )
    def test_valid_range_boundaries(self, lat, lon):
        assert validate_and_normalize_coordinate(lat, lon, 0, "test.kml") is not None

    @pytest.mark.parametrize(
        "lat,lon",
        [
            (100.0, 8.5),
            (-100.0, 8.5),
            (50.0, 200.0),
            (50.0, -200.0),
            (float("nan"), 8.5),
            (50.0, float("inf")),
        ],
    )
    def test_invalid_lat_lon_returns_none(self, lat, lon):
        assert validate_and_normalize_coordinate(lat, lon, 300, "test.kml") is None


class TestParseCoordinatePoint:
    def test_three_components(self):
        assert parse_coordinate_point("8.5,50.0,100.0", "test.kml") == (
            50.0,
            8.5,
            100.0,
        )

    def test_two_components(self):
        assert parse_coordinate_point("8.5,50.0", "test.kml") == (50.0, 8.5, None)

    def test_negative_altitude_kept(self):
        assert parse_coordinate_point("8.5,50.0,-100", "test.kml") == (
            50.0,
            8.5,
            -100.0,
        )

    def test_out_of_range_latitude(self):
        assert parse_coordinate_point("8.5,9999.0,300", "test.kml") is None

    def test_whitespace_stripping(self):
        assert parse_coordinate_point("  8.5,50.0,100.0  ", "test.kml") == (
            50.0,
            8.5,
            100.0,
        )

    @pytest.mark.parametrize(
        "value", ["", "   ", "8.5", "abc,def", "abc,def,ghi", "invalid"]
    )
    def test_invalid_values(self, value):
        assert parse_coordinate_point(value, "test.kml") is None

    @settings(max_examples=300)
    @given(
        st.one_of(
            st.text(),
            # Mostly well-formed, with any number: NaN, infinities, far out
            st.builds(
                lambda lon, lat, alt: f"{lon},{lat},{alt}",
                st.floats(),
                st.floats(),
                st.floats(),
            ),
        )
    )
    def test_never_raises(self, text):
        result = parse_coordinate_point(text, "test.kml")
        if result is None:
            return
        lat, lon, alt = result
        # Whatever the input, only a valid position comes out
        assert LAT_MIN <= lat <= LAT_MAX
        assert LON_MIN <= lon <= LON_MAX
        assert (lat, lon) != (0.0, 0.0)
        assert alt is None or ALT_MIN_M <= alt <= ALT_MAX_M


class TestFindXmlElement:
    NS: ClassVar[dict[str, str]] = NS

    def test_namespaced_found(self):
        root = etree.fromstring(
            '<root xmlns:kml="http://www.opengis.net/kml/2.2"><kml:name>T</kml:name></root>'
        )
        found = find_xml_element(root, "kml:name", "name", self.NS)
        assert found is not None
        assert found.text == "T"

    def test_fallback_found(self):
        root = etree.fromstring("<root><name>T</name></root>")
        found = find_xml_element(root, "kml:name", "name", self.NS)
        assert found is not None
        assert found.text == "T"

    def test_neither_found(self):
        root = etree.fromstring("<root><other>T</other></root>")
        assert find_xml_element(root, "kml:name", "name", self.NS) is None


class TestFindXmlElements:
    NS: ClassVar[dict[str, str]] = NS

    def test_namespaced_elements(self):
        root = etree.fromstring(
            '<root xmlns:kml="http://www.opengis.net/kml/2.2">'
            "<kml:when>1</kml:when><kml:when>2</kml:when></root>"
        )
        assert [
            e.text for e in find_xml_elements(root, "kml:when", "when", self.NS)
        ] == ["1", "2"]

    def test_fallback_elements(self):
        root = etree.fromstring(
            "<root><when>t1</when><when>t2</when><when>t3</when></root>"
        )
        assert len(find_xml_elements(root, "kml:when", "when", self.NS)) == 3

    def test_empty_result(self):
        root = etree.fromstring("<root><other>T</other></root>")
        assert find_xml_elements(root, "kml:when", "when", self.NS) == []


class TestExtractCharterwareTimestamp:
    @pytest.mark.parametrize(
        "desc,expected",
        [
            ("Flight Jan 12 2026 03:01PM path of OE-AKI", "2026-01-12T15:01:00+00:00"),
            ("Flight Mar 05 2026 08:30AM path of OE-AKI", "2026-03-05T08:30:00+00:00"),
            ("Flight Mar 3 2025 08:15AM path of D-EAGJ", "2025-03-03T08:15:00+00:00"),
            ("Flight Jun 01 2026 12:00PM path of OE-AKI", "2026-06-01T12:00:00+00:00"),
            ("Flight Jun 01 2026 12:00AM path of OE-AKI", "2026-06-01T00:00:00+00:00"),
            ("Flight Jan 1 2026 11:59PM path of OE-AKI", "2026-01-01T23:59:00+00:00"),
            (
                "Flight January 15 2026 02:00PM path of D-EAGJ",
                "2026-01-15T14:00:00+00:00",
            ),
            # The hour with one digit, and the four-letter September, as
            # the obfuscator reads them too
            ("Flight Jan 12 2026 3:01PM path of OE-AKI", "2026-01-12T15:01:00+00:00"),
            ("Flight Sept 12 2026 03:01PM path of OE-AKI", "2026-09-12T15:01:00+00:00"),
        ],
    )
    def test_parsing(self, desc, expected):
        assert extract_charterware_timestamp(desc) == expected

    @pytest.mark.parametrize(
        "desc",
        [
            None,
            "",
            "not a charterware description",
            "Flight without timestamp",
            "Flight Feb 31 2025 12:00AM path of OE-AKI",
            "Flight Foo 12 2026 03:01PM",
        ],
    )
    def test_invalid(self, desc):
        assert extract_charterware_timestamp(desc) is None

    @settings(max_examples=100)
    @given(
        # A local date and time of a description, which has no time zone
        st.datetimes(
            min_value=datetime(2000, 1, 1),  # noqa: DTZ001
            max_value=datetime(2099, 12, 31),  # noqa: DTZ001
        ),
        st.booleans(),
    )
    def test_round_trip(self, dt, long_month):
        month = dt.strftime("%B" if long_month else "%b")
        hour12 = dt.hour % 12 or 12
        meridiem = "AM" if dt.hour < 12 else "PM"
        desc = (
            f"Flight {month} {dt.day} {dt.year} "
            f"{hour12:02d}:{dt.minute:02d}{meridiem} path"
        )
        expected = dt.replace(second=0, microsecond=0, tzinfo=UTC).isoformat()
        assert extract_charterware_timestamp(desc) == expected


class TestExtractPlacemarkMetadata:
    def test_name_and_timestamps(self):
        placemark = etree.fromstring(
            '<Placemark xmlns:kml="http://www.opengis.net/kml/2.2">'
            "<kml:name>EDDS</kml:name>"
            "<kml:when>2025-03-03T08:58:01Z</kml:when>"
            "<kml:when>2025-03-03T10:30:00Z</kml:when></Placemark>"
        )
        assert extract_placemark_metadata(placemark, NS) == {
            "airport_name": "EDDS Stuttgart",
            "start_airport": None,
            "end_airport": None,
            "timestamp": "2025-03-03T08:58:01Z",
            "end_timestamp": "2025-03-03T10:30:00Z",
            "year": 2025,
        }

    def test_timestamp_element(self):
        placemark = etree.fromstring(
            "<Placemark><name>Test Airport</name>"
            "<TimeStamp><when>2025-06-15T12:00:00Z</when></TimeStamp></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["airport_name"] == "Test Airport"
        assert result["timestamp"] == "2025-06-15T12:00:00Z"
        assert result["end_timestamp"] is None
        assert result["year"] == 2025

    def test_date_in_name_fallback(self):
        placemark = etree.fromstring(
            "<Placemark><name>EDDS to EDDP - 16 Aug 2026</name></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["timestamp"] == "16 Aug 2026"
        assert result["year"] == 2026

    def test_a_date_in_the_name_with_a_day_of_one_digit(self):
        placemark = etree.fromstring(
            "<Placemark><name>EDDS to EDDP - 6 Aug 2026</name></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["timestamp"] == "6 Aug 2026"
        assert result["year"] == 2026
        assert result["start_airport"] == "EDDS Stuttgart"
        assert result["end_airport"] == "EDDP Leipzig/Halle"

    def test_route_airports_are_kept_apart(self):
        """LFBN is "Niort - Marais Poitevin"; the display name cannot be split."""
        placemark = etree.fromstring(
            "<Placemark><name>EDAQ Halle-Oppin - LFBN Niort</name></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["airport_name"] == (
            "EDAQ Halle-Oppin - LFBN Niort - Marais Poitevin"
        )
        assert result["start_airport"] == "EDAQ Halle-Oppin"
        assert result["end_airport"] == "LFBN Niort - Marais Poitevin"

    def test_route_date_is_not_an_airport(self):
        placemark = etree.fromstring(
            "<Placemark><name>EDDS to EDZZ - 16 Aug 2026</name></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["airport_name"] == "EDDS Stuttgart - EDZZ"
        assert result["start_airport"] == "EDDS Stuttgart"
        assert result["end_airport"] == "EDZZ"

    def test_log_start_name(self):
        placemark = etree.fromstring(
            "<Placemark><name>Log Start: 03 Mar 2025 08:58 Z</name></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["airport_name"] == "Log Start: 03 Mar 2025 08:58 Z"
        assert result["timestamp"] == "03 Mar 2025"
        assert result["year"] == 2025

    def test_charterware_description_fallback(self):
        placemark = etree.fromstring(
            "<Placemark><name>Route</name>"
            "<description>Flight Jan 12 2026 03:01PM path of OE-AKI</description>"
            "</Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["timestamp"] == "2026-01-12T15:01:00+00:00"
        assert result["year"] == 2026

    def test_timespan_without_when(self):
        """A LineString placemark dated only by a TimeSpan keeps its year."""
        placemark = etree.fromstring(
            '<Placemark xmlns:kml="http://www.opengis.net/kml/2.2">'
            "<kml:name>EDDS</kml:name><kml:TimeSpan>"
            "<kml:begin>2025-06-15T12:00:00Z</kml:begin>"
            "<kml:end>2025-06-15T13:30:00Z</kml:end>"
            "</kml:TimeSpan></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["timestamp"] == "2025-06-15T12:00:00Z"
        assert result["end_timestamp"] == "2025-06-15T13:30:00Z"
        assert result["year"] == 2025

    def test_timespan_without_namespace_and_without_end(self):
        placemark = etree.fromstring(
            "<Placemark><TimeSpan><begin>2024-02-01T08:00:00Z</begin></TimeSpan>"
            "</Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["timestamp"] == "2024-02-01T08:00:00Z"
        assert result["end_timestamp"] is None
        assert result["year"] == 2024

    def test_when_wins_over_timespan(self):
        placemark = etree.fromstring(
            "<Placemark><TimeSpan><begin>2024-02-01T08:00:00Z</begin></TimeSpan>"
            "<TimeStamp><when>2025-06-15T12:00:00Z</when></TimeStamp></Placemark>"
        )
        assert extract_placemark_metadata(placemark, NS)["year"] == 2025

    def test_no_metadata(self):
        assert (
            extract_placemark_metadata(etree.fromstring("<Placemark/>"), NS)
            == empty_placemark_metadata()
        )


class TestBuildPathMetadataDict:
    def _meta(self, **overrides: str | int | None) -> PlacemarkMetadata:
        meta = empty_placemark_metadata()
        # The keywords are keys of PlacemarkMetadata, which mypy cannot know
        meta.update(overrides)  # type: ignore[typeddict-item]
        return meta

    @staticmethod
    def _build(kml_file, point, meta):
        aircraft_info = parse_aircraft_from_filename(kml_file.rsplit("/", 1)[-1])
        return build_path_metadata_dict(kml_file, point, meta, aircraft_info)

    def test_basic_metadata(self):
        result = self._build(
            "test.kml",
            TrackPoint(50.0, 8.5, 100.0, 12.0),
            self._meta(
                airport_name="EDDS",
                timestamp="2025-03-03T08:58:01Z",
                end_timestamp="2025-03-03T10:30:00Z",
                year=2025,
            ),
        )
        assert result == {
            "start_point": [50.0, 8.5, 100.0],
            "airport_name": "EDDS",
            "start_airport": None,
            "end_airport": None,
            "timestamp": "2025-03-03T08:58:01Z",
            "end_timestamp": "2025-03-03T10:30:00Z",
            "filename": "test.kml",
            "year": 2025,
        }

    def test_year_comes_from_placemark_metadata(self):
        result = self._build(
            "test.kml",
            TrackPoint(50.0, 8.5, 100.0),
            self._meta(timestamp="x", year=2031),
        )
        assert result["year"] == 2031

    def test_no_aircraft_info(self):
        result = self._build("test.kml", TrackPoint(50.0, 8.5, 100.0), self._meta())
        assert result["year"] is None
        assert result["airport_name"] == ""
        assert "aircraft_registration" not in result

    def test_start_point_without_altitude(self):
        result = self._build("test.kml", TrackPoint(50.0, 8.5, None), self._meta())
        assert result["start_point"] == [50.0, 8.5]

    def test_with_aircraft_in_filename(self):
        result = self._build(
            "some/dir/1_DEAGJ_DA20.kml",
            TrackPoint(50.0, 8.5, 100.0),
            self._meta(airport_name="EDDS"),
        )
        assert result["aircraft_registration"] == "D-EAGJ"
        assert result["aircraft_type"] == "DA20"
        assert result["filename"] == "1_DEAGJ_DA20.kml"

    def test_charterware_route_becomes_airport_name(self):
        result = self._build(
            "2026-01-12_1513h_OE-AKI_EDDF-EDDM.kml",
            TrackPoint(50.0, 8.5, 100.0),
            self._meta(airport_name="OE-AKI"),
        )
        assert result["airport_name"] == "EDDF Frankfurt Main - EDDM Munich"
        assert result["start_airport"] == "EDDF Frankfurt Main"
        assert result["end_airport"] == "EDDM Munich"
        assert "route" not in result
        assert "aircraft_type" not in result

    @pytest.mark.parametrize("name", ["LOAV", "LOAV V\u00f6slau-Kottingbrunn"])
    def test_charterware_route_wins_over_a_single_airport_name(self, name):
        """A single airport, raw or standardized, says nothing about the arrival."""
        result = self._build(
            "2026-01-12_1513h_OE-AKI_EDDF-EDDM.kml",
            TrackPoint(50.0, 8.5, 100.0),
            self._meta(airport_name=name),
        )
        assert result["airport_name"] == "EDDF Frankfurt Main - EDDM Munich"
        assert result["start_airport"] == "EDDF Frankfurt Main"

    def test_charterware_keeps_a_route_placemark_name(self):
        result = self._build(
            "2026-01-12_1513h_OE-AKI_EDDF-EDDM.kml",
            TrackPoint(50.0, 8.5, 100.0),
            self._meta(
                airport_name="LOAV V\u00f6slau - LOWW Wien",
                start_airport="LOAV V\u00f6slau",
                end_airport="LOWW Wien",
            ),
        )
        assert result["airport_name"] == "LOAV V\u00f6slau - LOWW Wien"
        assert result["start_airport"] == "LOAV V\u00f6slau"
        assert result["end_airport"] == "LOWW Wien"

    def test_route_airports_are_carried_over(self):
        result = self._build(
            "1_DEAGJ_DA20.kml",
            TrackPoint(50.0, 8.5, 100.0),
            self._meta(
                airport_name="A - B - C", start_airport="A - B", end_airport="C"
            ),
        )
        assert (result["start_airport"], result["end_airport"]) == ("A - B", "C")

    def test_unparsable_when_leaves_the_date_in_the_name(self):
        """A broken <when> must not hide the date the name still holds."""
        placemark = etree.fromstring(
            "<Placemark><name>EDDS to EDDP - 16 Aug 2026</name>"
            "<TimeStamp><when>not a time</when></TimeStamp></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["timestamp"] == "16 Aug 2026"
        assert result["year"] == 2026

    def test_unparsable_whens_are_skipped(self):
        placemark = etree.fromstring(
            "<Placemark><when>garbage</when><when>2025-06-15 12:00:00z</when>"
            "<when>2025-06-15T13:00:00Z</when><when>also garbage</when>"
            "</Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["timestamp"] == "2025-06-15 12:00:00z"
        assert result["end_timestamp"] == "2025-06-15T13:00:00Z"
        assert result["year"] == 2025

    def test_date_only_when_is_usable(self):
        placemark = etree.fromstring(
            "<Placemark><TimeStamp><when>2024-05</when></TimeStamp></Placemark>"
        )
        assert extract_placemark_metadata(placemark, NS)["year"] == 2024

    @pytest.mark.parametrize("when", ["1998-05-01", "1998-05", "1998"])
    def test_date_only_when_of_the_last_century(self, when):
        """The path would be dropped for a timestamp without a year."""
        placemark = etree.fromstring(
            f"<Placemark><name>EDDS - 16 Aug 2026</name>"
            f"<TimeStamp><when>{when}</when></TimeStamp></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["timestamp"] == when
        assert result["year"] == 1998

    def test_date_only_when_without_a_plausible_year_is_skipped(self):
        placemark = etree.fromstring(
            "<Placemark><name>EDDS - 16 Aug 2026</name>"
            "<TimeStamp><when>0042-05-01</when></TimeStamp></Placemark>"
        )
        result = extract_placemark_metadata(placemark, NS)
        assert result["timestamp"] == "16 Aug 2026"
        assert result["year"] == 2026

    @pytest.mark.parametrize(
        ("container_time", "timestamp", "end_timestamp"),
        [
            (
                "<TimeStamp><when>2024-07-01T10:00:00Z</when></TimeStamp>",
                "2024-07-01T10:00:00Z",
                None,
            ),
            (
                "<TimeSpan><begin>2024-07-01</begin><end>2024-07-03</end></TimeSpan>",
                "2024-07-01",
                "2024-07-03",
            ),
        ],
    )
    def test_time_of_the_container_is_inherited(
        self, container_time, timestamp, end_timestamp
    ):
        root = etree.fromstring(
            f"<Document>{container_time}<Folder><name>Trip</name>"
            "<Placemark><name>Home</name></Placemark></Folder></Document>"
        )
        result = extract_placemark_metadata(_find(root, ".//Placemark"), NS)
        assert result["timestamp"] == timestamp
        assert result["end_timestamp"] == end_timestamp
        assert result["year"] == 2024

    def test_nearest_container_wins(self):
        root = etree.fromstring(
            "<Document><TimeStamp><when>2023</when></TimeStamp>"
            "<Folder><TimeStamp><when>2024</when></TimeStamp>"
            "<Placemark><name>Home</name></Placemark></Folder></Document>"
        )
        assert (
            extract_placemark_metadata(_find(root, ".//Placemark"), NS)["year"] == 2024
        )

    def test_time_of_a_sibling_is_not_inherited(self):
        root = etree.fromstring(
            "<Document><Placemark><TimeStamp><when>2024-07-01</when></TimeStamp>"
            "</Placemark><Placemark><name>Home</name></Placemark></Document>"
        )
        placemark = root.findall("Placemark")[1]
        assert extract_placemark_metadata(placemark, NS)["year"] is None

    def test_own_time_wins_over_the_container(self):
        root = etree.fromstring(
            "<Folder><TimeStamp><when>2023</when></TimeStamp><Placemark>"
            "<TimeStamp><when>2024-07-01T10:00:00Z</when></TimeStamp>"
            "</Placemark></Folder>"
        )
        assert extract_placemark_metadata(_find(root, "Placemark"), NS)["year"] == 2024


class TestNullIsland:
    def test_zero_zero_is_rejected(self):
        assert validate_and_normalize_coordinate(0.0, 0.0, 100.0, "f") is None

    @pytest.mark.parametrize(("lat", "lon"), [(0.0, 8.5), (50.0, 0.0)])
    def test_equator_and_prime_meridian_are_valid(self, lat, lon):
        assert validate_and_normalize_coordinate(lat, lon, 100.0, "f") == (
            lat,
            lon,
            100.0,
        )


class TestExtractYearLooseTimestamps:
    @pytest.mark.parametrize(
        "timestamp",
        ["2024-12-31 23:30:00-02:00", "2024-12-31T23:30:00-02:00"],
    )
    def test_space_separated_timestamp_is_read_in_utc(self, timestamp):
        assert extract_year_from_timestamp(timestamp) == 2025
