/**
 * The ribbons of the 3D view: a flight's smoothed curve (smoothing.ts) cut
 * into quads a few pixels wide, in pieces of one height each, and what the
 * feature of a piece carries for the paint that lifts it (ribbonPaint.ts).
 */
import {
  DEGREES_TO_RADIANS,
  METRES_PER_DEGREE,
  metresPerPixel,
  planarMetres,
  turnOf,
  type Coordinate,
} from "../utils/geometry";
import { FEET_TO_METERS } from "../utils/constants";
import {
  GROUND_LEVELS,
  groundKey,
  LIFT_STEP_FT,
  liftExaggeration,
  reliefLevel,
  ribbonId,
  switchesExaggeration,
} from "./lift";
import type { SmoothedFlights, SmoothedLine } from "./smoothing";

/**
 * How wide a ribbon is drawn, in pixels, about as wide as a flight's line.
 * Its width is part of its geometry, which the map cannot scale by zoom, so
 * the flights are cut again for every whole zoom level (see
 * ribbonWidthZoom), and this is the width in the middle of the level: 2 to
 * 4 pixels across it. A ribbon of fixed metres would be a hairline zoomed
 * out, which is all but gone seen from straight above, and gaps where the
 * flight runs towards the camera and its walls are seen edge on.
 */
const RIBBON_WIDTH_PX = 3;

/**
 * The finest step the ground offsets are rounded to, in feet: the ground
 * is written in steps of 10 ft (GROUND_STEP in segment_codec.py)
 */
const GROUND_OFFSET_STEP_FT = 10;

/**
 * The step the ground offsets of ribbons cut at the zoom `widthZoom` (see
 * ribbonWidthZoom) are rounded to, in feet: GROUND_OFFSET_STEP_FT, doubled
 * as long as it stays at most a quarter of a pixel in the middle of the
 * level, exaggerated as the level is. Rounding moves a ribbon by an eighth
 * of a pixel at most then, a quarter on the tiles of the next level in, and
 * over flat land most offsets round to nothing and are left out of the
 * features (see ribbonProperties), of which the map's worker holds hundreds
 * of thousands.
 */
export function groundOffsetStepFt(widthZoom: number): number {
  const quarterPxFt =
    metresPerPixel(widthZoom + 0.5) /
    4 /
    liftExaggeration(reliefLevel(widthZoom)) /
    FEET_TO_METERS;
  let step = GROUND_OFFSET_STEP_FT;
  while (step * 2 <= quarterPxFt) step *= 2;
  return step;
}

/**
 * The unit normal (to the left) of the segment from `a` to `b`, in metres
 * with `metresPerLng` to a degree of longitude; null for none
 */
function normalOf(
  a: Readonly<Coordinate> | undefined,
  b: Readonly<Coordinate> | undefined,
  metresPerLng: number,
): [number, number] | null {
  if (!a || !b) return null;
  const dx = (b[1] - a[1]) * metresPerLng;
  const dy = (b[0] - a[0]) * METRES_PER_DEGREE;
  const length = Math.hypot(dx, dy);
  return length > 0 ? [-dy / length, dx / length] : null;
}

/** The point `t` of the way from `a` to `b` */
function lerp(a: number[], b: number[], t: number): number[] {
  return [a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t];
}

/** How far a mitred corner may reach out, in ribbon half widths */
const MITER_LIMIT = 3;

/**
 * The two edges of a ribbon along a line of `[lat, lng]` points, as `[lng,
 * lat]`: every point moved half of RIBBON_WIDTH_PX to the left and to the right
 * of the line, at the zoom `widthZoom` (see ribbonWidthZoom). At a bend the
 * offset follows the bisector of the two segments, lengthened so the edges stay
 * parallel to both (a mitred join), and capped at MITER_LIMIT half widths for a
 * hairpin. `before` and `after` are the points the line continues from and to,
 * outside it: a ribbon cut into features at its height steps then joins its
 * neighbours without a gap.
 */
function ribbonEdges(
  points: readonly Coordinate[],
  widthZoom: number,
  before?: Coordinate,
  after?: Coordinate,
): { left: number[][]; right: number[][] } {
  // At the middle of the level, and in metres on the ground at the
  // equator: Mercator draws them larger by as much as it shrinks a degree
  // of longitude, so a ribbon is as many pixels wide at every latitude
  const halfWidth = (RIBBON_WIDTH_PX / 2) * metresPerPixel(widthZoom + 0.5);
  const all = [
    ...(before ? [before] : []),
    ...points,
    ...(after ? [after] : []),
  ];
  const first = before ? 1 : 0;
  const left: number[][] = [];
  const right: number[][] = [];
  for (let i = first; i < first + points.length; i++) {
    const [lat, lng] = all[i]!;
    const metresPerLng = METRES_PER_DEGREE * Math.cos(lat * DEGREES_TO_RADIANS);
    const incoming = normalOf(all[i - 1], all[i], metresPerLng);
    const outgoing = normalOf(all[i], all[i + 1], metresPerLng);
    let offset: [number, number] = incoming ?? outgoing ?? [0, 0];
    let scale = 1;
    if (incoming && outgoing) {
      const sum: [number, number] = [
        incoming[0] + outgoing[0],
        incoming[1] + outgoing[1],
      ];
      const length = Math.hypot(sum[0], sum[1]);
      if (length > 1e-9) {
        offset = [sum[0] / length, sum[1] / length];
        // The bisector is shorter across the ribbon than either normal
        const cos = offset[0] * incoming[0] + offset[1] * incoming[1];
        scale = Math.min(1 / Math.max(cos, 1e-9), MITER_LIMIT);
      } else {
        // Straight back the way it came: no corner to mitre
        offset = outgoing;
      }
    }
    const reach = halfWidth * Math.cos(lat * DEGREES_TO_RADIANS) * scale;
    const dLng = (offset[0] * reach) / metresPerLng;
    const dLat = (offset[1] * reach) / METRES_PER_DEGREE;
    left.push([lng + dLng, lat + dLat]);
    right.push([lng - dLng, lat - dLat]);
  }
  return { left, right };
}

/**
 * How a ribbon is cut: pieces `stepFt` apart in height, of heights that
 * span at most `spanFt` (see ribbonPieces), and for the screen (see
 * screenCut) the metres of a pixel, `pixelM`
 */
export interface RibbonCut {
  stepFt: number;
  spanFt: number;
  pixelM: number;
}

/** Every point of the curve, pieces a LIFT_STEP_FT apart of one height */
const EXACT_CUT: RibbonCut = { stepFt: LIFT_STEP_FT, spanFt: 0, pixelM: 0 };

/**
 * A ribbon cut for the screen (see screenCut) turns at a point after
 * QUAD_MIN_PX, when its way has turned by TURN_DEG, and goes straight for
 * QUAD_MAX_PX at most, in pixels in the middle of its level; a height is
 * moved by STEP_MAX_PX at most
 */
const QUAD_MIN_PX = 1.5;
const QUAD_MAX_PX = 16;
const TURN_DEG = 10;
const STEP_MAX_PX = 1;

/**
 * The longest quad of a ribbon cut for the screen, where its points are
 * further apart than QUAD_MAX_PX: MapLibre lifts a quad by the relief at
 * its middle, and one that reaches past the buffer of a tile would be cut
 * at its edge and stand on other relief on either side (see addRibbons)
 */
const QUAD_SPLIT_PX = 24;

/**
 * The cut of the ribbons of the colour layers at the zoom `widthZoom` (see
 * ribbonWidthZoom) and the latitude `lat`, for the pixels on the screen
 * rather than for the data (see keptPoints): pieces LIFT_STEP_FT apart,
 * doubled as long as a step stays within STEP_MAX_PX, of heights that span
 * one step. At the zoom of a whole country 99 % of the quads of the data
 * were under a pixel, and the pieces of a flight over the relief, whose
 * height above it never stays the same, were one per quad: 220,000
 * features of 1.3 million points for all years, which the map's worker
 * held at close to a gigabyte. Closer in than a step fits in STEP_MAX_PX
 * they are cut as the data has them.
 */
export function screenCut(widthZoom: number, lat: number): RibbonCut {
  const pixelM =
    metresPerPixel(widthZoom + 0.5) * Math.cos(lat * DEGREES_TO_RADIANS);
  const stepMaxFt =
    (STEP_MAX_PX * pixelM) /
    liftExaggeration(reliefLevel(widthZoom)) /
    FEET_TO_METERS;
  let stepFt = LIFT_STEP_FT;
  while (stepFt * 2 <= stepMaxFt) stepFt *= 2;
  return { stepFt, spanFt: stepFt <= stepMaxFt ? stepFt : 0, pixelM };
}

/** The points of a chain kept for a cut, see keptPoints */
const chainCuts = new WeakMap<
  SmoothedLine,
  { stepFt: number; pixelM: number; kept: Uint8Array }
>();

/**
 * Which points of a flight's curve a ribbon cut for the screen (`cut`)
 * goes through: its ends, and from the start on the next point where,
 * since the last one kept, its height or its ground has changed by a step
 * (the relief under a quad is the one of its middle), or it has gone
 * QUAD_MAX_PX, or QUAD_MIN_PX and turned by TURN_DEG. The ribbons of a
 * flight's runs go through the same points, and their neighbours' as
 * `before` and `after`, so they still meet corner to corner.
 */
function keptPoints(chain: SmoothedLine, cut: RibbonCut): Uint8Array {
  const { stepFt, pixelM } = cut;
  const held = chainCuts.get(chain);
  if (held?.stepFt === stepFt && held.pixelM === pixelM) return held.kept;
  const { points, heights, ground } = chain;
  const kept = new Uint8Array(points.length);
  kept[0] = kept[points.length - 1] = 1;
  // Degrees from east of the segment from the point `j` on
  const heading = (j: number): number => {
    const [lat, lng] = points[j]!;
    const [toLat, toLng] = points[j + 1]!;
    return (
      Math.atan2(
        toLat - lat,
        (toLng - lng) * Math.cos(lat * DEGREES_TO_RADIANS),
      ) / DEGREES_TO_RADIANS
    );
  };
  let along = 0;
  let turned = 0;
  // The range of the heights and of the ground since the last point kept
  let low = heights[0]!;
  let high = low;
  let lowGround = ground?.[0] ?? 0;
  let highGround = lowGround;
  for (let j = 1; j + 1 < points.length; j++) {
    along += planarMetres(points[j - 1]!, points[j]!) / pixelM;
    turned += Math.abs(turnOf(heading(j - 1), heading(j)));
    const height = heights[j]!;
    const under = ground?.[j] ?? 0;
    low = Math.min(low, height);
    high = Math.max(high, height);
    lowGround = Math.min(lowGround, under);
    highGround = Math.max(highGround, under);
    if (
      high - low >= stepFt ||
      highGround - lowGround >= stepFt ||
      along >= QUAD_MAX_PX ||
      (along >= QUAD_MIN_PX && turned >= TURN_DEG)
    ) {
      kept[j] = 1;
      along = turned = 0;
      low = high = height;
      lowGround = highGround = under;
    }
  }
  chainCuts.set(chain, { stepFt, pixelM, kept });
  return kept;
}

/**
 * The ribbon of the segments `start` to `end` (exclusive) of one flight,
 * cut from its smoothed curve: the neighbouring points of the curve on
 * either side are its `before` and `after`, so it meets the ribbons next to
 * it corner to corner. `forScreen` cuts it for the pixels of its zoom (see
 * screenCut), from the points keptPoints keeps.
 */
export function ribbonOf(
  smoothed: SmoothedFlights,
  start: number,
  end: number,
  widthZoom: number,
  forScreen = false,
): RibbonPiece[] {
  const chain = smoothed.chains[smoothed.chainOf[start]!];
  if (!chain) return [];
  const a = smoothed.from[start]!;
  const b = smoothed.to[end - 1]!;
  const { points, heights, offsets } = chain;
  if (!forScreen) {
    return ribbonPieces(
      points.slice(a, b + 1),
      heights.slice(a, b + 1),
      widthZoom,
      points[a - 1],
      points[b + 1],
      offsets?.map((level) => level.slice(a, b + 1)),
    );
  }
  const cut = screenCut(widthZoom, points[0]![0]);
  const kept = keptPoints(chain, cut);
  const at = [a];
  for (let j = a + 1; j < b; j++) if (kept[j]) at.push(j);
  at.push(b);
  let before = a - 1;
  while (before > 0 && !kept[before]) before--;
  let after = b + 1;
  while (after < points.length - 1 && !kept[after]) after++;
  const pick = <T>(values: readonly T[]): T[] => at.map((j) => values[j]!);
  return ribbonPieces(
    pick(points),
    pick(heights),
    widthZoom,
    points[before],
    points[after],
    offsets?.map(pick),
    cut,
  );
}

/** A piece of a ribbon: the quads it is made of, at one height step */
export interface RibbonPiece {
  /** Feet above the flight's ground: the height in the piece's middle */
  h: number;
  /**
   * The ground of the levels around the one of `h` in the piece's middle,
   * as offsets to it in the steps of groundOffsetStepFt, by level in the
   * order of GROUND_LEVELS; absent where the ground is the same at every
   * level
   */
  o?: number[];
  geometry: GeoJSON.MultiPolygon;
}

/**
 * The ribbon along a line of `[lat, lng]` points, climbing and descending
 * with it: `heights` are the feet above ground at each point, and between
 * two points the ribbon slopes from one to the other. A feature has one
 * height, so a sloping segment is cut into pieces a LIFT_STEP_FT apart, and
 * pieces of the same height that follow each other make one feature. The
 * quads share their corners (see ribbonEdges), so the ribbon runs on through
 * its bends and its climbs without a gap. See ribbonEdges for `widthZoom`,
 * `before` and `after`. `offsets` are the ground of the levels around the
 * one of `heights` at each point (see SmoothedLine), which each piece takes
 * along from its middle. `cut` sets the step, and how far the heights of
 * the pieces that make one feature may span (see screenCut): the feature
 * is drawn at the middle of them; cut for the screen, a quad is no longer
 * than QUAD_SPLIT_PX.
 */
export function ribbonPieces(
  points: readonly Coordinate[],
  heights: readonly number[],
  widthZoom: number,
  before?: Coordinate,
  after?: Coordinate,
  offsets?: readonly (readonly number[])[],
  { stepFt, spanFt, pixelM }: RibbonCut = EXACT_CUT,
): RibbonPiece[] {
  const { left, right } = ribbonEdges(points, widthZoom, before, after);
  const pieces: RibbonPiece[] = [];
  // The lowest and the highest height of the last piece
  let low = 0;
  let high = 0;
  const step = groundOffsetStepFt(widthZoom);
  for (let i = 0; i + 1 < points.length; i++) {
    const from = heights[i]!;
    const to = heights[i + 1]!;
    const count = Math.max(1, Math.ceil(Math.abs(to - from) / stepFt));
    // Cut for the screen, a piece is cut into quads of QUAD_SPLIT_PX at most
    const parts = Math.max(
      1,
      pixelM &&
        Math.ceil(
          planarMetres(points[i]!, points[i + 1]!) /
            pixelM /
            QUAD_SPLIT_PX /
            count,
        ),
    );
    for (let k = 0; k < count; k++) {
      const t0 = k / count;
      const t1 = (k + 1) / count;
      const h = from + ((to - from) * (k + 0.5)) / count;
      const o = offsets?.map((level) => {
        const offset =
          level[i]! + ((level[i + 1]! - level[i]!) * (k + 0.5)) / count;
        // Without a negative zero, which JSON writes as a zero anyway
        return Math.round(offset / step) * step || 0;
      });
      const quads: number[][][][] = [];
      for (let p = 0; p < parts; p++) {
        const start = t0 + ((t1 - t0) * p) / parts;
        const end = t0 + ((t1 - t0) * (p + 1)) / parts;
        const a = lerp(left[i]!, left[i + 1]!, start);
        const b = lerp(left[i]!, left[i + 1]!, end);
        const c = lerp(right[i]!, right[i + 1]!, end);
        const d = lerp(right[i]!, right[i + 1]!, start);
        quads.push([[a, b, c, d, a]]);
      }
      const last = pieces[pieces.length - 1];
      if (
        last &&
        Math.max(high, h) - Math.min(low, h) <= spanFt &&
        sameOffsets(last.o, o)
      ) {
        low = Math.min(low, h);
        high = Math.max(high, h);
        last.h = (low + high) / 2;
        last.geometry.coordinates.push(...quads);
      } else {
        low = high = h;
        pieces.push({
          h,
          ...(o && { o }),
          geometry: { type: "MultiPolygon", coordinates: quads },
        });
      }
    }
  }
  return pieces;
}

/** Whether two pieces stand on the same ground at every level */
function sameOffsets(
  a: readonly number[] | undefined,
  b: readonly number[] | undefined,
): boolean {
  return a === b || (!!a && !!b && a.every((offset, i) => offset === b[i]));
}

/** What a feature of a ribbon carries of its piece, see ribbonProperties */
export interface RibbonProperties {
  /** Feet above the ground of the level `l`, see RibbonPiece */
  h: number;
  /** The relief level the ribbon was cut for (see reliefLevel) */
  l: number;
  /**
   * The id the map knows the ribbon by (see ribbonId), where it switches
   * the exaggeration (see switchesExaggeration)
   */
  k?: number;
  /**
   * The ground of another level (see groundKey), where it is not the one
   * of `l`
   */
  [ground: `o${number}`]: number;
}

/**
 * The properties of the feature of a ribbon piece cut for the relief level
 * `level` in the `epoch`-th visit of a level: its height, the level, the id
 * where the map is to know the feature by one (see ribbonId), and the
 * ground of the levels around it where that is not the level's own: an
 * offset of zero is left out, and the paint takes a ground left out for the
 * one of the level (see ribbonHeights). Over flat land most pieces have
 * none.
 */
export function ribbonProperties(
  piece: RibbonPiece,
  level: number,
  epoch: number,
): RibbonProperties {
  const properties: RibbonProperties = {
    h: piece.h,
    l: level,
    ...(switchesExaggeration(level) && { k: ribbonId(level, epoch) }),
  };
  piece.o?.forEach((offset, k) => {
    if (offset !== 0) properties[groundKey(GROUND_LEVELS[k]!)] = offset;
  });
  return properties;
}
