/**
 * Flights framed on the map as it is tilted: the replay of all flights
 * (ui/replayAll.ts), the intro of a link to shared flights
 * (ui/shareIntro.ts), and share mode and a flight picked from a list (see
 * PathSelection, which fetches this bundle for it). A fit of their bounds
 * took no account of the tilt, and in the 3D view left them in the far
 * part of the map: it is only where the fit starts from (fitTilted), which
 * measures every point of them, each on the copy of the world it lies on
 * (fixPoints).
 */
import type {
  LngLat,
  LngLatBoundsLike,
  Map as MapLibreMap,
  PaddingOptions,
  Point,
} from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { PathSegment } from "../types";
import {
  fitTilted,
  fixPoints,
  type FitCamera,
  type FitPoints,
} from "../calculations/replayAll";
import { segmentsForPathIds } from "../calculations/statistics";
import { AUTO_ZOOM_FOLLOW } from "../utils/constants";
import { segmentBounds } from "../utils/geometry";
import { toBounds, unwrapLng } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { mapChromePadding } from "./pathSelection";

/**
 * How much of the map between the panels a flight picked on its own spans
 * at least, across or down, for the view to stay where it is
 */
const SEEN_SPAN = 0.25;

/** Time the view takes to frame the flights (ms) */
const FRAME_MS = 800;

/**
 * A camera that frames flights, turned by `bearing`, and `flat`, the zoom
 * of the fit of their bounds it started from. The tilt it is for is left
 * to the map, or to the move to it.
 */
export interface FlightsCamera extends FitCamera {
  bearing: number;
  flat: number;
}

/**
 * The camera that shows the flights `run` as large as the map allows within
 * `padding`, tilted by `pitch` and turned by `bearing`, and no closer in
 * than `maxZoom`: from the fit of their bounds, `bounds`, on (see
 * fitTilted), or null where the map has no room for them
 */
export function fitCamera(
  map: MapLibreMap,
  run: FitPoints,
  bounds: LngLatBoundsLike,
  padding: Required<PaddingOptions>,
  pitch: number,
  bearing: number,
  maxZoom: number,
): FlightsCamera | null {
  const start = map.cameraForBounds(bounds, { padding, bearing, maxZoom });
  if (!start) return null;
  const { width, height } = map.getContainer().getBoundingClientRect();
  const { lng, lat } = start.center as LngLat;
  const flat = start.zoom!;
  return {
    ...fitTilted(
      run,
      { center: [lng, lat], zoom: flat },
      {
        width,
        height,
        padding,
        pitch,
        fov: map.getVerticalFieldOfView(),
        bearing,
      },
      maxZoom,
    ),
    bearing,
    flat,
  };
}

/**
 * The camera that frames the flights of `segments` with the map's tilt and
 * bearing kept, clear of the panels along its edges (mapChromePadding),
 * and no closer than a replay follows a flight: a few fixes on a field
 * were framed at the map's deepest zoom. Null for no fix.
 */
export function flightsCamera(
  map: MapLibreMap,
  segments: PathSegment[],
): FlightsCamera | null {
  const bounds = segmentBounds(segments);
  return (
    bounds &&
    fitCamera(
      map,
      fixPoints(segments),
      toBounds(bounds),
      mapChromePadding(map),
      map.getPitch(),
      map.getBearing(),
      AUTO_ZOOM_FOLLOW,
    )
  );
}

/**
 * Bring flights into view, the selected ones or one of them, clear of the
 * panels: shared, they are all the map shows, and one could stay half off
 * the screen or under the chip that says it is selected.
 * With `unlessInView` the map stays where it is when every point of them
 * is on it and clear of the panels already, and they span a quarter of the
 * map between the panels either way: a circuit round the home field was a
 * speck in the middle of the heat, and on a phone none at all.
 */
export function frameFlights(
  app: MapApp,
  pathIds: ReadonlySet<number>,
  unlessInView = false,
): void {
  const map = app.map;
  const data = app.currentData;
  if (!map || !data) return;
  const segments = segmentsForPathIds(data.path_segments, pathIds);
  const bounds = unlessInView && segmentBounds(segments);
  if (bounds) {
    const padding = mapChromePadding(map);
    const { width, height } = map.getContainer().getBoundingClientRect();
    // Each point on the world copy the map shows: across the antimeridian
    // the other side of a flight is a world away otherwise
    const centre = map.getCenter().lng;
    const clear = segments.every((segment) =>
      segment.coords.every(([lat, lng]) => {
        const { x, y } = map.project([unwrapLng(lng, centre), lat]);
        return (
          x >= padding.left &&
          x <= width - padding.right &&
          y >= padding.top &&
          y <= height - padding.bottom
        );
      }),
    );
    // How far apart the corners of their bounds are on the map
    const [a, b] = toBounds(bounds).map((corner) => map.project(corner)) as [
      Point,
      Point,
    ];
    const seen = Math.max(
      Math.abs(b.x - a.x) / (width - padding.left - padding.right),
      Math.abs(b.y - a.y) / (height - padding.top - padding.bottom),
    );
    if (clear && seen > SEEN_SPAN) return;
  }
  const camera = flightsCamera(map, segments);
  if (camera) {
    map.easeTo({
      ...camera,
      duration: FRAME_MS,
      animate: !prefersReducedMotion(),
    });
  }
}
