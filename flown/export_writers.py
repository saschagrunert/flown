"""Airport and metadata export writers."""

import math
from pathlib import Path
from typing import TYPE_CHECKING

from .airport_lookup import (
    airport_icao_code,
    database_airport_name,
    load_airport_database,
    lookup_airport_country,
)
from .airports import extract_airport_name
from .cache import atomic_data_write
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Mapping, Sequence

    from .airports import AirportData
    from .types import AirportMarker, SiteMetadata

__all__ = [
    "export_airports_data",
    "export_metadata",
    "exported_airport_names",
    "exported_country_codes",
    "free_text_airport_names",
]


def _exported_airports(
    unique_airports: list[AirportData],
) -> list[tuple[AirportData, str]]:
    """Pair every airport that has a displayable name with that name.

    Nearby airports were already merged by ``airports.deduplicate_airports``,
    so no further deduplication happens here.
    """
    exported = []
    for apt in unique_airports:
        full_name = apt.name or "Unknown"
        airport_name = extract_airport_name(full_name, apt.is_at_path_end)
        if airport_name:
            exported.append((apt, airport_name))
    return exported


def exported_airport_names(unique_airports: list[AirportData]) -> frozenset[str]:
    """The names of the airport markers ``export_airports_data`` writes."""
    return frozenset(name for _, name in _exported_airports(unique_airports))


def _is_database_name(name: str) -> bool:
    """Whether a name is the one the airport database gives its code."""
    icao_code = airport_icao_code(name)
    return icao_code is not None and database_airport_name(icao_code) == name


def free_text_airport_names(unique_airports: list[AirportData]) -> list[str]:
    """The exported airport names that are no airport database name, sorted.

    Only a route name gives them ("Home strip - Aunt farm"): both its sides
    are published as written, so a route between two people ("Anna - Bob")
    would publish their names as airports. The parser names every airport it
    finds in the database by its code and the database's name ("EDDS
    Stuttgart"), so any other name holds text of its own: "ANNA Mueller" has
    the shape of a code but is no airport, and "Anna EDDS EDDF" holds codes
    but was published as written. The build and ``--list`` name them, so
    they can be renamed. Without an airport database no name can be told
    apart, so none is listed and one warning says so.
    """
    if not load_airport_database():
        logger.warning(
            "Cannot check the published airport names for free text: the "
            "airport database is empty"
        )
        return []
    return sorted(
        name
        for name in exported_airport_names(unique_airports)
        if not _is_database_name(name)
    )


def exported_country_codes(unique_airports: list[AirportData]) -> list[str]:
    """The countries the exported airports are in, as ISO codes.

    The same lookup ``export_airports_data`` writes into each airport, kept
    here so the site can publish a flag for each of them without reading its
    own export back.
    """
    codes: set[str] = set()
    for _, airport_name in _exported_airports(unique_airports):
        icao_code = airport_icao_code(airport_name)
        if not icao_code:
            continue
        country = lookup_airport_country(icao_code)
        if country:
            codes.add(country)
    return sorted(codes)


def export_airports_data(
    unique_airports: list[AirportData],
    output_dir: str,
) -> tuple[str, int]:
    """Export airport data to airports.json."""
    valid_airports = []

    for apt, airport_name in _exported_airports(unique_airports):
        # No flight count here: the frontend derives it per airport from the
        # path info of the active year/aircraft filter, so an exported count
        # would only ever be shown for the instant before the first refresh
        airport_data: AirportMarker = {
            "lat": apt.lat,
            "lon": apt.lon,
            "name": airport_name,
        }

        # The code the airports were merged by, written out so the frontend
        # shows the same one rather than working it out from the name again
        icao_code = airport_icao_code(airport_name)
        if icao_code:
            airport_data["code"] = icao_code
            country = lookup_airport_country(icao_code)
            if country:
                airport_data["country"] = country

        valid_airports.append(airport_data)

    airports_file = Path(output_dir) / "airports.json"
    atomic_data_write(airports_file, {"airports": valid_airports}, sort_keys=True)

    file_size = airports_file.stat().st_size

    logger.info(
        "  ✓ Airports: %d locations (%.1f KB)", len(valid_airports), file_size / 1024
    )

    return str(airports_file), file_size


def export_metadata(
    min_groundspeed_knots: float,
    max_groundspeed_knots: float,
    available_years: list[int],
    year_file_bytes: dict[str, int],
    aircraft_models: Mapping[str, str],
    output_dir: str,
    available_flags: Sequence[str],
) -> tuple[str, int]:
    """Export metadata.json.

    No statistics: the frontend computes them from the year files for every
    filter. It needs the years and their file sizes before loading any year,
    the groundspeed range for the speed scale, the aircraft models, which
    only aircraft.json knows, and the flags the site was able to publish.
    Those have no default, as in ``export_all_data``: a caller that forgot
    them would publish a site without a flag.
    """
    if not math.isfinite(min_groundspeed_knots):
        min_groundspeed_knots = 0.0
    if not math.isfinite(max_groundspeed_knots):
        max_groundspeed_knots = 0.0

    meta_data: SiteMetadata = {
        "min_groundspeed_knots": round(min_groundspeed_knots, 1),
        "max_groundspeed_knots": round(max_groundspeed_knots, 1),
        "available_years": sorted(available_years),
        "year_file_bytes": year_file_bytes,
        "aircraft_models": dict(aircraft_models),
        # Which countries the site carries a flag for. A build without the
        # flag files publishes none, and the frontend falls back to the code.
        "available_flags": list(available_flags),
    }

    meta_file = Path(output_dir) / "metadata.json"
    atomic_data_write(meta_file, meta_data, sort_keys=True)

    file_size = meta_file.stat().st_size

    logger.info("  ✓ Metadata: %.1f KB", file_size / 1024)

    return str(meta_file), file_size
