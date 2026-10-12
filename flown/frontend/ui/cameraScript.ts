/**
 * The camera of a script: the moves Wrapped's intro (ui/wrappedIntro.ts)
 * and the hotspot tour (ui/hotspotTour.ts) make on their own, and the
 * user's hand that ends them.
 *
 * Every move carries REPLAY_CAMERA_MOVE, so what the app does as the map
 * comes to rest (the saved view and the link, the relief level of the
 * cloud, the ribbons of the 3D view) waits for a move that is not
 * scripted, or for restCamera, as for the replay's camera. The turn over a
 * place is linear: eased, it came to a halt and set off again at every
 * stop of the tour.
 *
 * It comes with the feature bundle, and the intro, which is in Wrapped's,
 * finds it there (FeatureModule): a module of the two lazy bundles alone
 * would be a chunk of its own (see build.js).
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { Coordinate } from "../utils/geometry";
import {
  hasLostContext,
  REPLAY_CAMERA_MOVE,
  toLngLat,
} from "../utils/mapHelpers";

/** Where a script puts the camera: `[lat, lng]`, map zoom, tilt, heading */
export interface CameraStop {
  center: Coordinate;
  zoom: number;
  pitch: number;
  bearing: number;
}

/** The options of a camera move to `stop` */
function cameraOf(stop: CameraStop) {
  return {
    center: toLngLat(stop.center),
    zoom: stop.zoom,
    pitch: stop.pitch,
    bearing: stop.bearing,
  };
}

/** Put the camera at `stop` at once */
export function jumpToStop(map: MapLibreMap, stop: CameraStop): void {
  map.jumpTo(cameraOf(stop), REPLAY_CAMERA_MOVE);
}

/** Fly the camera to `stop` along MapLibre's curve, in `duration` ms */
export function flyToStop(
  map: MapLibreMap,
  stop: CameraStop,
  duration: number,
): void {
  map.flyTo({ ...cameraOf(stop), duration }, REPLAY_CAMERA_MOVE);
}

/** Turn the camera where it is to `bearing`, evenly over `duration` ms */
export function turnTo(
  map: MapLibreMap,
  bearing: number,
  duration: number,
): void {
  map.easeTo({ bearing, duration, easing: (t) => t }, REPLAY_CAMERA_MOVE);
}

/**
 * Tell the map's listeners the camera has come to rest where the script
 * put it: `zoomend` and `moveend`, untagged, as MapLibre ends a move, so
 * the app follows the view as after the user's own (the relief level of
 * the 3D view and its exaggeration, the ribbons, the saved view), as the
 * replay's camera does. Not on a map without its WebGL context, whose
 * listeners throw asking it now.
 */
export function restCamera(map: MapLibreMap): void {
  if (hasLostContext(map)) return;
  map.fire("zoomend");
  map.fire("moveend");
}

/** What the user takes the map over with: a press, a wheel or a key */
const TAKEOVER_EVENTS = ["pointerdown", "wheel", "keydown"] as const;

/**
 * Keys pressed on the map that do not take it over: Escape has a meaning
 * of its own, and Tab moves on through the page, with Shift and the other
 * modifiers on their own
 */
const KEYS_NOT_TAKING_OVER = new Set([
  "Escape",
  "Tab",
  "Shift",
  "Control",
  "Alt",
  "Meta",
]);

/**
 * Call `onTakeover` as the user takes the map over by a press, a wheel or
 * a key on it (KEYS_NOT_TAKING_OVER aside), until `signal` aborts; the map
 * stops the camera for them.
 */
export function followTakeover(
  map: MapLibreMap,
  onTakeover: () => void,
  signal: AbortSignal,
): void {
  for (const type of TAKEOVER_EVENTS) {
    map.getContainer().addEventListener(
      type,
      (event) => {
        if (!KEYS_NOT_TAKING_OVER.has((event as KeyboardEvent).key)) {
          onTakeover();
        }
      },
      { passive: true, signal },
    );
  }
}
