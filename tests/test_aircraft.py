"""Tests for aircraft module."""

import json
import logging

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from flown.aircraft import (
    AircraftInfo,
    load_aircraft_data,
    merge_aircraft_data,
    normalize_registration,
    parse_aircraft_from_filename,
    resolve_aircraft_models,
)


class TestNormalizeRegistration:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("DEAGJ", "D-EAGJ"),
            ("OEAKI", "OE-AKI"),
            ("HBXYZ", "HB-XYZ"),
            ("GABCD", "G-ABCD"),
            ("FGXYZ", "F-GXYZ"),
            ("IABCD", "I-ABCD"),
            ("PHABC", "PH-ABC"),
            ("OOABC", "OO-ABC"),
            ("LXABC", "LX-ABC"),
            ("SEABC", "SE-ABC"),
            ("OYABC", "OY-ABC"),
            ("LNABC", "LN-ABC"),
            ("OHABC", "OH-ABC"),
            ("EIABC", "EI-ABC"),
            ("SPABC", "SP-ABC"),
            ("OKABC", "OK-ABC"),
            ("OMABC", "OM-ABC"),
            ("HAABC", "HA-ABC"),
            ("9AABC", "9A-ABC"),
            ("S5ABC", "S5-ABC"),
            ("YUABC", "YU-ABC"),
            ("LZABC", "LZ-ABC"),
            ("YRABC", "YR-ABC"),
            ("SXABC", "SX-ABC"),
            ("TCABC", "TC-ABC"),
            ("ECABC", "EC-ABC"),
            ("CSABC", "CS-ABC"),
            ("ESABC", "ES-ABC"),
            ("YLABC", "YL-ABC"),
            ("LYABC", "LY-ABC"),
        ],
    )
    def test_prefix_table(self, raw, expected):
        assert normalize_registration(raw) == expected

    def test_us_registration_has_no_hyphen(self):
        assert normalize_registration("N12345") == "N12345"

    def test_existing_hyphen_kept(self):
        assert normalize_registration("OE-AKI") == "OE-AKI"

    def test_unknown_prefix_unchanged(self):
        assert normalize_registration("ZZ123") == "ZZ123"

    def test_prefix_only_unchanged(self):
        assert normalize_registration("D") == "D"
        assert normalize_registration("") == ""


class TestNormalizeRegistrationProperties:
    @settings(max_examples=200)
    @given(
        st.text(alphabet=st.characters(whitelist_categories=("Lu", "Nd")), max_size=8)
    )
    def test_idempotent(self, raw):
        once = normalize_registration(raw)
        assert normalize_registration(once) == once

    @settings(max_examples=200)
    @given(
        st.text(alphabet=st.characters(whitelist_categories=("Lu", "Nd")), max_size=8)
    )
    def test_only_inserts_one_hyphen(self, raw):
        result = normalize_registration(raw)
        assert result.replace("-", "") == raw
        assert result.count("-") <= 1


def _parsed(name: str) -> AircraftInfo:
    """What a file name says about the aircraft, where it says anything."""
    result = parse_aircraft_from_filename(name)
    assert result is not None
    return result


class TestParseAircraftFromFilenameNumbered:
    def test_numbered_format(self):
        result = _parsed("1_DEHYL_DA40.kml")
        assert result == AircraftInfo("D-EHYL", "DA40", None, "numbered")

    def test_uppercase_extension(self):
        result = _parsed("23_DEHYL_DA40.KML")
        assert result.type == "DA40"
        assert result.registration == "D-EHYL"

    def test_large_number(self):
        result = _parsed("87_DESST_C172.kml")
        assert result.registration == "D-ESST"
        assert result.type == "C172"

    def test_without_extension(self):
        result = _parsed("42_DELGD_C182")
        assert result.registration == "D-ELGD"
        assert result.type == "C182"

    def test_non_german_registration(self):
        result = _parsed("5_OE-AKI_PA28.kml")
        assert result.registration == "OE-AKI"
        assert result.type == "PA28"

    def test_austrian_registration_without_hyphen(self):
        result = _parsed("5_OEAKI_PA28.kml")
        assert result.registration == "OE-AKI"

    def test_extra_underscore_still_parses_first_three_parts(self):
        result = _parsed("7_DEAGJ_DA20_copy.kml")
        assert result.registration == "D-EAGJ"
        assert result.type == "DA20"
        assert result.format == "numbered"


class TestNotARegistration:
    @pytest.mark.parametrize(
        "name",
        [
            "2025_summer_trip.kml",
            "20250601_EDDS_EDDP.kml",
            "2025_LOWW_LOWI.kml",
            "12_12345_C172.kml",
            "3_D-EHYLXYZ_DA40.kml",
            "4_x_DA40.kml",
        ],
    )
    def test_no_aircraft(self, name):
        assert parse_aircraft_from_filename(name) is None

    @pytest.mark.parametrize(
        ("name", "registration"),
        [
            ("1_N12345_C172.kml", "N12345"),
            ("2_N123AB_C172.kml", "N123AB"),
            ("3_VHABC_C172.kml", "VHABC"),
            ("20250601_DEHYL_DA40.kml", "D-EHYL"),
            # Only after a date does a code count as an airport: ESSA is
            # Stockholm, and ES-SA in Estonia
            ("7_ESSA_C172.kml", "ES-SA"),
            ("20251399_ESSA_C172.kml", "ES-SA"),
            ("2_2GIGI_PA28.kml", "2-GIGI"),
            ("3_9XR-ABC_C172.kml", "9XR-ABC"),
            ("4_N1430Z_PA28.kml", "N1430Z"),
        ],
    )
    def test_registrations(self, name, registration):
        assert _parsed(name).registration == registration

    @pytest.mark.parametrize(
        "registration",
        ["ANNA", "JOHN", "MIKE", "DAVE", "DIRK", "BOB", "EDDS", "GREGOR", "N0123"],
    )
    def test_no_nationality_mark(self, registration, caplog):
        """A name has the shape of a registration, but starts with no mark."""
        result = _parsed(f"1_{registration}_DA40.kml")
        assert result.registration is None
        assert result.type == "DA40"
        assert f"Ignoring the registration {registration}" in caplog.text
        assert "nationality mark" in caplog.text

    def test_a_charterware_name_without_a_mark_keeps_its_route(self, caplog):
        assert _parsed("2026-01-01_0000h_ANNA_LOAV-LOAV.kml") == AircraftInfo(
            None, None, "LOAV-LOAV", "charterware"
        )
        assert "Ignoring the registration ANNA" in caplog.text

    @pytest.mark.parametrize(
        ("name", "aircraft_type"),
        [
            ("1_16AUG26_DA40.kml", "DA40"),
            ("3_1430Z_DA40.kml", "DA40"),
            ("4_MONDAY_DA40.kml", "DA40"),
            ("2026-01-01_0000h_16AUG26_LOAV-LOAV.kml", None),
        ],
    )
    def test_a_date_is_no_registration(self, name, aircraft_type, caplog):
        """The registration is published with every path, a date must not be."""
        result = _parsed(name)
        assert result.registration is None
        # The type and the route are still what the name says
        assert result.type == aircraft_type
        assert "it holds a date" in caplog.text


class TestAircraftType:
    @pytest.mark.parametrize(
        "raw",
        [
            "DA40",
            "C42",
            "P28A",
            "B738",
            "A20N",
            "EC35",
            "EC135",
            "R44",
            "H500",
            "AS50",
            "ASK21",
            "J3",
            "T6",
            "Z42",
            "DA40NG",
            "C172S",
            "PA-28",
            "PA-28-181",
            "DR400-180",
            "ATR72-600",
            "G-109B",
            "LS8-18",
            "DG-808C",
            "DA40-NG",
            "SR22",
            # Do and Mi are German weekdays as well (see _DATED_TYPE)
            "DO27",
            "MI8",
            "MI24",
            # A week of one digit, a quarter of the year 00 and a half with
            # digits after it name no day (see _DATED_TYPE)
            "W3",
            "W-3",
            "Q400",
            "Q300",
            "H25B",
            "H125",
            "H225",
            # The designators without a digit
            "GLID",
            "ULAC",
            "BALL",
            "GYRO",
            "SHIP",
            "UHEL",
            "PARA",
            "ZZZZ",
        ],
    )
    def test_a_type_designator_stays(self, raw, caplog):
        assert _parsed(f"1_DEHYL_{raw}.kml").type == raw
        assert "no type designator" not in caplog.text

    @pytest.mark.parametrize(
        ("raw", "aircraft_type"),
        [
            ("da40", "DA40"),
            ("Bo105", "BO105"),
            ("glid", "GLID"),
            # A date is taken out, as from every published name
            ("DA40 16 Aug 2026", "DA40"),
        ],
    )
    def test_published_in_capitals(self, raw, aircraft_type):
        assert _parsed(f"1_DEHYL_{raw}.kml").type == aircraft_type

    @pytest.mark.parametrize(
        "raw",
        [
            "DA40 mit Anna Mueller",
            "Anna",
            "ANNA",
            "JOHN",
            "MIKE",
            "DA40-ANNA",
            "DA40-BOB",
            "PA-BOB",
            "DA20 John",
            "Cessna-172-with-Bob",
            "PA-28-181-2",
            "C172Ä",
        ],
    )
    def test_free_text_is_dropped(self, raw, caplog):
        """The type is published with every path and in the link previews."""
        result = _parsed(f"3_DEHYL_{raw}.kml")
        assert result.registration == "D-EHYL"
        assert result.type is None
        assert f"Ignoring the aircraft type {raw!r}" in caplog.text

    def test_a_date_alone_is_no_type(self, caplog):
        assert _parsed("1_DEHYL_16AUG26.kml").type is None
        assert "no type designator" not in caplog.text

    @pytest.mark.parametrize(
        "raw",
        [
            "SAT16",
            "sun16",
            "MO16",
            "SA16",
            "FRI13",
            "W33",
            "Q3",
            "H2",
            "PM3",
            "AM10",
            # With a hyphen, a year or a day after it, and the weekdays of
            # French, Spanish, Italian and Portuguese
            "SAT-16",
            "MON-16",
            "W33-2",
            "Q326",
            "LUN16",
            "DOM16",
            "SAB16",
            "SEG16",
        ],
    )
    def test_a_day_week_or_hour_is_no_type(self, raw, caplog):
        """These passed as types and were published with every path (regression)."""
        assert _parsed(f"1_DEAGJ_{raw}.kml").type is None
        assert f"Ignoring the aircraft type {raw!r}" in caplog.text
        assert "names a day, a week or an hour" in caplog.text

    @pytest.mark.parametrize("raw", ["Q3-26", "H2-26"])
    def test_a_quarter_with_its_year_is_no_type(self, raw):
        assert _parsed(f"1_DEAGJ_{raw}.kml").type is None


class TestParseAircraftFromFilenameCharterware:
    def test_charterware_format(self):
        result = _parsed("2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml")
        assert result == AircraftInfo("OE-AKI", None, "LOAV-LOAV", "charterware")

    def test_different_route(self):
        result = _parsed("2026-01-15_1000h_D-EXYZ_EDDF-EDDM.kml")
        assert result.registration == "D-EXYZ"
        assert result.route == "EDDF-EDDM"

    def test_without_extension(self):
        result = _parsed("2026-01-12_1513h_OE-AKI_LOAV-LOAV")
        assert result.registration == "OE-AKI"

    def test_invalid_calendar_date_rejected(self):
        assert parse_aircraft_from_filename("2026-02-30_1513h_OE-AKI_LOAV.kml") is None

    def test_malformed_date_rejected(self):
        assert parse_aircraft_from_filename("2026-1-2_1513h_OE-AKI_LOAV.kml") is None

    @pytest.mark.parametrize("registration", ["constructor", "x", "12345", "D-EHYLXYZ"])
    def test_no_registration_keeps_the_route(self, registration):
        """The same rules as for a numbered name decide what a registration is."""
        name = f"2026-01-12_1513h_{registration}_LOAV-LOAV.kml"
        assert parse_aircraft_from_filename(name) == AircraftInfo(
            None, None, "LOAV-LOAV", "charterware"
        )

    @pytest.mark.parametrize("time_part", ["1513", "2513h", "1575h", "abcdh"])
    def test_invalid_time_rejected(self, time_part):
        name = f"2026-01-12_{time_part}_OE-AKI_LOAV-LOAV.kml"
        assert parse_aircraft_from_filename(name) is None


class TestParseAircraftFromFilenameUnrecognized:
    @pytest.mark.parametrize("name", ["flight_log.kml", "", "track.kml", "a_b.kml"])
    def test_unrecognized_returns_empty(self, name):
        assert parse_aircraft_from_filename(name) is None


class TestMorePrefixes:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("TFABC", "TF-ABC"),
            ("9HABC", "9H-ABC"),
            ("5BCKA", "5B-CKA"),
            ("URPSA", "UR-PSA"),
            ("EW123PA", "EW-123PA"),
            ("Z3MKD", "Z3-MKD"),
            ("E7ABC", "E7-ABC"),
            ("ZAABC", "ZA-ABC"),
            ("4OABC", "4O-ABC"),
            ("2GIGI", "2-GIGI"),
            ("MABCD", "M-ABCD"),
        ],
    )
    def test_the_hyphen_is_restored(self, raw, expected):
        assert normalize_registration(raw) == expected

    @pytest.mark.parametrize(
        ("name", "registration"),
        [
            ("1_9HABC_C172.kml", "9H-ABC"),
            ("2_2GIGI_PA28.kml", "2-GIGI"),
            ("3_M-ABCD_SR22.kml", "M-ABCD"),
            ("4_TFABC_C152.kml", "TF-ABC"),
        ],
    )
    def test_in_a_file_name(self, name, registration):
        assert _parsed(name).registration == registration


class TestLoadAircraftData:
    def test_loads_mapping(self, tmp_path):
        path = tmp_path / "aircraft.json"
        path.write_text(json.dumps({"D-EAGJ": "Diamond DA-20A-1 Katana"}))
        assert load_aircraft_data(path) == {"D-EAGJ": "Diamond DA-20A-1 Katana"}

    @pytest.mark.parametrize("key", ["d-eagj", "deagj", " D-EAGJ ", "Deagj"])
    def test_keys_are_read_in_capitals(self, tmp_path, key):
        """The file names are in capitals, and so is the registration they give."""
        path = tmp_path / "aircraft.json"
        path.write_text(json.dumps({key: "Diamond DA-20A-1 Katana"}))
        assert load_aircraft_data(path) == {"D-EAGJ": "Diamond DA-20A-1 Katana"}

    def test_corrupt_json_returns_empty(self, tmp_path):
        path = tmp_path / "aircraft.json"
        path.write_text("{invalid json")
        assert load_aircraft_data(path) == {}

    def test_missing_file_returns_empty(self, tmp_path):
        assert load_aircraft_data(tmp_path / "missing.json") == {}

    @pytest.mark.parametrize("encoding", ["utf-8-sig", "utf-16"])
    def test_reads_what_editors_save(self, tmp_path, encoding):
        """Notepad writes a byte order mark, or UTF-16."""
        path = tmp_path / "aircraft.json"
        path.write_text('{"D-EAGJ": "Kaétana"}', encoding=encoding)
        assert load_aircraft_data(path) == {"D-EAGJ": "Kaétana"}

    def test_another_encoding_returns_empty_with_a_warning(self, tmp_path, caplog):
        """A crash with a traceback before, in the CLI and in the page."""
        path = tmp_path / "aircraft.json"
        path.write_bytes('{"D-EAGJ": "Écureuil"}'.encode("cp1252"))
        with caplog.at_level(logging.WARNING, logger="flown"):
            assert load_aircraft_data(path) == {}
        assert "save it as UTF-8" in caplog.text

    def test_keys_are_normalized_like_file_names(self, tmp_path):
        """The key DEAGJ has to match D-EAGJ from 1_DEAGJ_DA20.kml."""
        path = tmp_path / "aircraft.json"
        path.write_text(json.dumps({"DEAGJ": "Katana", "D-EAGJ": "Other"}))
        assert load_aircraft_data(path) == {"D-EAGJ": "Katana"}

    def test_non_object_returns_empty(self, tmp_path):
        path = tmp_path / "aircraft.json"
        path.write_text(json.dumps(["D-EAGJ"]))
        assert load_aircraft_data(path) == {}

    def test_skips_models_that_are_no_text(self, tmp_path, caplog):
        """null would publish "None", an object its Python repr."""
        path = tmp_path / "aircraft.json"
        path.write_text(
            json.dumps(
                {
                    "D-EAGJ": None,
                    "D-EHYL": {"model": "DA40"},
                    "D-ESST": 172,
                    "D-EFGH": "  ",
                    "": "Nameless",
                    "D-EABC": "Cessna 172",
                }
            )
        )

        with caplog.at_level("WARNING", logger="flown"):
            aircraft = load_aircraft_data(path)

        assert aircraft == {"D-EABC": "Cessna 172"}
        assert len(caplog.records) == 5


class TestMergeAircraftData:
    def test_first_file_wins_on_conflict(self, tmp_path):
        first = tmp_path / "a" / "aircraft.json"
        second = tmp_path / "b" / "aircraft.json"
        first.parent.mkdir()
        second.parent.mkdir()
        first.write_text(json.dumps({"D-EAGJ": "First", "D-EHYL": "Only first"}))
        second.write_text(json.dumps({"D-EAGJ": "Second", "D-ESST": "Only second"}))

        merged = merge_aircraft_data([first, second])

        assert merged == {
            "D-EAGJ": "First",
            "D-EHYL": "Only first",
            "D-ESST": "Only second",
        }

    def test_empty_input(self):
        assert merge_aircraft_data([]) == {}


class TestResolveAircraftModels:
    def test_known_models_by_registration(self):
        data = {"D-EAGJ": "Katana", "D-EHYL": "Diamond Star", "D-XXXX": "Unused"}
        registrations = ["D-EHYL", None, "D-EAGJ", "D-ESST", "D-EAGJ", ""]
        models = resolve_aircraft_models(registrations, data)
        assert models == {"D-EAGJ": "Katana", "D-EHYL": "Diamond Star"}
        assert list(models) == ["D-EAGJ", "D-EHYL"]

    def test_without_aircraft_data(self):
        assert resolve_aircraft_models(["D-EAGJ"]) == {}
