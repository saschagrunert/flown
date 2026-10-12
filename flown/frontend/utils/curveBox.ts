/**
 * The box a curve of the 3D view lies in, which its ribbons and its cloud
 * are culled by against the view (see utils/viewBox.ts). Apart from that
 * module, which the first visit loads: only the 3D view cuts curves.
 */
import type { Coordinate } from "./geometry";
import type { Box } from "./viewBox";

/**
 * The box of the `[lat, lng]` points `from` to `to` of a curve (both
 * included), all of them by default
 */
export function boxOf(
  points: readonly Readonly<Coordinate>[],
  from = 0,
  to = points.length - 1,
): Box {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let k = from; k <= to; k++) {
    const point = points[k]!;
    const lat = point[0];
    const lng = point[1];
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}
