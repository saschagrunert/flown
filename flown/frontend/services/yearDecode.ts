/**
 * Decoding of the year files (<year>/data.json), the mirror of
 * flown/segment_codec.py.
 *
 * This module is the body of yearWorker.bundle.js and no part of what a
 * first visit downloads: the app hands the bytes of a year file to the
 * worker (services/yearWorker.ts) and gets flat columns back, which
 * services/yearDataset.ts turns into the dataset. Nothing in here may be
 * imported by the app statically.
 */

import { buildDataset } from "./yearDataset";
import type { DecodedYear } from "./yearDataset";
import type { KMLDataset, RawYearData } from "../types";

/**
 * Wire format of the year files this build reads (flown/segment_codec.py).
 * A file written by another release is refused rather than misread.
 */
export const DATA_FORMAT_VERSION = 6;

/**
 * How the encoded columns become values again, the mirror of
 * segment_codec.py. Every value the exporter writes is rounded to a fixed
 * step, so the columns hold exact integers counted in that step.
 */
const COORDINATE_SCALE = 1e5;
const ALTITUDE_STEP = 20;
const SPEED_SCALE = 1;
const TIME_SCALE = 10;
const GROUND_STEP = 10;

/**
 * Decode the compact per-year file format into flat columns.
 *
 * Each path stores a start point and, column by column, the rows of
 * `[lat, lon, altitude_ft, groundspeed_knots, time?]`, where the coordinate
 * is the row's END point: consecutive rows are contiguous, so the start of a
 * row is the end of the one before it.
 *
 * Every column holds integers scaled to the step the exporter rounded to,
 * stored as differences to the row before (the start point seeds the two
 * coordinate columns). A path without a time column carries no relative
 * times, and a null in it marks a row without one; the running time then
 * stays where the last row that had one left it. The ground under every
 * row is a column of its own, `ground`, which a path may leave out; one that
 * does not fit its path is dropped, the path is not.
 *
 * A value that is not a finite number would turn into a NaN coordinate,
 * which the map cannot draw. Since every value is a difference, nothing after
 * it can be trusted either, so the path is cut short there with a warning
 * instead, and left out when that is its first row.
 * @param raw - Contents of <year>/data.json
 * @returns The decoded columns, see DecodedYear
 */
export function decodeYear(raw: RawYearData): DecodedYear {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Invalid year data: expected an object");
  }
  if (raw.format !== DATA_FORMAT_VERSION) {
    const error = new Error(
      `Invalid year data: format ${String(raw.format)}, expected ` +
        `${DATA_FORMAT_VERSION}; the data was written by another release`,
    );
    // Told by name, not by class, by the loader (STALE_DATA_ERROR there):
    // the page and the year worker each have a class of their own
    error.name = "StaleDataError";
    throw error;
  }
  const segmentsByPath = raw.segments;
  if (typeof segmentsByPath !== "object" || segmentsByPath === null) {
    throw new Error("Invalid year data: missing 'segments' map");
  }

  // Paths in path_info order, which is the order of the input. The keys of
  // the segments object are no substitute: ids are content hashes, and
  // JavaScript iterates the ones below 2^32 in numeric order first.
  const pathInfo = Array.isArray(raw.path_info) ? raw.path_info : [];
  // A Set keeps a path listed twice from being decoded twice
  const listed = new Set(pathInfo.map((info) => String(info.id)));
  for (const id of Object.keys(segmentsByPath)) listed.add(id);
  const pathIds = [...listed];

  // Room for every row the file has; a path that is cut short leaves some of
  // it unused, which is trimmed at the end
  let maxRows = 0;
  for (const id of pathIds) {
    const lats = segmentsByPath[id]?.columns?.[0];
    maxRows += Array.isArray(lats) ? lats.length : 0;
  }
  const maxPoints = maxRows + pathIds.length;

  const ids = new Float64Array(pathIds.length);
  const rowCounts = new Uint32Array(pathIds.length);
  const lats = new Float64Array(maxPoints);
  const lons = new Float64Array(maxPoints);
  const altitudes = new Float64Array(maxRows);
  const speeds = new Float64Array(maxRows);
  const times = new Float64Array(maxRows);
  const grounds = new Float64Array(maxRows);
  const warnings: string[] = [];

  let paths = 0;
  let points = 0;
  let rows = 0;

  for (const id of pathIds) {
    const entry = segmentsByPath[id];
    // A listed path without segments is legal, and has nothing to draw
    if (!entry) continue;
    // Columns that are missing altogether read as one row that is not
    // numeric, so the path is reported like any other broken one
    const [
      latDeltas = [NaN],
      lonDeltas,
      altitudeDeltas,
      speedDeltas,
      timeDeltas,
    ] = Array.isArray(entry.columns) ? entry.columns : [];

    // Running totals of the encoded columns; the coordinates start at the
    // path's start point, the rest at zero
    let latScaled = entry.start?.[0] ?? NaN;
    let lonScaled = entry.start?.[1] ?? NaN;
    let altitudeScaled = 0;
    let speedScaled = 0;
    let timeScaled = 0;
    // NaN without a ground column, so every row of the path reads as none
    const groundDeltas =
      entry.ground?.length === latDeltas.length ? entry.ground : [NaN];
    let groundScaled = 0;
    const firstRow = rows;

    // The start point is written with the first row that holds, so a path
    // whose first row is broken leaves nothing behind
    const startLat = latScaled / COORDINATE_SCALE;
    const startLon = lonScaled / COORDINATE_SCALE;
    let row = 0;
    for (; row < latDeltas.length; row++) {
      latScaled += latDeltas[row]!;
      lonScaled += lonDeltas?.[row] ?? NaN;
      altitudeScaled += altitudeDeltas?.[row] ?? NaN;
      speedScaled += speedDeltas?.[row] ?? NaN;
      const timeDelta = timeDeltas?.[row] ?? null;
      // A missing value makes the sum NaN and a string makes it a string,
      // so one check covers every column, the start point included
      if (
        !Number.isFinite(
          latScaled +
            lonScaled +
            altitudeScaled +
            speedScaled +
            (timeDelta ?? 0),
        )
      ) {
        warnings.push(
          `Path ${id}: row ${row} is not numeric, dropped the rest`,
        );
        break;
      }
      if (row === 0) {
        lats[points] = startLat;
        lons[points] = startLon;
        points++;
      }
      lats[points] = latScaled / COORDINATE_SCALE;
      lons[points] = lonScaled / COORDINATE_SCALE;
      points++;
      altitudes[rows] = altitudeScaled * ALTITUDE_STEP;
      speeds[rows] = speedScaled / SPEED_SCALE;
      if (timeDelta !== null) {
        timeScaled += timeDelta;
        times[rows] = timeScaled / TIME_SCALE;
      } else {
        times[rows] = NaN;
      }
      groundScaled += groundDeltas[row] ?? NaN;
      grounds[rows] = groundScaled * GROUND_STEP;
      rows++;
    }
    // A value that is not a number leaves the whole path without ground
    if (!Number.isFinite(groundScaled)) grounds.fill(NaN, firstRow, rows);

    if (row > 0) {
      ids[paths] = Number(id);
      rowCounts[paths] = row;
      paths++;
    }
  }

  return {
    path_info: pathInfo,
    original_points:
      typeof raw.original_points === "number" ? raw.original_points : 0,
    pathIds: ids.slice(0, paths),
    rowCounts: rowCounts.slice(0, paths),
    // Not slice() where nothing was cut: that would copy the whole column
    lats: trimmed(lats, points),
    lons: trimmed(lons, points),
    altitudes: trimmed(altitudes, rows),
    speeds: trimmed(speeds, rows),
    times: trimmed(times, rows),
    grounds: trimmed(grounds, rows),
    warnings,
  };
}

/** The first `length` values, as an array that owns exactly that much */
function trimmed(column: Float64Array, length: number): Float64Array {
  return length === column.length ? column : column.slice(0, length);
}

/**
 * Decode a year file from the bytes of its body
 * @param bytes - Body of <year>/data.json
 * @returns The decoded columns
 */
export function decodeYearBytes(bytes: ArrayBuffer): DecodedYear {
  // JSON is UTF-8 by definition; a byte order mark is skipped by the decoder
  const text = new TextDecoder().decode(bytes);
  return decodeYear(JSON.parse(text) as RawYearData);
}

/**
 * Expand a parsed year file into the in-memory dataset in one go. The app
 * does the two halves apart (the first in the worker); this is for the tests
 * that check the format against the exporter.
 * @param raw - Contents of <year>/data.json
 * @returns Expanded dataset
 */
export function expandYearData(raw: RawYearData): KMLDataset {
  const decoded = decodeYear(raw);
  for (const warning of decoded.warnings) console.warn(warning);
  return buildDataset(decoded);
}
