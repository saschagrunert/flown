#!/usr/bin/env python3
"""
Generate test KML files with random flight data.

Creates realistic test KML files with curved flight paths between major
European airports. Useful for testing performance and visualization quality
with large datasets.

Features:
- Curved flight paths using Bezier curves (not straight lines)
- Random deviations to spread data across Germany
- Realistic altitude profiles (climb, cruise, descend)
- Configurable number of files, and the same files for the same --seed
- Documented N_REGISTRATION_TYPE.kml filenames (no dates in the filename or
  the placemark name)
- Two formats (--format):
  - gx-track (the default): a gx:Track with a <when> for every point, as
    SkyDemon and most loggers write, at the pace of the flight's groundspeed
  - linestring: LineString coordinates without per-point timestamps
    (Charterware style), the flight's start and end in a <TimeSpan>. Without
    per-point times the groundspeed falls back to path averages: the length
    of the path over the time from <begin> to <end>
"""

import argparse
import datetime
import random
import sys
from itertools import pairwise
from pathlib import Path

# The package is not installed (see [tool.uv] in pyproject.toml), so the
# script takes the distances and the units from the checkout, as pre_push.py
# does
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flown.constants import KM_TO_NAUTICAL_MILES
from flown.geometry import haversine_distance

Coordinate = tuple[float, float]

# Airport coordinates (major airports in Europe)
AIRPORTS = {
    "EDDF": (50.0379, 8.5622),  # Frankfurt
    "EDDM": (48.3538, 11.7861),  # Munich
    "EDDK": (50.8659, 7.1427),  # Cologne
    "EDDH": (53.6304, 9.9882),  # Hamburg
    "EDDB": (52.3667, 13.5033),  # Berlin
    "EDDL": (51.2895, 6.7668),  # Düsseldorf
    "EDDS": (48.6899, 9.2220),  # Stuttgart
    "EDDP": (51.4324, 12.2416),  # Leipzig
    "EDDW": (53.0475, 8.7867),  # Bremen
    "EDDN": (49.4987, 11.0669),  # Nuremberg
}

# The groundspeeds a flight is given, in knots: those of the light aircraft
# below, so the speed layer shows a plausible spread
GROUNDSPEED_KNOTS = (90, 150)

# The formats of --format, the first the default
FORMATS = ("gx-track", "linestring")
# What --seed is without one: the same files on every run
DEFAULT_SEED = 42

AIRCRAFT = [
    ("D-ABCD", "DA40"),
    ("D-EFGH", "C172"),
    ("D-IJKL", "PA28"),
    ("D-MNOP", "SR22"),
    ("D-QRST", "TB20"),
]


def generate_flight_path(
    start_coords: Coordinate, end_coords: Coordinate, num_points: int = 50
) -> list[tuple[float, float, float]]:
    """Generate a curved flight path between two coordinates with altitude."""
    lat1, lon1 = start_coords
    lat2, lon2 = end_coords

    coords: list[tuple[float, float, float]] = []

    # Generate cruise altitude (2000-10000 ft)
    cruise_alt = random.randint(2000, 10000)

    # Offset the midpoint perpendicular to the flight path to create curves
    mid_lat = (lat1 + lat2) / 2
    mid_lon = (lon1 + lon2) / 2
    dx = lat2 - lat1
    dy = lon2 - lon1
    offset_factor = random.uniform(0.2, 0.4) * random.choice([-1, 1])
    mid_lat += -dy * offset_factor
    mid_lon += dx * offset_factor

    for i in range(num_points):
        t = i / (num_points - 1)

        # Quadratic bezier curve interpolation for more realistic paths
        lat = (1 - t) ** 2 * lat1 + 2 * (1 - t) * t * mid_lat + t**2 * lat2
        lon = (1 - t) ** 2 * lon1 + 2 * (1 - t) * t * mid_lon + t**2 * lon2

        # Small random variations to spread the data
        lat += random.uniform(-0.02, 0.02)
        lon += random.uniform(-0.02, 0.02)

        # Altitude profile (climb, cruise, descend)
        if t < 0.2:
            alt = int(cruise_alt * (t / 0.2))
        elif t > 0.8:
            alt = int(cruise_alt * ((1 - t) / 0.2))
        else:
            alt = cruise_alt + random.randint(-200, 200)

        coords.append((lat, lon, alt))

    return coords


def path_length_km(coords: list[tuple[float, float, float]]) -> float:
    """The length of a path along the great circles between its points."""
    return sum(
        haversine_distance(lat1, lon1, lat2, lon2)
        for (lat1, lon1, _), (lat2, lon2, _) in pairwise(coords)
    )


def _point_times(
    coords: list[tuple[float, float, float]],
    start_time: datetime.datetime,
    groundspeed_knots: int,
) -> list[datetime.datetime]:
    """When the flight passes each point, at a constant groundspeed.

    The stretches between the points are a few kilometres long, so the
    points are tens of seconds apart, as a logger that records by distance
    writes them.
    """
    km_per_second = groundspeed_knots / KM_TO_NAUTICAL_MILES / 3600
    times = [start_time]
    for a, b in pairwise(coords):
        seconds = path_length_km([a, b]) / km_per_second
        times.append(times[-1] + datetime.timedelta(seconds=round(seconds, 1)))
    return times


def _iso(moment: datetime.datetime) -> str:
    """A KML timestamp with a tenth of a second where it has one."""
    text = moment.strftime("%Y-%m-%dT%H:%M:%S")
    tenths = moment.microsecond // 100_000
    return f"{text}.{tenths}Z" if tenths else f"{text}Z"


def _linestring_placemark(
    name: str,
    coords: list[tuple[float, float, float]],
    start_time: datetime.datetime,
    end_time: datetime.datetime,
) -> str:
    coordinate_lines = "\n".join(
        f"          {lon},{lat},{alt * 0.3048}" for lat, lon, alt in coords
    )
    return f"""    <Placemark>
      <name>{name}</name>
      <TimeSpan>
        <begin>{_iso(start_time)}</begin>
        <end>{_iso(end_time)}</end>
      </TimeSpan>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>
{coordinate_lines}
        </coordinates>
      </LineString>
    </Placemark>"""


def _gx_track_placemark(
    name: str,
    coords: list[tuple[float, float, float]],
    times: list[datetime.datetime],
) -> str:
    whens = "\n".join(f"        <when>{_iso(moment)}</when>" for moment in times)
    points = "\n".join(
        f"        <gx:coord>{lon} {lat} {alt * 0.3048}</gx:coord>"
        for lat, lon, alt in coords
    )
    return f"""    <Placemark>
      <name>{name}</name>
      <gx:Track>
        <altitudeMode>absolute</altitudeMode>
{whens}
{points}
      </gx:Track>
    </Placemark>"""


def generate_kml_file(
    flight_id: int,
    start_airport: str,
    end_airport: str,
    aircraft_reg: str,
    aircraft_type: str,
    output_dir: Path,
    kml_format: str = FORMATS[0],
) -> str:
    """Generate a single KML file for a flight in ``kml_format`` (see FORMATS)."""
    coords = generate_flight_path(AIRPORTS[start_airport], AIRPORTS[end_airport])

    # Flight date (2026 only). The start and the end are carried by a
    # TimeSpan element; without an end the flight has no duration, and the
    # speed layer nothing to average.
    start_time = datetime.datetime(
        2026,
        random.randint(1, 12),
        random.randint(1, 28),
        random.randint(8, 20),
        random.randint(0, 59),
        tzinfo=datetime.UTC,
    )
    groundspeed_knots = random.randint(*GROUNDSPEED_KNOTS)
    name = f"{start_airport} - {end_airport}"
    if kml_format == "gx-track":
        placemark = _gx_track_placemark(
            name, coords, _point_times(coords, start_time, groundspeed_knots)
        )
    elif kml_format == "linestring":
        hours = path_length_km(coords) * KM_TO_NAUTICAL_MILES / groundspeed_knots
        # Whole seconds, as the file keeps them
        end_time = start_time + datetime.timedelta(seconds=round(hours * 3600))
        placemark = _linestring_placemark(name, coords, start_time, end_time)
    else:
        raise ValueError(f"unknown format {kml_format!r}, not one of {FORMATS}")

    kml_content = f"""<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
  <Document>
    <name>Flight {flight_id}</name>
{placemark}
  </Document>
</kml>
"""

    # Documented filename format: N_REGISTRATION_TYPE.kml (registration without hyphen)
    filename = f"{flight_id}_{aircraft_reg.replace('-', '')}_{aircraft_type}.kml"
    (output_dir / filename).write_text(kml_content, encoding="utf-8")

    return filename


def main() -> None:
    """Generate test KML files."""
    parser = argparse.ArgumentParser(
        description="Generate realistic test KML files with curved flight paths",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Generate 1000 files (default)
  %(prog)s

  # Generate 10000 files
  %(prog)s 10000

  # Generate 5000 files to custom directory
  %(prog)s 5000 --output custom_test_data

  # Other flights, and lines without per-point times
  %(prog)s 100 --seed 7 --format linestring

  # Build and test the generated data
  make build INPUT_DIR=kml_test_10000
        """,
    )
    parser.add_argument(
        "count",
        type=int,
        nargs="?",
        default=1000,
        help="Number of KML files to generate (default: 1000)",
    )
    parser.add_argument(
        "-o",
        "--output",
        type=str,
        help="Output directory (default: kml_test_<count>)",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=DEFAULT_SEED,
        help=f"Random seed; the same seed writes the same files "
        f"(default: {DEFAULT_SEED})",
    )
    parser.add_argument(
        "--format",
        dest="kml_format",
        choices=FORMATS,
        default=FORMATS[0],
        help="gx-track: a <when> for every point (default); linestring: a "
        "LineString and a TimeSpan, without per-point times",
    )
    args = parser.parse_args()
    # Test data, not secrets: a seeded generator is the point
    random.seed(args.seed)

    num_files = args.count
    output_dir = Path(args.output or f"kml_test_{num_files}")
    output_dir.mkdir(exist_ok=True)

    print(f"Generating {num_files:,} KML files in {output_dir}/")
    # Measured: 50 points per flight come to about 6.4 KB per file with a
    # time for each, 3.4 KB without
    kb_per_file = 6.4 if args.kml_format == "gx-track" else 3.4
    estimated_size_mb = num_files * kb_per_file / 1024
    print(f"This will create approximately {estimated_size_mb:.1f} MB of test data...")

    airport_list = list(AIRPORTS.keys())

    for i in range(1, num_files + 1):
        start_airport = random.choice(airport_list)
        end_airport = random.choice([a for a in airport_list if a != start_airport])
        aircraft_reg, aircraft_type = random.choice(AIRCRAFT)

        generate_kml_file(
            i,
            start_airport,
            end_airport,
            aircraft_reg,
            aircraft_type,
            output_dir,
            args.kml_format,
        )

        if i % 1000 == 0:
            print(f"Generated {i:,} files...")

    print(f"\n✓ Successfully generated {num_files:,} KML files in {output_dir}/")
    print("\nTo test with this data, run:")
    print(f"  make build INPUT_DIR={output_dir}")
    # --user: the image's own user cannot write to host directories.
    # --output-dir: only a mounted directory reaches the host.
    name = output_dir.resolve().name
    print("\nOr with Docker (writes the site to out/):")
    print("  mkdir -p out ~/.cache/flown")
    print(
        '  docker run --rm --user "$(id -u):$(id -g)" '
        f'-v "{output_dir.resolve()}:/data/{name}" '
        '-v "$PWD/out:/data/out" -v ~/.cache/flown:/cache '
        f"flown {name} --output-dir out"
    )


if __name__ == "__main__":
    main()
