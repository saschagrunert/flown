/**
 * The satellite imagery: its switch, which fetches the code the first time
 * it is on, and the layer that code puts into the base map.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { StyleSpecification } from "maplibre-gl";
import {
  followSatellite,
  SATELLITE_LAYER,
} from "../../../../flown/frontend/ui/satellite";
import { followTerrain } from "../../../../flown/frontend/ui/terrain";
import {
  followSatelliteSwitch,
  SATELLITE_UNAVAILABLE_MESSAGE,
} from "../../../../flown/frontend/ui/layerVisibility";
import { withDataLayers } from "../../../../flown/frontend/mapLayers";
import { UIToggles } from "../../../../flown/frontend/ui/uiToggles";
import {
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../flown/frontend/utils/constants";
import { syncToggleButton } from "../../../../flown/frontend/utils/buttonState";
import {
  asMapApp,
  createMockApp,
  el,
  mountElements,
  type MockApp,
} from "../../testHelpers";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";

const toast = vi.hoisted(() => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock("../../../../flown/frontend/utils/toast", () => toast);

// The feature bundle, as far as the imagery takes it
const featureBundle = vi.hoisted(() => ({
  available: true,
  followSatellite: vi.fn(),
}));
vi.mock("../../../../flown/frontend/services/featureLoader", () => ({
  loadedFeatures: () => null,
  loadFeatures: vi.fn(() =>
    Promise.resolve(
      featureBundle.available
        ? { followSatellite: featureBundle.followSatellite }
        : null,
    ),
  ),
}));

/** Let the promises of a load and of `mapReady` settle */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r));

/**
 * A base style shaped like CARTO's dark matter: area fills with the county
 * and state borders and the rivers among them, the airport and the roads
 * above, then the country border and the labels
 */
const CARTO_LIKE: StyleSpecification = {
  version: 8,
  sources: { carto: { type: "vector", tiles: [] } },
  layers: [
    { id: "background", type: "background" },
    ...(
      [
        ["landcover", "fill", "landcover"],
        ["landuse", "fill", "landuse"],
        ["waterway", "line", "waterway"],
        ["boundary_county", "line", "boundary"],
        ["boundary_state", "line", "boundary"],
        ["water", "fill", "water"],
        ["aeroway-runway", "line", "aeroway"],
        ["road_pri_fill", "line", "transportation"],
        ["building", "fill", "building"],
        ["boundary_country", "line", "boundary"],
        ["place_town", "symbol", "place"],
      ] as const
    ).map(([id, type, sourceLayer]) => ({
      id,
      type,
      source: "carto",
      "source-layer": sourceLayer,
    })),
  ] as StyleSpecification["layers"],
};

describe("the satellite switch", () => {
  let app: MockApp;
  let unmount: () => void;

  beforeEach(() => {
    unmount = mountElements({ "satellite-btn": "button" });
    featureBundle.available = true;
    featureBundle.followSatellite.mockClear();
    toast.showToast.mockClear();
    app = createMockApp();
  });

  afterEach(() => {
    unmount();
    resetMapLibreMock();
  });

  it("is off by default and fetches nothing while it stays off", async () => {
    followSatelliteSwitch(asMapApp(app));
    await settle();

    expect(app.satelliteVisible).toBe(false);
    expect(featureBundle.followSatellite).not.toHaveBeenCalled();
  });

  it("hands itself to the feature bundle the first time it is on, once", async () => {
    followSatelliteSwitch(asMapApp(app));
    syncToggleButton(app.store, "satelliteVisible", "satellite-btn");
    const toggles = new UIToggles(asMapApp(app));

    toggles.toggleSatellite();
    expect(el("satellite-btn").getAttribute("aria-pressed")).toBe("true");
    await settle();
    toggles.toggleSatellite();
    toggles.toggleSatellite();
    await settle();

    expect(featureBundle.followSatellite).toHaveBeenCalledTimes(1);
    expect(featureBundle.followSatellite).toHaveBeenCalledWith(app);
    expect(app.satelliteVisible).toBe(true);
  });

  it("fetches the code at once for a state restored with it on", async () => {
    app.satelliteVisible = true;

    followSatelliteSwitch(asMapApp(app));
    await settle();

    expect(featureBundle.followSatellite).toHaveBeenCalledTimes(1);
  });

  it("turns back off and says so when the code cannot be fetched, and asks again", async () => {
    featureBundle.available = false;
    followSatelliteSwitch(asMapApp(app));

    app.satelliteVisible = true;
    await settle();

    expect(app.satelliteVisible).toBe(false);
    expect(toast.showToast).toHaveBeenCalledWith(
      SATELLITE_UNAVAILABLE_MESSAGE,
      "error",
    );

    featureBundle.available = true;
    app.satelliteVisible = true;
    await settle();
    expect(featureBundle.followSatellite).toHaveBeenCalledTimes(1);
    expect(app.satelliteVisible).toBe(true);
    // The error stays until dismissed, and is no longer true
    expect(toast.dismissToast).toHaveBeenCalledWith(
      SATELLITE_UNAVAILABLE_MESSAGE,
    );
  });

  it("says nothing when the code fails after the switch is off again", async () => {
    featureBundle.available = false;
    followSatelliteSwitch(asMapApp(app));

    app.satelliteVisible = true;
    app.satelliteVisible = false;
    await settle();

    expect(app.satelliteVisible).toBe(false);
    expect(toast.showToast).not.toHaveBeenCalled();
  });
});

describe("the satellite imagery", () => {
  let app: MockApp;

  const map = (): NonNullable<MockApp["map"]> => app.map!;
  const order = (): string[] => map().getLayersOrder();
  const visibility = (): unknown =>
    map().getLayoutProperty(SATELLITE_LAYER, "visibility");

  /** Swap the base style as MapApp does when CARTO's arrives */
  function swapBaseStyle(style: StyleSpecification): void {
    // The fake types the transform loosely; the map hands it styles
    map().setStyle(style, {
      transformStyle: withDataLayers as unknown as (
        previous: unknown,
        next: unknown,
      ) => ReturnType<typeof withDataLayers> & {
        sources: Record<string, Record<string, unknown>>;
        layers: Record<string, unknown>[];
      },
    });
    map().emit("styledata");
  }

  beforeEach(() => {
    app = createMockApp();
  });

  afterEach(() => {
    document.documentElement.style.cssText = "";
    resetMapLibreMock();
  });

  it("adds nothing until the switch is on", async () => {
    followSatellite(asMapApp(app));
    await settle();

    expect(map().getSource(MAP_SOURCES.satellite)).toBeUndefined();
    expect(map().getLayer(SATELLITE_LAYER)).toBeUndefined();
  });

  it("draws EOX's imagery with its credit on the source, which the map shows only while it is drawn", async () => {
    followSatellite(asMapApp(app));
    await settle();

    app.satelliteVisible = true;

    expect(map().source(MAP_SOURCES.satellite).spec).toEqual({
      type: "raster",
      tiles: [
        "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg",
      ],
      tileSize: 256,
      maxzoom: 14,
      attribution:
        'EOxCloudless <a href="https://cloudless.eox.at">cloudless.eox.at</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024)',
    });
    expect(map().layer(SATELLITE_LAYER)).toMatchObject({
      type: "raster",
      source: MAP_SOURCES.satellite,
    });
    expect(visibility()).not.toBe("none");

    app.satelliteVisible = false;
    expect(visibility()).toBe("none");
    app.satelliteVisible = true;
    expect(visibility()).toBe("visible");
  });

  it("tones the imagery down with the stylesheet's values, or its own", async () => {
    document.documentElement.style.setProperty("--satellite-brightness", "0.3");
    document.documentElement.style.setProperty("--satellite-contrast", "0");
    app.satelliteVisible = true;

    followSatellite(asMapApp(app));
    await settle();

    expect(map().layer(SATELLITE_LAYER).paint).toEqual({
      "raster-brightness-max": 0.3,
      "raster-saturation": -0.5,
      // Zero is a value, not a missing one
      "raster-contrast": 0,
    });
  });

  it("goes right above the background of the map's own style, below every layer of the app", async () => {
    app.satelliteVisible = true;

    followSatellite(asMapApp(app));
    await settle();

    const layers = order();
    expect(layers.indexOf(SATELLITE_LAYER)).toBe(
      layers.indexOf("background") + 1,
    );
    expect(layers[layers.indexOf(SATELLITE_LAYER) + 1]).toBe(
      MAP_LAYERS.aviation,
    );
  });

  it("goes above CARTO's ground and below its roads and labels, with its borders lifted above it", async () => {
    swapBaseStyle(CARTO_LIKE);
    followSatellite(asMapApp(app));
    await settle();

    app.satelliteVisible = true;

    expect(order().slice(0, 13)).toEqual([
      "background",
      "landcover",
      "landuse",
      "waterway",
      "water",
      SATELLITE_LAYER,
      "boundary_county",
      "boundary_state",
      "aeroway-runway",
      "road_pri_fill",
      "building",
      "boundary_country",
      MAP_LAYERS.aviation,
    ]);
    expect(order().indexOf("place_town")).toBeGreaterThan(
      order().indexOf(MAP_LAYERS.replayTrailRibbons),
    );
  });

  it("puts CARTO's borders back below the water while it is off", async () => {
    swapBaseStyle(CARTO_LIKE);
    const carto = order();
    followSatellite(asMapApp(app));
    await settle();

    app.satelliteVisible = true;
    app.satelliteVisible = false;
    expect(order().filter((id) => id !== SATELLITE_LAYER)).toEqual(carto);

    app.satelliteVisible = true;
    expect(order().slice(5, 8)).toEqual([
      SATELLITE_LAYER,
      "boundary_county",
      "boundary_state",
    ]);

    // A new base style has its borders in place; off, they stay there
    swapBaseStyle({ ...CARTO_LIKE, layers: [...CARTO_LIKE.layers] });
    expect(order().slice(5, 8)).toEqual([
      SATELLITE_LAYER,
      "boundary_county",
      "boundary_state",
    ]);
    app.satelliteVisible = false;
    expect(order().filter((id) => id !== SATELLITE_LAYER)).toEqual(carto);
  });

  it("goes back into a new base style, with its source and tiles kept", async () => {
    app.satelliteVisible = true;
    followSatellite(asMapApp(app));
    await settle();
    const source = map().source(MAP_SOURCES.satellite);

    swapBaseStyle(CARTO_LIKE);

    expect(map().source(MAP_SOURCES.satellite)).toBe(source);
    expect(order().indexOf(SATELLITE_LAYER)).toBe(order().indexOf("water") + 1);

    // Off, a new style leaves it out until the switch is on again
    app.satelliteVisible = false;
    swapBaseStyle({ ...CARTO_LIKE, layers: [...CARTO_LIKE.layers] });
    expect(map().getLayer(SATELLITE_LAYER)).toBeUndefined();
    app.satelliteVisible = true;
    expect(visibility()).not.toBe("none");
  });

  it("stays below the shading of the relief, whichever comes first", async () => {
    app.satelliteVisible = true;
    followSatellite(asMapApp(app));
    await settle();

    app.reliefShaded = true;
    followTerrain(asMapApp(app));
    await settle();

    const layers = order();
    expect(layers.indexOf("terrain-hillshade")).toBe(
      layers.indexOf(SATELLITE_LAYER) + 1,
    );

    // A new base style drops both; the imagery comes back below the shading
    swapBaseStyle(CARTO_LIKE);
    const swapped = order();
    expect(swapped.indexOf(SATELLITE_LAYER)).toBeLessThan(
      swapped.indexOf("terrain-hillshade"),
    );
  });

  it("stops following the map with the app", async () => {
    const lifetime = new AbortController();
    app = createMockApp({ signal: lifetime.signal });
    app.satelliteVisible = true;
    followSatellite(asMapApp(app));
    await settle();

    lifetime.abort();
    swapBaseStyle(CARTO_LIKE);

    expect(map().getLayer(SATELLITE_LAYER)).toBeUndefined();
  });

  it("does nothing on an app without a map", () => {
    const bare = createMockApp({ map: null });

    expect(() => followSatellite(asMapApp(bare))).not.toThrow();
  });
});
