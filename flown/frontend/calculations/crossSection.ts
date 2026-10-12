/**
 * The cross-section of the flights along a line on the map: where time
 * was spent within a corridor either side of it, by the distance along the
 * line and the height, as ui/crossSection.ts draws it.
 *
 * The time is the heatmap's, weighed alike (heatWeight in heatLines.ts):
 * the seconds each segment took, at most two minutes. It is shared out over
 * the part of a segment inside the corridor in proportion to its length
 * there. A circuit flown every week stands out against a route flown once,
 * as it does on the map.
 *
 * The line is measured on a plane through its start: metres east scaled by
 * the cosine of its middle latitude, and metres north. Over the few dozen
 * kilometres a line on a map of flights spans that is well within a pixel
 * of the chart.
 */
import type { PathSegment } from "../types";
import {
  DEGREES_TO_RADIANS,
  METRES_PER_DEGREE,
  turnOf,
  type Coordinate,
} from "../utils/geometry";
import { heatWeight } from "./heatLines";
import { groundLevelsFt } from "./statistics";

/** The half widths of the corridor on offer, in metres */
export const CORRIDOR_HALF_WIDTHS_M = [250, 500, 1000, 2000, 5000] as const;

/** Heights above the ground under each fix, or above sea level */
export type HeightReference = "agl" | "msl";

/** The least height the chart spans, in feet */
const MIN_SPAN_FT = 1000;

/**
 * Share of the time the chart's height leaves out at the top: one flight
 * far above the rest would otherwise squeeze them into its bottom rows
 */
const TOP_QUANTILE = 0.995;

/** Room kept above the height the chart reaches to, as a share of it */
const HEADROOM = 0.1;

/** Steps of the height grid, in feet; the first that gives few lines wins */
const GRID_STEPS_FT = [100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000];

/** Most lines of the height grid across the chart */
const MAX_GRID_LINES = 5;

/** Most pieces a stretch of a segment is cut into for the grid */
const MAX_STEPS = 256;

/**
 * Height above the ground under which a fix counts as on it, in feet:
 * taxiing, the apron and the runway, which a line across a field would
 * otherwise name as where the most time was spent
 */
const AIRBORNE_FT = 50;

/** A line on the map in its own plane (see lineFrame) */
export interface LineFrame {
  /** Where it starts, [lat, lon] */
  start: Coordinate;
  /** Its length in metres */
  lengthM: number;
  /** Metres per degree of longitude and of latitude */
  kx: number;
  ky: number;
  /** The unit vector along it, east and north */
  ux: number;
  uy: number;
}

/** The plane of a line from `start` to `end` */
export function lineFrame(start: Coordinate, end: Coordinate): LineFrame {
  const kx =
    METRES_PER_DEGREE *
    Math.cos(((start[0] + end[0]) / 2) * DEGREES_TO_RADIANS);
  const ky = METRES_PER_DEGREE;
  const x = turnOf(start[1], end[1]) * kx;
  const y = (end[0] - start[0]) * ky;
  const lengthM = Math.hypot(x, y);
  return {
    start,
    lengthM,
    kx,
    ky,
    ux: lengthM > 0 ? x / lengthM : 1,
    uy: lengthM > 0 ? y / lengthM : 0,
  };
}

/**
 * Where `point` is from the line: metres along it from its start, and
 * across it, to the left of its direction positive
 */
export function toFrame(
  frame: LineFrame,
  [lat, lon]: Coordinate,
): [along: number, across: number] {
  const x = turnOf(frame.start[1], lon) * frame.kx;
  const y = (lat - frame.start[0]) * frame.ky;
  return [x * frame.ux + y * frame.uy, y * frame.ux - x * frame.uy];
}

/** The point `along` metres along the line and `across` to its left */
export function fromFrame(
  frame: LineFrame,
  along: number,
  across: number,
): Coordinate {
  const x = along * frame.ux - across * frame.uy;
  const y = along * frame.uy + across * frame.ux;
  return [frame.start[0] + y / frame.ky, frame.start[1] + x / frame.kx];
}

/**
 * The corridor `halfWidthM` either side of the line, as its four corners,
 * [lat, lon], from the left of the start round
 */
export function corridorCorners(
  frame: LineFrame,
  halfWidthM: number,
): Coordinate[] {
  return [
    fromFrame(frame, 0, halfWidthM),
    fromFrame(frame, frame.lengthM, halfWidthM),
    fromFrame(frame, frame.lengthM, -halfWidthM),
    fromFrame(frame, 0, -halfWidthM),
  ];
}

/**
 * The corridor as a ring of points, [lat, lon], from the left of the start
 * round and back to it, and the line along its middle. The sides are cut
 * into `pieces`: the corridor is straight in the plane it is measured in,
 * which a Mercator map bends a little over a long line, and the map is to
 * draw the corridor that is counted.
 */
export function corridorOutline(
  frame: LineFrame,
  halfWidthM: number,
  pieces = 16,
): { ring: Coordinate[]; line: Coordinate[] } {
  const side = (across: number): Coordinate[] =>
    Array.from({ length: pieces + 1 }, (_, i) =>
      fromFrame(frame, (frame.lengthM * i) / pieces, across),
    );
  const ring = [...side(halfWidthM), ...side(-halfWidthM).reverse()];
  return { ring: [...ring, ring[0]!], line: side(0) };
}

/**
 * The span of the parameter of a segment from `a` to `b` (0 to 1) that lies
 * inside the corridor, [0, length] along and within `halfWidth` across; null
 * where none does. Liang and Barsky's clipping.
 */
export function clipToCorridor(
  a: readonly [number, number],
  b: readonly [number, number],
  lengthM: number,
  halfWidthM: number,
): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  // Each edge as p * t <= q, in a plain loop rather than a closure that
  // writes t0 and t1: it runs for every segment near the line, every frame
  // of a drag
  for (let edge = 0; edge < 4; edge++) {
    const p = edge === 0 ? -dx : edge === 1 ? dx : edge === 2 ? -dy : dy;
    const q =
      edge === 0
        ? a[0]
        : edge === 1
          ? lengthM - a[0]
          : edge === 2
            ? a[1] + halfWidthM
            : halfWidthM - a[1];
    if (p === 0) {
      if (!(q >= 0)) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return t1 > t0 ? [t0, t1] : null;
}

/** What to cut the section of, see crossSection */
export interface SectionRequest {
  segments: readonly PathSegment[];
  /** Whether a flight counts: the filters, and the selection */
  keep: (pathId: number) => boolean;
  start: Coordinate;
  end: Coordinate;
  halfWidthM: number;
  reference: HeightReference;
  /** Cells of the grid along the line and up */
  columns: number;
  rows: number;
}

/** The time within a corridor along a line, by distance and height */
export interface CrossSection {
  lengthM: number;
  halfWidthM: number;
  reference: HeightReference;
  columns: number;
  rows: number;
  /** The heights at the bottom and the top of the grid, in feet */
  bottomFt: number;
  topFt: number;
  /** The step of the lines across the chart, in feet */
  gridStepFt: number;
  /** Seconds by cell, a row of `columns` after another from the bottom up */
  seconds: Float64Array;
  /** Seconds spent in the corridor, those above the top included */
  totalSeconds: number;
  /** Seconds spent in the corridor above the top of the grid */
  aboveSeconds: number;
  /** Flights that spent any time in the corridor */
  flights: number;
  /**
   * The ground under the flights by column, in feet above sea level: the
   * mean of what the fixes in that column stood on, carried across the
   * columns without any. Null where no flight passes.
   */
  groundFt: Float64Array | null;
  /**
   * Whether the ground is the terrain under the flights (so heights above
   * it are AGL), not the level of each flight's field
   */
  fromTerrain: boolean;
  /**
   * The band of height the most time in the air was spent in, in feet:
   * half a grid step, and the time on the ground left out
   */
  busiest: [number, number] | null;
}

/** The value a share `t` of the way from `from` to `to` */
function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** A stretch of a segment inside the corridor */
interface Piece {
  along0: number;
  along1: number;
  height0: number;
  height1: number;
  ground0: number;
  ground1: number;
  seconds: number;
}

/**
 * The field levels of the flights of `segments`, worked out once per
 * dataset (groundLevelsFt)
 */
const fieldLevels = new WeakMap<readonly PathSegment[], Map<number, number>>();

function fieldLevelsOf(segments: readonly PathSegment[]): Map<number, number> {
  let levels = fieldLevels.get(segments);
  if (!levels) {
    levels = groundLevelsFt(segments as PathSegment[]);
    fieldLevels.set(segments, levels);
  }
  return levels;
}

/** Whether `segment` carries on where `before` ended, in the same flight */
function carriesOn(segment: PathSegment, before: PathSegment | undefined) {
  const end = before?.coords[1];
  const start = segment.coords[0];
  return (
    before?.path_id === segment.path_id &&
    end![0] === start[0] &&
    end![1] === start[1]
  );
}

/** The first step of GRID_STEPS_FT that puts few lines across `spanFt` */
function gridStep(spanFt: number): number {
  return (
    GRID_STEPS_FT.find((step) => spanFt / step <= MAX_GRID_LINES) ??
    GRID_STEPS_FT[GRID_STEPS_FT.length - 1]!
  );
}

/**
 * The stretches of the kept flights inside the corridor, with the height
 * and the ground at either end, and the frame they are measured in
 */
function corridorPieces(request: SectionRequest): {
  pieces: Piece[];
  flights: Set<number>;
  fromTerrain: boolean;
  frame: LineFrame;
} {
  const { segments, keep, halfWidthM, reference } = request;
  const frame = lineFrame(request.start, request.end);
  const { lengthM } = frame;
  // The corridor's box in degrees, to pass over most segments unmeasured
  const corners = corridorCorners(frame, halfWidthM);
  const lats = corners.map((corner) => corner[0]);
  const lons = corners.map((corner) => corner[1]);
  const [south, north] = [Math.min(...lats), Math.max(...lats)];
  const [west, east] = [Math.min(...lons), Math.max(...lons)];
  // A corridor across the antimeridian keeps every segment to be measured
  const wraps = east - west > 180 || east > 180 || west < -180;

  const pieces: Piece[] = [];
  const flights = new Set<number>();
  let fromTerrain = true;
  const count = segments.length;
  for (let i = 0; i < count; i++) {
    const segment = segments[i]!;
    const from = segment.coords[0];
    const to = segment.coords[1];
    const lat0 = from[0];
    const lat1 = to[0];
    const lon0 = from[1];
    const lon1 = to[1];
    if (
      (lat0 < south && lat1 < south) ||
      (lat0 > north && lat1 > north) ||
      (!wraps &&
        ((lon0 < west && lon1 < west) || (lon0 > east && lon1 > east))) ||
      !keep(segment.path_id)
    ) {
      continue;
    }
    const a = toFrame(frame, from);
    const b = toFrame(frame, to);
    const span = clipToCorridor(a, b, lengthM, halfWidthM);
    if (!span) continue;
    const next = segments[i + 1];
    const seconds = heatWeight(segment, next) * (span[1] - span[0]);
    if (!(seconds > 0)) continue;

    // The altitude and the ground of a segment are those of its end; its
    // start is the end of the one before where it carries on from it
    const before = i > 0 ? segments[i - 1] : undefined;
    const joined = carriesOn(segment, before);
    let groundEnd = segment.ground_ft;
    let groundStart = joined ? before!.ground_ft : groundEnd;
    if (groundEnd === undefined || groundStart === undefined) {
      fromTerrain = false;
      const field = fieldLevelsOf(segments).get(segment.path_id) ?? 0;
      groundEnd = groundStart = field;
    }
    const altitudeEnd = segment.altitude_ft;
    const altitudeStart = joined ? before!.altitude_ft : altitudeEnd;
    const [t0, t1] = span;
    const agl = reference === "agl";
    const height0 = altitudeStart - (agl ? groundStart : 0);
    const height1 = altitudeEnd - (agl ? groundEnd : 0);
    pieces.push({
      along0: lerp(a[0], b[0], t0),
      along1: lerp(a[0], b[0], t1),
      height0: lerp(height0, height1, t0),
      height1: lerp(height0, height1, t1),
      ground0: lerp(groundStart, groundEnd, t0),
      ground1: lerp(groundStart, groundEnd, t1),
      seconds,
    });
    flights.add(segment.path_id);
  }
  return { pieces, flights, fromTerrain, frame };
}

/** The step of the heights heightQuantile counts the time in, in feet */
const QUANTILE_STEP_FT = 10;

/**
 * The height below which `quantile` of the time of `pieces` was spent, by
 * the middle of each piece, to QUANTILE_STEP_FT: counted in steps of height
 * rather than sorted, as it is worked out again for every frame an end of
 * the line is dragged in
 */
function heightQuantile(pieces: readonly Piece[], quantile: number): number {
  const middle = (piece: Piece): number => (piece.height0 + piece.height1) / 2;
  let low = Infinity;
  let high = -Infinity;
  let total = 0;
  for (const piece of pieces) {
    low = Math.min(low, middle(piece));
    high = Math.max(high, middle(piece));
    total += piece.seconds;
  }
  if (!(high >= low)) return 0;
  const steps = Math.min(
    100_000,
    Math.floor((high - low) / QUANTILE_STEP_FT) + 1,
  );
  const stepFt = Math.max(QUANTILE_STEP_FT, (high - low) / (steps - 0.5));
  const byStep = new Float64Array(steps);
  for (const piece of pieces) {
    byStep[Math.floor((middle(piece) - low) / stepFt)]! += piece.seconds;
  }
  let seen = 0;
  for (let step = 0; step < steps; step++) {
    seen += byStep[step]!;
    if (seen >= total * quantile) return low + (step + 1) * stepFt;
  }
  return high;
}

/**
 * The time the flights `request.keep` accepts spent within
 * `request.halfWidthM` of the line from `request.start` to `request.end`,
 * on a grid of `columns` along it by `rows` up. Each stretch of a flight in
 * the corridor is cut into steps no longer than half a cell either way, and
 * its seconds shared out over them.
 *
 * The grid runs from the ground (AGL) or from below the lowest ground and
 * flight (MSL) to a little over the height below which all but half a per
 * cent of the time was spent, in whole steps of its grid lines.
 */
export function crossSection(request: SectionRequest): CrossSection {
  const { columns, rows, reference, halfWidthM } = request;
  const { pieces, flights, fromTerrain, frame } = corridorPieces(request);
  const { lengthM } = frame;

  let lowest = reference === "agl" ? 0 : Infinity;
  if (reference === "msl") {
    for (const piece of pieces) {
      lowest = Math.min(
        lowest,
        piece.height0,
        piece.height1,
        piece.ground0,
        piece.ground1,
      );
    }
    if (lowest === Infinity) lowest = 0;
  }
  const reach = pieces.length ? heightQuantile(pieces, TOP_QUANTILE) : 0;
  const wanted = reach + Math.max(0, reach - lowest) * HEADROOM;
  const gridStepFt = gridStep(Math.max(MIN_SPAN_FT, wanted - lowest));
  const bottomFt =
    reference === "agl" ? 0 : Math.floor(lowest / gridStepFt) * gridStepFt;
  const span = Math.max(MIN_SPAN_FT, wanted - bottomFt);
  const topFt = bottomFt + Math.ceil(span / gridStepFt) * gridStepFt;

  const seconds = new Float64Array(columns * rows);
  const columnM = lengthM / columns;
  const rowFt = (topFt - bottomFt) / rows;
  const groundSum = new Float64Array(columns);
  const groundCount = new Uint32Array(columns);
  /** The seconds in the air by row */
  const flown = new Float64Array(rows);
  let totalSeconds = 0;
  let aboveSeconds = 0;
  for (const piece of pieces) {
    totalSeconds += piece.seconds;
    const steps = Math.min(
      MAX_STEPS,
      Math.max(
        1,
        Math.ceil((2 * Math.abs(piece.along1 - piece.along0)) / columnM),
        Math.ceil((2 * Math.abs(piece.height1 - piece.height0)) / rowFt),
      ),
    );
    const share = piece.seconds / steps;
    for (let step = 0; step < steps; step++) {
      const t = (step + 0.5) / steps;
      const along = piece.along0 + (piece.along1 - piece.along0) * t;
      const height = piece.height0 + (piece.height1 - piece.height0) * t;
      const column = Math.min(columns - 1, Math.max(0, (along / columnM) | 0));
      const groundAt = piece.ground0 + (piece.ground1 - piece.ground0) * t;
      groundSum[column]! += groundAt;
      groundCount[column]!++;
      const aboveGround = reference === "agl" ? height : height - groundAt;
      // A height a little below the ground is the elevation model's error
      const row = Math.max(0, Math.floor((height - bottomFt) / rowFt));
      if (row >= rows) {
        aboveSeconds += share;
        continue;
      }
      seconds[row * columns + column]! += share;
      if (aboveGround >= AIRBORNE_FT) flown[row]! += share;
    }
  }

  return {
    lengthM,
    halfWidthM,
    reference,
    columns,
    rows,
    bottomFt,
    topFt,
    gridStepFt,
    seconds,
    totalSeconds,
    aboveSeconds,
    flights: flights.size,
    groundFt: pieces.length ? fillGround(groundSum, groundCount) : null,
    fromTerrain,
    busiest: busiestBand(flown, bottomFt, rowFt, gridStepFt),
  };
}

/**
 * The mean ground of each column from the sums and counts of its fixes,
 * carried in a straight line across the columns without any, and flat
 * beyond the first and the last with some
 */
function fillGround(sums: Float64Array, counts: Uint32Array): Float64Array {
  const ground = new Float64Array(sums.length);
  let last = -1;
  for (let column = 0; column < sums.length; column++) {
    if (!counts[column]) continue;
    ground[column] = sums[column]! / counts[column]!;
    const from = last < 0 ? column : last;
    for (let gap = last + 1; gap < column; gap++) {
      const t = from === column ? 1 : (gap - from) / (column - from);
      ground[gap] = ground[from]! + (ground[column]! - ground[from]!) * t;
    }
    last = column;
  }
  for (let gap = last + 1; gap < sums.length; gap++)
    ground[gap] = ground[last]!;
  return ground;
}

/**
 * The band of half a grid step the most of `byRow` was spent in, as its
 * bottom and top in feet; null without any time
 */
function busiestBand(
  byRow: Float64Array,
  bottomFt: number,
  rowFt: number,
  gridStepFt: number,
): [number, number] | null {
  const bandFt = gridStepFt / 2;
  const bands = new Map<number, number>();
  for (let row = 0; row < byRow.length; row++) {
    const sum = byRow[row]!;
    if (!sum) continue;
    const band = Math.floor((bottomFt + (row + 0.5) * rowFt) / bandFt);
    bands.set(band, (bands.get(band) ?? 0) + sum);
  }
  let best: number | null = null;
  for (const [band, sum] of bands) {
    if (best === null || sum > bands.get(best)!) best = band;
  }
  return best === null ? null : [best * bandFt, (best + 1) * bandFt];
}

/**
 * The corridor for a map at `metresPerPixel`: the half width on offer
 * nearest to `pixels` on the screen, on a scale of ratios, so the corridor
 * is about as wide on the screen at every zoom it is drawn at
 */
export function corridorForScale(metresPerPixel: number, pixels = 40): number {
  const wanted = metresPerPixel * pixels;
  let best: number = CORRIDOR_HALF_WIDTHS_M[0];
  for (const width of CORRIDOR_HALF_WIDTHS_M) {
    if (
      Math.abs(Math.log(width / wanted)) < Math.abs(Math.log(best / wanted))
    ) {
      best = width;
    }
  }
  return best;
}

/**
 * The seconds in the cells up to `radius` from the one of `column` and
 * `row` either way, as far as the grid reaches
 */
export function windowSeconds(
  section: CrossSection,
  column: number,
  row: number,
  radius: number,
): number {
  const { columns, rows, seconds } = section;
  let sum = 0;
  for (let r = Math.max(0, row - radius); r <= row + radius && r < rows; r++) {
    for (
      let c = Math.max(0, column - radius);
      c <= column + radius && c < columns;
      c++
    ) {
      sum += seconds[r * columns + c]!;
    }
  }
  return sum;
}

/**
 * `values`, a grid of `columns` by `rows`, smoothed by a cell either way
 * (a kernel of 1, 2, 1 across and up), so the chart reads as a density
 * rather than as cells. It reaches no further than a cell, well within the
 * cells the readout adds up (see windowSeconds). Written into `out`, by
 * way of `across`, which a chart that draws a section on every frame of a
 * drag hands it again each time.
 */
export function smoothCells(
  values: Float64Array,
  columns: number,
  rows: number,
  out = new Float64Array(values.length),
  across = new Float64Array(values.length),
): Float64Array {
  const pass = (
    from: Float64Array,
    to: Float64Array,
    step: number,
    length: number,
    at: (index: number) => number,
  ): Float64Array => {
    for (let index = 0; index < from.length; index++) {
      const position = at(index);
      let sum = 2 * from[index]!;
      let weight = 2;
      if (position > 0) {
        sum += from[index - step]!;
        weight++;
      }
      if (position < length - 1) {
        sum += from[index + step]!;
        weight++;
      }
      to[index] = sum / weight;
    }
    return to;
  };
  pass(values, across, 1, columns, (index) => index % columns);
  return pass(across, out, columns, rows, (index) => (index / columns) | 0);
}
