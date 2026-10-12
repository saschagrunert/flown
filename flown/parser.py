"""KML file parsing for flight tracking data."""

import logging
import os
import re
import zipfile
import zlib
from pathlib import Path
from typing import TYPE_CHECKING, Any

from lxml import etree

from .aircraft import parse_aircraft_from_filename
from .constants import KML_NAMESPACE, KML_NAMESPACES
from .exceptions import KMLParseError
from .logger import logger
from .parser_cache import (
    CachedParse,
    get_cache_key,
    load_cached_parse,
    save_to_cache,
)
from .parser_common import (
    NON_MSL_ALTITUDE_MODES,
    altitude_mode,
    extract_placemark_metadata,
    find_xml_elements,
    local_name,
)
from .parser_gx_track import process_gx_track
from .parser_standard import process_standard_coordinates
from .validation import MAX_KML_FILE_SIZE

if TYPE_CHECKING:
    from collections.abc import Callable

    from .landings import FlightLandings
    from .types import FlightPath, FlightPathGroup, PathMetadata, PlacemarkMetadata

__all__ = [
    "ParseResult",
    "load_cached_entry",
    "parse_and_cache",
    "parse_size",
]

# What a parse returns: the flat coordinate list, the flight paths and the
# metadata of each path
type ParseResult = tuple[FlightPath, FlightPathGroup, list[PathMetadata]]


def _gx_coord_counts(root: etree._Element) -> tuple[int, int]:
    """The gx:coord elements in a gx:Track and those the track parser ignores.

    Both counts come from wildcard iterations, which run in C: an XPath
    that walked the ancestors of every coord took a tenth of a parse. A
    track inside another (no exporter writes one) is counted with the
    outer one, not a second time.
    """
    in_tracks = sum(
        1
        for track in root.iter("{*}Track")
        if next(track.iterancestors("{*}Track"), None) is None
        for _ in track.iter("{*}coord")
    )
    return in_tracks, sum(1 for _ in root.iter("{*}coord")) - in_tracks


# Archives inside a KMZ, which it is not unpacked into
_NESTED_ARCHIVE_SUFFIXES = (".kmz", ".zip")
# The document Google Earth writes at the root of the archive
_KMZ_DOCUMENT = "doc.kml"


def _is_macos_metadata(name: str) -> bool:
    """Whether a member is the resource fork macOS adds to a zip it makes.

    "__MACOSX/doc.kml" or "._doc.kml" holds a few bytes of Finder data
    under the name of a real file, not a KML document.
    """
    return name.startswith("__MACOSX/") or name.rpartition("/")[2].startswith("._")


def _kmz_documents(members: list[zipfile.ZipInfo]) -> list[zipfile.ZipInfo]:
    """The members of a KMZ archive that are KML documents."""
    return [
        info
        for info in members
        if info.filename.lower().endswith(".kml")
        and not info.is_dir()
        and not _is_macos_metadata(info.filename)
    ]


def _kmz_document(members: list[zipfile.ZipInfo]) -> zipfile.ZipInfo | None:
    """The KML document among the members: doc.kml at the root when there
    is one, the first other ``.kml`` otherwise."""
    documents = _kmz_documents(members)
    return next(
        (info for info in documents if info.filename.lower() == _KMZ_DOCUMENT),
        documents[0] if documents else None,
    )


def _kmz_members(archive: zipfile.ZipFile) -> list[zipfile.ZipInfo]:
    return [
        info for info in archive.infolist() if not _is_macos_metadata(info.filename)
    ]


def parse_size(kml_file: str) -> int:
    """The bytes of KML a parse of ``kml_file`` reads, 0 for a missing file.

    For a KML file its size. A KMZ archive compresses its document ten to
    twenty times, and the memory a parse takes follows the document, so
    for one this is the size the zip central directory records for the
    member ``_read_kmz`` picks, capped at ``MAX_KML_FILE_SIZE`` like the
    read. Nothing is decompressed. An archive whose directory cannot be
    read counts with its file size: the parse refuses it anyway.
    """
    try:
        size = os.path.getsize(kml_file)
    except OSError:
        return 0
    if not kml_file.lower().endswith(".kmz"):
        return size
    try:
        with zipfile.ZipFile(kml_file) as archive:
            document = _kmz_document(_kmz_members(archive))
    except zipfile.BadZipFile, zipfile.LargeZipFile, OSError, EOFError, ValueError:
        return size
    if document is None:
        return size
    return min(document.file_size, MAX_KML_FILE_SIZE)


def _read_kmz(kmz_file: str) -> bytes:
    """The KML document of a KMZ archive (see ``_kmz_document``).

    Google Earth writes the document as doc.kml, usually first; other
    members are images and models the track does not need. Any other KML
    document in it is not read, with a warning. The member is
    read only up to ``MAX_KML_FILE_SIZE``, whatever the archive claims,
    and an archive inside the archive is refused rather than unpacked.
    """
    try:
        with zipfile.ZipFile(kmz_file) as archive:
            members = _kmz_members(archive)
            nested = [
                info.filename
                for info in members
                if info.filename.lower().endswith(_NESTED_ARCHIVE_SUFFIXES)
            ]
            if nested:
                raise KMLParseError(
                    f"KMZ archive holds another archive ({nested[0]}); unzip it "
                    "and pass the KML file instead",
                    file_path=kmz_file,
                )
            document = _kmz_document(members)
            if document is None:
                raise KMLParseError(
                    "KMZ archive holds no .kml file", file_path=kmz_file
                )
            others = len(_kmz_documents(members)) - 1
            if others:
                # Only one is read: the flights of the others would be
                # missing without a word
                logger.warning(
                    "%s: the KMZ archive holds %d more KML file(s) than %s, "
                    "which are not read; unzip it and pass them as files",
                    Path(kmz_file).name,
                    others,
                    document.filename,
                )
            if document.file_size > MAX_KML_FILE_SIZE:
                raise KMLParseError(
                    f"The KML file in the archive is too large "
                    f"({document.file_size / 1024 / 1024:.1f} MB, max "
                    f"{MAX_KML_FILE_SIZE / 1024 / 1024:.0f} MB)",
                    file_path=kmz_file,
                )
            with archive.open(document) as member:
                data = member.read(MAX_KML_FILE_SIZE + 1)
    # ValueError: a member name that is no UTF-8 (UnicodeDecodeError) or an
    # offset before the start of the file, which a damaged archive holds
    except (
        zipfile.BadZipFile,
        zipfile.LargeZipFile,
        EOFError,
        zlib.error,
        ValueError,
    ) as e:
        raise KMLParseError(f"Not a valid KMZ archive: {e}", file_path=kmz_file) from e
    # A compression method zipfile does not know (such as Deflate64). Before
    # RuntimeError, which it is a kind of.
    except NotImplementedError as e:
        raise KMLParseError(
            f"The KMZ archive uses a compression this tool cannot read, unzip "
            f"it first: {e}",
            file_path=kmz_file,
        ) from e
    # zipfile raises RuntimeError for a member that needs a password
    except RuntimeError as e:
        raise KMLParseError(
            f"The KML file in the archive is encrypted, unzip it first: {e}",
            file_path=kmz_file,
        ) from e
    if len(data) > MAX_KML_FILE_SIZE:
        raise KMLParseError(
            "The KML file in the archive is larger than it claims", file_path=kmz_file
        )
    return data


def _refuse_entity_declarations(tree: etree._ElementTree, kml_file: str) -> None:
    """Refuse a document whose internal DTD subset declares entities.

    No KML exporter writes one. The parser resolves no entities, and
    libxml2 2.11 and later limit how far one can amplify, but a refusal
    here keeps a "billion laughs" document out whatever the libxml2 below
    lxml does.
    """
    # lxml-stubs knows neither internalDTD's type nor its entity iterator
    dtd: Any = tree.docinfo.internalDTD
    if dtd is not None and any(True for _ in dtd.iterentities()):
        raise KMLParseError(
            "Entity declarations are not allowed in a KML file", file_path=kml_file
        )


# The namespace of the gx: elements, which a file that uses them may not
# declare (see _repaired)
_GX_DECLARATION = b'xmlns:gx="http://www.google.com/kml/ext/2.2"'
# The start tag of the root, with the prefix of a writer that gives the KML
# namespace one (<kml:kml>)
_KML_START = re.compile(rb"<((?:[\w.-]+:)?kml)(?=[\s/>])")


def _xml_parser(*, recover: bool = False) -> etree.XMLParser:
    """The parser of a document: no entities, no network, no comments.

    huge_tree lifts libxml2's 10 MB limit per text node, which a single
    long <coordinates> reaches well below the accepted file size. Entities
    stay unresolved and the amplification limit still applies. Comments
    and processing instructions are dropped while parsing, so the text
    around one is a single text again: elem.text stopped at a comment
    inside a <coordinates>, a <gx:coord>, a <when> or a <name> and lost the
    points or the words after it. ``recover`` reads what it can of a
    damaged document (see ``_parse_kml_tree``).
    """
    return etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        huge_tree=True,
        remove_comments=True,
        remove_pis=True,
        recover=recover,
    )


def _repaired(data: bytes) -> bytes | None:
    """A document with the slips of some writers mended, None if it has none.

    White space before the XML declaration, which allows nothing before
    it, and gx: elements without the declaration of their namespace.
    """
    repaired = data
    if data[:1].isspace() and data.lstrip().startswith(b"<?xml"):
        repaired = repaired.lstrip()
    if b"<gx:" in repaired and b"xmlns:gx" not in repaired:
        repaired = _KML_START.sub(rb"<\1 " + _GX_DECLARATION, repaired, count=1)
    return repaired if repaired != data else None


def _parse_kml_tree(kml_file: str) -> tuple[etree._Element, KMLParseError | None]:
    """Parse a KML (or KMZ) file into its XML root element.

    A document that is no well-formed XML is read once more with the slips
    of some writers mended (see ``_repaired``), and then for what it holds
    up to where it is damaged: a logger whose battery ran out leaves a
    file cut off in the middle of its track. The second value is the error
    of such a damaged one (None for a sound one), which the caller raises
    when no path came of it.
    """
    damage: KMLParseError | None = None
    data: bytes | None = None
    try:
        if kml_file.lower().endswith(".kmz"):
            data = _read_kmz(kml_file)
            tree = etree.fromstring(data, _xml_parser()).getroottree()
        else:
            # As bytes: libxml2 wants the name in UTF-8, and one that is not
            # (unzipped from a Windows archive, copied off an old FAT drive)
            # holds surrogates Python cannot encode
            tree = etree.parse(os.fsencode(kml_file), _xml_parser())
    except etree.ParseError as e:
        # The message of lxml without the file it appends (see KMLParseError)
        damage = KMLParseError(
            f"XML parsing error: {e.msg}", file_path=kml_file, line_number=e.lineno
        )
        try:
            if data is None:
                with open(os.fsencode(kml_file), "rb") as file:
                    data = file.read()
            tree, mended = _parse_damaged(data)
        except OSError as error:
            raise KMLParseError(f"File I/O error: {error}", file_path=kml_file) from e
        if tree is None:
            raise damage from e
        if mended:
            damage = None
    except OSError as e:
        raise KMLParseError(f"File I/O error: {e}", file_path=kml_file) from e

    _refuse_entity_declarations(tree, kml_file)
    root = tree.getroot()
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug("\n  Root tag: %s", root.tag)
        logger.debug("Root attrib: %s", root.attrib)
        all_tags = {local_name(elem.tag) for elem in root.iter()}
        logger.debug("All unique tags in file: %s", sorted(all_tags))
    return root, damage


def _parse_damaged(data: bytes) -> tuple[etree._ElementTree | None, bool]:
    """The tree of a document that is no well-formed XML, and whether mended.

    Mended (see ``_repaired``), when that makes it well-formed: True. Else
    what libxml2 recovers of it, which holds what comes before the damage:
    False, and None for the tree when nothing is left of it.
    """
    repaired = _repaired(data)
    if repaired is not None:
        try:
            return etree.fromstring(repaired, _xml_parser()).getroottree(), True
        except etree.ParseError:
            pass
    # The mended document first, whose gx: elements are in their namespace,
    # then the file as it is, should mending have left nothing to recover
    for document in (repaired, data):
        if document is None:
            continue
        parser = _xml_parser(recover=True)
        try:
            root = etree.fromstring(document, parser)
        except etree.ParseError:  # pragma: no cover - recovering returns None
            root = None
        if root is not None:
            break
    else:
        return None, False
    # Cut off: the document ended with elements still open. Damage
    # anywhere else (content after the end, a stray "&" in a name) leaves
    # the last value whole, and libxml2 reads on past it.
    if any(
        error.type == etree.ErrorTypes.ERR_TAG_NOT_FINISHED
        for error in parser.error_log
    ):
        _drop_cut_value(root)
    return root.getroottree(), False


def _drop_cut_value(root: etree._Element) -> None:
    """Leave out the value a recovered document may hold only the start of.

    The last element read (the last child of the last child, and so on:
    the last to start) is where a cut-off file ends, in the middle of a
    value: "8.12" of "8.1234", 2 km off. A <coordinates> loses its last
    point, any other element (a <gx:coord>, a <when>, one cut in its name)
    goes as a whole. Only for a document that ended with elements still
    open (see ``_parse_damaged``): one cut off just after a value costs
    that point.
    """
    last = root
    while len(last):
        last = last[-1]
    if last is root:
        return
    if local_name(last.tag) == "coordinates":
        text = (last.text or "").rstrip()
        points = text.split()
        last.text = text[: len(text) - len(points[-1])] if points else text
        return
    parent = last.getparent()
    if parent is not None:
        parent.remove(last)


def _document_namespaces(root: etree._Element) -> dict[str, str]:
    """The namespaces to search a document with.

    Google Earth's legacy namespaces (http://earth.google.com/kml/2.x) hold
    the same elements as the OGC one and are used together with gx:Track.
    A root element in such a namespace takes the place of the ``kml`` prefix.
    """
    namespace = etree.QName(root).namespace
    if namespace and namespace != KML_NAMESPACE and local_name(root.tag) == "kml":
        return {**KML_NAMESPACES, "kml": namespace}
    return KML_NAMESPACES


def _extract_kml_elements(
    root: etree._Element, namespaces: dict[str, str], kml_file: str
) -> tuple[list[etree._Element], list[etree._Element], list[etree._Element]]:
    """Extract coordinate elements, gx:Track elements and placemarks."""
    coord_elements = root.findall(".//kml:coordinates", namespaces)
    tracks = root.findall(".//gx:Track", namespaces)

    # If no results, try without namespace (some KML files don't use it)
    if not coord_elements and not tracks:
        for elem in root.iter():
            if isinstance(elem.tag, str) and "}" in elem.tag:
                elem.tag = elem.tag.split("}", 1)[1]
        coord_elements = root.findall(".//coordinates")
        tracks = root.findall(".//Track")
    else:
        # One kind may still be in another (or no) namespace, such as an
        # unprefixed <Track> next to a namespaced <Point>. The wildcard
        # iteration runs in C and the tree is left as it is.
        if not coord_elements:
            coord_elements = list(root.iter("{*}coordinates"))
        if not tracks:
            tracks = list(root.iter("{*}Track"))

    logger.debug("Found %d coordinate elements", len(coord_elements))
    for i, elem in enumerate(coord_elements[:2]):
        logger.debug(
            "Element %d text preview: %s",
            i,
            str(elem.text)[:100] if elem.text else "None",
        )

    if tracks:
        track_gx_coords, loose_gx_coords = _gx_coord_counts(root)
        logger.debug(
            "Found %d gx:Track element(s) with %d gx:coord elements",
            len(tracks),
            track_gx_coords,
        )
        if loose_gx_coords:
            logger.warning(
                "%s: %d gx:coord element(s) outside of gx:Track were ignored",
                Path(kml_file).name,
                loose_gx_coords,
            )

    placemarks = root.findall(".//kml:Placemark", namespaces)
    if not placemarks:
        placemarks = root.findall(".//Placemark")

    return coord_elements, tracks, placemarks


def _build_coord_metadata_map(
    placemarks: list[etree._Element],
    namespaces: dict[str, str],
    tracks: list[etree._Element],
) -> tuple[dict[int, PlacemarkMetadata], set[int]]:
    """Map coordinate elements to their placemark metadata.

    Also returns the ids of the LineString coordinates to skip: a placemark
    holding both a track and a LineString (a MultiGeometry) is one feature,
    and the LineString is the fallback geometry for viewers without gx
    support. Parsing both would count the flight twice. Only the tracks
    that are parsed (``tracks``) count, in whichever namespace: the <Track>
    of KML 2.3 is in that of OGC, and one the parser leaves out leaves its
    flight to the LineString.
    """
    coord_to_metadata: dict[int, PlacemarkMetadata] = {}
    track_fallback_lines: set[int] = set()
    parsed_tracks = {id(track) for track in tracks}
    for placemark in placemarks:
        placemark_coords = find_xml_elements(
            placemark, ".//kml:coordinates", ".//coordinates", namespaces
        )
        if not placemark_coords:
            continue

        if any(id(track) in parsed_tracks for track in placemark.iter("{*}Track")):
            for coord_elem in placemark_coords:
                parent = coord_elem.getparent()
                if parent is not None and local_name(parent.tag) == "LineString":
                    track_fallback_lines.add(id(coord_elem))

        metadata = extract_placemark_metadata(placemark, namespaces)
        for coord_elem in placemark_coords:
            coord_to_metadata[id(coord_elem)] = metadata

    if track_fallback_lines:
        logger.debug(
            "Ignoring %d LineString(s) next to a gx:Track in the same placemark",
            len(track_fallback_lines),
        )
    return coord_to_metadata, track_fallback_lines


def _select_line_coordinates(
    coord_elements: list[etree._Element], kml_file: str
) -> tuple[list[etree._Element], set[int]]:
    """The <coordinates> that are parsed, and the lines without altitudes.

    Only a LineString (on its own or in a MultiGeometry) is a flight path. A
    Point is kept: it is counted, but a single position never forms a path.
    Everything else, the rings of a Polygon above all, is an area rather than
    a flight and is skipped. The second value holds the ids of the lines
    whose altitudes are not above sea level (see NON_MSL_ALTITUDE_MODES).
    """
    selected: list[etree._Element] = []
    unknown_altitude: set[int] = set()
    skipped = 0
    for elem in coord_elements:
        parent = elem.getparent()
        kind = local_name(parent.tag) if parent is not None else ""
        if parent is not None and kind == "LineString":
            mode = altitude_mode(parent)
            if mode in NON_MSL_ALTITUDE_MODES:
                logger.warning(
                    "%s: LineString with altitudeMode %s ignored: its altitudes "
                    "are not above sea level",
                    Path(kml_file).name,
                    mode,
                )
                unknown_altitude.add(id(elem))
        elif kind != "Point":
            # SkyDemon writes an empty <coordinates /> into its gx:Track
            if elem.text and elem.text.strip():
                skipped += 1
            continue
        selected.append(elem)
    if skipped:
        logger.warning(
            "%s: %d <coordinates> outside of a LineString or Point (such as a "
            "Polygon) ignored",
            Path(kml_file).name,
            skipped,
        )
    return selected, unknown_altitude


def _log_parse_result(
    kml_file: str,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    cached: bool,
) -> None:
    suffix = " (cached)" if cached else ""
    logger.info(
        "✓ Loaded %d points from %s%s", len(coordinates), Path(kml_file).name, suffix
    )
    if path_groups:
        total_alt_points = sum(len(path) for path in path_groups)
        logger.info(
            "  (%d points have altitude data in %d path(s))",
            total_alt_points,
            len(path_groups),
        )


class _WarningRecorder(logging.Handler):
    """Collects what a parse logs at WARNING and above, for the cache."""

    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.warnings: list[tuple[int, str]] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.warnings.append((record.levelno, record.getMessage()))


def load_cached_entry(kml_file: str) -> tuple[CachedParse | None, Path | None]:
    """The cached parse of a KML file (None on a miss) and its entry.

    The entry is where ``parse_and_cache`` stores a fresh parse, which saves
    hashing the file a second time; None when there is no cache. A hit logs
    the warnings of the parse that was cached again.
    """
    cache_path, cache_valid = get_cache_key(kml_file)
    if not (cache_valid and cache_path):
        return None, cache_path
    cached = load_cached_parse(cache_path)
    if cached is None:
        return None, cache_path
    _log_parse_result(kml_file, cached.coordinates, cached.path_groups, cached=True)
    for level, message in cached.warnings:
        logger.log(level, "%s", message)
    return cached, cache_path


def parse_and_cache(
    kml_file: str,
    cache_path: Path | None = None,
    landings_of: Callable[[FlightPathGroup], list[FlightLandings | None]] | None = None,
) -> tuple[ParseResult, list[FlightLandings | None] | None]:
    """Parse a KML file and store the result in the cache entry ``cache_path``.

    The cache is not looked up (see ``load_cached_entry``). The warnings of
    the parse are stored with the result, and so are the landings of its
    paths that ``landings_of`` finds (see ``landings.path_landings``),
    which are returned with it: None without it.
    """
    recorder = _WarningRecorder()
    logger.addHandler(recorder)
    try:
        result = _parse_kml(kml_file)
    finally:
        logger.removeHandler(recorder)
    landings = landings_of(result[1]) if landings_of is not None else None
    if cache_path:
        save_to_cache(cache_path, *result, recorder.warnings, landings)
    return result, landings


def _parse_kml(kml_file: str) -> ParseResult:
    coordinates: FlightPath = []
    path_groups: FlightPathGroup = []
    path_metadata: list[PathMetadata] = []

    root, damage = _parse_kml_tree(kml_file)
    namespaces = _document_namespaces(root)

    coord_elements, tracks, placemarks = _extract_kml_elements(
        root, namespaces, kml_file
    )
    coord_to_metadata, track_fallback_lines = _build_coord_metadata_map(
        placemarks, namespaces, tracks
    )
    if track_fallback_lines:
        coord_elements = [
            elem for elem in coord_elements if id(elem) not in track_fallback_lines
        ]
    coord_elements, unknown_altitude = _select_line_coordinates(
        coord_elements, kml_file
    )

    # Once per file: it logs its complaints about the name on every call
    aircraft_info = parse_aircraft_from_filename(Path(kml_file).name)

    process_standard_coordinates(
        coord_elements,
        coord_to_metadata,
        kml_file,
        coordinates,
        path_groups,
        path_metadata,
        aircraft_info,
        unknown_altitude,
    )

    process_gx_track(
        tracks,
        namespaces,
        kml_file,
        coordinates,
        path_groups,
        path_metadata,
        aircraft_info,
    )

    if damage is not None:
        if not path_groups:
            raise damage
        # Loud: what the file held after the damage may be missing
        logger.warning(
            "%s: damaged, the points after it may be missing (%s)",
            Path(kml_file).name,
            damage,
        )

    _log_parse_result(kml_file, coordinates, path_groups, cached=False)

    if not coordinates:
        # One line with the file name: the files of a run are parsed in
        # parallel, so the lines of several warnings would interleave
        logger.warning(
            "%s: No valid coordinates found (unexpected structure or coordinate "
            "format; run with --debug for details)",
            Path(kml_file).name,
        )

    return coordinates, path_groups, path_metadata
