/**
 * The readout of the heat cloud: what the cloud under the pointer is made
 * of, as time spent, flights and heights (see ui/cloudReadout.ts). A custom
 * layer has no features the map could look under the pointer for, so the
 * readout is worked out from the segments themselves.
 *
 * "Under the pointer" is the line of sight through it. The cloud is drawn
 * at the heights of the flights and adds up every glow on a pixel (see
 * CLOUD_COLOUR in ui/heatCloudShaders.ts), so a pixel shows every flight the
 * line of sight passes near, at any height: a circuit at 1,000 ft in front
 * of the ground under the pointer and a route at 5,000 ft beyond it alike.
 * Taking the ground under the pointer instead would miss the glow pointed
 * at in a tilted view, where the flights stand up the screen from their
 * ground. The line is sampled at heights above the ground (SightLine), each
 * with the place on the ground below the point of the line at that height,
 * and a segment counts where it comes within the radius of the place of
 * its own height. Looking straight down, every height has the same place.
 *
 * The time is the cloud's: the heat of each segment in seconds, weighed as
 * the heatmap, its lines and the cloud weigh it (heatWeight), of the part
 * of the segment within the radius. The segments near a place are found in
 * a grid of cells twice the radius (segmentGrid), made the first time a
 * radius is asked for and kept with the dataset, those of the last few
 * radii. The readout makes it ahead of the pointer, where the map comes to
 * rest (see readoutKept).
 */
import type { PathSegment } from "../types";
import {
  DEGREES_TO_RADIANS,
  METRES_PER_DEGREE,
  planarMetres,
  turnOf,
  type Coordinate,
} from "../utils/geometry";
import { formatDuration } from "../utils/duration";
import { formatNumber } from "../utils/formatters";
import { pluralFlights } from "../utils/htmlGenerators";
import { heatWeight, type SegmentWeight } from "./heatLines";
import { groundProfilesFt } from "./groundProfile";

/**
 * The radii a readout says it is "within", in metres: round numbers, so it
 * reads "within 1 km" rather than "within 1.23 km"
 */
const READOUT_RADII_M: readonly number[] = [
  100, 250, 500, 1000, 2000, 5000, 10000, 20000, 50000,
];

/** The highest a line of sight is followed up to, in feet above the ground */
const SIGHT_TOP_FT = 15000;

/** The most heights a line of sight is sampled at, after the ground */
const SIGHT_MAX_STEPS = 48;

/**
 * The farthest two neighbouring places of a line of sight may be apart,
 * in radii. They are a radius apart on the screen, so this far apart on
 * the ground only towards the horizon of a steeply tilted map, where the
 * radius spans a few pixels at most; there the line ends, which keeps the
 * search for the segments near it (see readoutAt) to a few cells.
 */
const SIGHT_MAX_GAP_RADII = 8;

/**
 * The heights are counted in bins this many feet high, a higher one in the
 * last, and the band a readout names is BAND_WIDTH_BINS of them (400 ft)
 */
const BAND_BIN_FT = 100;
const BAND_BINS = SIGHT_TOP_FT / BAND_BIN_FT;
const BAND_WIDTH_BINS = 4;

/** Rows of a grid are numbered into one key with their column */
const ROW_STRIDE = 2 ** 22;

/**
 * The radius a readout is for where a CSS pixel in the middle of the map
 * spans `metresPerPx`: the one of READOUT_RADII_M nearest (by ratio) to
 * `radiusPx`, the reach of the glow of a stretch at the map's zoom (see
 * cloudReachPx in ui/heatCloudShaders.ts)
 */
export function readoutRadiusM(metresPerPx: number, radiusPx: number): number {
  const off = (radius: number): number =>
    Math.abs(Math.log(radius / (radiusPx * metresPerPx)));
  return READOUT_RADII_M.reduce((best, radius) =>
    off(radius) < off(best) ? radius : best,
  );
}

/**
 * Visit every segment that may come within `reachM` of one of `places`,
 * once per call: those in the cells within that reach, and a cell further.
 * Some are further away; the caller measures.
 */
export type SegmentGrid = (
  places: readonly Readonly<Coordinate>[],
  reachM: number,
  visit: (index: number) => void,
) => void;

/**
 * The segments of a dataset by the cells of a grid they pass through, the
 * cells `cellM` high and about as wide at the first segment. A segment goes
 * into the cells of points along it no more than half a cell apart, so
 * every point of it is in the cell of one of them or in a cell next to it;
 * one across the antimeridian into the cells of its ends. The columns go
 * round the world a whole number of times and wrap, so a place on one
 * side of the antimeridian finds the segments on the other.
 */
export function makeSegmentGrid(
  segments: readonly PathSegment[],
  cellM: number,
): SegmentGrid {
  const rowDeg = cellM / METRES_PER_DEGREE;
  const columns = Math.ceil(
    (360 / rowDeg) *
      Math.max(
        Math.cos((segments[0]?.coords[0][0] ?? 0) * DEGREES_TO_RADIANS),
        0.1,
      ),
  );
  const columnDeg = 360 / columns;
  /** The key of a cell, its column wrapped round the world */
  const keyOf = (row: number, column: number): number =>
    row * ROW_STRIDE + (((column % columns) + columns) % columns);
  const cells = new Map<number, number[]>();
  segments.forEach(({ coords: [[lat0, lng0], [lat1, lng1]] }, index) => {
    const steps =
      Math.abs(lng1 - lng0) > 180
        ? 1
        : Math.ceil(
            2 *
              Math.max(
                Math.abs(lng1 - lng0) / columnDeg,
                Math.abs(lat1 - lat0) / rowDeg,
                0.5,
              ),
          );
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const key = keyOf(
        Math.floor((lat0 + (lat1 - lat0) * t) / rowDeg),
        Math.floor((lng0 + (lng1 - lng0) * t) / columnDeg),
      );
      const list = cells.get(key);
      if (!list) cells.set(key, [index]);
      else if (list[list.length - 1] !== index) list.push(index);
    }
  });
  /** The call that last met each segment */
  const met = new Uint32Array(segments.length);
  let call = 0;
  return (places, reachM, visit) => {
    call++;
    const reachLat = reachM / METRES_PER_DEGREE;
    for (const [lat, lng] of places) {
      const reachLng =
        reachLat / Math.max(Math.cos(lat * DEGREES_TO_RADIANS), 0.01);
      const columnFrom = Math.floor((lng - reachLng) / columnDeg) - 1;
      const columnTo = Math.floor((lng + reachLng) / columnDeg) + 1;
      const rowTo = Math.floor((lat + reachLat) / rowDeg) + 1;
      for (
        let row = Math.floor((lat - reachLat) / rowDeg) - 1;
        row <= rowTo;
        row++
      ) {
        for (let column = columnFrom; column <= columnTo; column++) {
          for (const index of cells.get(keyOf(row, column)) ?? []) {
            if (met[index] === call) continue;
            met[index] = call;
            visit(index);
          }
        }
      }
    }
  };
}

/** What the readouts of a dataset are worked out from */
export interface ReadoutData {
  segments: readonly PathSegment[];
  /** The heat of each segment in seconds, as the cloud weighs it */
  seconds: Float32Array;
  /** The height of each segment above its flight's ground, in feet */
  heightsFt: Float32Array;
  /** The highest of them, at most SIGHT_TOP_FT */
  topFt: number;
}

/** What is kept for a dataset: its seconds, heights and grids */
interface Kept {
  /** By how they are weighed (heatWeight, or one a test asks for) */
  seconds: Map<SegmentWeight, Float32Array>;
  /** By the relief level of their ground, -1 for the line of the fields */
  heights: Map<number, { heightsFt: Float32Array; topFt: number }>;
  /** By the radius they are for, the one asked for last at the end */
  grids: Map<number, SegmentGrid>;
}

let kept = new WeakMap<readonly PathSegment[], Kept>();

function keptFor(segments: readonly PathSegment[]): Kept {
  let entry = kept.get(segments);
  if (!entry) {
    entry = { seconds: new Map(), heights: new Map(), grids: new Map() };
    kept.set(segments, entry);
  }
  return entry;
}

/**
 * The seconds and heights of the segments of a dataset, worked out the
 * first time they are asked for and kept with it. The seconds are the heat
 * of each segment as `weigh` weighs it, the cloud's. The heights are the
 * cloud's: above the ground the build sampled, smoothed for the relief
 * level `level`, where `sampled` (the relief is drawn), and above the line
 * between the fields otherwise (see groundProfilesFt), never below 0.
 */
export function readoutData(
  segments: readonly PathSegment[],
  sampled: boolean,
  level: number,
  weigh: SegmentWeight = heatWeight,
): ReadoutData {
  const entry = keptFor(segments);
  let seconds = entry.seconds.get(weigh);
  if (!seconds) {
    seconds = Float32Array.from(segments, (segment, index) =>
      weigh(segment, segments[index + 1]),
    );
    entry.seconds.set(weigh, seconds);
  }
  const key = sampled ? level : -1;
  let heights = entry.heights.get(key);
  if (!heights) {
    const { ground } = groundProfilesFt(segments, sampled, level);
    const heightsFt = new Float32Array(segments.length);
    let topFt = 0;
    segments.forEach((segment, index) => {
      const feet = Math.max(segment.altitude_ft - ground[index]!, 0);
      heightsFt[index] = feet;
      topFt = Math.max(topFt, feet);
    });
    heights = { heightsFt, topFt: Math.min(topFt, SIGHT_TOP_FT) };
    entry.heights.set(key, heights);
  }
  return { segments, seconds, ...heights };
}

/**
 * How many grids are kept per dataset, those of the radii asked for last.
 * The finer the grid, the more cells a segment is in: for 130,000
 * segments the one of 100 m took 13 MB, the one of 1 km 2.3 MB, and a
 * zoom from a region to a field would have kept all of them.
 */
const GRIDS_KEPT = 3;

/**
 * The grid of the segments of a dataset for readouts of `radiusM`, made the
 * first time and kept with it, among the GRIDS_KEPT asked for last. Its
 * cells are twice the radius, so a place looks in about four by four of
 * them.
 */
export function segmentGrid(
  segments: readonly PathSegment[],
  radiusM: number,
): SegmentGrid {
  const grids = keptFor(segments).grids;
  let grid = grids.get(radiusM);
  if (grid) {
    grids.delete(radiusM);
  } else {
    grid = makeSegmentGrid(segments, radiusM * 2);
    const oldest = grids.keys().next();
    if (!oldest.done && grids.size >= GRIDS_KEPT) grids.delete(oldest.value);
  }
  grids.set(radiusM, grid);
  return grid;
}

/**
 * Whether what a readout of `radiusM` is worked out from is kept for the
 * dataset: its seconds as `weigh` weighs them, its heights on the ground of
 * `sampled` and `level` (see readoutData) and its grid for the radius (see
 * segmentGrid). Each took some 5 to 35 ms to make for 135,000 segments on
 * a desktop, several times that on a phone, which the pointer's frames
 * leave to a moment of their own.
 */
export function readoutKept(
  segments: readonly PathSegment[],
  sampled: boolean,
  level: number,
  weigh: SegmentWeight,
  radiusM: number,
): boolean {
  const entry = kept.get(segments);
  return (
    !!entry &&
    entry.seconds.has(weigh) &&
    entry.heights.has(sampled ? level : -1) &&
    entry.grids.has(radiusM)
  );
}

/** Let go of what was kept for every dataset, as the 3D view goes */
export function releaseReadoutData(): void {
  kept = new WeakMap();
}

/**
 * A line of sight through the pointer: the places on the ground below its
 * points at heights `stepFt` apart from the ground up, `places[k]` at
 * `k * stepFt`. A single place is the line looking straight down, or at
 * flights drawn flat.
 */
export interface SightLine {
  places: readonly Readonly<Coordinate>[];
  stepFt: number;
}

/**
 * The line of sight through the point `x`, `y` of the screen, up to
 * `topFt` above the ground: `placeAt` gives the place on the ground drawn
 * at a point of the screen, null where none is (the sky, space), and
 * `liftPxPerFt` how far up the screen a foot of height is drawn (see
 * liftOffsetPx), 0 for none. A point of the line drawn at the pointer
 * stands on the ground that far down the screen. Sampled every `radiusPx`
 * of the screen, so that neighbouring places are about a radius
 * (`radiusM`) apart, at SIGHT_MAX_STEPS heights over the ground at most.
 *
 * Null where the pointer is on no ground, or on ground so far off that the
 * next place is more than SIGHT_MAX_GAP_RADII away: a radius there is less
 * than a few pixels. Further up the line ends at the first such place, and
 * the flights above its last are measured against that one.
 */
export function sightLine(
  x: number,
  y: number,
  topFt: number,
  liftPxPerFt: number,
  radiusPx: number,
  radiusM: number,
  placeAt: (x: number, y: number) => Coordinate | null,
): SightLine | null {
  const steps = Math.min(
    Math.ceil((topFt * liftPxPerFt) / radiusPx) || 0,
    SIGHT_MAX_STEPS,
  );
  const stepFt = steps > 0 ? topFt / steps : 0;
  const first = placeAt(x, y);
  if (!first) return null;
  const places: Coordinate[] = [first];
  for (let k = 1; k <= steps; k++) {
    const place = placeAt(x, y + k * stepFt * liftPxPerFt);
    if (
      !place ||
      planarMetres(places[k - 1]!, place) > SIGHT_MAX_GAP_RADII * radiusM
    ) {
      break;
    }
    places.push(place);
  }
  return steps > 0 && places.length < 2 ? null : { places, stepFt };
}

/**
 * The place of `sight` at `heightFt`, between the two samples around it,
 * the short way round where they lie either side of the antimeridian
 */
function placeOf({ places, stepFt }: SightLine, heightFt: number): Coordinate {
  const last = places.length - 1;
  const at = last > 0 ? Math.min(heightFt / stepFt, last) : 0;
  const k = Math.min(Math.floor(at), Math.max(last - 1, 0));
  const t = at - k;
  const [lat0, lng0] = places[k]!;
  const [lat1, lng1] = places[Math.min(k + 1, last)]!;
  return [lat0 + (lat1 - lat0) * t, lng0 + turnOf(lng0, lng1) * t];
}

/**
 * The part of the segment from `a` to `b` (metres from the middle of a
 * circle) that lies within `radius` of it, from 0 to 1. A segment of no
 * length is all within or all without.
 */
export function insideFraction(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const a = dx * dx + dy * dy;
  const c = ax * ax + ay * ay - radius * radius;
  if (a === 0) return c <= 0 ? 1 : 0;
  const b = ax * dx + ay * dy;
  const root = Math.sqrt(Math.max(b * b - a * c, 0));
  return Math.max(
    Math.min((root - b) / a, 1) - Math.max((-b - root) / a, 0),
    0,
  );
}

/** What a readout says */
export interface CloudReadout {
  /** The radius it is for, in metres */
  radiusM: number;
  /** The seconds spent within it */
  seconds: number;
  /** The flights that came within it */
  flights: number;
  /**
   * The BAND_WIDTH_BINS bins of height above the ground (fromFt to toFt)
   * that hold the most of the time, and the part of it they hold (0 to 1)
   */
  band: { fromFt: number; toFt: number; share: number };
}

/**
 * The readout of the flights `keep` accepts within `radiusM` of the line of
 * sight `sight`, or null where none came that close. A segment is measured
 * against the place of the line at its own height, and counts with the
 * part of its seconds that its part within the radius is of its length;
 * one of no heat counts for nothing, as the cloud draws nothing of it.
 */
export function readoutAt(
  { segments, seconds, heightsFt }: ReadoutData,
  grid: SegmentGrid,
  sight: SightLine,
  radiusM: number,
  keep: (pathId: number) => boolean,
): CloudReadout | null {
  const flights = new Set<number>();
  const bins = new Float64Array(BAND_BINS);
  let total = 0;
  // A place between two samples is at most half their distance from one,
  // and those are SIGHT_MAX_GAP_RADII apart at most (see sightLine)
  let widest = 0;
  for (let k = 1; k < sight.places.length; k++) {
    widest = Math.max(
      widest,
      planarMetres(sight.places[k - 1]!, sight.places[k]!),
    );
  }
  grid(sight.places, radiusM + widest / 2, (index) => {
    const segment = segments[index]!;
    const heightFt = heightsFt[index]!;
    if (!keep(segment.path_id)) return;
    const [lat, lng] = placeOf(sight, heightFt);
    const across = METRES_PER_DEGREE * Math.cos(lat * DEGREES_TO_RADIANS);
    const [[lat0, lng0], [lat1, lng1]] = segment.coords;
    // East of the place the short way round, and the far end from the
    // near one: a segment across the antimeridian is not a world away
    const x0 = turnOf(lng, lng0) * across;
    const part = insideFraction(
      x0,
      (lat0 - lat) * METRES_PER_DEGREE,
      x0 + turnOf(lng0, lng1) * across,
      (lat1 - lat) * METRES_PER_DEGREE,
      radiusM,
    );
    const spent = seconds[index]! * part;
    if (!(spent > 0)) return;
    flights.add(segment.path_id);
    total += spent;
    bins[Math.min(Math.floor(heightFt / BAND_BIN_FT), BAND_BINS - 1)]! += spent;
  });
  if (flights.size === 0) return null;
  // The run of bins that holds the most time, and of runs that hold the
  // same, the one with the most of it in its middle two
  let best = -1;
  let bestSum = 0;
  let bestFrom = 0;
  let sum = 0;
  bins.forEach((spent, i) => {
    sum += spent - (bins[i - BAND_WIDTH_BINS] ?? 0);
    const score = sum + ((bins[i - 1] ?? 0) + (bins[i - 2] ?? 0)) / 1024;
    if (score > best) {
      best = score;
      bestSum = sum;
      bestFrom = Math.max(i + 1 - BAND_WIDTH_BINS, 0);
    }
  });
  return {
    radiusM,
    seconds: total,
    flights: flights.size,
    band: {
      fromFt: bestFrom * BAND_BIN_FT,
      toFt: (bestFrom + BAND_WIDTH_BINS) * BAND_BIN_FT,
      share: Math.min(bestSum / total, 1),
    },
  };
}

/**
 * "Under a minute", "About 42 min", "About 3 h 25 min" (to five minutes
 * from the hour) or, from ten hours, "About 120 h": the page's words for a
 * length of time (formatDuration), rounded
 */
export function formatTimeSpent(seconds: number): string {
  if (seconds < 60) return "Under a minute";
  const rounded = seconds < 3600 ? seconds : Math.round(seconds / 300) * 300;
  return `About ${formatDuration(rounded)}`;
}

/**
 * What a readout says, in two parts: the time within the radius, and the
 * flights and the heights ("17 flights · mostly 800 to 1,200 ft AGL").
 * "Mostly" is for a band that holds at least half of it, "most often" for
 * one that only holds more than any other.
 */
export function readoutText({
  radiusM,
  seconds,
  flights,
  band,
}: CloudReadout): { time: string; detail: string } {
  const radius =
    radiusM < 1000 ? `${radiusM} m` : `${formatNumber(radiusM / 1000)} km`;
  return {
    time: `${formatTimeSpent(seconds)} within ${radius}`,
    detail:
      `${pluralFlights(flights)} · ${band.share < 0.5 ? "most often" : "mostly"} ` +
      `${formatNumber(band.fromFt)} to ${formatNumber(band.toFt)} ft AGL`,
  };
}
