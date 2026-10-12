"""Tests for geometry module."""

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from flown.geometry import (
    EARTH_RADIUS_KM,
    KM_PER_DEGREE,
    MAX_LATITUDE,
    METRES_PER_DEGREE,
    TERRAIN_MAX_LATITUDE,
    haversine_distance,
    longitude_difference,
    planar_km,
    planar_metres,
    true_bearing,
    web_mercator,
)

latitudes = st.floats(min_value=-90.0, max_value=90.0)
longitudes = st.floats(min_value=-180.0, max_value=180.0)


class TestHaversineDistance:
    def test_zero_distance(self):
        assert haversine_distance(0, 0, 0, 0) == pytest.approx(0, abs=0.01)

    def test_equator_distance(self):
        assert haversine_distance(0, 0, 0, 1) == pytest.approx(111.32, abs=1)

    def test_new_york_to_london(self):
        dist = haversine_distance(40.7128, -74.0060, 51.5074, -0.1278)
        assert dist == pytest.approx(5570, abs=10)

    def test_antipodal_points(self):
        dist = haversine_distance(0, 0, 0, 180)
        assert dist == pytest.approx(EARTH_RADIUS_KM * math.pi, abs=0.01)

    def test_negative_coordinates(self):
        dist = haversine_distance(-33.8688, 151.2093, -34.6037, -58.3816)
        assert dist == pytest.approx(11800, abs=100)

    def test_identical_points(self):
        assert haversine_distance(48.8566, 2.3522, 48.8566, 2.3522) == pytest.approx(
            0, abs=0.01
        )

    def test_very_small_distance(self):
        dist = haversine_distance(0.0, 0.0, 0.0001, 0.0001)
        assert 0 < dist < 0.02

    def test_poles(self):
        assert haversine_distance(90, 0, 90, 180) == pytest.approx(0, abs=0.01)
        assert haversine_distance(-90, 0, -90, 45) == pytest.approx(0, abs=0.01)


class TestHaversineProperties:
    @given(latitudes, longitudes, latitudes, longitudes)
    def test_symmetry(self, lat1, lon1, lat2, lon2):
        d1 = haversine_distance(lat1, lon1, lat2, lon2)
        d2 = haversine_distance(lat2, lon2, lat1, lon1)
        assert d1 == pytest.approx(d2, abs=1e-6)

    @given(latitudes, longitudes, latitudes, longitudes)
    def test_non_negative_and_bounded(self, lat1, lon1, lat2, lon2):
        d = haversine_distance(lat1, lon1, lat2, lon2)
        assert 0.0 <= d <= math.pi * EARTH_RADIUS_KM + 1e-6

    @given(latitudes, longitudes)
    def test_identity(self, lat, lon):
        assert haversine_distance(lat, lon, lat, lon) == pytest.approx(0.0, abs=1e-6)

    @settings(max_examples=200)
    @given(latitudes, longitudes, latitudes, longitudes, latitudes, longitudes)
    def test_triangle_inequality(self, lat1, lon1, lat2, lon2, lat3, lon3):
        direct = haversine_distance(lat1, lon1, lat3, lon3)
        via = haversine_distance(lat1, lon1, lat2, lon2) + haversine_distance(
            lat2, lon2, lat3, lon3
        )
        # Relative slack: near antipodal points the rounding error of a
        # 20,000 km distance is about 1e-5 km, more than any absolute epsilon
        assert direct <= via * (1 + 1e-9) + 1e-6


class TestLongitudeDifference:
    def test_the_short_way_round(self):
        assert longitude_difference(8.0, 9.5) == pytest.approx(1.5)
        assert longitude_difference(9.5, 8.0) == pytest.approx(-1.5)
        assert longitude_difference(179.5, -179.5) == pytest.approx(1.0)
        assert longitude_difference(-179.5, 179.5) == pytest.approx(-1.0)

    @given(longitudes, longitudes)
    def test_bounded(self, lon0, lon1):
        assert -180.0 <= longitude_difference(lon0, lon1) < 180.0


class TestTrueBearing:
    def test_the_points_of_the_compass(self):
        assert true_bearing(50.0, 8.0, 50.1, 8.0) == pytest.approx(0.0)
        assert true_bearing(50.0, 8.0, 50.0, 8.1) == pytest.approx(90.0)
        assert true_bearing(50.0, 8.0, 49.9, 8.0) == pytest.approx(180.0)
        assert true_bearing(50.0, 8.0, 50.0, 7.9) == pytest.approx(270.0)

    def test_across_the_antimeridian(self):
        assert true_bearing(-16.7, 179.99, -16.7, -179.99) == pytest.approx(90.0)
        assert true_bearing(-16.7, -179.99, -16.7, 179.99) == pytest.approx(270.0)

    def test_a_runway_is_narrower_eastward_further_north(self):
        """A degree of longitude is half as long at 60 degrees."""
        assert true_bearing(60.0, 8.0, 60.01, 8.02) == pytest.approx(45.0, abs=0.1)


class TestSharedConstants:
    def test_the_values_each_module_measured_with(self):
        """Two degrees of latitude, and two edges of the map, on purpose."""
        assert pytest.approx(111.19492664455873) == KM_PER_DEGREE
        assert METRES_PER_DEGREE == 111_320.0
        assert MAX_LATITUDE == 85.051129
        assert TERRAIN_MAX_LATITUDE == 85.0511


class TestPlanarDistances:
    def test_planar_km_along_a_meridian(self):
        assert planar_km(50.0, 8.0, 50.1, 8.0) == pytest.approx(11.132)

    def test_planar_km_across_the_antimeridian(self):
        assert planar_km(0.0, 179.99, 0.0, -179.99) == pytest.approx(2.2264)

    def test_planar_metres_at_the_middle_latitude(self):
        expected = math.hypot(
            0.1 * 111_320.0 * math.cos(math.radians(50.05)), 0.1 * 111_320.0
        )
        assert planar_metres(50.0, 8.0, 50.1, 8.1) == pytest.approx(expected)

    def test_planar_metres_across_the_antimeridian(self):
        assert planar_metres(0.0, 179.99, 0.0, -179.99) == pytest.approx(2226.4)


class TestWebMercator:
    def test_the_corners_of_the_world(self):
        assert web_mercator(0.0, -180.0) == pytest.approx((0.0, 0.5))
        assert web_mercator(MAX_LATITUDE, 180.0) == pytest.approx((1.0, 0.0), abs=1e-6)

    def test_beyond_the_edge_is_clamped(self):
        assert web_mercator(89.9, 0.0) == web_mercator(MAX_LATITUDE, 0.0)
        assert web_mercator(-89.9, 0.0) == web_mercator(-MAX_LATITUDE, 0.0)
