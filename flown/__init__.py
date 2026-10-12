"""
Flown

Turns KML flight logs into a static site of where you have flown.

Submodules are imported lazily so that ``python -m flown --help`` and
``--version`` work without the optional runtime dependencies installed.
"""

import importlib
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # What __getattr__ resolves, for the type checker: without these every
    # flown.X would be the Any it returns. The aliases re-export them.
    from .aircraft import parse_aircraft_from_filename as parse_aircraft_from_filename
    from .airports import deduplicate_airports as deduplicate_airports
    from .airports import extract_airport_name as extract_airport_name
    from .exceptions import FlownError as FlownError
    from .exceptions import KMLParseError as KMLParseError
    from .geometry import haversine_distance as haversine_distance
    from .obfuscate import check_kml_obfuscated as check_kml_obfuscated
    from .obfuscate import obfuscate_kml_files as obfuscate_kml_files
    from .renderer import create_progressive_heatmap as create_progressive_heatmap
    from .validation import validate_kml_file as validate_kml_file

__version__ = "1.0.0"

_LAZY_EXPORTS = {
    "FlownError": ".exceptions",
    "KMLParseError": ".exceptions",
    "check_kml_obfuscated": ".obfuscate",
    "create_progressive_heatmap": ".renderer",
    "deduplicate_airports": ".airports",
    "extract_airport_name": ".airports",
    "haversine_distance": ".geometry",
    "obfuscate_kml_files": ".obfuscate",
    "parse_aircraft_from_filename": ".aircraft",
    "validate_kml_file": ".validation",
}

# Written out, so that tools that read __all__ without running the module
# see it; tests/test_init.py checks that it names every lazy export
__all__ = [  # noqa: RUF022 - the version first, then the lazy names in order
    "__version__",
    "FlownError",
    "KMLParseError",
    "check_kml_obfuscated",
    "create_progressive_heatmap",
    "deduplicate_airports",
    "extract_airport_name",
    "haversine_distance",
    "obfuscate_kml_files",
    "parse_aircraft_from_filename",
    "validate_kml_file",
]


def __getattr__(name: str) -> Any:
    module_name = _LAZY_EXPORTS.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module = importlib.import_module(module_name, __name__)
    return getattr(module, name)
