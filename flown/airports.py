"""Airport deduplication, name extraction and the altitude heuristics behind it.

Uses a spatial grid approach for O(1) proximity lookups: divides the map into
~2km grid cells and checks the cells within the merge distance for nearby
airports, avoiding O(n^2) pairwise distance checks. The grid wraps around the
antimeridian, so fields on either side of it are neighbors too.

An entry whose name holds an ICAO code only ever merges with entries of the
same code: EDTX and EDTY are 0.7 km apart and two airports all the same. Only
entries without a code merge by proximity, and with the entry of the same
name (see ``AirportDeduplicator``).

A name only becomes a marker when it holds an ICAO code or is an airport of
a route ("Home strip - Aunt farm"): the name of any other placemark is free
text ("Flight with Anna", "Untitled Path"), and its start gets no marker
(see ``_add_departures``).
"""

import math
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, NamedTuple

from .airport_lookup import (
    airport_icao_code,
    extract_icao_codes_from_name,
    lookup_airport_coordinates,
    lookup_airport_elevation,
    split_route_name,
)
from .constants import (
    AIRPORT_DISTANCE_THRESHOLD_KM,
    AIRPORT_GRID_SIZE_DEGREES,
    LANDING_FALLBACK_ALTITUDE_M,
    LANDING_MAX_ALTITUDE_M,
    LANDING_MAX_VARIATION_M,
    MID_FLIGHT_MAX_VARIATION_M,
    MID_FLIGHT_MIN_ALTITUDE_M,
    PATH_SAMPLE_MAX_SIZE,
    PATH_SAMPLE_MIN_SIZE,
)
from .date_tokens import strip_dates
from .geometry import KM_PER_DEGREE, haversine_distance
from .logger import logger

if TYPE_CHECKING:
    from .types import FlightPath, FlightPathGroup, PathMetadata

__all__ = [
    "POINT_MARKERS",
    "AirportData",
    "AirportDeduplicator",
    "AltitudeSample",
    "airport_elevation",
    "deduplicate_airports",
    "extract_airport_name",
    "is_mid_flight_start",
    "is_point_marker",
    "is_valid_landing",
    "reference_altitude",
    "route_airports",
    "sample_path_altitudes",
]

# Marker types to filter out
POINT_MARKERS = ["Log Start", "Log Stop", "Takeoff", "Landing"]
# SkyDemon writes "Landing: 03 Mar 2025 08:50 Z". Only the start of a name
# counts: dozens of airports have "Landing" in their name (CYNL, KNFE, ...).
_POINT_MARKER_PATTERN = re.compile(
    "(?:" + "|".join(map(re.escape, POINT_MARKERS)) + ")(?::|$)"
)


class AltitudeSample(NamedTuple):
    """The altitudes at one end of a path (see ``sample_path_altitudes``)."""

    min: float
    max: float
    variation: float


@dataclass(slots=True)
class AirportData:
    """An airport a path starts or ends at, as ``deduplicate_airports`` merges them.

    ``name`` is the placemark name the airport was first seen under (a route
    or a single airport), ``path_index`` and ``is_at_path_end`` where.
    """

    lat: float
    lon: float
    name: str | None
    path_index: int | None = None
    is_at_path_end: bool = False

    def prefer_name(self, name: str | None) -> None:
        """Take ``name`` over the one held when it says more.

        A route name wins over a point marker's, and anything over no name;
        otherwise the first name stays, so the marker reads the same however
        the entries were ordered.
        """
        current = self.name or ""
        if name and (
            not current or (is_point_marker(current) and not is_point_marker(name))
        ):
            self.name = name


def sample_path_altitudes(
    path: FlightPath, from_end: bool = False
) -> AltitudeSample | None:
    """Extract altitude statistics from a path sample."""
    if len(path) <= 10:
        return None

    sample_size = min(PATH_SAMPLE_MAX_SIZE, len(path) // 4)
    if sample_size <= PATH_SAMPLE_MIN_SIZE:
        return None

    sample = path[-sample_size:] if from_end else path[:sample_size]
    alts = [point.alt for point in sample if point.alt is not None]
    if not alts:
        return None
    return AltitudeSample(min(alts), max(alts), max(alts) - min(alts))


def airport_elevation(name: str | None, is_at_path_end: bool) -> float | None:
    """The field elevation in meters of the airport a name refers to.

    A route name refers to its departure or its arrival, selected by
    ``is_at_path_end``. None when the name holds no ICAO code or the
    database does not know the field or its elevation.
    """
    if not name:
        return None
    return lookup_airport_elevation(
        airport_icao_code(_airport_at(name, is_at_path_end))
    )


def reference_altitude(path: FlightPath, airport_elevation_m: float | None) -> float:
    """The ground altitude the start or end of a path is compared against.

    The altitudes of a track are above sea level, but whether a flat start
    is a taxi or a cruise depends on the height above the field: Munich lies
    at 453 m, Samedan at 1707 m. The elevation of the named airport is the
    reference when the database has it. Otherwise the lowest altitude of the
    path stands in for the ground, provided the path climbs or descends at
    all; a recording that is flat throughout never touched the ground, and
    sea level keeps its flat start from counting as a departure.
    """
    if airport_elevation_m is not None:
        return airport_elevation_m
    altitudes = [point.alt for point in path if point.alt is not None]
    if altitudes and max(altitudes) - min(altitudes) > MID_FLIGHT_MAX_VARIATION_M:
        return min(altitudes)
    return 0.0


def is_mid_flight_start(
    path: FlightPath, start_alt: float | None, reference_alt: float = 0.0
) -> bool:
    """Detect if a path started mid-flight by analyzing altitude patterns.

    ``reference_alt`` is the ground altitude the start is measured against
    (see ``reference_altitude``); the default is sea level.
    """
    if start_alt is None:
        return False

    sample = sample_path_altitudes(path, from_end=False)
    if not sample:
        return False

    # Mid-flight indicators:
    # - Starting well above the ground
    # - AND altitude variation in first part is small (not climbing/descending much)
    is_mid_flight = (
        start_alt - reference_alt > MID_FLIGHT_MIN_ALTITUDE_M
        and sample.variation < MID_FLIGHT_MAX_VARIATION_M
    )

    if is_mid_flight:
        logger.debug(
            "Detected mid-flight start at %.0fm (%.0fm above the reference, "
            "variation: %.0fm)",
            start_alt,
            start_alt - reference_alt,
            sample.variation,
        )

    return is_mid_flight


def is_valid_landing(
    path: FlightPath, end_alt: float | None, reference_alt: float = 0.0
) -> bool:
    """Check if a path ends with a valid landing.

    ``reference_alt`` is the ground altitude the end is measured against
    (see ``reference_altitude``); the default is sea level.
    """
    height = end_alt - reference_alt if end_alt is not None else None
    sample = sample_path_altitudes(path, from_end=True)
    if not sample:
        # Short path, just accept if the height seems reasonable
        return height is not None and height < LANDING_FALLBACK_ALTITUDE_M

    # Valid landing: either descending significantly OR stable at low variation
    # Also accept any endpoint if variation at end is small - indicates stable landing
    return sample.variation < LANDING_MAX_VARIATION_M or (
        height is not None and height < LANDING_MAX_ALTITUDE_M
    )


def is_point_marker(name: str | None) -> bool:
    """Check if a name represents a point marker (not a flight path)."""
    if not name:
        return True
    return _POINT_MARKER_PATTERN.match(name) is not None


def route_airports(metadata: PathMetadata) -> tuple[str | None, str | None]:
    """The departure and arrival airport of a path, both None for no route.

    The parser records both when it standardizes the name, because airport
    names may contain " - " and the display name cannot be split reliably.
    Only metadata built without those keys falls back to splitting it.
    """
    if "start_airport" in metadata or "end_airport" in metadata:
        return metadata.get("start_airport"), metadata.get("end_airport")
    route = split_route_name(metadata.get("airport_name"))
    return route if route is not None else (None, None)


def _airport_at(name: str, is_at_path_end: bool) -> str:
    """The departure or arrival of a route name; any other name as it is."""
    route = split_route_name(name)
    if route is None:
        return name
    return route[1] if is_at_path_end else route[0]


def extract_airport_name(full_name: str, is_at_path_end: bool = False) -> str | None:
    """Extract a clean airport name, or None when it is no airport.

    ``deduplicate_airports`` stores the name of one airport. A route name
    ("DEPARTURE - ARRIVAL") yields the airport selected by ``is_at_path_end``.
    Dates and times of day are taken out of the name (see
    ``date_tokens.strip_dates``).
    """
    if not full_name or full_name in ["Airport", "Unknown", ""]:
        return None

    # Check if it's a marker prefix that shouldn't have made it here
    if is_point_marker(full_name):
        return None

    # A free-text name may hold the date of the flight ("Sunday flight 16 Aug
    # 2026"), which the marker would publish
    airport_name = strip_dates(_airport_at(full_name, is_at_path_end))
    if airport_name is None:
        return None

    # Validate: must have ICAO code OR be multi-word name
    has_icao_code = bool(re.search(r"\b[A-Z]{4}\b", airport_name))
    is_single_word = len(airport_name.split()) == 1

    # Skip if it's "Unknown" or single-word without ICAO code
    if airport_name == "Unknown" or (not has_icao_code and is_single_word):
        return None

    return airport_name


class AirportDeduplicator:
    """Efficiently deduplicate airports using spatial grid indexing.

    An entry named with an ICAO code merges with the earlier entry of the
    same code, wherever that is, and with nothing else. An entry without a
    code merges with the earlier entry of the same name, wherever that is,
    or else with any entry within ``AIRPORT_DISTANCE_THRESHOLD_KM``: the
    page tells its airports apart by name, and two markers of one name
    would be one airport to it.
    ``deduplicate_airports`` adds the entries with a code first, so an
    entry without one joins the coded airport it belongs to rather than
    the other way round.
    """

    def __init__(self, grid_size: float = AIRPORT_GRID_SIZE_DEGREES):
        """Initialize the airport deduplicator."""
        self.grid_size = grid_size
        self.unique_airports: list[AirportData] = []
        self.spatial_grid: dict[tuple[int, int], list[int]] = {}
        self._by_code: dict[str, int] = {}
        # The airports without a code, by the name their marker shows
        self._by_name: dict[str, int] = {}
        # Longitude cells around the globe; the last one may be narrower
        self._lon_cell_count = math.ceil(360 / grid_size)

    def _get_grid_key(self, lat: float, lon: float) -> tuple[int, int]:
        """Get grid cell key for a coordinate.

        Longitude cells are counted from the antimeridian and wrap, so the
        cell east of the last one is the first.
        """
        lon_cell = math.floor((lon + 180) / self.grid_size) % self._lon_cell_count
        return (math.floor(lat / self.grid_size), lon_cell)

    def _search_cells(self, lat: float) -> tuple[int, int]:
        """How many cells around a point, per axis, can hold a nearby airport.

        A degree of longitude shrinks with the cosine of the latitude: at 51°N
        a 0.018° cell is only 1.26 km wide, less than the merge distance, so
        a single neighbor cell is not enough. The pole side of the search
        radius is the narrowest, so its width decides.
        """
        cell_km = self.grid_size * KM_PER_DEGREE
        lat_cells = math.ceil(AIRPORT_DISTANCE_THRESHOLD_KM / cell_km)
        edge_lat = min(90.0, abs(lat) + lat_cells * self.grid_size)
        lon_cell_km = cell_km * math.cos(math.radians(edge_lat))
        max_lon_cells = self._lon_cell_count
        if lon_cell_km * max_lon_cells <= AIRPORT_DISTANCE_THRESHOLD_KM:
            return lat_cells, max_lon_cells
        lon_cells = math.ceil(AIRPORT_DISTANCE_THRESHOLD_KM / lon_cell_km)
        return lat_cells, min(lon_cells, max_lon_cells)

    def _find_nearby_airport(self, lat: float, lon: float) -> int | None:
        """The nearest airport within the threshold, from the spatial grid.

        The nearest rather than the first found: two fields can lie closer
        to each other than the threshold, and an end at one of them belongs
        to that one.
        """
        grid_key = self._get_grid_key(lat, lon)
        lat_cells, lon_cells = self._search_cells(lat)
        # Wrapped around the antimeridian; near a pole the search can cover
        # every cell of a row, which must not be visited twice
        lon_keys = dict.fromkeys(
            (grid_key[1] + dlon) % self._lon_cell_count
            for dlon in range(-lon_cells, lon_cells + 1)
        )
        nearest: int | None = None
        nearest_km = AIRPORT_DISTANCE_THRESHOLD_KM
        for dlat in range(-lat_cells, lat_cells + 1):
            for lon_key in lon_keys:
                neighbor_key = (grid_key[0] + dlat, lon_key)
                for apt_idx in self.spatial_grid.get(neighbor_key, ()):
                    airport = self.unique_airports[apt_idx]
                    dist = haversine_distance(lat, lon, airport.lat, airport.lon)
                    if dist < nearest_km:
                        nearest, nearest_km = apt_idx, dist
        return nearest

    def _add_to_grid(self, lat: float, lon: float, airport_idx: int) -> None:
        """Add airport to spatial grid."""
        grid_key = self._get_grid_key(lat, lon)
        self.spatial_grid.setdefault(grid_key, []).append(airport_idx)

    def add_or_update_airport(
        self,
        lat: float,
        lon: float,
        name: str | None,
        path_index: int,
        is_at_path_end: bool,
    ) -> int:
        """Add new airport or update existing one.

        An entry with an ICAO code merges with the entry of the same code
        and never by proximity; see the class documentation.
        """
        corrected_lat = lat
        corrected_lon = lon
        icao_code = (
            airport_icao_code(_airport_at(name, is_at_path_end)) if name else None
        )

        if icao_code:
            # Two fields with different codes are two airports however close
            # they are (EDTX and EDTY are 0.7 km apart)
            apt_idx = self._by_code.get(icao_code)
            # The OurAirports coordinates put every reference to the code at
            # the same spot
            coords = lookup_airport_coordinates(icao_code) if apt_idx is None else None
            if coords:
                corrected_lat, corrected_lon, _ = coords
                logger.debug(
                    "Using OurAirports coordinates for %s: "
                    "(%.6f, %.6f) instead of KML (%.6f, %.6f)",
                    icao_code,
                    corrected_lat,
                    corrected_lon,
                    lat,
                    lon,
                )
            marker_name = None
        else:
            marker_name = extract_airport_name(name, is_at_path_end) if name else None
            apt_idx = self._by_name.get(marker_name) if marker_name else None
            if apt_idx is None:
                apt_idx = self._find_nearby_airport(corrected_lat, corrected_lon)

        if apt_idx is not None:
            self.unique_airports[apt_idx].prefer_name(name)
            return apt_idx

        new_idx = len(self.unique_airports)
        self.unique_airports.append(
            AirportData(corrected_lat, corrected_lon, name, path_index, is_at_path_end)
        )
        self._add_to_grid(corrected_lat, corrected_lon, new_idx)
        if icao_code:
            self._by_code[icao_code] = new_idx
        elif marker_name:
            self._by_name[marker_name] = new_idx
        return new_idx

    def get_unique_airports(self) -> list[AirportData]:
        """Get the list of deduplicated airports."""
        return self.unique_airports


class _Entry(NamedTuple):
    """One airport a path starts or ends at, before deduplication."""

    lat: float
    lon: float
    name: str
    path_index: int
    is_at_path_end: bool


def _add_departures(
    entries: list[_Entry],
    all_path_metadata: list[PathMetadata],
    all_path_groups: FlightPathGroup,
) -> None:
    """Register the start point every path reported in its metadata.

    The parsers build the metadata start point from the path's first point,
    so this pass covers the departure of every path, including the ones whose
    name is a single airport rather than a route. The altitude comes from the
    metadata's ``start_point`` and defaults to 0 when the point carries none.
    A route registers its departure airport under that airport's own name,
    the name the path info of the export refers to.

    A path with fewer than two points is no flight: a lone waypoint or a
    stationary recording gets no entry in the export either, and its airport
    would tell where it was.

    A name that is no route and holds no ICAO code registers nothing: it is
    free text ("Flight with Anna"), which a marker would publish, and the
    page names its airports, so a neutral name of many places would make
    them one airport to it.
    """
    for idx, metadata in enumerate(all_path_metadata):
        start_point = metadata["start_point"]
        start_lat, start_lon = start_point[0], start_point[1]
        start_alt = start_point[2] if len(start_point) > 2 else 0.0
        airport_name = metadata.get("airport_name", "")

        # Skip point markers - they don't contain airport info
        if is_point_marker(airport_name):
            logger.debug("Skipping point marker '%s'", airport_name)
            continue

        path = all_path_groups[idx] if idx < len(all_path_groups) else []
        if len(path) < 2:
            logger.debug("Skipping the start of '%s': no flight path", airport_name)
            continue

        start_airport, _ = route_airports(metadata)
        if start_airport is None and not extract_icao_codes_from_name(
            strip_dates(airport_name)
        ):
            logger.debug("Skipping the start of '%s': no airport name", airport_name)
            continue

        # Skip mid-flight starts
        name = start_airport or airport_name
        reference = reference_altitude(path, airport_elevation(name, False))
        if is_mid_flight_start(path, start_alt, reference):
            logger.debug("Skipping mid-flight start '%s'", airport_name)
            continue

        entries.append(_Entry(start_lat, start_lon, name, idx, False))


def _add_arrivals(
    entries: list[_Entry],
    all_path_metadata: list[PathMetadata],
    all_path_groups: FlightPathGroup,
) -> None:
    """Register the end point of every path whose name is a route.

    Only routes ("DEPARTURE - ARRIVAL") reach this pass, because only they say
    which airport the end belongs to. The arrival is only registered when the
    path actually ends in a landing, under the arrival airport's own name.
    """
    for idx, path in enumerate(all_path_groups):
        if len(path) <= 1 or idx >= len(all_path_metadata):
            continue

        end = path[-1]
        metadata = all_path_metadata[idx]
        route_name = metadata.get("airport_name", "")
        _, end_airport = route_airports(metadata)

        # Skip if not a proper route name
        if is_point_marker(route_name) or not end_airport:
            continue

        reference = reference_altitude(path, airport_elevation(end_airport, True))
        if is_valid_landing(path, end.alt, reference):
            entries.append(_Entry(end.lat, end.lon, end_airport, idx, True))
            logger.debug(
                "Processed arrival airport for '%s' at %sm altitude",
                route_name,
                end.alt,
            )


def deduplicate_airports(
    all_path_metadata: list[PathMetadata],
    all_path_groups: FlightPathGroup,
) -> list[AirportData]:
    """Deduplicate airports by location using spatial grid indexing.

    Two passes collect the entries: the start point of every path, then the
    end point of the paths whose name is a route. Entries of the same ICAO
    code merge, and an entry without a code merges with any airport within
    ``AIRPORT_DISTANCE_THRESHOLD_KM``. The entries with a code are added
    first, so an entry without one joins the coded airport next to it
    whichever came first in the input; the airports are then returned in
    the order the input first mentions them.
    """
    entries: list[_Entry] = []
    _add_departures(entries, all_path_metadata, all_path_groups)
    _add_arrivals(entries, all_path_metadata, all_path_groups)

    def has_code(entry: _Entry) -> bool:
        return (
            airport_icao_code(_airport_at(entry.name, entry.is_at_path_end)) is not None
        )

    deduplicator = AirportDeduplicator()
    first_mention: dict[int, int] = {}
    for order in sorted(range(len(entries)), key=lambda i: not has_code(entries[i])):
        apt_idx = deduplicator.add_or_update_airport(*entries[order])
        first_mention[apt_idx] = min(first_mention.get(apt_idx, order), order)
    airports = deduplicator.get_unique_airports()
    return [airports[i] for i in sorted(first_mention, key=first_mention.__getitem__)]
