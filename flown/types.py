"""Type definitions for Flown."""

from typing import NamedTuple, NotRequired, TypedDict


class TrackPoint(NamedTuple):
    """A single parsed track point.

    ``alt`` is the altitude in meters (``None`` when the source had no usable
    altitude) and ``ts`` is the point's timestamp as Unix epoch seconds in UTC
    (``None`` when unavailable).

    Flight paths (the ``FlightPath`` entries of a ``FlightPathGroup``) only
    contain points with a known altitude. The flat ``coordinates`` list
    returned by the parser may also contain points without one.
    """

    lat: float
    lon: float
    alt: float | None = None
    ts: float | None = None


FlightPath = list[TrackPoint]

FlightPathGroup = list[FlightPath]

# Exported segment row: [lat, lon, altitude_ft, groundspeed_knots] followed by
# an optional relative time in seconds (omitted when unavailable). ``lat``/``lon``
# are the segment's END point; its start is the end of the previous row, and
# the first row continues from the start point of the path (see
# ``export_pipeline.process_path_segments``). The time, unlike the point, is
# when the segment STARTS: the frontend's flight clock reads it so
# (calculations/flightClock.ts).
SegmentRow = list[float]

# Number of decimals kept for exported coordinates (~1 m at the equator)
COORDINATE_DECIMALS = 5


class PlacemarkMetadata(TypedDict):
    """Metadata extracted from a KML Placemark element.

    ``airport_name`` is the display name; for a route ``start_airport`` and
    ``end_airport`` hold its two airports (both None otherwise).
    """

    airport_name: str | None
    start_airport: str | None
    end_airport: str | None
    timestamp: str | None
    end_timestamp: str | None
    year: int | None


class PathMetadata(TypedDict):
    """Metadata for a flight path.

    The parser always sets ``start_airport`` and ``end_airport``: the two
    airports of a route, or None when the name is not one. Metadata without
    these keys only comes from code that builds it by hand.
    """

    start_point: list[float]
    airport_name: str
    year: NotRequired[int | None]
    aircraft_registration: NotRequired[str | None]
    aircraft_type: NotRequired[str | None]
    start_airport: NotRequired[str | None]
    end_airport: NotRequired[str | None]
    timestamp: NotRequired[str | None]
    end_timestamp: NotRequired[str | None]
    # The part of the time from timestamp to end_timestamp that is this
    # path's, when several paths share one TimeSpan (1 when absent)
    span_share: NotRequired[float]
    filename: NotRequired[str | None]
    # The input file as the run was given it, folders and all, which the
    # file name alone is not: two folders may hold files of one name. Set
    # by the run (pipeline), never cached or exported.
    source: NotRequired[str]


class PathInfo(TypedDict):
    """Information about a complete flight path (keys with no value are omitted)."""

    id: int
    year: NotRequired[int]
    aircraft_registration: NotRequired[str]
    aircraft_type: NotRequired[str]
    start_airport: NotRequired[str]
    end_airport: NotRequired[str]
    min_altitude_ft: NotRequired[float]
    max_altitude_ft: NotRequired[float]
    altitude_gain_ft: NotRequired[float]
    # What the flight did at the fields it came to (see flown.landings),
    # written together for a flight with timestamps. A touchdown is the
    # ICAO code of its field and the runway, None where it cannot be told
    landings: NotRequired[int]
    touch_and_goes: NotRequired[int]
    go_arounds: NotRequired[int]
    touchdowns: NotRequired[list[tuple[str, str | None]]]


class YearFileHeader(TypedDict):
    """The keys of a year file (<year>/data.json) before its paths.

    ``path_info`` (a list of ``PathInfo``) and ``segments`` follow them; the
    exporter streams those from the chunk fragments.
    """

    format: int
    year: int
    original_points: int


class SiteMetadata(TypedDict):
    """metadata.json: what the frontend needs before it loads a year."""

    min_groundspeed_knots: float
    max_groundspeed_knots: float
    available_years: list[int]
    year_file_bytes: dict[str, int]
    aircraft_models: dict[str, str]
    available_flags: list[str]


class AirportMarker(TypedDict):
    """An airport of airports.json."""

    lat: float
    lon: float
    name: str
    # The ICAO code of the name (airport_lookup.airport_icao_code)
    code: NotRequired[str]
    country: NotRequired[str]


__all__ = [
    "COORDINATE_DECIMALS",
    "AirportMarker",
    "FlightPath",
    "FlightPathGroup",
    "PathInfo",
    "PathMetadata",
    "PlacemarkMetadata",
    "SegmentRow",
    "SiteMetadata",
    "TrackPoint",
    "YearFileHeader",
]
