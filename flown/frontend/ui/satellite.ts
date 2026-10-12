/**
 * Satellite - imagery under the flights
 *
 * The Satellite switch (satelliteVisible) lays Sentinel-2 imagery over the
 * ground of the base map, below its roads, borders and labels, so place
 * names stay: a hybrid view. It comes with the feature bundle, which the
 * switch fetches the first time it is on (ui/layerVisibility.ts): most
 * visits never turn it on.
 *
 * The tiles are EOX's Sentinel-2 cloudless mosaic of 2024, keyless like the
 * rest of the page and licensed CC BY-NC-SA 4.0, which this non-commercial
 * site meets; the credit is on the source, so the map shows it exactly
 * while the imagery is drawn, and an exported image carries it. The browser
 * fetches them only while the switch is on.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { MAP_LAYERS, MAP_SOURCES } from "../utils/constants";
import { cssVar, onMapReady } from "../utils/mapHelpers";

/** WMTS in EPSG:3857, which names the row before the column */
const SATELLITE_TILE_URL =
  "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg";

/**
 * The deepest level fetched, which the map stretches beyond. The mosaic is
 * of 10 m pixels, and the tiles of level 14 (6 m at 50 degrees north) are
 * the last to add detail: the server upscales the ones below, which would
 * only be four times the traffic for the same picture.
 */
const SATELLITE_TILE_MAX_ZOOM = 14;

/**
 * The imagery's layer. Like the shading of the relief it belongs with the
 * base map rather than with the app's layers, which `withDataLayers` puts
 * below the labels; it is created the first time it is shown.
 */
export const SATELLITE_LAYER = "satellite";

/**
 * The layers of the base map's ground in CARTO's style (the OpenMapTiles
 * schema): land cover, land use, parks and water. The imagery goes above
 * the last of them and so covers them all. The borders CARTO draws among
 * them are lifted above it while it is shown (`lifted`).
 */
const GROUND = ["landcover", "landuse", "park", "water"];
const BORDERS = "boundary";

/**
 * How the imagery is toned down, so the heat, the flights and the labels,
 * which are made for a near-black map, still read over fields and snow:
 * darker, paler and flatter. The stylesheet's (--satellite-*), with these
 * where it has none.
 */
const PAINT = [
  ["raster-brightness-max", "--satellite-brightness", 0.4],
  ["raster-saturation", "--satellite-saturation", -0.5],
  ["raster-contrast", "--satellite-contrast", -0.2],
] as const;

/** Show the imagery while satelliteVisible is on, from now on */
export function followSatellite(app: MapApp): void {
  const map = app.map;
  if (!map) return;
  const apply = (): void => show(map, app.satelliteVisible);
  onMapReady(app, "The imagery", () => {
    app.store.subscribe("satelliteVisible", apply);
    // A new base style drops the layer, which is none of the app's for
    // `withDataLayers` to carry; it goes back where it belongs in it. For
    // as long as the app lives, like its other map events.
    const styled = map.on("styledata", () => {
      if (app.satelliteVisible && !map.getLayer(SATELLITE_LAYER)) apply();
    });
    app.signal.addEventListener("abort", () => styled.unsubscribe());
    apply();
  });
}

/**
 * The borders lifted above the imagery in each map's current style, each
 * with the layer it was drawn below, to put it back when the imagery goes.
 * CARTO draws its county and state borders among the ground, below the
 * water, which hides them across lakes and seas; above the imagery they
 * show there too, which is right over the land in the picture but wrong on
 * the plain dark map. Placing the imagery below them instead would leave
 * the water fills above it, so they move, and only while it is shown.
 */
const lifted = new WeakMap<MapLibreMap, [id: string, before: string][]>();

function show(map: MapLibreMap, shown: boolean): void {
  if (map.getLayer(SATELLITE_LAYER)) {
    map.setLayoutProperty(
      SATELLITE_LAYER,
      "visibility",
      shown ? "visible" : "none",
    );
    if (shown) liftBorders(map);
    else lowerBorders(map);
    return;
  }
  // A new base style has its borders where it drew them
  lifted.delete(map);
  if (!shown) return;
  // Once: `withDataLayers` carries the source from then on
  if (!map.getSource(MAP_SOURCES.satellite)) {
    map.addSource(MAP_SOURCES.satellite, {
      type: "raster",
      tiles: [SATELLITE_TILE_URL],
      tileSize: 256,
      maxzoom: SATELLITE_TILE_MAX_ZOOM,
      attribution:
        'EOxCloudless <a href="https://cloudless.eox.at">cloudless.eox.at</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)',
    });
  }
  // Right above the ground of the base map, and below its roads, the
  // shading of the relief and every layer of the app
  const paint = Object.fromEntries(
    PAINT.map(([property, token, fallback]) => {
      const value = Number.parseFloat(cssVar(token));
      return [property, Number.isFinite(value) ? value : fallback];
    }),
  );
  map.addLayer(
    {
      id: SATELLITE_LAYER,
      type: "raster",
      source: MAP_SOURCES.satellite,
      paint,
    },
    aboveGround(map),
  );
  liftBorders(map);
}

/**
 * The layer right above the ground of the base map, to add a layer before:
 * above its land cover, land use, parks and water (GROUND), or its
 * background in a style without them (the map's own before CARTO's
 * arrives), and above the imagery, which lies on them, with the borders
 * lifted over it; below its roads, buildings and labels and every layer of
 * the app. The imagery goes there, and the shading of the relief
 * (ui/terrain.ts) above it, whichever comes first.
 */
export function aboveGround(map: MapLibreMap): string | undefined {
  const own = new Set<string>(Object.values(MAP_LAYERS));
  const order = map.getLayersOrder();
  let top = -1;
  let imagery = -1;
  for (const [i, id] of order.entries()) {
    const layer = map.getLayer(id);
    if (own.has(id) || layer?.type === "symbol") break;
    if (id === SATELLITE_LAYER) imagery = i;
    if (
      imagery === i ||
      (imagery >= 0 && top === i - 1 && layer?.sourceLayer === BORDERS) ||
      layer?.type === "background" ||
      GROUND.includes(layer?.sourceLayer ?? "")
    ) {
      top = i;
    }
  }
  return order[top + 1];
}

/** Move the borders below the imagery right above it, once */
function liftBorders(map: MapLibreMap): void {
  if (lifted.has(map)) return;
  const order = map.getLayersOrder();
  const at = order.indexOf(SATELLITE_LAYER);
  const moved: [string, string][] = [];
  for (const [i, id] of order.slice(0, at).entries()) {
    if (map.getLayer(id)?.sourceLayer !== BORDERS) continue;
    moved.push([id, order[i + 1] ?? SATELLITE_LAYER]);
    map.moveLayer(id, order[at + 1]);
  }
  lifted.set(map, moved);
}

/**
 * Put the lifted borders back, the last first, so one lifted with the
 * layer it was below finds that layer back in its place
 */
function lowerBorders(map: MapLibreMap): void {
  for (const [id, before] of [...(lifted.get(map) ?? [])].reverse()) {
    if (map.getLayer(id) && map.getLayer(before)) map.moveLayer(id, before);
  }
  lifted.delete(map);
}
