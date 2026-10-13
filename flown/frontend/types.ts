/**
 * Shared TypeScript type definitions for Flown
 */

import type { LngLat, Marker, Point } from "maplibre-gl";
import type { Coordinate } from "./utils/geometry";
import type { IconName, LazyIconName } from "./utils/icons";
import type { RibbonProperties } from "./calculations/ribbons";
import type { ToggleFlags } from "./state/toggles";
import type { Markup } from "./utils/markup";

/**
 * Path information from KML data.
 * Keys with null values are omitted by the exporter, so every optional field
 * is either absent or has a value (never null). Where a path starts and ends
 * and how many segments it has come from its segments.
 */
export interface PathInfo {
  /**
   * Derived from the flight itself, so it survives a re-export: stable in
   * shared links, but neither dense, ordered nor small (up to 2^40)
   */
  id: number;
  aircraft_registration?: string;
  aircraft_type?: string;
  year?: number;
  start_airport?: string;
  end_airport?: string;
  /** Exact altitude range; segment altitudes are rounded to 20 ft */
  min_altitude_ft?: number;
  max_altitude_ft?: number;
  /** Climb in feet from the unrounded altitudes, without level-flight noise */
  altitude_gain_ft?: number;
  /**
   * What the flight did at the fields it came to, read by the build from
   * the full-precision log (flown/landings.py). The four are written
   * together, for a flight with timestamps only; go-arounds include low
   * approaches, which GPS cannot tell apart from them.
   */
  landings?: number;
  touch_and_goes?: number;
  go_arounds?: number;
  /**
   * Every full stop and touch-and-go in the order flown: the ICAO code of
   * the field and the runway ("29", "08L"), null where it could not be told
   */
  touchdowns?: Touchdown[];
}

/** A touchdown of PathInfo: field and runway */
type Touchdown = [airport: string, runway: string | null];

/**
 * Path segment (in-memory shape expanded by the DataLoader), representing a
 * line between two points with associated altitude, speed, and timing data.
 * The decoder sets the first four for every segment (services/yearDataset.ts).
 */
export interface PathSegment {
  path_id: number;
  coords: [Coordinate, Coordinate];
  altitude_ft: number;
  /**
   * Knots; 0 where the build knew none (a log without timing), which is
   * no speed rather than standing still
   */
  groundspeed_knots: number;
  time?: number | undefined;
  /**
   * Feet of ground under the segment's end, from the elevation model of the
   * build (flown/terrain.py); only on a path that has it for every
   * segment, see groundProfileFt
   */
  ground_ft?: number | undefined;
  /** Great-circle length in km, memoised by `segmentDistance` on first use */
  distance_km?: number | undefined;
}

/**
 * Encoded columns of one path, as written by the exporter
 * (flown/segment_codec.py): latitude, longitude, altitude in steps of
 * 20 ft and groundspeed in whole knots, then the relative time in
 * tenths of a second when any row has one (null for a row without). Each
 * entry is the difference to the row before, as a scaled integer.
 *
 * Row i is the segment that ENDS at the i-th coordinate. Its start is the
 * end of the row before, and the first row continues from
 * `RawPathSegments.start`.
 */
export type RawColumns =
  | [number[], number[], number[], number[]]
  | [number[], number[], number[], number[], (number | null)[]];

/**
 * Exported segments of one path: the scaled first point and the columns of
 * the rows after it.
 */
export interface RawPathSegments {
  start: number[];
  columns: RawColumns;
  /**
   * Ground under every row in tens of feet, as differences like the
   * columns; left out for a path whose ground the build does not know
   */
  ground?: number[];
}

/**
 * Per-year data file contents (<year>/data.json)
 */
export interface RawYearData {
  /** Wire format of the rows, DATA_FORMAT_VERSION in services/yearDecode.ts */
  format: number;
  year: number;
  original_points: number;
  path_info: PathInfo[];
  segments: Record<string, RawPathSegments>;
}

/**
 * Aircraft aggregate data
 */
export interface AircraftAggregate {
  registration: string;
  type?: string | undefined;
  model?: string | undefined;
  flights: number;
  flight_time_seconds?: number;
  flight_time_str?: string;
  flight_distance_km?: number;
}

/**
 * Altitude statistics
 */
export interface AltitudeStats {
  min: number;
  max: number;
  gain: number;
}

/**
 * Speed statistics
 */
export interface SpeedStats {
  max: number;
  avg: number;
}

/**
 * Comprehensive flight statistics.
 * Optional fields may be absent but are never null.
 */
export interface FilteredStatistics {
  total_points: number;
  num_paths: number;
  num_airports: number;
  airport_names: string[];
  num_aircraft: number;
  aircraft_list: AircraftAggregate[];
  total_distance_km: number;
  total_distance_nm: number;
  max_altitude_m?: number | undefined;
  min_altitude_m?: number | undefined;
  total_altitude_gain_m?: number | undefined;
  max_altitude_ft?: number | undefined;
  min_altitude_ft?: number | undefined;
  total_altitude_gain_ft?: number | undefined;
  max_groundspeed_knots?: number | undefined;
  avg_groundspeed_knots?: number | undefined;
  cruise_speed_knots?: number | undefined;
  /**
   * The cruise figures are heights above the terrain under the flights
   * (AGL); false when some flight had no terrain in the export and was
   * measured above its own airfield instead. Undefined without a cruise.
   */
  cruise_height_above_terrain?: boolean | undefined;
  longest_flight_km?: number | undefined;
  longest_flight_nm?: number | undefined;
  total_flight_time_seconds?: number | undefined;
  total_flight_time_str?: string | undefined;
  most_common_cruise_altitude_ft?: number | undefined;
  most_common_cruise_altitude_m?: number | undefined;
  /** Undefined when no flight of the filter carries its landings */
  landings?: LandingTotals | undefined;
}

/** The landings of the flights of a filter, see landingTotals */
export interface LandingTotals {
  /** Full stops */
  landings: number;
  touchAndGoes: number;
  goArounds: number;
  /** The most touch-and-goes of a single flight */
  mostTouchAndGoes: number;
  /**
   * The runway with the most touchdowns, and its share of the touchdowns
   * with a runway at its field; undefined without one
   */
  busiestRunway?: { airport: string; runway: string; share: number };
}

/**
 * Airport information (airports.json)
 */
export interface Airport {
  name: string;
  lat: number;
  lon: number;
  /**
   * ICAO code the export found in the name (airport_icao_code in
   * flown/airport_lookup.py); left out for a name without one
   */
  code?: string;
  country?: string;
}

/** Full aircraft model names by registration, from aircraft.json */
export type AircraftModels = Readonly<Record<string, string>>;

/**
 * Metadata exported by the backend (metadata.json). The exporter writes every
 * field and none is ever null; the statistics are computed from the year
 * files instead.
 */
export interface Metadata {
  /** Lowest positive groundspeed; 0 without timing data */
  min_groundspeed_knots: number;
  /** Highest groundspeed; 0 without timing data */
  max_groundspeed_knots: number;
  available_years: number[];
  /** Size of each year file in bytes, by year */
  year_file_bytes: Record<string, number>;
  /**
   * Only the registrations aircraft.json knows a model for. Missing from
   * exports made before it was added, which a browser can still hold in its
   * cache next to a newer bundle.
   */
  aircraft_models?: AircraftModels;
  /**
   * ISO codes of the countries this site carries a flag for. A site built
   * without the flag files (a pip install, which leaves them out) publishes
   * none, and the country code is shown instead. Missing from older exports.
   */
  available_flags?: string[];
}

/**
 * In-memory KML dataset (one year or all years combined)
 */
export interface KMLDataset {
  path_segments: PathSegment[];
  path_info: PathInfo[];
  original_points: number;
  /** Set on an "all years" dataset that is missing a year that failed to load */
  incomplete?: boolean;
}

/**
 * Map center coordinates
 */
export interface MapCenter {
  lat: number;
  lng: number;
}

/**
 * What the app holds in place of a map layer. The layers themselves are
 * created once with the map and never removed (see MAP_LAYERS); showing and
 * hiding one is a layout property. The handle remembers the wish, so it can
 * be set before the style has loaded and is applied when the layers appear.
 */
export interface LayerHandle {
  /** The map layers this handle switches, bottom to top; none for markers */
  readonly ids: readonly string[];
  isVisible(): boolean;
  setVisible(visible: boolean): void;
}

/**
 * Properties of one feature in a paths source: a run of consecutive
 * segments of one path that share a colour step.
 */
export interface PathRunProperties extends Partial<RibbonProperties> {
  /** Index of the run in the layer manager's run table */
  r: number;
  /**
   * Generation of the table. Tiles answer queries with features of the
   * previous `setData` for a while; a stale generation gives them away.
   */
  g: number;
  pathId: number;
  color: string;
}

/** What `LayerManager.hitTest` found under a point of the map */
export interface PathHit {
  pathId: number;
  /** The segment nearest to the point, for the tooltip */
  segment: PathSegment;
}

/**
 * A flight, the empty map (null), or "stale": the only flights found under
 * the point were cut from data that has been replaced since, and whether a
 * flight is there cannot be told until the tiles have caught up.
 */
export type PathHitResult = PathHit | "stale" | null;

/**
 * What MapApp's click dispatcher asks of the layer manager. Paths are pixels
 * of a map layer and have no click listeners of their own, so the map's one
 * click handler asks what is under the pointer and hands a hit back.
 */
export interface PathHitTester {
  /** The flight drawn at `point` (container pixels), null or "stale" */
  hitTest(point: Point): PathHitResult;
  /**
   * Act on a click that hit a flight; `lngLat` is where it landed, and
   * `touch` whether a finger made it
   */
  onPathClick(hit: PathHit, lngLat: LngLat, touch?: boolean): void;
}

/** Anything on the map that owns a popup the app may have to close */
export interface PopupHost {
  openPopup(): void;
  closePopup(): void;
  isPopupOpen(): boolean;
}

/**
 * An airport on the map. MapLibre's marker knows nothing of popups the way
 * the app uses them (one shared popup, opened by the app and not by
 * `setPopup`, which toggles a second time on the same click) nor of being
 * hidden, so the app's markers are wrapped.
 */
export interface AirportMarker extends PopupHost {
  readonly marker: Marker;
  /** Latitude first, like the rest of the app */
  getLatLng(): MapCenter;
  /** The marker's element, which the map positions */
  getElement(): HTMLElement;
  /**
   * What of the marker takes the focus and Enter: the button round its dot,
   * or the chip of its code where that is its target (setAirportTarget)
   */
  getControl(): HTMLElement;
  setVisible(visible: boolean): void;
  setHome(home: boolean): void;
}

/**
 * One stretch of the replay trail in a single colour: a feature of the
 * `replay-trail` source. Consecutive segments of a colour extend the last
 * run instead of adding a feature each.
 */
export interface TrailRun {
  color: string;
  /** `[lng, lat]` vertices, ready for a LineString */
  coords: [number, number][];
  /** Indices of the first and the last replay segment in the run */
  firstIndex: number;
  lastIndex: number;
}

/**
 * Application state (used for URL encoding and state management). The
 * toggles (state/toggles.ts) are each absent or a flag.
 */
export interface AppState extends Partial<ToggleFlags> {
  /** Schema version of selectedPathIds; see STATE_SCHEMA_VERSION */
  schemaVersion?: number;
  selectedYear?: string;
  selectedAircraft?: string;
  selectedPathIds?: number[];
  center?: MapCenter;
  /** In state (legacy) units, one above the map's; see ZOOM_OFFSET */
  zoom?: number;
  /** Degrees the map is turned from north up, -180 to 180; absent means 0 */
  bearing?: number;
  /** Degrees the map is tilted, 0 to MAP_MAX_PITCH; absent means flat */
  pitch?: number;
  /** The cross-section's line (StoreState.crossSectionLine); absent: none */
  crossSectionLine?: string;
}

/**
 * Persisted state (localStorage / URL). All fields are optional because a
 * restored state may contain any subset of them.
 */
export type SavedState = AppState;

/**
 * Fun fact for wrapped/year-in-review feature
 */
export interface FunFact {
  /** The diversity bucket, and the icon when the fact names none */
  category: string;
  /**
   * The mark drawn beside the text. Several facts share a category (three
   * of them are about distance), so the category alone would draw the same
   * icon three times in one card.
   */
  icon?: IconName | LazyIconName;
  /**
   * The text, as markup whose values were escaped as it was made (markup
   * in utils/markup.ts): a registration or an airport's name is text in it
   */
  text: Markup;
  priority: number;
}

/**
 * Year statistics for wrapped feature
 */
export interface YearStats {
  total_flights: number;
  num_airports: number;
  total_distance_nm: number;
  flight_time: string;
  airport_names: string[];
  aircraft_list: AircraftAggregate[];
}

/**
 * The loading operation the indicator is up for. The loader derives one of
 * these from its model on every change, and the indicator draws its label
 * and its bar from that one object, so the two cannot disagree.
 */
export interface LoadingState {
  /**
   * Which operation this is. The loader counts up whenever the set of loads
   * changes (one joins, one fails), which is when the bar starts over; the
   * indicator is told, rather than left to guess it from the numbers.
   */
  operation: number;
  /** Every year is wanted; the label says so instead of naming the years */
  all: boolean;
  /**
   * The years whose files the operation downloads, in the order they joined.
   * A year that is already cached is not downloaded and is not listed, and
   * neither is one that has failed.
   */
  years: readonly string[];
  /**
   * Size of those files together, from metadata.year_file_bytes, for the
   * label; undefined when the size of one is unknown
   */
  fileBytes: number | undefined;
  /** Bytes of the operation that have arrived; never more than `totalBytes` */
  loadedBytes: number;
  /**
   * Bytes the operation has to download, which is what the bar is a share
   * of: the sizes on disk, which the decoded bodies add up to, less what had
   * arrived when the operation began. Zero when all of it had: the files
   * are complete and still being read. Undefined when the size of a file is
   * unknown.
   */
  totalBytes: number | undefined;
}

/**
 * Options of fetchJson
 */
export interface FetchJsonOptions {
  /** Time after which the request is aborted, headers and body together */
  timeoutMs?: number;
  /**
   * Called with the bytes of the body read so far. Never called where the
   * browser cannot count a body as it streams; the caller then has nothing
   * to show but that the file is loading.
   */
  onProgress?: (loadedBytes: number) => void;
}
