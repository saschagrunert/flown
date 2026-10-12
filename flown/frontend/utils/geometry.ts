/**
 * Geometry utility functions for coordinate calculations
 */
import { MAP_MAX_PITCH } from "./constants";
import type { PathSegment } from "../types";

/**
 * Coordinate tuple [latitude, longitude]
 */
export type Coordinate = [number, number];

/**
 * Metres a degree of latitude spans, and of longitude at the equator. The
 * exporter measures the flights with the same (flown/terrain.py).
 */
export const METRES_PER_DEGREE = 111320;

export const DEGREES_TO_RADIANS = Math.PI / 180;

/** The circumference of the earth, in metres, at the equator */
export const EARTH_CIRCUMFERENCE_M = 40075016.686;

/** The pixels a tile of the map spans, and the world at zoom 0 */
export const TILE_SIZE_PX = 512;

/**
 * The distance of the camera from the screen, in pixels, for a screen
 * `heightPx` high seen with the vertical field of view `fov` (radians)
 */
export function focalLengthPx(heightPx: number, fov: number): number {
  return heightPx / 2 / Math.tan(fov / 2);
}

/** Metres a pixel spans at the equator at a map zoom */
export function metresPerPixel(zoom: number): number {
  return EARTH_CIRCUMFERENCE_M / (TILE_SIZE_PX * 2 ** zoom);
}

/**
 * The difference of two angles, the short way round (degrees), from -180
 * up to 180. Exact where there is no way round to take: the difference is
 * left as it is.
 */
export function turnOf(from: number, to: number): number {
  const turn = to - from;
  return turn - 360 * Math.round(turn / 360);
}

/**
 * Metres between two `[lat, lng]` points close to each other, measured on
 * the plane there, and the short way across the antimeridian, as the
 * exporter measures them
 */
export function planarMetres(
  a: Readonly<Coordinate>,
  b: Readonly<Coordinate>,
): number {
  return Math.hypot(
    turnOf(a[1], b[1]) *
      METRES_PER_DEGREE *
      Math.cos(((a[0] + b[0]) / 2) * DEGREES_TO_RADIANS),
    (b[0] - a[0]) * METRES_PER_DEGREE,
  );
}

/**
 * The pair as a place a map can be centred on, or null when it is none.
 * Links and saved state both go through here before they reach the map:
 * MapLibre throws for a latitude past the poles, and a saved view that
 * throws would do so on every reload with nothing to clear it. A longitude
 * past 180 is no damage: a pan across the antimeridian leaves one behind,
 * and older builds saved it as it was. It is the same place in another copy
 * of the world, so it is wrapped back into range.
 */
export function toMapCenter(center: {
  lat: unknown;
  lng: unknown;
}): { lat: number; lng: number } | null {
  const { lat, lng } = center;
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !isFinite(lat) ||
    !isFinite(lng) ||
    Math.abs(lat) > 90
  ) {
    return null;
  }
  // Only out of range: the wrap adds rounding noise, and turns 180 into -180
  if (Math.abs(lng) <= 180) return { lat, lng };
  return { lat, lng: wrapDegrees(lng) };
}

/** Degrees wrapped into -180 to 180 */
export function wrapDegrees(degrees: number): number {
  return ((((degrees + 180) % 360) + 360) % 360) - 180;
}

/**
 * A bearing of a link or of saved state as the map reports its own: any
 * finite number of degrees, wrapped into -180 to 180. Null for anything else.
 */
export function toMapBearing(bearing: unknown): number | null {
  if (typeof bearing !== "number" || !isFinite(bearing)) return null;
  // Only out of range, for the reason given in toMapCenter
  return Math.abs(bearing) <= 180 ? bearing : wrapDegrees(bearing);
}

/** A pitch of a link or of saved state, held to what the map tilts to */
export function toMapPitch(pitch: unknown): number | null {
  if (typeof pitch !== "number" || !isFinite(pitch)) return null;
  return Math.max(0, Math.min(MAP_MAX_PITCH, pitch));
}

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param coords1 - [latitude, longitude] in decimal degrees
 * @param coords2 - [latitude, longitude] in decimal degrees
 * @returns Distance in kilometers
 */
export function calculateDistance(
  coords1: Coordinate,
  coords2: Coordinate,
): number {
  const [lat1Deg, lon1Deg] = coords1;
  const [lat2Deg, lon2Deg] = coords2;

  // Convert to radians
  const lat1 = (lat1Deg * Math.PI) / 180;
  const lon1 = (lon1Deg * Math.PI) / 180;
  const lat2 = (lat2Deg * Math.PI) / 180;
  const lon2 = (lon2Deg * Math.PI) / 180;

  const dlat = lat2 - lat1;
  const dlon = lon2 - lon1;

  const a =
    Math.sin(dlat / 2) * Math.sin(dlat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dlon / 2) * Math.sin(dlon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  // Earth's radius in kilometers
  return 6371 * c;
}

/**
 * Calculate bearing (direction) from one coordinate to another
 * @param lat1 - Starting latitude in decimal degrees
 * @param lon1 - Starting longitude in decimal degrees
 * @param lat2 - Ending latitude in decimal degrees
 * @param lon2 - Ending longitude in decimal degrees
 * @returns Bearing in degrees (0-360)
 */
export function calculateBearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  // Convert to radians
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;

  // Calculate bearing
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);

  // Convert to degrees and normalize to 0-360
  return ((θ * 180) / Math.PI + 360) % 360;
}

/**
 * Convert decimal degrees to degrees, minutes, seconds format
 * @param dd - Decimal degrees
 * @param isLat - True for latitude, false for longitude
 * @returns Formatted DMS string (e.g., "51°30'15.6"N")
 */
export function ddToDms(dd: number, isLat: boolean): string {
  const direction = dd >= 0 ? (isLat ? "N" : "E") : isLat ? "S" : "W";
  // Round once, in the unit that is printed, and split afterwards: rounding
  // only the seconds turns 59.96 into "60.0" instead of carrying the minute
  const tenths = Math.round(Math.abs(dd) * 36000);
  const degrees = Math.floor(tenths / 36000);
  const minutes = Math.floor((tenths % 36000) / 600);
  const seconds = (tenths % 600) / 10;
  return degrees + "°" + minutes + "'" + seconds.toFixed(1) + '"' + direction;
}

/**
 * The span of the latitudes and longitudes the segments touch, as a
 * [south-west, north-east] pair of [lat, lon], or null when none of them has
 * coordinates. Replay and Wrapped both frame their flights with it, and
 * their bundles share only what the app has as well (see build.js), so it
 * lives here rather than with either of them.
 *
 * Flights across the antimeridian span the narrower way round: the
 * western longitudes are counted from 180 on, so the east edge can lie
 * past 180, where MapLibre frames it, rather than the bounds taking in
 * the whole world the other way.
 */
export function segmentBounds(
  segments: PathSegment[],
): [Coordinate, Coordinate] | null {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  // The same longitudes with the western ones counted on past 180
  let minEast = Infinity;
  let maxEast = -Infinity;
  for (const segment of segments) {
    for (const [lat, lon] of segment.coords) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      const east = lon < 0 ? lon + 360 : lon;
      if (east < minEast) minEast = east;
      if (east > maxEast) maxEast = east;
    }
  }
  if (minLat === Infinity) return null;
  if (maxEast - minEast < maxLon - minLon) {
    minLon = minEast;
    maxLon = maxEast;
  }
  return [
    [minLat, minLon],
    [maxLat, maxLon],
  ];
}
