"""Tests for the parser module (end-to-end KML parsing)."""

import logging
import os
import zipfile
from pathlib import Path

import pytest

from flown.exceptions import KMLParseError
from flown.helpers import parse_timestamp_epoch
from flown.parser import _parse_kml_tree, parse_size
from flown.parser_cache import get_cache_key
from flown.types import TrackPoint
from tests.conftest import parse_kml_coordinates

MB = 1024 * 1024

KML_HEADER = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<kml xmlns="http://www.opengis.net/kml/2.2" '
    'xmlns:gx="http://www.google.com/kml/ext/2.2">'
)

LINESTRING_KML = f"""{KML_HEADER}
  <Document>
    <Placemark>
      <name>Test Path</name>
      <LineString>
        <coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>"""

GX_TRACK_KML = f"""{KML_HEADER}
  <Document>
    <Placemark>
      <name>Track</name>
      <gx:Track>
        <when>2025-03-15T10:00:00Z</when>
        <gx:coord>8.5 50.0 300</gx:coord>
        <when>2025-03-15T10:01:00Z</when>
        <gx:coord>9.0 51.0 400</gx:coord>
      </gx:Track>
    </Placemark>
  </Document>
</kml>"""


def _line_string(coordinates):
    return f"<LineString><coordinates>{coordinates}</coordinates></LineString>"


def _write(tmp_path, name, content):
    path = tmp_path / name
    path.write_text(content, encoding="utf-8")
    return str(path)


class TestParseKmlCoordinates:
    def test_parse_linestring(self, tmp_path):
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "test.kml", LINESTRING_KML)
        )
        assert coords == [
            TrackPoint(50.0, 8.5, 300.0, None),
            TrackPoint(51.0, 9.0, 400.0, None),
        ]
        assert paths == [coords]
        assert len(metadata) == 1
        assert metadata[0]["airport_name"] == "Test Path"
        assert metadata[0]["filename"] == "test.kml"
        assert metadata[0]["start_point"] == [50.0, 8.5, 300.0]

    def test_parse_gx_track_with_epoch_timestamps(self, tmp_path):
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "track.kml", GX_TRACK_KML)
        )
        assert len(coords) == 2
        assert len(paths) == 1
        assert paths[0][0].ts == parse_timestamp_epoch("2025-03-15T10:00:00Z")
        first_ts = paths[0][0].ts
        assert first_ts is not None
        assert paths[0][1].ts == first_ts + 60
        assert metadata[0]["timestamp"] == "2025-03-15T10:00:00Z"
        assert metadata[0]["end_timestamp"] == "2025-03-15T10:01:00Z"
        assert metadata[0]["year"] == 2025

    def test_second_parse_uses_cache_and_is_identical(self, tmp_path):
        kml_file = _write(tmp_path, "cached.kml", GX_TRACK_KML)
        first = parse_kml_coordinates(kml_file)
        cache_path, valid = get_cache_key(kml_file)
        assert valid is True
        assert cache_path is not None
        assert cache_path.exists()
        second = parse_kml_coordinates(kml_file)
        assert second == first
        assert all(isinstance(p, TrackPoint) for p in second[1][0])

    @pytest.mark.parametrize(
        "kml",
        [
            (
                f"{KML_HEADER}<Document><Placemark><Polygon><outerBoundaryIs>"
                "<LinearRing><coordinates>9,48,0 9.1,48,0 9.1,48.1,0 9,48,0"
                "</coordinates></LinearRing></outerBoundaryIs></Polygon>"
                "</Placemark></Document></kml>"
            ),
            LINESTRING_KML.replace(
                "<LineString>", "<LineString><altitudeMode>clampToGround</altitudeMode>"
            ),
        ],
        ids=["nothing-usable", "partly-usable"],
    )
    def test_a_cache_hit_logs_the_warnings_again(self, tmp_path, capsys, kml):
        kml_file = _write(tmp_path, "warn.kml", kml)
        first = parse_kml_coordinates(kml_file)
        warnings = capsys.readouterr().err
        assert "WARNING: warn.kml:" in warnings

        assert parse_kml_coordinates(kml_file) == first
        captured = capsys.readouterr()
        assert "(cached)" in captured.out
        assert captured.err == warnings

    def test_a_corrupt_cache_entry_is_parsed_again(self, tmp_path):
        kml_file = _write(tmp_path, "corrupt.kml", GX_TRACK_KML)
        first = parse_kml_coordinates(kml_file)
        cache_path, _ = get_cache_key(kml_file)
        assert cache_path is not None
        cache_path.write_text("{not json", encoding="utf-8")
        assert parse_kml_coordinates(kml_file) == first
        assert get_cache_key(kml_file) == (cache_path, True)
        assert cache_path.read_bytes().startswith(b"\x28\xb5\x2f\xfd")
        assert parse_kml_coordinates(kml_file) == first

    def test_invalid_xml_raises(self, tmp_path):
        with pytest.raises(KMLParseError, match="XML parsing error"):
            parse_kml_coordinates(_write(tmp_path, "bad.kml", "not valid xml <"))

    def test_parse_error_names_the_line(self, tmp_path):
        kml = "<?xml version='1.0'?>\n<kml>\n<Document>\n<Placemark>\n</kml>"
        with pytest.raises(KMLParseError, match="line 5") as excinfo:
            parse_kml_coordinates(_write(tmp_path, "bad.kml", kml))
        assert excinfo.value.line_number == 5
        assert "| File:" not in str(excinfo.value)

    def test_missing_file_raises(self, tmp_path):
        with pytest.raises(KMLParseError, match="I/O error"):
            parse_kml_coordinates(str(tmp_path / "missing.kml"))

    def test_no_valid_coordinates(self, tmp_path, capsys):
        kml = f"""{KML_HEADER}
  <Document><Placemark><name>Empty</name><Point><coordinates></coordinates></Point>
  </Placemark></Document></kml>"""
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "empty.kml", kml)
        )
        assert (coords, paths, metadata) == ([], [], [])
        # One line, with the file name: files are parsed in parallel
        err = capsys.readouterr().err
        assert "empty.kml: No valid coordinates found" in err
        assert err.count("\n") == 1

    def test_unprefixed_track_next_to_namespaced_point(self, tmp_path):
        """The namespace fallback is decided per element kind."""
        kml = f"""{KML_HEADER}
  <Document><Placemark><name>Home</name><Point><coordinates>8.5,50.0,100</coordinates></Point>
  </Placemark><Placemark><name>Flight</name>
  <Track><when>2025-03-15T10:00:00Z</when><coord>8.5 50.0 300</coord>
  <when>2025-03-15T10:01:00Z</when><coord>9.0 51.0 400</coord></Track>
  </Placemark></Document></kml>"""
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "mixed.kml", kml)
        )
        assert len(coords) == 3
        assert len(paths) == 1
        assert metadata[0]["year"] == 2025

    def test_namespace_less_kml(self, tmp_path):
        kml = """<?xml version="1.0"?><kml><Document><Placemark><name>Plain</name>
        <Track><when>2025-03-15T10:00:00Z</when><coord>8.5 50.0 300</coord>
        <when>2025-03-15T10:01:00Z</when><coord>9.0 51.0 400</coord></Track>
        </Placemark></Document></kml>"""
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "plain.kml", kml)
        )
        assert len(coords) == 2
        assert len(paths) == 1
        assert metadata[0]["year"] == 2025

    def test_elements_in_a_namespace_of_their_own(self, tmp_path):
        """An unknown namespace below the root is stripped, as if there were none.

        One on the root itself takes the place of the KML namespace instead.
        """
        kml = """<?xml version="1.0"?>
        <kml><Document xmlns="http://example.com/kml"><Placemark><name>Odd</name>
        <LineString><coordinates>8.5,50.0,300 9.0,51.0,400</coordinates></LineString>
        <TimeStamp><when>2025-03-15</when></TimeStamp>
        </Placemark></Document></kml>"""
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "odd.kml", kml)
        )
        assert len(coords) == 2
        assert len(paths) == 1
        assert metadata[0]["year"] == 2025

    def test_multiple_tracks_produce_multiple_paths(self, tmp_path):
        kml = f"""{KML_HEADER}
  <Document>
    <Placemark><name>First</name><gx:Track>
      <when>2025-03-15T10:00:00Z</when><gx:coord>8.5 50.0 300</gx:coord>
      <when>2025-03-15T10:01:00Z</when><gx:coord>8.6 50.1 300</gx:coord>
    </gx:Track></Placemark>
    <Placemark><name>Second</name><gx:Track>
      <when>2026-03-15T10:00:00Z</when><gx:coord>9.0 51.0 400</gx:coord>
      <when>2026-03-15T10:01:00Z</when><gx:coord>9.1 51.1 400</gx:coord>
    </gx:Track></Placemark>
  </Document></kml>"""
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "two.kml", kml)
        )
        assert len(coords) == 4
        assert [len(p) for p in paths] == [2, 2]
        assert [m["year"] for m in metadata] == [2025, 2026]
        assert [m["airport_name"] for m in metadata] == ["First", "Second"]

    def test_gx_coord_outside_track_warns(self, tmp_path, capsys):
        kml = f"""{KML_HEADER}<Document><Placemark>
        <gx:coord>8.5 50.0 300</gx:coord>
        <gx:Track><when>2025-03-15T10:00:00Z</when>
        <gx:coord>9.0 51.0 400</gx:coord></gx:Track>
        </Placemark></Document></kml>"""
        coords, _, _ = parse_kml_coordinates(_write(tmp_path, "loose.kml", kml))
        assert len(coords) == 1
        assert "outside of gx:Track were ignored" in capsys.readouterr().err

    def test_a_track_inside_a_track_counts_its_coords_once(self, tmp_path, capsys):
        """No exporter nests them, but no count may come out below zero."""
        kml = f"""{KML_HEADER}<Document><Placemark><gx:Track>
        <when>2025-03-15T10:00:00Z</when><gx:coord>9.0 51.0 400</gx:coord>
        <gx:Track><gx:coord>9.1 51.1 400</gx:coord></gx:Track>
        </gx:Track></Placemark></Document></kml>"""
        parse_kml_coordinates(_write(tmp_path, "nested.kml", kml))
        assert "outside of gx:Track" not in capsys.readouterr().err

    def test_gx_coord_counts_in_debug_output(self, tmp_path, capsys):
        from flown.logger import set_debug_mode

        set_debug_mode(True)
        try:
            parse_kml_coordinates(_write(tmp_path, "debug.kml", GX_TRACK_KML))
        finally:
            set_debug_mode(False)
        output = capsys.readouterr()
        assert "Found 1 gx:Track element(s) with 2 gx:coord elements" in output.out
        assert "outside of gx:Track" not in output.err

    def test_legacy_google_namespace_with_gx_track(self, tmp_path):
        """Names and LineStrings must not get lost next to a gx:Track."""
        kml = GX_TRACK_KML.replace(
            'xmlns="http://www.opengis.net/kml/2.2"',
            'xmlns="http://earth.google.com/kml/2.2"',
        ).replace(
            "</Document>",
            "<Placemark><name>EDDS - EDDP</name><LineString>"
            "<coordinates>9.2,48.7,300 12.2,51.4,300</coordinates>"
            "</LineString></Placemark></Document>",
        )
        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "legacy.kml", kml))
        assert len(paths) == 2
        assert [m["airport_name"] for m in metadata] == [
            "EDDS Stuttgart - EDDP Leipzig/Halle",
            "Track",
        ]

    def test_line_string_next_to_a_track_is_not_counted_twice(self, tmp_path):
        kml = f"""{KML_HEADER}<Document><Placemark><name>EDDS - EDDP</name>
        <MultiGeometry><gx:Track>
          <when>2025-03-15T10:00:00Z</when><gx:coord>8.5 50.0 300</gx:coord>
          <when>2025-03-15T10:01:00Z</when><gx:coord>9.0 51.0 400</gx:coord>
        </gx:Track>
        <LineString><coordinates>8.5,50.0,300 9.0,51.0,400</coordinates></LineString>
        </MultiGeometry></Placemark>
        <Placemark><name>Other</name><LineString>
          <coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>
        </LineString></Placemark></Document></kml>"""
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "both.kml", kml)
        )
        assert len(paths) == 2
        assert [m["airport_name"] for m in metadata] == [
            "Other",
            "EDDS Stuttgart - EDDP Leipzig/Halle",
        ]
        assert paths[1][0].ts is not None
        assert len(coords) == 4

    def test_a_kml_23_track_next_to_its_line_string(self, tmp_path):
        """The <Track> of KML 2.3 is in the namespace of OGC, not of gx.

        Its LineString was parsed as well and, coming first, kept as the
        flight by the duplicate check: without timestamps.
        """
        kml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<kml xmlns="http://www.opengis.net/kml/2.3"><Document><Placemark>'
            "<name>EDDS - EDDP</name><MultiGeometry><Track>"
            "<when>2025-03-15T10:00:00Z</when><coord>8.5 50.0 300</coord>"
            "<when>2025-03-15T10:01:00Z</when><coord>9.0 51.0 400</coord>"
            "</Track><LineString><coordinates>8.5,50.0,300 9.0,51.0,400"
            "</coordinates></LineString></MultiGeometry></Placemark>"
            "</Document></kml>"
        )
        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "kml23.kml", kml))
        assert len(paths) == 1
        assert paths[0][0].ts is not None

    @pytest.mark.parametrize(
        "track",
        [
            "<gx:Track/>",
            # 2D: no altitudes, so no path
            (
                "<gx:Track><when>2025-03-15T10:00:00Z</when>"
                "<gx:coord>8.5 50.0</gx:coord><when>2025-03-15T10:01:00Z</when>"
                "<gx:coord>9.0 51.0</gx:coord></gx:Track>"
            ),
            (
                "<gx:Track><altitudeMode>clampToGround</altitudeMode>"
                "<when>2025-03-15T10:00:00Z</when><gx:coord>8.5 50.0 300</gx:coord>"
                "<when>2025-03-15T10:01:00Z</when><gx:coord>9.0 51.0 400</gx:coord>"
                "</gx:Track>"
            ),
        ],
    )
    def test_a_line_string_next_to_a_track_without_a_path_is_kept(
        self, tmp_path, track
    ):
        """The LineString only stands in for a track that makes a path."""
        kml = (
            f"{KML_HEADER}<Document><Placemark><name>EDDS - EDDP</name>"
            f"<MultiGeometry>{track}"
            f"{_line_string('8.5,50.0,300 9.0,51.0,400')}"
            "</MultiGeometry></Placemark></Document></kml>"
        )
        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "t.kml", kml))
        assert [[p.alt for p in path] for path in paths] == [[300.0, 400.0]]
        assert metadata[0]["airport_name"] == "EDDS Stuttgart - EDDP Leipzig/Halle"

    def test_a_document_root_in_a_legacy_namespace(self, tmp_path):
        """No <kml> around it: the names were looked for in the OGC namespace
        and not found, next to a gx:Track."""
        kml = (
            '<Document xmlns="http://earth.google.com/kml/2.2" '
            'xmlns:gx="http://www.google.com/kml/ext/2.2">'
            "<Placemark><name>EDDS - EDDP</name>"
            "<TimeSpan><begin>2025-03-15T09:00:00Z</begin>"
            "<end>2025-03-15T10:00:00Z</end></TimeSpan>"
            f"{_line_string('8.5,50.0,300 9.0,51.0,400')}</Placemark>"
            "<Placemark><name>EDDP - EDDS</name><gx:Track>"
            "<when>2025-03-16T10:00:00Z</when><gx:coord>9.0 51.0 400</gx:coord>"
            "<when>2025-03-16T10:01:00Z</when><gx:coord>8.5 50.0 300</gx:coord>"
            "</gx:Track></Placemark></Document>"
        )
        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "doc.kml", kml))
        assert len(paths) == 2
        assert [m["airport_name"] for m in metadata] == [
            "EDDS Stuttgart - EDDP Leipzig/Halle",
            "EDDP Leipzig/Halle - EDDS Stuttgart",
        ]
        assert metadata[0]["end_timestamp"] == "2025-03-15T10:00:00Z"

    def test_a_line_string_next_to_an_unparsed_track_is_kept(self, tmp_path):
        """A <Track> the parser leaves out leaves its flight to the line."""
        kml = f"""{KML_HEADER}<Document><Placemark><name>A</name><gx:Track>
          <when>2025-03-15T10:00:00Z</when><gx:coord>8.5 50.0 300</gx:coord>
          <when>2025-03-15T10:01:00Z</when><gx:coord>9.0 51.0 400</gx:coord>
        </gx:Track></Placemark>
        <Placemark xmlns:o="urn:other"><name>B</name><MultiGeometry>
        <o:Track/><LineString><coordinates>7.5,50.0,300 7.0,51.0,400</coordinates>
        </LineString></MultiGeometry></Placemark></Document></kml>"""
        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "mixed.kml", kml))
        assert len(paths) == 2

    def test_a_file_name_that_is_not_utf_8(self, tmp_path, caplog):
        """As unzipped from a Windows archive: the build stopped on it."""
        # A captured line with the name cannot go to the xdist controller
        caplog.set_level(logging.CRITICAL, logger="flown")
        kml = f"""{KML_HEADER}<Document><Placemark><name>A</name><LineString>
          <coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>
        </LineString></Placemark></Document></kml>"""
        name = os.fsdecode(b"Flug_M\xfcnchen.kml")
        try:
            (tmp_path / name).write_text(kml, encoding="utf-8")
        except OSError, UnicodeEncodeError:  # pragma: no cover
            pytest.skip("the file system refuses names that are not UTF-8")
        _, paths, _ = parse_kml_coordinates(str(tmp_path / name))
        assert len(paths) == 1

    def test_text_node_over_10_mb(self, tmp_path):
        points = "9.123456,48.123456,1234.5 " * 420_000
        kml = (
            f"{KML_HEADER}<Document><Placemark><name>Long</name><LineString>"
            f"<coordinates>{points}</coordinates></LineString></Placemark>"
            "</Document></kml>"
        )
        coords, paths, _ = parse_kml_coordinates(_write(tmp_path, "long.kml", kml))
        assert len(coords) == 420_000
        assert len(paths) == 1

    def test_comments_inside_a_text_lose_nothing(self, tmp_path):
        """The text of an element stopped at a comment inside it: the
        points after it were lost without a word."""
        kml = (
            f"{KML_HEADER}<Document><Placemark>"
            "<name>Aunt<!-- from --> farm - Home <?pi x?>strip</name>"
            "<LineString><coordinates>8.5,50.0,300 <!-- a gap -->"
            "9.0,51.0,400 <!-- and another -->9.5,52.0,500</coordinates>"
            "</LineString></Placemark><Placemark><name>Track</name><gx:Track>"
            "<when>2025-03-15T10:00:00Z</when><gx:coord>8.5 50.0 <!-- -->300</gx:coord>"
            "<when>2025-03-15T10:01:00Z</when><gx:coord>9.0 <!-- -->51.0 400</gx:coord>"
            "</gx:Track></Placemark></Document></kml>"
        )
        coords, paths, metadata = parse_kml_coordinates(
            _write(tmp_path, "comments.kml", kml)
        )
        assert [len(path) for path in paths] == [3, 2]
        assert paths[0][-1] == TrackPoint(52.0, 9.5, 500.0, None)
        assert [(p.lat, p.lon, p.alt) for p in paths[1]] == [
            (50.0, 8.5, 300.0),
            (51.0, 9.0, 400.0),
        ]
        assert len(coords) == 5
        assert metadata[0]["airport_name"] == "Aunt farm - Home strip"

    def test_entity_expansion_is_still_rejected(self, tmp_path):
        entities = "".join(
            f'<!ENTITY lol{i} "' + f"&lol{i - 1};" * 10 + '">' for i in range(1, 10)
        )
        kml = (
            '<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY lol0 "lol">'
            f"{entities}]><kml><name>&lol9;</name></kml>"
        )
        # libxml2 stops it itself, or the declarations are refused after
        with pytest.raises(KMLParseError, match=r"XML parsing error|Entity"):
            parse_kml_coordinates(_write(tmp_path, "lol.kml", kml))

    def test_external_entities_are_not_resolved(self, tmp_path):
        secret = tmp_path / "secret.txt"
        secret.write_text("do not read")
        kml = (
            '<?xml version="1.0"?>'
            f'<!DOCTYPE kml [<!ENTITY x SYSTEM "{secret.as_uri()}">]>'
            "<kml><Placemark><name>&x;</name><LineString>"
            "<coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>"
            "</LineString></Placemark></kml>"
        )
        with pytest.raises(KMLParseError, match="Entity declarations") as failure:
            parse_kml_coordinates(_write(tmp_path, "xxe.kml", kml))
        assert "do not read" not in str(failure.value)

    def test_any_entity_declaration_is_refused(self, tmp_path):
        """Not left to the limits of whichever libxml2 lxml was built with."""
        kml = (
            '<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY field "EDAQ">]>'
            "<kml><Placemark><name>&field;</name><LineString>"
            "<coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>"
            "</LineString></Placemark></kml>"
        )
        with pytest.raises(KMLParseError, match="Entity declarations"):
            parse_kml_coordinates(_write(tmp_path, "entity.kml", kml))

    def test_a_doctype_without_entities_is_read(self, tmp_path):
        kml = (
            '<?xml version="1.0"?><!DOCTYPE kml [<!ELEMENT kml ANY>]>'
            "<kml><Placemark><name>EDAQ</name><LineString>"
            "<coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>"
            "</LineString></Placemark></kml>"
        )
        coordinates, _, _ = parse_kml_coordinates(_write(tmp_path, "dtd.kml", kml))
        assert len(coordinates) == 2

    def test_filename_is_parsed_once_per_file(self, tmp_path, capsys):
        kml = LINESTRING_KML.replace(
            "</Document>",
            "<Placemark><name>Second</name><LineString>"
            "<coordinates>8.5,50.0,300 9.0,51.0,400</coordinates>"
            "</LineString></Placemark></Document>",
        )
        _, paths, _ = parse_kml_coordinates(
            _write(tmp_path, "1_DEAGJ_DA20_extra.kml", kml)
        )
        assert len(paths) == 2
        assert capsys.readouterr().err.count("Ignoring extra filename parts") == 1

    def test_debug_logging_lists_tags(self, tmp_path, capsys):
        from flown.logger import set_debug_mode

        set_debug_mode(True)
        try:
            root, damage = _parse_kml_tree(_write(tmp_path, "dbg.kml", LINESTRING_KML))
        finally:
            set_debug_mode(False)
        assert root is not None
        assert damage is None
        assert "All unique tags in file" in capsys.readouterr().out
        assert not logging.getLogger("flown").isEnabledFor(logging.DEBUG)


class TestCharterwareIntegration:
    CHARTERWARE_KML = f"""{KML_HEADER}
    <Document id="1">
        <Placemark id="3">
            <name>OE-AKI</name>
            <description>Flight Jan 12 2026 03:01PM path of OE-AKI</description>
            <LineString id="2">
                <coordinates>
                    16.252537,47.96571,232.800003 16.252432,47.965717,231.800003
                    16.252419,47.96571,231.800003
                </coordinates>
            </LineString>
        </Placemark>
    </Document>
</kml>"""

    def test_parse_charterware_kml(self, tmp_path):
        kml_file = _write(
            tmp_path, "2026-01-12_1513h_OE-AKI_LOAV-LOAV.kml", self.CHARTERWARE_KML
        )
        coords, paths, metadata = parse_kml_coordinates(kml_file)
        assert len(coords) == 3
        assert len(paths) == 1
        meta = metadata[0]
        assert meta["aircraft_registration"] == "OE-AKI"
        assert "route" not in meta
        assert "aircraft_type" not in meta
        assert meta["timestamp"] == "2026-01-12T15:01:00+00:00"
        assert meta["year"] == 2026
        assert (
            meta["airport_name"]
            == "LOAV Vöslau-Kottingbrunn - LOAV Vöslau-Kottingbrunn"
        )

    def test_route_with_different_airports(self, tmp_path):
        kml = self.CHARTERWARE_KML.replace("OE-AKI", "D-EXYZ").replace(
            "Jan 12 2026 03:01PM", "Feb 15 2026 10:30AM"
        )
        kml_file = _write(tmp_path, "2026-02-15_1030h_D-EXYZ_EDDF-EDDM.kml", kml)
        _, _, metadata = parse_kml_coordinates(kml_file)
        assert metadata[0]["airport_name"] == "EDDF Frankfurt Main - EDDM Munich"
        assert metadata[0]["timestamp"] == "2026-02-15T10:30:00+00:00"

    def test_skydemon_airport_name_not_replaced(self, tmp_path):
        kml = f"""{KML_HEADER}<Document><Placemark><name>EDAV - EDBH</name>
        <gx:Track><when>2025-08-22T10:13:00Z</when>
        <gx:coord>13.71 52.82 42.0</gx:coord>
        <when>2025-08-22T10:14:00Z</when>
        <gx:coord>13.72 52.83 60.0</gx:coord></gx:Track>
        </Placemark></Document></kml>"""
        kml_file = _write(tmp_path, "1_DEHYL_DA40.kml", kml)
        _, _, metadata = parse_kml_coordinates(kml_file)
        assert (
            metadata[0]["airport_name"]
            == "EDAV Eberswalde-Finow - EDBH Stralsund-Barth"
        )
        assert metadata[0]["aircraft_registration"] == "D-EHYL"
        assert metadata[0]["aircraft_type"] == "DA40"


class TestTimeSpanPlacemark:
    KML = f"""{KML_HEADER}
  <Document>
    <Placemark>
      <name>EDDS - EDDP</name>
      <TimeSpan>
        <begin>2025-06-15T12:00:00Z</begin>
        <end>2025-06-15T13:30:00Z</end>
      </TimeSpan>
      <LineString>
        <coordinates>8.5,50.0,300 9.0,51.0,400 9.5,51.5,350</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>"""

    def test_timespan_gives_year_and_duration(self, tmp_path):
        """The obfuscator shifts TimeSpan dates; the parser must read them too."""
        from flown.export_pipeline import path_duration

        kml_file = _write(tmp_path, "1_DEAGJ_DA20.kml", self.KML)
        _, _, metadata = parse_kml_coordinates(kml_file)

        assert metadata[0]["year"] == 2025
        assert metadata[0]["timestamp"] == "2025-06-15T12:00:00Z"
        assert metadata[0]["end_timestamp"] == "2025-06-15T13:30:00Z"
        duration = path_duration(metadata[0])
        assert duration == 5400.0

    @pytest.mark.parametrize("inherited", [False, True], ids=["multi", "folder"])
    def test_lines_that_share_a_timespan_share_its_duration(self, tmp_path, inherited):
        """Each line gets its part by distance, so all fly the average speed."""
        from flown.export_pipeline import path_duration

        span = (
            "<TimeSpan><begin>2025-06-15T12:00:00Z</begin>"
            "<end>2025-06-15T13:30:00Z</end></TimeSpan>"
        )
        short = _line_string("8.0,50.0,300 8.0,50.1,300")
        long = _line_string("9.0,50.0,300 9.0,50.3,300")
        if inherited:
            body = (
                f"<Folder>{span}<Placemark><name>A</name>{short}</Placemark>"
                f"<Placemark><name>B</name>{long}</Placemark></Folder>"
            )
        else:
            body = (
                f"<Placemark><name>A</name>{span}"
                f"<MultiGeometry>{short}{long}</MultiGeometry></Placemark>"
            )
        kml = f"{KML_HEADER}<Document>{body}</Document></kml>"
        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "s.kml", kml))

        assert len(paths) == 2
        durations = [path_duration(meta) for meta in metadata]
        assert sum(durations) == pytest.approx(5400.0)
        assert durations[1] == pytest.approx(3 * durations[0])

    def test_lines_that_never_move_share_a_timespan_evenly(self, tmp_path):
        from flown.export_pipeline import path_duration

        span = (
            "<TimeSpan><begin>2025-06-15T12:00:00Z</begin>"
            "<end>2025-06-15T13:00:00Z</end></TimeSpan>"
        )
        # Apart from each other: a line that starts where the one before
        # ended continues it
        line = _line_string("8.0,50.0,300 8.0,50.0,310")
        other = _line_string("8.5,50.5,300 8.5,50.5,310")
        kml = (
            f"{KML_HEADER}<Document><Placemark><name>A</name>{span}"
            f"<MultiGeometry>{line}{other}</MultiGeometry></Placemark></Document></kml>"
        )
        _, _, metadata = parse_kml_coordinates(_write(tmp_path, "z.kml", kml))
        assert [path_duration(meta) for meta in metadata] == [1800.0, 1800.0]

    @pytest.mark.parametrize("inherited", [False, True], ids=["span", "folder"])
    def test_a_track_split_into_lines_is_one_flight(self, tmp_path, inherited):
        """Each piece starts where the one before ended: no airport between."""
        span = (
            "<TimeSpan><begin>2025-06-15T10:00:00Z</begin>"
            "<end>2025-06-15T11:00:00Z</end></TimeSpan>"
        )
        pieces = [
            "8.0,48.5,300 8.1,48.55,500",
            "8.1,48.55,500 8.2,48.6,700",
            "8.2,48.6,700 8.3,48.65,300",
        ]
        placemarks = "".join(
            f"<Placemark><name>Track segment</name>{'' if inherited else span}"
            f"{_line_string(piece)}</Placemark>"
            for piece in pieces
        )
        body = f"<Folder>{span}{placemarks}</Folder>" if inherited else placemarks
        kml = f"{KML_HEADER}<Document>{body}</Document></kml>"

        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "t.kml", kml))

        assert len(paths) == 1
        assert [(p.lon, p.alt) for p in paths[0]] == [
            (8.0, 300.0),
            (8.1, 500.0),
            (8.2, 700.0),
            (8.3, 300.0),
        ]
        assert metadata[0]["timestamp"] == "2025-06-15T10:00:00Z"
        assert metadata[0]["end_timestamp"] == "2025-06-15T11:00:00Z"
        assert "span_share" not in metadata[0]

    def test_pieces_of_one_name_in_sequence_span_them_all(self, tmp_path):
        placemarks = "".join(
            f"<Placemark><name>EDDS - EDDP</name><TimeSpan>"
            f"<begin>2025-06-15T{begin}</begin><end>2025-06-15T{end}</end>"
            f"</TimeSpan>{_line_string(piece)}</Placemark>"
            for begin, end, piece in [
                ("10:00:00Z", "10:30:00Z", "9.2,48.7,400 10.0,49.5,2000"),
                ("10:31:00Z", "11:00:00Z", "10.0,49.5,2000 12.2,51.4,150"),
            ]
        )
        kml = f"{KML_HEADER}<Document>{placemarks}</Document></kml>"

        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "r.kml", kml))

        assert len(paths) == 1
        assert metadata[0]["end_timestamp"] == "2025-06-15T11:00:00Z"
        assert metadata[0]["start_airport"].startswith("EDDS")

    @pytest.mark.parametrize(
        ("second_name", "second_begin", "start"),
        [
            # Another name and another time
            ("B", "10:31:00Z", "8.1,48.55"),
            # The same name, but hours later: the next flight from the spot
            ("A", "14:00:00Z", "8.1,48.55"),
            # The same name and time, but somewhere else
            ("A", "10:31:00Z", "8.5,48.9"),
        ],
    )
    def test_other_flights_stay_apart(self, tmp_path, second_name, second_begin, start):
        placemarks = "".join(
            f"<Placemark><name>{name}</name><TimeSpan>"
            f"<begin>2025-06-15T{begin}</begin><end>2025-06-15T{end}</end>"
            f"</TimeSpan>{_line_string(piece)}</Placemark>"
            for name, begin, end, piece in [
                ("A", "10:00:00Z", "10:30:00Z", "8.0,48.5,300 8.1,48.55,300"),
                (
                    second_name,
                    second_begin,
                    "23:00:00Z",
                    f"{start},300 8.3,48.65,300",
                ),
            ]
        )
        kml = f"{KML_HEADER}<Document>{placemarks}</Document></kml>"

        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "o.kml", kml))

        assert len(paths) == 2

    @pytest.mark.parametrize(
        ("second_begin", "second_start", "joined"),
        [
            # On from the point of the split, written twice
            ("10:30:00Z", "8.3 48.6 1500", True),
            # A few minutes later, a few metres on
            ("10:32:00Z", "8.3002 48.6001 1500", True),
            # Back in time: another recording of the same flight
            ("10:20:00Z", "8.3 48.6 1500", False),
            # Hours later: another flight of that name
            ("14:00:00Z", "8.3 48.6 1500", False),
        ],
    )
    def test_a_track_split_into_gx_tracks_is_one_flight(
        self, tmp_path, second_begin, second_start, joined
    ):
        """As LineStrings are: the first half would arrive in mid-air."""

        def placemark(whens, coords):
            return (
                "<Placemark><name>EDAQ - EDDC</name><gx:Track>"
                + "".join(f"<when>2025-06-15T{when}</when>" for when in whens)
                + "".join(f"<gx:coord>{coord}</gx:coord>" for coord in coords)
                + "</gx:Track></Placemark>"
            )

        first = placemark(
            ["10:00:00Z", "10:15:00Z", "10:30:00Z"],
            ["8.0 48.5 300", "8.2 48.55 1500", "8.3 48.6 1500"],
        )
        hour, minute, _ = second_begin.rstrip("Z").split(":")
        later = f"{hour}:{int(minute) + 10:02d}:00Z"
        second = placemark([second_begin, later], [second_start, "8.6 48.7 300"])
        kml = f"{KML_HEADER}<Document>{first}{second}</Document></kml>"

        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "g.kml", kml))

        assert len(paths) == (1 if joined else 2)
        if joined:
            assert len(paths[0]) == (4 if second_start == "8.3 48.6 1500" else 5)
            assert metadata[0]["end_timestamp"] == f"2025-06-15T{later}"

    def test_a_return_flight_under_one_timespan_stays_apart(self, tmp_path):
        """Out and back in a document of one TimeSpan: two routes, two flights."""
        span = (
            "<TimeSpan><begin>2026-01-01T08:00:00Z</begin>"
            "<end>2026-01-01T16:00:00Z</end></TimeSpan>"
        )
        placemarks = "".join(
            f"<Placemark><name>{name}</name>{_line_string(piece)}</Placemark>"
            for name, piece in [
                ("EDDS - EDTQ", "9.0,48.0,400 9.1,48.1,1200 9.3,48.3,400"),
                ("EDTQ - EDDS", "9.3,48.3,400 9.1,48.1,1200 9.0,48.0,400"),
            ]
        )
        kml = f"{KML_HEADER}<Document>{span}{placemarks}</Document></kml>"

        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "b.kml", kml))

        assert len(paths) == 2
        assert [meta["start_airport"][:4] for meta in metadata] == ["EDDS", "EDTQ"]

    @pytest.mark.parametrize(
        ("first", "second", "joined"),
        [
            # Named after the aircraft, a second flight from near where the
            # first one parked
            (
                "9.0,48.0,1000 9.1,48.1,1200 9.3,48.3,1100 9.3001,48.3001,1100",
                "9.3002,48.3002,1100 9.4,48.4,1200",
                False,
            ),
            # Split in flight, the point of the split written twice
            (
                "9.0,48.0,400 9.1,48.1,1200 9.3,48.3,1100",
                "9.3,48.3,1100 9.4,48.4,400",
                True,
            ),
            # The same point, but the first came down to where it started
            (
                "9.0,48.0,400 9.1,48.1,1200 9.3,48.3,400",
                "9.3,48.3,400 9.4,48.4,1200",
                False,
            ),
            # ... or stood still at its end, however high the field
            (
                (
                    "9.0,48.0,400 9.1,48.1,1200 9.3,48.3,900 9.30001,48.3,900 "
                    "9.30002,48.3,900"
                ),
                "9.30002,48.3,900 9.4,48.4,1200",
                False,
            ),
        ],
        ids=["near", "split", "landed", "standing"],
    )
    def test_untimed_lines_join_only_at_a_repeated_point_in_flight(
        self, tmp_path, first, second, joined
    ):
        placemarks = "".join(
            f"<Placemark><name>D-EABC</name>{_line_string(piece)}</Placemark>"
            for piece in (first, second)
        )
        kml = f"{KML_HEADER}<Document>{placemarks}</Document></kml>"

        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "u.kml", kml))

        assert len(paths) == (1 if joined else 2)

    def test_a_flight_that_landed_is_not_continued_by_the_next(self, tmp_path):
        """One name and one TimeSpan, but the first line ends on the ground."""
        span = (
            "<TimeSpan><begin>2026-01-01T08:00:00Z</begin>"
            "<end>2026-01-01T16:00:00Z</end></TimeSpan>"
        )
        placemarks = "".join(
            f"<Placemark><name>Local flight</name>{_line_string(piece)}</Placemark>"
            for piece in (
                "9.0,48.0,400 9.1,48.1,1200 9.0,48.0,400",
                "9.0,48.0,400 9.2,48.2,1200 9.0,48.0,400",
            )
        )
        kml = f"{KML_HEADER}<Document>{span}{placemarks}</Document></kml>"

        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "l.kml", kml))

        assert len(paths) == 2

    def test_lines_with_their_own_timespans_keep_them(self, tmp_path):
        from flown.export_pipeline import path_duration

        placemarks = "".join(
            f"<Placemark><name>{hour}</name><TimeSpan>"
            f"<begin>2025-06-15T{hour}:00:00Z</begin>"
            f"<end>2025-06-15T{hour}:30:00Z</end></TimeSpan><LineString>"
            f"<coordinates>8.0,50.0,300 8.0,50.{hour},300</coordinates>"
            "</LineString></Placemark>"
            for hour in (10, 12)
        )
        kml = f"{KML_HEADER}<Document>{placemarks}</Document></kml>"
        _, _, metadata = parse_kml_coordinates(_write(tmp_path, "o.kml", kml))
        assert [path_duration(meta) for meta in metadata] == [1800.0, 1800.0]
        assert all("span_share" not in meta for meta in metadata)


def _line(geometry, mode=None):
    mode_elem = f"<altitudeMode>{mode}</altitudeMode>" if mode else ""
    return (
        f"{KML_HEADER}<Document><Placemark><name>EDDS - EDDP</name>"
        f"<TimeStamp><when>2025-03-15T10:00:00Z</when></TimeStamp>{geometry}"
        f"</Placemark></Document></kml>"
    ).replace("MODE", mode_elem)


LINE = (
    "<LineString>MODE<coordinates>8.5,50.0,300 9.0,51.0,400</coordinates></LineString>"
)


class TestGeometryTypes:
    def test_polygon_is_no_flight_path(self, tmp_path, capsys):
        kml = _line(
            "<Polygon><outerBoundaryIs><LinearRing><coordinates>"
            "8.5,50.0,300 9.0,51.0,400 9.0,50.0,400 8.5,50.0,300"
            "</coordinates></LinearRing></outerBoundaryIs></Polygon>"
        )
        coords, paths, _ = parse_kml_coordinates(_write(tmp_path, "p.kml", kml))
        assert paths == []
        assert coords == []
        assert "outside of a LineString or Point" in capsys.readouterr().err

    def test_empty_coordinates_in_a_track_are_no_polygon(self, tmp_path, capsys):
        """SkyDemon writes an empty <coordinates /> into every gx:Track."""
        kml = GX_TRACK_KML.replace("<gx:Track>", "<gx:Track><coordinates />")
        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "e.kml", kml))
        assert len(paths) == 1
        assert "outside of a LineString" not in capsys.readouterr().err

    def test_multi_geometry_of_lines(self, tmp_path):
        kml = _line(
            f"<MultiGeometry>{LINE}{LINE.replace('8.5', '7.5')}</MultiGeometry>"
        )
        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "m.kml", kml))
        assert len(paths) == 2

    @pytest.mark.parametrize("mode", [None, "absolute"])
    def test_absolute_altitudes_are_kept(self, tmp_path, mode):
        _, paths, _ = parse_kml_coordinates(
            _write(tmp_path, "a.kml", _line(LINE, mode))
        )
        assert [p.alt for p in paths[0]] == [300.0, 400.0]

    @pytest.mark.parametrize(
        "mode", ["clampToGround", "relativeToGround", "clampToSeaFloor"]
    )
    def test_line_without_sea_level_altitudes_is_no_path(self, tmp_path, capsys, mode):
        coords, paths, _ = parse_kml_coordinates(
            _write(tmp_path, "c.kml", _line(LINE, mode))
        )
        assert paths == []
        assert [p.alt for p in coords] == [None, None]
        err = capsys.readouterr().err
        assert f"altitudeMode {mode} ignored" in err
        assert "without usable altitudes" not in err

    def test_gx_altitude_mode_on_a_track(self, tmp_path, capsys):
        kml = GX_TRACK_KML.replace(
            "<gx:Track>", "<gx:Track><gx:altitudeMode>clampToSeaFloor</gx:altitudeMode>"
        )
        coords, paths, _ = parse_kml_coordinates(_write(tmp_path, "t.kml", kml))
        assert paths == []
        assert len(coords) == 2
        assert "altitudeMode clampToSeaFloor ignored" in capsys.readouterr().err


class TestInheritedTime:
    def test_a_time_span_with_only_an_end_keeps_its_year(self, tmp_path):
        """The Folder's time took the place of the placemark's own end."""
        kml = (
            f"{KML_HEADER}<Document><Folder>"
            "<TimeSpan><begin>2023-07-01</begin></TimeSpan>"
            "<Placemark><name>EDDS - EDDP</name>"
            "<TimeSpan><begin>not a time</begin>"
            "<end>2024-07-01T11:00:00Z</end></TimeSpan>"
            f"{LINE.replace('MODE', '')}</Placemark></Folder></Document></kml>"
        )
        _, _, metadata = parse_kml_coordinates(_write(tmp_path, "e.kml", kml))
        assert metadata[0]["year"] == 2024
        assert metadata[0]["timestamp"] == "2024-07-01T11:00:00Z"

    def test_folder_time_dates_a_line_string(self, tmp_path):
        kml = (
            f"{KML_HEADER}<Document><Folder>"
            "<TimeSpan><begin>2024-07-01</begin></TimeSpan>"
            f"<Placemark><name>EDDS - EDDP</name>{LINE.replace('MODE', '')}"
            "</Placemark></Folder></Document></kml>"
        )
        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "f.kml", kml))
        assert len(paths) == 1
        assert metadata[0]["year"] == 2024


class TestLinesDatedByPoints:
    @staticmethod
    def _kml(points):
        trail = "".join(
            f"<Placemark><name>{name}</name>{time}"
            f"<Point><coordinates>{coords}</coordinates></Point></Placemark>"
            for name, time, coords in points
        )
        return (
            f"{KML_HEADER}<Document><Placemark><name>Route</name>"
            f"{_line_string('8.0,48.5,300 8.2,48.6,1500 8.4,48.7,300')}"
            f"</Placemark><Folder><name>Trail</name>{trail}</Folder>"
            "</Document></kml>"
        )

    def test_a_line_takes_the_year_of_its_timed_points(self, tmp_path):
        """Flightradar24: an untimed route, its times on a trail of Points."""
        kml = self._kml(
            [
                (
                    "1",
                    "<TimeStamp><when>2025-06-15T10:00:00Z</when></TimeStamp>",
                    "8.0,48.5,300",
                ),
                (
                    "2",
                    "<TimeStamp><when>2025-06-15T10:30:00Z</when></TimeStamp>",
                    "8.2,48.6,1500",
                ),
            ]
        )
        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "fr.kml", kml))
        assert len(paths) == 1
        assert metadata[0]["year"] == 2025

    def test_or_of_a_dated_marker(self, tmp_path):
        """SkyDemon names a Point after the start of the log."""
        kml = self._kml([("Log Start: 03 Mar 2025 08:58 Z", "", "8.0,48.5,300")])
        _, _, metadata = parse_kml_coordinates(_write(tmp_path, "sd.kml", kml))
        assert metadata[0]["year"] == 2025

    def test_points_of_two_years_date_nothing(self, tmp_path):
        kml = self._kml(
            [
                (
                    str(year),
                    f"<TimeStamp><when>{year}-06-15T10:00:00Z</when></TimeStamp>",
                    "8.0,48.5,300",
                )
                for year in (2024, 2025)
            ]
        )
        _, _, metadata = parse_kml_coordinates(_write(tmp_path, "two.kml", kml))
        assert metadata[0]["year"] is None


def _new_year_track():
    """A flight from 2025-12-31T23:00Z to 2026-01-01T02:00Z, mostly in 2026."""
    whens = []
    coords = []
    for i in range(19):
        minutes = 23 * 60 + 10 * i
        day = "2025-12-31" if minutes < 24 * 60 else "2026-01-01"
        clock = f"{minutes // 60 % 24:02d}:{minutes % 60:02d}:00"
        whens.append(f"<when>{day}T{clock}Z</when>")
        coords.append(f"<gx:coord>{9.0 + 0.02 * i:.2f} 48.0 {400 + 20 * i}</gx:coord>")
    return (
        f"{KML_HEADER}<Document><Placemark><name>EDDS - EDDP</name><gx:Track>"
        + "".join(whens)
        + "".join(coords)
        + "</gx:Track></Placemark></Document></kml>"
    )


class TestYearAcrossNewYear:
    def test_the_year_survives_the_obfuscation(self, tmp_path):
        """The parser and the obfuscator both go by the start of the flight."""
        from pathlib import Path

        from flown.obfuscate import obfuscate_kml_file

        kml_file = _write(tmp_path, "ny.kml", _new_year_track())
        _, _, before = parse_kml_coordinates(kml_file)
        assert obfuscate_kml_file(Path(kml_file)) is True
        _, _, after = parse_kml_coordinates(kml_file)

        assert before[0]["year"] == after[0]["year"] == 2025
        # At midnight, and three hours long as before
        assert after[0].get("timestamp") == "2025-01-01T00:00:00Z"
        assert after[0].get("end_timestamp") == "2025-01-01T03:00:00Z"


class TestMultiTrackFile:
    def test_a_paused_recording_is_one_flight(self, tmp_path):
        tracks = "".join(
            "<gx:Track>"
            + "".join(
                f"<when>2026-05-01T{hour:02d}:{minute:02d}:00Z</when>"
                f"<gx:coord>{9 + hour / 10 + minute / 1000:.3f} 48.0 300</gx:coord>"
                for minute in range(3)
            )
            + "</gx:Track>"
            for hour in (10, 11)
        )
        kml = (
            f"{KML_HEADER}<Document><Placemark><name>EDDS - EDDP</name>"
            "<gx:MultiTrack><altitudeMode>absolute</altitudeMode>"
            f"{tracks}</gx:MultiTrack></Placemark></Document></kml>"
        )
        _, paths, metadata = parse_kml_coordinates(_write(tmp_path, "m.kml", kml))
        assert [len(path) for path in paths] == [6]
        assert metadata[0]["timestamp"] == "2026-05-01T10:00:00Z"
        assert metadata[0]["end_timestamp"] == "2026-05-01T11:02:00Z"


KMZ_TRACK = (
    '<?xml version="1.0"?><kml xmlns="http://www.opengis.net/kml/2.2">'
    "<Placemark><name>EDAQ - EDAQ</name><TimeStamp><when>2025-01-01T00:00:00Z"
    "</when></TimeStamp><LineString><coordinates>"
    "12.05,51.55,110 12.10,51.60,500 12.15,51.65,900"
    "</coordinates></LineString></Placemark></kml>"
)


def _track(points):
    """A gx:Track of ``points`` fixes east, a second apart."""
    whens = "".join(
        f"<when>2025-06-01T10:{i // 60:02d}:{i % 60:02d}Z</when>\n"
        for i in range(points)
    )
    coords = "".join(
        f"<gx:coord>8.{i:04d} 50.0 {500 + i}</gx:coord>\n" for i in range(points)
    )
    return (
        f"{KML_HEADER}\n<Document><Placemark><name>Track</name><gx:Track>\n"
        f"{whens}{coords}</gx:Track></Placemark></Document></kml>\n"
    )


class TestDamagedDocuments:
    """A file a logger left cut off, and the slips of some writers."""

    def test_a_cut_off_track_keeps_what_comes_before_the_cut(self, tmp_path, caplog):
        kml = _track(100)
        cut = kml[: kml.index("<gx:coord>8.0060") + len("<gx:coord>8.00")]
        with caplog.at_level(logging.WARNING, logger="flown"):
            _, paths, _ = parse_kml_coordinates(_write(tmp_path, "cut.kml", cut))
        # The fix cut in the middle is left out, not read as 8.00
        assert [round(p.lon, 4) for p in paths[0]] == [
            round(8 + i / 10000, 4) for i in range(60)
        ]
        assert paths[0][59].ts is not None
        line = cut.count("\n") + 1
        assert "cut.kml: damaged, the points after it may be missing" in caplog.text
        # The message of lxml, which names the line once and not the file again
        assert caplog.text.count(f"line {line}, column") == 1
        assert "(cut.kml" not in caplog.text

    @pytest.mark.parametrize("end", ["8.12", "8.1234,50", "8.1234,50.1,5"])
    def test_the_point_a_line_is_cut_in_is_left_out(self, tmp_path, end):
        line = " ".join(f"8.{i:04d},50.0,{500 + i}" for i in range(10))
        kml = f"{KML_HEADER}<Placemark><LineString><coordinates>{line} {end}"
        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "cut.kml", kml))
        assert len(paths[0]) == 10
        assert paths[0][-1].alt == 509.0

    def test_content_after_the_end_leaves_every_point(self, tmp_path, caplog):
        kml = _track(10) + "\ngarbage<x>"
        with caplog.at_level(logging.WARNING, logger="flown"):
            _, paths, _ = parse_kml_coordinates(_write(tmp_path, "junk.kml", kml))
        assert len(paths[0]) == 10
        assert "junk.kml: damaged," in caplog.text

    def test_a_stray_ampersand_in_a_name_leaves_every_point(self, tmp_path):
        line = "8.1,50.1,300 8.2,50.2,310"
        kml = (
            f"{KML_HEADER}<Document><Placemark><name>EDAQ & back</name>"
            f"<LineString><coordinates>{line}</coordinates></LineString>"
            "</Placemark></Document></kml>"
        )
        _, paths, _ = parse_kml_coordinates(_write(tmp_path, "amp.kml", kml))
        assert len(paths[0]) == 2

    def test_a_damaged_file_without_a_path_still_fails(self, tmp_path):
        kml = f"{KML_HEADER}<Document><Placemark><name>Trac"
        with pytest.raises(KMLParseError, match="XML parsing error") as excinfo:
            parse_kml_coordinates(_write(tmp_path, "cut.kml", kml))
        assert excinfo.value.line_number == 2

    def test_white_space_before_the_declaration_is_no_damage(self, tmp_path, caplog):
        with caplog.at_level(logging.WARNING, logger="flown"):
            _, paths, _ = parse_kml_coordinates(
                _write(tmp_path, "lead.kml", "\n  " + GX_TRACK_KML)
            )
        assert len(paths[0]) == 2
        assert "damaged" not in caplog.text

    def test_a_mended_file_that_is_cut_off_is_recovered(self, tmp_path, caplog):
        kml = "\n" + _track(100)
        cut = kml[: kml.index("<gx:coord>8.0060")]
        with caplog.at_level(logging.WARNING, logger="flown"):
            _, paths, _ = parse_kml_coordinates(_write(tmp_path, "cut.kml", cut))
        assert len(paths[0]) == 59
        assert "cut.kml: damaged," in caplog.text

    def test_nothing_to_recover_fails_with_the_first_error(self, tmp_path):
        with pytest.raises(KMLParseError, match="XML parsing error"):
            parse_kml_coordinates(_write(tmp_path, "bad.kml", "\n<?xml oops"))

    def test_a_file_that_cannot_be_read(self, tmp_path, monkeypatch):
        kml_file = _write(tmp_path, "cut.kml", _track(10)[:-40])

        def unreadable(*args, **kwargs):
            raise OSError("gone")

        monkeypatch.setattr("builtins.open", unreadable)
        with pytest.raises(KMLParseError, match="File I/O error: gone"):
            _parse_kml_tree(kml_file)

    @pytest.mark.parametrize(
        "declaration", ['<?xml version="1.0" encoding="UTF-8"?>\n', ""]
    )
    def test_a_byte_that_is_no_utf_8_leaves_every_point(
        self, tmp_path, caplog, declaration
    ):
        """A Windows-1252 name in a file that claims, or defaults to, UTF-8.

        libxml2 reported it as an OSError of reading the file, so the whole
        flight failed with "File I/O error", where the same bytes inside a
        KMZ were recovered.
        """
        line = "8.1,50.1,300 8.2,50.2,310 8.3,50.3,320"
        kml = (
            f'{declaration}<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
            f"<Placemark><name>EDAQ - J\u00fcrgen</name>{_line_string(line)}"
            "</Placemark></Document></kml>"
        )
        path = tmp_path / "cp1252.kml"
        path.write_bytes(kml.encode("cp1252"))
        with caplog.at_level(logging.WARNING, logger="flown"):
            _, paths, _ = parse_kml_coordinates(str(path))
        assert len(paths[0]) == 3
        assert "cp1252.kml: damaged," in caplog.text
        assert "File I/O error" not in caplog.text

    def test_white_space_after_a_byte_order_mark_is_no_damage(self, tmp_path, caplog):
        path = tmp_path / "bom.kml"
        path.write_bytes(b"\xef\xbb\xbf\r\n  " + GX_TRACK_KML.encode())
        with caplog.at_level(logging.WARNING, logger="flown"):
            _, paths, _ = parse_kml_coordinates(str(path))
        assert len(paths[0]) == 2
        assert "damaged" not in caplog.text

    def test_a_root_prefix_that_is_not_declared(self, tmp_path, caplog):
        """Recovering it leaves the tag "kml:kml", which etree.QName refuses:
        the build logged a traceback for the file."""
        kml = (
            "<kml:kml><Document><Placemark><name>EDDS - EDDP</name>"
            f"{_line_string('8.5,50.0,300 9.0,51.0,400')}"
            "</Placemark></Document></kml:kml>"
        )
        with caplog.at_level(logging.WARNING, logger="flown"):
            _, paths, metadata = parse_kml_coordinates(
                _write(tmp_path, "prefix.kml", kml)
            )
        assert len(paths) == 1
        assert metadata[0]["airport_name"] == "EDDS Stuttgart - EDDP Leipzig/Halle"
        assert "prefix.kml: damaged," in caplog.text

    def test_gx_without_its_namespace_is_read(self, tmp_path, caplog):
        kml = GX_TRACK_KML.replace(' xmlns:gx="http://www.google.com/kml/ext/2.2"', "")
        with caplog.at_level(logging.WARNING, logger="flown"):
            _, paths, _ = parse_kml_coordinates(_write(tmp_path, "nogx.kml", kml))
        assert [p.alt for p in paths[0]] == [300.0, 400.0]
        assert "damaged" not in caplog.text

    def test_gx_without_its_namespace_under_a_prefixed_root_is_read(self, tmp_path):
        """A root in the KML namespace by a prefix of its own: the gx:
        declaration goes into that start tag, which stays whole."""
        kml = (
            GX_TRACK_KML.replace(' xmlns:gx="http://www.google.com/kml/ext/2.2"', "")
            .replace("<kml xmlns=", "<kml:kml xmlns:kml=")
            .replace("</kml>", "</kml:kml>")
        )
        root = _parse_kml_tree(_write(tmp_path, "prefixed.kml", kml))[0]
        assert root.tag == "{http://www.opengis.net/kml/2.2}kml"
        cut = kml[: kml.index("</kml:kml>") - 40]
        root, damage = _parse_kml_tree(_write(tmp_path, "cut.kml", cut))
        assert damage is not None
        assert root.tag == "{http://www.opengis.net/kml/2.2}kml"
        tracks = root.iter("{http://www.google.com/kml/ext/2.2}Track")
        assert next(tracks, None) is not None

    def test_a_cut_off_archive_member_is_read_once(self, tmp_path, caplog):
        kml = _track(100)
        kmz = _kmz(
            tmp_path / "cut.kmz",
            {"doc.kml": kml[: kml.index("<gx:coord>8.0060")], "extra.kml": kml},
        )
        with caplog.at_level(logging.WARNING, logger="flown"):
            _, paths, _ = parse_kml_coordinates(kmz)
        assert len(paths[0]) == 59
        assert caplog.text.count("holds 1 more KML file") == 1

    def test_entity_declarations_in_a_damaged_file_are_refused(self, tmp_path):
        kml = (
            '<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY a "b">]>'
            f"<kml>{_line_string('8.5,50.0,300 9.0,51.0,400')}<Placemark>"
        )
        with pytest.raises(KMLParseError, match="Entity"):
            parse_kml_coordinates(_write(tmp_path, "cut.kml", kml))


def _kmz(path, members):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return str(path)


class TestKmz:
    def test_reads_the_kml_member(self, tmp_path):
        kmz = _kmz(
            tmp_path / "1_DEAGJ_DA20.kmz",
            {"files/icon.png": b"png", "doc.kml": KMZ_TRACK},
        )

        coordinates, paths, metadata = parse_kml_coordinates(kmz)

        assert len(coordinates) == 3
        assert len(paths) == 1
        assert metadata[0]["aircraft_registration"] == "D-EAGJ"
        assert metadata[0]["filename"] == "1_DEAGJ_DA20.kmz"

    def test_other_kml_files_are_named_in_a_warning(self, tmp_path, caplog):
        """Only one is read: their flights were missing without a word."""
        kmz = _kmz(
            tmp_path / "tracks.kmz",
            {"tracks/a.kml": KMZ_TRACK, "tracks/b.kml": KMZ_TRACK},
        )
        with caplog.at_level(logging.WARNING, logger="flown"):
            _parse_kml_tree(kmz)
        assert (
            "tracks.kmz: the KMZ archive holds 1 more KML file(s) than tracks/a.kml"
            in caplog.text
        )

    def test_one_kml_file_and_macos_metadata_warn_of_nothing(self, tmp_path, caplog):
        kmz = _kmz(
            tmp_path / "track.kmz", {"doc.kml": KMZ_TRACK, "__MACOSX/._doc.kml": "x"}
        )
        with caplog.at_level(logging.WARNING, logger="flown"):
            _parse_kml_tree(kmz)
        assert "KMZ archive holds" not in caplog.text

    def test_the_same_as_the_kml_itself(self, tmp_path):
        kml = _write(tmp_path, "track.kml", KMZ_TRACK)
        kmz = _kmz(tmp_path / "track.kmz", {"doc.kml": KMZ_TRACK})

        assert parse_kml_coordinates(kmz)[:2] == parse_kml_coordinates(kml)[:2]

    def test_an_archive_without_a_kml_file_is_refused(self, tmp_path):
        kmz = _kmz(tmp_path / "empty.kmz", {"readme.txt": "nothing"})
        with pytest.raises(KMLParseError, match=r"holds no \.kml file"):
            _parse_kml_tree(kmz)

    def test_a_nested_archive_is_refused(self, tmp_path):
        inner = _kmz(tmp_path / "inner.kmz", {"doc.kml": KMZ_TRACK})
        kmz = _kmz(
            tmp_path / "outer.kmz",
            {"doc.kml": KMZ_TRACK, "inner.kmz": Path(inner).read_bytes()},
        )
        with pytest.raises(KMLParseError, match="another archive"):
            _parse_kml_tree(kmz)

    def test_a_damaged_member_name_is_a_bad_archive(self, tmp_path):
        """zipfile raises a UnicodeDecodeError for it, which is no bug of ours."""
        kmz = Path(_kmz(tmp_path / "damaged.kmz", {"dö.kml": KMZ_TRACK}))
        data = kmz.read_bytes()
        # The name of the local header, which comes first, no longer UTF-8
        name = "dö".encode()
        kmz.write_bytes(data.replace(name, b"d\xed\xa0", 1))
        with pytest.raises(KMLParseError, match="Not a valid KMZ archive"):
            _parse_kml_tree(str(kmz))

    def test_a_member_too_large_is_refused_before_it_is_read(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr("flown.parser.MAX_KML_FILE_SIZE", 100)
        kmz = _kmz(tmp_path / "big.kmz", {"doc.kml": KMZ_TRACK})
        with pytest.raises(KMLParseError, match="too large"):
            _parse_kml_tree(kmz)

    def test_a_member_larger_than_it_claims_is_refused(self, tmp_path, monkeypatch):
        """The size in the directory is the archive's word, not a limit."""
        monkeypatch.setattr("flown.parser.MAX_KML_FILE_SIZE", 100)
        kmz = _kmz(tmp_path / "liar.kmz", {"doc.kml": KMZ_TRACK})
        real = zipfile.ZipFile.infolist

        def claim_small(archive):
            infos = real(archive)
            for info in infos:
                info.file_size = 10
            return infos

        monkeypatch.setattr(zipfile.ZipFile, "infolist", claim_small)
        with pytest.raises(KMLParseError, match=r"larger than it claims|KMZ"):
            _parse_kml_tree(kmz)

    def test_skips_the_files_macos_adds(self, tmp_path):
        """Finder zips a folder with a resource fork per file: a few bytes of
        its own data under the name of the real file."""
        kmz = _kmz(
            tmp_path / "track.kmz",
            {
                "__MACOSX/._doc.kml": b"\x00\x05\x16\x07",
                "._doc.kml": b"\x00\x05\x16\x07",
                "track/._flight.kml": b"\x00\x05\x16\x07",
                "__MACOSX/old.kmz": b"",
                "track/flight.kml": KMZ_TRACK,
            },
        )

        assert len(parse_kml_coordinates(kmz)[1]) == 1

    def test_prefers_the_doc_kml_at_the_root(self, tmp_path):
        kmz = _kmz(
            tmp_path / "track.kmz",
            {
                "files/other.kml": "<kml/>",
                "files/doc.kml": "<kml/>",
                "doc.kml": KMZ_TRACK,
            },
        )

        assert len(parse_kml_coordinates(kmz)[1]) == 1

    def test_an_encrypted_member_is_refused(self, tmp_path):
        kmz = Path(_kmz(tmp_path / "locked.kmz", {"doc.kml": KMZ_TRACK}))
        data = bytearray(kmz.read_bytes())
        # The flag of a member that needs a password, in its local header and
        # in the central directory
        data[6] |= 0x1
        data[data.index(b"PK\x01\x02") + 8] |= 0x1
        kmz.write_bytes(bytes(data))

        with pytest.raises(KMLParseError, match="is encrypted"):
            _parse_kml_tree(str(kmz))

    def test_an_unknown_compression_is_refused(self, tmp_path, monkeypatch):
        kmz = _kmz(tmp_path / "deflate64.kmz", {"doc.kml": KMZ_TRACK})
        real = zipfile.ZipFile.infolist

        def deflate64(archive):
            infos = real(archive)
            for info in infos:
                info.compress_type = 9
            return infos

        monkeypatch.setattr(zipfile.ZipFile, "infolist", deflate64)
        with pytest.raises(KMLParseError, match="uses a compression"):
            _parse_kml_tree(kmz)

    def test_a_damaged_member_is_refused(self, tmp_path):
        kmz = Path(_kmz(tmp_path / "damaged.kmz", {"doc.kml": KMZ_TRACK}))
        with zipfile.ZipFile(kmz) as archive:
            info = archive.infolist()[0]
        data = bytearray(kmz.read_bytes())
        # Past the local header: a deflate block of the reserved type
        start = info.header_offset + 30 + len(info.filename) + len(info.extra)
        data[start : start + 3] = b"\xff\xff\xff"
        kmz.write_bytes(bytes(data))

        with pytest.raises(KMLParseError, match="Not a valid KMZ archive"):
            _parse_kml_tree(str(kmz))

    def test_not_a_zip_archive(self, tmp_path):
        kmz = _write(tmp_path, "fake.kmz", KMZ_TRACK)
        with pytest.raises(KMLParseError, match="Not a valid KMZ archive"):
            _parse_kml_tree(kmz)

    def test_the_cache_key_covers_the_archive(self, tmp_path):
        """The key hashes the file itself: another archive, another entry."""
        first = _kmz(tmp_path / "a.kmz", {"doc.kml": KMZ_TRACK})
        second = _kmz(tmp_path / "b.kmz", {"doc.kml": KMZ_TRACK})
        (tmp_path / "c").mkdir()
        # The name of the first, the content of neither
        changed = _kmz(
            tmp_path / "c" / "a.kmz", {"doc.kml": KMZ_TRACK.replace("900", "950")}
        )
        cache = tmp_path / "cache"
        keys = {str(get_cache_key(path, cache)[0]) for path in (first, second, changed)}
        assert len(keys) == 3


class TestParseSize:
    """The KML a parse reads, which the pool sizing and gates count."""

    def test_a_kml_file_counts_with_its_size(self, tmp_path):
        kml = _write(tmp_path, "track.kml", KMZ_TRACK)
        assert parse_size(kml) == Path(kml).stat().st_size

    def test_a_missing_file_counts_as_empty(self, tmp_path):
        assert parse_size(str(tmp_path / "missing.kmz")) == 0

    def test_a_kmz_counts_with_its_document_uncompressed(self, tmp_path, monkeypatch):
        # A megabyte of KML compresses to a few kilobytes
        kmz = _kmz(tmp_path / "track.kmz", {"doc.kml": b" " * MB})
        assert Path(kmz).stat().st_size < MB // 100
        # Only the central directory is read, no member is decompressed
        monkeypatch.setattr(
            zipfile.ZipFile, "open", lambda *_: pytest.fail("decompressed")
        )
        assert parse_size(kmz) == MB

    def test_the_member_the_parser_picks(self, tmp_path):
        kmz = _kmz(
            tmp_path / "track.kmz",
            {
                "__MACOSX/._doc.kml": b"x" * 10,
                "other.kml": b"x" * 20,
                "files/icon.png": b"x" * 40,
                "doc.kml": b"x" * 30,
            },
        )
        assert parse_size(kmz) == 30

    def test_capped_at_the_largest_document_the_parse_reads(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr("flown.parser.MAX_KML_FILE_SIZE", 100)
        kmz = _kmz(tmp_path / "big.kmz", {"doc.kml": b"x" * 1000})
        assert parse_size(kmz) == 100

    @pytest.mark.parametrize(
        "members", [None, {"readme.txt": "nothing"}], ids=["not a zip", "no kml"]
    )
    def test_an_archive_the_parse_refuses_counts_with_its_size(self, tmp_path, members):
        path = tmp_path / "broken.kmz"
        if members is None:
            path.write_bytes(b"not a zip archive")
        else:
            _kmz(path, members)
        assert parse_size(str(path)) == path.stat().st_size
