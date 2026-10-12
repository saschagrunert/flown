"""Geometric calculations and coordinate manipulations.

The constants and the small distance functions several modules share live
here, each with the exact value and formula its callers used before they
were shared, so that no exported number moves.
"""

from dataclasses import dataclass
from math import atan2, cos, degrees, hypot, log, pi, radians, sin, sqrt, tan
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Iterable

    from .types import TrackPoint

__all__ = [
    "EARTH_RADIUS_KM",
    "KM_PER_DEGREE",
    "MAX_LATITUDE",
    "METRES_PER_DEGREE",
    "TERRAIN_MAX_LATITUDE",
    "CoordinateExtent",
    "haversine_distance",
    "longitude_difference",
    "planar_km",
    "planar_metres",
    "true_bearing",
    "web_mercator",
]

EARTH_RADIUS_KM = 6371
# A degree of latitude on the sphere above, for the grids the airports and
# the recordings of a flight are indexed in
KM_PER_DEGREE = radians(EARTH_RADIUS_KM)
# A degree of latitude as the frontend measures distances along a path
# (calculations/groundProfile.ts), and as the landing detector does: a
# round figure rather than the sphere's, kept so the ground and the
# landings the site carries stay as they are
METRES_PER_DEGREE = 111_320.0
# Where Web Mercator ends, in a square: the latitude of the top and bottom
# edges of the world at every zoom, which the link previews clamp to
MAX_LATITUDE = 85.051129
# The rounder figure the elevation sampling has always clamped to (terrain):
# a few metres short of the edge, so a point beyond it samples the top row
# of pixels as before and the ground the site carries stays the same
TERRAIN_MAX_LATITUDE = 85.0511


def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Calculate great circle distance in kilometers between two points."""
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    a = min(1.0, max(0.0, a))
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return EARTH_RADIUS_KM * c


def longitude_difference(lon0: float, lon1: float) -> float:
    """``lon1 - lon0`` the short way round, from -180 to 180 degrees."""
    return (lon1 - lon0 + 180) % 360 - 180


def planar_km(lat0: float, lon0: float, lat1: float, lon1: float) -> float:
    """Distance in km on a plane tangent at the first point; fine for 10 km.

    The short way round across the antimeridian. What the landing detector
    measures the fixes of a flight with.
    """
    dx = longitude_difference(lon0, lon1) * cos(radians(lat0))
    return hypot(dx, lat1 - lat0) * METRES_PER_DEGREE / 1000


def planar_metres(lat0: float, lon0: float, lat1: float, lon1: float) -> float:
    """Distance in metres on a plane at the middle latitude of the two points.

    The short way round across the antimeridian, and multiplied out the way
    the frontend measures the metres flown along a path (groundProfileFt in
    calculations/groundProfile.ts), which the ground of a flight has to
    agree with to the bit.
    """
    dlon = longitude_difference(lon0, lon1)
    return hypot(
        dlon * METRES_PER_DEGREE * cos(radians((lat0 + lat1) / 2)),
        (lat1 - lat0) * METRES_PER_DEGREE,
    )


def true_bearing(lat0: float, lon0: float, lat1: float, lon1: float) -> float:
    """True bearing from the first point to the second, in degrees.

    On a plane, which is close enough for points a few kilometres apart (the
    ends of a runway, the last half minute of an approach), and the short
    way round across the antimeridian.
    """
    dx = longitude_difference(lon0, lon1) * cos(radians((lat0 + lat1) / 2))
    return degrees(atan2(dx, lat1 - lat0)) % 360


def web_mercator(lat: float, lon: float) -> tuple[float, float]:
    """A point in Web Mercator, as fractions of the world from 0 to 1.

    x runs east from the antimeridian, y south from the top edge. A
    latitude beyond ``MAX_LATITUDE`` is clamped to the edge.
    """
    phi = radians(max(-MAX_LATITUDE, min(MAX_LATITUDE, lat)))
    return (
        (lon + 180.0) / 360.0,
        (1.0 - log(tan(pi / 4 + phi / 2)) / pi) / 2.0,
    )


@dataclass(frozen=True)
class CoordinateExtent:
    """Bounding box of a set of coordinates.

    Plain minimum and maximum, also for data on both sides of the
    antimeridian: the map draws every path, marker and heat point at its own
    longitude, not where it would be nearest to the others, so a box that
    wrapped around 180 (179 to 181) would open the map on half of the
    flights.
    """

    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float

    @classmethod
    def of(cls, coordinates: Iterable[TrackPoint]) -> CoordinateExtent | None:
        """The extent of the coordinates, or None when there are none."""
        points = list(coordinates)
        if not points:
            return None
        return cls(
            min(point.lat for point in points),
            max(point.lat for point in points),
            min(point.lon for point in points),
            max(point.lon for point in points),
        )

    @property
    def center_lat(self) -> float:
        """The latitude halfway between the extremes."""
        return (self.min_lat + self.max_lat) / 2

    @property
    def center_lon(self) -> float:
        """The longitude halfway between the extremes."""
        return (self.min_lon + self.max_lon) / 2
