/**
 * The figures of the statistics panel and of Wrapped.
 *
 * Nothing on the map needs them, and both places that show them live in the
 * lazily loaded Wrapped bundle (see wrapped.ts), so they are kept apart from
 * statistics.ts, whose filters, segment slices, distances and altitude range
 * the map draws with on the first visit.
 */

import {
  CRUISE_ALTITUDE_THRESHOLD_FT,
  FEET_TO_METERS,
  METERS_TO_FEET,
  NAUTICAL_MILES_TO_KM,
} from "../utils/constants";
import { formatFlightTime } from "../utils/statsFormat";
import {
  aggregateAircraft,
  altitudeRangeFt,
  filterPaths,
  heightsAboveGround,
  pathsById,
  segmentDistance,
  segmentsForPathIds,
} from "./statistics";
import type { FilterView } from "./datasetIndex";
import type {
  AircraftAggregate,
  PathInfo,
  PathSegment,
  AltitudeStats,
  SpeedStats,
  FilteredStatistics,
  LandingTotals,
} from "../types";

/**
 * Group timed segments by path and return per-path flight seconds.
 * Shared by the per-aircraft times (addFlightTimes) and the total time of
 * calculateFilteredStatistics.
 *
 * Only the first and last time of each path matter, so a running min and
 * max per path replaces collecting every timestamp.
 */
export function perPathSeconds(
  segments: PathSegment[],
  pathIds?: Set<number>,
): Map<number, number> {
  const bounds = new Map<number, { min: number; max: number }>();
  for (const seg of segments) {
    if (seg.time === undefined) continue;
    if (pathIds && !pathIds.has(seg.path_id)) continue;
    const range = bounds.get(seg.path_id);
    if (!range) {
      bounds.set(seg.path_id, { min: seg.time, max: seg.time });
    } else {
      if (seg.time < range.min) range.min = seg.time;
      if (seg.time > range.max) range.max = seg.time;
    }
  }
  const result = new Map<number, number>();
  for (const [pathId, { min, max }] of bounds) {
    result.set(pathId, max - min);
  }
  return result;
}

/**
 * Add each aircraft's flight time, from the seconds of its paths (see
 * perPathSeconds)
 */
function addFlightTimes(
  aircraftList: AircraftAggregate[],
  paths: PathInfo[],
  secondsByPath: Map<number, number>,
): void {
  // A Map, as a registration is data: "constructor" is no key of it
  const byRegistration = new Map(
    aircraftList.map((aircraft) => [aircraft.registration, aircraft]),
  );
  for (const path of paths) {
    const entry = byRegistration.get(path.aircraft_registration ?? "");
    const seconds = secondsByPath.get(path.id);
    if (entry && seconds) entry.flight_time_seconds! += seconds;
  }
  for (const aircraft of aircraftList) {
    if (aircraft.flight_time_seconds && aircraft.flight_time_seconds > 0) {
      aircraft.flight_time_str = formatFlightTime(aircraft.flight_time_seconds);
    }
  }
}

/**
 * Filter segments by path IDs
 * @param segments - Array of all segments
 * @param pathInfo - Array of filtered path info objects
 * @returns Filtered segments
 */
export function filterSegmentsByPaths(
  segments: PathSegment[],
  pathInfo: PathInfo[],
): PathSegment[] {
  return segmentsForPathIds(
    segments,
    pathInfo.map((p) => p.id),
  );
}

/**
 * Calculate total distance from segments
 * @param segments - Array of segment objects with coords
 * @returns Total distance in kilometers
 */
export function calculateTotalDistance(segments: PathSegment[]): number {
  let total = 0;
  for (const segment of segments) {
    total += segmentDistance(segment);
  }
  return total;
}

/**
 * Collect unique airports from path info
 * @param pathInfo - Array of path info objects
 * @returns Set of unique airport codes
 */
export function collectAirports(pathInfo: PathInfo[]): Set<string> {
  const airports = new Set<string>();
  for (const path of pathInfo) {
    if (path.start_airport) airports.add(path.start_airport);
    if (path.end_airport) airports.add(path.end_airport);
  }
  return airports;
}

/**
 * The landings of the flights, from their path info: the build reads them
 * from the full-precision logs (flown/landings.py). Undefined when no
 * flight carries them, as on a site built from logs without timestamps.
 * @param paths - The flights
 */
export function landingTotals(paths: PathInfo[]): LandingTotals | undefined {
  let counted = false;
  const totals: LandingTotals = {
    landings: 0,
    touchAndGoes: 0,
    goArounds: 0,
    mostTouchAndGoes: 0,
  };
  // Touchdowns by field, then by runway
  const byField = new Map<string, Map<string, number>>();
  for (const path of paths) {
    if (path.landings === undefined) continue;
    counted = true;
    const touchAndGoes = path.touch_and_goes ?? 0;
    totals.landings += path.landings;
    totals.touchAndGoes += touchAndGoes;
    totals.goArounds += path.go_arounds ?? 0;
    totals.mostTouchAndGoes = Math.max(totals.mostTouchAndGoes, touchAndGoes);
    for (const [airport, runway] of path.touchdowns ?? []) {
      if (!runway) continue;
      const runways = byField.get(airport) ?? new Map<string, number>();
      runways.set(runway, (runways.get(runway) ?? 0) + 1);
      byField.set(airport, runways);
    }
  }
  if (!counted) return undefined;

  // The first runway to reach the most touchdowns wins a tie
  let most = 0;
  for (const [airport, runways] of byField) {
    let atField = 0;
    for (const count of runways.values()) atField += count;
    for (const [runway, count] of runways) {
      if (count <= most) continue;
      most = count;
      totals.busiestRunway = { airport, runway, share: count / atField };
    }
  }
  return totals;
}

/**
 * Calculate altitude statistics from segments
 *
 * The range and the climb are the exact ones path_info carries for every
 * path with an altitude (export_pipeline.py writes the three together),
 * summed over the paths that have a segment here.
 * @param segments - Array of segment objects
 * @param paths - Path info carrying the exact per-path altitude range and gain
 * @returns Altitude statistics in meters
 */
export function calculateAltitudeStats(
  segments: PathSegment[],
  paths: PathInfo[],
): AltitudeStats {
  const range = altitudeRangeFt(segments, paths);
  if (range === null) {
    return { min: 0, max: 0, gain: 0 };
  }

  const byId = pathsById(paths);
  const counted = new Set<number>();
  let gainFt = 0;
  for (const segment of segments) {
    if (counted.has(segment.path_id)) continue;
    counted.add(segment.path_id);
    gainFt += byId.get(segment.path_id)?.altitude_gain_ft ?? 0;
  }

  return {
    min: range.min * FEET_TO_METERS,
    max: range.max * FEET_TO_METERS,
    gain: gainFt * FEET_TO_METERS,
  };
}

/**
 * Calculate groundspeed statistics from segments
 * @param segments - Array of segment objects
 * @returns Speed statistics in knots
 */
export function calculateSpeedStats(segments: PathSegment[]): SpeedStats {
  let count = 0;
  let sum = 0;
  let max = 0;
  for (const segment of segments) {
    const speed = segment.groundspeed_knots;
    if (speed === undefined || speed <= 0) continue;
    count += 1;
    sum += speed;
    if (speed > max) max = speed;
  }

  return count === 0 ? { max: 0, avg: 0 } : { max, avg: sum / count };
}

/**
 * Calculate longest flight distance
 * @param segments - Array of segment objects
 * @returns Longest flight distance in kilometers
 */
export function calculateLongestFlight(segments: PathSegment[]): number {
  // A Map rather than an object keyed by the path ids, which took a quarter
  // of the statistics of all years on a phone
  const pathDistances = new Map<number, number>();

  for (const segment of segments) {
    const distance = segmentDistance(segment);
    if (distance > 0) {
      pathDistances.set(
        segment.path_id,
        (pathDistances.get(segment.path_id) ?? 0) + distance,
      );
    }
  }

  let longest = 0;
  for (const distance of pathDistances.values()) {
    if (distance > longest) longest = distance;
  }
  return longest;
}

function emptyStatistics(): FilteredStatistics {
  return {
    total_points: 0,
    num_paths: 0,
    num_airports: 0,
    airport_names: [],
    num_aircraft: 0,
    aircraft_list: [],
    total_distance_nm: 0,
    total_distance_km: 0,
  };
}

/** What the statistics are worked out from */
export interface StatisticsOptions {
  pathInfo: PathInfo[];
  segments: PathSegment[];
  year?: string;
  aircraft?: string;
  preFiltered?: { paths: PathInfo[]; segments: PathSegment[] };
}

/**
 * Calculate comprehensive statistics from filtered data
 * @param options - Options object
 * @returns Statistics object
 */
export function calculateFilteredStatistics(
  options: StatisticsOptions,
): FilteredStatistics {
  const steps = statisticsSteps(options);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Segments walked between two points a slice of the work may end at */
const SEGMENTS_PER_STEP = 4096;

/**
 * The work of calculateFilteredStatistics, in steps: it stops at every
 * `yield`, after a pass or a few thousand segments of one, where the work
 * can be left for the page to answer in between (filterStatisticsInSlices).
 */
function* statisticsSteps(
  options: StatisticsOptions,
): Generator<void, FilteredStatistics, void> {
  const {
    pathInfo,
    segments,
    year = "all",
    aircraft = "all",
    preFiltered,
  } = options;

  if (!pathInfo || !segments) {
    return emptyStatistics();
  }

  const filteredPaths =
    preFiltered?.paths ?? filterPaths(pathInfo, year, aircraft);

  if (filteredPaths.length === 0) {
    return emptyStatistics();
  }

  // Collect data
  const airports = collectAirports(filteredPaths);
  const filteredSegments =
    preFiltered?.segments ?? filterSegmentsByPaths(segments, filteredPaths);
  // The distances first, a few thousand segments at a time: the first time
  // a segment's distance is asked for it is worked out and kept on the
  // segment (see segmentDistance), and three of the passes below read it
  for (let i = 0; i < filteredSegments.length; i++) {
    segmentDistance(filteredSegments[i]!);
    if (i % SEGMENTS_PER_STEP === SEGMENTS_PER_STEP - 1) yield;
  }
  yield;
  // One grouping pass feeds both the per-aircraft times and the total
  const secondsByPath = perPathSeconds(
    filteredSegments,
    new Set(filteredPaths.map((p) => p.id)),
  );
  yield;
  const aircraftList = aggregateAircraft(filteredPaths);
  addFlightTimes(aircraftList, filteredPaths, secondsByPath);

  // Calculate metrics
  const totalDistanceKm = calculateTotalDistance(filteredSegments);
  yield;
  const altitudeStats = calculateAltitudeStats(filteredSegments, filteredPaths);
  yield;
  const speedStats = calculateSpeedStats(filteredSegments);
  yield;
  const longestFlight = calculateLongestFlight(filteredSegments);
  yield;
  let flightTime = 0;
  for (const secs of secondsByPath.values()) flightTime += secs;

  // Unit conversions
  // A filter without any altitude reports none instead of 0 m, so that a
  // flight that never left sea level still shows its altitude. Whether a
  // path has altitudes is in its info (see altitudeRangeFt): the segments
  // of one without carry 0 ft, like those at sea level.
  const hasAltitude = altitudeRangeFt(filteredSegments, filteredPaths) !== null;
  const maxAltitudeFt = altitudeStats.max * METERS_TO_FEET;
  const minAltitudeFt = altitudeStats.min * METERS_TO_FEET;
  const totalAltitudeGainFt = altitudeStats.gain * METERS_TO_FEET;
  const longestFlightNm = longestFlight / NAUTICAL_MILES_TO_KM;

  // Format flight time
  const flightTimeStr =
    flightTime > 0 ? formatFlightTime(flightTime) : undefined;

  // Cruise: the segments more than 1000 ft above the ground, each with its
  // height above it for the altitude bins below
  const heights = heightsAboveGround(filteredSegments);
  const cruiseSegments: { segment: PathSegment; heightFt: number }[] = [];
  let walked = 0;
  for (const segment of filteredSegments) {
    if (++walked % SEGMENTS_PER_STEP === 0) yield;
    if (!(segment.groundspeed_knots > 0)) continue;
    const heightFt = heights.heightFt(segment, segment.altitude_ft);
    if (heightFt > CRUISE_ALTITUDE_THRESHOLD_FT) {
      cruiseSegments.push({ segment, heightFt });
    }
  }

  // Weighted by distance (total distance over total time) rather than a
  // plain mean of the segment speeds: segments differ in length, and a
  // mean would let a burst of short ones outweigh the rest of the cruise
  let cruiseSpeed: number | undefined;
  if (cruiseSegments.length > 0) {
    let totalDistanceNm = 0;
    let totalTimeHours = 0;

    for (const { segment: seg } of cruiseSegments) {
      const distanceKm = segmentDistance(seg);
      if (
        distanceKm > 0 &&
        seg.groundspeed_knots &&
        seg.groundspeed_knots > 0
      ) {
        const distanceNm = distanceKm / NAUTICAL_MILES_TO_KM;
        const timeHours = distanceNm / seg.groundspeed_knots;

        totalDistanceNm += distanceNm;
        totalTimeHours += timeHours;
      }
    }

    cruiseSpeed =
      totalTimeHours > 0 ? totalDistanceNm / totalTimeHours : undefined;
  }

  // Most common cruise height, in 100 ft bins: the altitudes are exported
  // in 20 ft steps (see export_pipeline.py), finer than a cruise holds
  let mostCommonCruiseAltitudeFt: number | undefined;
  let mostCommonCruiseAltitudeM: number | undefined;
  if (cruiseSegments.length > 0) {
    const altitudeBuckets: { [key: number]: number } = {};
    for (const { heightFt } of cruiseSegments) {
      const bucketFt = Math.round(heightFt / 100) * 100;
      altitudeBuckets[bucketFt] = (altitudeBuckets[bucketFt] || 0) + 1;
    }
    // Most frequent bin wins; ties resolve to the lowest bin, so the figure
    // does not move with the iteration order of the bins
    const mostCommonBucket = Object.entries(altitudeBuckets).sort(
      (a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]),
    )[0];
    if (mostCommonBucket) {
      mostCommonCruiseAltitudeFt = Number(mostCommonBucket[0]);
      mostCommonCruiseAltitudeM = mostCommonCruiseAltitudeFt * FEET_TO_METERS;
    }
  }

  yield;
  // Track points behind the filtered segments: every segment contributes its
  // start point and each path adds the end point of its last segment. This is
  // exactly what the heatmap draws, so the figure follows every filter and
  // means the same thing for a filter and for a selection.
  const pathsWithSegments = new Set<number>();
  for (const seg of filteredSegments) pathsWithSegments.add(seg.path_id);
  const totalPoints = filteredSegments.length + pathsWithSegments.size;

  return {
    total_points: totalPoints,
    num_paths: filteredPaths.length,
    num_airports: airports.size,
    airport_names: Array.from(airports),
    num_aircraft: aircraftList.length,
    aircraft_list: aircraftList,
    total_distance_km: totalDistanceKm,
    total_distance_nm: totalDistanceKm / NAUTICAL_MILES_TO_KM,
    max_altitude_m: hasAltitude ? altitudeStats.max : undefined,
    min_altitude_m: hasAltitude ? altitudeStats.min : undefined,
    total_altitude_gain_m: hasAltitude ? altitudeStats.gain : undefined,
    max_altitude_ft: hasAltitude ? maxAltitudeFt : undefined,
    min_altitude_ft: hasAltitude ? minAltitudeFt : undefined,
    total_altitude_gain_ft: hasAltitude ? totalAltitudeGainFt : undefined,
    max_groundspeed_knots: speedStats.max,
    avg_groundspeed_knots: speedStats.avg,
    cruise_speed_knots: cruiseSpeed,
    cruise_height_above_terrain:
      cruiseSegments.length > 0 ? heights.fromTerrain : undefined,
    longest_flight_km: longestFlight,
    longest_flight_nm: longestFlightNm,
    total_flight_time_seconds: flightTime,
    total_flight_time_str: flightTimeStr,
    most_common_cruise_altitude_ft: mostCommonCruiseAltitudeFt,
    most_common_cruise_altitude_m: mostCommonCruiseAltitudeM,
    landings: landingTotals(filteredPaths),
  };
}

/**
 * Statistics by filter view, dropped with the view (and so the dataset),
 * and by the options of a selection (see statisticsInSlices)
 */
const viewStatistics = new WeakMap<object, FilteredStatistics>();
/**
 * Statistics of a view being worked out in slices, with how many callers
 * still wait for them: the run stops once none does
 */
interface PendingStatistics {
  promise: Promise<FilteredStatistics>;
  waiters: number;
  stop: AbortController;
}
const pendingStatistics = new WeakMap<object, PendingStatistics>();

/**
 * How long a slice of the statistics runs before the page gets a turn. A
 * slice ends at the first step past it, which on a slow phone can take
 * another 20 ms, and a task of more than 50 ms counts as long.
 */
const SLICE_MS = 25;

/** The view's options for calculateFilteredStatistics */
function viewOptions(view: FilterView): StatisticsOptions {
  const segments = view.segments();
  return {
    pathInfo: view.paths,
    segments,
    preFiltered: { paths: view.paths, segments },
  };
}

/** The options a selection's statistics are kept by, as they are */
const asGiven = (options: object): StatisticsOptions =>
  options as StatisticsOptions;

/** Keep the first statistics of a view; a later run found the same */
function keep(view: object, stats: FilteredStatistics): FilteredStatistics {
  const kept = viewStatistics.get(view);
  if (kept) return kept;
  viewStatistics.set(view, stats);
  return stats;
}

/**
 * Statistics of the paths a filter view keeps. They walk every kept
 * segment, and the panel needs them again every time a selection is
 * cleared, as does Wrapped for the same filter, so they are kept with the
 * view.
 */
export function filterStatistics(view: FilterView): FilteredStatistics {
  return (
    viewStatistics.get(view) ??
    keep(view, calculateFilteredStatistics(viewOptions(view)))
  );
}

/**
 * The statistics of a view, like filterStatistics, without holding the
 * page up: all the flights of every year took a third of a second on a
 * phone, in one task. The work runs in slices of up to SLICE_MS, with a
 * task of the page's own between two of them. What is done within the
 * first slice (a view whose statistics are kept, or a small one) is
 * returned as it is; anything longer as a promise. A caller whose `signal`
 * aborts gets a rejection with the signal's reason (Wrapped closed while it
 * loaded); the run goes on for the others that asked for the same view
 * (the statistics rail), and stops at its next slice once none is left.
 */
export function filterStatisticsInSlices(
  view: FilterView,
  signal?: AbortSignal,
): FilteredStatistics | Promise<FilteredStatistics> {
  return statisticsInSlices(view, signal, viewOptions);
}

/**
 * filterStatisticsInSlices for any `key` the statistics are kept by: a
 * view, or by default the options of a selection, which the statistics
 * rail makes anew for each. A large selection, such as every flight of
 * the home base, took the page as long as a filter's statistics in one
 * task.
 */
export function statisticsInSlices(
  options: StatisticsOptions,
  signal?: AbortSignal,
): FilteredStatistics | Promise<FilteredStatistics>;
export function statisticsInSlices<K extends object>(
  key: K,
  signal: AbortSignal | undefined,
  optionsOf: (key: K) => StatisticsOptions,
): FilteredStatistics | Promise<FilteredStatistics>;
export function statisticsInSlices(
  view: object,
  signal?: AbortSignal,
  optionsOf: (key: object) => StatisticsOptions = asGiven,
): FilteredStatistics | Promise<FilteredStatistics> {
  const kept = viewStatistics.get(view);
  if (kept) return kept;
  const running = pendingStatistics.get(view);
  if (running) return follow(running, signal);
  const steps = statisticsSteps(optionsOf(view));
  const slice = (): FilteredStatistics | null => {
    const end = performance.now() + SLICE_MS;
    for (;;) {
      const step = steps.next();
      if (step.done) return keep(view, step.value);
      if (performance.now() >= end) return null;
    }
  };
  const done = slice();
  if (done) return done;
  const stop = new AbortController();
  const run = async (): Promise<FilteredStatistics> => {
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        stop.signal.throwIfAborted();
        const stats = slice();
        if (stats) return stats;
      }
    } finally {
      if (pendingStatistics.get(view) === pending) {
        pendingStatistics.delete(view);
      }
    }
  };
  const pending: PendingStatistics = { promise: run(), waiters: 0, stop };
  pendingStatistics.set(view, pending);
  // Let go of a stopped run at once, not at its next slice: a caller in
  // between (Wrapped opened again right after a close) starts its own
  stop.signal.addEventListener(
    "abort",
    () => {
      if (pendingStatistics.get(view) === pending) {
        pendingStatistics.delete(view);
      }
    },
    { once: true },
  );
  return follow(pending, signal);
}

/** A caller's share of a run: rejected when its own signal aborts */
function follow(
  pending: PendingStatistics,
  signal?: AbortSignal,
): Promise<FilteredStatistics> {
  // Without a signal the caller waits to the end, and so does the run
  if (!signal) {
    pending.waiters = Infinity;
    return pending.promise;
  }
  return new Promise((resolve, reject) => {
    const leave = () => {
      reject(signal.reason as Error);
      if (--pending.waiters === 0) pending.stop.abort(signal.reason);
    };
    pending.waiters++;
    if (signal.aborted) leave();
    signal.addEventListener("abort", leave, { once: true });
    pending.promise.then(resolve, reject);
  });
}
