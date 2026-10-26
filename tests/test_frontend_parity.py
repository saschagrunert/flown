"""The numbers the frontend shares with the Python side.

The constants are read from the TypeScript sources of flown/frontend and
compared with the ones the exporter writes the data files with, so that one
side changed alone fails here rather than on the map.
"""

import ast
import operator
import re
from pathlib import Path

import pytest

import flown.terrain as terrain_module
import flown.terrain_fetch as fetch_module
from flown import browser, previews
from flown.constants import KM_TO_NAUTICAL_MILES, METERS_TO_FEET
from flown.geometry import METRES_PER_DEGREE
from flown.path_content import PATH_ID_BITS
from flown.segment_codec import (
    ALTITUDE_STEP,
    COORDINATE_SCALE,
    FORMAT_VERSION,
    GROUND_STEP,
    SPEED_SCALE,
    TIME_SCALE,
)
from flown.terrain import (
    TERRAIN_ZOOM,
    TILE_SIZE,
)

FRONTEND = Path(__file__).parent.parent / "flown" / "frontend"


_TS_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.Pow: operator.pow,
}


def _ts_evaluate(node, lookup):
    """A numeric TypeScript initializer, which Python parses the same way.

    Numbers, the four operators and ``**``, the names of other constants of
    the same file and arrays of them: ``2 ** 40``, ``1.0 /
    METERS_TO_FEET`` or ``[0.04, 0.26, 0.62]`` (a tuple here). Anything
    else fails the test rather than being guessed at.
    """
    match node:
        case ast.Constant(value=int() | float() as value):
            return float(value)
        case ast.List(elts=items):
            return tuple(_ts_evaluate(item, lookup) for item in items)
        case ast.Name(id=name):
            return lookup(name)
        case ast.BinOp(left=left, op=op, right=right) if type(op) in _TS_OPERATORS:
            return _TS_OPERATORS[type(op)](
                _ts_evaluate(left, lookup), _ts_evaluate(right, lookup)
            )
        case ast.UnaryOp(op=ast.USub(), operand=operand):
            return -_ts_evaluate(operand, lookup)
    raise AssertionError(f"cannot evaluate {ast.unparse(node)}")


def _ts_constant(relative, name):
    source = (FRONTEND / relative).read_text(encoding="utf-8")

    def value(constant):
        match = re.search(
            rf"\bconst {constant}(?:: \w+)? = ([^;]+?)(?: as const)?;", source
        )
        assert match, f"{constant} not found in {relative}"
        expression = ast.parse(match.group(1).strip(), mode="eval").body
        return _ts_evaluate(expression, value)

    return value(name)


@pytest.mark.parametrize(
    ("relative", "name", "value"),
    [
        ("services/yearDecode.ts", "DATA_FORMAT_VERSION", FORMAT_VERSION),
        ("services/yearDecode.ts", "GROUND_STEP", GROUND_STEP),
        ("services/yearDecode.ts", "ALTITUDE_STEP", ALTITUDE_STEP),
        ("calculations/groundProfile.ts", "TAXI_KNOTS", terrain_module.TAXI_KNOTS),
        (
            "calculations/groundProfile.ts",
            "TAXI_MIN_FIXES",
            terrain_module.TAXI_MIN_FIXES,
        ),
        (
            "utils/geometry.ts",
            "METRES_PER_DEGREE",
            METRES_PER_DEGREE,
        ),
        ("services/yearDecode.ts", "COORDINATE_SCALE", COORDINATE_SCALE),
        ("services/yearDecode.ts", "SPEED_SCALE", SPEED_SCALE),
        ("services/yearDecode.ts", "TIME_SCALE", TIME_SCALE),
        # The page draws the relief from the tiles the ground was sampled
        # from, and no finer
        ("calculations/liftZoom.ts", "TERRAIN_TILE_MAX_ZOOM", TERRAIN_ZOOM),
        # The units the altitudes and distances are exported and shown in
        ("utils/constants.ts", "METERS_TO_FEET", METERS_TO_FEET),
        ("utils/constants.ts", "NAUTICAL_MILES_TO_KM", 1 / KM_TO_NAUTICAL_MILES),
        # A link names its flights by id, and ids are content hashes
        ("state/urlState.ts", "PATH_ID_LIMIT", 2**PATH_ID_BITS),
        # The selection a flight page links to, which the page has to read
        ("state/urlState.ts", "STATE_SCHEMA_VERSION", previews.STATE_SCHEMA_VERSION),
        # The previews colour their heat as the heat cloud does
        ("ui/heatCloudShaders.ts", "CLOUD_COLOUR", previews.CLOUD_COLOUR),
        # Your flights refuses a file the build in the page would skip
        ("ui/localMessages.ts", "MAX_FILE_BYTES", browser.MAX_KML_BYTES),
        # The worker fetches the tiles of a build in the page as the site
        # build fetches them, and decodes them as its decoder does
        ("services/localTiles.ts", "TILE_FETCHES", fetch_module.FETCH_WORKERS),
        ("services/localTiles.ts", "MAX_TILE_BYTES", fetch_module.MAX_TILE_BYTES),
        (
            "services/localTiles.ts",
            "SERVER_ERRORS_TO_GIVE_UP",
            fetch_module.SERVER_ERROR_TILES_TO_GIVE_UP,
        ),
        ("services/localTiles.ts", "TILE_SIDE", TILE_SIZE),
    ],
)
def test_the_frontend_reads_what_the_exporter_writes(relative, name, value):
    """The two sides of the ground column share their numbers."""
    assert _ts_constant(relative, name) == value


@pytest.mark.parametrize(
    ("expression", "value"),
    [
        ("2 ** 40", 2.0**40),
        ("1.0 / 1.852", 1.0 / 1.852),
        ("-3.5e2", -350.0),
        ("[0.5, 2 ** 2]", (0.5, 4.0)),
    ],
)
def test_the_parity_check_reads_expressions(expression, value):
    """Constants written as expressions are read, not skipped (regression)."""
    node = ast.parse(expression, mode="eval").body
    assert _ts_evaluate(node, pytest.fail) == value


def test_the_parity_check_refuses_what_it_cannot_read():
    node = ast.parse("Math.max(1, 2)", mode="eval").body
    with pytest.raises(AssertionError, match="cannot evaluate"):
        _ts_evaluate(node, lambda name: 0.0)


def test_the_frontend_asks_for_tiles_of_the_size_they_are():
    """The relief source is told the size of the tiles the ground came from.

    The size is a constant of calculations/lift.ts, which reliefPixelM
    measures the relief's pixels with as well.
    """
    source = (FRONTEND / "ui" / "terrain.ts").read_text(encoding="utf-8")
    match = re.search(r'type: "raster-dem",[^}]*?\btileSize: (\w+),', source)
    assert match, "the raster-dem source's tileSize not found in ui/terrain.ts"
    assert match.group(1) == "TERRAIN_TILE_SIZE_PX"
    assert _ts_constant("calculations/lift.ts", "TERRAIN_TILE_SIZE_PX") == TILE_SIZE


def test_the_frontend_draws_the_relief_from_the_same_tiles():
    source = (FRONTEND / "ui" / "terrain.ts").read_text(encoding="utf-8")
    match = re.search(r'\bconst TERRAIN_TILE_URL =\s*"([^"]+)";', source)
    assert match, "TERRAIN_TILE_URL not found in ui/terrain.ts"
    assert match.group(1) == fetch_module.TILE_URL


def test_the_worker_gives_the_tile_host_up_on_the_same_answers():
    """The server errors a tile of the site build is tried again on are
    those the worker counts towards giving the host up."""
    source = (FRONTEND / "services" / "localTiles.ts").read_text(encoding="utf-8")
    match = re.search(r"\bconst SERVER_ERRORS = new Set\(\[([\d, ]+)\]\);", source)
    assert match, "SERVER_ERRORS not found in services/localTiles.ts"
    codes = {int(code) for code in match.group(1).split(",")}
    assert codes == fetch_module._RETRIED_HTTP_CODES
