/**
 * Year files and datasets for the tests of the loader and of the year worker
 */

import { vi } from "vitest";
import { DATA_FORMAT_VERSION } from "../../flown/frontend/services/yearDecode";
import { handleRequest } from "../../flown/frontend/services/yearWorker";
import type { YearWorkerLike } from "../../flown/frontend/services/yearDecoder";
import type {
  YearRequest,
  YearResponse,
} from "../../flown/frontend/services/yearWorker";
import type {
  KMLDataset,
  RawSegments,
  RawYearData,
} from "../../flown/frontend/types";

/**
 * A year worker without a thread: it answers with the real message handler,
 * a microtask after the request, and its buffers change hands the way a real
 * transfer would move them.
 */
export class FakeYearWorker {
  requests: YearRequest[] = [];
  /** What each request handed over (see postMessage) */
  transfers: (Transferable[] | StructuredSerializeOptions)[] = [];
  terminate = vi.fn();
  /** Cleared by a test that wants to answer, or not to answer, by itself */
  answers = true;
  private listeners = new Map<string, ((event: Event) => void)[]>();

  addEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  postMessage(
    request: YearRequest,
    transfer: Transferable[] | StructuredSerializeOptions = [],
  ): void {
    this.requests.push(request);
    this.transfers.push(transfer);
    if (this.answers) queueMicrotask(() => this.answer(request));
  }

  /**
   * Answer `request` as the worker would. A Blob crosses as a handle to the
   * same bytes, which jsdom's cannot be cloned into, so it is kept as it is.
   */
  answer(request: YearRequest): void {
    const { response, transfer } = handleRequest(request);
    const data = structuredClone(response, { transfer });
    if ("drawn" in response && "drawn" in data) {
      data.drawn.source = response.drawn.source;
    }
    if ("source" in response && "source" in data) data.source = response.source;
    this.emit("message", { data });
  }

  /** Send the page an answer of the test's own making */
  say(response: YearResponse): void {
    this.emit("message", { data: response });
  }

  emit(type: string, event: object): void {
    const full = { preventDefault: vi.fn(), ...event } as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) listener(full);
  }

  /** For the `createWorker` option of the decoder */
  asWorker(): YearWorkerLike {
    return this;
  }
}

/**
 * Column scales of the wire format, mirroring flown/segment_codec.py
 * (the altitude column counts steps of 20 ft). The two coordinate columns
 * are second differences. The helpers below take rows
 * in the units a reader thinks in and encode them, so a test says what it
 * means and the decoder is still checked against an independent encoder.
 */
const SCALES = [1e5, 1e5, 1 / 20, 1, 10];
/** The columns written as second differences */
const SECOND_ORDER = 2;

/**
 * One path's encoded segments, as segment_codec.py's encode_rows returns
 * them: the scaled start point, the columns of its rows (without a time
 * column when no row has a time) and its ground. A year file holds them
 * column by column across its paths; rawYear lays them out that way.
 */
export interface PathSegments {
  start: number[];
  columns: (number | null)[][];
  ground?: number[];
}

/**
 * One path's exported segments, given as plain `[lat, lon, ft, kt, s?]` rows,
 * and the feet of ground under each row when the path has them
 */
export function path(
  start: [number, number],
  rows: number[][],
  groundFt?: number[],
): PathSegments {
  const scaledStart = [
    Math.round(start[0] * SCALES[0]!),
    Math.round(start[1] * SCALES[1]!),
  ];
  const running = [scaledStart[0]!, scaledStart[1]!, 0, 0, 0];
  // The last step of each coordinate column
  const steps = [0, 0];
  // The time column is only written when some row has a time
  const columns: (number | null)[][] = [[], [], [], []];
  if (rows.some((row) => row.length > 4)) columns.push([]);
  for (const row of rows) {
    columns.forEach((column, index) => {
      const value = row[index];
      if (value === undefined) {
        column.push(null);
        return;
      }
      const scaled = Math.round(value * SCALES[index]!);
      const step = scaled - running[index]!;
      if (index < SECOND_ORDER) {
        column.push(step - steps[index]!);
        steps[index] = step;
      } else {
        column.push(step);
      }
      running[index] = scaled;
    });
  }
  const encoded: PathSegments = { start: scaledStart, columns };
  if (groundFt) {
    // In tens of feet, as differences (GROUND_STEP of segment_codec.py)
    encoded.ground = groundFt.map(
      (feet, i) => (feet - (groundFt[i - 1] ?? 0)) / 10,
    );
  }
  return encoded;
}

/**
 * A year file of the given paths, by id. `pathInfo` lists the paths in the
 * order of the file and defaults to the ids of `paths`; a path it does not
 * list cannot be written. Entries that are not well formed are laid out as
 * they are, so a test can hand the decoder a broken path.
 */
export function rawYear(
  year: number,
  paths: Record<string, PathSegments>,
  pathInfo: RawYearData["path_info"] = Object.keys(paths).map((id) => ({
    id: Number(id),
  })),
): RawYearData {
  const listed = new Set(pathInfo.map((info) => String(info.id)));
  const unlisted = Object.keys(paths).filter((id) => !listed.has(id));
  if (unlisted.length > 0) {
    throw new Error(`path_info does not list ${unlisted.join(", ")}`);
  }
  const entries = pathInfo.map((info) => paths[String(info.id)]);
  const columnsOf = (entry?: PathSegments): unknown[] =>
    Array.isArray(entry?.columns) ? entry.columns : [];
  const segments = {
    start: entries.map((entry) => entry?.start ?? null),
    columns: [0, 1, 2, 3, 4].map((column) =>
      entries.map((entry) => columnsOf(entry)[column] ?? null),
    ),
    ground: entries.map((entry) => entry?.ground ?? null),
  } as RawSegments;
  return {
    format: DATA_FORMAT_VERSION,
    year,
    path_info: pathInfo,
    segments,
  };
}

export function dataset(segmentsCount: number, pathIdStart = 1): KMLDataset {
  const path_segments = Array.from({ length: segmentsCount }, (_, i) => ({
    path_id: pathIdStart + i,
    coords: [
      [50, 8],
      [50.1, 8.1],
    ] as [[number, number], [number, number]],
    altitude_ft: 1000,
    groundspeed_knots: 100,
  }));
  return {
    path_segments,
    path_info: path_segments.map((s) => ({ id: s.path_id })),
  };
}

/** The body of a year file, as the site would serve it */
export function yearBytes(raw: unknown): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(raw));
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
}
