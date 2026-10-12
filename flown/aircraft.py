"""Aircraft registration and model lookup functionality."""

import json
import re
from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING, NamedTuple

from .constants import ICAO_REGION_PREFIXES
from .date_tokens import strip_dates
from .logger import logger

if TYPE_CHECKING:
    from collections.abc import Iterable, Mapping

__all__ = [
    "NATIONALITY_MARKS",
    "REGISTRATION_PREFIXES",
    "AircraftInfo",
    "load_aircraft_data",
    "merge_aircraft_data",
    "normalize_registration",
    "parse_aircraft_from_filename",
    "resolve_aircraft_models",
]

# ICAO nationality prefixes that are written with a hyphen, in Europe and
# around it (doc/usage.md lists them). Longer prefixes are matched first, so
# "9H" (Malta) wins over nothing shorter and "2" (Guernsey) or "M" (Isle of
# Man) only apply where no two-character prefix does. "N" (United States) is
# written without a hyphen and is intentionally absent; any other prefix is
# used as written, so a registration outside this table has to be written
# with its hyphen in the file name.
REGISTRATION_PREFIXES: tuple[str, ...] = tuple(
    sorted(
        (
            "2",
            "4O",
            "5B",
            "9A",
            "9H",
            "CS",
            "E7",
            "EC",
            "EI",
            "ES",
            "EW",
            "HA",
            "HB",
            "LN",
            "LX",
            "LY",
            "LZ",
            "OE",
            "OH",
            "OK",
            "OM",
            "OO",
            "OY",
            "PH",
            "S5",
            "SE",
            "SP",
            "SX",
            "TC",
            "TF",
            "UR",
            "YL",
            "YR",
            "YU",
            "Z3",
            "ZA",
            "D",
            "F",
            "G",
            "I",
            "M",
        ),
        key=len,
        reverse=True,
    )
)


# The ICAO nationality marks a registration starts with (ICAO Annex 7), of
# every state. "N" (United States) is read by its own rule (_N_NUMBER).
NATIONALITY_MARKS: frozenset[str] = frozenset(
    """
    B C D F G I M P Z 2
    3A 3B 3C 3D 3DC 3X 4K 4L 4O 4R 4W 4X 5A 5B 5H 5N 5R 5T 5U 5V 5W 5X 5Y
    6O 6V 6W 6Y 7O 7P 7Q 7T 8P 8Q 8R 9A 9G 9H 9J 9K 9L 9M 9N 9Q 9U 9V 9XR
    9Y A2 A3 A4O A5 A6 A7 A8 A9C AP C2 C3 C5 C6 C9 CC CN CP CS CU CX D2 D4
    D6 DQ E3 E5 E7 EC EI EJ EK EP ER ES ET EW EX EY EZ H4 HA HB HC HH HI HK
    HL HP HR HS HZ J2 J3 J5 J6 J7 J8 JA JU JY LN LV LX LY LZ OB OD OE OH OK
    OM OO OY P2 P4 PH PJ PK PP PR PS PT PU PZ RA RDPL RP S2 S5 S7 S9 SE SP
    ST SU SX T2 T3 T7 T8A T9 TC TF TG TI TJ TL TN TR TS TT TU TY TZ UK UN UP
    UR V2 V3 V4 V5 V6 V7 V8 VH VN VP VQ VT XA XB XC XT XU XY YA YI YJ YK YL
    YN YR YS YU YV Z3 ZA ZK ZP ZS ZT ZU
    """.split()  # noqa: SIM905 - a table reads better than 190 quoted lines
)
# The length of what follows a mark of one character, which a name rarely
# has: D-EHYL, G-ABCD and F-GABC have four letters, Z-WPA three. The marks
# of two characters and more take one to five (OE-AKI, JA1234, RA-12345).
_SINGLE_MARK_SUFFIX = {
    "B": (3, 5),
    "C": (4, 4),
    "D": (4, 4),
    "F": (4, 4),
    "G": (4, 4),
    "I": (4, 4),
    "M": (4, 4),
    "P": (3, 4),
    "Z": (3, 3),
    "2": (4, 4),
}
# A US registration: N, a digit other than zero, then digits with at most two
# letters at the end, five characters at most (N12345, N123AB, N1430Z)
_N_NUMBER = re.compile(r"N[1-9](?:\d{0,4}|\d{0,3}[A-Z]|\d{0,2}[A-Z]{2})")


class AircraftInfo(NamedTuple):
    """What a KML file name says about the aircraft (see the parser below).

    ``registration`` is None when the name has the shape of one but no
    registration in it; ``route`` is the DEPARTURE-ARRIVAL part of a
    Charterware name.
    """

    registration: str | None
    type: str | None = None
    route: str | None = None
    format: str = "numbered"


# The shape of a registration: a nationality mark (D, OE, 9A, N, 9XR), with
# or without its hyphen, then letters and digits (D-EHYL, OEAKI, N12345,
# N123AB). In capitals, and with at least one letter: "summer" in
# "2025_summer_trip.kml" is none. Which mark it starts with is up to
# _has_nationality_mark.
_REGISTRATION = re.compile(r"[A-Z0-9]{1,4}-[A-Z0-9]{1,5}|[A-Z0-9]{3,7}")
_ICAO_CODE = re.compile(rf"[{ICAO_REGION_PREFIXES}][A-Z]{{3}}")
_CHARTERWARE_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_CHARTERWARE_TIME = re.compile(r"(?:[01]\d|2[0-3])[0-5]\dh")
# An aircraft type is an ICAO type designator (DA40, C172, P28A, EC135), maybe
# with a variant (DA40NG, C172S) or hyphen groups (PA-28-181, DR400-180,
# G-109B), and holds a digit: a word of letters alone is as often a name
# ("ANNA"), so only the ICAO designators without one are taken
# (see _is_type_designator). Anything else is free text ("DA40 mit Anna"),
# which the site would publish.
_TYPE_BASE = re.compile(r"[A-Z][A-Z0-9]{0,5}")
# A hyphen group starts with a digit (PA-28, LS8-18), or is a variant of one or
# two letters right after a digit (DA40-NG)
_TYPE_GROUP = re.compile(r"\d[A-Z0-9]{0,4}|[A-Z]{1,2}")
_TYPE_MAX_GROUPS = 2
# The ICAO designators for aircraft without a type designator of their own
_SPECIAL_TYPES = frozenset(
    {"BALL", "GLID", "GYRO", "PARA", "SHIP", "UHEL", "ULAC", "ZZZZ"}
)


def load_aircraft_data(aircraft_file: Path) -> dict[str, str]:
    """Load an aircraft.json mapping of registration to model name."""
    try:
        data = json.loads(aircraft_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to read aircraft data from %s: %s", aircraft_file, e)
        return {}

    if not isinstance(data, dict):
        logger.warning("Ignoring %s: expected a JSON object", aircraft_file)
        return {}

    # Keyed the way registrations from file names are written ("DEAGJ" is
    # D-EAGJ, "d-eagj" too: the names are read in capitals); the first
    # spelling of a registration wins
    aircraft: dict[str, str] = {}
    for key, value in data.items():
        # A null or an object would reach metadata.json as "None" or as a
        # Python dict, and the page would show it as the model
        if not isinstance(value, str) or not value.strip() or not key.strip():
            logger.warning(
                "Ignoring %r in %s: the model must be a non-empty string",
                key,
                aircraft_file,
            )
            continue
        aircraft.setdefault(normalize_registration(key.strip().upper()), value)
    return aircraft


def merge_aircraft_data(aircraft_files: Iterable[Path]) -> dict[str, str]:
    """Merge several aircraft.json files; the first file wins on conflicts."""
    merged: dict[str, str] = {}
    for aircraft_file in aircraft_files:
        for registration, model in load_aircraft_data(aircraft_file).items():
            merged.setdefault(registration, model)
    return merged


def resolve_aircraft_models(
    registrations: Iterable[str | None],
    aircraft_data: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """The model of every registration that aircraft.json knows.

    Registrations without a model are left out; the frontend shows the
    aircraft type from the KML file for them.
    """
    models: dict[str, str] = {}
    for registration in sorted({reg for reg in registrations if reg}):
        model = aircraft_data.get(registration) if aircraft_data else None
        if model:
            logger.info("  ✓ %s: %s", registration, model)
            models[registration] = model
        else:
            logger.info("  ⚠ %s: no model in aircraft.json", registration)
    return models


def normalize_registration(raw: str) -> str:
    """Insert the nationality hyphen into a registration written without one."""
    if not raw or "-" in raw:
        return raw

    for prefix in REGISTRATION_PREFIXES:
        if raw.startswith(prefix) and len(raw) > len(prefix):
            return f"{prefix}-{raw[len(prefix) :]}"

    return raw


def _is_date(text: str) -> bool:
    """Whether a leading number of a file name is a date (20250601) or year."""
    if len(text) == 8:
        try:
            date.fromisoformat(text)
        except ValueError:
            return False
        return True
    return len(text) == 4 and text.isascii() and 1900 <= int(text) <= 2099


def _is_registration(text: str, after_date: bool) -> bool:
    """Whether the second part of a numbered file name is a registration.

    After a date it must not be an ICAO airport code either:
    "20250601_EDDS_EDDP.kml" is a route, not the aircraft EDDS.
    """
    if not _REGISTRATION.fullmatch(text) or not any(c.isalpha() for c in text):
        return False
    return not (after_date and _ICAO_CODE.fullmatch(text))


def _fits_mark(mark: str, rest: str) -> bool:
    if mark == "N":
        return _N_NUMBER.fullmatch(mark + rest) is not None
    if mark not in NATIONALITY_MARKS:
        return False
    low, high = _SINGLE_MARK_SUFFIX.get(mark, (1, 5))
    return low <= len(rest) <= high


def _has_nationality_mark(text: str) -> bool:
    """Whether a registration starts with an ICAO nationality mark.

    Before its hyphen, or any mark it starts with when written without one
    (DEHYL, OEAKI, N12345). "ANNA" and "JOHN" start with none, and "MIKE"
    is no M-IKE: the Isle of Man has four letters after its mark.
    """
    if "-" in text:
        mark, _, rest = text.partition("-")
        return _fits_mark(mark, rest)
    return _N_NUMBER.fullmatch(text) is not None or any(
        _fits_mark(text[:length], text[length:]) for length in range(1, 5)
    )


def _unmarked_registration(text: str, filename: str) -> bool:
    """Whether a registration has no nationality mark, a name as often.

    "ANNA" in "1_ANNA_DA40.kml" has the shape of a registration, but the
    site would publish a name with every path. Warns about it.
    """
    if _has_nationality_mark(text):
        return False
    logger.warning(
        "Ignoring the registration %s in %s: it starts with no ICAO "
        "nationality mark (D-EHYL, OE-AKI, N12345), and the site would publish it",
        text,
        filename,
    )
    return True


def _dated_registration(text: str, filename: str) -> bool:
    """Whether a registration holds a date, which it would publish.

    "16AUG26" in "1_16AUG26_DA40.kml" has the shape of a registration, but
    it is the day of the flight, and the registration is published with
    every path. Warns about it.
    """
    if strip_dates(text) == text:
        return False
    logger.warning(
        "Ignoring the registration %s in %s: it holds a date", text, filename
    )
    return True


def _is_type_designator(text: str) -> bool:
    """Whether an upper-case text is an aircraft type designator.

    A base (DA40, PA, G) and at most two hyphen groups, each starting with a
    digit or a variant of one or two letters after a digit; and a digit in
    it, unless it is one of the designators that have none (GLID).
    """
    if text in _SPECIAL_TYPES:
        return True
    base, *groups = text.split("-")
    if len(groups) > _TYPE_MAX_GROUPS or not _TYPE_BASE.fullmatch(base):
        return False
    previous = base
    for group in groups:
        if not _TYPE_GROUP.fullmatch(group) or (
            group[0].isalpha() and not previous[-1].isdigit()
        ):
            return False
        previous = group
    return any(char.isdigit() for char in text)


def _aircraft_type(text: str, filename: str) -> str | None:
    """The aircraft type of a numbered file name, None where it has none.

    A date is taken out of it, as everywhere a name is published (a type
    that is only a date is none); what is left must be a type designator in
    any case (see ``_is_type_designator``), which is published in capitals,
    else it is dropped with a warning.
    """
    aircraft_type = strip_dates(text)
    if not aircraft_type:
        return None
    if aircraft_type.isascii() and _is_type_designator(aircraft_type.upper()):
        return aircraft_type.upper()
    logger.warning(
        "Ignoring the aircraft type %r in %s: it is no type designator "
        "(DA40, C172), and the site would publish it",
        aircraft_type,
        filename,
    )
    return None


def parse_aircraft_from_filename(filename: str) -> AircraftInfo | None:
    """Parse aircraft information from KML filename, None for a name without.

    Supports two formats:
    1. Numbered: N_REGISTRATION_TYPE.kml (e.g., 1_DEHYL_DA40.kml)
    2. Charterware: YYYY-MM-DD_HHMMh_REGISTRATION_ROUTE.kml

    A numbered name whose second part is no registration (see
    ``_is_registration``) names no aircraft; a Charterware name without one
    keeps its route. A registration that holds a date or starts with no
    nationality mark is none either (see ``_dated_registration`` and
    ``_unmarked_registration``), but the type and route stay. A type that is
    no type designator is dropped (see ``_aircraft_type``).
    """
    name = Path(filename).stem
    parts = name.split("_")

    if len(parts) >= 3 and parts[0].isascii() and parts[0].isdigit():
        if not _is_registration(parts[1], _is_date(parts[0])):
            logger.debug("No aircraft registration in filename: %s", filename)
            return None
        if len(parts) > 3:
            logger.warning(
                "Ignoring extra filename parts in %s (expected N_REGISTRATION_TYPE)",
                filename,
            )
        return AircraftInfo(
            registration=None
            if _dated_registration(parts[1], filename)
            or _unmarked_registration(parts[1], filename)
            else normalize_registration(parts[1]),
            type=_aircraft_type(parts[2], filename),
            format="numbered",
        )

    if (
        len(parts) >= 4
        and _CHARTERWARE_DATE.fullmatch(parts[0])
        and _CHARTERWARE_TIME.fullmatch(parts[1])
    ):
        try:
            date.fromisoformat(parts[0])
        except ValueError:
            logger.warning("Invalid date in Charterware filename: %s", filename)
            return None

        # The same rules as for a numbered name: "constructor" in
        # "2026-01-12_1513h_constructor_LOAV-LOAV.kml" is no aircraft, but
        # the route still names the airports
        registration = None
        if (
            _is_registration(parts[2], after_date=False)
            and not _dated_registration(parts[2], filename)
            and not _unmarked_registration(parts[2], filename)
        ):
            registration = normalize_registration(parts[2])
        else:
            logger.debug("No aircraft registration in filename: %s", filename)
        return AircraftInfo(registration, None, parts[3] or None, "charterware")

    logger.debug("No aircraft information in filename: %s", filename)
    return None
