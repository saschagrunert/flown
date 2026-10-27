"""Tests for the landing detector (flown.landings).

Most flights here are drawn leg by leg around a made-up field, so each rule
of the detector is tried on its own; the sample flights of data/ and the
fixture airport and runway databases check that it reads a real log.
"""

import math
import os
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

import flown.airport_lookup as lookup_module
import flown.landings as landings_module
from flown.airport_lookup import (
    REQUIRE_DATABASE_ENV,
    AirportRecord,
    RunwayEnd,
    load_runway_database,
)
from flown.constants import FEET_TO_METERS
from flown.data_exporter import export_all_data
from flown.exceptions import AirportDatabaseError
from flown.geometry import planar_km
from flown.landings import (
    FIELD_RADIUS_KM,
    Field,
    FieldIndex,
    FlightLandings,
    detect_landings,
    detect_path_landings,
    field_index,
    name_airports,
    path_landings,
)
from flown.parser import parse_and_cache
from flown.types import PathMetadata, TrackPoint
from tests.conftest import parse_data, parse_kml_coordinates

DATA_DIR = Path(__file__).parent.parent / "data"
# Takeoffs, full stops, touch-and-goes and go-arounds of the first sample
# flights, with the fixture airport and runway databases; flights added to
# data/ after them are read but left out of the totals
COUNTED_FLIGHTS = 103
TOTALS = [109, 87, 161, 19]

# A field with one runway, 09/27, and the altitude its logger reads there
FIELD = Field("EXMP", 50.0, 8.0, 500.0, (RunwayEnd("09", 90.0), RunwayEnd("27", 270.0)))
FIELDS = FieldIndex([FIELD])
LOGGED_GROUND_FT = 520.0
KNOTS_TO_METRES_PER_SECOND = 1852 / 3600
FIX_SECONDS = 5


class Flight:
    """A track drawn leg by leg: a fix every ``fix_seconds`` seconds."""

    def __init__(
        self, lat=50.0, lon=8.004, alt_ft=LOGGED_GROUND_FT, fix_seconds=FIX_SECONDS
    ):
        self.lat, self.lon, self.alt_ft, self.t = lat, lon, alt_ft, 0.0
        self.fix_seconds = fix_seconds
        self.points = [self._point()]

    def _point(self):
        return TrackPoint(self.lat, self.lon, self.alt_ft * FEET_TO_METERS, self.t)

    def leg(self, seconds, knots, fpm=0.0, heading=270.0, floor=LOGGED_GROUND_FT):
        """Fly ``seconds`` at a groundspeed, a vertical speed and a heading.

        The altitude never goes below ``floor``, the ground as logged.
        """
        for _ in range(round(seconds / self.fix_seconds)):
            metres = knots * KNOTS_TO_METRES_PER_SECOND * self.fix_seconds
            self.lat += metres * math.cos(math.radians(heading)) / 111_320
            self.lon += (
                metres
                * math.sin(math.radians(heading))
                / (111_320 * math.cos(math.radians(self.lat)))
            )
            self.alt_ft = max(floor, self.alt_ft + fpm * self.fix_seconds / 60)
            self.t += self.fix_seconds
            self.points.append(self._point())
        return self

    def takeoff(self):
        """Taxi, roll and climb 1000 ft westward off runway 27."""
        return self.leg(60, 10).leg(20, 55).leg(120, 70, 500)

    def circuit(self):
        """Crosswind, downwind and a base leg down to 500 ft above the field."""
        return self.leg(60, 90, 0, 0).leg(150, 90, 0, 90).leg(60, 80, -500, 180)

    def final(self, lowest_ft=LOGGED_GROUND_FT, heading=270.0):
        """Descend on runway 27 to ``lowest_ft`` (the ground by default)."""
        return self.leg(90, 70, -500, heading, lowest_ft)

    def stop(self):
        """Roll out and taxi off."""
        return self.leg(10, 55).leg(10, 30).leg(30, 10)

    def touch_and_go(self):
        """Roll on the runway and climb away."""
        return self.leg(10, 55).leg(80, 70, 700)


def _detect(flight_or_points, fields=FIELDS) -> FlightLandings:
    """What a timed flight did, which the detector always reads."""
    points = getattr(flight_or_points, "points", flight_or_points)
    found = detect_path_landings(points, fields)
    assert found is not None
    return found


def _nearest(
    index: FieldIndex, lat: float, lon: float, radius_km: float = FIELD_RADIUS_KM
) -> Field:
    near = index.nearest(lat, lon, radius_km)
    assert near is not None
    return near[0]


class TestTheRules:
    def test_a_takeoff_and_a_full_stop(self):
        flight = Flight().takeoff().circuit().final().stop()

        assert _detect(flight) == FlightLandings(
            takeoffs=1,
            landings=1,
            touchdowns=[("EXMP", "27")],
            departure="EXMP",
            arrival="EXMP",
        )

    def test_a_touch_and_go_climbs_away_without_stopping(self):
        flight = Flight().takeoff().circuit().final().touch_and_go()
        flight.circuit().final().stop()

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes, found.go_arounds) == (1, 1, 0)
        assert found.touchdowns == [("EXMP", "27"), ("EXMP", "27")]
        # A touch-and-go is no arrival; the full stop after it is
        assert (found.departure, found.arrival) == ("EXMP", "EXMP")

    def test_the_departure_is_the_field_of_the_first_takeoff_alone(self):
        """A takeoff 14 km east of the field, where the database has none,
        then a full stop at the field and a takeoff from it (regression: the
        second takeoff was the departure)."""
        flight = (
            Flight(lon=8.204)
            .takeoff()
            .leg(310, 90, 0, 270)
            .circuit()
            .final()
            .stop()
            .takeoff()
        )

        found = _detect(flight)

        assert (found.takeoffs, found.landings) == (2, 1)
        assert found.departure is None

    def test_a_takeoff_after_the_last_full_stop_leaves_no_arrival(self):
        """It left for a field the landings never saw (regression)."""
        flight = Flight().takeoff().circuit().final().stop().takeoff().leg(600, 100)

        found = _detect(flight)

        assert (found.takeoffs, found.landings) == (2, 1)
        assert (found.departure, found.arrival) == ("EXMP", None)

    def test_a_touch_and_go_slower_than_the_contact_speed_is_a_go_around(self):
        """Between STOP_KNOTS and CONTACT_KNOTS no contact is recorded.

        A touch-and-go at 30 kt over the ground (into a strong headwind) is
        therefore counted as a go-around, the same flight at 40 kt as a
        touch-and-go. This documents the rule; it is not a goal.
        """
        slow = Flight().takeoff().circuit().leg(90, 30, -500).leg(10, 30)
        slow.leg(80, 30, 700).circuit().final().stop()
        fast = Flight().takeoff().circuit().leg(90, 40, -500).leg(10, 40)
        fast.leg(80, 40, 700).circuit().final().stop()

        slow_found, fast_found = _detect(slow), _detect(fast)

        assert (slow_found.touch_and_goes, slow_found.go_arounds) == (0, 1)
        assert (fast_found.touch_and_goes, fast_found.go_arounds) == (1, 0)

    def test_the_takeoff_roll_is_no_touch_and_go(self):
        """A touchdown only counts after a climb of 400 ft."""
        flight = Flight().takeoff().leg(300, 90, 0, 0)

        found = _detect(flight)

        assert (found.takeoffs, found.landings, found.touch_and_goes) == (1, 0, 0)

    def test_a_go_around_on_the_runway(self):
        """Low over the runway and away again, without touching down."""
        flight = Flight().takeoff().circuit().final(LOGGED_GROUND_FT + 150)
        flight.leg(80, 70, 700).circuit().final().stop()

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes, found.go_arounds) == (1, 0, 1)
        assert found.touchdowns == [("EXMP", "27")]

    def test_the_climb_away_is_one_go_around(self):
        """Through the approach band once, however often the logger writes.

        From 70 ft a fix every second is still below 400 ft when the climb
        of 300 ft is complete, and the climb on from there is no second one.
        """
        flight = Flight(fix_seconds=1).takeoff().circuit()
        flight.final(LOGGED_GROUND_FT + 70).leg(80, 70, 700).circuit().final().stop()

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes, found.go_arounds) == (1, 0, 1)

    def test_a_low_pass_without_a_roll_is_a_go_around(self):
        """Down to 10 ft over the runway at one fix and climbing at the next.

        Within CONTACT_FT of the ground, but never rolling on it (regression:
        it was a touch-and-go).
        """
        flight = Flight().takeoff().circuit().leg(60, 70, -490)
        flight.leg(80, 70, 700).circuit().final().stop()

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes, found.go_arounds) == (1, 0, 1)
        assert found.touchdowns == [("EXMP", "27")]

    def test_a_level_pass_above_the_earlier_rolls_is_a_go_around(self):
        """Level, but 25 ft above where the touch-and-go rolled."""
        flight = Flight().takeoff().circuit().final().touch_and_go()
        flight.circuit().final(LOGGED_GROUND_FT + 25).leg(80, 70, 700)
        flight.circuit().final().stop()

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes, found.go_arounds) == (1, 1, 1)
        assert found.touchdowns == [("EXMP", "27"), ("EXMP", "27")]

    def test_a_roll_between_sparse_fixes_cannot_be_told(self):
        """A fix every 10 s: the low pass stays a touch-and-go."""
        flight = Flight(fix_seconds=10).takeoff().circuit().leg(60, 70, -490)
        flight.leg(80, 70, 700).circuit().final().stop()

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes, found.go_arounds) == (1, 1, 0)

    def test_a_fix_lost_beside_the_low_stretch_cannot_be_told(self):
        """Two fixes 5 s apart near the ground, after a gap of 10 s.

        The stretch is too short for a roll, but one could hide in the gap:
        the fix the logger lost.
        """
        flight = Flight().takeoff().circuit().leg(60, 70, -490)
        lowest = len(flight.points) - 1
        flight.leg(80, 70, 700).circuit().final().stop()
        flight.points[lowest + 1] = flight.points[lowest + 1]._replace(
            alt=(LOGGED_GROUND_FT + 8) * FEET_TO_METERS
        )
        del flight.points[lowest - 1]

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes, found.go_arounds) == (1, 1, 0)

    def test_a_roll_with_a_lost_altitude_is_no_earlier_roll(self):
        """The logger reads 300 ft under the ground through the first roll.

        Kept as the first roll's lowest point, it would put the second one
        300 ft above it and make it a go-around.
        """
        flight = Flight().takeoff().circuit().final()
        lost = len(flight.points) - 4
        flight.touch_and_go().circuit().final().touch_and_go()
        flight.circuit().final().stop()
        for index in range(lost, lost + 5):
            flight.points[index] = flight.points[index]._replace(
                alt=(LOGGED_GROUND_FT - 300) * FEET_TO_METERS
            )

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes, found.go_arounds) == (1, 2, 0)

    def test_a_low_pass_across_the_runway_is_nothing(self):
        """No roll and no runway to line up with: neither of the two."""
        flight = Flight().takeoff().leg(60, 90, 0, 0).leg(60, 90, 0, 90)
        flight.leg(60, 80, -500, 180).leg(60, 80, -490, 180).leg(80, 70, 700, 180)
        flight.leg(60, 90, 0, 270).circuit().final().stop()

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes, found.go_arounds) == (1, 0, 0)

    def test_a_low_pass_across_the_runways_is_no_go_around(self):
        flight = Flight().takeoff().leg(60, 90, 0, 0).leg(60, 90, 0, 90)
        flight.leg(60, 80, -500, 180).leg(60, 80, 0, 180, LOGGED_GROUND_FT + 150)
        flight.leg(80, 70, 700, 180)

        assert _detect(flight).go_arounds == 0

    def test_a_stop_far_above_the_field_is_no_landing(self):
        """A gap in the timestamps reads as a stop wherever it happens."""
        flight = Flight().takeoff().leg(60, 90, 0, 0).leg(120, 5, 0, 90)
        flight.leg(60, 90, 0, 180).leg(60, 90, 0, 270)

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes) == (0, 0)

    def test_a_dropped_altitude_is_no_touchdown(self):
        """Some loggers lose the altitude for a fix or two now and then."""
        flight = Flight().takeoff().circuit()
        # On the downwind leg, at the ground of the field
        for index in (-25, -24):
            flight.points[index] = flight.points[index]._replace(
                alt=LOGGED_GROUND_FT * FEET_TO_METERS
            )
        flight.final().stop()

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes, found.go_arounds) == (1, 0, 0)

    def test_the_logger_offset_moves_the_ground(self):
        """A logger reading 300 ft high still lands on the field."""
        high = LOGGED_GROUND_FT + 300
        flight = Flight(alt_ft=high).leg(60, 10, floor=high).leg(20, 55, floor=high)
        flight.leg(120, 70, 500, floor=high).leg(60, 90, 0, 0).leg(150, 90, 0, 90)
        flight.leg(60, 80, -500, 180).leg(90, 70, -500, 270, high)
        flight.leg(10, 55, floor=high).leg(40, 10, floor=high)

        found = _detect(flight)

        assert (found.takeoffs, found.landings) == (1, 1)

    def test_a_flight_that_starts_in_the_air_can_land(self):
        flight = Flight(alt_ft=LOGGED_GROUND_FT + 1000).circuit().final().stop()

        found = _detect(flight)

        assert (found.takeoffs, found.landings) == (0, 1)

    def test_the_runway_is_the_nearest_end(self):
        """Snapped to the runway list, whatever the variation."""
        field = FIELD._replace(runways=(RunwayEnd("08", 84.0), RunwayEnd("26", 264.0)))
        flight = Flight().takeoff().circuit().final().stop()

        found = _detect(flight, FieldIndex([field]))

        assert found.touchdowns == [("EXMP", "26")]

    def test_no_runway_far_off_the_track(self):
        field = FIELD._replace(runways=(RunwayEnd("18", 180.0), RunwayEnd("36", 0.0)))
        flight = Flight().takeoff().circuit().final().stop()

        found = _detect(flight, FieldIndex([field]))

        assert found.touchdowns == [("EXMP", None)]

    def test_a_field_without_an_elevation_stands_on_its_taxiing(self):
        field = FIELD._replace(elevation_ft=None)
        flight = Flight().takeoff().circuit().final().stop()

        found = _detect(flight, FieldIndex([field]))

        assert (found.takeoffs, found.landings) == (1, 1)

    def test_a_field_without_runways_gives_none(self):
        """And a go-around there needs no runway to line up with."""
        field = FIELD._replace(runways=())
        flight = Flight().takeoff().circuit().final(LOGGED_GROUND_FT + 150)
        flight.leg(80, 70, 700).circuit().final().stop()

        found = _detect(flight, FieldIndex([field]))

        assert found.touchdowns == [("EXMP", None)]
        assert found.go_arounds == 1

    def test_down_and_stopped_between_two_fixes(self):
        """A gap in the log over the touchdown and the roll."""
        flight = Flight().takeoff().circuit().final(LOGGED_GROUND_FT + 200)
        flight.t += 60
        flight.lon -= 0.001
        flight.alt_ft = LOGGED_GROUND_FT
        flight.leg(60, 5)

        found = _detect(flight)

        assert (found.landings, found.touch_and_goes) == (1, 0)
        # The fixes before the gap are more than half a minute away: no track
        assert found.touchdowns == [("EXMP", None)]

    def test_a_log_that_ends_on_the_runway_lands(self):
        flight = Flight().takeoff().circuit().final().leg(10, 55)

        found = _detect(flight)

        assert (found.landings, found.touchdowns) == (1, [("EXMP", "27")])

    def test_a_log_that_ends_in_the_takeoff_roll(self):
        flight = Flight().leg(60, 10).leg(20, 55)

        assert _detect(flight).takeoffs == 0

    def test_nothing_is_read_from_an_untimed_flight(self):
        flight = Flight().takeoff().circuit().final().stop()
        untimed = [point._replace(ts=None) for point in flight.points]

        assert detect_path_landings(untimed, FIELDS) is None

    def test_a_clock_that_runs_backwards_is_not_read(self):
        flight = Flight().takeoff().circuit().final().stop()
        points = list(flight.points)
        points[5], points[6] = points[6], points[5]

        assert detect_path_landings(points, FIELDS) is None

    def test_no_field_no_landing(self):
        """A takeoff counts anywhere, a touchdown only at a field."""
        flight = Flight().takeoff().circuit().final().stop()

        found = _detect(flight, FieldIndex([]))

        assert found == FlightLandings(takeoffs=1)

    def test_a_circuit_across_the_antimeridian(self):
        """The field on the 180th meridian, half the circuit to the west of it
        and half to the east, where the longitudes start again at -180."""
        field = FIELD._replace(ident="ANTI", lon=180.0)
        flight = Flight().takeoff().circuit().final().stop()
        points = [
            point._replace(lon=(point.lon + 172.0 + 180.0) % 360.0 - 180.0)
            for point in flight.points
        ]
        assert min(point.lon for point in points) < 0 < max(p.lon for p in points)

        assert _detect(points, FieldIndex([field])) == FlightLandings(
            takeoffs=1,
            landings=1,
            touchdowns=[("ANTI", "27")],
            departure="ANTI",
            arrival="ANTI",
        )

    def test_the_first_fixes_of_a_receiver_share_a_time(self):
        """Their scatter reads as speed; the recording still starts on the ground."""
        flight = Flight().takeoff().circuit().final().stop()
        scattered = [
            TrackPoint(50.0 + i * 0.001, 8.004, LOGGED_GROUND_FT * FEET_TO_METERS, 0.0)
            for i in range(5)
        ]

        found = _detect(scattered + flight.points[1:])

        assert (found.takeoffs, found.landings) == (1, 1)


class TestFieldIndex:
    def test_the_nearest_field_within_the_radius(self):
        near = Field("NEAR", 50.01, 8.0, 0.0)
        far = Field("FARR", 50.03, 8.0, 0.0)
        index = FieldIndex([far, near])

        assert _nearest(index, 50.0, 8.0) is near
        assert index.nearest(50.0, 8.0, radius_km=0.5) is None
        assert len(index) == 2

    def test_fields_across_a_cell_boundary(self):
        index = FieldIndex([Field("EAST", 50.0, 8.0001, 0.0)])

        assert _nearest(index, 50.0, 7.9999).ident == "EAST"

    def test_a_field_two_cells_away_in_the_far_north(self):
        """At 70 degrees a cell is 3.8 km wide; 4.5 km east is two cells on."""
        index = FieldIndex([Field("NORD", 70.0, 8.217, 0.0)])

        assert _nearest(index, 70.0, 8.099).ident == "NORD"

    def test_fields_across_the_antimeridian(self):
        index = FieldIndex([Field("EAST", 50.0, -179.9999, 0.0)])

        near = index.nearest(50.0, 179.9999)
        assert near is not None
        assert near[0].ident == "EAST"
        # 0.0002 degrees of longitude at 50 degrees north, not 359.9998
        assert near[1] == pytest.approx(0.0143, abs=1e-4)
        assert _nearest(index, 50.0, 180.0).ident == "EAST"

    @settings(max_examples=200, deadline=None)
    @given(
        st.lists(
            st.tuples(
                st.floats(-85.0, 85.0), st.floats(-180.0, 179.999), st.booleans()
            ),
            min_size=1,
            max_size=20,
        ),
        st.floats(-85.0, 85.0),
        st.floats(-180.0, 179.999),
        st.floats(-0.05, 0.05),
        st.floats(-0.2, 0.2),
    )
    def test_the_same_as_looking_at_every_field(self, places, lat, lon, d_lat, d_lon):
        """The cells kept per cell miss none, wherever in it the fix is."""
        fields = [
            # Some right next to the fix, wherever the others are
            Field(
                f"F{i}",
                lat + d_lat if close else p_lat,
                lon + d_lon if close else p_lon,
                0.0,
            )
            for i, (p_lat, p_lon, close) in enumerate(places)
        ]
        index = FieldIndex(fields)
        # A first fix in the cell keeps its fields for the second one
        index.nearest(math.floor(lat * 10) / 10 + 0.0001, lon)
        found = index.nearest(lat, lon)
        distances = [planar_km(lat, lon, f.lat, f.lon) for f in fields]
        within = [d for d in distances if d <= FIELD_RADIUS_KM]
        if not within:
            assert found is None
        else:
            assert found is not None
            assert found[1] == min(within)

    def test_only_airports_with_runways_are_fields(self):
        airports = {
            "EDAQ": AirportRecord(51.55, 12.05, "Halle-Oppin", "DE", 106.0),
            "EDXX": AirportRecord(51.0, 12.0, "Hospital heliport", "DE"),
        }
        runways = {"EDAQ": (RunwayEnd("11", 109.0), RunwayEnd("29", 289.0))}

        index = field_index(airports, runways)

        assert len(index) == 1
        field = _nearest(index, 51.55, 12.05)
        assert field.ident == "EDAQ"
        assert field.elevation_ft == pytest.approx(106.0 / FEET_TO_METERS)
        assert field.runways == runways["EDAQ"]

    def test_without_a_runway_list_every_airport_is_a_field(self):
        airports = {"EDXX": AirportRecord(51.0, 12.0, "Somewhere", "DE")}

        index = field_index(airports, {})

        assert len(index) == 1
        assert _nearest(index, 51.0, 12.0).elevation_ft is None


@pytest.mark.repo_data
class TestSampleFlights:
    """The fixture databases hold EDAQ and its runways 11/29."""

    def _landings(self, name):
        _, groups, _ = parse_kml_coordinates(str(DATA_DIR / name))
        return _detect(groups[0], field_index())

    def test_circuits_at_the_home_field(self):
        found = self._landings("2_DEAGJ_DA20.kml")

        assert (found.takeoffs, found.landings, found.touch_and_goes) == (1, 1, 7)
        assert found.go_arounds == 0
        assert found.touchdowns == [("EDAQ", "29")] * 8

    def test_the_other_runway(self):
        found = self._landings("75_DEHYL_DA40.kml")

        assert found.touchdowns == [("EDAQ", "11")]

    def test_a_flight_with_glitches_in_its_log(self):
        """Altitudes of 0 and a lost fix near EDAQ read as no touchdown."""
        found = self._landings("88_DELGD_C182.kml")

        # LOAG, where it landed, is not in the fixture database
        assert (found.takeoffs, found.landings, found.touch_and_goes) == (1, 0, 0)

    def test_every_sample_flight_is_read(self):
        paths = {}
        for kml in DATA_DIR.glob("*.kml"):
            _, groups, _ = parse_kml_coordinates(str(kml))
            paths[int(kml.name.split("_")[0])] = groups[0]

        found = detect_landings(paths)

        assert len(found) == len(paths)
        # Every touchdown is on a runway of its field
        runways = load_runway_database()
        for landings in found.values():
            for airport, runway in landings.touchdowns:
                assert runway in {end.designator for end in runways[airport]}
        # What the fixture databases let it find; with the full ones the
        # counted flights land 110 times and touch and go 173 times
        counted = [found[number] for number in range(1, COUNTED_FLIGHTS + 1)]
        totals = [
            sum(getattr(landings, key) for landings in counted)
            for key in ("takeoffs", "landings", "touch_and_goes", "go_arounds")
        ]
        assert totals == TOTALS


class TestDetectLandings:
    def test_without_an_airport_database_nothing_is_counted(self, caplog):
        flight = Flight().takeoff().circuit().final().stop()

        assert detect_landings({1: flight.points}, FieldIndex([])) == {}
        assert "landings are not counted" in caplog.text

    def test_untimed_paths_are_left_out(self):
        timed = Flight().takeoff().circuit().final().stop().points
        untimed = [point._replace(ts=None) for point in timed]

        found = detect_landings({1: timed, 2: untimed}, FIELDS)

        assert list(found) == [1]


class TestNameAirports:
    """The airports of a path whose name tells none (fixture databases)."""

    LANDED = FlightLandings(takeoffs=1, landings=1, departure="EDAQ", arrival="EDDP")

    def _named(self, name, landings=LANDED, **keys):
        metadata = cast("PathMetadata", {"airport_name": name, **keys})
        name_airports(metadata, landings)
        return metadata.get("start_airport"), metadata.get("end_airport")

    def test_a_name_without_an_airport_gets_the_fields(self):
        assert self._named("Flight with Anna") == (
            "EDAQ Halle-Oppin",
            "EDDP Leipzig/Halle",
        )

    def test_a_field_the_database_does_not_name_keeps_its_code(self):
        found = FlightLandings(takeoffs=1, departure="EXMP")
        assert self._named("Flight", found) == ("EXMP", None)

    def test_a_recording_that_starts_in_the_air_gets_the_arrival_alone(self):
        found = FlightLandings(landings=1, arrival="EDDP")
        assert self._named("Flight", found) == (None, "EDDP Leipzig/Halle")

    @pytest.mark.parametrize(
        ("name", "keys"),
        [
            # A single airport, a route with codes and one without
            ("EDDS", {}),
            ("EDDS - EDDF", {"start_airport": "EDDS", "end_airport": "EDDF"}),
            ("Home strip - Aunt farm", {"start_airport": "Home strip"}),
        ],
    )
    def test_a_name_that_tells_its_airports_keeps_them(self, name, keys):
        assert self._named(name, **keys) == (
            keys.get("start_airport"),
            keys.get("end_airport"),
        )

    def test_a_parse_names_them(self, tmp_path):
        """Through the parse, which keeps them with its landings."""
        lat, lon = 51.552223, 12.053889
        flight = Flight(lat, lon + 0.004).takeoff().circuit().final().stop()
        whens = "".join(
            f"<when>{datetime.fromtimestamp(1742032800 + p.ts, UTC):%Y-%m-%dT%H:%M:%SZ}"
            f"</when><gx:coord>{p.lon} {p.lat} {p.alt}</gx:coord>"
            for p in flight.points
        )
        kml_file = tmp_path / "1_DEAGJ_DA20.kml"
        kml_file.write_text(
            '<kml xmlns="http://www.opengis.net/kml/2.2" '
            'xmlns:gx="http://www.google.com/kml/ext/2.2"><Document><Placemark>'
            f"<name>Flight</name><gx:Track>{whens}</gx:Track></Placemark>"
            "</Document></kml>",
            encoding="utf-8",
        )

        (_, _, metadata), _ = parse_and_cache(str(kml_file), None, path_landings)

        assert metadata[0]["airport_name"] == "Flight"
        assert (metadata[0]["start_airport"], metadata[0]["end_airport"]) == (
            "EDAQ Halle-Oppin",
            "EDAQ Halle-Oppin",
        )

    def test_without_landings_nothing_changes(self):
        assert self._named("Flight", None) == (None, None)
        assert self._named("Flight", FlightLandings()) == (None, None)


class TestExport:
    def test_the_path_info_carries_the_landings(self, tmp_path):
        """At EDAQ of the fixture databases, landing on its runway 29."""
        lat, lon = 51.552223, 12.053889
        flight = Flight(lat, lon + 0.004).takeoff().circuit().final().touch_and_go()
        flight.circuit().final().stop()
        # Not the same flight, which the export would leave out as a copy
        untimed = [
            point._replace(lat=point.lat + 0.1, ts=None) for point in flight.points
        ]
        metadata: PathMetadata = {
            "start_point": [lat, lon + 0.004],
            "airport_name": "EDAQ Halle-Oppin",
            "year": 2025,
        }

        export_all_data(
            [flight.points, untimed],
            [metadata, metadata],
            [],
            tmp_path,
            available_flags=[],
        )

        timed_info, untimed_info = parse_data(tmp_path / "2025" / "data.json")[
            "path_info"
        ]
        assert (
            timed_info["landings"],
            timed_info["touch_and_goes"],
            timed_info["go_arounds"],
        ) == (1, 1, 0)
        assert timed_info["touchdowns"] == [["EDAQ", "29"], ["EDAQ", "29"]]
        for key in ("landings", "touch_and_goes", "go_arounds", "touchdowns"):
            assert key not in untimed_info


_RUNWAY_HEADER = (
    "airport_ident,closed,le_ident,le_latitude_deg,le_longitude_deg,"
    "le_heading_degT,he_ident,he_latitude_deg,he_longitude_deg,"
    "he_heading_degT\n"
)


def _read_runways(tmp_path, rows):
    """The runways of ``rows`` of a list, read as the cache is.

    See AirportDatabases.load_runways.
    """
    path = tmp_path / "runways.csv"
    path.write_text(_RUNWAY_HEADER + "\n".join(rows) + "\n", encoding="utf-8")
    loaded = lookup_module._read_database(
        path, lookup_module._runway_rows, lookup_module.RUNWAY_COLUMNS
    )
    assert loaded is not None
    return loaded[0]


class TestRunwayDatabase:
    def test_the_fixture_runways(self):
        runways = load_runway_database()

        assert runways["EDAQ"] == (RunwayEnd("11", 109.0), RunwayEnd("29", 289.0))
        # A closed runway is none, and neither is a helipad
        assert all(end.designator != "09" for end in runways["EDAU"])

    def test_designators_and_headings(self, tmp_path):
        rows = [
            # Headings from the list
            "AAAA,0,8L,,,84,26R,,,264",
            # From the thresholds
            "BBBB,0,18,50.01,8.0,,36,50.0,8.0,",
            # From the designator
            "CCCC,0,03,,,,21,,,",
            # One end has a heading, the other is derived
            "DDDD,0,,,,,27,,,268",
            # One end without a heading
            "GGGG,0,,,,,27,,,",
            # A pad and a closed runway are no runways
            "EEEE,0,H1,,,,,,,",
            "FFFF,1,09,,,90,27,,,270",
            # A code of another length is no ICAO code
            "DE-0001,0,09,,,90,27,,,270",
            # A true heading, gliders and ultralights, arrivals and departures
            "HHHH,0,16T,,,,34T,,,",
            "IIII,0,09G,,,,27U,,,",
            "JJJJ,0,10A,,,,28D,,,",
            # Compass points, with a letter for parallels, and a bearing
            "KKKK,0,N,,,,S,,,",
            "LLLL,0,NEL,,,,SWR,,,",
            "MMMM,0,,,,,S30W,,,",
            # A water lane and words are no runways
            "NNNN,0,09W,,,,27W,,,",
            "OOOO,0,ALL,,,,WAY,,,",
        ]
        runways = _read_runways(tmp_path, rows)

        assert runways["AAAA"] == (RunwayEnd("08L", 84.0), RunwayEnd("26R", 264.0))
        (low, high) = runways["BBBB"]
        assert (low.designator, high.designator) == ("18", "36")
        assert low.heading == pytest.approx(180.0)
        assert high.heading == pytest.approx(0.0)
        assert runways["CCCC"] == (RunwayEnd("03", 30.0), RunwayEnd("21", 210.0))
        assert runways["DDDD"] == (RunwayEnd("27", 268.0),)
        assert runways["GGGG"] == (RunwayEnd("27", 270.0),)
        assert runways["HHHH"] == (RunwayEnd("16T", 160.0), RunwayEnd("34T", 340.0))
        assert runways["IIII"] == (RunwayEnd("09G", 90.0), RunwayEnd("27U", 270.0))
        assert runways["JJJJ"] == (RunwayEnd("10A", 100.0), RunwayEnd("28D", 280.0))
        assert runways["KKKK"] == (RunwayEnd("N", 0.0), RunwayEnd("S", 180.0))
        assert runways["LLLL"] == (RunwayEnd("NEL", 45.0), RunwayEnd("SWR", 225.0))
        assert runways["MMMM"] == (RunwayEnd("S30W", 210.0),)
        assert set(runways) == {
            "AAAA",
            "BBBB",
            "CCCC",
            "DDDD",
            "GGGG",
            "HHHH",
            "IIII",
            "JJJJ",
            "KKKK",
            "LLLL",
            "MMMM",
        }

    def test_a_strip_beside_a_runway_is_left_out(self, tmp_path):
        """No track tells them apart: the runway keeps its name (LSZG, EDST)."""
        runways = _read_runways(
            tmp_path,
            [
                "AAAA,0,08,,,84,26,,,264",
                "AAAA,0,08G,,,86,26G,,,266",
                "AAAA,0,08L,,,86,26R,,,266",
                # Beside by the designators: a strip without thresholds or
                # headings has the magnetic heading of its designator
                "BBBB,0,12,,,135,30,,,315",
                "BBBB,0,12G,,,,30G,,,",
                # A water lane named by compass point
                "CCCC,0,01,,,5,19,,,185",
                "CCCC,0,N,,,,S,,,",
                # A strip across the runway stays, and so do the strips of a
                # field without a runway
                "DDDD,0,07,,,70,25,,,250",
                "DDDD,0,11U,,,,29U,,,",
                "EEEE,0,09G,,,,27G,,,",
                "FFFF,0,NE,,,,SW,,,",
            ],
        )

        def designators(ident):
            return [end.designator for end in runways[ident]]

        assert designators("AAAA") == ["08", "26", "08L", "26R"]
        assert designators("BBBB") == ["12", "30"]
        assert designators("CCCC") == ["01", "19"]
        assert designators("DDDD") == ["07", "25", "11U", "29U"]
        assert designators("EEEE") == ["09G", "27G"]
        assert designators("FFFF") == ["NE", "SW"]

        field = FIELD._replace(runways=runways["AAAA"])
        flight = Flight().takeoff().circuit().final().stop()
        found = _detect(flight, FieldIndex([field]))
        assert found.touchdowns == [("EXMP", "26R")]
        # A field of strips alone counts its landings on them
        field = FIELD._replace(runways=runways["EEEE"])
        found = _detect(flight, FieldIndex([field]))
        assert (found.landings, found.touchdowns) == (1, [("EXMP", "27G")])

    def test_a_wrong_heading_of_the_list_is_left_out(self, tmp_path):
        runways = _read_runways(
            tmp_path,
            [
                # The other end's (LKCE): the thresholds say which is which
                "AAAA,0,13,50.7115,14.5629,309,31,50.7074,14.5705,129",
                # Without thresholds, far off its designator (EGCJ)
                "BBBB,0,01,,,1,19,,,19",
                # ... where the number of the designator stands in for both
                # (EPKR), or a heading 90 off for one (IS41): neither end
                # takes the other's reversed
                "EEEE,0,16,,,16,34,,,34",
                "FFFF,0,09,,,,27,,,360",
                # Near the designator but not the thresholds: those are wrong
                "CCCC,0,09,50.0,8.01,92,27,50.0,8.0,272",
                # Off the thresholds by a little: the list is kept
                "DDDD,0,09,50.0,8.0,93,27,50.0,8.01,273",
            ],
        )

        (low, high) = runways["AAAA"]
        assert low.heading == pytest.approx(130.4, abs=0.1)
        assert high.heading == pytest.approx(310.4, abs=0.1)
        assert runways["BBBB"] == (RunwayEnd("01", 1.0), RunwayEnd("19", 181.0))
        assert runways["EEEE"] == (RunwayEnd("16", 160.0), RunwayEnd("34", 340.0))
        assert runways["FFFF"] == (RunwayEnd("09", 90.0), RunwayEnd("27", 270.0))
        assert runways["CCCC"] == (RunwayEnd("09", 92.0), RunwayEnd("27", 272.0))
        assert runways["DDDD"] == (RunwayEnd("09", 93.0), RunwayEnd("27", 273.0))

    def test_ends_that_name_two_strips_keep_their_headings(self, tmp_path):
        """EBHC: arrivals on 04, departures on 13."""
        runways = _read_runways(
            tmp_path,
            ["AAAA,0,04A,,,,13D,,,", "BBBB,0,04A,,,42,13D,,,", "CCCC,0,,,,,13D,,,"],
        )

        assert runways["AAAA"] == (RunwayEnd("04A", 40.0), RunwayEnd("13D", 130.0))
        assert runways["BBBB"] == (RunwayEnd("04A", 42.0), RunwayEnd("13D", 130.0))
        assert runways["CCCC"] == (RunwayEnd("13D", 130.0),)

    def test_a_missing_list_leaves_the_runways_out(self, monkeypatch, tmp_path):
        monkeypatch.setattr(lookup_module, "RUNWAYS_CACHE_FILE", tmp_path / "no.csv")
        monkeypatch.setattr(
            lookup_module, "RUNWAYS_DOWNLOAD_FAILED_MARKER", tmp_path / "failed"
        )
        (tmp_path / "failed").touch()

        assert load_runway_database() == {}

    def test_a_required_list_that_is_missing_fails(self, monkeypatch, tmp_path):
        monkeypatch.setattr(lookup_module, "RUNWAYS_CACHE_FILE", tmp_path / "no.csv")
        monkeypatch.setattr(
            lookup_module, "RUNWAYS_DOWNLOAD_FAILED_MARKER", tmp_path / "failed"
        )
        (tmp_path / "failed").touch()
        monkeypatch.setitem(os.environ, REQUIRE_DATABASE_ENV, "1")

        with pytest.raises(AirportDatabaseError, match=REQUIRE_DATABASE_ENV):
            load_runway_database()

    def test_a_list_that_cannot_be_read_leaves_the_runways_out(self, monkeypatch):
        def broken(path, rows, columns, stored=None):
            raise OSError("unreadable")

        monkeypatch.setattr(lookup_module, "_read_database", broken)

        assert load_runway_database() == {}

    def test_the_list_is_loaded_once_per_process(self):
        assert load_runway_database() is load_runway_database()


class TestFieldsOfThisProcess:
    def test_the_fields_are_built_once_for_the_databases(self):
        first = landings_module._fields_of_this_process()
        assert landings_module._fields_of_this_process() is first

    def test_the_fields_follow_the_databases_after_a_reset(self):
        """A refresh resets the databases: the fields come from the new ones."""
        before = landings_module._fields_of_this_process()
        lookup_module.databases.reset()
        lookup_module.databases.use(
            {"EXMP": AirportRecord(50.0, 8.0, "Example", "DE", 150.0)}
        )
        lookup_module.databases.runways = {"EXMP": FIELD.runways}

        after = landings_module._fields_of_this_process()

        assert after is not before
        assert len(after) == 1
