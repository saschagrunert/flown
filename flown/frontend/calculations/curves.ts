/**
 * The flights drawn flat on the map, along a curve through their fixes.
 *
 * A logger writes a fix every few seconds: some 200 metres apart in
 * cruise, and 80 in a turn, where the heading changes by ten degrees from
 * one to the next. Drawn straight from fix to fix, a turn is a polygon
 * once zoomed in. The colour lines, the heat lines, the selection's lines
 * and the replay all draw the curve of calculations/smoothing.ts through
 * the same fixes instead, cut into more points where the flight turns, so they
 * lie on top of each other. The fixes stay where they are: a colour still
 * changes at a fix, and every point of the curve belongs to the segment it
 * lies on.
 */
import type { PathSegment } from "../types";
import { toLngLatAfter, type LngLatTuple } from "../utils/mapHelpers";
import {
  smoothFlights,
  type ChainCache,
  type SmoothedFlights,
  type SmoothedLine,
} from "./smoothing";
import { segmentRangesFor } from "./statistics";

/**
 * Degrees of turn per point of the curve. The ribbons of the 3D view take
 * eight (see ribbons.ts), which left the corners of a gentle turn to be seen
 * on a flat line at zoom 16.
 */
export const FLAT_TURN_STEP_DEG = 4;

/** The curves of a segment array, worked out once for it */
const curvesOf = new WeakMap<readonly PathSegment[], SmoothedFlights>();

/**
 * The curve of every chain smoothed flat, by its first segment: the
 * datasets of a year and of all years share their segments (see
 * combineYearData), and so does a selection sliced out of either, so a
 * flight is smoothed once for all of them
 */
const flatChains = new WeakMap<PathSegment, SmoothedLine>();

/** flatChains, for the chains of `segments` */
function chainsOf(segments: readonly PathSegment[]): ChainCache {
  return {
    get: (first) => flatChains.get(segments[first]!),
    set: (first, line) => flatChains.set(segments[first]!, line),
  };
}

/**
 * Every flight of `segments` along its curve, flat. Kept for the array it
 * was worked out for: the data of a year does not change while it is on
 * the map, and whatever draws it draws the same one. `chains` holds the
 * curves of flights smoothed before, which are taken as they are (by
 * default flatChains).
 */
export function flatCurves(
  segments: readonly PathSegment[],
  chains: ChainCache = chainsOf(segments),
): SmoothedFlights {
  let curves = curvesOf.get(segments);
  if (!curves) {
    curves = smoothFlights(segments, () => 0, {
      turnStepDeg: FLAT_TURN_STEP_DEG,
      chains,
    });
    curvesOf.set(segments, curves);
  }
  return curves;
}

/**
 * The curves of the flight of `pathId` in `segments` alone, and where its
 * segments start there: the selection's lines and the tooltip smooth no
 * flight but the ones they draw. All of `segments` for an array that is
 * not in order of its paths (see segmentRangesFor).
 */
export function flightCurves(
  segments: readonly PathSegment[],
  pathId: number,
): FlightCurves {
  let flights = flightsOf.get(segments);
  if (!flights) {
    flights = new Map<number, FlightCurves>();
    flightsOf.set(segments, flights);
  }
  let flight = flights.get(pathId);
  if (!flight) {
    const range = segmentRangesFor(segments)?.get(pathId);
    // Out of order, the curves of every flight, smoothed once for all
    flight = range
      ? { curves: flatCurves(segments.slice(...range)), from: range[0] }
      : { curves: flatCurves(segments), from: 0 };
    flights.set(pathId, flight);
  }
  return flight;
}

/** The curves of one flight of a segment array, see flightCurves */
interface FlightCurves {
  curves: SmoothedFlights;
  /** Where the flight's segments start in the array */
  from: number;
}

/** flightCurves of a segment array, by path */
const flightsOf = new WeakMap<
  readonly PathSegment[],
  Map<number, FlightCurves>
>();

/**
 * Carry `line`, which ends where the segment at `index` starts, on to its
 * end along the curve, each point in the copy of the world of the one
 * before (see toLngLatAfter)
 */
export function appendCurve(
  line: LngLatTuple[],
  curves: SmoothedFlights,
  index: number,
): void {
  const chain = curves.chains[curves.chainOf[index]!];
  if (!chain) return;
  for (let i = curves.from[index]! + 1; i <= curves.to[index]!; i++) {
    line.push(toLngLatAfter(chain.points[i]!, line[line.length - 1]));
  }
}
