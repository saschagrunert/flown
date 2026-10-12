"""Per-path export helpers: path info entries and segment rows."""

from functools import lru_cache
from itertools import pairwise
from typing import TYPE_CHECKING

from .airport_lookup import airport_icao_code
from .airports import extract_airport_name, route_airports
from .constants import ALTITUDE_GAIN_HYSTERESIS_FT, METERS_TO_FEET
from .date_tokens import strip_dates
from .helpers import calculate_duration_seconds
from .logger import logger
from .segment_calculator import (
    SegmentSpeed,
    SpeedWindow,
    calculate_fallback_groundspeed,
    extract_segment_speeds,
    outlasts_the_window,
)
from .segment_codec import ALTITUDE_STEP
from .types import COORDINATE_DECIMALS

if TYPE_CHECKING:
    from collections.abc import Sequence

    from .landings import FlightLandings
    from .types import FlightPath, PathInfo, PathMetadata, SegmentRow


def path_duration(metadata: PathMetadata) -> float:
    """The duration of a path in seconds, from the metadata timestamps.

    0 when the metadata carries no usable start and end timestamp. A path
    that shares its time span with others gets its ``span_share`` of it.
    """
    path_duration_seconds = 0.0
    start_ts = metadata.get("timestamp")
    end_ts = metadata.get("end_timestamp")

    if start_ts and end_ts:
        path_duration_seconds = calculate_duration_seconds(start_ts, end_ts)
        if path_duration_seconds == 0:
            logger.debug("  Could not parse timestamps '%s' -> '%s'", start_ts, end_ts)

    return path_duration_seconds * metadata.get("span_share", 1.0)


def altitude_gain_m(altitudes_m: Sequence[float]) -> float:
    """The total climb of a path in meters, without the jitter.

    Follows the lowest point (the trough) until the altitude rises
    ``ALTITUDE_GAIN_HYSTERESIS_FT`` above it, then the highest point (the
    peak) until the altitude falls as far below it. Each climb from a trough
    to its peak counts once; rises and dips smaller than the hysteresis
    count for nothing.
    """
    if not altitudes_m:
        return 0.0
    hysteresis_m = ALTITUDE_GAIN_HYSTERESIS_FT / METERS_TO_FEET
    gain = 0.0
    trough = peak = altitudes_m[0]
    climbing = False
    for altitude in altitudes_m[1:]:
        if climbing:
            if altitude > peak:
                peak = altitude
            elif peak - altitude >= hysteresis_m:
                gain += peak - trough
                climbing = False
                trough = altitude
        elif altitude < trough:
            trough = altitude
        elif altitude - trough >= hysteresis_m:
            climbing = True
            peak = altitude
    if climbing:
        gain += peak - trough
    return gain


@lru_cache(maxsize=4)
def _markers_by_code(airport_names: frozenset[str]) -> dict[str, str]:
    """The name of the marker of every ICAO code among ``airport_names``."""
    markers: dict[str, str] = {}
    for name in sorted(airport_names):
        code = airport_icao_code(name)
        if code:
            markers.setdefault(code, name)
    return markers


def _marker_name(name: str | None, airport_names: frozenset[str]) -> str | None:
    """The marker of an end of a path, None when it has none.

    ``airports.deduplicate_airports`` merges the names of one ICAO code into
    one marker under the first name ("EDZZ local flight"), and the end of
    another flight ("EDZZ" of "EDZZ - EDDF") is that marker as well.
    """
    if name is None or name in airport_names:
        return name
    code = airport_icao_code(name)
    return _markers_by_code(airport_names).get(code) if code else None


def build_path_info(
    path: FlightPath,
    metadata: PathMetadata,
    path_id: int,
    year: int,
    airport_names: frozenset[str] | None = None,
    landings: FlightLandings | None = None,
) -> PathInfo:
    """Build the path info entry of an exported path.

    Keys without a value are omitted from the entry. ``landings`` are what
    ``landings.detect_landings`` found for the path, None for a path it
    could not read (no timestamps, no airport database).

    ``airport_names`` are the names of the exported airport markers. An end
    of a path counts as an airport if and only if it has a marker: the
    frontend counts the airports of the path info in its statistics and
    shows the markers of the names it finds there, so a name without a
    marker ("Home", "Aunt Martha" when the path never landed there) would
    count as an airport nobody can see. The marker rules are those of
    ``airports.deduplicate_airports`` and ``airports.extract_airport_name``:
    a name holding an ICAO code, or an airport of a route of more than one
    word, at a real start or landing; a name with the ICAO code of a marker
    is that marker. A name that is no route ("EDDS" for a local flight) is
    the start of the path when it is one of the markers,
    since ``airports.deduplicate_airports`` puts the start of every path on
    the map under its name. None keeps every route name (for callers
    without airports) and no other.
    """
    # The names match the airport markers of airports.json exactly, which
    # have their dates taken out the same way
    start_airport, end_airport = (
        strip_dates(name) for name in route_airports(metadata)
    )
    if airport_names is not None:
        if start_airport is None and end_airport is None:
            # The marker of a single airport, named as export_writers names
            # it (route_airports found no route in the name)
            start_airport = extract_airport_name(metadata.get("airport_name", ""))
        start_airport = _marker_name(start_airport, airport_names)
        end_airport = _marker_name(end_airport, airport_names)

    info: PathInfo = {"id": path_id, "year": year}

    # Segment altitudes are rounded to ALTITUDE_STEP for rendering, so the
    # exact range and climb are carried per path to keep the frontend
    # statistics accurate
    altitudes_m = [point.alt for point in path if point.alt is not None]
    if altitudes_m:
        info["min_altitude_ft"] = round(min(altitudes_m) * METERS_TO_FEET, 1)
        info["max_altitude_ft"] = round(max(altitudes_m) * METERS_TO_FEET, 1)
        info["altitude_gain_ft"] = round(
            altitude_gain_m(altitudes_m) * METERS_TO_FEET, 1
        )
    if start_airport:
        info["start_airport"] = start_airport
    if end_airport:
        info["end_airport"] = end_airport

    registration = metadata.get("aircraft_registration")
    if registration:
        info["aircraft_registration"] = registration
    # The type is a part of the file name, which may be a date, as in
    # 1_DEHYL_2026-08-16.kml
    aircraft_type = strip_dates(metadata.get("aircraft_type"))
    if aircraft_type:
        info["aircraft_type"] = aircraft_type

    if landings is not None:
        info["landings"] = landings.landings
        info["touch_and_goes"] = landings.touch_and_goes
        info["go_arounds"] = landings.go_arounds
        info["touchdowns"] = list(landings.touchdowns)

    return info


def _segment_groundspeed(
    segment: SegmentSpeed,
    window: SpeedWindow,
    path_distance_km: float,
    path_duration_seconds: float,
) -> float | None:
    """The groundspeed of a single segment in knots, None when unknown.

    The rolling window average where the segment is timed. A segment longer
    than the window is not in it (see ``outlasts_the_window``): where the
    window around its start is empty, as with a logger that writes a fix
    every few minutes, it has its own speed. The path's average speed
    otherwise.
    """
    if segment.timestamp is not None:
        groundspeed_knots = window.groundspeed(segment.timestamp)
        if groundspeed_knots is not None:
            return groundspeed_knots
    if segment.speed is not None and outlasts_the_window(segment):
        return segment.speed
    return calculate_fallback_groundspeed(
        segment.distance, path_distance_km, path_duration_seconds
    )


def exported_knots(groundspeed_knots: float | None) -> float:
    """A groundspeed as the year file carries it: in whole knots.

    A tenth of a knot shows nowhere on the page, and whole knots repeat far
    more from row to row, which gzip turns into a year file an eighth
    smaller. 0 is "no speed" (see ``process_path_segments``), so a speed
    that is known and positive stays at least 1 kt: rounded to 0, a taxi at
    walking pace would become unknown and end the taxiing that
    ``terrain.ground_profile_ft`` and the page anchor the ground on.
    """
    if groundspeed_knots is None or groundspeed_knots <= 0:
        return 0.0
    return float(max(1, round(groundspeed_knots)))


def process_path_segments(
    path: FlightPath,
    path_duration_seconds: float,
) -> tuple[list[float], list[SegmentRow]]:
    """Build the exported segment rows of a path.

    Coordinates are rounded to ``COORDINATE_DECIMALS`` (~1 m), and only the
    segments that are zero-length at that precision are skipped: standing
    still, including GPS jitter below the precision. Because their two
    exported endpoints are the same coordinate, dropping them keeps the
    remaining rows geometrically contiguous: every row continues where the
    previous one ended. Each row therefore stores only its END point, and the
    start of the first row is returned separately.

    The groundspeeds use the unrounded geometry, which is about the aircraft
    rather than about the export, and are exported in whole knots (see
    ``exported_knots``). A groundspeed that is unknown (no timing, or only
    implausible values) is exported as 0, which the frontend reads as "no
    speed" rather than as standing still. Times stay at a tenth of a second:
    loggers write fixes a fraction of a second apart as often as whole ones,
    and the replay moves the airplane by them. A row's time is when its
    segment starts, while its point is where it ends: the frontend's flight
    clock reads them so (see ``types.SegmentRow``).

    Returns:
        Tuple of (start point, segment rows). The start point is empty when
        the path has no exported rows.
    """
    path_start_time = next((point.ts for point in path if point.ts is not None), None)

    segment_speeds = extract_segment_speeds(path, path_start_time)
    window = SpeedWindow(segment_speeds)
    path_distance_km = sum(segment.distance for segment in segment_speeds)

    start: list[float] = []
    rows: list[SegmentRow] = []
    altitude_ft: float = 0.0
    # The rounded start of the current segment, which is also the end of the
    # last exported row: a skipped segment starts and ends on it
    previous: tuple[float, float] | None = None

    for segment, (p1, p2) in zip(segment_speeds, pairwise(path), strict=True):
        if previous is None:
            previous = (
                round(p1.lat, COORDINATE_DECIMALS),
                round(p1.lon, COORDINATE_DECIMALS),
            )
        end = (
            round(p2.lat, COORDINATE_DECIMALS),
            round(p2.lon, COORDINATE_DECIMALS),
        )
        if end == previous:
            continue

        # Flight paths only carry points with a known altitude (see
        # types.FlightPath). Were both missing, the row would keep the
        # altitude of the one before rather than be skipped: a skipped row
        # would break the end-to-start chain the row format relies on.
        altitudes = [alt for alt in (p1.alt, p2.alt) if alt is not None]
        if altitudes:
            avg_alt_m = sum(altitudes) / len(altitudes)
            altitude_ft = (
                round(avg_alt_m * METERS_TO_FEET / ALTITUDE_STEP) * ALTITUDE_STEP
            )

        groundspeed_knots = _segment_groundspeed(
            segment, window, path_distance_km, path_duration_seconds
        )

        if not rows:
            start = [previous[0], previous[1]]

        row: SegmentRow = [
            end[0],
            end[1],
            altitude_ft,
            exported_knots(groundspeed_knots),
        ]
        if segment.relative_time is not None:
            row.append(round(segment.relative_time, 1))

        rows.append(row)
        previous = end

    return start, rows
