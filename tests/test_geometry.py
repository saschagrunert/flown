"""Tests for geometry module."""

import math

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

import flown.geometry as geometry_module
from flown.geometry import (
    EARTH_RADIUS_KM,
    KM_PER_DEGREE,
    MAX_LATITUDE,
    METRES_PER_DEGREE,
    TERRAIN_MAX_LATITUDE,
    haversine_distance,
    heading_difference,
    longitude_difference,
    planar_km,
    planar_metres,
    trim_path_ends,
    true_bearing,
    web_mercator,
)
from flown.types import TrackPoint

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

    def test_a_half_turn_that_rounds_up(self):
        # Found by Hypothesis: the modulo came out as 360, which left 180
        assert longitude_difference(5.606116679153747e-14, -179.99999999999997) == (
            -180.0
        )

    @given(longitudes, longitudes)
    def test_bounded(self, lon0, lon1):
        assert -180.0 <= longitude_difference(lon0, lon1) < 180.0


class TestHeadingDifference:
    def test_the_angle_between_two_headings(self):
        assert heading_difference(10.0, 350.0) == pytest.approx(20.0)
        assert heading_difference(350.0, 10.0) == pytest.approx(20.0)
        assert heading_difference(90.0, 270.0) == 180.0
        assert heading_difference(84.0, 444.0) == pytest.approx(0.0)


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


def _east(*metres):
    """Points at 51 north, ``metres`` east of 12 east each."""
    from flown.types import TrackPoint

    return [
        TrackPoint(51.0, 12.0 + m / (METRES_PER_DEGREE * 0.6293), 100.0) for m in metres
    ]


class TestTrimPathEnds:
    def test_drops_the_points_near_both_ends(self):
        """The taxiing from the parking spot, and back to it."""
        path = _east(0, 50, 200, 1000, 5000, 9000, 9800, 9950, 10000)

        trimmed = trim_path_ends(path, 300)

        assert trimmed == path[3:6]

    def test_off_keeps_the_path(self):
        path = _east(0, 50, 1000)
        assert trim_path_ends(path, 0) == path

    def test_a_path_that_never_leaves_keeps_one_point(self):
        """Which the export leaves out, rather than publish the spot."""
        path = _east(0, 50, 100, 20)
        assert trim_path_ends(path, 300) == path[:1]


class _Recorder:
    """A logger writing a fix a second, moving east and north in metres."""

    def __init__(self, lat=51.0, lon=12.0):
        self.lat, self.lon, self.t = lat, lon, 0.0
        self.fixes: list[TrackPoint] = []

    def at(self, north_m=0.0, east_m=0.0, alt=100.0):
        """One fix this far off the current place, which stays."""
        lat = self.lat + north_m / METRES_PER_DEGREE
        lon = self.lon + east_m / (METRES_PER_DEGREE * math.cos(math.radians(lat)))
        self.fixes.append(TrackPoint(lat, lon, alt, self.t))
        self.t += 1.0
        return self

    def stand(self, seconds, alt=100.0):
        for _ in range(seconds):
            self.at(alt=alt)
        return self

    def go(self, seconds, knots, alt_from=100.0, alt_to=None, north=False):
        """Move at ``knots`` for ``seconds``, climbing or sinking evenly."""
        alt_to = alt_from if alt_to is None else alt_to
        step = knots * 1852 / 3600
        for i in range(seconds):
            if north:
                self.lat += step / METRES_PER_DEGREE
            else:
                self.lon += step / (
                    METRES_PER_DEGREE * math.cos(math.radians(self.lat))
                )
            self.at(alt=alt_from + (alt_to - alt_from) * (i + 1) / seconds)
        return self

    def circle(self, seconds, alt_from=100.0, alt_to=None, period=24, radius=80):
        """Circle for ``seconds``, once every ``period``: slow over the
        ground, as the chord of a circle is short, at the speed of flight."""
        alt_to = alt_from if alt_to is None else alt_to
        lat, lon = self.lat, self.lon
        for i in range(seconds):
            angle = 2 * math.pi * i / period
            self.lat, self.lon = lat, lon
            self.at(
                north_m=radius * math.sin(angle),
                east_m=radius * (math.cos(angle) - 1),
                alt=alt_from + (alt_to - alt_from) * (i + 1) / seconds,
            )
        self.lat, self.lon = lat, lon
        return self


def _flight(recorder):
    """Taxi out, take off, climb, cruise, descend, land, taxi in."""
    return (
        recorder.go(120, 10)
        .go(30, 60)
        .go(300, 90, 100.0, 1000.0)
        .go(600, 100, 1000.0)
        .go(300, 90, 1000.0, 100.0)
        .go(20, 50)
        .go(120, 10)
    )


def _within(points, lat, lon, metres):
    return [
        point
        for point in points
        if haversine_distance(lat, lon, point.lat, point.lon) * 1000 <= metres
    ]


class TestTrimPathEndsOnTheFlight:
    """--trim-ends measured from the first and the last fix, which a stale
    fix or a drive home moved away from the parking spot."""

    def test_a_stale_first_fix_publishes_no_parking_spot(self):
        recorder = _Recorder()
        recorder.at(north_m=500).stand(60)
        parked = recorder.fixes[1]
        _flight(recorder)

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert recorder.fixes[0] not in trimmed
        assert not _within(trimmed, parked.lat, parked.lon, 300)
        # The circle is measured from where the takeoff roll began
        assert (
            haversine_distance(parked.lat, parked.lon, trimmed[0].lat, trimmed[0].lon)
            > 0.3
        )

    def test_two_stale_last_fixes_publish_no_parking_spot(self):
        recorder = _flight(_Recorder().stand(60))
        recorder.stand(60)
        parked = recorder.fixes[-1]
        recorder.at(north_m=700).at(north_m=700)

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert not _within(trimmed, parked.lat, parked.lon, 300)
        assert recorder.fixes[-1] not in trimmed

    def test_a_takeoff_roll_that_dips_below_the_speed_for_a_moment(self):
        """Fast, below the speed for a moment, fast again: that moment ended
        the wait on the ground, so the takeoff was none and the trim
        measured from the parking spot (10 of the 210 ends of data/)."""
        recorder = _Recorder().stand(60)
        parked = recorder.fixes[0]
        recorder.go(120, 10).go(15, 50).go(10, 25)
        rolled = len(recorder.fixes)
        recorder.go(30, 60).go(300, 90, 100.0, 1000.0).go(600, 100, 1000.0)
        recorder.go(300, 90, 1000.0, 100.0).go(20, 50).go(120, 10)

        start, _ = geometry_module._flight_span(recorder.fixes)

        assert start is not None
        assert start >= rolled - 20
        self._drops_all_before_the_roll(recorder, parked, rolled - 20)

    def test_the_drive_home_is_not_published(self):
        recorder = _flight(_Recorder().stand(60)).stand(120)
        landed = len(recorder.fixes)
        # Ten minutes on a road at 50 kt, a little down, then home
        recorder.go(600, 50, 100.0, 80.0, north=True).stand(300, alt=80.0)
        home = recorder.fixes[-1]

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert not _within(trimmed, home.lat, home.lon, 300)
        assert all(point in recorder.fixes[:landed] for point in trimmed)

    def test_the_drive_to_the_field_is_not_published(self):
        """Over a rise on the road, from a home at about the height of the
        field: the road climbs, slower than a takeoff, and comes down."""
        recorder = _Recorder().stand(120, alt=90.0)
        home = recorder.fixes[0]
        recorder.go(600, 50, 90.0, 160.0, north=True)
        recorder.go(600, 50, 160.0, 100.0, north=True).stand(300)
        driven = len(recorder.fixes)
        _flight(recorder)

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert not _within(trimmed, home.lat, home.lon, 300)
        assert all(point in recorder.fixes[driven:] for point in trimmed)

    def _drops_all_before_the_roll(self, recorder, parked, rolled):
        trimmed = trim_path_ends(recorder.fixes, 300)
        assert not _within(trimmed, parked.lat, parked.lon, 300)
        assert all(point in recorder.fixes[rolled:] for point in trimmed)

    def test_a_receiver_warming_up_high_still_anchors(self):
        """Forty metres too high for the first half minute, as a cold GPS
        can be: the field is the lowest the recording was."""
        recorder = _Recorder().stand(30, alt=140.0).stand(60)
        parked = recorder.fixes[0]
        rolled = len(recorder.fixes) + 120
        _flight(recorder)

        self._drops_all_before_the_roll(recorder, parked, rolled)

    def test_an_apron_above_the_runway_still_anchors(self):
        """Parked 35 m above the runway, taxiing down to it."""
        recorder = _Recorder().stand(60, alt=135.0).go(120, 10, 135.0, 100.0)
        parked = recorder.fixes[0]
        rolled = len(recorder.fixes)
        recorder.go(30, 60).go(300, 90, 100.0, 1000.0).go(600, 100, 1000.0)
        recorder.go(300, 90, 1000.0, 100.0).go(20, 50).go(120, 10)

        self._drops_all_before_the_roll(recorder, parked, rolled)

    def test_the_drive_down_from_a_home_above_the_field_is_not_published(self):
        recorder = _Recorder().stand(120, alt=150.0)
        home = recorder.fixes[0]
        recorder.go(600, 50, 150.0, 100.0, north=True).stand(300)
        rolled = len(recorder.fixes) + 120
        _flight(recorder)

        self._drops_all_before_the_roll(recorder, home, rolled)

    @pytest.mark.parametrize("home", [50.0, 0.0, 200.0])
    def test_a_home_off_the_height_of_the_field_leaves_the_circle(self, home):
        """A home TRIM_FIELD_M or more below the field, or TRIM_CLIMB_M or
        more above it, reads as a wait in the air would: the circle alone
        trims that end, and the drive is published but for the spot it
        started at."""
        recorder = _Recorder().stand(120, alt=home)
        recorder.go(600, 50, home, 100.0, north=True).stand(300)
        _flight(recorder)

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert self._starts_as_without_times(recorder, trimmed)

    def test_a_recording_that_starts_in_the_air_keeps_its_start(self):
        """Nothing tells where it started: the circle around its first fix."""
        recorder = _Recorder().go(600, 100, 1000.0).go(300, 90, 1000.0, 100.0)
        recorder.go(20, 50).go(120, 10).stand(60)
        parked = recorder.fixes[-1]

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert not _within(trimmed, parked.lat, parked.lon, 300)
        first = recorder.fixes[0]
        assert trimmed[0] == next(
            point
            for point in recorder.fixes
            if haversine_distance(first.lat, first.lon, point.lat, point.lon) > 0.3
        )

    def test_a_flight_at_one_height_trims_as_without_times(self):
        """A stretch that never climbs is no flight the times can tell."""
        recorder = _Recorder().go(600, 100)

        trimmed = trim_path_ends(recorder.fixes, 300)

        untimed = [point._replace(ts=None) for point in recorder.fixes]
        assert [point.lat for point in trimmed] == [
            point.lat for point in trim_path_ends(untimed, 300)
        ]

    def test_a_gap_in_the_recording_tells_no_speed(self):
        """A logger that paused on the ground: no speed across the gap, and
        the parked fixes before it are no flight."""
        recorder = _Recorder().stand(60)
        parked = recorder.fixes[-1]
        recorder.t += 600
        _flight(recorder)

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert not _within(trimmed, parked.lat, parked.lon, 300)

    @staticmethod
    def _airborne_kept(recorder, trimmed, field=100.0):
        """Every fix of the recording well above the field is published."""
        kept = {tuple(point) for point in trimmed}
        return all(
            tuple(point) in kept
            for point in recorder.fixes
            if (point.alt or 0.0) >= field + 100
        )

    def test_a_logger_that_froze_in_the_air_keeps_the_flight(self):
        """Slow fixes in cruise end a stretch in the air: no takeoff there."""
        recorder = _Recorder().stand(60).go(120, 10).go(30, 60)
        recorder.go(300, 90, 100.0, 1000.0).go(600, 100, 1000.0)
        recorder.stand(60, alt=1000.0).go(300, 100, 1000.0, 1500.0)
        recorder.go(600, 100, 1500.0).go(300, 90, 1500.0, 100.0)
        recorder.go(20, 50).go(120, 10).stand(60)

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert self._airborne_kept(recorder, trimmed)

    def test_a_logger_that_lost_its_height_in_the_air_keeps_the_flight(self):
        recorder = _Recorder().stand(60).go(120, 10).go(30, 60)
        recorder.go(300, 90, 100.0, 1000.0).go(600, 100, 1000.0)
        recorder.stand(40, alt=0.0).go(300, 100, 1000.0, 1500.0)
        recorder.go(300, 90, 1500.0, 100.0).go(20, 50).go(120, 10).stand(60)

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert self._airborne_kept(recorder, trimmed)

    def test_a_glider_keeps_its_thermals_and_glides(self):
        """Circling in a thermal is slow over the ground, in the air."""
        recorder = _Recorder().stand(60).go(40, 60, 100.0, 400.0)
        recorder.go(120, 50, 400.0, 300.0).go(240, 20, 300.0, 700.0)
        recorder.go(120, 50, 700.0, 600.0).go(240, 20, 600.0, 900.0)
        recorder.go(400, 55, 900.0, 100.0).go(15, 30).stand(60)
        parked = recorder.fixes[0]

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert self._airborne_kept(recorder, trimmed)
        assert not _within(trimmed, parked.lat, parked.lon, 300)

    def test_a_slow_takeoff_into_the_wind_keeps_its_climb(self):
        """Under TRIM_FLIGHT_KNOTS over the ground on the roll and the climb:
        the first fast stretch starts in the air, over no level ground."""
        recorder = _Recorder().stand(60).go(120, 10).go(20, 30)
        climb = len(recorder.fixes)
        recorder.go(150, 35, 100.0, 400.0)
        climbed = len(recorder.fixes)
        recorder.go(600, 50, 400.0).go(200, 45, 400.0, 100.0)
        recorder.go(15, 30).go(120, 10).stand(60)

        trimmed = trim_path_ends(recorder.fixes, 300)

        kept = {tuple(point) for point in trimmed}
        assert all(tuple(point) in kept for point in recorder.fixes[climb:climbed])

    @staticmethod
    def _starts_as_without_times(recorder, trimmed):
        """The start the circle alone gives: no wait in the air was taken
        for the field."""
        untimed = [point._replace(ts=None) for point in recorder.fixes]
        return trimmed[0][:3] == trim_path_ends(untimed, 300)[0][:3]

    def test_a_glider_circling_level_after_a_winch_launch_keeps_its_launch(self):
        """A winch launch into the wind, slow over the ground, a glide, then
        level circling and a fast climb: the circling is no field."""
        recorder = _Recorder().stand(180, alt=200.0).go(40, 25, 200.0, 600.0)
        recorder.go(60, 50, 600.0, 560.0).circle(90, 560.0)
        recorder.go(200, 55, 560.0, 800.0).go(900, 55, 800.0, 300.0)
        recorder.go(60, 50, 300.0, 200.0).go(10, 25, 200.0).stand(300, alt=200.0)

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert self._starts_as_without_times(recorder, trimmed)

    def test_a_helicopter_hovering_after_a_low_transit_keeps_the_transit(self):
        """A hover 70 m above the field after a low transit is no field."""
        recorder = _Recorder().stand(120).go(10, 5, 100.0, 110.0)
        recorder.go(200, 60, 110.0, 170.0).stand(60, alt=170.0)
        recorder.go(200, 70, 170.0, 600.0).go(600, 100, 600.0)
        recorder.go(300, 90, 600.0, 100.0).go(10, 20).stand(120)

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert self._starts_as_without_times(recorder, trimmed)

    def test_an_ultralight_climbing_out_slowly_keeps_its_climb_out(self):
        """Under TRIM_FLIGHT_KNOTS to 70 m above the field, then fast: the
        fast stretch starts above the field."""
        recorder = _Recorder().stand(600).go(120, 10).go(60, 30, 100.0, 170.0)
        recorder.go(300, 70, 170.0, 600.0).go(600, 70, 600.0)
        recorder.go(300, 70, 600.0, 100.0).go(20, 45).go(120, 10).stand(60)

        trimmed = trim_path_ends(recorder.fixes, 300)

        assert self._starts_as_without_times(recorder, trimmed)

    def test_times_that_run_backwards_trim_as_without_times(self):
        recorder = _flight(_Recorder().stand(60))
        fixes = recorder.fixes
        fixes[100] = fixes[100]._replace(ts=0.0)

        untimed = [point._replace(ts=None) for point in fixes]
        assert [point[:2] for point in trim_path_ends(fixes, 300)] == [
            point[:2] for point in trim_path_ends(untimed, 300)
        ]
