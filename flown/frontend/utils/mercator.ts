/**
 * Web Mercator, as MapLibre draws the flat map: x and y from 0 to 1 across
 * the world. Apart from utils/geometry.ts, which the first visit loads:
 * only the 3D view, the replays and their camera draw in it.
 */
import { DEGREES_TO_RADIANS, type Coordinate } from "./geometry";

/**
 * The latitude Web Mercator ends at, north and south: where the map's
 * square world ends. A fix at the pole would lie at an infinite y.
 */
const MERCATOR_MAX_LAT = 85.0511287798;

/** The Mercator x and y (0 to 1) of a `[lat, lng]` point */
export function mercatorOf([lat, lng]: Readonly<Coordinate>): [number, number] {
  return [mercatorX(lng), mercatorY(lat)];
}

/** The Mercator x (0 to 1) of a longitude, as mercatorOf's */
export function mercatorX(lng: number): number {
  return (lng + 180) / 360;
}

/**
 * The Mercator y (0 to 1) of a latitude, as mercatorOf's: one beyond
 * MERCATOR_MAX_LAT at the edge of the world
 */
export function mercatorY(lat: number): number {
  const sin = Math.sin(
    Math.min(Math.max(lat, -MERCATOR_MAX_LAT), MERCATOR_MAX_LAT) *
      DEGREES_TO_RADIANS,
  );
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

/** The `[lng, lat]` of the Mercator x and y (0 to 1), as mercatorOf's */
export function lngLatOfMercator(x: number, y: number): [number, number] {
  return [
    x * 360 - 180,
    (360 / Math.PI) * Math.atan(Math.exp((1 - 2 * y) * Math.PI)) - 90,
  ];
}
