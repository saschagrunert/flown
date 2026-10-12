"""Google Earth Track (gx:Track) processing.

Every gx:Track element becomes one flight path, and so do all tracks of one
gx:MultiTrack together. The <when> and <gx:coord> children of a track are
paired by position in document order; metadata is taken from the enclosing
Placemark.
"""

from bisect import bisect_right
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING

from .constants import MAX_TIMESTAMP_DISTANCE_SECONDS
from .helpers import parse_timestamp_epoch
from .logger import logger
from .parser_common import (
    NON_MSL_ALTITUDE_MODES,
    altitude_mode,
    build_path_metadata_dict,
    empty_placemark_metadata,
    extract_placemark_metadata,
    extract_year_from_timestamp,
    local_name,
    validate_and_normalize_coordinate,
)
from .types import TrackPoint

if TYPE_CHECKING:
    from collections.abc import Sequence

    from lxml import etree

    from .aircraft import AircraftInfo
    from .types import FlightPath, FlightPathGroup, PathMetadata, PlacemarkMetadata


def _find_placemark(track: etree._Element) -> etree._Element | None:
    """Find the Placemark element enclosing a gx:Track."""
    for ancestor in track.iterancestors():
        if local_name(ancestor.tag) == "Placemark":
            return ancestor
    return None


def _collect_track_children(
    track: etree._Element,
) -> tuple[list[str], list[str | None]]:
    """Collect <when> texts and <gx:coord> texts of a track in document order.

    One walk over the children: only the two tags come through it, and the
    local name of each ends in "when" or in "coord".
    """
    whens: list[str] = []
    coords: list[str | None] = []
    for child in track.iterchildren("{*}when", "{*}coord"):
        if child.tag.endswith("when"):
            whens.append((child.text or "").strip())
        else:
            coords.append(child.text)
    return whens, coords


def _consistent_timestamps(timestamps: list[float | None]) -> list[bool]:
    """Which of a track's timestamps to keep (True) and which to drop.

    Loggers write the odd wrong <when>: a clock at its default date until
    the GPS fix, a single stamp years ahead, a GPS week rollover. Two rules
    keep one such stamp from spoiling the rest of the track:

    - A stamp more than ``MAX_TIMESTAMP_DISTANCE_SECONDS`` from the median of
      the track is wrong. The median belongs to the majority of the stamps,
      however wrong the first ones are.
    - Of the rest, the longest run of stamps that never goes backwards is
      kept (the longest non-decreasing subsequence). A stamp out of order
      with its neighbours is dropped, whichever direction it is off in,
      and the stamps around it are kept: rejecting everything before a
      later stamp, as a plain "not before the previous one" rule would,
      lost the whole track after a single stamp from the future.

    Time therefore never runs backwards along the kept stamps.
    """
    keep = [ts is not None for ts in timestamps]
    present = [ts for ts in timestamps if ts is not None]
    if not present:
        return keep
    # The usual track is in order and within the limit: nothing to drop
    in_order = all(a <= b for a, b in pairwise(present))
    if in_order:
        median = present[len(present) // 2]
        if max(median - present[0], present[-1] - median) <= (
            MAX_TIMESTAMP_DISTANCE_SECONDS
        ):
            return keep
    else:
        median = sorted(present)[len(present) // 2]
    for index, ts in enumerate(timestamps):
        if ts is not None and abs(ts - median) > MAX_TIMESTAMP_DISTANCE_SECONDS:
            keep[index] = False

    # Longest non-decreasing subsequence in O(n log n): tails[k] is the
    # smallest last stamp of a run of length k + 1, and predecessor links
    # the stamps of the best run back to its start
    candidates = [
        (index, ts)
        for index, (ts, kept) in enumerate(zip(timestamps, keep, strict=True))
        if kept and ts is not None
    ]
    tails: list[float] = []
    tail_index: list[int] = []
    predecessor: dict[int, int | None] = {}
    for index, ts in candidates:
        length = bisect_right(tails, ts)
        predecessor[index] = tail_index[length - 1] if length else None
        if length == len(tails):
            tails.append(ts)
            tail_index.append(index)
        else:
            tails[length] = ts
            tail_index[length] = index

    in_run: set[int] = set()
    current = tail_index[-1] if tail_index else None
    while current is not None:
        in_run.add(current)
        current = predecessor[current]
    for index, _ in candidates:
        if index not in in_run:
            keep[index] = False
    return keep


def parse_gx_tracks(
    tracks: Sequence[etree._Element], kml_file: str, coordinates: FlightPath
) -> tuple[FlightPath, list[str]]:
    """Parse gx:Track elements into one flight path, one track after another.

    Several tracks are the children of one gx:MultiTrack: one flight whose
    recording paused. Their points are joined into a single path, whose gap
    in time the exporter and the frontend handle like any other.

    Returns the path (points with altitude) and the <when> texts of the
    path's points that carry a timestamp, in path order: the first and last
    of them are the time span of the path. A <when> that is unparsable,
    inconsistent with the rest of the path (see ``_consistent_timestamps``),
    or that belongs to a coordinate that was rejected or has no altitude, is
    not among them. Points are appended to ``coordinates`` as well.
    """
    filename = Path(kml_file).name
    source = f"{filename} (gx:Track)"

    # The valid coordinates with their <when> text and parsed timestamp
    points: list[tuple[float, float, float | None, str]] = []
    timestamps: list[float | None] = []
    ignored_mode: str | None = None
    for track in tracks:
        whens, coord_texts = _collect_track_children(track)
        # See NON_MSL_ALTITUDE_MODES: such a track has no usable altitudes
        mode = altitude_mode(track)
        msl_altitudes = mode not in NON_MSL_ALTITUDE_MODES
        if not msl_altitudes:
            ignored_mode = mode

        if whens and len(whens) != len(coord_texts):
            logger.warning(
                "%s: gx:Track has %d <when> but %d <gx:coord> elements; "
                "pairing them by position",
                filename,
                len(whens),
                len(coord_texts),
            )

        for idx, coord_text in enumerate(coord_texts):
            parsed = _parse_gx_coord(coord_text)
            if parsed is None:
                continue
            lat, lon, alt = parsed
            validated = validate_and_normalize_coordinate(
                lat, lon, alt if msl_altitudes else None, source
            )
            if validated is None:
                continue

            when = whens[idx] if idx < len(whens) else ""
            ts = None
            if when:
                ts = parse_timestamp_epoch(when)
                if ts is None:
                    logger.debug("Unparsable <when> in %s: %s", source, when)
            points.append((*validated, when))
            timestamps.append(ts)

    if ignored_mode is not None:
        # Once for all tracks of a gx:MultiTrack, which share the mode
        logger.warning(
            "%s: gx:Track with altitudeMode %s ignored: its altitudes are not "
            "above sea level",
            filename,
            ignored_mode,
        )

    keep = _consistent_timestamps(timestamps)
    dropped = sum(
        1
        for ts, kept in zip(timestamps, keep, strict=True)
        if ts is not None and not kept
    )
    if dropped:
        logger.debug("Dropped %d inconsistent <when> in %s", dropped, source)

    path: FlightPath = []
    path_whens: list[str] = []
    for (lat, lon, alt, when), ts, kept in zip(points, timestamps, keep, strict=True):
        point = TrackPoint(lat, lon, alt, ts if kept else None)
        coordinates.append(point)
        if alt is not None:
            path.append(point)
            if point.ts is not None:
                path_whens.append(when)

    return path, path_whens


def _parse_gx_coord(coord_text: str | None) -> tuple[float, float, float | None] | None:
    """The latitude, longitude and altitude of a <gx:coord>, unvalidated."""
    if not coord_text:
        return None
    parts = coord_text.split()
    if len(parts) < 2:
        return None
    try:
        lon = float(parts[0])
        lat = float(parts[1])
        alt = float(parts[2]) if len(parts) >= 3 else None
    except ValueError:
        logger.debug("Failed to parse gx:coord: %s", coord_text)
        return None
    return lat, lon, alt


def _flights(tracks: list[etree._Element]) -> list[list[etree._Element]]:
    """The tracks grouped into flights, in document order.

    A gx:Track on its own is a flight, and so are all tracks of one
    gx:MultiTrack together.
    """
    flights: dict[int, tuple[etree._Element, list[etree._Element]]] = {}
    for track in tracks:
        parent = track.getparent()
        # The owner is kept in the dictionary, so its id stays its own
        owner = (
            parent
            if parent is not None and local_name(parent.tag) == "MultiTrack"
            else track
        )
        flights.setdefault(id(owner), (owner, []))[1].append(track)
    return [members for _, members in flights.values()]


def process_gx_track(
    tracks: list[etree._Element],
    namespaces: dict[str, str],
    kml_file: str,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    path_metadata: list[PathMetadata],
    aircraft_info: AircraftInfo | None,
) -> None:
    """Process all gx:Track elements of a KML document.

    Every gx:Track is one path, except that the tracks of a gx:MultiTrack
    make one path together (see ``parse_gx_tracks``).
    """
    if not tracks:
        return

    filename = Path(kml_file).name
    metadata_cache: dict[int, PlacemarkMetadata] = {}

    for flight in _flights(tracks):
        placemark = _find_placemark(flight[0])
        if placemark is None:
            placemark_meta = empty_placemark_metadata()
        else:
            key = id(placemark)
            if key not in metadata_cache:
                metadata_cache[key] = extract_placemark_metadata(placemark, namespaces)
            placemark_meta = metadata_cache[key]

        path, whens = parse_gx_tracks(flight, kml_file, coordinates)
        # One point is no path, as for a LineString (see parser_standard);
        # it still counts for the heat
        if len(path) < 2:
            logger.debug("gx:Track without a usable path in %s", filename)
            continue

        track_meta = placemark_meta.copy()
        if whens:
            # The track's own timestamps are authoritative for its time span:
            # those of the path's points, not of the raw <when> list, whose
            # first entry may be unparsable or belong to a rejected coordinate.
            # The year is the one of the start, like that of a LineString with
            # a TimeSpan: the obfuscator moves a flight to January 1st of the
            # year it started in, so a flight across New Year stays in its
            # year after the obfuscation.
            track_meta["timestamp"] = whens[0]
            track_meta["end_timestamp"] = whens[-1] if len(whens) > 1 else None
            track_meta["year"] = extract_year_from_timestamp(whens[0])

        if track_meta["timestamp"] is None and track_meta["airport_name"]:
            logger.debug(
                "No timestamp found for gx:Track with name: %s",
                track_meta["airport_name"],
            )

        path_groups.append(path)
        path_metadata.append(
            build_path_metadata_dict(kml_file, path[0], track_meta, aircraft_info)
        )

    logger.debug("Parsed %d gx:Track element(s) in %s", len(tracks), filename)
