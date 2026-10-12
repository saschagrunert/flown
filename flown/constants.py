"""Constants used throughout Flown."""

# === Unit Conversions ===
METERS_TO_FEET = 3.28084
FEET_TO_METERS = 1.0 / METERS_TO_FEET

# 1 NM = exactly 1.852 km by definition
KM_TO_NAUTICAL_MILES = 1.0 / 1.852

# Time conversion
SECONDS_PER_HOUR = 3600

# === Groundspeed Calculations ===
# Above this a groundspeed is a position or clock glitch rather than a
# measurement: faster than any piston or turboprop aircraft with a good
# tailwind, and than most light jets. Such a speed counts as unknown.
MAX_GROUNDSPEED_KNOTS = 600
MIN_SEGMENT_TIME_SECONDS = 0.1  # Avoid division by very small time differences
SPEED_WINDOW_SECONDS = 120  # 2 minute rolling average window for speed calculation

# === Timestamps ===
# How far a timestamp may be from the median of its track before it counts
# as a clock error. Generous for a flight, which is over within a day, and
# even for a logger left running for days; far below the errors it catches
# (a clock at its default date, a GPS week rollover of almost 20 years). The
# parser drops such a stamp, and the obfuscator moves it on its own.
MAX_TIMESTAMP_DISTANCE_SECONDS = 7 * 24 * 3600

# === Altitude Gain ===
# A climb counts toward the altitude gain of a path only once the altitude has
# risen this far above the lowest point since the last descent, and a descent
# ends it only once the altitude has fallen this far below the highest point.
# GPS and barometric altitudes wander by a few meters from fix to fix; summing
# every small rise would turn a level cruise into thousands of feet of climb.
ALTITUDE_GAIN_HYSTERESIS_FT = 50.0

# === Validation Ranges ===
LAT_MIN = -90.0
LAT_MAX = 90.0
LON_MIN = -180.0
LON_MAX = 180.0
ALT_MIN_M = -1000.0  # Below sea level limit
ALT_MAX_M = 50000.0  # Upper atmosphere limit

# === Airport Detection ===
AIRPORT_DISTANCE_THRESHOLD_KM = 1.5  # Distance threshold for deduplicating airports
AIRPORT_GRID_SIZE_DEGREES = (
    0.018  # Grid cell size in degrees (~2km at equator) for spatial indexing
)

# === Path Sampling ===
PATH_SAMPLE_MAX_SIZE = 50  # Maximum sample size for path analysis
PATH_SAMPLE_MIN_SIZE = 5  # Minimum sample size for path analysis

# === Mid-Flight Detection ===
# Heights are above the field elevation when the airport database knows it
# (see airports.reference_altitude), above sea level otherwise
MID_FLIGHT_MIN_ALTITUDE_M = 400  # Minimum height to consider mid-flight start
MID_FLIGHT_MAX_VARIATION_M = 100  # Maximum altitude variation for stable flight

# === Landing Detection ===
LANDING_MAX_VARIATION_M = 50  # Maximum altitude variation for stable landing
LANDING_MAX_ALTITUDE_M = 600  # Maximum height for valid landing endpoint
LANDING_FALLBACK_ALTITUDE_M = 1000  # Fallback height threshold for short paths

# === XML/KML Namespaces ===
KML_NAMESPACE = "http://www.opengis.net/kml/2.2"
GX_NAMESPACE = "http://www.google.com/kml/ext/2.2"

KML_NAMESPACES = {"kml": KML_NAMESPACE, "gx": GX_NAMESPACE}

# === ICAO Region Prefixes ===
# Valid first letters of ICAO airport codes by region.
# Excludes I (not assigned), J (not assigned for airports),
# Q (reserved for non-geographic use), X (not assigned).
ICAO_REGION_PREFIXES = "ABCDEFGHKLMNOPRSTUVWYZ"

# === Cache ===
# Where the caches go (see flown.cache), read once when that module is
# first imported: the command line sets it from --cache-dir before
CACHE_DIR_ENV = "FLOWN_CACHE_DIR"
