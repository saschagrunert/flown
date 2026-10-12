/**
 * What the layers show follows from the store: the user's layer flags and
 * whether a replay runs. Wired with a real layer manager, so the colour
 * layers are drawn and cleared for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  dimsHeatCloud,
  dimsHeatmap,
  followLayerVisibility,
  highlightsSelection,
  setColorLayer,
} from "../../../../flown/frontend/ui/layerVisibility";
import { LayerManager } from "../../../../flown/frontend/ui/layerManager";
import {
  AVIATION_SHOWN_STATE,
  HEAT_SHOWN_STATE,
} from "../../../../flown/frontend/mapLayers";
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
  type MockApp,
} from "../../testHelpers";

describe("layer visibility", () => {
  let app: MockApp;
  let unmount: () => void;

  const visibility = (id: string): unknown =>
    app.map!.layer(id).layout["visibility"];
  const runs = (source: string): number =>
    (app.map!.source(source).data as GeoJSON.FeatureCollection).features.length;
  /** What the map shows, layer by layer */
  const shown = (): Record<string, unknown> => ({
    heatmap: visibility(MAP_LAYERS.heat),
    altitude: visibility(MAP_LAYERS.pathsAltitude),
    airspeed: visibility(MAP_LAYERS.pathsAirspeed),
    airports: app.airportLayer.isVisible(),
    aviation: visibility(MAP_LAYERS.aviation),
  });

  beforeEach(() => {
    unmount = mountElements({
      "heatmap-btn": "button",
      "altitude-legend": "div",
      "heat-legend": "div",
    });
    app = createMockApp({
      currentData: createDataset(
        [{ id: 1, year: 2025 }],
        [createSegment({ path_id: 1 })],
      ),
    });
    app.layerManager = new LayerManager(
      asMapApp(app),
    ) as unknown as MockApp["layerManager"];
    app.dataManager.showHeatmap.mockImplementation(() =>
      app.heatmapLayer.setVisible(true),
    );
  });

  afterEach(() => {
    unmount();
  });

  it("shows what the store holds from the start", () => {
    app.store.batch(() => {
      app.heatmapVisible = false;
      app.airspeedVisible = true;
      app.airportsVisible = false;
      app.aviationVisible = true;
    });

    followLayerVisibility(asMapApp(app));

    expect(shown()).toEqual({
      heatmap: "none",
      altitude: "none",
      airspeed: "visible",
      airports: false,
      aviation: "visible",
    });
    expect(runs(MAP_SOURCES.pathsAirspeed)).toBeGreaterThan(0);
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
  });

  it("hides the heatmap and the colour layers for a replay, and keeps the flags", () => {
    app.altitudeVisible = true;
    app.aviationVisible = true;
    followLayerVisibility(asMapApp(app));
    const drawn = runs(MAP_SOURCES.pathsAltitude);

    app.replayActive = true;

    expect(shown()).toEqual({
      heatmap: "none",
      altitude: "none",
      airspeed: "none",
      airports: true,
      aviation: "visible",
    });
    expect(app.heatmapVisible).toBe(true);
    expect(app.altitudeVisible).toBe(true);
    // Hidden, not cleared: it comes back as it was
    expect(runs(MAP_SOURCES.pathsAltitude)).toBe(drawn);
    // The heatmap's toggle does not claim a layer the replay hides
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
    expect(el("heatmap-btn").classList.contains("active")).toBe(false);
  });

  it("brings back exactly what the user chose, changes made during the replay included", () => {
    app.store.batch(() => {
      app.heatmapVisible = false;
      app.airspeedVisible = true;
    });
    followLayerVisibility(asMapApp(app));
    app.replayActive = true;

    // The colour toggles stay usable while the replay runs
    setColorLayer(asMapApp(app), "altitude", true);
    app.replayActive = false;

    expect(shown()).toEqual({
      heatmap: "none",
      altitude: "visible",
      airspeed: "none",
      airports: true,
      aviation: "none",
    });
    expect(runs(MAP_SOURCES.pathsAltitude)).toBeGreaterThan(0);
    expect(runs(MAP_SOURCES.pathsAirspeed)).toBe(0);
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
  });

  it("shows the heatmap through the data manager once the replay ends", () => {
    followLayerVisibility(asMapApp(app));
    app.replayActive = true;
    app.dataManager.showHeatmap.mockClear();

    app.replayActive = false;

    expect(app.dataManager.showHeatmap).toHaveBeenCalledTimes(1);
    expect(visibility(MAP_LAYERS.heat)).toBe("visible");
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("true");
  });

  it("steps the flat heatmap aside while the 3D view draws the heat as a cloud, and keeps its switch on", () => {
    followLayerVisibility(asMapApp(app));
    expect(visibility(MAP_LAYERS.heat)).toBe("visible");

    app.store.set("heatCloud", true);
    for (const id of app.heatmapLayer.ids) {
      expect(visibility(id), id).toBe("none");
    }
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("true");
    expect(app.heatmapVisible).toBe(true);

    // Off and on again: the cloud's to show, not the flat heatmap's
    app.heatmapVisible = false;
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
    app.heatmapVisible = true;
    expect(visibility(MAP_LAYERS.heat)).toBe("none");

    app.dataManager.showHeatmap.mockClear();
    app.store.set("heatCloud", false);
    expect(app.dataManager.showHeatmap).toHaveBeenCalledTimes(1);
    expect(visibility(MAP_LAYERS.heat)).toBe("visible");
  });

  it("reports the heatmap on through a replay while the 3D view's cloud still draws it", () => {
    followLayerVisibility(asMapApp(app));
    app.store.batch(() => {
      app.store.set("heatCloud", true);
      app.replayActive = true;
    });
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("true");
    for (const id of app.heatmapLayer.ids) {
      expect(visibility(id), id).toBe("none");
    }

    // Off, the cloud draws nothing either
    app.heatmapVisible = false;
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
    app.heatmapVisible = true;
    // Nor where it did not work and the flat heatmap stays hidden
    app.store.set("heatCloud", false);
    expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
  });

  it("draws a colour layer anew as the replay ends", () => {
    // Its legend shows the range of the replayed flight until then
    app.altitudeVisible = true;
    followLayerVisibility(asMapApp(app));
    app.replayActive = true;
    const setData = app.map!.source(MAP_SOURCES.pathsAltitude).setData;
    setData.mockClear();

    app.replayActive = false;

    expect(setData).toHaveBeenCalled();
  });

  it("shows the altitude scale for a replay trail coloured by altitude", () => {
    followLayerVisibility(asMapApp(app));
    const legend = el("altitude-legend");
    expect(legend.hidden).toBe(true);

    app.replayActive = true;
    expect(legend.hidden).toBe(false);

    // The speed layer colours the trail by speed
    setColorLayer(asMapApp(app), "airspeed", true);
    expect(legend.hidden).toBe(true);

    setColorLayer(asMapApp(app), "airspeed", false);
    app.replayActive = false;
    expect(legend.hidden).toBe(true);
  });

  it("shows no altitude scale for the replay of every flight, whose trails take no colours", () => {
    followLayerVisibility(asMapApp(app));
    const legend = el("altitude-legend");

    app.replayState.all = true;
    app.replayActive = true;
    expect(legend.hidden).toBe(true);

    app.replayActive = false;
    app.replayState.all = false;
  });

  it("shows the heat's legend while the heat is the colour the map shows", () => {
    const legend = el("heat-legend");
    legend.hidden = true;
    followLayerVisibility(asMapApp(app));
    expect(app.heatmapVisible).toBe(true);
    expect(legend.hidden).toBe(false);

    app.heatmapVisible = false;
    expect(legend.hidden).toBe(true);
    app.heatmapVisible = true;
    expect(legend.hidden).toBe(false);

    // A colour layer brings its own legend, and a replay hides the heat
    for (const key of [
      "altitudeVisible",
      "airspeedVisible",
      "replayActive",
    ] as const) {
      app[key] = true;
      expect(legend.hidden, key).toBe(true);
      app[key] = false;
      expect(legend.hidden, key).toBe(false);
    }

    // The cloud of the 3D view draws the heat in the same colours
    app.heatCloud = true;
    expect(legend.hidden).toBe(false);
  });

  it("fades the heat's legend with the heat", () => {
    const legend = el("heat-legend");
    followLayerVisibility(asMapApp(app));
    expect(legend.classList.contains("is-dimmed")).toBe(false);

    app.aviationVisible = true;
    expect(legend.classList.contains("is-dimmed")).toBe(true);
    app.aviationVisible = false;
    expect(legend.classList.contains("is-dimmed")).toBe(false);

    // The selection's lines are drawn over it
    app.selectedPathIds = new Set([1]);
    expect(legend.classList.contains("is-dimmed")).toBe(true);
  });

  it("fades the base map's labels while the heat is drawn at full strength", async () => {
    const faded = (): unknown => app.map!.getGlobalState()[HEAT_SHOWN_STATE];
    // At a zoom the aviation chart draws at
    app.map!.setZoom(8);
    followLayerVisibility(asMapApp(app));
    // Once the style is there
    await app.mapReady;
    expect(faded()).toBe(true);

    // Not while the heat steps back, is off, or a replay hides it. The
    // aviation chart has a state of its own, which the labels' paint
    // reads across the chart's band only (mapLayers.ts)
    const chart = (): unknown =>
      app.map!.getGlobalState()[AVIATION_SHOWN_STATE];
    expect(chart()).toBe(false);
    app.aviationVisible = true;
    expect(faded()).toBe(true);
    expect(chart()).toBe(true);
    app.aviationVisible = false;
    expect(chart()).toBe(false);
    app.altitudeVisible = true;
    expect(faded()).toBe(false);
    app.altitudeVisible = false;
    expect(faded()).toBe(true);
    app.heatmapVisible = false;
    expect(faded()).toBe(false);
    app.heatmapVisible = true;
    app.replayActive = true;
    expect(faded()).toBe(false);
    app.replayActive = false;
    // The cloud of the 3D view is the heat as well
    app.heatCloud = true;
    expect(faded()).toBe(true);

    // A style still loading takes no state, and nothing else fails
    app.map!.setGlobalStateProperty.mockImplementationOnce(() => {
      throw new Error("Style is not done loading.");
    });
    expect(() => (app.aviationVisible = true)).not.toThrow();
    expect(visibility(MAP_LAYERS.aviation)).toBe("visible");
    app.aviationVisible = false;

    // A style built anew starts from a state of its own, and is given the
    // one of now once it has loaded
    app.map!.globalState = {};
    app.map!.emit("style.load");
    expect(faded()).toBe(true);
  });

  it("dims the heatmap as the colour flags change", () => {
    followLayerVisibility(asMapApp(app));
    app.dataManager.applyHeatmapEmphasis.mockClear();

    app.altitudeVisible = true;

    expect(app.dataManager.applyHeatmapEmphasis).toHaveBeenCalledTimes(1);
  });

  describe("the selection's lines", () => {
    const highlight = (): unknown => visibility(MAP_LAYERS.selectionHighlight);

    // selected, altitude, airspeed, replay, isolate: shown
    it.each([
      [false, false, false, false, false, false],
      [true, false, false, false, false, true],
      [true, false, false, false, true, true],
      [true, true, false, false, false, false],
      [true, false, true, false, false, false],
      [true, false, true, false, true, false],
      [true, false, false, true, false, false],
      [true, true, false, true, false, false],
      [false, true, false, false, false, false],
    ])(
      "selection %s, altitude %s, speed %s, replay %s, isolate %s: shown %s",
      (selected, altitude, airspeed, replay, isolate, expected) => {
        app.store.batch(() => {
          if (selected) {
            app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
          }
          app.altitudeVisible = altitude;
          app.airspeedVisible = airspeed;
          app.replayActive = replay;
          app.isolateSelection = isolate;
        });

        followLayerVisibility(asMapApp(app));

        expect(highlightsSelection(asMapApp(app))).toBe(expected);
        expect(highlight()).toEqual(expected ? "visible" : "none");
        // The heatmap steps back for exactly what is drawn over it
        expect(dimsHeatmap(asMapApp(app))).toBe(
          expected || altitude || airspeed,
        );
      },
    );

    it("dim the heatmap under the aviation chart too", () => {
      followLayerVisibility(asMapApp(app));
      app.dataManager.applyHeatmapEmphasis.mockClear();

      // Its airspace outlines drowned under the bloom (regression)
      app.aviationVisible = true;
      expect(dimsHeatmap(asMapApp(app))).toBe(true);
      expect(app.dataManager.applyHeatmapEmphasis).toHaveBeenCalledTimes(1);

      app.aviationVisible = false;
      expect(dimsHeatmap(asMapApp(app))).toBe(false);
    });

    it("dim the heat for the aviation chart only where it draws", async () => {
      // It has tiles from zoom 6 to 13: the heat dimmed above and below
      // for a chart that was not there
      const legend = el("heat-legend");
      const faded = (): unknown => app.map!.getGlobalState()[HEAT_SHOWN_STATE];
      const map = app.map!;
      map.setZoom(4);
      followLayerVisibility(asMapApp(app));
      await app.mapReady;
      app.aviationVisible = true;
      expect(dimsHeatmap(asMapApp(app))).toBe(false);
      expect(dimsHeatCloud(asMapApp(app))).toBe(false);
      expect(legend.classList.contains("is-dimmed")).toBe(false);
      expect(faded()).toBe(true);

      let before = false;
      for (const [zoom, dimmed] of [
        [6, true],
        [13, true],
        [13.5, false],
        [9, true],
        [5.9, false],
      ] as const) {
        app.dataManager.applyHeatmapEmphasis.mockClear();
        map.setZoom(zoom);
        map.emit("zoomend");
        expect(dimsHeatmap(asMapApp(app))).toBe(dimmed);
        expect(dimsHeatCloud(asMapApp(app))).toBe(dimmed);
        expect(legend.classList.contains("is-dimmed")).toBe(dimmed);
        // The labels follow the band in their paint, by zoom, in every
        // frame of a pinch: the state stays (see mapLayers.test.ts)
        expect(faded()).toBe(true);
        // Only a zoom into or out of the band changes something
        expect(app.dataManager.applyHeatmapEmphasis).toHaveBeenCalledTimes(
          dimmed === before ? 0 : 1,
        );
        before = dimmed;
      }
    });

    it("come and go with the selection, and dim the heatmap with them", () => {
      followLayerVisibility(asMapApp(app));
      app.dataManager.applyHeatmapEmphasis.mockClear();

      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      expect(highlight()).toBe("visible");
      expect(app.dataManager.applyHeatmapEmphasis).toHaveBeenCalledTimes(1);

      app.selectedPathIds = new Set();
      expect(highlight()).toBe("none");
      expect(dimsHeatmap(asMapApp(app))).toBe(false);
      expect(app.dataManager.applyHeatmapEmphasis).toHaveBeenCalledTimes(2);
    });

    it("give way to a colour layer and a replay, and come back after them", () => {
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      followLayerVisibility(asMapApp(app));
      expect(highlight()).toBe("visible");

      setColorLayer(asMapApp(app), "altitude", true);
      expect(highlight()).toBe("none");
      setColorLayer(asMapApp(app), "altitude", false);
      expect(highlight()).toBe("visible");

      app.replayActive = true;
      expect(highlight()).toBe("none");
      app.replayActive = false;
      expect(highlight()).toBe("visible");
    });
  });

  describe("setColorLayer", () => {
    it("switches the other colour layer off in the same update", () => {
      app.airspeedVisible = true;
      const listener = vi.fn();
      app.store.subscribeKeys(["altitudeVisible", "airspeedVisible"], listener);

      const replaced = setColorLayer(asMapApp(app), "altitude", true);

      expect(replaced).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(app.altitudeVisible).toBe(true);
      expect(app.airspeedVisible).toBe(false);
    });

    it("replaces nothing when the other one is off", () => {
      expect(setColorLayer(asMapApp(app), "airspeed", true)).toBe(false);
      expect(app.airspeedVisible).toBe(true);
    });

    it("leaves the other one alone when switching off", () => {
      app.altitudeVisible = true;

      expect(setColorLayer(asMapApp(app), "airspeed", false)).toBe(false);
      expect(app.altitudeVisible).toBe(true);
      expect(app.airspeedVisible).toBe(false);
    });
  });
});
