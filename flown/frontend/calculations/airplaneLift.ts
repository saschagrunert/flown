/**
 * Where a point of a flight is drawn on the screen in the 3D view: the
 * airplane of the replay and the chase view, the pointer of the flight
 * profile and the readout of the heat cloud. Only the feature bundle asks,
 * so this is kept out of lift.ts, whose policy the map draws the ribbons
 * with on the first visit.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  heightOnReliefFt,
  isLiftedAt,
  liftOffsetPx,
  reliefLevel,
} from "./lift";

/**
 * A point's feet above the ground of the relief level `level`, and the
 * ground of the levels around it there (see groundOffsetFt); a height of
 * null is none, where the flights are not lifted
 */
export interface GroundedHeight {
  heightFt: number | null;
  offsetsFt?: readonly number[] | undefined;
  level?: number | undefined;
}

/**
 * The feet above the relief under a tile of the map zoom `zoom` of a point
 * lifted as `point` says (see heightOnReliefFt), or null for none
 */
export function heightAtZoomFt(
  point: GroundedHeight,
  zoom: number,
): number | null {
  return point.heightFt === null
    ? null
    : heightOnReliefFt(
        point.heightFt,
        point.offsetsFt,
        point.level ?? reliefLevel(zoom),
        zoom,
      );
}

/**
 * How far up the screen the replay's airplane is drawn at `zoom`: at its
 * height, on its trail, where the trail is lifted (see isLiftedAt).
 * `heightFt` is null while the trail is flat.
 */
export function airplaneLiftPx(
  map: MapLibreMap,
  lat: number,
  heightFt: number | null,
  exaggeration: number,
  zoom = map.getZoom(),
): number {
  return heightFt === null || !isLiftedAt(zoom)
    ? 0
    : liftOffsetPx(map, lat, heightFt, exaggeration, zoom);
}
