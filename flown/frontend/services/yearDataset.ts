/**
 * The decoded form of a year file, and the dataset the app builds from it.
 *
 * The year worker (services/yearWorker.ts) parses and decodes a year file
 * and answers with flat columns in typed arrays. Their buffers are
 * transferred, which costs nothing however long they are, while the dataset
 * itself (one object and one coordinate pair per segment) would have to be
 * cloned on the main thread, for longer than decoding it there took. The
 * objects are made here instead, a slice at a time.
 */

import type { Coordinate } from "../utils/geometry";
import type { KMLDataset, PathInfo, PathSegment } from "../types";

/**
 * One year file, decoded. A path is `rowCounts[i]` rows, and one point more
 * than that: its start point, then the end point of every row. Paths follow
 * each other in all columns without gaps; one without a row is left out.
 */
export interface DecodedYear {
  path_info: PathInfo[];
  original_points: number;
  /** Id of every path that has rows */
  pathIds: Float64Array;
  /** Number of rows of every such path */
  rowCounts: Uint32Array;
  /** Per point, in degrees */
  lats: Float64Array;
  lons: Float64Array;
  /** Per row, in feet */
  altitudes: Float64Array;
  /** Per row, in knots */
  speeds: Float64Array;
  /** Per row, in seconds from the start of the path; NaN for a row without */
  times: Float64Array;
  /** Per row, feet of ground under its end; NaN for a path without */
  grounds: Float64Array;
  /** What the decoder had to say about broken paths */
  warnings: string[];
}

/** The buffers of a decoded year, for the transfer list of postMessage */
export function transferablesOf(decoded: DecodedYear): ArrayBuffer[] {
  const { pathIds, rowCounts, lats, lons, altitudes, speeds, times, grounds } =
    decoded;
  return [
    pathIds,
    rowCounts,
    lats,
    lons,
    altitudes,
    speeds,
    times,
    grounds,
  ].map((column) => column.buffer as ArrayBuffer);
}

/** Where a dataset under construction stands */
interface BuildCursor {
  path: number;
  point: number;
  row: number;
  /** Row at which the path being added ends */
  pathEnd: number;
  /** Where the next segment starts; null between two paths */
  previous: Coordinate | null;
}

function newCursor(): BuildCursor {
  return { path: 0, point: 0, row: 0, pathEnd: 0, previous: null };
}

/**
 * Rows added between two looks at the clock: a fraction of a millisecond of
 * work, and few enough that one long flight cannot outlast a slice.
 */
const ROWS_PER_CHECK = 1024;

/**
 * Add rows to the dataset until `isDue` says to stop.
 *
 * Neighbouring segments share the very same coordinate array: each
 * segment creates exactly one object.
 * @returns Whether every path has been added
 */
function addRows(
  decoded: DecodedYear,
  dataset: KMLDataset,
  cursor: BuildCursor,
  isDue: () => boolean,
): boolean {
  const { pathIds, rowCounts, lats, lons, altitudes, speeds, times, grounds } =
    decoded;
  // Filled with push: arrays preallocated with new Array(n) have holes
  // until they are full, which V8 keeps treating as the slower kind
  const { path_segments } = dataset;
  let { path, point, row, pathEnd, previous } = cursor;

  while (path < pathIds.length) {
    if (!previous) {
      previous = [lats[point]!, lons[point]!];
      point++;
      pathEnd = row + rowCounts[path]!;
    }
    const pathId = pathIds[path]!;
    const stop = Math.min(pathEnd, row + ROWS_PER_CHECK);
    for (; row < stop; row++, point++) {
      const next: Coordinate = [lats[point]!, lons[point]!];
      const segment: PathSegment = {
        path_id: pathId,
        coords: [previous, next],
        altitude_ft: altitudes[row]!,
        groundspeed_knots: speeds[row]!,
      };
      const time = times[row]!;
      if (!Number.isNaN(time)) segment.time = time;
      const ground = grounds[row]!;
      if (!Number.isNaN(ground)) segment.ground_ft = ground;
      path_segments.push(segment);
      previous = next;
    }
    if (row === pathEnd) {
      previous = null;
      path++;
    }
    if (isDue()) break;
  }

  Object.assign(cursor, { path, point, row, pathEnd, previous });
  return path === pathIds.length;
}

function emptyDataset(decoded: DecodedYear): KMLDataset {
  return {
    path_segments: [],
    path_info: decoded.path_info,
    original_points: decoded.original_points,
  };
}

/**
 * Build the in-memory dataset of a decoded year in one go
 * @param decoded - What the year worker answered with
 * @returns Expanded dataset
 */
export function buildDataset(decoded: DecodedYear): KMLDataset {
  const dataset = emptyDataset(decoded);
  addRows(decoded, dataset, newCursor(), () => false);
  return dataset;
}

/**
 * How long the dataset is worked on before the main thread is given back.
 * Short enough to fit into a frame next to what else the page is doing.
 */
const SLICE_MS = 4;

/**
 * Give the main thread back for a moment. A message rather than a timer:
 * timers are held back to once a second in a tab in the background, which
 * would stretch a year over minutes.
 */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

/**
 * Build the in-memory dataset of a decoded year a slice at a time, so that a
 * large year does not hold up a frame
 * @param decoded - What the year worker answered with
 * @param pause - Gives the main thread back between slices
 * @returns Expanded dataset
 */
export async function buildDatasetInSlices(
  decoded: DecodedYear,
  pause: () => Promise<void> = nextTask,
): Promise<KMLDataset> {
  const dataset = emptyDataset(decoded);
  const cursor = newCursor();
  for (;;) {
    const sliceEnd = performance.now() + SLICE_MS;
    const isDue = (): boolean => performance.now() >= sliceEnd;
    if (addRows(decoded, dataset, cursor, isDue)) return dataset;
    await pause();
  }
}

/**
 * Combine multiple year datasets into one.
 * Path ids are unique across years, so this is a plain concatenation:
 * segment and path info objects are shared, not copied.
 * @param yearDatasets - Array of year datasets (null entries are skipped)
 * @returns Combined dataset
 */
export function combineYearData(
  yearDatasets: (KMLDataset | null | undefined)[],
): KMLDataset {
  const years = yearDatasets.filter((data): data is KMLDataset => !!data);
  // Concatenated, not filled into new Array(n): see addRows
  return {
    path_segments: ([] as PathSegment[]).concat(
      ...years.map((data) => data.path_segments),
    ),
    path_info: ([] as KMLDataset["path_info"]).concat(
      ...years.map((data) => data.path_info),
    ),
    original_points: years.reduce(
      (sum, data) => sum + (data.original_points || 0),
      0,
    ),
  };
}
