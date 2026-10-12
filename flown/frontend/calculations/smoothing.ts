/**
 * The curve through the fixes of a flight: a smooth line through its
 * logged positions, cut into more points where it turns, with its heights
 * eased along it and held to a slope no aircraft climbs at. The ribbons
 * of the 3D view are cut from it (ribbons.ts), and the flat lines are
 * drawn along it (curves.ts), so both lie on top of each other.
 */
import {
  DEGREES_TO_RADIANS,
  METRES_PER_DEGREE,
  planarMetres,
  type Coordinate,
} from "../utils/geometry";
import { METERS_TO_FEET } from "../utils/constants";
import { unwrapLng } from "../utils/mapHelpers";
import { liftFt } from "./liftZoom";

/**
 * The steepest a flight climbs or descends on its ribbon, in feet per foot
 * over the ground (about 17 degrees). A light aircraft climbs at a tenth
 * of that and descends on a glide path of a twentieth, so no flight is
 * changed by it; a height that jumps while the aircraft stands or rolls,
 * as the altitude of a GPS settles before takeoff, would otherwise stand
 * as a tower of pieces over one spot.
 */
const MAX_SLOPE = 0.3;

/**
 * How many degrees of turn at either end of a segment are one more point
 * on the curve through it, and the most points a segment is cut into. A
 * straight segment stays one, so smoothing costs only where the flight
 * turns; a straight climb stays a straight slope. The ribbons take 8, the
 * flat lines 4 (see calculations/curves.ts).
 */
const SMOOTH_TURN_DEG = 8;

const SMOOTH_MAX_STEPS = 8;

/** A line smoothed through its points, see smoothLine */
export interface SmoothedLine {
  /** `[lat, lng]` points along the curve, the given ones among them */
  points: Coordinate[];
  /** Feet above ground at each point */
  heights: number[];
  /** Where each given point is in `points` */
  vertex: number[];
  /**
   * With the ground of other levels (see SmoothOptions): the offsets of
   * each at every point, by level in the order of GROUND_LEVELS
   */
  offsets?: number[][];
  /** With a ground (see SmoothOptions): the feet of it at each point */
  ground?: number[];
}

/** Degrees the direction turns at `b`, from `a` over `b` to `c` */
function turnDeg(a: number[], b: number[], c: number[]): number {
  const ux = b[0]! - a[0]!;
  const uy = b[1]! - a[1]!;
  const vx = c[0]! - b[0]!;
  const vy = c[1]! - b[1]!;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu === 0 || lv === 0) return 0;
  const cos = Math.min(Math.max((ux * vx + uy * vy) / (lu * lv), -1), 1);
  return Math.acos(cos) / DEGREES_TO_RADIANS;
}

/**
 * A point of the centripetal Catmull-Rom spline from `p1` to `p2`, at `t`
 * from 0 to 1. Centripetal: it neither loops nor overshoots where the
 * points are unevenly spaced, as the fixes of a flight are.
 */
function catmullRom(
  p0: number[],
  p1: number[],
  p2: number[],
  p3: number[],
  t: number,
): number[] {
  const knot = (a: number[], b: number[]): number =>
    Math.max(Math.sqrt(Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!)), 1e-9);
  const t1 = knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const u = t1 + (t2 - t1) * t;
  const mix = (a: number[], b: number[], ta: number, tb: number): number[] => {
    const w = (u - ta) / (tb - ta);
    return [a[0]! + (b[0]! - a[0]!) * w, a[1]! + (b[1]! - a[1]!) * w];
  };
  const a1 = mix(p0, p1, 0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, p3, t2, t3);
  const b1 = mix(a1, a2, 0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

/**
 * The height at `t` on a segment from `h1` to `h2`, as a curve through its
 * neighbours `h0` and `h3`, never above or below the segment's own two: a
 * climb eases in and out, and a level stretch stays level
 */
function smoothHeight(
  h0: number,
  h1: number,
  h2: number,
  h3: number,
  t: number,
): number {
  const m1 = (h2 - h0) / 2;
  const m2 = (h3 - h1) / 2;
  const t2 = t * t;
  const t3 = t2 * t;
  const h =
    (2 * t3 - 3 * t2 + 1) * h1 +
    (t3 - 2 * t2 + t) * m1 +
    (-2 * t3 + 3 * t2) * h2 +
    (t3 - t2) * m2;
  return Math.min(Math.max(h, Math.min(h1, h2)), Math.max(h1, h2));
}

/** How smoothLine smooths a line */
export interface SmoothOptions {
  /** Degrees of turn per point of the curve (see SMOOTH_TURN_DEG) */
  turnStepDeg?: number | undefined;
  /**
   * The ground under each point, in feet: the heights are altitudes then,
   * and the ground is taken off them after they are smoothed
   */
  ground?: readonly number[] | undefined;
  /**
   * The ground of the levels around the one of `ground` at each point, as
   * offsets to it (see groundProfilesFt), by level: they run along the
   * curve as the ground does
   */
  offsets?: readonly (readonly number[])[] | undefined;
}

/**
 * A line of `[lat, lng]` points with the feet above ground at each, drawn
 * as a smooth curve through its points: the logged positions stay where
 * they are, and a segment where the flight turns is cut into more points
 * along a spline through its neighbours; its heights change no faster
 * than MAX_SLOPE allows. The whole of a flight is smoothed at once, so the
 * ribbons cut from it at its colour and height steps meet in the same
 * points and fit together without a seam.
 *
 * `turnStepDeg` is the turn per point of the curve. With `ground`, the ground
 * under each point, `heights` are altitudes, and are smoothed and held to the
 * slope as such before the ground is taken off: a flight level over a ridge
 * stays level, where its height above the relief changes faster than any climb.
 */
export function smoothLine(
  points: readonly Coordinate[],
  heights: readonly number[],
  { turnStepDeg = SMOOTH_TURN_DEG, ground, offsets }: SmoothOptions = {},
): SmoothedLine {
  if (points.length === 0) return { points: [], heights: [], vertex: [] };
  // The ground at every point of the curve, straight between the given
  // ones, and the offsets of the other levels' as well
  const under = ground && [ground[0]!];
  const around = offsets?.map((level) => [level[0]!]);
  // Planar metres around the line, so the curve is round on the ground
  const [lat0] = points[0]!;
  const scale = Math.cos(lat0 * DEGREES_TO_RADIANS);
  const planar = points.map(([lat, lng]) => [
    lng * scale * METRES_PER_DEGREE,
    lat * METRES_PER_DEGREE,
  ]);
  const out: SmoothedLine = {
    points: [points[0]!],
    heights: [heights[0]!],
    vertex: [0],
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const p1 = planar[i]!;
    const p2 = planar[i + 1]!;
    // Where the line ends, its neighbour is the next point mirrored: the
    // curve then leaves and arrives along the segment, straight
    const p0 = planar[i - 1] ?? [2 * p1[0]! - p2[0]!, 2 * p1[1]! - p2[1]!];
    const p3 = planar[i + 2] ?? [2 * p2[0]! - p1[0]!, 2 * p2[1]! - p1[1]!];
    const h1 = heights[i]!;
    const h2 = heights[i + 1]!;
    const h0 = heights[i - 1] ?? h1;
    const h3 = heights[i + 2] ?? h2;
    const turn = Math.max(turnDeg(p0, p1, p2), turnDeg(p1, p2, p3));
    const steps = Math.min(
      Math.max(Math.ceil(turn / turnStepDeg), 1),
      SMOOTH_MAX_STEPS,
    );
    for (let k = 1; k < steps; k++) {
      const [x, y] = catmullRom(p0, p1, p2, p3, k / steps);
      out.points.push([y! / METRES_PER_DEGREE, x! / scale / METRES_PER_DEGREE]);
      out.heights.push(smoothHeight(h0, h1, h2, h3, k / steps));
      under?.push(ground![i]! + ((ground![i + 1]! - ground![i]!) * k) / steps);
      around?.forEach((level, l) => {
        const given = offsets![l]!;
        level.push(given[i]! + ((given[i + 1]! - given[i]!) * k) / steps);
      });
    }
    out.points.push(points[i + 1]!);
    out.heights.push(h2);
    under?.push(ground![i + 1]!);
    around?.forEach((level, l) => level.push(offsets![l]![i + 1]!));
    out.vertex.push(out.points.length - 1);
  }
  limitSlope(out.points, out.heights);
  if (under) {
    out.heights = out.heights.map((feet, j) => liftFt(feet, under[j]!));
    out.ground = under;
  }
  if (around) out.offsets = around;
  return out;
}

/**
 * Hold the heights of a line to MAX_SLOPE, from its start on: a height
 * that changes faster than that over the ground to the point before is
 * taken as far as the slope allows, and the line goes on from there
 */
function limitSlope(points: readonly Coordinate[], heights: number[]): void {
  for (let i = 1; i < points.length; i++) {
    const reach =
      planarMetres(points[i - 1]!, points[i]!) * METERS_TO_FEET * MAX_SLOPE;
    const previous = heights[i - 1]!;
    heights[i] = Math.min(
      Math.max(heights[i]!, previous - reach),
      previous + reach,
    );
  }
}

/**
 * Every flight of a list of segments smoothed (see smoothLine), and where
 * each segment lies on its flight's curve. A flight is a chain of segments
 * of one path, each starting where the one before ends.
 */
export interface SmoothedFlights {
  chains: SmoothedLine[];
  /** Per segment: its chain */
  chainOf: Int32Array;
  /** Per segment: where its start is on its chain's curve */
  from: Int32Array;
  /** Per segment: where its end is on its chain's curve */
  to: Int32Array;
}

/** How smoothFlights smooths the flights */
export interface SmoothFlightsOptions {
  /** Degrees of turn per point of the curve (see SMOOTH_TURN_DEG) */
  turnStepDeg?: number | undefined;
  /**
   * The ground under the end of a segment, in feet: `heightOf` gives
   * altitudes then (see SmoothOptions)
   */
  groundOf?: ((index: number) => number) | undefined;
  /**
   * With `groundOf`, the ground of the levels around its one under the end
   * of each segment, as offsets to it by level (see groundProfilesFt)
   */
  offsets?: readonly ArrayLike<number>[] | null | undefined;
  /**
   * The curves of chains smoothed before, which are not smoothed again:
   * only for curves of the points alone, as the flat ones are (see
   * flatCurves in calculations/curves.ts)
   */
  chains?: ChainCache | undefined;
}

/**
 * Curves smoothed before, by the first segment of their chain (an index
 * into the segments being smoothed). One of another number of segments is
 * smoothed anew.
 */
export interface ChainCache {
  get(first: number): SmoothedLine | undefined;
  set(first: number, line: SmoothedLine): void;
}

/**
 * Smooth the flights of `segments`, the height of each point from
 * `heightOf`: the feet above ground a segment ends at, or with `groundOf`
 * its altitude, and the ground under it from that (see smoothLine). A
 * segment's altitude is the one at its end, so a chain's first point takes
 * the height of its first segment. `turnStepDeg` is the turn per point of
 * the curve (see SMOOTH_TURN_DEG).
 */
export function smoothFlights(
  segments: readonly {
    path_id: number;
    coords: readonly [Coordinate, Coordinate];
  }[],
  heightOf: (index: number) => number,
  { turnStepDeg, groundOf, offsets, chains: held }: SmoothFlightsOptions = {},
): SmoothedFlights {
  const count = segments.length;
  const chainOf = new Int32Array(count);
  const from = new Int32Array(count);
  const to = new Int32Array(count);
  const chains: SmoothedLine[] = [];
  let i = 0;
  while (i < count) {
    const first = segments[i]!;
    const members = [i];
    let end = first.coords[1];
    while (i + members.length < count) {
      const next = segments[i + members.length]!;
      if (
        next.path_id !== first.path_id ||
        next.coords[0][0] !== end[0] ||
        next.coords[0][1] !== end[1]
      ) {
        break;
      }
      members.push(i + members.length);
      end = next.coords[1];
    }
    let line = held?.get(i);
    if (line?.vertex.length !== members.length + 1) {
      const points: Coordinate[] = [first.coords[0]];
      const heights: number[] = [heightOf(i)];
      const ground = groundOf && [groundOf(i)];
      const around = groundOf && offsets?.map((level) => [level[i]!]);
      for (const m of members) {
        // Across the antimeridian the curve goes on past 180 rather than
        // round the world, through the spline points it would add there
        const end = segments[m]!.coords[1];
        const lng = unwrapLng(end[1], points[points.length - 1]![1]);
        points.push(lng === end[1] ? end : [end[0], lng]);
        heights.push(heightOf(m));
        ground?.push(groundOf!(m));
        around?.forEach((level, l) => level.push(offsets![l]![m]!));
      }
      line = smoothLine(points, heights, {
        turnStepDeg,
        ground,
        offsets: around,
      });
      held?.set(i, line);
    }
    members.forEach((m, j) => {
      chainOf[m] = chains.length;
      from[m] = line.vertex[j]!;
      to[m] = line.vertex[j + 1]!;
    });
    chains.push(line);
    i += members.length;
  }
  return { chains, chainOf, from, to };
}
