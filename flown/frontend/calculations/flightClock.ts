/**
 * The clock of every flight: how many seconds into its flight each segment
 * starts, and each point of the curve it is drawn along. Replay of all
 * flights (ui/replayAll.ts) plays every flight from its own first fix at
 * once, so the only clock it needs is the one each flight carries, never
 * the date or the hour it was flown.
 *
 * A logged flight keeps its logged seconds. A break in the log (the logger
 * paused, the aircraft stood with it switched off), a track without times
 * (a planned route, an old export) and the last segment of a flight take
 * their length at their groundspeed instead, as the heat lines count them
 * (segmentSeconds), and a segment with neither takes no time at all. The
 * heat stops counting at two minutes a segment, so a long stand does not
 * outshine the rest; a clock that did would fly a long leg in two minutes,
 * and it stops at MAX_CLOCK_STEP_S instead. The pulses of the heat cloud
 * (calculations/heatCloud.ts) run by the same clock along the same curves,
 * so they and the replay agree on where each flight is when.
 */
import type { PathSegment } from "../types";
import type { SmoothedFlights } from "./smoothing";
import { planarMetres, type Coordinate } from "../utils/geometry";
import { segmentSeconds, type SegmentWeight } from "./heatLines";

/**
 * A logged step longer than this is a break in the log rather than time
 * spent flying, as for the heat lines (MAX_LOGGED_STEP_S in heatLines.ts)
 */
const MAX_CLOCK_STEP_S = 600;

/** The clock of the segments of a dataset, see flightClock */
export interface FlightClock {
  /** Per segment: the seconds into its flight at its start */
  start: Float64Array;
  /** Per segment: the seconds it took */
  spent: Float64Array;
  /** Per flight (path id): the seconds from its first fix to its last */
  duration: Map<number, number>;
}

/**
 * The seconds each segment of `segments` took and how far into its flight
 * it starts. A segment's time is when it starts, so the time of the next
 * one of its flight is when it ends; the segments of a flight need not be
 * next to each other.
 */
export function flightClock(segments: readonly PathSegment[]): FlightClock {
  const count = segments.length;
  const start = new Float64Array(count);
  const spent = new Float64Array(count);
  const duration = new Map<number, number>();
  const last = new Map<number, number>();
  // The next segment of the same flight, for every segment
  const next = new Int32Array(count).fill(-1);
  for (let i = 0; i < count; i++) {
    const pathId = segments[i]!.path_id;
    const before = last.get(pathId);
    if (before !== undefined) next[before] = i;
    last.set(pathId, i);
  }
  for (let i = 0; i < count; i++) {
    const segment = segments[i]!;
    const after = segments[next[i]!];
    let seconds = -1;
    if (after && segment.time !== undefined && after.time !== undefined) {
      seconds = after.time - segment.time;
    }
    if (seconds < 0 || seconds > MAX_CLOCK_STEP_S) {
      // Its length at its groundspeed: segmentSeconds without a next one
      seconds = segmentSeconds(segment, undefined, MAX_CLOCK_STEP_S);
    }
    const pathId = segment.path_id;
    const at = duration.get(pathId) ?? 0;
    start[i] = at;
    spent[i] = seconds;
    duration.set(pathId, at + seconds);
  }
  return { start, spent, duration };
}

/** The clock of each array of segments, worked out once */
const clocks = new WeakMap<readonly PathSegment[], FlightClock>();

/** flightClock of `segments`, worked out once for the replay and the cloud */
export function flightClockOf(segments: readonly PathSegment[]): FlightClock {
  let clock = clocks.get(segments);
  if (!clock) {
    clock = flightClock(segments);
    clocks.set(segments, clock);
  }
  return clock;
}

/**
 * The seconds into its flight at each point of the curve of the chain the
 * segments `first` to `end` (exclusive) are smoothed into (see
 * smoothFlights): a point between two fixes is as far into its segment's
 * time as it is along its piece of the curve. `lengths` are the metres
 * from each point of the curve to the one before (see pieceLengths), where
 * the caller has them already.
 */
export function chainTimes(
  flights: SmoothedFlights,
  clock: FlightClock,
  first: number,
  end: number,
  lengths: Float64Array = pieceLengths(flights, first, end),
): Float64Array {
  const { chains, chainOf, from, to } = flights;
  const times = new Float64Array(chains[chainOf[first]!]!.points.length);
  for (let m = first; m < end; m++) {
    const a = from[m]!;
    const b = to[m]!;
    const begins = clock.start[m]!;
    const spent = clock.spent[m]!;
    times[a] = begins;
    let total = 0;
    for (let j = a + 1; j <= b; j++) total += lengths[j]!;
    let along = 0;
    for (let j = a + 1; j <= b; j++) {
      along += lengths[j]!;
      times[j] =
        begins + spent * (total > 0 ? along / total : (j - a) / (b - a));
    }
  }
  return times;
}

/**
 * What the pieces of the curve of a chain are, point by point (see
 * chainPieces): the metres from the point before, the heat of them in
 * seconds, and the time into its flight at each point
 */
export interface ChainPieces {
  lengths: Float64Array;
  seconds: Float64Array;
  times: Float64Array;
}

/**
 * The pieces of each curve, by its points, and by how their heat is
 * weighed, all timed by one clock: a flight's curve is the same on every
 * ground and at every level (see groundedFlights), which only lift its
 * points, so the cloud and the replay of every level take them from here.
 * They go with the curves.
 */
const piecesOf = new WeakMap<
  readonly Coordinate[],
  Map<SegmentWeight, ChainPieces & { clock: FlightClock }>
>();

/**
 * The pieces of the curve of the chain the segments `first` to `end`
 * (exclusive) of `segments` are smoothed into, as `flights` has it: the
 * metres of each (pieceLengths), the heat of each as `weigh` counts its
 * segment's (segmentSeconds, or see heatWeight) spread over its pieces by
 * their length, and the time into its flight at each point by `clock`
 * (chainTimes), whatever `weigh` counts. Worked out once for a curve, its
 * clock and its weighing; another weighing of the same clock measures and
 * times the curve alike, and only weighs it anew.
 */
export function chainPieces(
  segments: readonly PathSegment[],
  flights: SmoothedFlights,
  first: number,
  end: number,
  clock: FlightClock,
  weigh: SegmentWeight = segmentSeconds,
): ChainPieces {
  const { chains, chainOf, from, to } = flights;
  const points = chains[chainOf[first]!]!.points;
  // The weighings of a curve are all timed by the same clock; another one
  // lets go of them
  let weighings = piecesOf.get(points);
  let alike = weighings?.values().next().value;
  if (!weighings || alike?.clock !== clock) {
    weighings = new Map();
    piecesOf.set(points, weighings);
    alike = undefined;
  }
  const held = weighings.get(weigh);
  if (held) return held;
  const lengths = alike?.lengths ?? pieceLengths(flights, first, end);
  const seconds = new Float64Array(points.length);
  for (let m = first; m < end; m++) {
    let total = 0;
    for (let j = from[m]! + 1; j <= to[m]!; j++) total += lengths[j]!;
    const spent = weigh(segments[m]!, segments[m + 1]);
    const pieces = to[m]! - from[m]!;
    for (let j = from[m]! + 1; j <= to[m]!; j++) {
      seconds[j] = total > 0 ? (spent * lengths[j]!) / total : spent / pieces;
    }
  }
  const times = alike?.times ?? chainTimes(flights, clock, first, end, lengths);
  const made = { lengths, seconds, times, clock };
  weighings.set(weigh, made);
  return made;
}

/**
 * The metres from each point of the curve of the chain the segments
 * `first` to `end` (exclusive) are smoothed into to the point before it
 */
function pieceLengths(
  flights: SmoothedFlights,
  first: number,
  end: number,
): Float64Array {
  const { chains, chainOf, from, to } = flights;
  const points = chains[chainOf[first]!]!.points;
  const lengths = new Float64Array(points.length);
  for (let m = first; m < end; m++) {
    for (let j = from[m]! + 1; j <= to[m]!; j++) {
      lengths[j] = planarMetres(points[j - 1]!, points[j]!);
    }
  }
  return lengths;
}
