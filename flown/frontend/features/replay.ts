/**
 * Replay functionality helpers
 * Pure functions for flight replay calculations
 */

import { segmentsForPathIds } from "../calculations/statistics";
import {
  smoothFlights,
  type SmoothedFlights,
  type SmoothFlightsOptions,
} from "../calculations/smoothing";
import { FLAT_TURN_STEP_DEG } from "../calculations/curves";
import {
  DEGREES_TO_RADIANS,
  planarMetres,
  type Coordinate,
} from "../utils/geometry";
import type { PathSegment } from "../types";

/**
 * Prepare segments for replay
 * @param segments - All segments
 * @param pathId - Selected path ID
 * @returns Sorted segments with time data
 */
export function prepareReplaySegments(
  segments: PathSegment[],
  pathId: number,
): PathSegment[] {
  // The path's own segments come from the per-path index; only the ones
  // with time data can be replayed
  const replaySegments = segmentsForPathIds(segments, [pathId]).filter(
    (seg): seg is PathSegment & { time: number } => seg.time !== undefined,
  );

  // Sort by time
  return replaySegments.sort((a, b) => a.time - b.time);
}

/** The flight of a replay along its curve, timed (see replayCurve) */
export interface ReplayCurve extends SmoothedFlights {
  /** Per chain: metres along its curve to each of its points */
  along: Float64Array[];
  /**
   * Per segment: metres along the curve per whole segment of time at its
   * start and at its end, the slopes of the distance flown over time (see
   * replayPoint)
   */
  startSlope: Float64Array;
  endSlope: Float64Array;
  /**
   * Per segment: when the airplane is at its start, the logged time
   * smoothed (see replayCurve)
   */
  times: Float64Array;
  /**
   * Per segment: the seconds the airplane takes along it, to the start of
   * the next one of its flight, or for the last of a flight its own time
   */
  spent: Float64Array;
  /** When the airplane is at the end of the last segment (see replayCurve) */
  end: number;
  /** The flights of the replay, one after another (see ReplayLeg) */
  legs: ReplayLeg[];
}

/**
 * A flight of a replay of several one after another, on the replay's one
 * clock: its segments from `first` to `end` (exclusive), when the airplane
 * starts it and when it has landed
 */
export interface ReplayLeg {
  first: number;
  end: number;
  start: number;
  finish: number;
}

/**
 * The flight of `legs` the clock is on at `time`: the last to have
 * started, which is still the one that landed during the pause after it
 */
export function legAt(legs: readonly ReplayLeg[], time: number): number {
  let leg = 0;
  while ((legs[leg + 1]?.start ?? Infinity) <= time) leg++;
  return leg;
}

/**
 * Longest time the last segment takes (s), which ends at no fix: one
 * logged at a crawl would otherwise hold the replay for minutes
 */
const LAST_SEGMENT_MAX_S = 120;

/** Fixes on either side of one that its time is smoothed over */
const TIME_WINDOW = 2;

/**
 * The flight of `segments`, at the feet above ground `heightOf` gives, or
 * with `groundOf` at the altitudes it gives over that ground, and the
 * ground of the levels around its one as `offsets` (see smoothFlights),
 * along the curve the lines are drawn on (see calculations/curves.ts), and
 * when it is where.
 *
 * A segment's time is when it starts, so the one of the next segment is
 * when it ends. Moved evenly along each segment the airplane changed speed
 * at every fix, by as much as the logged speeds differ, which is a lot for
 * fixes of a few seconds. The distance flown is taken as a curve over time
 * instead, through the fixes at their times, with the speed at a fix the
 * harmonic mean of the segments on either side of it (Fritsch and
 * Butland): the speed changes smoothly, and the airplane never stops or
 * goes back on a segment where it did neither.
 *
 * The times themselves are smoothed first. A logger's times and positions
 * do not quite agree: in the sample data a fix 0.4 s after the one before
 * is 32 m on at 70 kt, as far as 0.9 s would take it, and the segments on
 * either side are slower by as much. The time of a fix is the one a
 * straight line of time over the distance flown gives it, fitted to
 * TIME_WINDOW fixes on either side, but never before the one of the fix
 * before, nor past the logged ones of its neighbours. The first and the
 * last fix keep theirs, and so does one where the flight stands.
 *
 * `segments` may hold several flights, each after the one before (the
 * replay of a selection): each is timed on its own, as it would be alone,
 * and then put on one clock, starting where the one before has landed and
 * `pauseS` have passed (see ReplayLeg). The first starts at 0, at its first fix.
 */
export function replayCurve(
  segments: readonly PathSegment[],
  heightOf: (index: number) => number,
  groundOf?: (index: number) => number,
  offsets?: SmoothFlightsOptions["offsets"],
  pauseS = 0,
): ReplayCurve {
  const curves = smoothFlights(segments, heightOf, {
    turnStepDeg: FLAT_TURN_STEP_DEG,
    groundOf,
    offsets,
  });
  const along = curves.chains.map(({ points }) => {
    const metres = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      metres[i] = metres[i - 1]! + planarMetres(points[i - 1]!, points[i]!);
    }
    return metres;
  });
  const count = segments.length;
  // Whether the segment at `i` is the last of its flight
  const lastOfFlight = (i: number): boolean =>
    segments[i + 1]?.path_id !== segments[i]!.path_id;
  // Whether the segment at `i` carries on the one before along the curve
  const joined = (i: number): boolean =>
    i > 0 &&
    curves.chainOf[i]! >= 0 &&
    curves.chainOf[i] === curves.chainOf[i - 1] &&
    curves.from[i] === curves.to[i - 1];
  // Metres along its chain to the start of a segment
  const flownTo = (i: number): number =>
    along[curves.chainOf[i]!]?.[curves.from[i]!] ?? 0;
  const logged = Float64Array.from(segments, (segment) => segment.time ?? 0);
  const times = logged.slice();
  for (let i = 1; i + 1 < count; i++) {
    // The first and the last fix of each flight keep their times
    if (lastOfFlight(i) || lastOfFlight(i - 1)) continue;
    let first = i;
    let last = i;
    while (first > i - TIME_WINDOW && joined(first)) first--;
    while (last < i + TIME_WINDOW && joined(last + 1)) last++;
    let metres = 0;
    let seconds = 0;
    for (let j = first; j <= last; j++) {
      metres += flownTo(j);
      seconds += logged[j]!;
    }
    metres /= last - first + 1;
    seconds /= last - first + 1;
    let spread = 0;
    let together = 0;
    for (let j = first; j <= last; j++) {
      spread += (flownTo(j) - metres) ** 2;
      together += (flownTo(j) - metres) * (logged[j]! - seconds);
    }
    const fitted =
      spread > 1
        ? seconds + (together / spread) * (flownTo(i) - metres)
        : logged[i]!;
    times[i] = Math.min(
      Math.max(fitted, times[i - 1]!, logged[i - 1]!),
      logged[i + 1]!,
    );
  }
  // Per segment: its length along the curve, and its time
  const length = new Float64Array(count);
  const seconds = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const chain = along[curves.chainOf[i]!];
    if (!chain) continue;
    length[i] = chain[curves.to[i]!]! - chain[curves.from[i]!]!;
    seconds[i] = lastOfFlight(i) ? 0 : Math.max(times[i + 1]! - times[i]!, 0);
  }
  // The speed of a segment, or null without a time to tell
  const speed = (i: number): number | null =>
    seconds[i]! > 0 ? length[i]! / seconds[i]! : null;
  // Each flight from where the one before has landed and the pause has
  // passed, the first from 0. The last segment of a flight has no next one
  // to end at: it takes the time its length does at its logged
  // groundspeed, or at the speed of the one before, and the airplane flies
  // it rather than jumping to its end.
  const legs: ReplayLeg[] = [];
  let end = 0;
  for (let first = 0; first < count;) {
    let last = first;
    while (!lastOfFlight(last)) last++;
    const start = legs.length ? end + pauseS : 0;
    const shift = start - times[first]!;
    for (let i = first; i <= last; i++) times[i] = times[i]! + shift;
    const knots = segments[last]!.groundspeed_knots;
    const metresPerSecond =
      knots > 0 ? (knots * 1852) / 3600 : joined(last) ? speed(last - 1) : 0;
    if (length[last]! > 0 && metresPerSecond) {
      const flown = Math.min(
        length[last]! / metresPerSecond,
        LAST_SEGMENT_MAX_S,
      );
      // Up to a whole second, a step of the timeline's slider: one between
      // two could not be reached by dragging to its end
      seconds[last] = Math.ceil(times[last]! + flown) - times[last]!;
    }
    end = times[last]! + seconds[last]!;
    legs.push({ first, end: last + 1, start, finish: end });
    first = last + 1;
  }
  // The speed at the fix a segment starts at
  const atStart = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const after = speed(i);
    const before = joined(i) ? speed(i - 1) : null;
    atStart[i] =
      before === null
        ? (after ?? 0)
        : after === null
          ? before
          : before + after > 0
            ? (2 * before * after) / (before + after)
            : 0;
  }
  const startSlope = new Float64Array(count);
  const endSlope = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const own = speed(i) ?? 0;
    startSlope[i] = atStart[i]! * seconds[i]!;
    endSlope[i] = (joined(i + 1) ? atStart[i + 1]! : own) * seconds[i]!;
  }
  return {
    ...curves,
    along,
    startSlope,
    endSlope,
    times,
    spent: seconds,
    end,
    legs,
  };
}

/**
 * `curve` on another ground (see replayCurve): the heights of its points
 * worked out anew, where the curve on the map, the distances along it and
 * its times stay as they are. These depend only on where the fixes are and
 * when they were logged, and the times of `segments` may be the ones the
 * curve has already smoothed, which are not smoothed a second time.
 */
export function liftReplayCurve(
  curve: ReplayCurve,
  segments: readonly PathSegment[],
  heightOf: (index: number) => number,
  groundOf?: (index: number) => number,
  offsets?: SmoothFlightsOptions["offsets"],
): ReplayCurve {
  const { chains } = smoothFlights(segments, heightOf, {
    turnStepDeg: FLAT_TURN_STEP_DEG,
    groundOf,
    offsets,
  });
  return { ...curve, chains };
}

/** Where the airplane is on its curve, see replayPoint */
export interface ReplayPoint {
  /** `[lat, lng]` */
  position: Coordinate;
  /** Feet above the flight's ground */
  heightFt: number;
  /**
   * The ground of the levels around the one of `heightFt` there, where the
   * curve has it (see SmoothedLine)
   */
  offsetsFt?: number[];
  /**
   * The direction of the curve there, in degrees clockwise from north;
   * null where the flight stands and has none
   */
  track: number | null;
  /** The point of the curve the airplane has passed last */
  point: number;
}

/**
 * Where the airplane is `fraction` of the time of the segment at `index`
 * on: on the curve, as far along it as the distance flown over time says
 * (see replayCurve). Its track is the direction of the curve there, which
 * turns evenly from the one at a point of the curve to the one at the
 * next: at a point it is the mean of the two pieces that meet there. Null
 * for an index past the curve's segments.
 */
export function replayPoint(
  curve: ReplayCurve,
  index: number,
  fraction: number,
): ReplayPoint | null {
  const chainIndex = curve.chainOf[index] ?? -1;
  const chain = curve.chains[chainIndex];
  const along = curve.along[chainIndex];
  if (!chain || !along) return null;
  const from = curve.from[index]!;
  const to = curve.to[index]!;
  const u = Math.min(Math.max(fraction, 0), 1);
  const length = along[to]! - along[from]!;
  // Cubic Hermite from 0 to the length over the segment's time
  const flown =
    (u * u * u - 2 * u * u + u) * curve.startSlope[index]! +
    (3 * u * u - 2 * u * u * u) * length +
    (u * u * u - u * u) * curve.endSlope[index]!;
  const target = along[from]! + Math.min(Math.max(flown, 0), length);
  let point = from;
  while (point + 1 < to && along[point + 1]! <= target) point++;
  const span = along[point + 1]! - along[point]!;
  const w = to > from && span > 0 ? (target - along[point]!) / span : 0;
  const a = chain.points[point]!;
  const b = chain.points[Math.min(point + 1, to)]!;
  // The directions at the two points, as vectors of metres, mixed
  const [ax, ay] = directionAt(chain.points, point);
  const [bx, by] = directionAt(chain.points, Math.min(point + 1, to));
  const x = ax + (bx - ax) * w;
  const y = ay + (by - ay) * w;
  const next = Math.min(point + 1, to);
  return {
    position: [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w],
    heightFt:
      chain.heights[point]! +
      (chain.heights[next]! - chain.heights[point]!) * w,
    ...(chain.offsets && {
      offsetsFt: chain.offsets.map(
        (level) => level[point]! + (level[next]! - level[point]!) * w,
      ),
    }),
    track:
      Math.hypot(x, y) > 1e-9
        ? (((Math.atan2(x, y) / DEGREES_TO_RADIANS) % 360) + 360) % 360
        : null,
    point,
  };
}

/**
 * The direction of a line of `[lat, lng]` points at its point `i`: the sum
 * of the unit vectors of the pieces on either side, east and north. A piece
 * of no length has none.
 */
function directionAt(
  points: readonly Coordinate[],
  i: number,
): [number, number] {
  let x = 0;
  let y = 0;
  for (const [a, b] of [
    [points[i - 1], points[i]],
    [points[i], points[i + 1]],
  ]) {
    if (!a || !b) continue;
    const dx = (b[1] - a[1]) * Math.cos(a[0] * DEGREES_TO_RADIANS);
    const dy = b[0] - a[0];
    const length = Math.hypot(dx, dy);
    if (length > 0) {
      x += dx / length;
      y += dy / length;
    }
  }
  return [x, y];
}
