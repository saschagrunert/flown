/**
 * The relief under the 3D view: the map following terrainActive,
 * reliefLevel and reliefShaded, the shading's place in the base map, and
 * the ribbons hidden while they settle on another ground. First through
 * followTerrain alone, then through the LayerManager, which loads the
 * relief's code with the feature bundle and cuts the flights on it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
import {
  followTerrain,
  HILLSHADE_LAYER,
} from "../../../../flown/frontend/ui/terrain";
import {
  followSatellite,
  SATELLITE_LAYER,
} from "../../../../flown/frontend/ui/satellite";
import { LayerManager } from "../../../../flown/frontend/ui/layerManager";
import { setBaseStyle } from "../../../../flown/frontend/mapLayers";
import {
  liftExaggeration,
  ribbonId,
} from "../../../../flown/frontend/calculations/lift";
import {
  ribbonHeightFt,
  ribbonHeights,
} from "../../../../flown/frontend/calculations/ribbonPaint";
import { RIBBON_SOURCES } from "../../../../flown/frontend/ui/reliefState";
import {
  groundedFlights,
  groundProfilesFt,
  heldGroundedFlights,
} from "../../../../flown/frontend/calculations/groundProfile";
import type { SmoothedFlights } from "../../../../flown/frontend/calculations/smoothing";
import type { PathSegment } from "../../../../flown/frontend/types";
import {
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../flown/frontend/utils/constants";
import {
  followContextLoss,
  REPLAY_CAMERA_MOVE,
} from "../../../../flown/frontend/utils/mapHelpers";
import {
  asMapApp,
  createDataset,
  createMockApp,
  createSegment,
  type MockApp,
} from "../../testHelpers";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";
import {
  ALTITUDE,
  ALTITUDE_SELECTED,
  drawMode,
  endZoom,
  layerManagerHelpers,
  setupLayerManager,
  teardownLayerManager,
} from "./layerManagerTestSetup";

/**
 * A base style shaped like CARTO's dark matter: the ground (land cover, land
 * use, water) with borders among it, then the runways, roads, bridges and
 * buildings, which are area fills as well, then the labels
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
        ["boundary_county", "line", "boundary"],
        ["water", "fill", "water"],
        ["aeroway-runway", "fill", "aeroway"],
        ["road_pri_fill", "line", "transportation"],
        ["bridge_mot_fill", "line", "transportation"],
        ["building", "fill", "building"],
        ["building-top", "fill", "building"],
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

/** The trail's opacity as addDataLayers creates it */
const TRAIL_OPACITY = 0.8;

/** The opacity of the ribbons of a selection, as addDataLayers creates it */
const SELECTION_OPACITY = 0.9;

describe("the relief", () => {
  let app: MockApp;
  let lifetime: AbortController;

  const map = (): NonNullable<MockApp["map"]> => app.map!;
  const order = (): string[] => map().getLayersOrder();
  const trailOpacity = (): unknown =>
    map().getPaintProperty(
      MAP_SOURCES.replayTrailRibbons,
      "fill-extrusion-opacity",
    );
  const selectionOpacity = (): unknown =>
    map().getPaintProperty(
      MAP_LAYERS.selectionHighlightRibbons,
      "fill-extrusion-opacity",
    );

  /** Follow the store, once the map is ready */
  async function follow(): Promise<void> {
    followTerrain(asMapApp(app));
    await app.mapReady;
  }

  /** Swap the base style as MapApp does when CARTO's arrives */
  function swapBaseStyle(style: StyleSpecification): void {
    setBaseStyle(map() as unknown as MapLibreMap, style);
    map().emit("styledata");
  }

  beforeEach(() => {
    lifetime = new AbortController();
    app = createMockApp({ signal: lifetime.signal });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMapLibreMock();
  });

  describe("its shading", () => {
    it("lies right above the ground of the base map, below its runways, roads and buildings", async () => {
      swapBaseStyle(CARTO_LIKE);
      app.reliefShaded = true;

      await follow();

      const layers = order();
      expect(layers.indexOf(HILLSHADE_LAYER)).toBe(layers.indexOf("water") + 1);
      expect(layers[layers.indexOf(HILLSHADE_LAYER) + 1]).toBe(
        "aeroway-runway",
      );
      expect(layers.indexOf(HILLSHADE_LAYER)).toBeLessThan(
        layers.indexOf(MAP_LAYERS.aviation),
      );
    });

    it("lies right above the satellite imagery and the borders lifted over it, whichever comes first", async () => {
      const shadeOver = (): string[] => {
        const layers = order();
        const water = layers.indexOf("water");
        return layers.slice(water, water + 5);
      };
      const expected = [
        "water",
        SATELLITE_LAYER,
        "boundary_county",
        HILLSHADE_LAYER,
        "aeroway-runway",
      ];
      swapBaseStyle(CARTO_LIKE);
      app.satelliteVisible = true;
      followSatellite(asMapApp(app));
      app.reliefShaded = true;
      await follow();
      expect(shadeOver()).toEqual(expected);

      // The shading first, then the imagery
      resetMapLibreMock();
      app = createMockApp();
      swapBaseStyle(CARTO_LIKE);
      app.reliefShaded = true;
      await follow();
      app.satelliteVisible = true;
      followSatellite(asMapApp(app));
      await app.mapReady;
      expect(shadeOver()).toEqual(expected);
    });

    it("lies right above the background of the map's own style", async () => {
      app.reliefShaded = true;

      await follow();

      expect(order().slice(0, 3)).toEqual([
        "background",
        HILLSHADE_LAYER,
        MAP_LAYERS.aviation,
      ]);
    });

    it("goes back into a new base style, where it belongs in it", async () => {
      app.reliefShaded = true;
      await follow();

      swapBaseStyle(CARTO_LIKE);

      expect(order().indexOf(HILLSHADE_LAYER)).toBe(
        order().indexOf("water") + 1,
      );
      // Its elevation tiles are carried over, not made anew
      expect(map().source(MAP_SOURCES.terrain).spec).toMatchObject({
        type: "raster-dem",
      });
    });
  });

  describe("the ribbons as the ground changes", () => {
    it("hide, the trail's and the selection's too, until the map has drawn them on the new ground", async () => {
      await follow();
      map().isSourceLoaded.mockReturnValue(false);

      const restyle = vi.fn();
      app.relief.onRibbonsShown(restyle);
      app.terrainActive = true;

      expect(app.relief.ribbonsShown).toBe(0);
      expect(restyle).toHaveBeenCalledTimes(1);
      expect(trailOpacity()).toBe(0);
      expect(selectionOpacity()).toBe(0);

      // Asked after every frame, until the tiles have landed
      map().emit("render");
      expect(app.relief.ribbonsShown).toBe(0);
      map().isSourceLoaded.mockReturnValue(true);
      map().emit("render");

      expect(app.relief.ribbonsShown).toBe(1);
      expect(restyle).toHaveBeenCalledTimes(2);
      expect(trailOpacity()).toBe(TRAIL_OPACITY);
      expect(selectionOpacity()).toBe(SELECTION_OPACITY);
      expect(map().listenerCount("render")).toBe(0);
    });

    it("show on whatever ground has landed after a while, a change starting the wait anew", async () => {
      vi.useFakeTimers();
      await follow();
      map().isSourceLoaded.mockReturnValue(false);

      app.terrainActive = true;
      vi.advanceTimersByTime(2000);
      app.reliefLevel = 9;
      vi.advanceTimersByTime(2999);
      expect(app.relief.ribbonsShown).toBe(0);

      vi.advanceTimersByTime(1);
      expect(app.relief.ribbonsShown).toBe(1);
      expect(trailOpacity()).toBe(TRAIL_OPACITY);
      // Only the ribbons' exaggeration waits on, for them to land (see
      // exaggerateRibbons)
      expect(map().listenerCount("render")).toBe(1);
      map().isSourceLoaded.mockReturnValue(true);
      map().emit("render");
      expect(map().listenerCount("render")).toBe(0);
    });
  });

  describe("while a replay plays", () => {
    /** The trail, written anew in every frame, never has all its tiles */
    const trailNeverLoaded = (): void => {
      map().isSourceLoaded.mockImplementation(
        (id: string) => id !== MAP_SOURCES.replayTrailRibbons,
      );
    };

    it("show as soon as the flights have landed, not after the longest wait", async () => {
      vi.useFakeTimers();
      await follow();
      app.replayState.playing = true;
      trailNeverLoaded();

      app.reliefLevel = 9;
      expect(app.relief.ribbonsShown).toBe(0);
      map().emit("render");

      expect(app.relief.ribbonsShown).toBe(1);
      expect(trailOpacity()).toBe(TRAIL_OPACITY);
      // The cuts of the levels before are let go of as well
      expect(map().listenerCount("render")).toBe(0);
    });

    it("wait for the trail once the replay is paused, which writes it no more", async () => {
      vi.useFakeTimers();
      await follow();
      app.replayState.playing = false;
      trailNeverLoaded();

      app.reliefLevel = 9;
      map().emit("render");

      expect(app.relief.ribbonsShown).toBe(0);
      map().isSourceLoaded.mockReturnValue(true);
      map().emit("render");
      expect(app.relief.ribbonsShown).toBe(1);
    });
  });

  it("gives every layer of ribbons the paint that lifts them, which the map creates them without", async () => {
    const paint = (id: string): unknown[] => [
      map().getPaintProperty(id, "fill-extrusion-base"),
      map().getPaintProperty(id, "fill-extrusion-height"),
    ];
    for (const id of RIBBON_SOURCES) {
      expect(paint(id)).toEqual([undefined, undefined]);
    }

    await follow();

    const { base, height } = ribbonHeights();
    for (const id of RIBBON_SOURCES) expect(paint(id)).toEqual([base, height]);
    // A new base style keeps it (see withDataLayers)
    swapBaseStyle(CARTO_LIKE);
    for (const id of RIBBON_SOURCES) expect(paint(id)).toEqual([base, height]);
    // A style built anew without it (restored after a lost WebGL context,
    // or a base style the map could not apply as a difference) gets it
    // again as it loads
    for (const id of RIBBON_SOURCES) {
      map().setPaintProperty(id, "fill-extrusion-base", undefined);
      map().setPaintProperty(id, "fill-extrusion-height", undefined);
    }
    map().emit("styledata");
    for (const id of RIBBON_SOURCES) expect(paint(id)).toEqual([base, height]);
    // A style event of a style that kept it sets nothing again
    map().setPaintProperty.mockClear();
    map().emit("styledata");
    expect(map().setPaintProperty).not.toHaveBeenCalledWith(
      expect.anything(),
      "fill-extrusion-height",
      expect.anything(),
      expect.anything(),
    );
  });

  it("gives the trail and the selection their opacity again after a lost WebGL context", async () => {
    // Hidden as the context is lost, and shown by the longest wait during
    // the loss: MapLibre restores the style of the loss, the trail hidden
    vi.useFakeTimers();
    // As MapApp does it, before anyone else listens to the map
    followContextLoss(map() as unknown as MapLibreMap);
    await follow();
    map().isSourceLoaded.mockReturnValue(false);
    app.terrainActive = true;
    expect(trailOpacity()).toBe(0);
    map().emit("webglcontextlost");
    vi.advanceTimersByTime(3000);
    expect(app.relief.ribbonsShown).toBe(1);
    // The map had no style to take it
    expect(trailOpacity()).toBe(0);
    expect(selectionOpacity()).toBe(0);

    map().emit("webglcontextrestored");
    map().emit("style.load");

    expect(trailOpacity()).toBe(TRAIL_OPACITY);
    expect(selectionOpacity()).toBe(SELECTION_OPACITY);
  });

  describe("the far labels of a tilted view", () => {
    const start = (id: string): unknown => map().getLayer(id)?.minzoom;

    it("leave the coarse tiles towards the horizon, and come back as the map lies flat", async () => {
      swapBaseStyle(CARTO_LIKE);
      await follow();
      app.terrainActive = true;
      map().jumpTo({ zoom: 6.5, pitch: 70 });
      map().emit("moveend");

      // Only in tiles at most a level coarser than the map
      expect(start("place_town")).toBe(5);
      // The app's own labels keep their range
      expect(start(MAP_LAYERS.airportLabels)).not.toBe(5);

      map().jumpTo({ zoom: 9.2 });
      map().emit("moveend");
      expect(start("place_town")).toBe(8);

      map().jumpTo({ pitch: 30 });
      map().emit("moveend");
      expect(start("place_town")).toBe(0);
    });

    it("follow the replay's camera, walked only for another zoom level or tilt", async () => {
      swapBaseStyle(CARTO_LIKE);
      await follow();
      app.terrainActive = true;
      // A chase flies for minutes without a rest
      map().jumpTo({ zoom: 6.5, pitch: 70 });
      map().emit("moveend", REPLAY_CAMERA_MOVE);
      expect(start("place_town")).toBe(5);

      const walks = vi.spyOn(map(), "getLayersOrder");
      walks.mockClear();
      map().jumpTo({ zoom: 6.9 });
      map().emit("moveend", REPLAY_CAMERA_MOVE);
      expect(walks).not.toHaveBeenCalled();

      map().jumpTo({ zoom: 9.2 });
      map().emit("moveend", REPLAY_CAMERA_MOVE);
      expect(start("place_town")).toBe(8);
    });

    it("come back after a lost WebGL context built the layers anew where the walk had them", async () => {
      swapBaseStyle(CARTO_LIKE);
      await follow();
      app.terrainActive = true;
      map().jumpTo({ zoom: 9.2, pitch: 70 });
      map().emit("moveend");
      expect(start("place_town")).toBe(8);

      // MapLibre builds the style it kept anew, as new layer objects
      map().layers = map().layers.map((layer) => ({ ...layer }));
      map().emit("styledata");
      expect(start("place_town")).toBe(8);

      map().jumpTo({ pitch: 30 });
      map().emit("moveend");
      expect(start("place_town")).toBe(0);
    });

    it("are left alone off the relief, and in a new base style too", async () => {
      await follow();
      map().jumpTo({ zoom: 6.5, pitch: 70 });
      swapBaseStyle(CARTO_LIKE);
      map().emit("moveend");
      expect(start("place_town")).toBeUndefined();

      app.terrainActive = true;
      swapBaseStyle(CARTO_LIKE);
      expect(start("place_town")).toBe(5);
      // Laid out anew only when the level changes
      map().setLayerZoomRange.mockClear();
      map().emit("moveend");
      expect(map().setLayerZoomRange).not.toHaveBeenCalled();
    });
  });

  it("is built anew after a lost WebGL context", async () => {
    app.reliefLevel = 11;
    app.terrainActive = true;
    await follow();
    map().setTerrain.mockClear();

    map().emit("webglcontextrestored");
    map().emit("style.load");

    expect(map().setTerrain.mock.calls).toEqual([
      [null],
      [{ source: MAP_SOURCES.terrain, exaggeration: liftExaggeration(11) }],
    ]);
  });

  it("has the markers follow the ground at the end of a move, not at every frame of the replay's camera", async () => {
    app.terrainActive = true;
    await follow();
    const terrainEvents = (): number =>
      map().fire.mock.calls.filter(([type]) => type === "terrain").length;

    map().emit("moveend", REPLAY_CAMERA_MOVE);
    expect(terrainEvents()).toBe(0);

    map().emit("moveend");
    expect(terrainEvents()).toBe(1);
  });

  it("stops following the map with the app", async () => {
    vi.useFakeTimers();
    app.terrainActive = true;
    app.reliefShaded = true;
    await follow();
    map().isSourceLoaded.mockReturnValue(false);
    app.reliefLevel = 9;
    map().setTerrain.mockClear();

    lifetime.abort();
    map().emit("moveend");
    swapBaseStyle(CARTO_LIKE);
    map().emit("webglcontextrestored");
    map().emit("style.load");
    vi.advanceTimersByTime(5000);

    expect(map().fire).not.toHaveBeenCalledWith("terrain");
    expect(map().getLayer(HILLSHADE_LAYER)).toBeUndefined();
    expect(map().setTerrain).not.toHaveBeenCalled();
    expect(map().listenerCount("render")).toBe(0);
    // Nothing shows the ribbons for a map the app has let go of
    expect(app.relief.ribbonsShown).toBe(0);
  });
});

const featureBundle = vi.hoisted(() => ({
  available: true,
  held: false,
  followHeatCloud: vi.fn(),
  followSelectionRibbons: vi.fn(),
}));
vi.mock("../../../../flown/frontend/services/featureLoader", async () => {
  const { followTerrain } =
    await import("../../../../flown/frontend/ui/terrain");
  const { ribbonBox, ribbonFeatures, ribbonLiftPx, viewLeaves } =
    await import("../../../../flown/frontend/ui/pathRibbons");
  const { followsLevel } =
    await import("../../../../flown/frontend/calculations/lift");
  const { heldGroundedFlights, releaseGroundedFlights, releaseGroundProfiles } =
    await import("../../../../flown/frontend/calculations/groundProfile");
  const { followHeatCloud, followSelectionRibbons } = featureBundle;
  const bundle = {
    followTerrain,
    followHeatCloud,
    followSelectionRibbons,
    ribbonFeatures,
    ribbonBox,
    ribbonLiftPx,
    viewLeaves,
    followsLevel,
    heldGroundedFlights,
    releaseGroundedFlights,
    releaseGroundProfiles,
  };
  return {
    loadedFeatures: () =>
      featureBundle.available && !featureBundle.held ? bundle : null,
    loadFeatures: vi.fn(() =>
      featureBundle.held
        ? new Promise<never>(() => {})
        : Promise.resolve(featureBundle.available ? bundle : null),
    ),
  };
});

describe("LayerManager on the relief", () => {
  let layerManager: LayerManager;
  let mockApp: MockApp;
  /** Callbacks waiting for the next animation frame, by their handle */
  let frames: Map<number, FrameRequestCallback>;
  const { features, setDataCalls, rendered, pointAt, settled } =
    layerManagerHelpers({
      get layerManager() {
        return layerManager;
      },
      get mockApp() {
        return mockApp;
      },
      get frames() {
        return frames;
      },
    });

  beforeEach(() => {
    featureBundle.held = false;
    ({ layerManager, mockApp, frames } = setupLayerManager());
  });

  afterEach(() => teardownLayerManager(layerManager));

  describe("the relief of the 3D view", () => {
    const RIBBONS = "paths-altitude-3d";

    beforeEach(() => {
      featureBundle.available = true;
      // The relief's code hides and shows the ribbons through the manager
      (mockApp as unknown as { layerManager: LayerManager }).layerManager =
        layerManager;
    });

    /**
     * A level flight at 3,000 ft over ground the build sampled at 1,000 ft,
     * between fields it taxied at at 400 ft, lifted at map zoom `zoom`, or
     * without `threeD` drawn flat there
     */
    async function drawOverHills(zoom: number, threeD = true): Promise<void> {
      const taxi = (from: number, lng: number): PathSegment =>
        createSegment({
          path_id: 1,
          altitude_ft: 400,
          groundspeed_knots: 10,
          ground_ft: 1000,
          coords: [
            [48, from],
            [48, lng],
          ],
        });
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        [
          taxi(16, 16.001),
          taxi(16.001, 16.002),
          taxi(16.002, 16.003),
          ...[0, 1, 2].map((i) =>
            createSegment({
              path_id: 1,
              altitude_ft: 3000,
              groundspeed_knots: 100,
              ground_ft: 1000,
              coords: [
                [48, 16.003 + i * 0.01],
                [48, 16.013 + i * 0.01],
              ],
            }),
          ),
          taxi(16.033, 16.034),
          taxi(16.034, 16.035),
          taxi(16.035, 16.036),
        ],
      );
      mockApp.map!.jumpTo({ zoom, pitch: 60, center: [16.018, 48] });
      mockApp.altitudeVisible = true;
      mockApp.altitudeLayer.setVisible(true);
      mockApp.store.set("threeDVisible", threeD);
      drawMode(layerManager, "altitude");
      // The relief's code arrives with the feature bundle
      await new Promise((resolve) => setTimeout(resolve));
    }

    const heights = (): number[] =>
      features(RIBBONS).map((ribbon) => ribbon.properties.h ?? NaN);
    const opacity = (): unknown =>
      mockApp.map!.layer(RIBBONS).paint["fill-extrusion-opacity"];

    it("draws the relief for a 3D view the page opened with (regression)", async () => {
      featureBundle.followHeatCloud.mockClear();
      // A link or a restored session: 3D and the zoom are set before the
      // manager exists, and the map fires no zoomend for them
      layerManager.destroy();
      mockApp.map!.jumpTo({ zoom: 11, pitch: 60 });
      mockApp.store.set("threeDVisible", true);

      layerManager = new LayerManager(asMapApp(mockApp));
      (mockApp as unknown as { layerManager: LayerManager }).layerManager =
        layerManager;
      await new Promise((resolve) => setTimeout(resolve));

      expect(mockApp.terrainActive).toBe(true);
      expect(mockApp.map!.getTerrain()).not.toBeNull();
      // The heat cloud comes with the relief's code, once
      expect(featureBundle.followHeatCloud).toHaveBeenCalledExactlyOnceWith(
        mockApp,
      );
    });

    /** The exaggerations of the levels the ribbons were cut for */
    const exaggerations = (): Set<number | undefined> =>
      new Set(
        features(RIBBONS).map((ribbon) =>
          ribbon.properties.l === undefined
            ? undefined
            : liftExaggeration(ribbon.properties.l),
        ),
      );

    it("draws the relief at every zoom, exaggerated as the flights, and stands them on the sampled ground", async () => {
      await drawOverHills(11);
      for (const zoom of [11, 4.5]) {
        mockApp.map!.jumpTo({ zoom });
        await endZoom(mockApp.map!);

        expect(mockApp.terrainActive).toBe(true);
        expect(mockApp.map!.getTerrain()).toEqual({
          source: "terrain",
          exaggeration: liftExaggeration(Math.floor(zoom)),
        });
        expect(exaggerations()).toEqual(
          new Set([liftExaggeration(Math.floor(zoom))]),
        );
        // 2,000 ft over the relief, which the map adds itself
        expect(Math.max(...heights())).toBeCloseTo(2000, 6);
      }
      expect(mockApp.map!.source("terrain").spec).toMatchObject({
        type: "raster-dem",
        encoding: "terrarium",
      });
    });

    it("has the markers follow the ground a move ends on, while the relief is drawn", async () => {
      await drawOverHills(11);
      const fired = vi.fn();
      mockApp.map!.on("terrain", fired);
      mockApp.map!.emit("moveend");
      expect(fired).toHaveBeenCalledTimes(1);

      mockApp.globeVisible = true;
      mockApp.map!.emit("moveend");
      expect(fired).toHaveBeenCalledTimes(1);
    });

    /** How many features each write to the ribbons had, in order */
    const writes = (): number[] =>
      mockApp
        .map!.source(RIBBONS)
        .setData.mock.calls.map(
          ([data]) => (data as GeoJSON.FeatureCollection).features.length,
        );

    it("cuts the flights once, on the relief, as the 3D view comes on with them", async () => {
      // Flat first, the colour layer off
      await drawOverHills(11, false);
      mockApp.altitudeVisible = false;
      layerManager.syncModes();
      const before = writes().length;

      // The 3D view shows the flights, in one update of the store, before
      // the relief's code has arrived
      mockApp.store.set("threeDVisible", true);
      mockApp.altitudeVisible = true;
      layerManager.syncModes();
      expect(writes().slice(before)).toEqual([]);

      await new Promise((resolve) => setTimeout(resolve));
      expect(mockApp.terrainActive).toBe(true);
      const cut = writes().slice(before);
      expect(cut).toHaveLength(1);
      expect(cut[0]).toBeGreaterThan(0);
      expect(Math.max(...heights())).toBeCloseTo(2000, 6);
    });

    it("takes the flights on the map for stale as the data changes while the relief's code loads (regression)", async () => {
      await drawOverHills(11, false);
      const g = features(ALTITUDE)[0]!.properties.g;

      // The 3D view comes on, and another year arrives before its code
      featureBundle.held = true;
      mockApp.store.set("threeDVisible", true);
      mockApp.currentData = createDataset(
        [{ id: 7, year: 2026 }],
        [
          ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
            createSegment({
              path_id: 7,
              altitude_ft: 2000,
              coords: [
                [48, 16 + i * 0.004],
                [48, 16.004 + i * 0.004],
              ],
            }),
          ),
        ],
      );
      layerManager.syncModes(true);

      // The tiles still hold the flights of before, which the runs of the
      // new data do not stand for
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g, pathId: 1 }),
      ];
      expect(layerManager.hitTest(pointAt(48, 16.001))).toBe("stale");
    });

    it("draws a mode that shows again while the camera moves once the move has ended", async () => {
      await drawOverHills(9);
      settled();
      /** The writes of both sources of the flights */
      const writes = (): number =>
        setDataCalls(RIBBONS) + setDataCalls(ALTITUDE);

      // A replay hides the flights, and chases the airplane in close
      mockApp.replayActive = true;
      layerManager.syncModes();
      mockApp.map!.jumpTo({ zoom: 14.1 });
      await endZoom(mockApp.map!, REPLAY_CAMERA_MOVE);
      const before = writes();
      const ribbonsBefore = setDataCalls(RIBBONS);

      // It closes, and the camera eases back to the view of before
      mockApp.map!.isMoving.mockReturnValue(true);
      mockApp.replayActive = false;
      layerManager.syncModes();
      expect(mockApp.altitudeLayer.isVisible()).toBe(true);
      expect(writes()).toBe(before);

      mockApp.map!.jumpTo({ zoom: 9.3 });
      mockApp.map!.isMoving.mockReturnValue(false);
      await endZoom(mockApp.map!);
      mockApp.map!.emit("moveend");
      // Cut once, for the level the move has ended on
      expect(setDataCalls(RIBBONS) - ribbonsBefore).toBe(1);
      expect(writes() - before).toBe(1);
      expect(features(RIBBONS).length).toBeGreaterThan(0);
      expect(new Set(features(RIBBONS).map((f) => f.properties.l))).toEqual(
        new Set([9]),
      );
    });

    it("lets go of the ground of every level as the 3D view goes", async () => {
      await drawOverHills(11);
      const segments = mockApp.currentData!.path_segments;
      const level = mockApp.reliefLevel;
      const ground = groundProfilesFt(segments, true, level).ground;
      // Worked out once for the level, and kept while the 3D view is on
      expect(groundProfilesFt(segments, true, level).ground).toBe(ground);

      mockApp.store.set("threeDVisible", false);
      expect(groundProfilesFt(segments, true, level).ground).not.toBe(ground);
    });

    it("switches the exaggeration and the ground at the level they are cut for, once", async () => {
      await drawOverHills(11);
      mockApp.map!.setTerrain.mockClear();
      const before = writes().length;

      mockApp.map!.jumpTo({ zoom: 7.2 });
      await endZoom(mockApp.map!);

      // The relief and the flights exaggerated alike, for the new level
      expect(mockApp.reliefLevel).toBe(7);
      expect(mockApp.map!.setTerrain.mock.calls).toEqual([
        [{ source: "terrain", exaggeration: liftExaggeration(7) }],
      ]);
      expect(exaggerations()).toEqual(new Set([liftExaggeration(7)]));
      expect(Math.max(...heights())).toBe(2000);
      // Cut once, on the new ground and for the new level at the same time,
      // after the cut of before has been let go of: cut for level 11, which
      // the map knows by no id, it cannot take the exaggeration of level 7
      // and waits out of sight, and the map's worker holds one cut at a time
      expect(writes().slice(before)).toEqual([0, heights().length]);
      // No feature state either: MapLibre works out the paint of every
      // feature of an id with one anew in each tile it loads
      expect(mockApp.map!.featureStates.size).toBe(0);
    });

    /** The exaggeration the ribbons of an id were given by feature state */
    const given = (id: number): unknown =>
      (
        mockApp.map!.featureStates.get(`${RIBBONS}:${id}`) as
          { e?: number } | undefined
      )?.e;
    /** The id of the ribbons cut for `level` now (see ribbonId) */
    const idOf = (level: number): number =>
      ribbonId(level, mockApp.relief.epoch);

    it("keeps the ribbons in sight as a zoom ends a level on, and switches the exaggeration of the old cut with the relief", async () => {
      await drawOverHills(8.2);
      mockApp.map!.emit("render");
      mockApp.map!.isSourceLoaded.mockImplementation((id) => id !== RIBBONS);
      const cut8 = idOf(8);
      expect(features(RIBBONS)[0]!.properties).toMatchObject({
        l: 8,
        k: cut8,
      });
      // Nothing to switch yet, and no state
      expect(mockApp.map!.featureStates.size).toBe(0);

      mockApp.map!.jumpTo({ zoom: 7.2 });
      await endZoom(mockApp.map!);

      // The ribbons cut for level 8 take the exaggeration of level 7 in the
      // same task as the relief does, and stay in sight
      expect(opacity()).toBeGreaterThan(0);
      expect(mockApp.map!.getTerrain()).toMatchObject({
        exaggeration: liftExaggeration(7),
      });
      expect(given(cut8)).toBe(liftExaggeration(7));
      // Those cut for level 7 have an id no state was given, and never is
      // while they are the ones for the level of the map
      const cut7 = idOf(7);
      expect(cut7).not.toBe(cut8);
      expect(features(RIBBONS)[0]!.properties).toMatchObject({
        l: 7,
        k: cut7,
      });
      expect(given(cut7)).toBeUndefined();
      expect(
        [...mockApp.map!.featureStates.keys()].every((key) =>
          key.endsWith(`:${cut8}`),
        ),
      ).toBe(true);

      // Back before the cut for level 7 has landed: the cut for level 8
      // has its own again, the one for 7 that of 8, and the new cut for 8
      // an id of its own
      mockApp.map!.jumpTo({ zoom: 8.2 });
      await endZoom(mockApp.map!);
      expect(given(cut8)).toBeUndefined();
      expect(given(cut7)).toBe(liftExaggeration(8));
      expect(idOf(8)).not.toBe(cut8);
      expect(given(idOf(8))).toBeUndefined();

      // Once all have landed the old cuts are gone, and nothing is given
      // to them again
      mockApp.map!.isSourceLoaded.mockReturnValue(true);
      mockApp.map!.emit("render");
      const states = mockApp.map!.setFeatureState.mock.calls.length;
      mockApp.map!.isSourceLoaded.mockImplementation((id) => id !== RIBBONS);
      mockApp.map!.jumpTo({ zoom: 9.2 });
      await endZoom(mockApp.map!);
      const calls = mockApp.map!.setFeatureState.mock.calls.slice(states);
      expect(calls.length).toBeGreaterThan(0);
      expect(
        calls.every(([{ id }]) => id === ribbonId(8, mockApp.relief.epoch - 1)),
      ).toBe(true);
    });

    it("hides the ribbons that cannot follow the level while an older cut may still be drawn", async () => {
      await drawOverHills(6.2);
      mockApp.map!.emit("render");
      // The cut for level 7 is still on its way as the zoom goes on
      mockApp.map!.isSourceLoaded.mockImplementation((id) => id !== RIBBONS);
      mockApp.map!.jumpTo({ zoom: 7.2 });
      await endZoom(mockApp.map!);
      // Level 6 has the exaggeration of 7: they stay in sight
      expect(opacity()).toBeGreaterThan(0);

      mockApp.map!.jumpTo({ zoom: 8.2 });
      await endZoom(mockApp.map!);
      // The map may still draw the cut for level 6, which it knows by no id
      // and which cannot take the exaggeration of level 8
      expect(opacity()).toBe(0);

      // Had the cut for level 7 landed, they would have followed
      mockApp.map!.isSourceLoaded.mockReturnValue(true);
      mockApp.map!.emit("render");
      expect(opacity()).toBeGreaterThan(0);
      mockApp.map!.jumpTo({ zoom: 7.2 });
      await endZoom(mockApp.map!);
      mockApp.map!.emit("render");
      mockApp.map!.isSourceLoaded.mockImplementation((id) => id !== RIBBONS);
      mockApp.map!.jumpTo({ zoom: 8.2 });
      await endZoom(mockApp.map!);
      expect(opacity()).toBeGreaterThan(0);
    });

    it("lets go of the ribbons of a mode out of sight as the level changes", async () => {
      await drawOverHills(8.2);
      const before = writes().length;
      // Hidden, as a replay hides it, with its runs kept
      mockApp.altitudeLayer.setVisible(false);

      mockApp.map!.jumpTo({ zoom: 7.2 });
      await endZoom(mockApp.map!);

      // Emptied rather than left with the cut for level 8, which would show
      // on the ground of another level until it was cut again
      expect(writes().slice(before)).toEqual([0]);
      mockApp.altitudeLayer.setVisible(true);
      layerManager.updateSelectionStyles();
      expect(writes().length).toBe(before + 2);
      expect(features(RIBBONS)[0]!.properties).toMatchObject({ l: 7 });
    });

    it("gives the ribbons the ground of the levels around the one they are cut for", async () => {
      await drawOverHills(9.2);
      // A ridge under the cruise, which the levels further out smooth away
      const data = mockApp.currentData!;
      mockApp.currentData = {
        ...data,
        path_segments: data.path_segments.map((segment, i) => ({
          ...segment,
          ground_ft: i === 4 ? 4000 : 1000,
        })),
      };
      drawMode(layerManager, "altitude");

      const ribbons = features(RIBBONS);
      expect(ribbons.every((ribbon) => ribbon.properties.l === 9)).toBe(true);
      // Over the ridge the ground of the coarser levels is lower, so a
      // ribbon stands higher above it there
      const over = ribbons.filter(
        (ribbon) => (ribbon.properties["o-1"] ?? 0) > 0,
      );
      expect(over.length).toBeGreaterThan(0);
      for (const ribbon of over) {
        expect(ribbonHeightFt(ribbon.properties, 8.5)).toBeGreaterThan(
          ribbon.properties.h!,
        );
      }
    });

    it("leaves the relief and the flights as they are while a zoom goes on", async () => {
      await drawOverHills(7.2);
      mockApp.map!.setTerrain.mockClear();
      const before = writes().length;

      // Mid-gesture, a level on: nothing follows before the zoom ends
      mockApp.map!.jumpTo({ zoom: 8.6 });
      mockApp.map!.emit("zoom");
      expect(mockApp.reliefLevel).toBe(7);
      expect(mockApp.map!.setTerrain).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(before);

      // Within the level it ends in, nothing is cut again either
      mockApp.map!.jumpTo({ zoom: 7.8 });
      await endZoom(mockApp.map!);
      expect(mockApp.map!.setTerrain).not.toHaveBeenCalled();
      expect(writes()).toHaveLength(before);
    });

    it("cuts the ribbons only for their width beyond the level of the deepest tiles", async () => {
      await drawOverHills(12.2);
      mockApp.map!.setTerrain.mockClear();
      const before = writes().length;
      const opacityBefore = opacity();

      mockApp.map!.jumpTo({ zoom: 13.1 });
      await endZoom(mockApp.map!);

      expect(mockApp.map!.setTerrain).not.toHaveBeenCalled();
      expect(writes().slice(before)).toEqual([heights().length]);
      expect(opacity()).toBe(opacityBefore);
    });

    it("cuts the flights once as the 3D view is switched on over the relief", async () => {
      await drawOverHills(11, false);
      const before = writes().length;

      mockApp.store.set("threeDVisible", true);
      expect(writes()).toHaveLength(before);
      await new Promise((resolve) => setTimeout(resolve));
      expect(writes().slice(before)).toEqual([heights().length]);
      expect(Math.max(...heights())).toBe(2000);
    });

    it("cuts the flights for the new level once the code has come after all", async () => {
      featureBundle.available = false;
      await drawOverHills(7.2);
      expect(features(RIBBONS)).toEqual([]);

      // The switch went back off (layerManager.threeD.test.ts), and the
      // next press, on another level, asks again
      expect(mockApp.threeDVisible).toBe(false);
      featureBundle.available = true;
      mockApp.map!.jumpTo({ zoom: 8.2 });
      await endZoom(mockApp.map!);
      mockApp.store.set("threeDVisible", true);
      await new Promise((resolve) => setTimeout(resolve));

      expect(mockApp.terrainActive).toBe(true);
      expect(features(ALTITUDE)).toEqual([]);
      expect(exaggerations()).toEqual(new Set([liftExaggeration(8)]));
    });

    it("hides the ribbons until the map has drawn them on their new ground", async () => {
      await drawOverHills(11);
      mockApp.map!.emit("render");
      expect(opacity()).toBeGreaterThan(0);

      // Level 11 is not one the map knows its ribbons by (see
      // switchesExaggeration), and 7 has another exaggeration
      mockApp.map!.isSourceLoaded.mockImplementation((id) => id !== "terrain");
      mockApp.map!.jumpTo({ zoom: 7.2 });
      await endZoom(mockApp.map!);
      expect(opacity()).toBe(0);
      expect(
        mockApp.map!.layer("replay-trail-3d").paint["fill-extrusion-opacity"],
      ).toBe(0);
      // A selection meanwhile does not show them early
      layerManager.updateSelectionStyles();
      mockApp.map!.emit("render");
      expect(opacity()).toBe(0);

      mockApp.map!.isSourceLoaded.mockReturnValue(true);
      mockApp.map!.emit("render");
      expect(opacity()).toBeGreaterThan(0);
      expect(
        mockApp.map!.layer("replay-trail-3d").paint["fill-extrusion-opacity"],
      ).toBe(0.8);
      expect(mockApp.map!.listenerCount("render")).toBe(0);
    });

    it("shows the ribbons after SETTLE_MAX_MS even when the relief is still loading", async () => {
      await drawOverHills(11);
      mockApp.map!.emit("render");
      vi.useFakeTimers();
      try {
        mockApp.map!.isSourceLoaded.mockImplementation(
          (id) => id !== "terrain",
        );
        mockApp.map!.jumpTo({ zoom: 7.2 });
        await endZoom(mockApp.map!);
        expect(opacity()).toBe(0);

        // A slow device: the elevation tiles are still coming in
        vi.advanceTimersByTime(2999);
        mockApp.map!.emit("render");
        expect(opacity()).toBe(0);
        vi.advanceTimersByTime(1);
        expect(opacity()).toBeGreaterThan(0);
        expect(mockApp.map!.listenerCount("render")).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("shades the relief above the base map's fills and below everything of the app's", async () => {
      await drawOverHills(11);

      const order = mockApp.map!.getLayersOrder();
      const shading = order.indexOf(HILLSHADE_LAYER);
      expect(shading).toBeGreaterThan(0);
      expect(mockApp.map!.layer(HILLSHADE_LAYER)).toMatchObject({
        type: "hillshade",
        source: "terrain",
      });
      // Right above the background of the stub style, below the first
      // layer of the app
      expect(order[shading - 1]).toBe("background");
      expect(order[shading + 1]).toBe(MAP_LAYERS.aviation);
      expect(
        mockApp.map!.getLayoutProperty(HILLSHADE_LAYER, "visibility"),
      ).not.toBe("none");

      mockApp.store.set("threeDVisible", false);
      expect(
        mockApp.map!.getLayoutProperty(HILLSHADE_LAYER, "visibility"),
      ).toBe("none");
      expect(mockApp.map!.getTerrain()).toBeNull();
      mockApp.store.set("threeDVisible", true);
      expect(
        mockApp.map!.getLayoutProperty(HILLSHADE_LAYER, "visibility"),
      ).toBe("visible");
    });

    it("puts the shading back into a new base style", async () => {
      await drawOverHills(11);
      mockApp.map!.removeLayer(HILLSHADE_LAYER);

      mockApp.map!.emit("styledata");

      expect(mockApp.map!.getLayer(HILLSHADE_LAYER)).toBeDefined();
    });

    const shading = (): unknown =>
      mockApp.map!.getLayer(HILLSHADE_LAYER)
        ? mockApp.map!.getLayoutProperty(HILLSHADE_LAYER, "visibility")
        : "absent";

    it("shades the relief on the globe without drawing it, and switches with the globe", async () => {
      await drawOverHills(11);
      mockApp.map!.setTerrain.mockClear();

      mockApp.globeVisible = true;
      expect(mockApp.terrainActive).toBe(false);
      expect(mockApp.reliefShaded).toBe(true);
      expect(mockApp.map!.getTerrain()).toBeNull();
      expect(shading()).toBe("visible");
      // The flights stand on the line between their fields there
      expect(Math.max(...heights())).toBe(2600);

      // Another level on the globe lifts them as much as off it
      mockApp.map!.jumpTo({ zoom: 6.5 });
      await endZoom(mockApp.map!);
      expect(exaggerations()).toEqual(new Set([liftExaggeration(6)]));
      expect(mockApp.map!.getTerrain()).toBeNull();

      mockApp.globeVisible = false;
      expect(mockApp.terrainActive).toBe(true);
      expect(mockApp.map!.getTerrain()).not.toBeNull();
      expect(shading()).toBe("visible");
      expect(Math.max(...heights())).toBeCloseTo(2000, 6);
      // Once off and once on: never the relief on the globe
      expect(mockApp.map!.setTerrain.mock.calls).toEqual([
        [null],
        [{ source: "terrain", exaggeration: liftExaggeration(6) }],
      ]);
    });

    it("keeps the flights smoothed on the globe as a zoom ends on another level", async () => {
      await drawOverHills(11);
      const smoothed = (): SmoothedFlights | null => {
        const segments = heldGroundedFlights();
        return (
          segments &&
          groundedFlights(segments, mockApp.terrainActive, mockApp.reliefLevel)
        );
      };
      mockApp.globeVisible = true;
      const onGlobe = smoothed();
      expect(onGlobe).not.toBeNull();

      // The line between their fields is the same at every level
      mockApp.map!.jumpTo({ zoom: 6.5 });
      await endZoom(mockApp.map!);
      expect(smoothed()).toBe(onGlobe);

      // On the relief each level has its own ground
      mockApp.globeVisible = false;
      const onRelief = smoothed();
      expect(onRelief).not.toBe(onGlobe);
      mockApp.map!.jumpTo({ zoom: 9.5 });
      await endZoom(mockApp.map!);
      expect(smoothed()).not.toBe(onRelief);
    });

    it("loads the relief's code for the shading alone on the globe", async () => {
      mockApp.globeVisible = true;
      await drawOverHills(11);

      expect(mockApp.reliefShaded).toBe(true);
      expect(mockApp.terrainActive).toBe(false);
      expect(mockApp.map!.getTerrain()).toBeNull();
      expect(mockApp.map!.source("terrain").spec).toMatchObject({
        type: "raster-dem",
      });
      // Created shown, with no visibility of its own
      expect(shading()).toBeUndefined();
      // The ground does not change, so the ribbons stay shown
      expect(opacity()).toBeGreaterThan(0);
      expect(Math.max(...heights())).toBe(2600);

      mockApp.store.set("threeDVisible", false);
      expect(mockApp.reliefShaded).toBe(false);
      expect(shading()).toBe("none");
    });

    it("cuts the ribbons on the globe once the feature bundle has come, which cuts them", async () => {
      featureBundle.held = true;
      mockApp.globeVisible = true;
      await drawOverHills(11, false);
      const lines = setDataCalls(ALTITUDE);

      mockApp.store.set("threeDVisible", true);
      layerManager.syncModes(true);
      expect(setDataCalls(RIBBONS)).toBe(0);
      expect(setDataCalls(ALTITUDE)).toBe(lines);

      // Arrived for the next zoom
      featureBundle.held = false;
      mockApp.map!.jumpTo({ zoom: 11.2 });
      await endZoom(mockApp.map!);
      await new Promise((resolve) => setTimeout(resolve));
      expect(mockApp.terrainActive).toBe(false);
      expect(features(RIBBONS).length).toBeGreaterThan(0);
      expect(features(ALTITUDE)).toEqual([]);
    });

    it("leaves the cut of a selection to the feature bundle too, with its legend at once", async () => {
      // A selection while the bundle loaded was drawn as flat lines in the
      // 3D view, under the legend of before
      const legend = document.getElementById("legend-max")!;
      featureBundle.held = true;
      mockApp.globeVisible = true;
      await drawOverHills(11, false);
      mockApp.store.set("threeDVisible", true);
      layerManager.syncModes(true);
      const selected = setDataCalls(ALTITUDE_SELECTED);
      const written = legend.textContent;

      legend.textContent = "stale";
      mockApp.selectedPathIds = new Set([1]);
      layerManager.updateSelectionStyles();

      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(selected);
      expect(legend.textContent).toBe(written);

      // Nor does a new dataset meanwhile keep the legend of the one before
      legend.textContent = "stale";
      layerManager.syncModes(true);
      expect(legend.textContent).toBe(written);
      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(selected);
    });

    it("draws the flights as lines on the flat map without the feature bundle, which cuts the ribbons", async () => {
      featureBundle.available = false;
      await drawOverHills(11);

      expect(mockApp.terrainActive).toBe(false);
      expect(features(RIBBONS)).toEqual([]);
      expect(features(ALTITUDE).length).toBeGreaterThan(0);

      // Not even zoomed in further, on another level
      mockApp.map!.jumpTo({ zoom: 12.1 });
      await endZoom(mockApp.map!);
      await new Promise((resolve) => setTimeout(resolve));
      expect(features(RIBBONS)).toEqual([]);
      expect(features(ALTITUDE).length).toBeGreaterThan(0);
    });

    it("builds the relief anew after a lost WebGL context", async () => {
      await drawOverHills(11);
      mockApp.map!.setTerrain.mockClear();

      mockApp.map!.emit("webglcontextrestored");
      mockApp.map!.emit("style.load");

      expect(mockApp.map!.setTerrain.mock.calls).toEqual([
        [null],
        [{ source: "terrain", exaggeration: liftExaggeration(11) }],
      ]);
    });
  });
});
