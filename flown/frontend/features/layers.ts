/**
 * Layer rendering helpers
 * Pure functions used by the LayerManager for colour ranges, segment
 * styling, legend labels and tooltips.
 */

import type { PathInfo, PathSegment } from "../types";
import { DEGREES_TO_RADIANS, type Coordinate } from "../utils/geometry";
import type { SmoothedFlights } from "../calculations/smoothing";
import {
  DEFAULT_AIRSPEED_RANGE,
  DEFAULT_ALTITUDE_RANGE,
  type Range,
} from "../state/store";
import { FEET_TO_METERS, NAUTICAL_MILES_TO_KM } from "../utils/constants";
import { formatNumber } from "../utils/formatters";
import { unwrapLng } from "../utils/mapHelpers";
import { altitudeRangeFt } from "../calculations/statistics";

/**
 * Segment rendering properties
 */
export interface SegmentProperties {
  weight: number;
  opacity: number;
  color: string;
  isSelected: boolean;
}

export { DEFAULT_ALTITUDE_RANGE, DEFAULT_AIRSPEED_RANGE };

/**
 * How many evenly spaced steps of rank a colour range keeps the values of
 * (see Range.ranks): as many as the steps a run of the flights is cut at
 * (see LayerManager), more than the eye tells apart on the ramp
 */
export const RANK_STEPS = 32;

/**
 * Where the `i`-th of the ranks rankValues reads is in a sorted array whose
 * last index is `last`
 */
function rankIndex(i: number, last: number, from: number, to: number): number {
  return Math.round((from + ((to - from) * i) / RANK_STEPS) * last);
}

/** The indices rankValues reads, ascending (see rankIndex) */
function rankIndices(last: number, from = 0, to = 1): number[] {
  return Array.from({ length: RANK_STEPS + 1 }, (_, i) =>
    rankIndex(i, last, from, to),
  );
}

/**
 * Put the values a sort would put at the indices `ks` (ascending) there,
 * and every smaller value before each, every larger one after it: a
 * quickselect of all of them at once, which goes into the parts of the
 * array with one of `ks` in them only. The ranks of a year's groundspeeds
 * took a sort of all of them at every change of the dataset, 30 to 50 ms on
 * a phone; this is two to three times faster.
 */
export function selectRanks(values: Float64Array, ks: readonly number[]): void {
  const parts = [0, values.length - 1, 0, ks.length];
  while (parts.length > 0) {
    const [lo, hi, from, to] = parts.splice(-4) as [
      number,
      number,
      number,
      number,
    ];
    if (from >= to) continue;
    if (hi - lo < 64) {
      values.subarray(lo, hi + 1).sort();
      continue;
    }
    const pivot = values[(lo + hi) >> 1]!;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (values[i]! < pivot) i++;
      while (values[j]! > pivot) j--;
      if (i <= j) {
        [values[i], values[j]] = [values[j]!, values[i]!];
        i++;
        j--;
      }
    }
    // Up to j at most the pivot, from i on at least it, the pivot between
    let m = from;
    while (m < to && ks[m]! <= j) m++;
    let n = m;
    while (n < to && ks[n]! < i) n++;
    parts.push(lo, j, from, m, i, hi, n, to);
  }
}

/**
 * The values of `sorted` (ascending) at RANK_STEPS + 1 evenly spaced ranks
 * from the share `from` of them to the share `to`, held between `min` and
 * `max`, which the first and the last are
 */
export function rankValues(
  sorted: ArrayLike<number>,
  min: number,
  max: number,
  from = 0,
  to = 1,
): number[] {
  const ranks: number[] = [];
  for (let i = 0; i <= RANK_STEPS; i++) {
    const value = sorted[rankIndex(i, sorted.length - 1, from, to)] ?? min;
    // Never below the rank before: rounding at either end may reach past
    ranks.push(
      Math.max(Math.min(Math.max(value, min), max), ranks[i - 1] ?? min),
    );
  }
  ranks[0] = min;
  ranks[RANK_STEPS] = max;
  return ranks;
}

/**
 * Altitude colour range (feet) of the given segments, falling back to
 * `defaultRange` when none has an altitude. Callers pass the segments of the
 * paths the range is for (the selection, or the whole dataset).
 *
 * The ends are the exact per-path altitudes from `paths`, like the
 * statistics panel beside the legend (see altitudeRangeFt), and the colours
 * are spread by the segments' altitudes between them (see scalePosition),
 * the median in the middle of the ramp, where the legend names it.
 * Negative altitudes (below the MSL reference) are kept in the data but drawn
 * with the lowest colour: the scale's lower bound is clamped at 0 ft so the
 * legend and colours match the previous (clamped) exports. Kept for the
 * array and its paths, its ranks worked out once they are read (see
 * altitudeRanges).
 */
export function calculateAltitudeRange(
  segments: PathSegment[],
  defaultRange: Range,
  paths: PathInfo[],
): Range {
  const held = altitudeRanges.get(segments);
  if (held?.[0] === paths) return held[1];
  const ends = altitudeRangeFt(segments, paths);
  if (ends === null) return defaultRange;
  const min = Math.max(ends.min, 0);
  const max = Math.max(ends.max, 0);
  let ranks: number[] | undefined;
  const range: Range = {
    min,
    max,
    get ranks() {
      if (!ranks) {
        const altitudes = new Float64Array(segments.length);
        segments.forEach((segment, i) => (altitudes[i] = segment.altitude_ft));
        // Only the values the ramp reads are put in their place: a sort of
        // all of them took 10 ms for every year on a desktop
        selectRanks(altitudes, rankIndices(segments.length - 1));
        ranks = rankValues(altitudes, min, max);
      }
      return ranks;
    },
  };
  altitudeRanges.set(segments, [paths, range]);
  return range;
}

/**
 * calculateAltitudeRange of each segment array: the range of a dataset was
 * worked out at every change of the filter, which it does not follow, 23
 * ms for all years on a desktop. Its ranks, most of that, are worked out
 * once they are read, which only the colours of the altitude do: the 3D
 * view reads `max` alone.
 */
const altitudeRanges = new WeakMap<
  readonly PathSegment[],
  [paths: PathInfo[], range: Range]
>();

/** Share of the speeds that falls below and above the ends of the scale */
const AIRSPEED_RANGE_TAIL = 0.05;

/**
 * Groundspeed colour range (knots) of the given segments, ignoring segments
 * without a positive speed. Falls back to `defaultRange` when none has one.
 *
 * The scale runs from the 5th to the 95th percentile rather than from the
 * slowest to the fastest segment, whose tails take the colours of its ends,
 * which the legend says: a GPS fix that jumped made one segment of a year
 * fly at several hundred knots. Between them the colours are spread by the
 * speeds (see scalePosition): a flight taxis at a crawl and cruises near
 * one speed, and spread evenly over the values the taxiing and the cruise
 * each took a few neighbouring colours. A dataset whose middle has no
 * spread keeps the full range.
 */
export function calculateAirspeedRange(
  segments: PathSegment[],
  defaultRange: Range = DEFAULT_AIRSPEED_RANGE,
): Range {
  let count = 0;
  const speeds = new Float64Array(segments.length);
  for (const segment of segments) {
    const speed = segment.groundspeed_knots;
    if (speed > 0) speeds[count++] = speed;
  }
  if (count === 0) return defaultRange;
  // Only the values the scale reads are put in their place, see selectRanks
  const sorted = speeds.subarray(0, count);
  const last = count - 1;
  const low = Math.floor(AIRSPEED_RANGE_TAIL * last);
  const high = Math.ceil((1 - AIRSPEED_RANGE_TAIL) * last);
  const tail = [AIRSPEED_RANGE_TAIL, 1 - AIRSPEED_RANGE_TAIL] as const;
  selectRanks(
    sorted,
    [low, high, ...rankIndices(last, ...tail)].sort((a, b) => a - b),
  );
  const min = sorted[low]!;
  const max = sorted[high]!;
  if (min < max) {
    return { min, max, ranks: rankValues(sorted, min, max, ...tail) };
  }
  sorted.sort();
  return {
    min: sorted[0]!,
    max: sorted[last]!,
    ranks: rankValues(sorted, sorted[0]!, sorted[last]!),
  };
}

/**
 * The value in the middle of a colour range's ramp: its median where the
 * colours are spread by rank, halfway between its ends otherwise
 */
export function rangeMiddle(range: Range): number {
  const ranks = range.ranks;
  if (ranks && ranks.length > 2) {
    const half = (ranks.length - 1) / 2;
    return (ranks[Math.floor(half)]! + ranks[Math.ceil(half)]!) / 2;
  }
  return (range.min + range.max) / 2;
}

/**
 * Calculate segment rendering properties (weight, opacity, colour) from the
 * selection state.
 *
 * - no selection: normal weight, 0.85 opacity
 * - selected path: heavier line, full opacity
 * - unselected path while a selection exists: dimmed
 * - share mode: only selected paths are drawn, at normal weight
 */
export function calculateSegmentProperties(options: {
  pathId: number;
  selectedPathIds?: ReadonlySet<number>;
  isolateSelection?: boolean;
  colorFunction?: (value: number, min: number, max: number) => string;
  colorMin?: number;
  colorMax?: number;
  value?: number; // altitude_ft or groundspeed_knots
}): SegmentProperties {
  const {
    pathId,
    selectedPathIds = new Set<number>(),
    isolateSelection = false,
    colorFunction,
    colorMin = 0,
    colorMax = 0,
    value = 0,
  } = options;

  const hasSelection = selectedPathIds.size > 0;
  const isSelected = selectedPathIds.has(pathId);
  const inSolo = isolateSelection && isSelected;

  return {
    weight: isSelected && !inSolo ? 6 : 4,
    opacity: inSolo ? 0.85 : isSelected ? 1.0 : hasSelection ? 0.1 : 0.85,
    color: colorFunction ? colorFunction(value, colorMin, colorMax) : "#3388ff",
    isSelected,
  };
}

/**
 * Format an altitude legend label, e.g. "1,000 ft" over "(305 m)". Each of
 * the three labels carries both units, the second on a line of its own
 * (the legend keeps the line break, see styles.css): on one line the ends
 * made the legend 70 px wider than the heat's, and the middle, which had
 * no room for the second unit, went without it.
 */
export function formatAltitudeLabel(valueFt: number): string {
  return (
    formatNumber(valueFt) +
    " ft\n(" +
    formatNumber(valueFt * FEET_TO_METERS) +
    " m)"
  );
}

/**
 * Format a groundspeed legend label, e.g. "100 kt" over "(185 km/h)" (see
 * formatAltitudeLabel)
 */
export function formatAirspeedLabel(valueKt: number): string {
  return (
    formatNumber(valueKt) +
    " kt\n(" +
    formatNumber(valueKt * NAUTICAL_MILES_TO_KM) +
    " km/h)"
  );
}

/**
 * Squared planar distance (in degrees, longitude scaled by cos(lat)) from a
 * point to a line segment. Its end is taken on the turn of the world of its
 * start: a segment across the antimeridian, from 179.9 to -179.9, is the
 * short way round, not a line round the whole world, which put the point
 * at 180 nearer the segment after it.
 */
function distanceToSegmentSquared(
  lat: number,
  lng: number,
  a: [number, number],
  b: [number, number],
): number {
  const scale = Math.cos(lat * DEGREES_TO_RADIANS);
  const ax = a[1] * scale;
  const ay = a[0];
  const bx = unwrapLng(b[1], a[1]) * scale;
  const by = b[0];
  const px = lng * scale;
  const py = lat;

  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  let t = 0;
  if (lengthSquared > 0) {
    t = ((px - ax) * dx + (py - ay) * dy) / lengthSquared;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return (px - cx) * (px - cx) + (py - cy) * (py - cy);
}

/**
 * Find the segment closest to a geographic point. Used to show per-segment
 * tooltip data on lines that were merged from several segments.
 *
 * The map draws copies of the world, so the longitude of the point may be
 * any number of turns away from the one a segment is stored with, and a run
 * that crosses the antimeridian has segments on either side of it. Each
 * segment is measured against the point as seen from its own copy.
 * @param segments - Candidate segments (must have coords)
 * @param lat - Latitude of the point
 * @param lng - Longitude of the point, wrapped or not
 * @returns Nearest segment or undefined for an empty list
 */
export function findNearestSegment(
  segments: PathSegment[],
  lat: number,
  lng: number,
): PathSegment | undefined {
  let best: PathSegment | undefined;
  let bestDistance = Infinity;
  for (const segment of segments) {
    const coords = segment.coords;
    const turns = Math.round((coords[0][1] - lng) / 360);
    const d = distanceToSegmentSquared(
      lat,
      lng + 360 * turns,
      coords[0],
      coords[1],
    );
    if (d < bestDistance) {
      bestDistance = d;
      best = segment;
    }
  }
  return best;
}

/**
 * `findNearestSegment` for segments drawn along their flight's curve (see
 * calculations/curves.ts): the index, from `start` to `end` (exclusive), of
 * the segment whose part of the curve passes nearest to the point, and the
 * piece of the curve it passes nearest on. A point of the curve belongs to
 * the segment it lies on, so near a fix in a turn the answer is the segment
 * drawn under the point, not the one whose straight line is nearer.
 */
export function findNearestOnCurve(
  curves: SmoothedFlights,
  start: number,
  end: number,
  lat: number,
  lng: number,
): { index: number; piece: [Coordinate, Coordinate] } | null {
  let best: { index: number; piece: [Coordinate, Coordinate] } | null = null;
  let bestDistance = Infinity;
  for (let index = start; index < end; index++) {
    const points = curves.chains[curves.chainOf[index]!]?.points;
    if (!points) continue;
    for (let i = curves.from[index]!; i < curves.to[index]!; i++) {
      const a = points[i]!;
      const b = points[i + 1]!;
      const turns = Math.round((a[1] - lng) / 360);
      const d = distanceToSegmentSquared(lat, lng + 360 * turns, a, b);
      if (d < bestDistance) {
        bestDistance = d;
        best = { index, piece: [a, b] };
      }
    }
  }
  return best;
}
