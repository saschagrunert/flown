/**
 * View box - the part of the map the ribbons of the 3D view are cut for
 *
 * Zoomed in, a ribbon is cut into pieces for the pixels of its zoom level
 * (see screenCut), and the flights of a year come to tens of thousands of
 * them. Only those around the view are written then, and written again as
 * the view leaves that part: for the colour layers by the layer manager,
 * through ui/pathRibbons.ts, and by ui/selectionRibbons.ts for the lines
 * of a selection. It comes with the feature bundle, which cuts them.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import { FEET_TO_METERS } from "./constants";
import { DEGREES_TO_RADIANS, METRES_PER_DEGREE } from "./geometry";
import { liftExaggeration } from "../calculations/lift";

/** `[west, south, east, north]`, in degrees */
export type Box = readonly [number, number, number, number];

/**
 * The whole zoom level (see ribbonWidthZoom) from which the 3D view writes
 * only the ribbons around the view (see viewBox), app zoom 9: at app zoom
 * 12, 916 of the 205,000 ribbons of all years were in view
 */
export const CULL_FROM_ZOOM = 8;

/**
 * How far around the view the ribbons are written, in spans of the view:
 * a pan of a quarter of a view or a zoom out of about half a level writes
 * them again
 */
export const VIEW_SPARE = 0.25;

/**
 * How high a flight at `maxFt` may be drawn above its ground, in metres,
 * in the 3D view at the relief level `level`: no higher than its altitude
 */
export function ribbonsTopM(maxFt: number, level: number): number {
  return maxFt * FEET_TO_METERS * liftExaggeration(level);
}

/**
 * The part of the map a view of `map` may show ribbons of, and `spare`
 * spans of it around: the ground in view, which MapLibre draws no further
 * than the bounds of the view, and as far beyond as a ribbon `topM` metres
 * up as drawn reaches into view from outside it in a tilted view.
 */
export function viewBox(map: MapLibreMap, topM: number, spare: number): Box {
  const bounds = map.getBounds();
  const { lng: west, lat: south } = bounds.getSouthWest();
  const { lng: east, lat: north } = bounds.getNorthEast();
  const reach =
    (topM * Math.tan(map.getPitch() * DEGREES_TO_RADIANS)) / METRES_PER_DEGREE;
  const lat = reach + spare * (north - south);
  const lng =
    reach /
      Math.cos(Math.min(Math.max(-south, north), 85) * DEGREES_TO_RADIANS) +
    spare * (east - west);
  return [west - lng, south - lat, east + lng, north + lat];
}

/** Whether two boxes overlap, in any copy of the world */
export function overlaps(a: Box, b: Box): boolean {
  return (
    a[1] <= b[3] &&
    b[1] <= a[3] &&
    [-360, 0, 360].some((shift) => a[0] <= b[2] + shift && b[0] + shift <= a[2])
  );
}

/**
 * Whether the view `view` (see viewBox, without spare) reaches past an edge
 * of the part of the map `box` the ribbons were written for
 */
export function leavesBox(view: Box, box: Box): boolean {
  return view.some((edge, i) => (i < 2 ? edge < box[i]! : edge > box[i]!));
}
