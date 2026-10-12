/**
 * The heat lines: the flights as lines, each stretch of them telling how
 * long the aircraft spent around it.
 *
 * The heatmap hands over to them when zoomed in (see HEAT_LINES in
 * constants.ts), and they keep saying what it said: where the time was
 * spent, both weighing each stretch alike (heatWeight). Here the time is
 * added up per cell of a grid over the ground, and every stretch takes the
 * time of the cells it lies in. A taxiway, a holding point or a circuit
 * flown every week come out hot; a route flown once at cruise speed stays
 * cool.
 */
import type { PathSegment } from "../types";
import { DEGREES_TO_RADIANS, METRES_PER_DEGREE } from "../utils/geometry";
import { toLngLat, type LngLatTuple } from "../utils/mapHelpers";
import { appendCurve, flatCurves } from "./curves";
import type { SmoothedFlights } from "./smoothing";
import { segmentDistance } from "./statistics";

/**
 * Edge of a grid cell in metres. About the width of a taxiway: the tracks
 * of one taxi route fall into the same cells, those of the next taxiway
 * over do not.
 */
const HEAT_CELL_M = 40;
/**
 * A segment that took longer than this is a break in the log (the logger
 * paused, the aircraft stood with it switched off), not time spent on it
 */
const MAX_LOGGED_STEP_S = 600;
/** Most time one segment adds, so a long stand at one spot saturates */
const MAX_SEGMENT_S = 120;
const KNOTS_TO_METRES_PER_SECOND = 1852 / 3600;
/** Rows of the grid are numbered into one key with their column */
const ROW_STRIDE = 2 ** 22;
const COLUMN_OFFSET = 2 ** 21;

/**
 * How long a segment took. A segment's time is when it starts, so the time
 * of the next one of its path is when it ends. The last segment of a path,
 * and a track without times (a planned route, an old export), fall back to
 * its length at its groundspeed, and to no time at all without either.
 * The heat cloud of the 3D view counts the time alike (heatCloud.ts). It
 * is at most `most` seconds, MAX_SEGMENT_S for the heat.
 */
export function segmentSeconds(
  segment: PathSegment,
  next: PathSegment | undefined,
  most = MAX_SEGMENT_S,
): number {
  let seconds = -1;
  if (
    next?.path_id === segment.path_id &&
    segment.time !== undefined &&
    next.time !== undefined
  ) {
    seconds = next.time - segment.time;
  }
  if (seconds < 0 || seconds > MAX_LOGGED_STEP_S) {
    const knots = segment.groundspeed_knots;
    seconds =
      knots > 1
        ? (segmentDistance(segment) * 1000) /
          (knots * KNOTS_TO_METRES_PER_SECOND)
        : 0;
  }
  return Math.min(seconds, most);
}

/**
 * How much heat a segment carries, in seconds (see heatWeight); `next` is
 * the segment after it in the dataset
 */
export type SegmentWeight = (
  segment: PathSegment,
  next: PathSegment | undefined,
) => number;

/**
 * The speed a stretch without times or speeds is counted at, in metres per
 * second: a cruise at 100 kt, the one the heat cloud's glow is calibrated
 * for (see CLOUD_REFERENCE_SPEED_MS in ui/heatCloudShaders.ts)
 */
export const CRUISE_SPEED_MS = 51.4;

/**
 * The heat of a segment, as the heatmap, its lines and the heat cloud all
 * count it: the seconds spent on it (segmentSeconds). A track without
 * times or speeds counts as flown at CRUISE_SPEED_MS rather than not at
 * all, and no segment adds more than MAX_SEGMENT_S: the heatmap puts it on
 * one point and the lines on its ends, so a leg of a planned route
 * kilometres long would otherwise glow at its corners.
 */
export function heatWeight(
  segment: PathSegment,
  next: PathSegment | undefined,
): number {
  return (
    segmentSeconds(segment, next) ||
    Math.min((segmentDistance(segment) * 1000) / CRUISE_SPEED_MS, MAX_SEGMENT_S)
  );
}

/** The cells of the grid: a row per `HEAT_CELL_M` of latitude */
const ROW_DEGREES = HEAT_CELL_M / METRES_PER_DEGREE;

function rowOf(lat: number): number {
  return Math.floor(lat / ROW_DEGREES);
}

/**
 * The width in degrees of the columns of `row` in a grid whose rows are
 * `rowDegrees` of latitude: as wide as a row is high at its middle, so the
 * cells stay square from the equator to the north of Norway. The hotspots'
 * grid is one too, of cells of its own size (calculations/hotspots.ts).
 */
export function columnWidth(row: number, rowDegrees: number): number {
  return rowDegrees / Math.cos((row + 0.5) * rowDegrees * DEGREES_TO_RADIANS);
}

/** A column is `HEAT_CELL_M` wide at the middle of its row (columnWidth) */
function columnOf(row: number, lng: number): number {
  let width = columnWidths.get(row);
  if (width === undefined) {
    width = columnWidth(row, ROW_DEGREES);
    columnWidths.set(row, width);
  }
  return Math.floor(lng / width);
}

/** Width of the columns by row, in degrees: a row is met again and again */
const columnWidths = new Map<number, number>();

/**
 * The key of the cell of a row and a column, for a grid of cells of any
 * size (the hotspots use it for theirs, calculations/hotspots.ts)
 */
export function cellKey(row: number, column: number): number {
  return row * ROW_STRIDE + column + COLUMN_OFFSET;
}

/**
 * The time spent around a point: the most any cell of the three by three
 * around its own holds. A fix a few metres off the line the others share
 * still counts as on it.
 */
function secondsAround(
  cells: Map<number, number>,
  [lat, lng]: [number, number],
): number {
  const row = rowOf(lat);
  const column = columnOf(row, lng);
  let most = 0;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const seconds = cells.get(cellKey(row + dr, column + dc)) ?? 0;
      if (seconds > most) most = seconds;
    }
  }
  return most;
}

/** The least heat a stretch is drawn with, in seconds */
const MIN_SECONDS = 0.5;
/**
 * Segments on either side of one that its heat is averaged over. The time
 * around a stretch jumps from cell to cell of the grid; rounded to steps as
 * it is, it made a busy band flicker between two shades. Five segments of
 * a flight in the air are about a kilometre, on the ground a few dozen
 * metres, both far less than a change of place the map has to show.
 */
const SMOOTHING_SEGMENTS = 2;

/**
 * The heat of each stretch, averaged (as a power of two, so a geometric
 * mean) over its neighbours along the same flight: `heats` by segment,
 * `joins` telling where a segment carries on the one before. A mean never
 * reaches across a gap in the log or into another flight.
 */
function smoothAlongFlights(
  heats: Float64Array,
  joins: Uint8Array,
): Float64Array {
  const smoothed = new Float64Array(heats.length);
  let runStart = 0;
  for (let index = 0; index <= heats.length; index++) {
    if (index < heats.length && (index === 0 || joins[index])) continue;
    // A run of joined segments ends before `index`
    for (let at = runStart; at < index; at++) {
      const from = Math.max(runStart, at - SMOOTHING_SEGMENTS);
      const to = Math.min(index - 1, at + SMOOTHING_SEGMENTS);
      let sum = 0;
      for (let i = from; i <= to; i++) sum += heats[i]!;
      smoothed[at] = sum / (to - from + 1);
    }
    runStart = index;
  }
  return smoothed;
}

/**
 * The content of the heat line source: the flights `keep` accepts, `[lng,
 * lat]`, as lines with the seconds spent around them as `heat`.
 *
 * Every segment's time goes half to the cell of each end. A segment then
 * takes the lesser of the time around its two ends: one that only crosses
 * a busy place (a departure across the runway) is not drawn as busy along
 * its whole length. Only the kept flights count, and of them the segments
 * with any heat, so a filter or a weighing recolours the lines the way it
 * redraws the heatmap.
 *
 * The heat is then smoothed along each flight and rounded to a power of
 * two, so that neighbouring segments of about the same heat merge into one
 * line: far fewer features for the map's worker than one per segment. That
 * is two steps per stop of the colour ramp, which the eye does not tell
 * apart on a line. The lines run along the curve through the fixes (see
 * calculations/curves.ts), the way the colour lines do; the time is added
 * up at the fixes, where it was logged. `tone` rolls the time around a
 * segment off before it is smoothed (see heatLineTone in
 * calculations/heatTone.ts).
 */
export function heatLineFeatures(
  segments: readonly PathSegment[],
  keep: (pathId: number) => boolean,
  weigh: SegmentWeight = heatWeight,
  tone: (seconds: number) => number = (seconds) => seconds,
): GeoJSON.FeatureCollection<GeoJSON.LineString, { heat: number }> {
  return heatLinesAlong(flatCurves(segments), segments, keep, weigh, tone);
}

/**
 * heatLineFeatures along `curves`, the curves of `segments` (see
 * flatCurves). The year worker works the lines out along the flights it
 * holds (see heatLinesSource in services/flightLines.ts), which leaves them
 * out of what a first visit downloads and off the main thread.
 */
export function heatLinesAlong(
  curves: SmoothedFlights,
  segments: readonly PathSegment[],
  keep: (pathId: number) => boolean,
  weigh: SegmentWeight,
  tone: (seconds: number) => number,
): GeoJSON.FeatureCollection<GeoJSON.LineString, { heat: number }> {
  const kept: PathSegment[] = [];
  /** Where each kept segment is in `segments`, and so on its curve */
  const keptIndex: number[] = [];
  const cells = new Map<number, number>();
  const addTo = ([lat, lng]: [number, number], seconds: number): void => {
    const row = rowOf(lat);
    const key = cellKey(row, columnOf(row, lng));
    cells.set(key, (cells.get(key) ?? 0) + seconds);
  };

  segments.forEach((segment, index) => {
    if (!keep(segment.path_id)) return;
    const seconds = weigh(segment, segments[index + 1]);
    // No heat, no line: what only the flights in the air leave out is not
    // drawn, as the heatmap leaves out its point
    if (!(seconds > 0)) return;
    addTo(segment.coords[0], seconds / 2);
    addTo(segment.coords[1], seconds / 2);
    kept.push(segment);
    keptIndex.push(index);
  });

  // The heat of every kept segment, as a power of two, and whether it
  // carries on the one before (same flight, no gap in the log)
  const heats = new Float64Array(kept.length);
  const joins = new Uint8Array(kept.length);
  // The end of one segment is the start of the next: look it up once
  let lastEndSeconds = 0;
  kept.forEach((segment, index) => {
    const [start, end] = segment.coords;
    const last = index > 0 ? kept[index - 1]! : null;
    const lastEnd = last?.coords[1];
    const carriesOn =
      last?.path_id === segment.path_id &&
      lastEnd?.[0] === start[0] &&
      lastEnd[1] === start[1];
    joins[index] = carriesOn ? 1 : 0;
    const startSeconds = carriesOn
      ? lastEndSeconds
      : secondsAround(cells, start);
    lastEndSeconds = secondsAround(cells, end);
    heats[index] = Math.log2(
      Math.max(tone(Math.min(startSeconds, lastEndSeconds)), MIN_SECONDS),
    );
  });

  const smoothed = smoothAlongFlights(heats, joins);

  const features: GeoJSON.Feature<GeoJSON.LineString, { heat: number }>[] = [];
  let line: LngLatTuple[] = [];
  let lineStep = 0;
  const flush = (): void => {
    if (line.length >= 2) {
      features.push({
        type: "Feature",
        properties: { heat: 2 ** lineStep },
        geometry: { type: "LineString", coordinates: line },
      });
    }
    line = [];
  };

  kept.forEach((segment, index) => {
    const step = Math.round(smoothed[index]!);
    if (!joins[index] || step !== lineStep) {
      flush();
      line.push(toLngLat(segment.coords[0]));
      lineStep = step;
    }
    appendCurve(line, curves, keptIndex[index]!);
  });
  flush();

  return { type: "FeatureCollection", features };
}
