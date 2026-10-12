"""Standard KML <coordinates> processing."""

import re
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING

from .geometry import haversine_distance
from .helpers import parse_timestamp_epoch
from .logger import logger
from .parser_common import (
    build_path_metadata_dict,
    empty_placemark_metadata,
    parse_coordinate_point,
)
from .types import TrackPoint

if TYPE_CHECKING:
    from collections.abc import Collection

    from lxml import etree

    from .aircraft import AircraftInfo
    from .types import FlightPath, FlightPathGroup, PathMetadata, PlacemarkMetadata

_SPACE_AFTER_COMMA = re.compile(r",\s+")
# A line of the same name that starts this close to where the one before it
# ended continues it: a logger that splits its track writes the point of the
# split twice
JOIN_DISTANCE_KM = 0.05
# ... unless its time begins this long after the end of the one before
JOIN_MAX_GAP_SECONDS = 30 * 60
# A line whose last point is this close above its lowest one (metres), after
# it was this much higher (metres), came down to land; so did one whose last
# GROUND_FIXES points stand within GROUND_SPREAD_KM of each other: at a
# standstill, or rolling slower than any aircraft flies
GROUND_MARGIN_M = 30.0
GROUND_CLIMB_M = 150.0
GROUND_FIXES = 3
GROUND_SPREAD_KM = 0.015


def process_standard_coordinates(
    coord_elements: list[etree._Element],
    coord_to_metadata: dict[int, PlacemarkMetadata],
    kml_file: str,
    coordinates: FlightPath,
    path_groups: FlightPathGroup,
    path_metadata: list[PathMetadata],
    aircraft_info: AircraftInfo | None,
    unknown_altitude: Collection[int] = frozenset(),
) -> None:
    """Process standard KML <coordinates> elements.

    A flight path needs at least two points: a lone ``<Point>`` (a waypoint,
    a home field) is kept in ``coordinates`` but is no path, so it neither
    gets exported nor registers an airport. Consecutive lines that are one
    flight in pieces become one path (see ``_join_split_lines``).

    ``unknown_altitude`` holds the ids of the elements whose altitudes are to
    be ignored (the caller has said why); they form no path either.
    """
    lines_without_altitude = 0
    # Once per file: parse_coordinate_point runs once per coordinate
    filename = Path(kml_file).name
    first_path = len(path_groups)

    for idx, coord_elem in enumerate(coord_elements):
        if coord_elem.text is None:
            logger.debug("Coordinate element %d has None text, skipping", idx)
            continue

        coord_text = coord_elem.text.strip()
        if not coord_text:
            logger.debug("Coordinate element %d has empty text, skipping", idx)
            continue

        metadata = coord_to_metadata.get(id(coord_elem), empty_placemark_metadata())

        # Tuples are separated by whitespace and their values by commas.
        # Google Earth also accepts a space after the comma ("8.5, 50.0, 300"),
        # which the split below would tear apart.
        if _SPACE_AFTER_COMMA.search(coord_text):
            coord_text = _SPACE_AFTER_COMMA.sub(",", coord_text)

        current_path: FlightPath = []
        element_coords = 0
        altitude_known = id(coord_elem) not in unknown_altitude

        for point_text in coord_text.split():
            parsed = parse_coordinate_point(point_text, filename)
            if parsed is None:
                continue

            lat, lon, alt = parsed
            if not altitude_known:
                alt = None
            point = TrackPoint(lat, lon, alt, None)
            coordinates.append(point)

            # Only points with a known altitude form the flight path
            if alt is not None:
                current_path.append(point)

            element_coords += 1

        if len(current_path) > 1:
            path_groups.append(current_path)
            path_metadata.append(
                build_path_metadata_dict(
                    kml_file, current_path[0], metadata, aircraft_info
                )
            )
        elif element_coords > 1 and altitude_known:
            lines_without_altitude += 1

        if element_coords > 0:
            coord_type = (
                "Point" if element_coords == 1 else f"Path ({element_coords} points)"
            )
            logger.debug("Element %d: %s", idx, coord_type)

    joined_paths, joined_metadata = _join_split_lines(
        path_groups[first_path:], path_metadata[first_path:]
    )
    path_groups[first_path:] = joined_paths
    path_metadata[first_path:] = joined_metadata
    _share_time_spans(path_groups[first_path:], path_metadata[first_path:])

    if lines_without_altitude:
        # Only the file's point count would show it otherwise, and that is
        # not zero, so the missing flight would go unnoticed
        logger.warning(
            "%s: %d line(s) without usable altitudes were ignored",
            filename,
            lines_without_altitude,
        )


def _ends_on_ground(path: FlightPath) -> bool:
    """Whether a line ends on the ground: the flight it holds has landed.

    A line has no speeds, so the ground is told by the altitudes and the
    spacing of its points: it came back down to the lowest point of a line
    that had climbed well above it, or its last points stand still. A track
    split in flight ends at the height it was flying at, and moving.
    """
    altitudes = [point.alt for point in path if point.alt is not None]
    if altitudes:
        last, lowest = altitudes[-1], min(altitudes)
        if last - lowest <= GROUND_MARGIN_M and max(altitudes) - last >= GROUND_CLIMB_M:
            return True
    if len(path) < GROUND_FIXES:
        return False
    end = path[-1]
    return all(
        haversine_distance(end.lat, end.lon, point.lat, point.lon) <= GROUND_SPREAD_KM
        for point in path[-GROUND_FIXES:-1]
    )


def _continues(
    before: FlightPath,
    before_meta: PathMetadata,
    after: FlightPath,
    after_meta: PathMetadata,
) -> bool:
    """Whether a line continues the one before it, as one flight.

    Both have the same name, the one before has not landed (see
    ``_ends_on_ground``), and the line starts where the one before ended:
    with the same time span, or a time that follows on from it, within
    ``JOIN_DISTANCE_KM``. Two flights of one name from the same parking spot
    are told apart by their times: the second begins well after the first
    ended. Without times to go by, or without a name that says both lines
    are one, only the point of the split written twice joins them: two
    untimed flights of an aircraft named after its registration may well
    start near where the one before ended.
    """
    name = before_meta.get("airport_name")
    if name != after_meta.get("airport_name") or _ends_on_ground(before):
        return False
    end, start = before[-1], after[0]
    if haversine_distance(end.lat, end.lon, start.lat, start.lon) > JOIN_DISTANCE_KM:
        return False
    repeated = (end.lat, end.lon, end.alt) == (start.lat, start.lon, start.alt)
    span = (before_meta.get("timestamp"), before_meta.get("end_timestamp"))
    after_span = (after_meta.get("timestamp"), after_meta.get("end_timestamp"))
    if span[0] and span == after_span:
        return bool(name) or repeated
    before_end = parse_timestamp_epoch(span[1] or span[0])
    after_begin = parse_timestamp_epoch(after_span[0])
    begin = parse_timestamp_epoch(span[0])
    if before_end is None or after_begin is None or begin is None:
        return repeated
    return (
        (bool(name) or repeated)
        and begin <= after_begin
        and after_begin - before_end <= JOIN_MAX_GAP_SECONDS
    )


def _join_split_lines(
    paths: FlightPathGroup, metadata: list[PathMetadata]
) -> tuple[FlightPathGroup, list[PathMetadata]]:
    """Join the lines that are one flight split in pieces, in document order.

    Some loggers and exporters write a long track as several LineStrings,
    one after the other, each starting where the one before ended. Taken
    for flights of their own, every piece had a departure (and for a route
    name an arrival) at a point of the flight where nobody landed. A line
    that continues the one before (see ``_continues``) is appended to it,
    without the point they share; the flight ends when the last piece does.
    """
    joined_paths: FlightPathGroup = []
    joined_metadata: list[PathMetadata] = []
    for path, meta in zip(paths, metadata, strict=True):
        if joined_paths and _continues(
            joined_paths[-1], joined_metadata[-1], path, meta
        ):
            last = joined_paths[-1]
            shared = (last[-1].lat, last[-1].lon) == (path[0].lat, path[0].lon)
            last.extend(path[1:] if shared else path)
            previous = joined_metadata[-1]
            if (meta.get("timestamp"), meta.get("end_timestamp")) != (
                previous.get("timestamp"),
                previous.get("end_timestamp"),
            ):
                previous["end_timestamp"] = (
                    meta.get("end_timestamp")
                    or meta.get("timestamp")
                    or previous.get("end_timestamp")
                )
            continue
        joined_paths.append(list(path))
        joined_metadata.append(meta)
    if len(joined_paths) < len(paths):
        logger.debug(
            "Joined %d line(s) that continue the one before",
            len(paths) - len(joined_paths),
        )
    return joined_paths, joined_metadata


def _path_distance_km(path: FlightPath) -> float:
    return sum(
        haversine_distance(p1.lat, p1.lon, p2.lat, p2.lon) for p1, p2 in pairwise(path)
    )


def _share_time_spans(paths: FlightPathGroup, metadata: list[PathMetadata]) -> None:
    """Split a time span that several lines have between them.

    A TimeSpan of a MultiGeometry, or one the lines inherit from their Folder
    or Document, is the time of all of them together, not of each one: taken
    for each line, it made every one of them as slow as all of them. The
    lines of a file with the same begin and end share it, each by its part
    of their distance (``span_share``, see ``export_pipeline.path_duration``).
    That gives every line the average speed of all of them, the best guess
    without the times of the lines themselves; their order in time is not
    known, so no line gets a begin or end of its own.
    """
    sharing: dict[tuple[str, str], list[int]] = {}
    for index, meta in enumerate(metadata):
        begin, end = meta.get("timestamp"), meta.get("end_timestamp")
        if begin and end:
            sharing.setdefault((begin, end), []).append(index)
    for indices in sharing.values():
        if len(indices) < 2:
            continue
        distances = [_path_distance_km(paths[index]) for index in indices]
        total = sum(distances)
        for index, distance in zip(indices, distances, strict=True):
            metadata[index]["span_share"] = (
                distance / total if total > 0 else 1 / len(indices)
            )
