/**
 * The heat of the 3D view as a cloud in the air: the flights the heatmap
 * shows, along the curves the ribbons are cut from, as the points of a line
 * that the cloud's layer draws as a soft glow (see ui/heatCloudLayer.ts).
 * This module is the data: which points of the curves, where and how high,
 * and how much heat each stretch between two of them carries: the seconds
 * spent on it, as the heatmap and its lines count them (heatWeight), not
 * the fixes along it: a logger that writes a fix per turn or per change of
 * speed left a straight cruise in beads of light and dark.
 *
 * The curves and their heights are the ribbons' (smoothing.ts, lift.ts):
 * each flight smoothed through its fixes, at its altitude above the ground
 * of its flight at the relief level the map is drawn for, never below it,
 * and on the relief the ground itself under that (see groundedFlights,
 * which both take them from). The ribbons stand on the relief MapLibre
 * draws, which that ground follows to within a pixel at every level (see
 * groundProfileFt); the cloud stands on the ground, since a custom layer
 * cannot ask the map for its relief.
 *
 * Each point also carries the time into its flight it was flown at, which
 * the pulses of the layer run along, and how strongly the stretch from it
 * may draw the marks of the way it was flown, from the directions of the
 * flights around it (calculations/cloudCells.ts); and the heat is added up
 * in coarse cells on the way, for the exposure the layer draws the cloud
 * with.
 */
import type { PathSegment } from "../types";
import {
  DEGREES_TO_RADIANS,
  EARTH_CIRCUMFERENCE_M,
  metresPerPixel,
  TILE_SIZE_PX,
  type Coordinate,
} from "../utils/geometry";
import { mercatorOf } from "../utils/mercator";
import { FEET_TO_METERS } from "../utils/constants";
import { overlaps, type Box } from "../utils/viewBox";
import { boxOf } from "../utils/curveBox";
import { heatWeight, CRUISE_SPEED_MS, type SegmentWeight } from "./heatLines";
import { liftExaggeration } from "./lift";
import { chainPieces, flightClockOf } from "./flightClock";
import { cellTable } from "./cellTable";
import { markStretches } from "./cloudCells";
import type { SmoothedFlights } from "./smoothing";

/**
 * The points of a flight's curve are kept this many pixels apart at most,
 * in the middle of the zoom level the cloud is cut for (see cloudPoints):
 * closer ones are merged into the step between the ones kept, and their
 * heat with it. The glow of a step is wider (see CLOUD_STOPS in
 * ui/heatCloudShaders.ts), so a step is a chord of the curve that no one
 * tells from it, and zoomed out a year's flights are a few thousand steps
 * instead of a hundred thousand. Closer in the level is the zoom's, so the
 * cloud follows a taxiway or the corner of a circuit as the flat heat
 * lines do.
 */
export const CLOUD_STEP_PX = 6;

/**
 * A fix is kept as well where the height of the track has changed by this
 * many pixels since the last one kept, exaggerated as the level is, so a
 * climb stays a climb and does not turn into a slope to the next fix kept.
 */
const CLOUD_HEIGHT_STEP_PX = 1;

/**
 * The steps along a flight that lie on a straight line are merged into one
 * stretch, as long as it strays from none of the points on the way by more
 * than this many pixels of the level: across, in height or on the ground
 * under it, a seventh of the glow zoomed out and under half of it close
 * in, where it is narrowest (see CLOUD_STOPS in ui/heatCloudShaders.ts).
 * Every stretch is a quad that reaches three glows past either end, and
 * those of steps of a few pixels lay ten deep along every track: on a
 * phone's screen that was over 100 million pixels of glow a frame.
 */
export const CLOUD_MERGE_PX = 1;

/**
 * How far from a point merged over the pulses may run by the time it was
 * flown at, in pixels of the level: a pulse fades along 90 of them (see
 * CLOUD_FLOW_SPACING_PX in ui/heatCloudShaders.ts), and the layer runs them
 * along a stretch at an even speed.
 */
const CLOUD_MERGE_TIME_PX = 3;

/**
 * The longest a merged stretch gets, in pixels of the level: in a tilted
 * view the layer eases the blur and the pulses from one end of a stretch
 * to the other in a straight line on the screen, which is further off the
 * view's own perspective the longer the stretch is.
 */
export const CLOUD_MERGE_MAX_PX = 64;

/**
 * How many times the heat per metre of one of the steps merged into a
 * stretch the heat of another may be: a stretch glows alike along its
 * length, where a slower bit of a track glows brighter.
 */
export const CLOUD_MERGE_HEAT = 1.5;

/**
 * The least heat a stretch of any carries, in seconds, so its 32-bit float
 * is not 0, which to the layer is no stretch at all
 */
const MIN_HEAT_S = 0.01;

/**
 * The cells the heat is added up in for the exposure of the cloud (see
 * CloudPoints.busiest), this many pixels wide in the middle of the relief
 * level: about as wide as the glow of a stretch (see CLOUD_STOPS in
 * ui/heatCloudShaders.ts), so the heat of a cell is about what glows on its
 * brightest pixels. The directions of the stretches are added up in cells
 * as wide at the level the cloud is cut for (see markStretches), so the
 * flights of one track share them and those of a track a glow away do not.
 */
const CLOUD_CELL_PX = 16;

/** The part of the cells of heat that are less busy than CloudPoints.busiest */
const CLOUD_BUSIEST_PERCENTILE = 0.99;

/**
 * The floats of a point of the cloud: x, y, ground, lift, heat, time and
 * marks
 */
export const CLOUD_POINT_FLOATS = 7;

/** Which of them are the heat and the marks */
const HEAT_FLOAT = 4;
const MARKS_FLOAT = 6;

/**
 * The points of the cloud, one after the other along each flight, with a
 * point of no heat before the first and after the last, so the layer can
 * read the points on either side of every stretch (see
 * ui/heatCloudLayer.ts). Each is `CLOUD_POINT_FLOATS` floats:
 * - x and y in Mercator units (the world is 0 to 1), from `origin`, so a
 *   32-bit float holds them to a fraction of a pixel at every zoom the map
 *   has;
 * - the ground under the point, in feet (see groundProfilesFt);
 * - its height above that ground, in feet, never below 0 (see liftFt);
 * - the heat of the stretch from it to the next point: the seconds spent
 *   on the segments merged into it. The last point of a flight has none,
 *   and the stretch from it to the next flight's first is not drawn;
 * - its time: the seconds into its flight at which it was flown, by the
 *   clock replay all plays the flights by (see flightClock), from 0 at the
 *   flight's first fix and on across a gap in its log, so the pulses run
 *   the way the flight went, in step with replay all;
 * - its marks: how strongly the stretch from it may draw the marks of the
 *   way it was flown, from 0 to 1, for how far the flights around it go
 *   the same way (see markStretches); the last point of a run of
 *   stretches has those of the stretch before it.
 */
export interface CloudPoints {
  points: Float32Array;
  /** The number of points, without the two around them */
  count: number;
  /** The Mercator point the points are given from */
  origin: readonly [number, number];
  /** The Mercator x of the westernmost and easternmost point, unwrapped */
  xs: readonly [number, number];
  /**
   * The heat per metre where the cloud is busiest: of the cells of
   * CLOUD_CELL_PX the heat of the steps of the relief level in them is
   * added up in, the one CLOUD_BUSIEST_PERCENTILE of the others are
   * below, its heat over its width, in seconds per metre; 0 without any.
   * The layer sets its exposure by it (see cloudExposure in
   * ui/heatCloudShaders.ts).
   */
  busiest: number;
}

/** A point to a Chord: where it is, its height and the ground, and its time */
type ChordPoint<T> = (
  x: number,
  y: number,
  height: number,
  ground: number,
  time: number,
) => T;

/**
 * A stretch of the cloud from a point on (`from`), and whether it can go
 * on straight to another (`reaches`): a straight line on to it has to pass
 * every point on the way (`pass`) within CLOUD_MERGE_PX, across, in height
 * and on the ground under it, within CLOUD_MERGE_TIME_PX of where the time
 * at each puts it, and must not turn back. Each point passed narrows what
 * the line may be: the directions from the start within the tolerance of
 * it (the sector of Zhao and Saalfeld), and the slopes of the height, of
 * the ground and of the time over the distance, so a test costs the same
 * however many points the stretch is merged over. Everything is in pixels
 * of the level but the time, in seconds.
 */
interface Chord {
  from: ChordPoint<void>;
  reaches: ChordPoint<boolean>;
  pass: ChordPoint<void>;
}

/** A Chord */
function chord(): Chord {
  let x0 = 0;
  let y0 = 0;
  let height0 = 0;
  let ground0 = 0;
  let time0 = 0;
  /** The direction of the first point passed further than the tolerance */
  let ahead = NaN;
  /** How far the furthest point passed is */
  let reach = 0;
  /**
   * The least and the most a line may take of the turn from `ahead`, of
   * the slope of the height, of the ground and of the time
   */
  const low = new Float64Array(4);
  const high = new Float64Array(4);
  const narrow = (k: number, least: number, most: number): void => {
    low[k] = Math.max(low[k]!, least);
    high[k] = Math.min(high[k]!, most);
  };
  const within = (k: number, value: number): boolean =>
    value >= low[k]! && value <= high[k]!;
  return {
    from(x, y, height, ground, time) {
      x0 = x;
      y0 = y;
      height0 = height;
      ground0 = ground;
      time0 = time;
      ahead = NaN;
      reach = 0;
      low.fill(-Infinity);
      high.fill(Infinity);
    },
    reaches(x, y, height, ground, time) {
      const dx = x - x0;
      const dy = y - y0;
      const distance = Math.hypot(dx, dy);
      return (
        distance > 0 &&
        distance <= CLOUD_MERGE_MAX_PX &&
        distance >= reach - CLOUD_MERGE_PX &&
        (Number.isNaN(ahead) ||
          within(0, turnRad(Math.atan2(dy, dx) - ahead))) &&
        within(1, (height - height0) / distance) &&
        within(2, (ground - ground0) / distance) &&
        within(3, (time - time0) / distance)
      );
    },
    pass(x, y, height, ground, time) {
      const dx = x - x0;
      const dy = y - y0;
      const distance = Math.hypot(dx, dy);
      const off = CLOUD_MERGE_PX;
      reach = Math.max(reach, distance);
      if (distance > off) {
        const direction = Math.atan2(dy, dx);
        if (Number.isNaN(ahead)) ahead = direction;
        const turn = turnRad(direction - ahead);
        const spread = Math.asin(off / distance);
        narrow(0, turn - spread, turn + spread);
      }
      if (distance > 0) {
        const rise = height - height0;
        const slope = ground - ground0;
        narrow(1, (rise - off) / distance, (rise + off) / distance);
        narrow(2, (slope - off) / distance, (slope + off) / distance);
      }
      // Where the time puts the point on the line, from the time at either
      // end, is within the tolerance of where it is
      const spent = time - time0;
      const late = CLOUD_MERGE_TIME_PX;
      narrow(
        3,
        spent / (distance + late),
        distance > late ? spent / (distance - late) : Infinity,
      );
    },
  };
}

/** An angle in radians turned into the half turns either way */
function turnRad(angle: number): number {
  return angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
}

/** Whether the `[lat, lng]` point is in `box`, in any copy of the world */
function inBox(box: Box, [lat, lng]: Readonly<Coordinate>): boolean {
  return overlaps(box, [lng, lat, lng, lat]);
}

/**
 * Whether the straight line between the `[lat, lng]` points `a` and `b`
 * may cross `box`: whether the box around the two overlaps it. A step of a
 * flight logged a kilometre or more apart crosses the view close in
 * without an end in it.
 */
function crosses(
  box: Box,
  [latA, lngA]: Readonly<Coordinate>,
  [latB, lngB]: Readonly<Coordinate>,
): boolean {
  return overlaps(box, [
    Math.min(lngA, lngB),
    Math.min(latA, latB),
    Math.max(lngA, lngB),
    Math.max(latA, latB),
  ]);
}

/** Whether any of the curve `points` may reach into `box` */
function reaches(box: Box, points: readonly Readonly<Coordinate>[]): boolean {
  return overlaps(box, boxOf(points));
}

/**
 * The points of the cloud of the flights `keep` accepts, along their curves
 * `flights`, smoothed on their ground at the relief level `level` (see
 * groundedFlights): the curve the ribbons are cut from, at the heights
 * they have, so the cloud lies on them. It is cut for the zoom level
 * `detail`: the relief level's own, and closer in than the last relief
 * level the zoom's (see ui/heatCloud.ts). With a `box` only the stretches
 * that reach into it are kept (see viewBox), as the 3D view does around
 * the view from CULL_FROM_ZOOM on.
 *
 * A point of the curve is kept where it is CLOUD_STEP_PX of the level on
 * from the last one kept, or its height has changed by CLOUD_HEIGHT_STEP_PX,
 * and at either end of a flight: the steps of the cloud. The heat of a
 * segment, as `weigh` counts it (see heatWeight), is spread over the
 * pieces of the curve along it by their length, and a step carries that
 * of the curve it is merged from. The steps along a straight run are
 * merged into one stretch (see CLOUD_MERGE_PX), which carries their heat
 * and the time its first point was flown at, on replay all's clock
 * whatever `weigh` counts; steps out of the box, and steps of no heat
 * (what only the flights in the air leave out), are neither merged nor
 * written.
 *
 * The exposure (CloudPoints.busiest) adds up the heat of the steps of the
 * relief level, of every flight, in the box or not, so it is the same
 * wherever the view is and at every zoom level beyond the last relief
 * level. Where it is known already, `busiest` hands it on, and the flights
 * that do not reach the box are left alone.
 *
 * `scaleOf` says how brightly the layer draws a flight's worth for the
 * busiest heat per metre (see cloudExposure in ui/heatCloudShaders.ts), and
 * with it the heat of the stretches written is rolled off by that of the
 * cells they pass (see markStretches); without it the heat is left as it
 * is. With `starts`, the time of each flight's points begins where it
 * gives (see sequenceStarts in calculations/replayAll.ts) rather than at
 * 0, as the replay of flights played one after another times them, so
 * the heat builds up behind each in turn.
 */
export function cloudPoints(
  segments: readonly PathSegment[],
  flights: SmoothedFlights,
  keep: (pathId: number) => boolean,
  level: number,
  detail = level,
  box: Box | null = null,
  busiest?: number,
  weigh: SegmentWeight = heatWeight,
  scaleOf?: (busiest: number) => number,
  starts?: ReadonlyMap<number, number>,
): CloudPoints {
  const exaggeration = liftExaggeration(level);
  const values: number[] = [];
  let west = Infinity;
  let east = -Infinity;
  let north = Infinity;
  let south = -Infinity;
  const { chains, chainOf } = flights;
  const count = segments.length;
  // Mercator units in pixels of the level
  const worldPx = TILE_SIZE_PX * 2 ** (detail + 0.5);
  // The cells of heat, in Mercator units, and the heat per metre in each,
  // unless the exposure is known
  const cell = CLOUD_CELL_PX / (TILE_SIZE_PX * 2 ** (level + 0.5));
  // The heat of the steps added up by cell (see CLOUD_CELL_PX); most
  // steps go into the cell of the step before
  const cells = busiest === undefined ? cellTable(1) : null;
  // The time of the points, as replay all plays them
  const clock = flightClockOf(segments);
  const straight = chord();
  let i = 0;
  while (i < count) {
    // The segments of the chain of `i`, one after the other
    let end = i + 1;
    while (end < count && chainOf[end] === chainOf[i]) end++;
    const chain = chains[chainOf[i]!];
    if (
      chain &&
      chain.points.length > 1 &&
      keep(segments[i]!.path_id) &&
      (cells || !box || reaches(box, chain.points))
    ) {
      const { points, heights, ground } = chain;
      const [lat] = points[0]!;
      const cosLat = Math.cos(lat * DEGREES_TO_RADIANS);
      const pixelM = metresPerPixel(detail + 0.5) * cosLat;
      const stepM = CLOUD_STEP_PX * pixelM;
      // The pixels of the level a foot of height is drawn as
      const pixelsPerFt = (FEET_TO_METERS * exaggeration) / pixelM;
      const heightStepFt = CLOUD_HEIGHT_STEP_PX / pixelsPerFt;
      // The length, the heat and the time of each piece of the curve,
      // the same at every level (see chainPieces)
      const { lengths, seconds, times } = chainPieces(
        segments,
        flights,
        i,
        end,
        clock,
        weigh,
      );
      const groundAt = (j: number): number => (ground ? ground[j]! : 0);
      const heightAt = (j: number): number => groundAt(j) + heights[j]!;
      const start = starts?.get(segments[i]!.path_id) ?? 0;

      // The point the last step ended at, `prev`: whether it is in the
      // box, and where it is, its height and the ground under it in
      // pixels once they are `known`, which they need not be where no
      // stretch starts from it
      let prev = 0;
      let prevIn = !box || inBox(box, points[0]!);
      let prevX = 0;
      let prevY = 0;
      let prevHeight = 0;
      let prevGround = 0;
      let known = false;
      // The stretch being merged, from the point `first` of the curve to
      // `prev`, none before its first step (`merging`): where `first` is,
      // the heat of the stretch, and the least and the most heat per metre
      // of its steps. Each has an end in the box, or crosses it.
      let merging = false;
      let first = 0;
      let firstX = 0;
      let firstY = 0;
      let merged = 0;
      let least = 0;
      let most = 0;
      /** Whether the last point written goes on to the next */
      let open = false;
      const write = (j: number, x: number, y: number, heat: number): void => {
        west = Math.min(west, x);
        east = Math.max(east, x);
        north = Math.min(north, y);
        south = Math.max(south, y);
        values.push(x, y, groundAt(j), heights[j]!, heat, start + times[j]!, 0);
      };
      /** Write the stretch merged so far, which ends at `prev` */
      const flush = (): void => {
        if (open) {
          values[values.length - CLOUD_POINT_FLOATS + HEAT_FLOAT] = merged;
        } else write(first, firstX, firstY, merged);
        write(prev, prevX, prevY, 0);
        open = true;
      };
      /** The step to `j`, of `heat` over `metres`, merged on or not */
      const step = (j: number, heat: number, metres: number): void => {
        const point = points[j]!;
        const inside = !box || inBox(box, point);
        if (
          heat === 0 ||
          (!inside && !prevIn && !crosses(box, points[prev]!, point))
        ) {
          // Of no heat, or out of the box from end to end: neither drawn
          // nor merged, and a stretch starts anew where it ends
          if (merging) flush();
          merging = false;
          open = false;
          prev = j;
          prevIn = inside;
          known = false;
          return;
        }
        if (!known) {
          [prevX, prevY] = mercatorOf(points[prev]!);
          prevHeight = heightAt(prev) * pixelsPerFt;
          prevGround = groundAt(prev) * pixelsPerFt;
        }
        const [x, y] = mercatorOf(point);
        const height = heightAt(j) * pixelsPerFt;
        const under = groundAt(j) * pixelsPerFt;
        const density = heat / metres;
        const prevPx = prevX * worldPx;
        const prevPy = prevY * worldPx;
        if (merging) {
          straight.pass(prevPx, prevPy, prevHeight, prevGround, times[prev]!);
        }
        const low = Math.min(least, density);
        const high = Math.max(most, density);
        if (
          merging &&
          high <= low * CLOUD_MERGE_HEAT &&
          straight.reaches(x * worldPx, y * worldPx, height, under, times[j]!)
        ) {
          merged += heat;
          least = low;
          most = high;
        } else {
          if (merging) flush();
          first = prev;
          firstX = prevX;
          firstY = prevY;
          straight.from(prevPx, prevPy, prevHeight, prevGround, times[prev]!);
          merging = true;
          merged = heat;
          least = density;
          most = density;
        }
        prev = j;
        prevIn = inside;
        prevX = x;
        prevY = y;
        prevHeight = height;
        prevGround = under;
        known = true;
      };

      // The steps of the relief level, whose heat goes into the cells: the
      // point kept last, where it is, and the metres and seconds since
      const cellPixelM = metresPerPixel(level + 0.5) * cosLat;
      const cellStepM = CLOUD_STEP_PX * cellPixelM;
      const cellHeightStepFt =
        (CLOUD_HEIGHT_STEP_PX * cellPixelM) / exaggeration / FEET_TO_METERS;
      const cellM = CLOUD_CELL_PX * cellPixelM;
      let [cellX, cellY] = cells ? mercatorOf(points[0]!) : [0, 0];
      let cellFt = heightAt(0);
      let cellAlong = 0;
      let cellSeconds = 0;

      let along = 0;
      let heat = 0;
      let keptFt = heightAt(0);
      const final = points.length - 1;
      for (let j = 1; j <= final; j++) {
        along += lengths[j]!;
        heat += seconds[j]!;
        if (cells) {
          cellAlong += lengths[j]!;
          cellSeconds += seconds[j]!;
          if (
            j === final ||
            cellAlong >= cellStepM ||
            Math.abs(heightAt(j) - cellFt) >= cellHeightStepFt
          ) {
            // Into the cell it starts in, over as many metres as it spans;
            // one of no heat is not busy at all
            if (cellSeconds > 0) {
              const at = cells.at(
                Math.floor(cellX / cell),
                Math.floor(cellY / cell),
              );
              const heats = cells.sums();
              heats[at] =
                heats[at]! +
                Math.max(cellSeconds, MIN_HEAT_S) / Math.max(cellAlong, cellM);
            }
            [cellX, cellY] = mercatorOf(points[j]!);
            cellFt = heightAt(j);
            cellAlong = 0;
            cellSeconds = 0;
          }
        }
        if (
          j === final ||
          along >= stepM ||
          Math.abs(heightAt(j) - keptFt) >= heightStepFt
        ) {
          // The heat of the step goes on the point it starts from
          step(j, heat > 0 ? Math.max(heat, MIN_HEAT_S) : 0, along);
          keptFt = heightAt(j);
          along = 0;
          heat = 0;
        }
      }
      if (merging) flush();
    }
    i = end;
  }
  const busy = cells?.sums().subarray(0, cells.count());
  const most = !busy
    ? busiest!
    : busy.length > 0
      ? nthSmallest(
          busy,
          Math.floor(CLOUD_BUSIEST_PERCENTILE * (busy.length - 1)),
        )
      : 0;
  // The marks of the stretches written, in cells of the level cut for, and
  // the roll-off of their heat: the flights' worth drawn of a second in a
  // cell, a cruise crossing it taking its width at CRUISE_SPEED_MS
  const markCell = CLOUD_CELL_PX / worldPx;
  markStretches(
    values,
    CLOUD_POINT_FLOATS,
    HEAT_FLOAT,
    MARKS_FLOAT,
    markCell,
    scaleOf
      ? (scaleOf(most) * CRUISE_SPEED_MS) / (markCell * EARTH_CIRCUMFERENCE_M)
      : 0,
  );
  const origin: [number, number] =
    values.length > 0 ? [(west + east) / 2, (north + south) / 2] : [0.5, 0.5];
  const points = new Float32Array(values.length + 2 * CLOUD_POINT_FLOATS);
  points.set(values, CLOUD_POINT_FLOATS);
  for (let k = 0; k < values.length; k += CLOUD_POINT_FLOATS) {
    points[k + CLOUD_POINT_FLOATS] = values[k]! - origin[0];
    points[k + CLOUD_POINT_FLOATS + 1] = values[k + 1]! - origin[1];
  }
  return {
    points,
    count: values.length / CLOUD_POINT_FLOATS,
    origin,
    xs: values.length > 0 ? [west, east] : [0.5, 0.5],
    busiest: most,
  };
}

/**
 * The value that would be at `n` (from 0) of `values` sorted, which it
 * reorders: Hoare's selection, since sorting every cell of the cloud for
 * one of them was a third of the work of cloudPoints
 */
export function nthSmallest(values: Float64Array, n: number): number {
  let low = 0;
  let high = values.length - 1;
  while (low < high) {
    const pivot = values[(low + high) >>> 1]!;
    let i = low;
    let j = high;
    while (i <= j) {
      while (values[i]! < pivot) i++;
      while (values[j]! > pivot) j--;
      if (i <= j) {
        const swap = values[i]!;
        values[i++] = values[j]!;
        values[j--] = swap;
      }
    }
    // Below j none is greater than the pivot, from i none is less, and
    // between the two all are the pivot
    if (n <= j) high = j;
    else if (n >= i) low = i;
    else return pivot;
  }
  return values[n]!;
}
