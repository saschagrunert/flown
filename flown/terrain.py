"""The ground under the flights, sampled from an elevation model at build time.

The 3D view of the page draws every flight at its height above the ground.
Without an elevation model the ground of a flight can only be a line from
the field it left to the one it landed on, which knows nothing of the hills
in between: a flight across a ridge sits too high or too low over it, the
more so the lower it was. The exporter therefore samples the ground under
every exported position here and writes it next to the altitude (the ground
column of ``segment_codec``), so the page reads it and computes nothing.

The elevations come from the Terrarium tiles of the AWS open data terrain
tiles (Mapzen's Joerd, from SRTM and other sources), fetched once and kept in
the cache directory. The page never loads a tile: the ground reaches it as
numbers in the year files.

A digital elevation model and the altitudes a recorder logs never agree to
the foot: GPS altitudes are off by tens of feet, a barometric one by the
pressure of the day. The ground is therefore anchored where the flight
itself shows where it is: at the field it left and the one it landed on,
the altitudes it recorded taxiing there are the ground (see
``ground_profile_ft``), and in between the model is shifted from the one
offset to the other in proportion to the distance flown. A flight taxis on
the map at both ends, and follows the relief in between.

Nothing here fails a build unless asked to: a tile that cannot be fetched
or decoded leaves the positions under it without ground, and a path with a
position without ground gets no ground column at all, so the page falls back
to the line between the fields for it. A build that publishes the site sets
``FLOWN_REQUIRE_TERRAIN=1``, which fails it instead (see
``sample_path_elevations``).

The tiles are fetched by ``terrain_fetch`` and their pixels kept decoded
by ``terrain_pixels``; this module samples the ground from them.
"""

import hashlib
import math
import os
import re
import struct
import time
from array import array
from itertools import pairwise
from pathlib import Path
from statistics import median_high
from typing import TYPE_CHECKING, Protocol

from .cache import load_bytes, prune_entries, source_fingerprint, store_bytes
from .constants import METERS_TO_FEET
from .exceptions import TerrainUnavailableError
from .geometry import TERRAIN_MAX_LATITUDE, planar_metres
from .logger import logger
from .segment_codec import ALTITUDE, GROUND_STEP, LAT, LON, SPEED, TIME
from .terrain_fetch import TERRAIN_CACHE_DIR, TILE_URL, TerrariumTiles
from .terrain_pixels import TILE_SIZE, DecodeFailedError, TileKey
from .types import COORDINATE_DECIMALS

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping, Sequence

    from .types import FlightPath, SegmentRow

__all__ = [
    "REQUIRE_TERRAIN_ENV",
    "TERRAIN_CACHE_DIR",
    "TERRAIN_ZOOM",
    "TILE_SIZE",
    "DecodeFailedError",
    "TerrariumTiles",
    "TileKey",
    "TileSource",
    "elevations_by_coordinate",
    "ground_profile_ft",
    "sample_path_elevations",
]

# The zoom level the ground is sampled at. Its pixels are about 100 m across
# at 50 degrees north (153 m at the equator), which is finer than anything a
# flight a few hundred feet up shows of the relief under it, and the flights
# of a few years of logs touch a few hundred tiles of it. Every level more
# takes about 2.5 times the tiles, the download and the decoding time.
TERRAIN_ZOOM = 10
# Set to "1", a tile that cannot be fetched or decoded fails the build
REQUIRE_TERRAIN_ENV = "FLOWN_REQUIRE_TERRAIN"

# Groundspeed below which a fix is taxiing, and the fixes of taxiing it takes
# to tell where a field is: the values of groundProfileFt in the frontend
# (calculations/groundProfile.ts), which this mirrors
TAXI_KNOTS = 40
TAXI_MIN_FIXES = 3


class TileSource(Protocol):
    """Where the elevations come from.

    ``pixels`` answers, for every tile asked for, the elevation in metres of
    each of its pixels given by index (``row * TILE_SIZE + column``), in that
    order. A tile that is not available is left out of the answer. An
    ``array("d")`` holds a few million of them in a fraction of the memory
    a list takes.

    A source that also has a ``ground_dir`` (a ``Path``, or None for none)
    keeps the ground sampled under each path there, which the next build
    reads rather than sampling it again (see ``sample_path_elevations``).
    """

    def pixels(
        self, wanted: Mapping[TileKey, Sequence[int]]
    ) -> dict[TileKey, Sequence[float]]: ...


# --- Sampling -----------------------------------------------------------

# A coordinate as the exporter rounds it (see COORDINATE_DECIMALS)
Coordinate = tuple[float, float]
# The ground under the points of a path, in metres: one value per point, in
# the order of the points, and NaN for a point the tiles do not cover. An
# array rather than a mapping of coordinates, because a million points in
# Python objects take a gigabyte and are pickled into every export chunk.
type PointElevations = array[float]
TILE_PIXELS = TILE_SIZE * TILE_SIZE
# A pixel asked for, in the bytes of a tile that mark them (see
# sample_elevations): found by the regular expression engine, which skips
# the tens of thousands of the others in C, where going through every one
# of them took half the time of sampling
_WANTED = re.compile(b"\x01")


def _position(lat: float, lon: float, zoom: int) -> tuple[int, int, float, float]:
    """Where a point is among the pixels around it.

    Pixels are counted across the whole world at ``zoom``. Returns the
    column and the row of the pixel whose centre is up and to the left of
    the point, then the fractions of the way from it to the next column and
    the next row. The column wraps across the antimeridian; the row is -1
    above the centre of the top row.
    """
    world = TILE_SIZE << zoom
    # Web Mercator in the form the tests and the frontend measure a pixel
    # position in: the projection of geometry.web_mercator, but another
    # formula for it rounds differently, which moves a point by a bit and,
    # once in a few million, into the next pixel
    lat = max(min(lat, TERRAIN_MAX_LATITUDE), -TERRAIN_MAX_LATITUDE)
    sin = math.sin(math.radians(lat))
    x = (lon + 180) / 360 * world - 0.5
    y = (0.5 - math.log((1 + sin) / (1 - sin)) / (4 * math.pi)) * world - 0.5
    left = math.floor(x)
    top = math.floor(y)
    return left % world, top, x - left, y - top


def _corner_pixels(left: int, top: int, zoom: int) -> list[tuple[int, int]]:
    """The four pixels around a point of ``_position``, as tile and index.

    Top left, top right, bottom left, bottom right; a tile is numbered row
    by row across the world (``y * tiles + x``) and a pixel within it the
    same way. Across the antimeridian the world wraps; at the top and bottom
    the edge row stands in for the one beyond.
    """
    world = TILE_SIZE << zoom
    right = (left + 1) % world
    bottom = min(top + 1, world - 1)
    top = max(top, 0)
    tiles = 1 << zoom
    return [
        (
            row // TILE_SIZE * tiles + column // TILE_SIZE,
            row % TILE_SIZE * TILE_SIZE + column % TILE_SIZE,
        )
        for row in (top, bottom)
        for column in (left, right)
    ]


def sample_elevations(
    coordinates: Iterable[Coordinate],
    source: TileSource,
    zoom: int = TERRAIN_ZOOM,
) -> tuple[PointElevations, int, int]:
    """The ground elevation in metres at every coordinate, in their order.

    Bilinear between the four pixels around a coordinate, which can be in
    up to four tiles: the relief runs on across tile edges. A coordinate
    with a pixel of a missing tile is NaN. Also returns how many tiles were
    asked for and how many of them were missing.

    Every pixel is asked for once. Nothing is kept per coordinate but four
    numbers in arrays (its fractions, and its index and that of its top
    left pixel in its tile), and the pixels of one tile at a time are looked
    up in a dense array; only the rare coordinate whose pixels are in
    several tiles goes through a mapping.
    """
    tiles_across = 1 << zoom
    size = TILE_SIZE
    last = size - 1
    fractions_x = array("d")
    fractions_y = array("d")
    # The pixels each tile is asked for, one byte per pixel
    wanted_pixels: dict[int, bytearray] = {}
    # The points whose four pixels are all in one tile, by that tile, with
    # the index of their top left pixel in it
    inner: dict[int, tuple[array[int], array[int]]] = {}
    # The other points, with the column and the row of that pixel, and the
    # pixels they need of each tile
    across: list[tuple[int, int, int]] = []
    across_pixels: dict[int, set[int]] = {}

    def tile_pixels(tile: int) -> bytearray:
        pixels = wanted_pixels.get(tile)
        if pixels is None:
            pixels = wanted_pixels[tile] = bytearray(TILE_PIXELS)
        return pixels

    previous: Coordinate | None = None
    position = (0, 0, 0.0, 0.0)
    # The tile of the last point: the next one is mostly in it as well
    current = -1
    current_pixels = bytearray()
    # The loop runs once per point of every flight, a few hundred thousand
    # times: the methods it calls are looked up once, and those that add
    # a point to its tile once per tile it enters
    add_fraction_x, add_fraction_y = fractions_x.append, fractions_y.append
    add_point = add_index = array("i").append
    count = 0
    for count, coordinate in enumerate(coordinates, 1):
        # Consecutive points of a slow flight often round to the same place
        if coordinate != previous:
            position = _position(coordinate[0], coordinate[1], zoom)
            previous = coordinate
        left, top, fraction_x, fraction_y = position
        add_fraction_x(fraction_x)
        add_fraction_y(fraction_y)
        if left & last != last and top >= 0 and top & last != last:
            tile = top // size * tiles_across + left // size
            if tile != current:
                current = tile
                current_pixels = tile_pixels(tile)
                points, indices = inner.setdefault(tile, (array("i"), array("i")))
                add_point, add_index = points.append, indices.append
            index = (top & last) * size + (left & last)
            current_pixels[index] = current_pixels[index + 1] = 1
            current_pixels[index + size] = current_pixels[index + size + 1] = 1
            add_point(count - 1)
            add_index(index)
        else:
            across.append((count - 1, left, top))
            for tile, index in _corner_pixels(left, top, zoom):
                tile_pixels(tile)[index] = 1
                across_pixels.setdefault(tile, set()).add(index)

    keys = {
        tile: TileKey(zoom, tile % tiles_across, tile // tiles_across)
        for tile in wanted_pixels
    }
    wanted = {
        keys[tile]: array(
            "H", [match.start() for match in _WANTED.finditer(wanted_pixels.pop(tile))]
        )
        for tile in list(wanted_pixels)
    }
    answered = source.pixels(wanted)

    elevations = array("d", [math.nan]) * count
    unknown_tile = array("d", [math.nan]) * TILE_PIXELS
    no_points = (array("i"), array("i"))
    across_values: dict[tuple[int, int], float] = {}
    for tile, key in keys.items():
        values = answered.get(key)
        if values is None:
            continue
        dense = array("d", unknown_tile)
        for index, value in zip(wanted[key], values, strict=True):
            dense[index] = value
        for index in across_pixels.get(tile, ()):
            across_values[tile, index] = dense[index]
        points, indices = inner.get(tile, no_points)
        for point, index in zip(points, indices, strict=True):
            top_left = dense[index]
            bottom_left = dense[index + size]
            fraction_x = fractions_x[point]
            upper = top_left + (dense[index + 1] - top_left) * fraction_x
            lower = bottom_left + (dense[index + size + 1] - bottom_left) * fraction_x
            elevations[point] = upper + (lower - upper) * fractions_y[point]
    for point, left, top in across:
        top_left, top_right, bottom_left, bottom_right = (
            across_values.get(pixel, math.nan)
            for pixel in _corner_pixels(left, top, zoom)
        )
        upper = top_left + (top_right - top_left) * fractions_x[point]
        lower = bottom_left + (bottom_right - bottom_left) * fractions_x[point]
        elevations[point] = upper + (lower - upper) * fractions_y[point]
    return elevations, len(wanted), len(wanted) - len(answered)


def _rounded(path: FlightPath) -> Iterable[Coordinate]:
    return (
        (round(point.lat, COORDINATE_DECIMALS), round(point.lon, COORDINATE_DECIMALS))
        for point in path
    )


def _all_rounded(paths: Iterable[FlightPath]) -> Iterable[Coordinate]:
    """``_rounded`` of every path, one after the other, in one generator."""
    decimals = COORDINATE_DECIMALS
    return (
        (round(point.lat, decimals), round(point.lon, decimals))
        for path in paths
        for point in path
    )


def _content_coordinates(contents: Iterable[bytes]) -> Iterable[Coordinate]:
    """The rounded coordinates the contents of paths hold, one after the other.

    A content is the coordinates, rounded the way they are exported, and the
    altitude of every point (see ``path_content.exported_contents``), which
    the exporter has packed already: unpacking it takes a fraction of the
    time of rounding every point again.
    """
    return (
        (lat, lon)
        for content in contents
        for lat, lon, _ in struct.iter_unpack("<3d", content)
    )


# What the ground kept for a path follows from: the code that samples it, the
# zoom and the tiles. A change to any of them makes a key no entry has
_GROUND_MODULES = ("terrain", "terrain_pixels", "png")
_GROUND_FORMAT = 1


def _ground_key_prefix() -> bytes:
    fingerprint = source_fingerprint(Path(__file__).parent, _GROUND_MODULES)
    return f"{_GROUND_FORMAT}:{fingerprint}:{TERRAIN_ZOOM}:{TILE_URL}:".encode()


def _ground_path(ground_dir: Path, prefix: bytes, content: bytes) -> Path:
    """Where the ground under a path of ``content`` is kept."""
    return ground_dir / hashlib.blake2b(prefix + content, digest_size=16).hexdigest()


def _load_ground(path: Path, points: int) -> PointElevations | None:
    """The ground kept at ``path`` for a path of ``points``, None for none."""
    data = load_bytes(path)
    elevations = array("d")
    if data is None or len(data) != points * elevations.itemsize:
        return None
    elevations.frombytes(data)
    return elevations


def sample_path_elevations(
    paths: Mapping[int, FlightPath],
    source: TileSource,
    contents: Mapping[int, bytes] | None = None,
) -> dict[int, PointElevations]:
    """The ground under every point of the given paths, keyed like them.

    Each path gets the elevations in metres of its points, in their order,
    at the coordinate as the exporter rounds it, which is what its segment
    rows carry. A point the tiles do not cover is NaN, and a path none of
    whose points they cover is left out. Logs one summary, and one warning
    when tiles were missing; never raises for a tile it could not get,
    unless ``FLOWN_REQUIRE_TERRAIN`` is "1": then a missing tile, or
    tiles that cannot be decoded at all, raise ``TerrainUnavailableError``.

    ``contents`` are those of the paths (see
    ``path_content.exported_contents``), which hold the rounded coordinates.
    With them, and a source with a ``ground_dir``, the ground of a path
    whose content was sampled before is read from there: sampling every
    point of every flight again took a quarter of a build whose flights had
    not changed. Only a ground the tiles cover at every point is kept, as a
    point without one gets it once its tile is there.
    """
    started = time.monotonic()
    required = os.environ.get(REQUIRE_TERRAIN_ENV) == "1"
    ground_dir: Path | None = (
        getattr(source, "ground_dir", None) if contents is not None else None
    )
    prefix = _ground_key_prefix() if ground_dir is not None else b""
    kept: dict[int, PointElevations] = {}
    if ground_dir is not None and contents is not None:
        for index, path in paths.items():
            found = _load_ground(
                _ground_path(ground_dir, prefix, contents[index]), len(path)
            )
            if found is not None:
                kept[index] = found
    wanted = {index: path for index, path in paths.items() if index not in kept}
    coordinates = (
        _content_coordinates(contents[index] for index in wanted)
        if contents is not None
        else _all_rounded(wanted.values())
    )
    try:
        elevations, tiles, missing = (
            sample_elevations(coordinates, source) if wanted else (array("d"), 0, 0)
        )
    except DecodeFailedError as e:
        if required:
            raise TerrainUnavailableError(
                f"The elevation tiles could not be decoded ({e}), and "
                f"{REQUIRE_TERRAIN_ENV}=1 requires them"
            ) from e
        logger.warning(
            "Terrain: the elevation tiles could not be decoded (%s); %d "
            "flight(s) keep the ground between their airfields",
            e,
            len(wanted),
        )
        return kept
    by_path: dict[int, PointElevations] = {}
    uncovered = 0
    offset = 0
    for index, path in paths.items():
        if index in kept:
            by_path[index] = kept[index]
            continue
        own = elevations[offset : offset + len(path)]
        offset += len(path)
        gaps = sum(map(math.isnan, own))
        if gaps:
            uncovered += 1
        if gaps < len(own):
            by_path[index] = own
        if not gaps and ground_dir is not None and contents is not None:
            store_bytes(
                _ground_path(ground_dir, prefix, contents[index]),
                own.tobytes(),
                prune=False,
            )
    if ground_dir is not None and wanted:
        prune_entries(ground_dir)
    sampled_before = (
        f", and read that of {len(kept)} flight(s) sampled before" if kept else ""
    )
    if wanted:
        logger.info(
            "  Sampled the ground under %s point(s) from %d elevation tile(s) "
            "in %.1f s%s",
            f"{len(elevations):,}",
            tiles,
            time.monotonic() - started,
            sampled_before,
        )
    else:
        logger.info(
            "  Read the ground of %d flight(s) sampled before in %.1f s",
            len(kept),
            time.monotonic() - started,
        )
    if missing and required:
        raise TerrainUnavailableError(
            f"{missing} of {tiles} elevation tile(s) are unavailable, and "
            f"{REQUIRE_TERRAIN_ENV}=1 requires every one"
        )
    if missing:
        logger.warning(
            "Terrain: %d of %d elevation tile(s) are unavailable (offline?); "
            "%d flight(s) keep the ground between their airfields",
            missing,
            tiles,
            uncovered,
        )
    return by_path


def elevations_by_coordinate(
    path: FlightPath, elevations: PointElevations
) -> dict[Coordinate, float]:
    """The elevations of ``sample_path_elevations`` by rounded coordinate.

    What ``ground_profile_ft`` looks the rows of the path up in; the points
    the tiles do not cover are left out.
    """
    return {
        coordinate: elevation
        for coordinate, elevation in zip(_rounded(path), elevations, strict=True)
        if not math.isnan(elevation)
    }


# --- The ground of a flight ---------------------------------------------


def _field_offset_ft(
    rows: Sequence[SegmentRow], dem_ft: Sequence[float], order: Iterable[int]
) -> float | None:
    """How far the recorded field is above the model at one end of a path.

    The rows from that end up to the first fast one are its taxiing: the
    middle of their altitudes is the field as the recorder saw it, the
    middle of the model under them the field as the model has it. None for
    a path that starts or ends in the air, or without speeds to tell. A
    speed of 0 is no speed (see ``process_path_segments``), which ends the
    taxiing like a fast one, here and in the frontend (fieldFt). So does a
    row without a time: its speed is the average of a line without times
    (``calculate_fallback_groundspeed``), the same for every row, and a
    flight of circuits whose average was below ``TAXI_KNOTS`` taxied all
    of its way at the median of its altitudes.
    """
    altitudes: list[float] = []
    grounds: list[float] = []
    for index in order:
        row = rows[index]
        if len(row) <= TIME or not 0 < row[SPEED] < TAXI_KNOTS:
            break
        altitudes.append(row[ALTITUDE])
        grounds.append(dem_ft[index])
    if len(altitudes) < TAXI_MIN_FIXES:
        return None
    # The upper median, as the frontend takes it
    return median_high(altitudes) - median_high(grounds)


def ground_profile_ft(
    start: Sequence[float],
    rows: Sequence[SegmentRow],
    elevations: Mapping[Coordinate, float],
) -> list[float] | None:
    """The ground under the end of every row of a path, in feet.

    The model's elevation under each row (``elevations``, in metres, by the
    coordinate), shifted to meet the flight's own fields: at each end by as
    much as the altitudes it recorded taxiing there are above the model
    (``_field_offset_ft``), and in between from the one offset to the other
    in proportion to the distance flown, measured like groundProfileFt does
    in the frontend. With a field at one end only, its offset holds all the
    way; with none, the model is the ground. Rounded to ``GROUND_STEP``, the
    step the year file stores.

    The taxiing rows then stand on the ground as they do without a model,
    since the ground under them is their own altitudes up to the relief of
    the field, and the altitudes are rounded to 20 ft anyway.

    None when the path has no rows or a row without an elevation: a ground
    with a hole in it would be worse than the line between the fields.
    """
    if not rows or not start:
        return None
    dem_ft: list[float] = []
    for row in rows:
        elevation = elevations.get((row[LAT], row[LON]))
        if elevation is None:
            return None
        dem_ft.append(elevation * METERS_TO_FEET)

    first = _field_offset_ft(rows, dem_ft, range(len(rows)))
    last = _field_offset_ft(rows, dem_ft, reversed(range(len(rows))))
    from_ft = first if first is not None else last if last is not None else 0.0
    to_ft = last if last is not None else from_ft

    # Metres flown to the end of each row, as the frontend measures them
    along: list[float] = []
    total = 0.0
    points = [(start[0], start[1]), *((row[LAT], row[LON]) for row in rows)]
    for (lat0, lon0), (lat1, lon1) in pairwise(points):
        total += planar_metres(lat0, lon0, lat1, lon1)
        along.append(total)

    ground: list[float] = []
    for dem, distance in zip(dem_ft, along, strict=True):
        t = distance / total if total > 0 else 0.0
        feet = dem + from_ft + (to_ft - from_ft) * t
        ground.append(float(round(feet / GROUND_STEP) * GROUND_STEP))
    return ground
