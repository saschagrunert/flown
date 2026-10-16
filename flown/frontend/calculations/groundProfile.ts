/**
 * The ground a flight stands on in the 3D view (see lift.ts): the one the
 * build sampled under it, smoothed as the relief of a level draws it, or
 * the line between the fields it taxied on, and the ground of the levels
 * around a level, which its ribbons carry.
 */
import type { PathSegment } from "../types";
import { planarMetres } from "../utils/geometry";
import {
  GROUND_LEVELS,
  liftFt,
  RELIEF_MAX_LEVEL,
  reliefPixelM,
  TERRAIN_TILE_MAX_ZOOM,
} from "./lift";
import { groundLevelsFt } from "./statistics";
import {
  smoothFlights,
  type SmoothedFlights,
  type SmoothedLine,
} from "./smoothing";

/**
 * Groundspeed below which a flight is taken to be taxiing, in knots: a
 * light aircraft lifts off at 50 or more, and taxies at a walking pace to
 * 20
 */
const TAXI_KNOTS = 40;

/** Fixes of taxiing it takes to tell where the field is */
const TAXI_MIN_FIXES = 3;

/**
 * The height of the field at one end of a flight, in feet: the middle of
 * the altitudes it recorded taxiing there, from `indices` in the order
 * away from that end up to its first fast segment. Null for a flight that
 * starts or ends in the air, or without speeds to tell. A speed of 0 is no
 * speed, as the build writes an unknown one (a log without timing), and
 * ends the taxiing like a fast one, as it does in the build
 * (_field_offset_ft in flown/terrain.py): counted as taxiing, every
 * fix of such a flight would be, and its field the middle of its altitudes.
 * So does a segment without a time: its speed is the average of a line
 * without times, the same for every segment, and one below the taxiing
 * speed lifted the field of a flight of circuits to its circuit height.
 */
function fieldFt(
  segments: readonly PathSegment[],
  indices: readonly number[],
): number | null {
  const altitudes: number[] = [];
  for (const index of indices) {
    const segment = segments[index]!;
    const speed = segment.groundspeed_knots;
    if (segment.time === undefined || !(speed > 0 && speed < TAXI_KNOTS)) break;
    altitudes.push(segment.altitude_ft);
  }
  if (altitudes.length < TAXI_MIN_FIXES) return null;
  altitudes.sort((a, b) => a - b);
  return altitudes[Math.floor(altitudes.length / 2)]!;
}

/**
 * The ground under every segment, in feet, by its index: what the build sampled
 * under a flight (PathSegment.ground_ft), where it has that for every segment
 * and `sampled` asks for it, smoothed as the relief the map draws at the relief
 * level `level` (see reliefPixelM), and as sampled without one. The sampled
 * ground follows the relief, so it is only the ground where the relief is
 * drawn: over a flat map a level flight above it would climb and sink with
 * every ridge it crossed, and over a relief coarser than it with every ridge
 * the relief leaves out. Otherwise from the field a flight left to the one it
 * landed on, as its taxiing recorded them, and in between along the way it
 * flew, in proportion to the distance. The heights are the recorder's own, so
 * its taxiing is on the map whatever its altimeter was off by; and an altitude
 * that dips below the fields in flight, as a glitch of the recorder does, takes
 * no flight up with it.
 *
 * A flight that starts or ends in the air has a field at one end only, and
 * stands on it; one with neither, or without speeds, on the lowest part
 * of its time (groundLevelsFt).
 */
export function groundProfileFt(
  segments: readonly PathSegment[],
  sampled = true,
  level = Infinity,
): Float64Array {
  const ground = new Float64Array(segments.length);
  let lowest: Map<number, number> | null = null;
  for (const [pathId, path] of pathsOf(segments)) {
    const { indices, samples } = path;
    if (sampled && samples) {
      const smoothed =
        level > TERRAIN_TILE_MAX_ZOOM
          ? samples
          : smoothAlong(
              samples,
              (path.along ??= alongMetres(segments, indices)),
              reliefPixelM(level, segments[indices[0]!]!.coords[0][0]),
            );
      smoothed.forEach((feet, i) => (ground[indices[i]!] = feet));
      continue;
    }
    const start = fieldFt(segments, indices);
    const end = fieldFt(segments, [...indices].reverse());
    if (start === null && end === null) {
      lowest ??= groundLevelsFt(segments as PathSegment[]);
      const floor = lowest.get(pathId) ?? 0;
      for (const index of indices) ground[index] = floor;
      continue;
    }
    const from = start ?? end!;
    const to = end ?? start!;
    const along = (path.along ??= alongMetres(segments, indices));
    const total = along[along.length - 1] ?? 0;
    indices.forEach((index, i) => {
      const t = total > 0 ? along[i]! / total : 0;
      ground[index] = from + (to - from) * t;
    });
  }
  return ground;
}

/** A flight of a dataset, as groundProfileFt stands it on its ground */
interface GroundPath {
  /** Its segments, in their order */
  indices: number[];
  /** The ground sampled under each, where every one of them has it */
  samples: number[] | null;
  /** The metres flown to the end of each, once asked for (alongMetres) */
  along?: Float64Array;
}

/**
 * The flights of each dataset, as groundProfileFt found them the first
 * time: the same at every level, which only smooths their ground anew.
 * They go with the 3D view (see releaseGroundProfiles).
 */
let groundPaths = new WeakMap<
  readonly PathSegment[],
  Map<number, GroundPath>
>();

/** The flights of `segments` by path id (see groundPaths) */
function pathsOf(segments: readonly PathSegment[]): Map<number, GroundPath> {
  let paths = groundPaths.get(segments);
  if (paths) return paths;
  paths = new Map();
  segments.forEach((segment, index) => {
    const path = paths.get(segment.path_id);
    if (path) path.indices.push(index);
    else paths.set(segment.path_id, { indices: [index], samples: null });
  });
  for (const path of paths.values()) {
    const samples = path.indices.map((index) => segments[index]!.ground_ft);
    if (!samples.includes(undefined)) path.samples = samples as number[];
  }
  groundPaths.set(segments, paths);
  return paths;
}

/**
 * The ground under every segment at the relief level `level` (see
 * groundProfileFt), and the ground of each of the levels around it that a
 * ribbon carries (GROUND_LEVELS): as the feet to add to a height above the
 * one to have it above the other, in the order of GROUND_LEVELS. They are
 * null without the sampled ground: the line between the fields is the same
 * at every level.
 */
export function groundProfilesFt(
  segments: readonly PathSegment[],
  sampled: boolean,
  level: number,
): { ground: Float64Array; offsets: Float64Array[] | null } {
  const ground = levelGroundFt(segments, sampled, level);
  if (!sampled) return { ground, offsets: null };
  const offsets = GROUND_LEVELS.map((step) => {
    const other = levelGroundFt(segments, true, level + step);
    return ground.map((feet, i) => feet - other[i]!);
  });
  return { ground, offsets };
}

/**
 * The ground under every segment at the relief level `level` alone (see
 * groundProfileFt), kept per level where it is the sampled one: the levels
 * of a cut are mostly those of the cut before, a level away
 */
export function levelGroundFt(
  segments: readonly PathSegment[],
  sampled: boolean,
  level: number,
): Float64Array {
  if (!sampled) return groundProfileFt(segments, false);
  let byLevel = sampledGround.get(segments);
  if (!byLevel) {
    sampledGround.set(segments, (byLevel = new Map<number, Float64Array>()));
  }
  const clamped = Math.min(Math.max(level, 0), RELIEF_MAX_LEVEL);
  let profile = byLevel.get(clamped);
  if (!profile) {
    profile = groundProfileFt(segments, true, clamped);
    byLevel.set(clamped, profile);
  }
  return profile;
}

/**
 * The sampled ground of the segments of a dataset by relief level, as
 * groundProfilesFt has worked it out: a dataset does not change while it
 * is on the map, and goes with it, or with the 3D view (see
 * releaseGroundProfiles)
 */
let sampledGround = new WeakMap<
  readonly PathSegment[],
  Map<number, Float64Array>
>();

/**
 * Let go of the ground worked out for every level, and of the flights
 * smoothed on it, as the 3D view goes: a profile is a number per segment,
 * and a dataset of all years kept one for each level it was shown at, for
 * as long as it stayed on the flat map
 */
export function releaseGroundProfiles(): void {
  sampledGround = new WeakMap();
  groundPaths = new WeakMap();
  releaseGroundedFlights();
}

/**
 * The flights of a dataset smoothed at their altitudes, before they stand
 * on any ground (see smoothedCurves), the last worked out
 */
let curves: {
  segments: readonly PathSegment[];
  flights: SmoothedFlights;
} | null = null;

/**
 * The flights of a dataset smoothed on their ground (see groundedFlights),
 * the last worked out, and the ground and level they stand on
 */
let grounded: {
  segments: readonly PathSegment[];
  level: number;
  flights: SmoothedFlights;
} | null = null;

/**
 * Every flight of `segments` smoothed at its altitude (smoothFlights), on
 * no ground: the curve and its altitudes are the same on every ground and
 * at every level, since a flight is smoothed at its altitude and only then
 * set on its ground (see smoothLine). Smoothing every flight of all years
 * is most of the work of turning the 3D view on, and was all of it again
 * at every level a zoom ended on; the last dataset's is kept for as long
 * as its flights are (releaseGroundedFlights).
 */
function smoothedCurves(segments: readonly PathSegment[]): SmoothedFlights {
  if (curves?.segments !== segments) {
    curves = { segments, flights: smoothAltitudes(segments) };
  }
  return curves.flights;
}

/**
 * Every flight of `segments` smoothed at its altitude, see smoothedCurves;
 * a few flights on their own take it as well (calculations/smoothGrounded.ts)
 */
export function smoothAltitudes(
  segments: readonly PathSegment[],
): SmoothedFlights {
  return smoothFlights(segments, (i) => segments[i]!.altitude_ft);
}

/**
 * Every flight of `segments` smoothed at its height above its ground
 * (smoothFlights): the sampled ground of the relief level `level` where
 * `sampled`, with the ground of the levels around it, and otherwise the
 * line between its fields, which is the same at every level. The ribbons
 * of the colour layers are cut from these and the heat cloud is drawn
 * along them (calculations/heatCloud.ts), so the last is kept for both.
 * The curves are smoothed once for the dataset (smoothedCurves), and only
 * set on the ground of another level. It holds a curve point by point,
 * which for all years is tens of megabytes; the layer manager lets go of
 * it once neither needs it (releaseGroundedFlights).
 */
export function groundedFlights(
  segments: readonly PathSegment[],
  sampled: boolean,
  level: number,
): SmoothedFlights {
  const held = heldFlights(segments, sampled, level);
  if (held) return held;
  const flights = onGround(
    smoothedCurves(segments),
    groundProfilesFt(segments, sampled, level),
  );
  grounded = { segments, level: groundedKey(sampled, level), flights };
  return flights;
}

/** The level groundedFlights holds its flights by: -1 for the fields' line */
function groundedKey(sampled: boolean, level: number): number {
  return sampled ? Math.min(Math.max(level, 0), RELIEF_MAX_LEVEL) : -1;
}

/**
 * The flights of `segments` as groundedFlights would give them, where it
 * holds them already, and null otherwise
 */
export function heldFlights(
  segments: readonly PathSegment[],
  sampled: boolean,
  level: number,
): SmoothedFlights | null {
  return grounded?.segments === segments &&
    grounded.level === groundedKey(sampled, level)
    ? grounded.flights
    : null;
}

/**
 * The flights `curves`, smoothed at their altitudes (smoothAltitudes), on
 * the ground `ground` under the end of each segment and with the offsets
 * `offsets` of the levels around it (see groundProfilesFt): as
 * smoothFlights smooths them on that ground, to the bit. The ground runs
 * straight along the curve from one fix to the next, as smoothLine lays
 * it, and a height above it is the altitude over it (liftFt). The points
 * of the curves and where each segment is on them are shared.
 */
export function onGround(
  curves: SmoothedFlights,
  { ground, offsets }: ReturnType<typeof groundProfilesFt>,
): SmoothedFlights {
  const { chainOf } = curves;
  const count = chainOf.length;
  const chains = new Array<SmoothedLine>(curves.chains.length);
  let first = 0;
  while (first < count) {
    let end = first + 1;
    while (end < count && chainOf[end] === chainOf[first]) end++;
    const chain = curves.chains[chainOf[first]!]!;
    // A chain's first fix takes the ground of its first segment, and each
    // fix after it that of the segment it ends
    const at = (fix: number): number => first + Math.max(fix - 1, 0);
    const under = alongCurve(chain.vertex, ground, at);
    const line: SmoothedLine = {
      points: chain.points,
      heights: chain.heights.map((feet, j) => liftFt(feet, under[j]!)),
      vertex: chain.vertex,
      ground: under,
    };
    if (offsets) {
      line.offsets = offsets.map((level) =>
        alongCurve(chain.vertex, level, at),
      );
    }
    chains[chainOf[first]!] = line;
    first = end;
  }
  return { chains, chainOf, from: curves.from, to: curves.to };
}

/**
 * `values`, by segment, at every point of a curve whose fixes are at
 * `vertex`, the value of a fix from its segment `at(fix)`: straight from
 * one fix to the next, worked out as smoothLine does, to the bit
 */
function alongCurve(
  vertex: readonly number[],
  values: ArrayLike<number>,
  at: (fix: number) => number,
): number[] {
  const out = [values[at(0)]!];
  for (let i = 0; i + 1 < vertex.length; i++) {
    const a = values[at(i)]!;
    const b = values[at(i + 1)]!;
    const steps = vertex[i + 1]! - vertex[i]!;
    for (let k = 1; k < steps; k++) out.push(a + ((b - a) * k) / steps);
    out.push(b);
  }
  return out;
}

/** Whether flights smoothed by groundedFlights are held, and of what */
export function heldGroundedFlights(): readonly PathSegment[] | null {
  return curves?.segments ?? null;
}

/** What else lets go with the flights (see onReleaseGrounded) */
const alsoReleased: (() => void)[] = [];

/**
 * Let go of what `release` holds whenever the flights smoothed by
 * groundedFlights go (releaseGroundedFlights): the few flights of
 * keptGrounded, smoothed on their own
 */
export function onReleaseGrounded(release: () => void): void {
  alsoReleased.push(release);
}

/**
 * Let go of the flights smoothed by groundedFlights, and of their curves
 * (smoothedCurves)
 */
export function releaseGroundedFlights(): void {
  grounded = null;
  curves = null;
  for (const release of alsoReleased) release();
}

/** Metres flown to the end of each of the segments `indices` of a flight */
function alongMetres(
  segments: readonly PathSegment[],
  indices: readonly number[],
): Float64Array {
  const along = new Float64Array(indices.length);
  let total = 0;
  indices.forEach((index, i) => {
    const [from, to] = segments[index]!.coords;
    total += planarMetres(from, to);
    along[i] = total;
  });
  return along;
}

/**
 * `values` at the distances `along`, smoothed as the relief the map draws
 * from coarser tiles smooths the ground: a pixel `pixelM` across stands
 * for the ground under and around it, and the map draws the straight line
 * from one pixel to the next. Twice a moving average over two pixels,
 * which of the averages tried followed the relief the map drew along a
 * flight over the Alps closest: at every level from 4 to 9 it halved the
 * difference, to about 100 m out to 30 m in. What is left is the relief
 * beside the flight, which no smoothing along it can know. Where the
 * flight ends, the average is of the part it flew.
 */
export function smoothAlong(
  values: readonly number[],
  along: ArrayLike<number>,
  pixelM: number,
): number[] {
  const width = 2 * pixelM;
  return boxAverage(boxAverage(values, along, width), along, width);
}

/**
 * The average of the line through `values` at `along` over `width` metres
 * around each point, cut off at the ends
 */
function boxAverage(
  values: readonly number[],
  along: ArrayLike<number>,
  width: number,
): number[] {
  const n = values.length;
  // The integral of the line from the first point to each point
  const integral = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    integral[i] =
      integral[i - 1]! +
      ((values[i]! + values[i - 1]!) / 2) * (along[i]! - along[i - 1]!);
  }
  // The integral up to `x` from the point `i` before it
  const integralAt = (x: number, i: number): number => {
    if (i + 1 >= n) return integral[n - 1]!;
    const span = along[i + 1]! - along[i]!;
    const t = span > 0 ? (x - along[i]!) / span : 0;
    const v = values[i]! + (values[i + 1]! - values[i]!) * t;
    return integral[i]! + ((values[i]! + v) / 2) * (x - along[i]!);
  };
  const out = new Array<number>(n);
  // The points before either end of the window, which only move on
  let lower = 0;
  let upper = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.max(along[i]! - width / 2, along[0]!);
    const b = Math.min(along[i]! + width / 2, along[n - 1]!);
    if (b <= a) {
      out[i] = values[i]!;
      continue;
    }
    while (lower + 1 < n && along[lower + 1]! <= a) lower++;
    while (upper + 1 < n && along[upper + 1]! <= b) upper++;
    out[i] = (integralAt(b, upper) - integralAt(a, lower)) / (b - a);
  }
  return out;
}
