/**
 * Selection highlight - The selected flights as thin lines over the heatmap
 *
 * The colour layers draw a selection on layers of their own. With neither
 * of them on, the heatmap is all there is, and it does not follow the
 * selection on purpose (only Share mode narrows it), so a selected flight was
 * nowhere to be seen. These lines mark it instead. Whether they show is
 * worked out with the other layers (see ui/layerVisibility.ts); this module
 * keeps their data in step with the selection and the dataset. Where the
 * 3D view lifts the flights, it draws them as ribbons at their height
 * instead (ui/selectionRibbons.ts), and the lines step aside.
 */
import type { GeoJSONSource } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { PathSegment } from "../types";
import { segmentsForPathIds } from "../calculations/statistics";
import { shownSelection } from "../calculations/datasetIndex";
import { appendCurve, flatCurves } from "../calculations/curves";
import { MAP_LAYERS, MAP_SOURCES } from "../utils/constants";
import { highlightsSelection } from "./layerVisibility";
import {
  toLngLat,
  onMapReady,
  whenContextRestored,
  type LngLatTuple,
} from "../utils/mapHelpers";

/**
 * The given segments as lines, one per path: the segments of a path are one
 * chain (see services/yearDataset.ts). They run along the curve through the
 * fixes, like the colour lines (see calculations/curves.ts). Each point is
 * taken into the copy of the world of the point before, so a flight across
 * the antimeridian does not go round the world.
 */
export function selectionLines(
  segments: readonly PathSegment[],
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const curves = flatCurves(segments);
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  let line: LngLatTuple[] = [];
  let pathId: number | undefined;
  segments.forEach(({ path_id, coords }, index) => {
    if (path_id !== pathId) {
      pathId = path_id;
      line = [toLngLat(coords[0])];
      features.push({
        type: "Feature",
        properties: null,
        geometry: { type: "LineString", coordinates: line },
      });
    }
    appendCurve(line, curves, index);
  });
  return { type: "FeatureCollection", features };
}

/**
 * How strong the lines of a selection are: at full strength for a few
 * flights, which have to be found, and at half of it for many. A click on
 * the home base selects every flight of it, and 27 opaque lines out of one
 * field and over one another were a white knot over the heat.
 */
const SELECTION_OPACITY = { few: 0.9, many: 0.45 };
/** Flights up to which the lines are at full strength */
const SELECTION_FEW = 3;
/** Flights from which they are at the least, fading in between */
const SELECTION_MANY = 20;

/** The opacity of the lines of `count` selected flights (see above) */
export function selectionOpacity(count: number): number {
  const { few, many } = SELECTION_OPACITY;
  const t = (count - SELECTION_FEW) / (SELECTION_MANY - SELECTION_FEW);
  return few - (few - many) * Math.min(Math.max(t, 0), 1);
}

/**
 * Keep the lines on the selected flights of the dataset on the map while
 * they show (see highlightsSelection), and bring them up to date as they
 * come to show: under a colour layer, which draws the selection itself,
 * the lines of the busiest airport's hundreds of flights took a fifth of
 * the click that selected them, for nobody to see. Of the selected
 * flights the year and aircraft filters show (shownSelection): share mode
 * keeps the ones they hide, which no line is drawn on. While the 3D view
 * draws the
 * selection as ribbons (selectionRibbons), the lines are of no flight.
 * After a lost WebGL context the source is back with the data of the
 * moment of the loss, and gets them again.
 */
export function followSelectionHighlight(app: MapApp): void {
  let lines = selectionLines([]);
  // The lines are of another dataset or selection than the store's
  let stale = true;
  const write = (): void => {
    const map = app.map;
    void map
      ?.getSource<GeoJSONSource>(MAP_SOURCES.selectionHighlight)
      ?.setData(lines);
    if (map?.getLayer(MAP_LAYERS.selectionHighlight)) {
      map.setPaintProperty(
        MAP_LAYERS.selectionHighlight,
        "line-opacity",
        selectionOpacity(lines.features.length),
      );
    }
  };
  const update = (): void => {
    const selected = app.selectionRibbons
      ? new Set<number>()
      : shownSelection(app);
    // Taken away as the selection is cleared, whether they show or not
    if (!stale || (selected.size > 0 && !highlightsSelection(app))) return;
    stale = false;
    // Nothing selected, and nothing drawn to take away
    if (selected.size === 0 && lines.features.length === 0) return;
    const data = app.currentData;
    lines = selectionLines(
      data ? segmentsForPathIds(data.path_segments, selected) : [],
    );
    write();
  };
  const keys = [
    "currentData",
    "selectedPathIds",
    "selectedYear",
    "selectedAircraft",
    "selectionRibbons",
  ] as const;
  app.store.subscribeKeys(keys, () => {
    stale = true;
    update();
  });
  app.store.subscribeKeys(
    ["altitudeVisible", "airspeedVisible", "replayActive"],
    update,
  );
  update();
  onMapReady(app, "The selection's lines", (map) => {
    write();
    whenContextRestored(map, write, app.signal);
  });
}
