/**
 * Flight time and distance of every flight of a dataset, which the flight
 * list of the statistics rail shows and sorts by (ui/flightList.ts), and
 * the rows of an airport's popup name (ui/airportFlights.ts).
 *
 * path_info carries neither, so both are worked out from the segments in
 * one pass over all of them, by the rules the statistics use: the time is
 * the span from the first to the last timed segment (perPathSeconds in
 * panelStats.ts), the distance the sum of the segments' great-circle
 * lengths (segmentDistance, which the other statistics share). The result
 * is kept for as long as the dataset's index is (calculations/
 * datasetIndex.ts), so every filter, search and sort of the list reads it
 * again for free. Part of the first visit, for the airport popups.
 */
import type { KMLDataset, PathSegment } from "../types";
import { datasetIndex, type DatasetIndex } from "./datasetIndex";
import { segmentDistance } from "./statistics";

/** What one flight adds up to */
export interface FlightTotals {
  /** Seconds in the log; absent for a flight without timing */
  seconds?: number;
  /** Great-circle length of its segments */
  km: number;
}

/** A flight's totals while the pass is on its segments */
interface Running {
  km: number;
  first: number;
  last: number;
}

/** The totals of a dataset, kept per index and so per dataset */
const kept = new WeakMap<DatasetIndex, Map<number, FlightTotals>>();

/**
 * The totals of every flight of the segments, by path id, in one pass. A
 * flight whose log has no time, or a single one, gets no `seconds`.
 */
export function computeFlightTotals(
  segments: readonly PathSegment[],
): Map<number, FlightTotals> {
  const running = new Map<number, Running>();
  for (const segment of segments) {
    let flight = running.get(segment.path_id);
    if (!flight) {
      flight = { km: 0, first: Infinity, last: -Infinity };
      running.set(segment.path_id, flight);
    }
    flight.km += segmentDistance(segment);
    const time = segment.time;
    if (time !== undefined) {
      if (time < flight.first) flight.first = time;
      if (time > flight.last) flight.last = time;
    }
  }

  const totals = new Map<number, FlightTotals>();
  for (const [id, { km, first, last }] of running) {
    totals.set(id, last > first ? { km, seconds: last - first } : { km });
  }
  return totals;
}

/** The totals of every flight of a dataset, worked out on first use */
export function flightTotals(data: KMLDataset): Map<number, FlightTotals> {
  const index = datasetIndex(data);
  let totals = kept.get(index);
  if (!totals) {
    totals = computeFlightTotals(data.path_segments);
    kept.set(index, totals);
  }
  return totals;
}
