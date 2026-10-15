"""Tests for the wire format of the exported segment rows.

The encoding only pays off if it is lossless for the values the exporter
actually writes, so the round trip is checked over generated data as well as
over the fixed cases below. ``tests/frontend/unit/services/yearDecode.test.ts``
and the contract test cover the decoder the browser runs.
"""

import pytest
from hypothesis import given
from hypothesis import strategies as st

from flown.segment_codec import (
    COORDINATE_SCALE,
    FORMAT_VERSION,
    GROUND_STEP,
    decode_ground,
    decode_rows,
    encode_ground,
    encode_rows,
    encode_start,
)
from flown.types import COORDINATE_DECIMALS

# The exporter's own rounding, which is what the format relies on
coordinates = st.floats(-180, 180).map(lambda v: round(v, COORDINATE_DECIMALS))
altitudes = st.integers(-1_000, 60_000).map(lambda v: float(v * 100))
speeds = st.integers(0, 1000).map(float)
times = st.floats(0, 100_000).map(lambda v: round(v, 1))
starts = st.tuples(coordinates, coordinates).map(list)


@st.composite
def rows(draw):
    """A list of rows the way process_path_segments builds them.

    Each row has a relative time or not, independently of the others.
    """
    untimed = st.tuples(coordinates, coordinates, altitudes, speeds).map(list)
    timed = st.tuples(coordinates, coordinates, altitudes, speeds, times).map(list)
    return draw(st.lists(st.one_of(untimed, timed), max_size=30))


class TestRoundTrip:
    @given(start=starts, path_rows=rows())
    def test_decoding_gives_the_rows_back(self, start, path_rows):
        encoded = encode_rows(start, path_rows)

        assert decode_rows(encode_start(start), encoded) == path_rows

    @given(start=starts, path_rows=rows())
    def test_everything_written_is_an_integer(self, start, path_rows):
        """Integers are the point: floats would undo the size win."""
        assert all(isinstance(value, int) for value in encode_start(start))
        for column in encode_rows(start, path_rows):
            assert all(isinstance(value, int | None) for value in column)

    @given(start=starts, path_rows=rows())
    def test_every_column_has_a_value_per_row(self, start, path_rows):
        columns = encode_rows(start, path_rows)

        assert len(columns) in (4, 5)
        assert all(len(column) == len(path_rows) for column in columns)


class TestEncoding:
    def test_the_first_row_is_a_difference_to_the_start(self):
        start = [50.0, 8.0]
        encoded = encode_rows(start, [[50.00001, 8.00002, 500.0, 2.0, 2.0]])

        assert encoded == [[1], [2], [25], [2], [20]]

    def test_rows_are_written_column_by_column(self):
        """A column of repeating differences is what gzip compresses best.

        The coordinates are second differences, so a steady course is a
        column of zeros after its first step.
        """
        path_rows = [
            [50.00001, 8.0, 500.0, 90.0, 1.0],
            [50.00002, 8.0, 520.0, 90.0, 2.0],
            [50.00003, 8.0, 540.0, 90.0, 3.0],
        ]

        encoded = encode_rows([50.0, 8.0], path_rows)

        assert encoded == [[1, 0, 0], [0, 0, 0], [25, 1, 1], [90, 0, 0], [10] * 3]

    def test_a_still_aircraft_encodes_to_zeros(self):
        """Repetition is what makes the format small."""
        row = [50.1, 8.1, 500.0, 0.0, 10.0]
        encoded = encode_rows([50.1, 8.1], [row, row, row])

        assert [column[1:] for column in encoded] == [[0, 0]] * 5

    def test_the_start_is_scaled_to_integers(self):
        assert encode_start([50.0, 8.0]) == [
            50 * COORDINATE_SCALE,
            8 * COORDINATE_SCALE,
        ]

    def test_an_empty_path_encodes_to_empty_columns(self):
        assert encode_rows([], []) == [[], [], [], []]
        assert encode_start([]) == []
        assert decode_rows([], [[], [], [], []]) == []

    def test_without_relative_times_there_is_no_time_column(self):
        encoded = encode_rows([50.0, 8.0], [[50.1, 8.1, 500.0, 1.0]])

        assert len(encoded) == 4

    def test_a_gap_in_the_time_column_does_not_shift_the_rows_after_it(self):
        """A row without a time keeps the running time where it was."""
        path_rows = [
            [50.0, 8.0, 500.0, 1.0, 10.0],
            [50.1, 8.1, 500.0, 1.0],
            [50.2, 8.2, 500.0, 1.0, 30.0],
        ]
        encoded = encode_rows([50.0, 8.0], path_rows)

        assert encoded[4] == [100, None, 200]
        assert decode_rows(encode_start([50.0, 8.0]), encoded) == path_rows

    def test_an_altitude_off_the_20_ft_grid_is_refused(self):
        """The altitude column is written in steps of 20 ft."""
        with pytest.raises(ValueError, match="multiple of 20"):
            encode_rows([50.0, 8.0], [[50.1, 8.1, 550.0, 1.0]])

    def test_a_groundspeed_off_whole_knots_is_refused(self):
        """The speed column is written in whole knots, as the exporter rounds."""
        with pytest.raises(ValueError, match="whole number of knots"):
            encode_rows([50.0, 8.0], [[50.1, 8.1, 500.0, 92.5]])

    def test_the_coordinates_are_second_differences(self):
        """What is written is the change of the step, not the step."""
        path_rows = [
            [50.00002, 8.0, 500.0, 90.0],
            [50.00005, 8.0, 500.0, 90.0],
            [50.00007, 8.0, 500.0, 90.0],
            [50.00007, 8.0, 500.0, 90.0],
        ]

        encoded = encode_rows([50.0, 8.0], path_rows)

        # Steps of 2, 3, 2 and 0
        assert encoded[0] == [2, 1, -1, -2]
        assert decode_rows(encode_start([50.0, 8.0]), encoded) == path_rows

    def test_a_row_without_a_time_keeps_the_coordinates_in_step(self):
        """The second differences run on over a row that has no time."""
        path_rows = [
            [50.00001, 8.0, 500.0, 90.0, 1.0],
            [50.00002, 8.0, 500.0, 90.0],
            [50.00003, 8.0, 500.0, 90.0, 3.0],
        ]

        encoded = encode_rows([50.0, 8.0], path_rows)

        assert encoded[0] == [1, 0, 0]
        assert decode_rows(encode_start([50.0, 8.0]), encoded) == path_rows

    def test_whole_knots_are_written_as_they_are(self):
        """No scale: a difference of 3 kt is a 3, not a 30."""
        columns = encode_rows(
            [50.0, 8.0], [[50.1, 8.1, 500.0, 90.0], [50.2, 8.2, 500.0, 93.0]]
        )

        assert columns[3] == [90, 3]

    @pytest.mark.parametrize("value", [0.0, -0.00001, 179.99999, -179.99999])
    def test_coordinate_extremes_survive(self, value):
        row = [value, value, 0.0, 0.0]

        decoded = decode_rows(encode_start([0.0, 0.0]), encode_rows([0.0, 0.0], [row]))

        assert decoded == [row]


def test_the_format_version_is_pinned():
    """Bumping it is a deliberate act; the frontend checks the same number."""
    assert FORMAT_VERSION == 7


grounds = st.lists(
    st.integers(-50_000, 300_000).map(lambda v: float(v * GROUND_STEP)), max_size=30
)


class TestGround:
    @given(grounds)
    def test_round_trip(self, ground):
        column = encode_ground(ground)

        assert all(isinstance(value, int) for value in column)
        assert decode_ground(column) == ground

    def test_is_stored_in_steps_as_differences(self):
        assert encode_ground([1200.0, 1210.0, 1210.0, 1180.0]) == [120, 1, 0, -3]

    def test_refuses_a_ground_off_the_step(self):
        with pytest.raises(ValueError, match="not a multiple"):
            encode_ground([1205.0])

    def test_an_empty_column(self):
        assert encode_ground([]) == []
        assert decode_ground([]) == []
