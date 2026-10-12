/**
 * UIToggles: the layer toggles. They only write the store; the layers, the
 * buttons and the legends follow it. That is wired here the way MapApp
 * wires it, with a real layer manager, and the tests read the map and the
 * DOM that result.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { UIToggles } from "../../../../flown/frontend/ui/uiToggles";
import { LayerManager } from "../../../../flown/frontend/ui/layerManager";
import { AIRPORTS_HIDDEN_CLASS } from "../../../../flown/frontend/mapLayers";
import {
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../flown/frontend/utils/constants";
import {
  asMapApp,
  createDataset,
  createMockApp,
  createSegment,
  el,
  mountElements,
  syncControlsWithStore,
  type MockApp,
} from "../../testHelpers";

const toastMock = vi.hoisted(() => ({ showToast: vi.fn() }));
vi.mock("../../../../flown/frontend/utils/toast", () => toastMock);

const DOM: Record<string, string> = {
  "heatmap-btn": "button",
  "altitude-btn": "button",
  "airspeed-btn": "button",
  "airports-btn": "button",
  "aviation-btn": "button",
  "altitude-legend": "div",
  "airspeed-legend": "div",
  map: "div",
};

describe("UIToggles layers", () => {
  let uiToggles: UIToggles;
  let app: MockApp;
  let unmount: () => void;

  /** The `visibility` the map holds for a layer */
  const visibility = (id: string): unknown =>
    app.map!.layer(id).layout["visibility"];
  /** How many runs a colour layer's main source holds */
  const runs = (source: string): number =>
    (app.map!.source(source).data as GeoJSON.FeatureCollection).features.length;

  beforeEach(() => {
    vi.clearAllMocks();
    unmount = mountElements(DOM);
    app = createMockApp({
      hasTimingData: true,
      currentData: createDataset(
        [{ id: 1, year: 2025 }],
        [createSegment({ path_id: 1 })],
      ),
    });
    app.layerManager = new LayerManager(
      asMapApp(app),
    ) as unknown as MockApp["layerManager"];
    // The data manager's part of showing the heatmap
    app.dataManager.showHeatmap.mockImplementation(() =>
      app.heatmapLayer.setVisible(true),
    );
    syncControlsWithStore(app);
    uiToggles = new UIToggles(asMapApp(app));
  });

  afterEach(() => {
    unmount();
  });

  describe("toggleHeatmap", () => {
    it("hides the heatmap and releases the button", () => {
      expect(visibility(MAP_LAYERS.heat)).toBe("visible");

      uiToggles.toggleHeatmap();

      expect(app.heatmapVisible).toBe(false);
      expect(visibility(MAP_LAYERS.heat)).toBe("none");
      expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
      expect(app.dataManager.showHeatmap).toHaveBeenCalledTimes(1);
    });

    it("shows it again through the data manager and lights the button", () => {
      uiToggles.toggleHeatmap();

      uiToggles.toggleHeatmap();

      expect(app.heatmapVisible).toBe(true);
      expect(app.dataManager.showHeatmap).toHaveBeenCalledTimes(2);
      expect(visibility(MAP_LAYERS.heat)).toBe("visible");
      expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("does nothing without a map", () => {
      app.map = null;

      uiToggles.toggleHeatmap();

      expect(app.heatmapVisible).toBe(true);
    });
  });

  describe("toggleAltitude", () => {
    it("shows altitude, drawn, with its button and legend", () => {
      uiToggles.toggleAltitude();

      expect(app.altitudeVisible).toBe(true);
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("visible");
      expect(visibility(MAP_LAYERS.pathsAltitudeSelected)).toBe("visible");
      expect(runs(MAP_SOURCES.pathsAltitude)).toBeGreaterThan(0);
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("true");
      expect(el("altitude-legend").hidden).toBe(false);
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("switches speed off in the same update, and says so", () => {
      uiToggles.toggleAirspeed();
      const seen: [boolean, boolean][] = [];
      app.store.subscribeKeys(["altitudeVisible", "airspeedVisible"], () =>
        seen.push([app.altitudeVisible, app.airspeedVisible]),
      );

      uiToggles.toggleAltitude();

      // Never both on, never both off on the way
      expect(seen).toEqual([[true, false]]);
      expect(visibility(MAP_LAYERS.pathsAirspeed)).toBe("none");
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("visible");
      // The layer it replaces lets go of its runs
      expect(runs(MAP_SOURCES.pathsAirspeed)).toBe(0);
      expect(el("airspeed-btn").getAttribute("aria-pressed")).toBe("false");
      expect(el("airspeed-legend").hidden).toBe(true);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Groundspeed off, colouring by altitude",
        "info",
      );
    });

    it("hides altitude and lets go of its runs", () => {
      uiToggles.toggleAltitude();

      uiToggles.toggleAltitude();

      expect(app.altitudeVisible).toBe(false);
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("none");
      // Kept, the features of a hidden layer held tens of MB
      expect(runs(MAP_SOURCES.pathsAltitude)).toBe(0);
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("false");
      expect(el("altitude-legend").hidden).toBe(true);
    });

    it("draws a layer anew each time it is shown", () => {
      uiToggles.toggleAltitude();
      uiToggles.toggleAltitude();
      uiToggles.toggleAltitude();

      expect(runs(MAP_SOURCES.pathsAltitude)).toBeGreaterThan(0);
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("visible");
    });

    it("does nothing without a map", () => {
      app.map = null;

      uiToggles.toggleAltitude();

      expect(app.altitudeVisible).toBe(false);
    });

    it("says it is on during a replay whose trail is in altitude colours", () => {
      app.replayActive = true;

      // Neither layer is on, and the trail and its legend are in altitude
      // colours: the toggle said off over them (regression)
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("true");
      expect(el("altitude-btn").classList.contains("active")).toBe(true);
      expect(el("altitude-legend").hidden).toBe(false);

      app.replayActive = false;

      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("false");
      expect(el("altitude-legend").hidden).toBe(true);
    });

    it("during a replay switches the trail to groundspeed, and back", () => {
      app.replayActive = true;

      // A plain flip of the flag changed nothing on screen: the trail is
      // always in one of the two colours
      uiToggles.toggleAltitude();

      expect(app.altitudeVisible).toBe(false);
      expect(app.airspeedVisible).toBe(true);
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("false");
      expect(el("airspeed-btn").getAttribute("aria-pressed")).toBe("true");

      uiToggles.toggleAltitude();

      expect(app.altitudeVisible).toBe(true);
      expect(app.airspeedVisible).toBe(false);
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("true");

      // The layer the choice left on waits for the end of the replay
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("none");
      app.replayActive = false;
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("visible");
      expect(runs(MAP_SOURCES.pathsAltitude)).toBeGreaterThan(0);
    });
  });

  describe("toggleAirspeed", () => {
    it("shows airspeed and switches altitude off", () => {
      uiToggles.toggleAltitude();
      toastMock.showToast.mockClear();

      uiToggles.toggleAirspeed();

      expect(app.altitudeVisible).toBe(false);
      expect(app.airspeedVisible).toBe(true);
      expect(visibility(MAP_LAYERS.pathsAltitude)).toBe("none");
      expect(visibility(MAP_LAYERS.pathsAirspeed)).toBe("visible");
      expect(visibility(MAP_LAYERS.pathsAirspeedSelected)).toBe("visible");
      expect(el("altitude-legend").hidden).toBe(true);
      expect(el("airspeed-btn").getAttribute("aria-pressed")).toBe("true");
      expect(el("airspeed-legend").hidden).toBe(false);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Altitude off, colouring by groundspeed",
        "info",
      );
    });

    it("hides airspeed when visible", () => {
      uiToggles.toggleAirspeed();

      uiToggles.toggleAirspeed();

      expect(app.airspeedVisible).toBe(false);
      expect(visibility(MAP_LAYERS.pathsAirspeed)).toBe("none");
      expect(el("airspeed-btn").getAttribute("aria-pressed")).toBe("false");
      expect(el("airspeed-legend").hidden).toBe(true);
    });

    it("does nothing without a map", () => {
      app.map = null;

      uiToggles.toggleAirspeed();

      expect(app.airspeedVisible).toBe(false);
    });

    it("says why it stays off without timing data, or while loading", () => {
      // The button is aria-disabled then, and a click still reaches it
      app.hasTimingData = false;

      uiToggles.toggleAirspeed();

      expect(app.airspeedVisible).toBe(false);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "No timing data in the flights",
      );

      app.isInitializing = true;
      uiToggles.toggleAirspeed();

      expect(app.airspeedVisible).toBe(false);
      expect(toastMock.showToast).toHaveBeenLastCalledWith(
        "Still loading the flights",
      );
    });
  });

  describe("toggleAirports", () => {
    it("hides airports when visible", () => {
      uiToggles.toggleAirports();

      expect(app.airportsVisible).toBe(false);
      expect(el("map").classList.contains(AIRPORTS_HIDDEN_CLASS)).toBe(true);
      expect(el("airports-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("shows airports when hidden", () => {
      uiToggles.toggleAirports();

      uiToggles.toggleAirports();

      expect(app.airportsVisible).toBe(true);
      expect(el("map").classList.contains(AIRPORTS_HIDDEN_CLASS)).toBe(false);
      expect(el("airports-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("does nothing without a map", () => {
      app.map = null;

      uiToggles.toggleAirports();

      expect(app.airportsVisible).toBe(true);
    });
  });

  describe("toggleAviation", () => {
    it("shows the aviation layer when hidden", () => {
      uiToggles.toggleAviation();

      expect(app.aviationVisible).toBe(true);
      expect(visibility(MAP_LAYERS.aviation)).toBe("visible");
      expect(el("aviation-btn").getAttribute("aria-pressed")).toBe("true");
    });

    it("hides the aviation layer when visible", () => {
      uiToggles.toggleAviation();

      uiToggles.toggleAviation();

      expect(app.aviationVisible).toBe(false);
      expect(visibility(MAP_LAYERS.aviation)).toBe("none");
      expect(el("aviation-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("does nothing without a map", () => {
      app.map = null;

      uiToggles.toggleAviation();

      expect(app.aviationVisible).toBe(false);
    });
  });
});
