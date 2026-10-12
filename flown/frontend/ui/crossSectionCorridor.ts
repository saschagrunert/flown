/**
 * Cross-section corridor - the line and its corridor on the map
 *
 * While the cross-section (ui/crossSection.ts) is open, the line it is
 * drawn along and the corridor either side of it that it counts the
 * flights in are drawn on the map, from a source and three layers of their
 * own under the airports' labels. They are none of the app's fixed layers
 * (mapLayers.ts): the tool adds them as it opens, again after a new base
 * style has dropped them, and removes them as it closes. This module holds
 * that source and those layers, the GeoJSON of the corridor for a line and
 * a half width (`corridorData`), where a pointer is on the map
 * (`pointAt`) and whether two ends are too close to make a line
 * (`tooShort`). When and where the corridor is drawn is the tool's.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import { corridorOutline, lineFrame } from "../calculations/crossSection";
import { MAP_LAYERS } from "../utils/constants";
import type { Coordinate } from "../utils/geometry";
import { cssVar, toLngLat } from "../utils/mapHelpers";

/** The source of the corridor on the map, and its layers */
export const CROSS_SECTION_SOURCE = "cross-section";
export const CROSS_SECTION_LAYERS = {
  corridor: "cross-section-corridor",
  edge: "cross-section-edge",
  line: "cross-section-line",
} as const;

/** The shortest line there is a section of, in metres */
const MIN_LINE_M = 1;

/** The corridor's width on the screen as the line is drawn, in pixels */
export const CORRIDOR_SCREEN_PX = 40;

/** The corridor and the line from `from` to `to`, as GeoJSON */
export const corridorData = (
  from: Coordinate | null,
  to: Coordinate | null,
  halfWidth: number,
): GeoJSON.FeatureCollection => {
  const features: GeoJSON.Feature[] = [];
  if (from && to) {
    const outline = corridorOutline(lineFrame(from, to), halfWidth);
    features.push(
      {
        type: "Feature",
        properties: { kind: "corridor" },
        geometry: {
          type: "Polygon",
          coordinates: [outline.ring.map(toLngLat)],
        },
      },
      {
        type: "Feature",
        properties: { kind: "line" },
        geometry: {
          type: "LineString",
          coordinates: outline.line.map(toLngLat),
        },
      },
    );
  }
  return { type: "FeatureCollection", features };
};

/** Add the source and the layers of the corridor where they are missing */
export const addLayers = (target: MapLibreMap): void => {
  if (!target.getSource(CROSS_SECTION_SOURCE)) {
    target.addSource(CROSS_SECTION_SOURCE, {
      type: "geojson",
      data: corridorData(null, null, 0),
    });
  }
  const colour = cssVar("--color-accent-blue") || "#4facfe";
  const before = target.getLayer(MAP_LAYERS.airportLabels)
    ? MAP_LAYERS.airportLabels
    : undefined;
  const layers = [
    {
      id: CROSS_SECTION_LAYERS.corridor,
      type: "fill",
      source: CROSS_SECTION_SOURCE,
      filter: ["==", ["get", "kind"], "corridor"],
      paint: { "fill-color": colour, "fill-opacity": 0.12 },
    },
    {
      id: CROSS_SECTION_LAYERS.edge,
      type: "line",
      source: CROSS_SECTION_SOURCE,
      filter: ["==", ["get", "kind"], "corridor"],
      paint: {
        "line-color": colour,
        "line-width": 1.5,
        "line-dasharray": [2, 2],
      },
    },
    {
      id: CROSS_SECTION_LAYERS.line,
      type: "line",
      source: CROSS_SECTION_SOURCE,
      filter: ["==", ["get", "kind"], "line"],
      layout: { "line-cap": "round" },
      paint: { "line-color": "#ffffff", "line-width": 2 },
    },
  ] as const;
  for (const layer of layers) {
    if (!target.getLayer(layer.id)) {
      target.addLayer(
        layer as unknown as Parameters<MapLibreMap["addLayer"]>[0],
        before,
      );
    }
  }
};

export const removeLayers = (target: MapLibreMap): void => {
  for (const id of Object.values(CROSS_SECTION_LAYERS)) {
    if (target.getLayer(id)) target.removeLayer(id);
  }
  if (target.getSource(CROSS_SECTION_SOURCE)) {
    target.removeSource(CROSS_SECTION_SOURCE);
  }
};

/** Where a pointer is on the map, [lat, lon] */
export const pointAt = (
  target: MapLibreMap,
  event: PointerEvent,
): Coordinate => {
  const box = target.getContainer().getBoundingClientRect();
  const at = target.unproject([
    event.clientX - box.left,
    event.clientY - box.top,
  ]);
  return [at.lat, at.lng];
};

/** Whether the ends `from` and `to` are too close to make a line */
export const tooShort = (from: Coordinate, to: Coordinate): boolean =>
  lineFrame(from, to).lengthM < MIN_LINE_M;
