/**
 * LayerManager in the 3D view: the ribbons in place of the lines, cut
 * again for the zoom and around the view, and the flights under the
 * pointer among them. The relief they stand on is in terrain.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Point, type Map as MapLibreMap } from "maplibre-gl";
import { LngLatBounds } from "../../../mocks/maplibre-gl";
import {
  THREE_D_UNAVAILABLE_MESSAGE,
  type LayerManager,
} from "../../../../flown/frontend/ui/layerManager";
import type { PathSegment } from "../../../../flown/frontend/types";
import { createDataset, createSegment, type MockApp } from "../../testHelpers";
import { liftOffsetPx } from "../../../../flown/frontend/calculations/lift";
import {
  GROUND_IDLE_MS,
  groundedFlights,
  heldGroundedFlights,
} from "../../../../flown/frontend/calculations/groundProfile";
import { REPLAY_CAMERA_MOVE } from "../../../../flown/frontend/utils/mapHelpers";
import {
  type RunFeature,
  ALTITUDE,
  ALTITUDE_SELECTED,
  segmentsAlong,
  drawMode,
  endZoom,
  layerManagerHelpers,
  setupLayerManager,
  teardownLayerManager,
} from "./layerManagerTestSetup";

// The feature bundle, as far as the relief of the 3D view takes it (the
// heat cloud has tests of its own), and with `held` still on its way
const featureBundle = vi.hoisted(() => ({
  available: true,
  held: false,
  followHeatCloud: vi.fn(),
  followSelectionRibbons: vi.fn(),
}));
const toast = vi.hoisted(() => ({ showToast: vi.fn(), dismissToast: vi.fn() }));
vi.mock("../../../../flown/frontend/utils/toast", () => toast);
vi.mock("../../../../flown/frontend/services/featureLoader", async () => {
  const { followTerrain } =
    await import("../../../../flown/frontend/ui/terrain");
  const { ribbonBox, ribbonFeatures, ribbonLiftPx, viewLeaves } =
    await import("../../../../flown/frontend/ui/pathRibbons");
  const { followsLevel } =
    await import("../../../../flown/frontend/calculations/lift");
  const { heldGroundedFlights, releaseGroundedFlights } =
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

describe("LayerManager 3D view", () => {
  let layerManager: LayerManager;
  let mockApp: MockApp;
  /** Callbacks waiting for the next animation frame, by their handle */
  let frames: Map<number, FrameRequestCallback>;
  const {
    features,
    selectionFilter,
    setDataCalls,
    paint,
    landed,
    holdSetData,
    rendered,
    pointAt,
    terrainCode,
    settled,
  } = layerManagerHelpers({
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
    toast.showToast.mockClear();
    toast.dismissToast.mockClear();
    ({ layerManager, mockApp, frames } = setupLayerManager());
  });

  afterEach(() => teardownLayerManager(layerManager));

  describe("the 3D view", () => {
    const RIBBONS = "paths-altitude-3d";
    const RIBBONS_SELECTED = "paths-altitude-selected-3d";

    /** A climb from the ground at 1000 ft to 1100 ft, then level */
    async function drawClimb(): Promise<void> {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        [
          createSegment({
            path_id: 1,
            altitude_ft: 1000,
            coords: [
              [48, 16],
              [48, 16.01],
            ],
          }),
          createSegment({
            path_id: 1,
            altitude_ft: 1100,
            coords: [
              [48, 16.01],
              [48, 16.02],
            ],
          }),
          createSegment({
            path_id: 1,
            altitude_ft: 1100,
            coords: [
              [48, 16.02],
              [48, 16.03],
            ],
          }),
        ],
      );
      mockApp.altitudeRange = { min: 0, max: 32000 };
      // Over the flight: zoomed in, only the ribbons around the view are
      // written
      mockApp.map!.jumpTo({ center: [16.015, 48] });
      mockApp.store.set("threeDVisible", true);
      mockApp.altitudeLayer.setVisible(true);
      // Cut by the feature bundle, which the 3D view fetches
      await terrainCode();
      drawMode(layerManager, "altitude");
    }

    const ribbons = (): RunFeature[] => features(RIBBONS);

    /** How far apart the two edges of a ribbon's first quad are, in metres */
    const ribbonWidthM = (): number => {
      const geometry = ribbons()[0]!.geometry as GeoJSON.MultiPolygon;
      const [a, , , d] = geometry.coordinates[0]![0]! as [number, number][];
      const metresPerDegree = 111320;
      const dLng =
        (d![0] - a![0]) * metresPerDegree * Math.cos((48 * Math.PI) / 180);
      const dLat = (d![1] - a![1]) * metresPerDegree;
      return Math.hypot(dLng, dLat);
    };

    it("writes each run as ribbon pieces of the same run in place of its line", async () => {
      // Close in, where the ribbons are cut as the data has them
      mockApp.map!.jumpTo({ zoom: 13 });
      await drawClimb();

      // To a source of their own, which is not simplified
      expect(features(ALTITUDE)).toEqual([]);
      expect(ribbons().length).toBeGreaterThan(1);
      for (const ribbon of ribbons()) {
        expect(ribbon.geometry.type).toBe("MultiPolygon");
        // One run: the table answers for all of its pieces
        expect(ribbon.properties).toMatchObject({ r: 0, g: 1, pathId: 1 });
      }
    });

    it("stands the ribbon on the flight's ground and slopes it with the climb", async () => {
      mockApp.map!.jumpTo({ zoom: 13 });
      await drawClimb();

      // The ground of this flight is where it spent the lowest of its time,
      // 1000 ft: level on it, then 100 ft of climb cut into pieces of 20 ft,
      // each at the height of its middle, then level at the top
      expect(ribbons().map((ribbon) => ribbon.properties.h)).toEqual([
        0, 10, 30, 50, 70, 90, 100,
      ]);
    });

    it("turns the 3D view back off and says so when its code cannot be fetched", async () => {
      featureBundle.available = false;
      try {
        mockApp.store.set("threeDVisible", true);
        await terrainCode();
        // The switch stayed on over flat flights, and nothing said why
        expect(mockApp.threeDVisible).toBe(false);
        // Nor does the press leave its tilt and colours behind
        expect(mockApp.mapOrientation.undoThreeD).toHaveBeenCalledOnce();
        expect(toast.showToast).toHaveBeenCalledExactlyOnceWith(
          THREE_D_UNAVAILABLE_MESSAGE,
          "error",
        );

        // The next press asks again, and the failure is no longer true
        featureBundle.available = true;
        mockApp.store.set("threeDVisible", true);
        await terrainCode();
        expect(mockApp.threeDVisible).toBe(true);
        expect(toast.dismissToast).toHaveBeenCalledWith(
          THREE_D_UNAVAILABLE_MESSAGE,
        );
      } finally {
        featureBundle.available = true;
      }
    });

    it("writes no ribbon outside the 3D view", async () => {
      await drawClimb();
      mockApp.store.set("threeDVisible", false);

      expect(ribbons()).toEqual([]);
      expect(features(ALTITUDE)).toHaveLength(1);
    });

    it("draws the ribbons a few pixels wide, cut again for another zoom level", async () => {
      mockApp.map!.jumpTo({ zoom: 7.2 });
      await drawClimb();
      await terrainCode();
      const at7 = ribbonWidthM();
      const writes = setDataCalls(RIBBONS);

      // Within the level nothing is cut again
      mockApp.map!.jumpTo({ zoom: 7.9 });
      await endZoom(mockApp.map!);
      expect(setDataCalls(RIBBONS)).toBe(writes);

      // A level further in, half as wide on the ground: as wide on screen.
      // Written over the cut of before, which stands on the relief of both
      // levels until the new one has landed.
      mockApp.map!.jumpTo({ zoom: 8.1 });
      await endZoom(mockApp.map!);
      expect(setDataCalls(RIBBONS)).toBe(writes + 1);
      expect(ribbonWidthM()).toBeCloseTo(at7 / 2, 3);
      // About 3 pixels at zoom 8.5, 512 px tiles, at 48 degrees
      const metresPerPixel =
        (40075016.686 * Math.cos((48 * Math.PI) / 180)) / (512 * 2 ** 8.5);
      expect(ribbonWidthM() / metresPerPixel).toBeCloseTo(3, 1);
    });

    it("cuts the ribbons for a new level in a task after the one the zoom ends in, unless another zoom is under way", async () => {
      mockApp.map!.jumpTo({ zoom: 7.2 });
      await drawClimb();
      await terrainCode();
      const writes = setDataCalls(RIBBONS);
      vi.useFakeTimers();
      try {
        mockApp.map!.jumpTo({ zoom: 8.1 });
        mockApp.map!.emit("zoomend");
        expect(setDataCalls(RIBBONS)).toBe(writes);
        mockApp.map!.isZooming.mockReturnValueOnce(true);
        vi.advanceTimersByTime(0);
        expect(setDataCalls(RIBBONS)).toBe(writes);

        mockApp.map!.emit("zoomend");
        vi.advanceTimersByTime(0);
        expect(setDataCalls(RIBBONS)).toBe(writes + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("leaves the zooms of the replay's camera to its own rest", async () => {
      mockApp.map!.jumpTo({ zoom: 7.2 });
      await drawClimb();
      await terrainCode();
      const writes = setDataCalls(RIBBONS);

      mockApp.map!.jumpTo({ zoom: 8.1 });
      await endZoom(mockApp.map!, REPLAY_CAMERA_MOVE);
      expect(setDataCalls(RIBBONS)).toBe(writes);

      // Which it tells the map of as MapLibre would
      await endZoom(mockApp.map!);
      expect(setDataCalls(RIBBONS)).toBe(writes + 1);
    });

    it("still answers for the flights while the ribbons are cut for another zoom", async () => {
      // Beyond the level of the deepest elevation tiles, where only the
      // width of the ribbons changes
      mockApp.map!.jumpTo({ zoom: 12.2 });
      await drawClimb();
      await terrainCode();
      await landed();
      settled();
      const g = ribbons()[0]!.properties.g;
      const workerAnswers = holdSetData(RIBBONS);

      mockApp.map!.jumpTo({ zoom: 13.1 });
      await endZoom(mockApp.map!);

      // The same runs, so the tiles of before still stand for them: no
      // click or pointer is kept waiting for the new ones
      expect(ribbons()[0]!.properties.g).toBe(g);
      mockApp.map!.renderedFeatures = [
        rendered(RIBBONS, { r: 0, g, pathId: 1, h: 0 }),
      ];
      expect(layerManager.hitTest(pointAt(48, 16.005))).toMatchObject({
        pathId: 1,
      });
      await workerAnswers();
    });

    it("draws the flights as lines zoomed in close, and lifts them again further out", async () => {
      mockApp.map!.jumpTo({ zoom: 16.5 });
      await drawClimb();
      await terrainCode();
      expect(ribbons().length).toBeGreaterThan(0);

      // The camera is lower than a circuit there
      mockApp.map!.jumpTo({ zoom: 17.2 });
      await endZoom(mockApp.map!);
      expect(ribbons()).toEqual([]);
      expect(features(ALTITUDE)).toHaveLength(1);

      mockApp.map!.jumpTo({ zoom: 16.8 });
      await endZoom(mockApp.map!);
      expect(features(ALTITUDE)).toEqual([]);
      expect(ribbons().length).toBeGreaterThan(0);
    });

    it("leaves the ribbons be as the map zooms while the flights are flat", async () => {
      await drawClimb();
      mockApp.store.set("threeDVisible", false);
      const writes = setDataCalls(RIBBONS);

      mockApp.map!.jumpTo({ zoom: 3 });
      await endZoom(mockApp.map!);

      expect(setDataCalls(RIBBONS)).toBe(writes);
    });

    it("draws the ribbons as strong as the lines, dimmed like them", async () => {
      await drawClimb();
      // Shown once the map has drawn them on their ground (ui/terrain.ts)
      await landed();
      settled();

      expect(paint(RIBBONS)["fill-extrusion-opacity"]).toBe(0.85);
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.85);
    });

    it("keeps the ribbons of the selected flights off the main layer, like the lines", async () => {
      await drawClimb();
      // Shown once the map has drawn them on their ground (ui/terrain.ts)
      await landed();
      settled();
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      layerManager.updateSelectionStyles();

      expect(mockApp.map!.layer(RIBBONS).filter).toEqual([
        "!",
        ["in", ["get", "pathId"], ["literal", [1]]],
      ]);
      // The selection's own ribbons, at full strength
      expect(features(ALTITUDE_SELECTED)).toEqual([]);
      expect(features(RIBBONS_SELECTED).length).toBeGreaterThan(0);
      expect(paint(RIBBONS_SELECTED)["fill-extrusion-opacity"]).toBe(1);
    });

    it("looks for the ribbons under the pointer only in the 3D view", async () => {
      await drawClimb();
      // Shown once the map has drawn them on their ground (ui/terrain.ts)
      await landed();
      settled();

      layerManager.hitTest(new Point(100, 50));
      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenLastCalledWith(
        expect.anything(),
        { layers: [ALTITUDE, ALTITUDE_SELECTED, RIBBONS, RIBBONS_SELECTED] },
      );

      mockApp.store.set("threeDVisible", false);
      layerManager.hitTest(new Point(100, 50));
      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenLastCalledWith(
        expect.anything(),
        { layers: [ALTITUDE, ALTITUDE_SELECTED] },
      );
    });

    it("finds the flight of a ribbon under the pointer", async () => {
      await drawClimb();
      await terrainCode();
      await landed();
      settled();
      mockApp.map!.renderedFeatures = [
        rendered(RIBBONS, { r: 0, g: ribbons()[0]!.properties.g, h: 100 }),
      ];

      expect(layerManager.hitTest(pointAt(48, 16.025))).toMatchObject({
        pathId: 1,
      });
    });

    it("finds no ribbon while they are hidden on their way to another ground, and takes that for no empty map", async () => {
      await drawClimb();
      await terrainCode();
      await landed();
      mockApp.map!.renderedFeatures = [
        rendered(RIBBONS, { r: 0, g: ribbons()[0]!.properties.g, h: 100 }),
      ];

      // A query finds a feature whatever its opacity
      mockApp.relief.showRibbons(false);
      expect(layerManager.hitTest(pointAt(48, 16.025))).toBe("stale");
      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenLastCalledWith(
        expect.anything(),
        { layers: [ALTITUDE, ALTITUDE_SELECTED] },
      );

      mockApp.relief.showRibbons(true);
      expect(layerManager.hitTest(pointAt(48, 16.025))).toMatchObject({
        pathId: 1,
      });
    });

    it("writes nothing again as the map zooms on among the flat lines", async () => {
      mockApp.map!.jumpTo({ zoom: 17.2 });
      await drawClimb();
      await terrainCode();
      const writes = setDataCalls(ALTITUDE);

      // A line is the same at every zoom
      mockApp.map!.jumpTo({ zoom: 18.1 });
      await endZoom(mockApp.map!);
      mockApp.map!.jumpTo({ zoom: 19.1 });
      await endZoom(mockApp.map!);
      expect(setDataCalls(ALTITUDE)).toBe(writes);

      // Out to where they are lifted again, as ribbons
      mockApp.map!.jumpTo({ zoom: 16.5 });
      await endZoom(mockApp.map!);
      expect(ribbons().length).toBeGreaterThan(0);
      expect(features(ALTITUDE)).toEqual([]);
    });

    it("cuts each source again for the zoom level it was written at", async () => {
      mockApp.map!.jumpTo({ zoom: 7.2 });
      await drawClimb();
      await terrainCode();
      const at7 = ribbonWidthM();

      // The selection is written at the next level before the zoom ends;
      // the main ribbons are still those of the level before
      mockApp.map!.jumpTo({ zoom: 8.1 });
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      layerManager.updateSelectionStyles();
      await endZoom(mockApp.map!);

      expect(ribbonWidthM()).toBeCloseTo(at7 / 2, 3);
    });

    it("writes neither the selection nor the flights share mode hides for isolation alone", async () => {
      mockApp.map!.jumpTo({ zoom: 7.2 });
      await drawClimb();
      await terrainCode();
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      layerManager.updateSelectionStyles();
      /** The writes of a source that held any ribbon */
      const drawnWrites = (id: string): number =>
        mockApp
          .map!.source(id)
          .setData.mock.calls.filter(
            ([data]) => (data as GeoJSON.FeatureCollection).features.length,
          ).length;
      const main = drawnWrites(RIBBONS);
      const selected = drawnWrites(RIBBONS_SELECTED);
      const g = features(RIBBONS_SELECTED)[0]!.properties.g;

      // The same runs, styled for isolation: the features on the map stay
      // those of the runs, and a click on the empty map counts
      mockApp.isolateSelection = true;
      layerManager.updateSelectionStyles();
      expect(drawnWrites(RIBBONS_SELECTED)).toBe(selected);
      expect(selectionFilter(RIBBONS)).toEqual(["literal", false]);
      await landed();
      settled();
      mockApp.map!.renderedFeatures = [];
      expect(layerManager.hitTest(pointAt(48, 16.5))).toBeNull();

      // Framed on another level: the selection is cut for it, the flights
      // out of sight are not
      mockApp.map!.jumpTo({ zoom: 8.1 });
      await endZoom(mockApp.map!);
      expect(drawnWrites(RIBBONS)).toBe(main);
      expect(drawnWrites(RIBBONS_SELECTED)).toBe(selected + 1);
      expect(features(RIBBONS_SELECTED)[0]!.properties.g).toBe(g);

      // Back in sight, they are, once, for the level they show at
      mockApp.isolateSelection = false;
      layerManager.updateSelectionStyles();
      expect(drawnWrites(RIBBONS)).toBe(main + 1);
      expect(drawnWrites(RIBBONS_SELECTED)).toBe(selected + 1);
      expect(selectionFilter(RIBBONS)).not.toEqual(["literal", false]);
      layerManager.updateSelectionStyles();
      expect(drawnWrites(RIBBONS)).toBe(main + 1);
    });

    it("lands a write of the worker that a recut took over from", async () => {
      // Flat in the 3D view, the year worker writes the lines of every
      // flight; held here, as on a slow phone
      mockApp.map!.jumpTo({ zoom: 17.2 });
      await drawClimb();
      await landed();
      settled();
      const answers: (() => void)[] = [];
      mockApp.dataManager.askWorker.mockImplementation(
        (_ask: unknown, take: (answer: unknown) => void) =>
          answers.push(() => take({ type: "FeatureCollection", features: [] })),
      );
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds = new Set([1]);
      mockApp.isolateSelection = true;
      drawMode(layerManager, "altitude");

      // A zoom while share mode hides the flights leaves them behind, and
      // its end writes them again, cut for the zoom, before the worker
      // has answered for the first write
      mockApp.map!.jumpTo({ zoom: 18.1 });
      await endZoom(mockApp.map!);
      mockApp.isolateSelection = false;
      layerManager.updateSelectionStyles();
      // The worker is asked for the recut once it has answered the first
      expect(answers).toHaveLength(1);
      answers[0]!();
      expect(answers).toHaveLength(2);
      answers[1]!();
      await landed();
      settled();

      // The empty map is the empty map again
      mockApp.map!.renderedFeatures = [];
      expect(layerManager.hitTest(pointAt(48, 16.5))).toBeNull();
    });

    it("leaves a mode the replay hides as it is, and draws it again as it shows", async () => {
      mockApp.map!.jumpTo({ zoom: 8.2 });
      await drawClimb();
      /** The writes of the ribbons that held any, not those that emptied them */
      const cuts = (): number =>
        mockApp
          .map!.source(RIBBONS)
          .setData.mock.calls.filter(
            ([data]) => (data as GeoJSON.FeatureCollection).features.length,
          ).length;
      const writes = cuts();

      // Hidden, not cleared, as the replay does it: nothing is cut for it,
      // and its ribbons are let go of on another level (see releaseRibbons)
      mockApp.altitudeLayer.setVisible(false);
      mockApp.map!.jumpTo({ zoom: 9.1 });
      await endZoom(mockApp.map!);
      mockApp.store.set("threeDVisible", false);
      expect(cuts()).toBe(writes);
      expect(setDataCalls(ALTITUDE)).toBe(0);

      // Shown again, a change of the selection draws it as a whole, flat
      mockApp.altitudeLayer.setVisible(true);
      mockApp.altitudeVisible = true;
      layerManager.updateSelectionStyles();
      expect(ribbons()).toEqual([]);
      expect(features(ALTITUDE)).toHaveLength(1);
    });

    it("lets go of the flights another feature smoothed on the flat map as the data changes", () => {
      // Replay all smooths the flights on the flat map, with the bundle it
      // fetched for itself; the 3D view never came on
      const old = mockApp.currentData!.path_segments;
      groundedFlights(old, false, 0);
      expect(heldGroundedFlights()).toBe(old);

      // Another year, drawn flat
      mockApp.currentData = createDataset([{ id: 1, year: 2025 }], [...old]);
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");

      expect(heldGroundedFlights()).toBeNull();
    });

    it("lets the smoothed flights go once nothing lifted needs them", async () => {
      const smoothed = heldGroundedFlights;
      await drawClimb();
      expect(smoothed()).not.toBeNull();

      // Kept a while for the 3D view to come back on to
      vi.useFakeTimers();
      try {
        mockApp.store.set("threeDVisible", false);
        const held = smoothed();
        expect(held).not.toBeNull();
        vi.advanceTimersByTime(GROUND_IDLE_MS - 1);
        expect(smoothed()).toBe(held);
        vi.advanceTimersByTime(1);
        expect(smoothed()).toBeNull();
      } finally {
        vi.useRealTimers();
      }

      mockApp.store.set("threeDVisible", true);
      await terrainCode();
      expect(smoothed()).not.toBeNull();
      // Another dataset, drawn flat zoomed in
      mockApp.map!.jumpTo({ zoom: 17.5 });
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        [...mockApp.currentData!.path_segments],
      );
      drawMode(layerManager, "altitude");
      expect(smoothed()).toBeNull();

      mockApp.map!.jumpTo({ zoom: 12 });
      await endZoom(mockApp.map!);
      await terrainCode();
      expect(smoothed()).not.toBeNull();
      layerManager.clearLayer("altitude");
      expect(smoothed()).toBeNull();

      // Kept for the heat cloud, which draws along them (ui/heatCloud.ts)
      drawMode(layerManager, "altitude");
      expect(smoothed()).not.toBeNull();
      mockApp.store.batch(() => {
        mockApp.heatmapVisible = true;
        mockApp.heatCloud = true;
      });
      layerManager.clearLayer("altitude");
      expect(smoothed()).not.toBeNull();
    });

    it("takes a ribbon down by the lift at the map's centre, as MapLibre raises it", async () => {
      // Due north at 60 degrees, a segment every 0.005 degrees, while the
      // middle of the map is at the equator
      const points = Array.from({ length: 40 }, (_, i): [number, number] => [
        60 + i * 0.005,
        16,
      ]);
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        segmentsAlong(points),
      );
      mockApp.store.set("threeDVisible", true);
      mockApp.altitudeLayer.setVisible(true);
      mockApp.map!.jumpTo({ center: [16, 0], zoom: 12, pitch: 60 });
      // A view that reaches up to the flight, whose ribbons are written
      // only around it
      mockApp.map!.getBounds.mockReturnValue(
        new LngLatBounds([15, -1], [17, 61]),
      );
      drawMode(layerManager, "altitude");
      await terrainCode();
      await landed();
      settled();
      mockApp.map!.renderedFeatures = [
        rendered(RIBBONS, {
          r: 0,
          g: ribbons()[0]!.properties.g,
          h: 1000,
          l: 11,
        }),
      ];

      // Drawn up by the lift of the centre's latitude, half of that at 60
      const ground = pointAt(60 + 20.5 * 0.005, 16);
      const lift = liftOffsetPx(
        mockApp.map! as unknown as MapLibreMap,
        0,
        1000,
        2,
      );
      const hit = layerManager.hitTest(new Point(ground.x, ground.y - lift));

      expect(hit).toMatchObject({
        segment: mockApp.currentData.path_segments[20],
      });
    });

    describe("zoomed in", () => {
      /** Two flights, one at 48 N 16 E and one two and a half degrees east */
      async function drawTwo(zoom: number): Promise<void> {
        const along = (lng: number, id: number): PathSegment[] =>
          [0, 1, 2].map((i) =>
            createSegment({
              path_id: id,
              altitude_ft: 3000,
              coords: [
                [48, lng + i * 0.01],
                [48, lng + (i + 1) * 0.01],
              ],
            }),
          );
        mockApp.currentData = createDataset(
          [
            { id: 1, year: 2025 },
            { id: 2, year: 2025 },
          ],
          [...along(16, 1), ...along(18.5, 2)],
        );
        mockApp.altitudeRange = { min: 0, max: 32000 };
        mockApp.map!.jumpTo({ center: [16.015, 48], zoom });
        mockApp.store.set("threeDVisible", true);
        mockApp.altitudeLayer.setVisible(true);
        drawMode(layerManager, "altitude");
        await terrainCode();
      }
      const paths = (): number[] => [
        ...new Set(ribbons().map((ribbon) => ribbon.properties.pathId)),
      ];

      it("writes the ribbons around the view only, and again as it leaves that", async () => {
        // The view of the mock map reaches a degree to each side
        await drawTwo(9.5);
        expect(paths()).toEqual([1]);
        const g = ribbons()[0]!.properties.g;
        const writes = setDataCalls(RIBBONS);

        // Within the part written for, nothing is written again
        mockApp.map!.jumpTo({ center: [16.2, 48] });
        mockApp.map!.emit("moveend");
        expect(setDataCalls(RIBBONS)).toBe(writes);

        // Beyond it, the same runs around the new view: the features the
        // tiles still hold answer for them, and finding none is no word of
        // the empty map until the new ones have landed
        await landed();
        settled();
        const workerAnswers = holdSetData(RIBBONS);
        mockApp.map!.jumpTo({ center: [18.5, 48] });
        mockApp.map!.emit("moveend");
        expect(setDataCalls(RIBBONS)).toBe(writes + 1);
        mockApp.map!.renderedFeatures = [];
        expect(layerManager.hitTest(pointAt(48, 18.51))).toBe("stale");
        await workerAnswers();
        expect(layerManager.hitTest(pointAt(48, 18.51))).toBeNull();
        const written = mockApp.map!.source(RIBBONS).setData.mock.calls.at(-1)!;
        const features = (written[0] as { features: RunFeature[] }).features;
        expect(new Set(features.map((f) => f.properties.pathId))).toEqual(
          new Set([2]),
        );
        expect(features[0]!.properties.g).toBe(g);

        // Not for the replay's camera, nor with the lines drawn flat
        mockApp.map!.jumpTo({ center: [16, 48] });
        mockApp.map!.emit("moveend", REPLAY_CAMERA_MOVE);
        expect(setDataCalls(RIBBONS)).toBe(writes + 1);
      });

      it("reaches further around a tilted view, by as high as a flight is drawn", async () => {
        // Twice the height, at the level of the least exaggeration
        await drawTwo(10.5);
        mockApp.map!.jumpTo({ center: [15.6, 48], pitch: 0 });
        mockApp.map!.emit("moveend");
        expect(paths()).toEqual([1]);
        // Nearly a degree west of the view's edge: out of reach flat,
        // but not of the flights of 32,000 ft of the range tilted
        mockApp.map!.jumpTo({ center: [20.4, 48] });
        mockApp.map!.emit("moveend");
        expect(paths()).toEqual([]);
        mockApp.map!.jumpTo({ pitch: 80 });
        mockApp.map!.emit("moveend");
        expect(paths()).toEqual([2]);
      });

      it("writes every ribbon zoomed out, where all of them are in view", async () => {
        await drawTwo(7.5);
        expect(paths()).toEqual([1, 2]);
      });
    });

    it("cuts and writes the flights again as the 3D view comes and goes", async () => {
      await drawClimb();
      await terrainCode();
      const writes = setDataCalls(ALTITUDE);

      mockApp.store.set("threeDVisible", false);
      expect(setDataCalls(ALTITUDE)).toBe(writes + 1);
      mockApp.store.set("threeDVisible", true);
      expect(setDataCalls(ALTITUDE)).toBe(writes + 2);
    });
  });
});
