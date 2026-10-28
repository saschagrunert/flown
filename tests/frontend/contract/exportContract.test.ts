/**
 * Contract test for the data files written by the Python exporter.
 *
 * Validates `docs/data/metadata.json`, `docs/data/airports.json` and each
 * `docs/data/<year>/data.json` against hand-written runtime guards derived from
 * `flown/frontend/types.ts` (decisions D1/D2/D3). A second test runs the
 * same guards against an inline sample so the guards are verified on their own.
 *
 * The guards require every field the exporter always writes and only leave
 * the fields optional that the exporter itself omits when it has no value,
 * so a field quietly dropped on the Python side fails here.
 *
 * `docs/` is a local build output. The docs/data half of this suite is
 * skipped when the site has not been built, or was built from other sources
 * than the checkout, except in CI, where the unit job builds it first and a
 * missing build is a failure.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cwd, env } from "node:process";
import {
  DATA_FORMAT_VERSION,
  expandYearData,
} from "../../../flown/frontend/services/yearDecode";
import { PATH_ID_BITS } from "../../../flown/frontend/state/urlState";
import type {
  Airport,
  Metadata,
  PathInfo,
  RawYearData,
} from "../../../flown/frontend/types";
import { checkSite } from "../../e2e/site-check";
import { path, rawYear } from "../yearFixtures";

// vitest runs with the repository root as working directory
const DATA_DIR = join(cwd(), "docs", "data");

/** Path ids are content hashes of PATH_ID_BITS (path_content.py has it too) */
const PATH_ID_LIMIT = 2 ** PATH_ID_BITS;

/** Fields the exporter no longer writes; a comeback fails the contract */
const REMOVED_PATH_INFO_KEYS = ["start_coords", "end_coords", "segment_count"];
const REMOVED_METADATA_KEYS = [
  // The frontend computes every statistic from the year files
  "stats",
  "gradient",
  "file_structure",
  // The altitude scale comes from the loaded segments
  "min_alt_m",
  "max_alt_m",
];

type Json = Record<string, unknown>;

/** The contents of a data file, which the page reads with response.json() */
function parseDataFile(source: string): unknown {
  return JSON.parse(source) as unknown;
}

// ---- runtime guards ----

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function optional<T>(
  value: unknown,
  guard: (v: unknown) => v is T,
): value is T | undefined {
  return value === undefined || guard(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isCoordinatePair(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isFiniteNumber(value[0]) &&
    isFiniteNumber(value[1]) &&
    value[0] >= -90 &&
    value[0] <= 90 &&
    value[1] >= -180 &&
    value[1] <= 180
  );
}

/** A touchdown of path_info: the field's code and the runway, or null */
function isTouchdown(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    isString(value[0]) &&
    (value[1] === null || isString(value[1]))
  );
}

/** A count of path_info's landings: a whole number, never negative */
function isCount(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

/**
 * The landings of a flight (flown/landings.py): all four keys or
 * none, and one touchdown for every full stop and touch-and-go
 */
function hasLandings(value: Json): boolean {
  const keys = ["landings", "touch_and_goes", "go_arounds", "touchdowns"];
  const written = keys.filter((key) => value[key] !== undefined).length;
  if (written === 0) return true;
  const { landings, touch_and_goes, go_arounds, touchdowns } = value;
  return (
    written === keys.length &&
    isCount(landings) &&
    isCount(touch_and_goes) &&
    isCount(go_arounds) &&
    Array.isArray(touchdowns) &&
    touchdowns.length === landings + touch_and_goes &&
    touchdowns.every(isTouchdown)
  );
}

function isPathInfo(value: unknown): value is PathInfo {
  if (!isRecord(value)) return false;
  const id = value["id"];
  if (!isInteger(id) || id < 0 || id >= PATH_ID_LIMIT) return false;
  // build_path_info always writes the year; paths without one are dropped
  // before export
  if (!isInteger(value["year"])) return false;
  // The start, the end and the segment count come from the segments
  if (REMOVED_PATH_INFO_KEYS.some((key) => key in value)) return false;
  // The altitude range and the climb are written together, whenever at
  // least one point has an altitude: the frontend takes the range and the
  // gain of the statistics from them and has no fallback of its own
  const minAltitude = value["min_altitude_ft"];
  const maxAltitude = value["max_altitude_ft"];
  const gain = value["altitude_gain_ft"];
  const written = [minAltitude, maxAltitude, gain].filter(
    (field) => field !== undefined,
  ).length;
  if (written !== 0 && written !== 3) return false;
  if (
    !optional(minAltitude, isFiniteNumber) ||
    !optional(maxAltitude, isFiniteNumber) ||
    (minAltitude !== undefined && minAltitude > (maxAltitude as number))
  ) {
    return false;
  }
  // The climb, from the unrounded altitudes; never negative
  if (!optional(gain, isFiniteNumber) || (gain !== undefined && gain < 0)) {
    return false;
  }
  if (!hasLandings(value)) return false;
  // null values are omitted by the exporter: optional means absent or typed
  return (
    optional(value["aircraft_registration"], isString) &&
    optional(value["aircraft_type"], isString) &&
    optional(value["start_airport"], isString) &&
    optional(value["end_airport"], isString)
  );
}

/**
 * The encoded columns of one path: four or five arrays of one length each.
 * Every value is a scaled integer, which is what makes the format compact;
 * a float here would mean the exporter stopped scaling a column. Only the
 * time column may hold null, for a row without a relative time.
 */
function isPathColumns(value: unknown): value is (number | null)[][] {
  if (!Array.isArray(value)) return false;
  if (value.length !== 4 && value.length !== 5) return false;
  if (!value.every(Array.isArray)) return false;
  const columns = value as unknown[][];
  const count = columns[0]!.length;
  return columns.every(
    (column, index) =>
      column.length === count &&
      column.every(
        (entry) => isInteger(entry) || (index === 4 && entry === null),
      ),
  );
}

/** One path's share of the segments, see segmentsOfPath */
function isPathSegments(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if ("rows" in value) return false;
  const columns = value["columns"];
  if (!isPathColumns(columns)) return false;
  // The ground under every row, in tens of feet (GROUND_STEP in
  // segment_codec.py), left out for a path whose ground the build does not
  // know; where it is written it covers every row
  const ground = value["ground"];
  if (
    ground !== undefined &&
    !(
      Array.isArray(ground) &&
      ground.length === columns[0]!.length &&
      ground.length > 0 &&
      ground.every(isInteger)
    )
  ) {
    return false;
  }
  const start = value["start"];
  if (!Array.isArray(start)) return false;
  // A path with rows has to say where its first row starts, as a scaled
  // coordinate pair
  if (columns[0]!.length === 0) return start.length === 0;
  return (
    start.length === 2 &&
    start.every(isInteger) &&
    isCoordinatePair(start.map((v: number) => v / 1e5))
  );
}

/**
 * The entries of path `index` in the segments of a year file, which are laid
 * out column by column across the paths (format 8): its start point, its
 * columns without the time when that is null, and its ground unless null
 */
function segmentsOfPath(segments: Json, index: number): Json {
  const columns = (segments["columns"] as unknown[][]).map((c) => c[index]);
  const entry: Json = {
    start: (segments["start"] as unknown[])[index],
    columns: columns[4] === null ? columns.slice(0, 4) : columns,
  };
  const ground = (segments["ground"] as unknown[])[index];
  if (ground !== null) entry["ground"] = ground;
  return entry;
}

/**
 * The segments of a year file: the start points, five columns and the
 * ground, each an array of one entry per path, and every path's entries well
 * formed
 */
function isRawSegments(value: unknown, paths: number): boolean {
  if (!isRecord(value)) return false;
  const columns = value["columns"];
  if (!Array.isArray(columns) || columns.length !== 5) return false;
  const arrays = [value["start"], ...(columns as unknown[]), value["ground"]];
  if (!arrays.every((a) => Array.isArray(a) && a.length === paths)) {
    return false;
  }
  for (let index = 0; index < paths; index++) {
    if (!isPathSegments(segmentsOfPath(value, index))) return false;
  }
  return true;
}

function isRawYearData(value: unknown): value is RawYearData {
  if (!isRecord(value)) return false;
  if (value["format"] !== DATA_FORMAT_VERSION) return false;
  if (!isInteger(value["year"])) return false;
  const pathInfo = value["path_info"];
  if (!Array.isArray(pathInfo) || !pathInfo.every(isPathInfo)) return false;
  return isRawSegments(value["segments"], pathInfo.length);
}

/**
 * The ICAO code of an airport's name, which the exporter writes where the
 * name holds one (airport_icao_code in flown/airport_lookup.py): four
 * letters of a region that has airport codes, standing as a word of the name
 */
function isAirportCode(code: unknown, name: string): boolean {
  return (
    isString(code) &&
    /^[ABCDEFGHKLMNOPRSTUVWYZ][A-Z]{3}$/.test(code) &&
    new RegExp(`\\b${code}\\b`).test(name)
  );
}

function isAirport(value: unknown): value is Airport {
  return (
    isRecord(value) &&
    isString(value["name"]) &&
    isCoordinatePair([value["lat"], value["lon"]]) &&
    (value["code"] === undefined ||
      isAirportCode(value["code"], value["name"])) &&
    optional(value["country"], isString) &&
    // The frontend derives the count from the active filter, so an exported
    // one would only ever contradict what the panel shows
    !("flight_count" in value) &&
    !("icao" in value)
  );
}

function isAirportsFile(value: unknown): value is { airports: Airport[] } {
  return (
    isRecord(value) &&
    Array.isArray(value["airports"]) &&
    value["airports"].every(isAirport)
  );
}

/** Model names by registration; only the ones aircraft.json knows */
function isAircraftModels(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((model) => isString(model) && model.length > 0)
  );
}

function isMetadata(value: unknown): value is Metadata {
  if (!isRecord(value)) return false;
  // Both 0 without timing data, never null
  const minSpeed = value["min_groundspeed_knots"];
  const maxSpeed = value["max_groundspeed_knots"];
  if (
    !isFiniteNumber(minSpeed) ||
    !isFiniteNumber(maxSpeed) ||
    minSpeed < 0 ||
    minSpeed > maxSpeed
  )
    return false;
  const years = value["available_years"];
  if (!Array.isArray(years) || !years.every(isInteger)) return false;
  // Written for every year so the loader can show progress
  const bytes = value["year_file_bytes"];
  if (!isRecord(bytes)) return false;
  for (const year of years) {
    if (!(String(year) in bytes)) return false;
  }
  for (const [year, size] of Object.entries(bytes)) {
    if (!/^\d{4}$/.test(year) || !isInteger(size) || size < 0) {
      return false;
    }
  }
  if (!isAircraftModels(value["aircraft_models"])) return false;
  // D2: removed keys must not come back
  return !REMOVED_METADATA_KEYS.some((key) => key in value);
}

// ---- inline sample (new format) ----

const sampleMetadata = {
  min_groundspeed_knots: 0.1,
  max_groundspeed_knots: 120,
  available_years: [2024, 2025],
  year_file_bytes: { "2024": 1234, "2025": 5678 },
  aircraft_models: { "D-EAGJ": "Diamond DA-20A-1 Katana" },
};

const sampleAirports = {
  airports: [
    {
      name: "EDDF Frankfurt",
      lat: 50.03,
      lon: 8.57,
      code: "EDDF",
      country: "DE",
    },
    { name: "EDDM Munich", lat: 48.35, lon: 11.79, code: "EDDM" },
    // A name without a code has none
    { name: "Grass Strip Oppin", lat: 51.5, lon: 12.1 },
  ],
};

/** The first path of sampleYear2025, with relative times and ground */
const samplePath = path(
  [50.03, 8.57],
  [
    [49.5, 9.5, 3000, 110, 0],
    [48.35, 11.79, 4000, 120, 1800],
  ],
  [1400, 1530],
);

const sampleYear2025: RawYearData = rawYear(
  2025,
  {
    "840108108563": samplePath,
    // A path whose ground the build does not know, without relative times
    "5": path([48.35, 11.79], [[48.4, 11.8, 1000, 60]]),
  },
  [
    // Ids are content hashes: large, sparse and in no particular order
    {
      id: 840108108563,
      year: 2025,
      aircraft_registration: "D-EAGJ",
      aircraft_type: "DA20",
      start_airport: "EDDF Frankfurt",
      end_airport: "EDDM Munich",
      min_altitude_ft: 2950.5,
      max_altitude_ft: 4010,
      altitude_gain_ft: 1059.5,
      landings: 1,
      touch_and_goes: 1,
      go_arounds: 0,
      touchdowns: [
        ["EDDM", "26L"],
        ["EDDM", null],
      ],
    },
    // A path without airports, aircraft or altitudes has only an id and a year
    { id: 5, year: 2025 },
  ],
);

function serialize(value: unknown): string {
  return JSON.stringify(value);
}

describe("export contract (inline new-format sample)", () => {
  it("refuses the script format of earlier versions", () => {
    expect(parseDataFile(serialize({ a: 1 }))).toEqual({ a: 1 });
    expect(() => parseDataFile("window.KML_METADATA = {};")).toThrow();
  });

  it("accepts a valid metadata.json", () => {
    expect(isMetadata(parseDataFile(serialize(sampleMetadata)))).toBe(true);
  });

  it("rejects metadata with removed keys or null fields", () => {
    for (const key of REMOVED_METADATA_KEYS) {
      expect(isMetadata({ ...sampleMetadata, [key]: {} }), key).toBe(false);
    }
    expect(isMetadata({ ...sampleMetadata, min_groundspeed_knots: null })).toBe(
      false,
    );
    expect(isMetadata({ ...sampleMetadata, aircraft_models: null })).toBe(
      false,
    );
    expect(isMetadata({ ...sampleMetadata, available_years: ["2025"] })).toBe(
      false,
    );
    expect(isMetadata({ ...sampleMetadata, year_file_bytes: { abc: 1 } })).toBe(
      false,
    );
    expect(
      isMetadata({ ...sampleMetadata, aircraft_models: { "D-EAGJ": "" } }),
    ).toBe(false);
    // The lowest speed cannot be above the highest
    expect(isMetadata({ ...sampleMetadata, min_groundspeed_knots: 130 })).toBe(
      false,
    );
  });

  it("rejects metadata that drops a field the exporter always writes", () => {
    for (const key of Object.keys(sampleMetadata)) {
      const metadata: Record<string, unknown> = { ...sampleMetadata };
      delete metadata[key];
      expect(isMetadata(metadata), key).toBe(false);
    }
    // A year without its file size
    expect(
      isMetadata({ ...sampleMetadata, year_file_bytes: { "2024": 1234 } }),
    ).toBe(false);
  });

  it("accepts a valid airports.json and rejects icao", () => {
    expect(isAirportsFile(sampleAirports)).toBe(true);
    expect(
      isAirportsFile({
        airports: [{ ...sampleAirports.airports[0], icao: "EDDF" }],
      }),
    ).toBe(false);
    expect(isAirportsFile({ airports: [{ name: "X", lat: 91, lon: 0 }] })).toBe(
      false,
    );
  });

  it("takes the code of an airport only from its own name", () => {
    const [frankfurt] = sampleAirports.airports;
    for (const code of ["EDDM", "eddf", "EDD", 4, "", "JDDF"]) {
      expect(
        isAirportsFile({ airports: [{ ...frankfurt, code }] }),
        String(code),
      ).toBe(false);
    }
    const { code: _code, ...withoutCode } = frankfurt!;
    expect(isAirportsFile({ airports: [withoutCode] })).toBe(true);
  });

  it("accepts a valid per-year data.json", () => {
    const parsed = parseDataFile(serialize(sampleYear2025));
    expect(isRawYearData(parsed)).toBe(true);
  });

  it("checks the encoded columns of a path", () => {
    const valid = samplePath;
    expect(isPathSegments(valid)).toBe(true);
    expect(segmentsOfPath({ ...sampleYear2025.segments }, 0)).toEqual(valid);
    // Row by row, as format 2 wrote it
    expect(
      isPathSegments({ start: valid.start, rows: [[1, 2, 3, 4, 5]] }),
    ).toBe(false);
    for (const columns of [
      // Columns of different lengths
      [[1, 2], [1], [1], [1]],
      // A float: the exporter stopped scaling a column
      [[1.5], [1], [1], [1]],
      // null is only a missing time, never a missing coordinate
      [[null], [1], [1], [1]],
      // Too few columns
      [[1], [1], [1]],
    ]) {
      expect(isPathSegments({ start: valid.start, columns })).toBe(false);
    }
    // The ground covers every row, in whole steps, or is left out
    for (const ground of [[], [140], [140, 13.5], [140, null], "140,13"]) {
      expect(isPathSegments({ ...valid, ground })).toBe(false);
    }
    const { ground: _ground, ...withoutGround } = valid;
    expect(isPathSegments(withoutGround)).toBe(true);
    // A row without a relative time
    expect(
      isPathSegments({
        start: valid.start,
        columns: [
          [1, 1],
          [1, 1],
          [1, 1],
          [1, 1],
          [null, 1],
        ],
      }),
    ).toBe(true);
  });

  it("rejects legacy or malformed per-year files", () => {
    expect(
      isRawYearData({
        ...sampleYear2025,
        segments: undefined,
        path_segments: [],
      }),
    ).toBe(false);
    expect(isRawYearData({ ...sampleYear2025, coordinates: [] })).toBe(true);
    expect(
      isRawYearData({
        ...sampleYear2025,
        segments: { "5": [[1, 2, 3, 4, 5]] },
      }),
    ).toBe(false);
    // Path by path, keyed by id, as format 7 wrote it
    expect(
      isRawYearData({
        ...sampleYear2025,
        segments: { "840108108563": samplePath },
      }),
    ).toBe(false);
    // An array with an entry more or less than path_info has paths
    const { start, columns, ground } = sampleYear2025.segments;
    for (const segments of [
      { start: start.slice(1), columns, ground },
      { start, columns, ground: [...ground, null] },
      { start, columns: [...columns.slice(0, 4), []], ground },
      { start, columns: columns.slice(0, 4), ground },
    ]) {
      expect(isRawYearData({ ...sampleYear2025, segments })).toBe(false);
    }
    expect(
      isRawYearData({
        ...sampleYear2025,
        segments: { x: [[1, 2, 3, 4, 5, 6]] },
      }),
    ).toBe(false);
    expect(
      isRawYearData({
        ...sampleYear2025,
        path_info: [{ id: 1, aircraft_registration: null }],
      }),
    ).toBe(false);
  });

  it("rejects path info that drops a field the exporter always writes", () => {
    const [full] = sampleYear2025.path_info;
    for (const key of ["id", "year"] as const) {
      const info: Record<string, unknown> = { ...full };
      delete info[key];
      expect(isPathInfo(info), key).toBe(false);
    }
    // The altitude range comes as a pair, in order
    const { max_altitude_ft: _max, ...halfRange } = full!;
    expect(isPathInfo(halfRange)).toBe(false);
    expect(isPathInfo({ ...full, min_altitude_ft: 5000 })).toBe(false);
    expect(isPathInfo({ ...full, min_altitude_ft: null })).toBe(false);
  });

  it("requires the altitude gain with the altitude range, as a climb", () => {
    const [full] = sampleYear2025.path_info;
    // The frontend has no estimate of its own to fall back on (regression)
    const { altitude_gain_ft: _gain, ...withoutGain } = full!;
    expect(isPathInfo(withoutGain)).toBe(false);
    const { min_altitude_ft: _min, max_altitude_ft: _max, ...gainOnly } = full!;
    expect(isPathInfo(gainOnly)).toBe(false);
    expect(isPathInfo({ ...full, altitude_gain_ft: 0 })).toBe(true);
    expect(isPathInfo({ ...full, altitude_gain_ft: -1 })).toBe(false);
    expect(isPathInfo({ ...full, altitude_gain_ft: null })).toBe(false);
    expect(isPathInfo({ ...full, altitude_gain_ft: "100" })).toBe(false);
  });

  it("requires the landings together, a touchdown for each", () => {
    const [full] = sampleYear2025.path_info;
    const { touchdowns: _touchdowns, ...withoutTouchdowns } = full!;
    expect(isPathInfo(withoutTouchdowns)).toBe(false);
    const {
      landings: _landings,
      touch_and_goes: _touchAndGoes,
      go_arounds: _goArounds,
      ...withoutLandings
    } = withoutTouchdowns;
    // A flight without timestamps has none of them
    expect(isPathInfo(withoutLandings)).toBe(true);
    expect(isPathInfo({ ...full, landings: 2 })).toBe(false);
    expect(isPathInfo({ ...full, go_arounds: -1 })).toBe(false);
    expect(isPathInfo({ ...full, landings: 0.5 })).toBe(false);
    expect(
      isPathInfo({
        ...full,
        touchdowns: [
          ["EDDM", 26],
          ["EDDM", null],
        ],
      }),
    ).toBe(false);
    expect(isPathInfo({ ...full, touchdowns: [["EDDM"], ["EDDM"]] })).toBe(
      false,
    );
  });

  it("rejects path info with removed fields or an id out of range", () => {
    const [full] = sampleYear2025.path_info;
    for (const key of REMOVED_PATH_INFO_KEYS) {
      expect(isPathInfo({ ...full, [key]: 1 }), key).toBe(false);
    }
    expect(isPathInfo({ ...full, id: -1 })).toBe(false);
    expect(isPathInfo({ ...full, id: 1.5 })).toBe(false);
    expect(isPathInfo({ ...full, id: PATH_ID_LIMIT })).toBe(false);
    expect(isPathInfo({ ...full, id: PATH_ID_LIMIT - 1 })).toBe(true);
  });

  it("expands the sample into the in-memory dataset shape", () => {
    const data = expandYearData(sampleYear2025);
    expect(data.path_segments).toHaveLength(3);
    // In path_info order, although JavaScript lists the key "5" first
    expect(data.path_segments.map((segment) => segment.path_id)).toEqual([
      840108108563, 840108108563, 5,
    ]);
    expect(data.path_segments[0]).toEqual({
      path_id: 840108108563,
      coords: [
        [50.03, 8.57],
        [49.5, 9.5],
      ],
      altitude_ft: 3000,
      groundspeed_knots: 110,
      time: 0,
      ground_ft: 1400,
    });
    expect(data.path_segments[1]!.coords).toEqual([
      [49.5, 9.5],
      [48.35, 11.79],
    ]);
    expect(data.path_segments[1]!.time).toBe(1800);
    expect(data.path_segments[1]!.ground_ft).toBe(1530);
    expect(data.path_segments[2]!.time).toBeUndefined();
    expect(data.path_segments[2]!.ground_ft).toBeUndefined();
  });
});

/**
 * Why docs/ does not match the checkout, or null when it does: the check
 * the e2e tests refuse a stale site with (tests/e2e/site-check.ts), whose
 * message names the command that rebuilds it
 */
function staleSite(): string | null {
  try {
    checkSite("docs");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("export contract (docs/data)", () => {
  const available = existsSync(join(DATA_DIR, "metadata.json"));
  // A site left over from before the last change to the exporter or the
  // frontend holds data of another shape, and failed here for a change
  // that was fine. Locally that is a reason to skip, with the command that
  // rebuilds it; CI builds the site from the checkout in the same job, so
  // there it is checked whatever the result would be.
  const stale = available && !env["CI"] ? staleSite() : null;

  beforeEach((context) => {
    if (stale) context.skip(stale);
  });

  // Locally the site may simply not have been built yet. In CI the unit job
  // builds it before running vitest, so a missing build is a broken job,
  // not a reason to skip the half of this suite that reads real output.
  it.runIf(env["CI"])("the built site is present in CI", () => {
    expect(
      available,
      `${DATA_DIR} is missing; run python -m flown data --output-dir docs`,
    ).toBe(true);
  });

  it.skipIf(!available)("metadata.json matches the Metadata contract", () => {
    const parsed = parseDataFile(
      readFileSync(join(DATA_DIR, "metadata.json"), "utf8"),
    );
    expect(isMetadata(parsed)).toBe(true);
    for (const key of REMOVED_METADATA_KEYS) {
      expect(parsed, key).not.toHaveProperty(key);
    }
    const metadata = parsed as Metadata;
    expect(metadata.available_years).toEqual(
      [...metadata.available_years].sort((a, b) => a - b),
    );
    for (const year of metadata.available_years) {
      expect(metadata.year_file_bytes).toHaveProperty(String(year));
      expect(existsSync(join(DATA_DIR, String(year), "data.json"))).toBe(true);
    }
  });

  it.skipIf(!available)("airports.json matches the Airport contract", () => {
    const parsed = parseDataFile(
      readFileSync(join(DATA_DIR, "airports.json"), "utf8"),
    );
    expect(isAirportsFile(parsed)).toBe(true);
    // A name that leads with a code has it written out: the page shows the
    // exported code and has no way of its own to find it
    for (const airport of (parsed as { airports: Airport[] }).airports) {
      const leading = /^([ABCDEFGHKLMNOPRSTUVWYZ][A-Z]{3})\b/.exec(
        airport.name,
      )?.[1];
      if (leading) expect(airport.code, airport.name).toBe(leading);
    }
  });

  it.skipIf(!available)(
    "every <year>/data.json matches the per-year contract with unique path ids",
    () => {
      const years = readdirSync(DATA_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && /^\d{4}$/.test(e.name))
        .map((e) => e.name)
        .sort();
      expect(years.length).toBeGreaterThan(0);

      const metadata = parseDataFile(
        readFileSync(join(DATA_DIR, "metadata.json"), "utf8"),
      ) as Metadata;
      const seenIds = new Set<number>();
      const registrations = new Set<string>();
      for (const year of years) {
        const parsed = parseDataFile(
          readFileSync(join(DATA_DIR, year, "data.json"), "utf8"),
        );
        expect(isRawYearData(parsed), `docs/data/${year}/data.json`).toBe(true);
        const raw = parsed as RawYearData;
        expect(raw.year).toBe(Number(year));
        expect("coordinates" in raw).toBe(false);

        const ids = raw.path_info.map((p) => p.id);
        for (const id of ids) {
          expect(seenIds.has(id), `duplicate path id ${id} in ${year}`).toBe(
            false,
          );
          seenIds.add(id);
        }

        const rowCounts = raw.segments.columns[0].map((rows) => rows.length);
        raw.path_info.forEach((info, index) => {
          expect(info.year, `path ${info.id} year`).toBe(Number(year));
          for (const key of REMOVED_PATH_INFO_KEYS) {
            expect(info, `path ${info.id}`).not.toHaveProperty(key);
          }
          // Every exported path has at least one segment to draw
          expect(rowCounts[index], `path ${info.id} rows`).toBeGreaterThan(0);
          if (info.aircraft_registration) {
            registrations.add(info.aircraft_registration);
          }
        });

        // the loader can expand it
        const data = expandYearData(raw);
        expect(data.path_segments.length).toBe(
          rowCounts.reduce((n, rows) => n + rows, 0),
        );

        // The decoded values have to be the ones the exporter put in. The
        // row columns are scaled by flown/segment_codec.py and
        // unscaled here, so a disagreement between the two sides would show
        // as physically impossible numbers rather than as a parse error.
        // metadata.json carries the groundspeed range, which the Python side
        // measured before encoding: every decoded speed has to fall inside
        // it, which no wrong scale factor would manage.
        // One pass, collecting what is wrong rather than asserting per
        // segment: a year holds tens of thousands of them, and an expect()
        // each would dominate the run time of the whole suite.
        const bad: string[] = [];
        const seen = new Map<number, { min: number; max: number }>();
        for (const segment of data.path_segments) {
          const coords = segment.coords;
          const altitude = segment.altitude_ft;
          const speed = segment.groundspeed_knots;
          if (
            coords === undefined ||
            altitude === undefined ||
            speed === undefined
          ) {
            bad.push(`path ${segment.path_id}: incomplete segment`);
            continue;
          }
          const [lat, lon] = coords[1];
          if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
            bad.push(`path ${segment.path_id}: latitude ${lat}`);
          }
          if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
            bad.push(`path ${segment.path_id}: longitude ${lon}`);
          }
          // process_path_segments quantises altitude to 20 ft.
          // Math.abs, because -0 % 20 is -0 and a negative altitude is legal
          if (Math.abs(altitude % 20) !== 0) {
            bad.push(`path ${segment.path_id}: altitude ${altitude}`);
          }
          // metadata.json carries the groundspeed range, which the Python side
          // measured before encoding: every decoded speed has to fall inside
          // it, which no wrong scale factor would manage
          if (
            speed > 0 &&
            (speed < metadata.min_groundspeed_knots ||
              speed > metadata.max_groundspeed_knots)
          ) {
            bad.push(`path ${segment.path_id}: groundspeed ${speed}`);
          }

          const range = seen.get(segment.path_id);
          if (range === undefined) {
            seen.set(segment.path_id, { min: altitude, max: altitude });
          } else {
            range.min = Math.min(range.min, altitude);
            range.max = Math.max(range.max, altitude);
          }
        }
        expect(bad.slice(0, 5), `${year}: decoded values out of range`).toEqual(
          [],
        );

        // path_info pins the altitude range of each path, measured on the
        // unrounded metres before the rows were quantised and encoded
        for (const info of raw.path_info) {
          if (info.min_altitude_ft === undefined) continue;
          const range = seen.get(info.id);
          expect(range, `path ${info.id} has no segments`).toBeDefined();
          // The rows are quantised to 20 ft, so they may sit one step
          // outside the exact range that path_info reports
          expect(range!.min).toBeGreaterThanOrEqual(info.min_altitude_ft - 20);
          expect(range!.max).toBeLessThanOrEqual(info.max_altitude_ft! + 20);
        }
      }

      // Models are only exported for aircraft that fly in the year files
      for (const registration of Object.keys(metadata.aircraft_models ?? {})) {
        expect(registrations.has(registration), registration).toBe(true);
      }
    },
  );
});
