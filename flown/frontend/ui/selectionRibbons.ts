/**
 * Selection ribbons - the lines of a selection at their height in 3D
 *
 * With no colour layer on, the selected flights are drawn as thin lines
 * over the heatmap (ui/selectionHighlight.ts). The 3D view draws the heat
 * as a cloud at the heights of the flights (ui/heatCloud.ts), and the lines
 * flat on the ground lay beside it: at map zoom 9 and a tilt of 60 degrees
 * the glow of a flight at 1,900 ft stood well off its line. While the 3D
 * view lifts the flights, the selection is drawn as ribbons instead, cut as
 * the colour layers' are (calculations/ribbons.ts) from the curves of the
 * flights on their ground (groundedFlights), which the cloud is drawn
 * along as well, so the two lie on each other. To the relief's code they
 * are ribbons like the others (RIBBON_SOURCES): they take the exaggeration
 * of a new relief level in the frame the relief does, and hide with the
 * others while they settle on new ground (ui/terrain.ts). The flat lines
 * step aside for them (selectionRibbons in the store). Like the lines they
 * only draw, and are worked out only while they show (highlightsSelection).
 * They come with the feature bundle, with the relief.
 */
import type { GeoJSONSource } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import { groundedFlights, heldFlights } from "../calculations/groundProfile";
import { smoothGrounded } from "../calculations/smoothGrounded";
import { isLiftedAt, ribbonWidthZoom } from "../calculations/lift";
import { ribbonOf, ribbonProperties } from "../calculations/ribbons";
import {
  segmentRangesFor,
  segmentsForPathIds,
} from "../calculations/statistics";
import type { SmoothedFlights } from "../calculations/smoothing";
import { shownSelection } from "../calculations/datasetIndex";
import { MAP_SOURCES } from "../utils/constants";
import {
  isReplayCameraMove,
  onMapReady,
  whenContextRestored,
} from "../utils/mapHelpers";
import {
  CULL_FROM_ZOOM,
  leavesBox,
  overlaps,
  ribbonsTopM,
  VIEW_SPARE,
  viewBox,
  type Box,
} from "../utils/viewBox";
import { boxOf } from "../utils/curveBox";
import { highlightsSelection } from "./layerVisibility";

/**
 * The keys whose change leaves the ribbons on the map of another selection
 * or dataset than the store's
 */
const CUT_KEYS: readonly (keyof StoreState)[] = [
  "currentData",
  "selectedPathIds",
  // The filter: share mode keeps the flights it hides (shownSelection)
  "selectedYear",
  "selectedAircraft",
];

/**
 * The keys that decide whether the ribbons show, and the ground they stand
 * on (see groundKey)
 */
const SHOWN_KEYS: readonly (keyof StoreState)[] = [
  "threeDVisible",
  "altitudeVisible",
  "airspeedVisible",
  "replayActive",
  "terrainActive",
  "reliefLevel",
];

/**
 * The stretches of the segments `start` to `end` (exclusive) of one flight
 * whose part of its curve lies in `box`, each as its first segment and the
 * one after its last
 */
function stretchesIn(
  flights: SmoothedFlights,
  start: number,
  end: number,
  box: Box,
): (readonly [number, number])[] {
  const { points } = flights.chains[flights.chainOf[start]!]!;
  const stretches: (readonly [number, number])[] = [];
  let open = -1;
  for (let i = start; i < end; i++) {
    const inside = overlaps(box, boxOf(points, flights.from[i], flights.to[i]));
    if (inside && open < 0) open = i;
    if (!inside && open >= 0) {
      stretches.push([open, i]);
      open = -1;
    }
  }
  if (open >= 0) stretches.push([open, end]);
  return stretches;
}

/**
 * The ribbons of the selected flights of the dataset, cut for the zoom
 * level `widthZoom` (see ribbonWidthZoom) and the relief level the map is
 * drawn for, as the layer manager cuts those of a colour layer: from each
 * flight's curve on its ground, for the pixels of the level (see
 * screenCut), known to the map by the id of the cut where a zoom switches
 * their exaggeration (see ribbonProperties), and with a `box` only the
 * stretches in it (see viewBox), as the layer manager does from
 * CULL_FROM_ZOOM on: at map zoom 16 the 31 flights of a year, all
 * selected, came to 83,000 pieces and 125 ms of every zoom's end, and
 * around the view to 7,000 pieces and 20 ms. The curves are the ones every
 * flight is smoothed into for the colour layers and the heat cloud (see
 * groundedFlights) where those are held for the level, or where the
 * selection is most of the dataset, as the flights of the home field are.
 * Otherwise they are those of the selected flights alone, smoothed alike:
 * every flight of a year smoothed for another level took 35 ms of a zoom's
 * end on a desktop, where the cloud had kept its points of that level.
 */
export function selectionRibbons(
  app: MapApp,
  widthZoom: number,
  box: Box | null = null,
): GeoJSON.Feature<GeoJSON.MultiPolygon>[] {
  const data = app.currentData;
  const selected = shownSelection(app);
  if (!data || selected.size === 0) return [];
  const level = app.reliefLevel;
  const sampled = app.terrainActive;
  const all = data.path_segments;
  const picked = segmentsForPathIds(all, selected);
  const whole =
    picked.length * 2 > all.length || !!heldFlights(all, sampled, level);
  const segments = whole ? all : picked;
  const flights = whole
    ? groundedFlights(all, sampled, level)
    : smoothGrounded(picked, sampled, level);
  const index = whole && segmentRangesFor(all);
  // The slices of the selected flights, or all of the segments where they
  // are those of the selected flights or not grouped by flight
  const stretches: (readonly [number, number])[] = index
    ? [...selected].flatMap((id) => {
        const stretch = index.get(id);
        return stretch ? [stretch] : [];
      })
    : [[0, segments.length]];
  const features: GeoJSON.Feature<GeoJSON.MultiPolygon>[] = [];
  for (const [from, to] of stretches) {
    let start = from;
    while (start < to) {
      // The segments of a flight that meet end to end are one chain
      let end = start + 1;
      while (end < to && flights.chainOf[end] === flights.chainOf[start]) {
        end++;
      }
      if (selected.has(segments[start]!.path_id)) {
        const cut = box
          ? stretchesIn(flights, start, end, box)
          : [[start, end] as const];
        for (const [a, b] of cut) {
          for (const piece of ribbonOf(flights, a, b, widthZoom, true)) {
            features.push({
              type: "Feature",
              properties: ribbonProperties(piece, level, app.relief.epoch),
              geometry: piece.geometry,
            });
          }
        }
      }
      start = end;
    }
  }
  return features;
}

/**
 * Keep the ribbons of the selected flights on the map while the 3D view
 * lifts the flights and the lines of the selection show, from now on, for
 * as long as the app lives: cut again for another selection, dataset,
 * ground, relief level or zoom level, or a view that leaves the part of
 * the map they were cut for, and taken away where the flights lie flat
 * again, or as the lines are hidden with ribbons on the map that no longer
 * fit them. Hidden by a colour layer or a replay, ribbons that still fit
 * stay for the lines to show again.
 */
export function followSelectionRibbons(app: MapApp): void {
  const map = app.map;
  if (!map) return;
  /**
   * Whether the flights are lifted: as the ribbons of the colour layers,
   * which the layer manager hands to the flat lines once a zoom has ended
   * (see LayerManager.handleZoomEnd), not while it goes on
   */
  let lifted = isLiftedAt(map.getZoom());
  let features: GeoJSON.Feature[] = [];
  /** The zoom level the ribbons on the map were cut for */
  let widthZoom: number | null = null;
  /** The part of the map they were cut for, null for all of it */
  let box: Box | null = null;
  /** The ground they stand on (see groundKey) */
  let ground = "";
  /** They are of another selection or dataset (see CUT_KEYS) or view */
  let stale = true;

  /**
   * The ground and relief level the ribbons are cut for, and the visit of
   * the level (see ribbonId). The layer manager moves the relief along
   * with the 3D view, in the same update, so a cut as the 3D view comes
   * already stands on the ground the relief switches to after it.
   */
  const groundKey = (): string =>
    `${app.terrainActive}/${app.reliefLevel}/${app.relief.epoch}`;

  const topM = (): number =>
    ribbonsTopM(app.altitudeRange.max, app.reliefLevel);

  const write = (): void => {
    void map
      .getSource<GeoJSONSource>(MAP_SOURCES.selectionHighlightRibbons)
      ?.setData({ type: "FeatureCollection", features });
  };

  const update = (): void => {
    // The layer manager ends a zoom before this hears of it, and moves the
    // relief to the level of the new zoom then
    if (!map.isZooming()) lifted = isLiftedAt(map.getZoom());
    const on = app.threeDVisible && lifted;
    // The flat lines step aside (ui/selectionHighlight.ts)
    app.selectionRibbons = on;
    const fits = !stale && ground === groundKey();
    if (on && highlightsSelection(app)) {
      const zoom = ribbonWidthZoom(map.getZoom());
      if (fits && widthZoom === zoom) return;
      widthZoom = zoom;
      box = zoom >= CULL_FROM_ZOOM ? viewBox(map, topM(), VIEW_SPARE) : null;
      features = selectionRibbons(app, zoom, box);
      ground = groundKey();
      stale = false;
    } else {
      if (features.length === 0 || (on && fits)) return;
      features = [];
      box = null;
      stale = true;
    }
    write();
  };

  onMapReady(app, "The ribbons of the selection", () => {
    const signal = app.signal;
    const unsubscribe = [
      app.store.subscribeKeys(CUT_KEYS, () => {
        stale = true;
        update();
      }),
      app.store.subscribeKeys(SHOWN_KEYS, update),
    ];
    // The replay's camera rests of its own (see isReplayCameraMove)
    const zoomed = map.on("zoomend", (event) => {
      if (!isReplayCameraMove(event)) update();
    });
    // Cut around the view, they are cut again as it leaves that
    const moved = map.on("moveend", (event) => {
      if (!box || isReplayCameraMove(event)) return;
      if (!leavesBox(viewBox(map, topM(), 0), box)) return;
      stale = true;
      update();
    });
    // The source comes back with the data of the moment of the loss
    whenContextRestored(map, write, signal);
    signal.addEventListener("abort", () => {
      for (const stop of unsubscribe) stop();
      zoomed.unsubscribe();
      moved.unsubscribe();
    });
    update();
  });
}
