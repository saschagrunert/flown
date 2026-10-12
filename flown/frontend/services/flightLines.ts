/**
 * The lines the year worker (services/yearWorker.ts) draws along the
 * flights: the heat lines and the colour layers' lines.
 *
 * Both run along the curve through the fixes (calculations/curves.ts).
 * Worked out on the page, the curves of all years of the sample flights
 * took the main thread about 60 ms, the heat lines 100 ms on top, and the
 * colour lines handed to MapLibre as objects another 50 to 75 ms for its
 * copy of them, each time (on a desktop; three to five times that on a
 * phone). So the page packs the segments of a dataset into columns
 * (flightColumns) and hands them to the worker with the first lines asked
 * of it. The worker keeps them for the lines asked next, smooths them, and
 * writes the lines as GeoJSON text, which the sources are given a URL of,
 * as the heat source is (see services/heatSource.ts). The page sends no
 * more than which flights a heat keeps, or the runs of a colour layer.
 *
 * Like everything else in yearWorker.bundle.js this is no part of what a
 * first visit downloads, and the page writes the same lines with it where
 * the worker cannot be used (services/yearDecoder.ts).
 */
import type { PathSegment } from "../types";
import type { Coordinate } from "../utils/geometry";
import { toLngLat, type LngLatTuple } from "../utils/mapHelpers";
import { appendCurve, flatCurves } from "../calculations/curves";
import { heatLinesAlong, heatWeight } from "../calculations/heatLines";
import { heatLineTone } from "../calculations/heatTone";
import type {
  ChainCache,
  SmoothedFlights,
  SmoothedLine,
} from "../calculations/smoothing";
import {
  collection,
  degrees,
  flatLines,
  json,
  linesSource,
} from "./heatSource";

/**
 * The segments of a dataset as columns, as much of them as the lines read:
 * where each is, of which path, how fast and when
 */
export interface FlightColumns {
  pathIds: Float64Array;
  /** Latitude and longitude of the start of each segment, then of its end */
  coords: Float64Array;
  /** Knots, see PathSegment.groundspeed_knots */
  speeds: Float64Array;
  /** NaN for a segment without a time */
  times: Float64Array;
}

/** The columns of `segments`, see FlightColumns */
export function flightColumns(segments: readonly PathSegment[]): FlightColumns {
  const count = segments.length;
  const columns: FlightColumns = {
    pathIds: new Float64Array(count),
    coords: new Float64Array(count * 4),
    speeds: new Float64Array(count),
    times: new Float64Array(count),
  };
  const { pathIds, coords, speeds, times } = columns;
  segments.forEach((segment, index) => {
    const [start, end] = segment.coords;
    pathIds[index] = segment.path_id;
    coords[index * 4] = start[0];
    coords[index * 4 + 1] = start[1];
    coords[index * 4 + 2] = end[0];
    coords[index * 4 + 3] = end[1];
    speeds[index] = segment.groundspeed_knots;
    times[index] = segment.time ?? NaN;
  });
  return columns;
}

/** The buffers of `columns`, for the transfer list of postMessage */
export function columnBuffers(columns: FlightColumns): ArrayBuffer[] {
  return Object.values(columns).map(
    (column: Float64Array) => column.buffer as ArrayBuffer,
  );
}

/** Flights to draw lines along: their segments and the curves through them */
export interface Flights {
  segments: readonly PathSegment[];
  curves: SmoothedFlights;
}

/**
 * The curves the worker smoothed, by the path and the segment of it their
 * chain starts with: every dataset it is handed brings segments of its
 * own, and the flights of a year are those of all years as well, their
 * segments in the same order. The place of the segment in its path, not
 * where it is: two chains of a flight may start at one point (a gap while
 * parked), with as many segments.
 */
const chainLines = new Map<string, SmoothedLine>();

/**
 * chainLines, for the chains of `segments`, which the flights handed over
 * last hold: the curves of other paths go as new flights arrive, so the
 * worker keeps those of the dataset shown and no more
 */
function heldChains(segments: readonly PathSegment[]): ChainCache {
  // The first segment of each path, the segments of a path being together
  const starts = new Map<number, number>();
  segments.forEach(({ path_id }, index) => {
    if (!starts.has(path_id)) starts.set(path_id, index);
  });
  for (const key of chainLines.keys()) {
    if (!starts.has(Number(key.slice(0, key.indexOf(","))))) {
      chainLines.delete(key);
    }
  }
  const key = (first: number): string => {
    const { path_id } = segments[first]!;
    return path_id + "," + (first - starts.get(path_id)!);
  };
  return {
    get: (first) => chainLines.get(key(first)),
    set: (first, line) => chainLines.set(key(first), line),
  };
}

/**
 * The flights of `columns`: segments as the lines read them, with no
 * altitude, and their curves
 */
export function flightsOf(columns: FlightColumns): Flights {
  const { pathIds, coords, speeds, times } = columns;
  const segments: PathSegment[] = [];
  let end: Coordinate = [NaN, NaN];
  for (let index = 0, at = 0; index < pathIds.length; index++, at += 4) {
    // A segment starts where the one before ends, which keeps one pair
    const start: Coordinate =
      end[0] === coords[at] && end[1] === coords[at + 1]
        ? end
        : [coords[at]!, coords[at + 1]!];
    end = [coords[at + 2]!, coords[at + 3]!];
    const segment: PathSegment = {
      path_id: pathIds[index]!,
      coords: [start, end],
      altitude_ft: NaN,
      groundspeed_knots: speeds[index]!,
    };
    const time = times[index]!;
    if (!Number.isNaN(time)) segment.time = time;
    segments.push(segment);
  }
  return { segments, curves: flatCurves(segments, heldChains(segments)) };
}

/** What the heat lines of a heat are asked for with */
export interface HeatLinesAsk {
  /** The paths the heat keeps, null for all of them */
  keep: Float64Array | null;
  /** What the heat is scaled by, see heatExposure */
  exposure: number;
}

/**
 * The content of the heat line source: the lines of heatLinesAlong of the
 * flights `ask` keeps, as bright as the heatmap draws the same heat
 */
export function heatLinesSource(
  { segments, curves }: Flights,
  { keep, exposure }: HeatLinesAsk,
): Blob {
  const kept = keep && new Set(keep);
  return linesSource(
    flatLines(
      heatLinesAlong(
        curves,
        segments,
        (pathId) => !kept || kept.has(pathId),
        (segment, next) => heatWeight(segment, next) * exposure,
        heatLineTone,
      ),
    ),
  );
}

/** The runs of a colour layer (see ui/pathRuns.ts), as columns */
export interface FlatRuns {
  /** Half-open range of the segments of each run */
  starts: Uint32Array;
  ends: Uint32Array;
  pathIds: Float64Array;
  colors: string[];
  /** The generation of the runs, see RunTable.g in ui/pathRuns.ts */
  g: number;
}

/** What a run is of a colour layer, as much as its line needs */
export interface LineRun {
  start: number;
  end: number;
  pathId: number;
  color: string;
}

/** `runs` as columns, see FlatRuns */
export function flatRuns(runs: readonly LineRun[], g: number): FlatRuns {
  return {
    starts: Uint32Array.from(runs, (run) => run.start),
    ends: Uint32Array.from(runs, (run) => run.end),
    pathIds: Float64Array.from(runs, (run) => run.pathId),
    colors: runs.map((run) => run.color),
    g,
  };
}

/**
 * The content of a colour layer's source: a LineString per run along the
 * curve through its fixes, each point in the copy of the world of the one
 * before, with the run's index as `r`, its generation as `g`, its path and
 * its colour (see PathRunProperties), at 7 decimals like the heat lines
 */
export function runsSource(
  { segments, curves }: Flights,
  runs: FlatRuns,
): Blob {
  const { starts, ends, pathIds, colors, g } = runs;
  return collection(starts.length, (r) => {
    const start = starts[r]!;
    const line: LngLatTuple[] = [toLngLat(segments[start]!.coords[0])];
    for (let i = start; i < ends[r]!; i++) appendCurve(line, curves, i);
    return (
      '{"type":"Feature","properties":{"r":' +
      r +
      ',"g":' +
      g +
      ',"pathId":' +
      json(pathIds[r]!) +
      ',"color":' +
      JSON.stringify(colors[r]) +
      '},"geometry":{"type":"LineString","coordinates":[' +
      line
        .map(
          ([lng, lat]) =>
            "[" + degrees(lng, 1e7) + "," + degrees(lat, 1e7) + "]",
        )
        .join() +
      "]}}"
    );
  });
}
