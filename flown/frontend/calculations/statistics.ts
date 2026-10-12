/**
 * Statistics calculation utilities
 * Pure functions for calculating flight statistics from path data
 *
 * What the map itself needs is here: the filters, the per-path segment
 * slices, distances, the altitude range of the colour scale and the ground
 * levels. The figures only the statistics panel and Wrapped show are in
 * panelStats.ts, which is part of the lazily loaded Wrapped bundle.
 */

import { calculateDistance } from "../utils/geometry";
import type { Range } from "../state/store";
import type { PathInfo, PathSegment, AircraftAggregate } from "../types";

/**
 * Great-circle length of a segment in kilometres.
 *
 * Every statistics refresh needs the distance of the same segments three
 * times (total distance, longest flight, cruise weighting), so the result is
 * memoised on the segment. The value only depends on `coords`, which the
 * data loader never changes after expansion.
 */
export function segmentDistance(segment: PathSegment): number {
  const cached = segment.distance_km;
  if (cached !== undefined) return cached;

  const coords = segment.coords;
  const distance =
    coords && coords.length === 2 ? calculateDistance(coords[0], coords[1]) : 0;
  segment.distance_km = distance;
  return distance;
}

/** Half-open index range `[start, end)` of one path within a segment array */
type SegmentRange = [start: number, end: number];

/** Path id to its range; null when the array is not grouped by path */
export type SegmentRanges = Map<number, SegmentRange> | null;

/** One index per segment array; the arrays never change after expansion */
const segmentRangesCache = new WeakMap<readonly PathSegment[], SegmentRanges>();

/**
 * Locate every path's segments in one pass. The exporter writes the
 * segments of a path contiguously and the loader keeps that order, so a
 * path is a slice of the array. An array where a path id comes back after
 * a different one is not indexable and yields null, which makes the callers
 * fall back to a filter.
 */
export function buildSegmentRanges(
  segments: readonly PathSegment[],
): SegmentRanges {
  const ranges = new Map<number, SegmentRange>();
  let current = -1;
  for (let i = 0; i < segments.length; i++) {
    const pathId = segments[i]!.path_id;
    if (pathId === current) {
      ranges.get(pathId)![1] = i + 1;
      continue;
    }
    if (ranges.has(pathId)) return null;
    ranges.set(pathId, [i, i + 1]);
    current = pathId;
  }
  return ranges;
}

/**
 * The index of a segment array, built once per array. Every dataset the
 * loader produces gets exactly one; temporary arrays are indexed on demand
 * and dropped with the array.
 */
export function segmentRangesFor(
  segments: readonly PathSegment[],
): SegmentRanges {
  const cached = segmentRangesCache.get(segments);
  if (cached !== undefined) return cached;
  const ranges = buildSegmentRanges(segments);
  segmentRangesCache.set(segments, ranges);
  return ranges;
}

/**
 * The segments of the given paths, in array order. Sliced through the index
 * where the array has one, so the cost is the size of the result rather than
 * the size of the dataset.
 */
export function segmentsForPathIds(
  segments: PathSegment[],
  pathIds: Iterable<number>,
): PathSegment[] {
  const ranges = segmentRangesFor(segments);
  if (ranges === null) {
    const wanted = pathIds instanceof Set ? pathIds : new Set(pathIds);
    return segments.filter((segment) => wanted.has(segment.path_id));
  }

  const found: SegmentRange[] = [];
  for (const pathId of pathIds) {
    const range = ranges.get(pathId);
    if (range) found.push(range);
  }
  if (found.length === 0) return [];
  // Array order, whatever order the ids came in
  found.sort((a, b) => a[0] - b[0]);

  let total = 0;
  for (const [start, end] of found) total += end - start;
  const result: PathSegment[] = new Array<PathSegment>(total);
  let index = 0;
  for (const [start, end] of found) {
    for (let i = start; i < end; i++) {
      result[index++] = segments[i]!;
    }
  }
  return result;
}

/**
 * Filter path info by year and aircraft
 * @param pathInfo - Array of path info objects
 * @param year - Year filter ('all' or specific year)
 * @param aircraft - Aircraft registration filter ('all' or specific registration)
 * @returns Filtered path info array
 */
export function filterPaths(
  pathInfo: PathInfo[],
  year: string,
  aircraft: string,
): PathInfo[] {
  return pathInfo.filter((path) => {
    if (year !== "all" && (!path.year || path.year.toString() !== year)) {
      return false;
    }
    if (
      aircraft !== "all" &&
      (!path.aircraft_registration || path.aircraft_registration !== aircraft)
    ) {
      return false;
    }
    return true;
  });
}

/**
 * Aggregate aircraft data from path info. The flight times are the
 * statistics panel's to add (see panelStats.ts), which the aircraft
 * dropdown does without.
 * @param pathInfo - Array of path info objects
 * @returns Array of aircraft objects with registration, type, and flight count
 */
export function aggregateAircraft(pathInfo: PathInfo[]): AircraftAggregate[] {
  // A Map, as a registration is data: "constructor" is no key of it
  const aircraftMap = new Map<string, AircraftAggregate>();

  for (const path of pathInfo) {
    if (path.aircraft_registration) {
      const reg = path.aircraft_registration;
      let entry = aircraftMap.get(reg);
      if (!entry) {
        entry = {
          registration: reg,
          type: path.aircraft_type,
          flights: 0,
          flight_time_seconds: 0,
        };
        aircraftMap.set(reg, entry);
      }
      entry.flights += 1;
      // Mixed sources: a later path may carry the type the first one lacks
      entry.type ??= path.aircraft_type;
    }
  }

  // Sort by flight count descending
  return [...aircraftMap.values()].sort((a, b) => b.flights - a.flights);
}

const pathsByIdCache = new WeakMap<PathInfo[], Map<number, PathInfo>>();

/** Paths by id, kept with the array: a filter view hands the same one again */
export function pathsById(paths: PathInfo[]): Map<number, PathInfo> {
  let byId = pathsByIdCache.get(paths);
  if (!byId) {
    byId = new Map(paths.map((path) => [path.id, path]));
    pathsByIdCache.set(paths, byId);
  }
  return byId;
}

/**
 * Altitude range in feet of the paths the segments belong to.
 *
 * Taken from path_info, which carries the exact range of every path with an
 * altitude: segment altitudes are rounded to 20 ft and can land on either
 * side of the exact value (1,291 ft rounds to 1,300 ft). The exporter writes
 * the range of every path whose points have an altitude, and a path without
 * one has no segment altitudes either (see the export contract test). Paths
 * without a segment here do not count at all. Null when none has a range.
 */
export function altitudeRangeFt(
  segments: PathSegment[],
  paths: PathInfo[],
): Range | null {
  const byId = pathsById(paths);
  let min = Infinity;
  let max = -Infinity;
  let pathId = NaN;
  for (const segment of segments) {
    // A path's segments are contiguous, so each path is looked up once
    if (segment.path_id === pathId) continue;
    pathId = segment.path_id;
    const info = byId.get(pathId);
    if (info?.min_altitude_ft === undefined) continue;
    if (info.max_altitude_ft === undefined) continue;
    if (info.min_altitude_ft < min) min = info.min_altitude_ft;
    if (info.max_altitude_ft > max) max = info.max_altitude_ft;
  }
  return min === Infinity ? null : { min, max };
}

/** Share of a path's altitude samples that may lie below its ground level */
const GROUND_LEVEL_PERCENTILE = 0.01;

/**
 * Ground level of every path, in feet: the altitude at index
 * `floor((n - 1) * 0.01)` of the path's `n` segment altitudes sorted in
 * ascending order.
 *
 * The lowest sample alone is not robust: one barometric glitch to -1,400 ft
 * lifts a taxi at 0 ft 1,400 ft above "ground" and counts it as cruise. A
 * glitch is a handful of samples while the time on the ground is many more,
 * so the first percentile skips the one and still lands on the other.
 */
export function groundLevelsFt(segments: PathSegment[]): Map<number, number> {
  // Altitudes are rounded to 20 ft, so a histogram per path holds a few
  // hundred entries where sorting every sample would copy all of them
  const histograms = new Map<number, Map<number, number>>();
  let pathId = NaN;
  let histogram: Map<number, number> | undefined;
  for (const segment of segments) {
    const alt = segment.altitude_ft;
    if (segment.path_id !== pathId || !histogram) {
      pathId = segment.path_id;
      histogram = histograms.get(pathId);
      if (!histogram) {
        histogram = new Map();
        histograms.set(pathId, histogram);
      }
    }
    histogram.set(alt, (histogram.get(alt) ?? 0) + 1);
  }

  const levels = new Map<number, number>();
  for (const [id, counts] of histograms) {
    let samples = 0;
    for (const count of counts.values()) samples += count;
    const index = Math.floor((samples - 1) * GROUND_LEVEL_PERCENTILE);
    let seen = 0;
    for (const alt of [...counts.keys()].sort((a, b) => a - b)) {
      seen += counts.get(alt)!;
      if (seen > index) {
        levels.set(id, alt);
        break;
      }
    }
  }
  return levels;
}

/**
 * Height of each segment above the ground, in feet, and whether all of it
 * is.
 *
 * The ground is the terrain under the segment where the export carries it
 * (ground_ft, flown/terrain.py), which is what AGL means. A path the
 * build has no terrain for stands on the lowest part of its own time
 * instead (groundLevelsFt), which is the height above its airfield; any
 * segment measured that way makes `fromTerrain` false, so the panel does
 * not call a height above the field AGL. The statistics panel and the
 * flight profile (ui/flightProfile.ts) both measure with it, and live in
 * different lazy bundles, so it is kept here with the map's own figures.
 */
export function heightsAboveGround(segments: PathSegment[]): {
  heightFt: (segment: PathSegment, altitudeFt: number) => number;
  readonly fromTerrain: boolean;
} {
  let fieldLevels: Map<number, number> | null = null;
  let fromTerrain = true;
  return {
    heightFt(segment, altitudeFt) {
      if (segment.ground_ft !== undefined) {
        return altitudeFt - segment.ground_ft;
      }
      fromTerrain = false;
      fieldLevels ??= groundLevelsFt(segments);
      return altitudeFt - (fieldLevels.get(segment.path_id) ?? 0);
    },
    get fromTerrain() {
      return fromTerrain;
    },
  };
}
