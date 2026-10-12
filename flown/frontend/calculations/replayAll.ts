/**
 * The flights of the replay of all flights (ui/replayAll.ts) as the points its
 * layer draws (ui/replayAllLayer.ts): every flight's curve, uploaded once with
 * the seconds into its flight at each point (flightClock.ts), so a frame only
 * tells the layer the time. Played one after another (the intro of a share
 * link, ui/shareIntro.ts), each flight's seconds start where the one
 * before has landed (sequenceStarts). The curves and their heights are the
 * ones the ribbons and the heat cloud are cut from (groundedFlights), thinned
 * as the heat cloud thins them, a little closer (REPLAY_ALL_STEP_PX): a year
 * of flights is some 150,000 points, which a phone cannot draw every frame,
 * and a few thousand zoomed out.
 */
import type { PathSegment } from "../types";
import {
  DEGREES_TO_RADIANS,
  focalLengthPx,
  metresPerPixel,
  planarMetres,
  TILE_SIZE_PX,
} from "../utils/geometry";
import {
  lngLatOfMercator,
  mercatorOf,
  mercatorX,
  mercatorY,
} from "../utils/mercator";
import { FEET_TO_METERS } from "../utils/constants";
import { chainPieces, type FlightClock } from "./flightClock";
import { heatWeight } from "./heatLines";
import { liftExaggeration } from "./lift";
import type { SmoothedFlights, SmoothedLine } from "./smoothing";

/**
 * The points of a flight's curve are kept this many pixels apart at most,
 * at the middle of the zoom level they are cut for; closer ones are merged
 * into the stretch between the ones kept, and the airplane moves along
 * that stretch in the time of all of them. A trail is narrower than the
 * cloud's glow, so it keeps its points closer.
 */
const REPLAY_ALL_STEP_PX = 4;

/** A point is kept as well where the height has changed by this many pixels */
const HEIGHT_STEP_PX = 1;

/** A flight shorter than this has no clock to play by, and sits out */
const MIN_FLIGHT_S = 1;

/**
 * Seconds of the clock between the landing of one flight and the start of
 * the next where they play one after another (see sequenceStarts): a
 * second and a half at 200 times their speed. Never the time the aircraft
 * stood on the ground, which would say how the day went.
 */
export const LEG_PAUSE_S = 300;

/**
 * Where on one clock each of the flights `pathIds` starts when they play
 * one after another in the order given, by the seconds each takes,
 * `duration` (see FlightClock): the first at 0, and each after the one
 * before has landed and LEG_PAUSE_S have passed. A flight shorter than
 * MIN_FLIGHT_S has no clock to play by, and is left out.
 */
export function sequenceStarts(
  pathIds: Iterable<number>,
  duration: ReadonlyMap<number, number>,
): Map<number, number> {
  const starts = new Map<number, number>();
  let at = 0;
  for (const pathId of pathIds) {
    const seconds = duration.get(pathId) ?? 0;
    if (seconds < MIN_FLIGHT_S || starts.has(pathId)) continue;
    starts.set(pathId, at);
    at += seconds + LEG_PAUSE_S;
  }
  return starts;
}

/**
 * The floats of a point: x, y, ground, lift, the seconds into its flight,
 * 1 where the stretch to the next point is drawn (0 at the last point of a
 * curve), and the colour of the stretch up to it (see replayAllPoints)
 */
export const REPLAY_ALL_POINT_FLOATS = 7;

/** The points of the replay of all flights, see replayAllPoints */
export interface ReplayAllPoints {
  /**
   * `REPLAY_ALL_POINT_FLOATS` floats per point, one curve after the other:
   * x and y in Mercator units from `origin`, the ground under the point
   * and the height above it in feet (as for the heat cloud, see
   * CloudPoints), the seconds into its flight (on the clock of the run,
   * see sequenceStarts), whether it joins the next point, and the colour
   * of the stretch that ends at it
   */
  points: Float32Array;
  /** The number of points */
  count: number;
  /** The Mercator point the points are given from */
  origin: readonly [number, number];
  /** The Mercator x of the westernmost and easternmost point, unwrapped */
  xs: readonly [number, number];
  /**
   * When the last flight has landed: the seconds of the longest, or of
   * all of them one after another
   */
  duration: number;
  /** The flights among the points */
  flights: number;
  /** West, south, east and north of the points in degrees, null for none */
  bounds: [number, number, number, number] | null;
}

/**
 * The whole worlds (in degrees) to move each curve by that starts at the
 * longitude of `starts`, so they lie together: each start into the 360
 * degrees from the one after the widest gap between them round the world.
 * Flights either side of the antimeridian lay a world apart, unwrapped
 * each on its own, and their bounds were the whole world; moved to start
 * near the first flight they stayed apart where it was far from them.
 */
export function worldShifts(starts: readonly number[]): number[] {
  if (starts.length === 0) return [];
  const wrapped = starts.map(
    (lng) => lng - 360 * Math.floor((lng + 180) / 360),
  );
  const sorted = [...wrapped].sort((a, b) => a - b);
  // From the last round to the first, then between each and the next
  let gap = sorted[0]! + 360 - sorted[sorted.length - 1]!;
  let from = sorted[0]!;
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k]! - sorted[k - 1]! > gap) {
      gap = sorted[k]! - sorted[k - 1]!;
      from = sorted[k]!;
    }
  }
  return starts.map((lng) => -360 * Math.floor((lng - from) / 360) || 0);
}

/**
 * The points of the flights `keep` accepts, along their curves `flights`
 * (see groundedFlights) with the clock `clock` of their segments. A point
 * of a curve is kept where it is REPLAY_ALL_STEP_PX on from the last one
 * kept at the middle of the zoom level `detail`, where its height has
 * changed by HEIGHT_STEP_PX as exaggerated at the relief level `level`,
 * and at either end of a curve. A flight whose clock is shorter than
 * MIN_FLIGHT_S (no times and no speeds) sits out. With `starts`, each
 * flight's clock begins where it gives (see sequenceStarts) rather than
 * at 0, so the flights play one after another. With `colourOf`, each point
 * carries the colour of the segment the stretch up to it lies along, its
 * red, green and blue bytes in one number (`(r << 16) | (g << 8) | b`,
 * which a float holds exactly), and 0 without, for the trail's own; a
 * negative colour is that of a stretch the trail leaves out.
 */
export function replayAllPoints(
  segments: readonly PathSegment[],
  flights: SmoothedFlights,
  clock: FlightClock,
  keep: (pathId: number) => boolean,
  detail: number,
  level: number,
  starts?: ReadonlyMap<number, number>,
  colourOf?: (segment: PathSegment) => number,
): ReplayAllPoints {
  const exaggeration = liftExaggeration(level);
  // The points are picked first, and the bounds with them, which the
  // origin is taken from; then they are written straight into the array
  // the layer is given. The index into its curve of every point kept,
  // curve after curve, and each curve with the end of its points in it.
  const kept: number[] = [];
  // Each curve with its box, as it is unwrapped on its own (see
  // smoothFlights): moved by whole worlds below (see worldShifts)
  const curves: {
    line: SmoothedLine;
    times: Float64Array;
    /** The colour of the stretch up to each point (see colourOf) */
    colours: number[];
    /** When its flight starts on the clock of the run */
    start: number;
    end: number;
    box: [west: number, south: number, east: number, north: number];
    shift: number;
  }[] = [];
  const played = new Set<number>();
  let duration = 0;
  const { chains, chainOf, from, to } = flights;
  const count = segments.length;
  let i = 0;
  while (i < count) {
    let end = i + 1;
    while (end < count && chainOf[end] === chainOf[i]) end++;
    const chain = chains[chainOf[i]!];
    const pathId = segments[i]!.path_id;
    const seconds = clock.duration.get(pathId) ?? 0;
    if (
      chain &&
      chain.points.length > 1 &&
      seconds >= MIN_FLIGHT_S &&
      keep(pathId)
    ) {
      played.add(pathId);
      const start = starts?.get(pathId) ?? 0;
      duration = Math.max(duration, start + seconds);
      const { points, heights, ground } = chain;
      // Weighed as the heat cloud weighs them, which keeps one weighing of
      // the curve for both: the times are the same for every weighing
      const { times } = chainPieces(
        segments,
        flights,
        i,
        end,
        clock,
        heatWeight,
      );
      const pixelM =
        metresPerPixel(detail + 0.5) *
        Math.cos(points[0]![0] * DEGREES_TO_RADIANS);
      const stepM = REPLAY_ALL_STEP_PX * pixelM;
      const heightStepFt =
        (HEIGHT_STEP_PX * pixelM) / exaggeration / FEET_TO_METERS;
      const heightAt = (j: number): number => (ground?.[j] ?? 0) + heights[j]!;
      // The pieces of a segment end at its points after its first, and the
      // first point of the curve takes the first segment's
      const colours: number[] = [];
      for (let m = i; colourOf && m < end; m++) {
        const colour = colourOf(segments[m]!);
        for (let j = from[m]! + (m > i ? 1 : 0); j <= to[m]!; j++) {
          colours[j] = colour;
        }
      }
      let keptFt = heightAt(0);
      let along = 0;
      const box: [number, number, number, number] = [
        Infinity,
        Infinity,
        -Infinity,
        -Infinity,
      ];
      const pick = (j: number): void => {
        const [lat, lng] = points[j]!;
        box[0] = Math.min(box[0], lng);
        box[1] = Math.min(box[1], lat);
        box[2] = Math.max(box[2], lng);
        box[3] = Math.max(box[3], lat);
        kept.push(j);
        keptFt = heightAt(j);
      };
      pick(0);
      const last = points.length - 1;
      for (let j = 1; j <= last; j++) {
        along += planarMetres(points[j - 1]!, points[j]!);
        if (
          j === last ||
          along >= stepM ||
          Math.abs(heightAt(j) - keptFt) >= heightStepFt
        ) {
          pick(j);
          along = 0;
        }
      }
      curves.push({
        line: chain,
        times,
        colours,
        start,
        end: kept.length,
        box,
        shift: 0,
      });
    }
    i = end;
  }
  const shifts = worldShifts(curves.map(({ line }) => line.points[0]![1]));
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  curves.forEach((curve, c) => {
    const shift = (curve.shift = shifts[c]!);
    west = Math.min(west, curve.box[0] + shift);
    south = Math.min(south, curve.box[1]);
    east = Math.max(east, curve.box[2] + shift);
    north = Math.max(north, curve.box[3]);
  });
  const size = REPLAY_ALL_POINT_FLOATS;
  const total = kept.length;
  let origin: [number, number] = [0.5, 0.5];
  if (total > 0) {
    const [x0, y0] = mercatorOf([north, west]);
    const [x1, y1] = mercatorOf([south, east]);
    origin = [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  const points = new Float32Array(total * size);
  let n = 0;
  for (const { line, times, colours, start, end, shift } of curves) {
    const { ground, heights } = line;
    // Every point joins the next but the last of its curve
    for (; n < end; n++) {
      const j = kept[n]!;
      const [lat, lng] = line.points[j]!;
      const k = n * size;
      points[k] = mercatorX(lng + shift) - origin[0];
      points[k + 1] = mercatorY(lat) - origin[1];
      points[k + 2] = ground?.[j] ?? 0;
      points[k + 3] = heights[j]!;
      points[k + 4] = start + times[j]!;
      points[k + 5] = n < end - 1 ? 1 : 0;
      points[k + 6] = colours[j] ?? 0;
    }
  }
  return {
    points,
    count: total,
    origin,
    xs: total > 0 ? [mercatorX(west), mercatorX(east)] : [0.5, 0.5],
    duration,
    flights: played.size,
    bounds: total > 0 ? [west, south, east, north] : null,
  };
}

/** What a fit measures of the flights, see fitTilted and fixPoints */
export type FitPoints = Pick<ReplayAllPoints, "points" | "count" | "origin">;

/**
 * Both ends of every one of `segments`, where they are, as the points of a
 * run for a fit of them (see fitTilted): the curves of a run are thinned
 * for the zoom they were cut for, and cut for a map far out, a point every
 * 18 km or so, they cut the turn of a short flight short of the frame.
 * Each fix is taken to the copy of the world nearest the one before: a
 * flight across the antimeridian lay a world apart on either side of it,
 * and the fit of it was the whole world.
 */
export function fixPoints(segments: readonly PathSegment[]): FitPoints {
  const count = segments.length * 2;
  const points = new Float32Array(count * REPLAY_ALL_POINT_FLOATS);
  const first = segments[0]?.coords[0];
  const origin = first ? mercatorOf(first) : ([0, 0] as [number, number]);
  let k = 0;
  let x = 0;
  for (const { coords } of segments) {
    for (const fix of coords) {
      const [fx, fy] = mercatorOf(fix);
      x = fx - origin[0] - Math.round(fx - origin[0] - x);
      points[k] = x;
      points[k + 1] = fy - origin[1];
      k += REPLAY_ALL_POINT_FLOATS;
    }
  }
  return { points, count, origin };
}

/** A camera of the fit of the flights: its centre, `[lng, lat]`, and zoom */
export interface FitCamera {
  center: [number, number];
  zoom: number;
}

/**
 * The map a fit is for: its size in pixels, the pixels kept free along
 * each edge, its tilt and its vertical field of view in degrees, and the
 * compass direction that is up, north (0) by default
 */
export interface FitMap {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
  pitch: number;
  fov: number;
  bearing?: number;
}

/** How often the fit measures the flights on the screen and moves */
const FIT_ROUNDS = 4;

/**
 * The most a round of the fit zooms in or out, in levels: a flight behind
 * the camera of a steep tilt has no pixel, and the next round measures
 * from closer to where they fit
 */
const FIT_STEP_ZOOM = 2;

/**
 * The camera, from `camera` on, that shows the flights `run` as large as
 * the room of `map` within its padding allows. A fit of their bounds in a
 * tilted view left them small in the middle of it, the far part of the map
 * empty: it fits the corners of the bounds, which the tilt spreads, rather
 * than the flights. Each round measures their points on the screen of the
 * camera, as MapLibre draws the flat map in Mercator (the camera
 * looks at the middle of the map from the distance its field of view puts
 * it at, tilted towards the top of the screen, which the bearing turns
 * from the north, and a point below the middle comes nearer and lower on
 * the screen; the globe is taken for the flat map),
 * moves their middle to the middle of the room and zooms by how much more
 * room there is. The tilt makes the next measure differ a little, and
 * FIT_ROUNDS fill the room to a hundredth. No closer in than `maxZoom`.
 */
export function fitTilted(
  run: FitPoints,
  camera: FitCamera,
  map: FitMap,
  maxZoom: number,
): FitCamera {
  const { points, count, origin } = run;
  const { width, height, padding } = map;
  const across = width - padding.left - padding.right;
  const down = height - padding.top - padding.bottom;
  if (count === 0 || across <= 0 || down <= 0) return camera;
  const distance = focalLengthPx(height, map.fov * DEGREES_TO_RADIANS);
  const sin = Math.sin(map.pitch * DEGREES_TO_RADIANS);
  const cos = Math.cos(map.pitch * DEGREES_TO_RADIANS);
  // The bearing turns the map under the camera: what is east and south of
  // the middle is that far right of it and below it on a map north up
  const turn = (map.bearing ?? 0) * DEGREES_TO_RADIANS;
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  // The centre in Mercator units from the origin of the points, on the
  // copy of the world they lie on: across the antimeridian the centre of
  // their bounds comes wrapped to the other side of it
  const [mx, my] = mercatorOf([camera.center[1], camera.center[0]]);
  let x = mx - origin[0];
  x -= Math.round(x);
  let y = my - origin[1];
  let zoom = camera.zoom;
  for (let round = 0; round < FIT_ROUNDS; round++) {
    const world = TILE_SIZE_PX * 2 ** zoom;
    // Left, top, right and bottom, in pixels from the middle of the map
    let [left, top, right, bottom] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let k = 0; k < points.length; k += REPLAY_ALL_POINT_FLOATS) {
      const east = (points[k]! - x) * world;
      const down = (points[k + 1]! - y) * world;
      // How far below the middle of the screen it lies on the ground
      const south = down * c - east * s;
      const depth = distance - south * sin;
      // Behind the camera, or level with it: further out, where it comes
      // into view
      if (depth <= 0) top = -Infinity;
      const scale = distance / depth;
      const px = (east * c + down * s) * scale;
      const py = south * cos * scale;
      left = Math.min(left, px);
      right = Math.max(right, px);
      top = Math.min(top, py);
      bottom = Math.max(bottom, py);
    }
    const scale = Math.min(across / (right - left), down / (bottom - top));
    // Their middle, from where it is to the middle of the room
    const dx = (left + right - across + width) / 2 - padding.left;
    const dy = (top + bottom - down + height) / 2 - padding.top;
    const south = (dy * distance) / (distance * cos + dy * sin);
    if (top > -Infinity) {
      // Right of the middle and below it on the ground, turned back
      const right = (dx * (distance - south * sin)) / distance;
      x += (right * c - south * s) / world;
      y += (right * s + south * c) / world;
    }
    zoom = Math.min(
      zoom +
        Math.min(Math.max(Math.log2(scale), -FIT_STEP_ZOOM), FIT_STEP_ZOOM),
      maxZoom,
    );
  }
  return {
    center: lngLatOfMercator(x + origin[0], y + origin[1]),
    zoom,
  };
}
