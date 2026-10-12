"""Tests for export_writers module."""

from typing import Any
from unittest.mock import patch

import pytest

from flown.airports import AirportData
from flown.export_writers import (
    export_airports_data,
    export_metadata,
    exported_country_codes,
    free_text_airport_names,
)


def _airport(name, lat=48.6899, lon=9.2220, is_at_path_end=False):
    return AirportData(lat, lon, name, 0, is_at_path_end)


class TestExportAirportsData:
    def test_names_of_routes_and_markers(self, tmp_path, parse_data):
        airports = [
            _airport("EDDS Stuttgart - EDDP Leipzig"),
            _airport("EDDS Stuttgart - EDDP Leipzig", is_at_path_end=True),
            _airport("Log Start: 03 Mar 2025"),
            _airport(None),
        ]
        export_airports_data(airports, str(tmp_path))
        data = parse_data(tmp_path / "airports.json")
        names = [airport["name"] for airport in data["airports"]]
        assert names == ["EDDS Stuttgart", "EDDP Leipzig"]

    def test_valid_airport_with_country(self, tmp_path, parse_data):
        airports = [_airport("EDDS Stuttgart")]
        filepath, size = export_airports_data(airports, str(tmp_path))

        assert filepath == str(tmp_path / "airports.json")
        assert size == (tmp_path / "airports.json").stat().st_size
        data = parse_data(tmp_path / "airports.json")
        assert data == {
            "airports": [
                {
                    "code": "EDDS",
                    "country": "DE",
                    "lat": 48.6899,
                    "lon": 9.222,
                    "name": "EDDS Stuttgart",
                }
            ]
        }

    def test_only_the_marker_fields_are_exported(self, tmp_path, parse_data):
        export_airports_data([_airport("EDDS Stuttgart")], str(tmp_path))
        data = parse_data(tmp_path / "airports.json")
        assert set(data["airports"][0]) == {"code", "country", "lat", "lon", "name"}

    def test_country_of_an_airport_name_with_dash(self, tmp_path, parse_data):
        """The deduplicator stores one airport, not "EDAQ ... - LFBN ..."."""
        airports = [
            _airport("LFBN Niort - Marais Poitevin", lat=46.31, is_at_path_end=True)
        ]
        export_airports_data(airports, str(tmp_path))
        data = parse_data(tmp_path / "airports.json")
        assert data["airports"][0]["name"] == "LFBN Niort - Marais Poitevin"
        assert data["airports"][0]["country"] == "FR"

    def test_unknown_icao_has_no_country(self, tmp_path, parse_data):
        export_airports_data([_airport("ZZZZ Nowhere")], str(tmp_path))
        data = parse_data(tmp_path / "airports.json")
        assert "country" not in data["airports"][0]
        assert data["airports"][0]["code"] == "ZZZZ"

    @pytest.mark.parametrize(
        ("name", "code"),
        [
            ("EDAQ Halle-Oppin", "EDAQ"),
            # One code anywhere in the name is the airport's
            ("Flugplatz EDAQ Halle", "EDAQ"),
            # A leading code wins over a second one further on
            ("EDAQ near EDDP", "EDAQ"),
            # Two codes, neither leading: which one is the airport's is
            # unknown, and the page shows no code rather than a guess
            ("Between EDAQ and EDDP", None),
            # Not an ICAO region: I, J, Q and X lead no airport code
            ("JUNE Fly-in Meadow", None),
            ("Grass Strip Oppin", None),
        ],
    )
    def test_code_is_the_one_airports_merge_by(self, tmp_path, parse_data, name, code):
        """The frontend shows this code rather than reading the name again."""
        export_airports_data([_airport(name)], str(tmp_path))
        data = parse_data(tmp_path / "airports.json")
        assert data["airports"][0].get("code") == code

    def test_route_name_uses_position(self, tmp_path, parse_data):
        airports = [
            _airport("EDDS Stuttgart - EDDP Leipzig", is_at_path_end=False),
            _airport(
                "EDDS Stuttgart - EDDP Leipzig",
                lat=51.42,
                lon=12.23,
                is_at_path_end=True,
            ),
        ]
        export_airports_data(airports, str(tmp_path))
        data = parse_data(tmp_path / "airports.json")
        assert [a["name"] for a in data["airports"]] == [
            "EDDS Stuttgart",
            "EDDP Leipzig",
        ]

    @pytest.mark.parametrize("name", ["", "Unknown", "Log Start: 03 Mar 2025", None])
    def test_invalid_names_filtered(self, tmp_path, name, parse_data):
        export_airports_data([_airport(name)], str(tmp_path))
        data = parse_data(tmp_path / "airports.json")
        assert data["airports"] == []

    def test_every_deduplicated_airport_is_written(self, tmp_path, parse_data):
        """Merging nearby airports is the deduplicator's job, not the writer's."""
        airports = [
            _airport("EDDS Stuttgart"),
            _airport("EDDS Stuttgart", lat=48.68991, lon=9.22201),
        ]
        export_airports_data(airports, str(tmp_path))
        data = parse_data(tmp_path / "airports.json")
        assert len(data["airports"]) == 2

    def test_flight_count_never_exported(self, tmp_path, parse_data):
        """The frontend counts flights per active filter; see export_writers."""
        airports = [_airport("EDDS Stuttgart")]
        export_airports_data(airports, str(tmp_path))
        data = parse_data(tmp_path / "airports.json")
        assert "flight_count" not in data["airports"][0]

    def test_empty_list(self, tmp_path, parse_data):
        export_airports_data([], str(tmp_path))
        data = parse_data(tmp_path / "airports.json")
        assert data == {"airports": []}


class TestExportMetadata:
    def _export(self, tmp_path, **overrides):
        kwargs: dict[str, Any] = {
            "min_groundspeed_knots": 50.0,
            "max_groundspeed_knots": 180.0,
            "available_years": [2025, 2024],
            "year_file_bytes": {"2024": 10, "2025": 20},
            "aircraft_models": {"D-EHYL": "Diamond Star", "D-EAGJ": "Katana"},
            "output_dir": str(tmp_path),
            "available_flags": [],
        }
        kwargs.update(overrides)
        return export_metadata(**kwargs)

    def test_d2_shape(self, tmp_path, parse_data):
        filepath, size = self._export(tmp_path)
        assert filepath == str(tmp_path / "metadata.json")
        assert size == (tmp_path / "metadata.json").stat().st_size
        data = parse_data(tmp_path / "metadata.json")
        assert data == {
            "min_groundspeed_knots": 50.0,
            "max_groundspeed_knots": 180.0,
            "available_years": [2024, 2025],
            "year_file_bytes": {"2024": 10, "2025": 20},
            "aircraft_models": {"D-EAGJ": "Katana", "D-EHYL": "Diamond Star"},
            "available_flags": [],
        }
        # The frontend computes the statistics itself
        assert "stats" not in data
        # Written with sorted keys, so a re-export is byte identical
        content = (tmp_path / "metadata.json").read_text()
        assert content.index('"D-EAGJ"') < content.index('"D-EHYL"')
        assert list(data) == sorted(data)

    @pytest.mark.parametrize(
        "min_speed,max_speed,expected_min,expected_max",
        [
            (float("inf"), 150, 0.0, 150),
            (float("nan"), float("nan"), 0.0, 0.0),
            (float("-inf"), float("-inf"), 0.0, 0.0),
            (50.0, float("inf"), 50.0, 0.0),
        ],
        ids=["inf-min", "nan-both", "neg-inf-both", "inf-max"],
    )
    def test_non_finite_speeds_become_zero(
        self, tmp_path, min_speed, max_speed, expected_min, expected_max, parse_data
    ):
        self._export(
            tmp_path, min_groundspeed_knots=min_speed, max_groundspeed_knots=max_speed
        )
        data = parse_data(tmp_path / "metadata.json")
        assert data["min_groundspeed_knots"] == expected_min
        assert data["max_groundspeed_knots"] == expected_max

    def test_groundspeed_rounding(self, tmp_path, parse_data):
        self._export(
            tmp_path, min_groundspeed_knots=55.678, max_groundspeed_knots=199.123
        )
        data = parse_data(tmp_path / "metadata.json")
        assert data["min_groundspeed_knots"] == 55.7
        assert data["max_groundspeed_knots"] == 199.1


class TestExportedCountryCodes:
    """Which countries an export visited, for the flags the site publishes."""

    def test_lists_each_country_once_sorted(self):
        airports = [
            _airport("EDDF Frankfurt"),
            _airport("EDDM Munich"),
            _airport("LOWW Vienna"),
        ]

        assert exported_country_codes(airports) == ["AT", "DE"]

    def test_skips_what_no_country_is_known_for(self):
        assert exported_country_codes([_airport("Some Field")]) == []


class TestFreeTextAirportNames:
    """The published airport names the build warns about."""

    def test_names_without_a_known_code(self):
        airports = [
            _airport("EDDF Frankfurt Main"),
            _airport("Home strip - Aunt farm", is_at_path_end=True),
            # The shape of a code, but no airport in the database
            _airport("ANNA Mueller"),
            _airport("Bob Smith - MIKE", is_at_path_end=True),
        ]

        assert free_text_airport_names(airports) == [
            "ANNA Mueller",
            "Aunt farm",
            "MIKE",
        ]

    def test_none_for_coded_names(self):
        assert free_text_airport_names([_airport("EDDF Frankfurt Main")]) == []

    def test_text_beside_a_known_code(self):
        """A name the parser could not take a code of is published as written."""
        airports = [
            _airport("Anna EDDS EDDF"),
            _airport("EDDF Frankfurt with Anna"),
            _airport("EDDF Frankfurt Main"),
        ]
        assert free_text_airport_names(airports) == [
            "Anna EDDS EDDF",
            "EDDF Frankfurt with Anna",
        ]

    def test_without_an_airport_database(self, caplog):
        with patch("flown.export_writers.load_airport_database", return_value={}):
            assert free_text_airport_names([_airport("Anna - Bob")]) == []
        assert "Cannot check the published airport names" in caplog.text
