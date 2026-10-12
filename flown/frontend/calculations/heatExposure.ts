/**
 * How far the heat of the flat heatmap is scaled and rolled off before it is
 * drawn (heatExposure, exposedHeat), and the reference of the heatmap's
 * kernel that both the exposure and the paint of ui/heatmapPaint.ts are
 * tuned for.
 *
 * It lives apart from the paint because the year worker (services/
 * heatSource.ts) works the exposure out, off the main thread, and the
 * worker's bundle should carry no MapLibre expressions. The heat of a
 * source travels as one flat column of `[lat, lng, heat]` per point (see
 * heatColumns), which is handed to the worker as it is.
 */
import { DEGREES_TO_RADIANS, type Coordinate } from "../utils/geometry";
import { heatTone } from "./heatTone";

/**
 * The reach HEATMAP_REFERENCE_INTENSITY is chosen for. The ridge of a
 * track is as high as its kernel is wide (a sum along it of the kernels
 * of its fixes, each as high at its middle whatever its reach), so a
 * narrower reach takes as much more intensity (see intensityAt in
 * ui/heatmapPaint.ts).
 */
export const HEATMAP_REFERENCE_RADIUS_PX = 22;
/**
 * The zoom at which the fixes of a track (a few hundred metres apart) are
 * about one radius apart on screen, and the intensity a point of the
 * reference reach has there. With the radius above it puts the ridge of a
 * single track at a density of about 0.015, which the gradient draws in
 * blue (see HEATMAP_GRADIENT in ui/heatmapPaint.ts).
 */
export const HEATMAP_REFERENCE_ZOOM = 12;
export const HEATMAP_REFERENCE_INTENSITY = 0.0375;

/**
 * The density the ridge of a lone cruise is drawn at unscaled (see
 * heatExposure), the third stop of the heatmap's gradient, which
 * HEATMAP_REFERENCE_INTENSITY is chosen for (heatScale.test.ts holds the
 * two together): a flight's worth of heat (see ui/heatScale.ts)
 */
export const HEAT_FLIGHT_DENSITY = 0.015;

/**
 * Adaptive exposure: the heat of a year of flights, of one aircraft or of
 * one isolated flight is drawn so that its busiest places come out alike.
 * The heat is added up in a grid whose cells are two standard deviations
 * of the kernel of a point of the reference reach (a third of it) wide at
 * EXPOSURE_ZOOM, a region of a few airfields, counted at the intensity of
 * that reach (EXPOSURE_INTENSITY: the narrower reach the heatmap draws
 * with there does not change the exposure), and scaled so that the cell at
 * EXPOSURE_PERCENTILE of those with any heat reaches EXPOSURE_DENSITY, a
 * light cyan: the busiest routes and circuits, with the airfields white
 * beyond them. That is about where all the sample flights are drawn
 * unscaled, and a year of them came out far fainter. However few cells
 * there are, the EXPOSURE_TOP_CELLS busiest stay beyond it: a lone flight
 * has few, and its 99th percentile was the airfields it stood and taxied
 * on, which scaled to cyan left a quarter of the sample flights fainter
 * than unscaled. A lone flight comes
 * out as brightly as its routes do in a year of them instead of as a faint
 * trace, and a logbook of many years does not wash out to white. Within
 * EXPOSURE_RANGE: a single short flight is not lit like a year, nor a
 * hundred years dimmed to nothing.
 *
 * The heat itself is scaled, rather than the paint: the points' weights,
 * which leaves the least a point contributes where it was (see
 * heatmapWeight in ui/heatmapPaint.ts), and the heat of the lines the
 * heatmap hands over to, so they take over in the colours it had.
 */
const EXPOSURE_ZOOM = 10;
const EXPOSURE_PERCENTILE = 0.99;
const EXPOSURE_DENSITY = 0.15;
const EXPOSURE_TOP_CELLS = 4;
const EXPOSURE_RANGE = [0.25, 3] as const;
const EXPOSURE_INTENSITY =
  HEATMAP_REFERENCE_INTENSITY / 2 ** (HEATMAP_REFERENCE_ZOOM - EXPOSURE_ZOOM);
/**
 * The mean density over a cell two standard deviations wide of the heat in
 * it, per unit of weight times intensity: a kernel (MapLibre's Gaussian,
 * peak 1 / sqrt(2 pi)) holds 2 pi sigma^2 / sqrt(2 pi) of density in all,
 * spread over (2 sigma)^2
 */
const DENSITY_PER_CELL_WEIGHT = Math.sqrt(2 * Math.PI) / 4;

/**
 * The heat of `points`, each weighing `weights` of the same index (see
 * heatmapPoints in ui/dataManager.ts), as one column: `[lat, lng, heat]`
 * per point, one after the other. That is what the year worker is handed.
 */
export function heatColumns(
  points: readonly Coordinate[],
  weights: ArrayLike<number>,
): Float64Array {
  const columns = new Float64Array(points.length * 3);
  points.forEach(([lat, lng], index) => {
    columns[3 * index] = lat;
    columns[3 * index + 1] = lng;
    columns[3 * index + 2] = weights[index]!;
  });
  return columns;
}

/**
 * The heat of `heat` (see heatColumns) added up in the cells of the
 * exposure: the key of the cell of each point, and the heat of each cell
 */
function exposureCells(heat: Float64Array): {
  keys: Float64Array;
  cells: Map<number, number>;
} {
  // In degrees of longitude, and of the Mercator latitude in the same unit
  const cell =
    (720 * HEATMAP_REFERENCE_RADIUS_PX) / 3 / (512 * 2 ** EXPOSURE_ZOOM);
  const cells = new Map<number, number>();
  const keys = new Float64Array(heat.length / 3);
  for (let index = 0; index < keys.length; index++) {
    const lat = heat[3 * index]!;
    const lng = heat[3 * index + 1]!;
    const y = Math.atanh(Math.sin(lat * DEGREES_TO_RADIANS));
    // A key the engine keeps as a small integer: a row holds fewer than
    // 2^15 columns either side of the meridian
    const key =
      Math.floor(y / DEGREES_TO_RADIANS / cell) * 2 ** 16 +
      Math.floor(lng / cell);
    cells.set(key, (cells.get(key) ?? 0) + heat[3 * index + 2]!);
    keys[index] = key;
  }
  return { keys, cells };
}

/** The exposure of heat of `cells` (see exposureCells) */
function exposureOf(cells: Map<number, number>): number {
  const sums = Float64Array.from(cells.values()).sort();
  const rank = Math.min(
    Math.floor((sums.length - 1) * EXPOSURE_PERCENTILE),
    sums.length - 1 - EXPOSURE_TOP_CELLS,
  );
  const busy =
    (sums[Math.max(rank, 0)] ?? 0) *
    EXPOSURE_INTENSITY *
    DENSITY_PER_CELL_WEIGHT;
  return busy > 0
    ? Math.min(
        Math.max(EXPOSURE_DENSITY / busy, EXPOSURE_RANGE[0]),
        EXPOSURE_RANGE[1],
      )
    : 1;
}

/**
 * The exposure of the heat of `heat` (see heatColumns): what the heat is
 * scaled by, 1 for no heat at all
 */
export function heatExposure(heat: Float64Array): number {
  return exposureOf(exposureCells(heat).cells);
}

/**
 * The heat of `heat` (see heatColumns) as the heatmap draws it: its
 * exposure (see heatExposure), and the weights scaled by it and rolled off
 * (see heatTone) by the heat of the cell of the exposure each point is in,
 * its mean density there in flights' worth. The busiest cells, a circuit
 * flown hundreds of times, are drawn at the few flights' worth their heat
 * rolls off to, and the points in them as much fainter; a cell up to the
 * knee keeps its heat, and within a cell every point keeps its share of
 * it, so the downwind, the base, the final and the runway of a circuit
 * keep their steps. The cells are about as wide as the reach of a point in
 * a region, so the roll-off changes from one to the next about as
 * gradually as the heat itself.
 */
export function exposedHeat(heat: Float64Array): {
  exposure: number;
  weights: Float64Array;
} {
  const { keys, cells } = exposureCells(heat);
  const exposure = exposureOf(cells);
  const perFlight =
    (exposure * EXPOSURE_INTENSITY * DENSITY_PER_CELL_WEIGHT) /
    HEAT_FLIGHT_DENSITY;
  const weights = new Float64Array(keys.length);
  for (let index = 0; index < keys.length; index++) {
    const drawn = cells.get(keys[index]!)! * perFlight;
    weights[index] =
      heat[3 * index + 2]! * exposure * (heatTone(drawn) / drawn);
  }
  return { exposure, weights };
}
