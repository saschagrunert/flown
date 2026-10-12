/**
 * LayerManager.hitTest: the flight and the segment under a point, from the
 * features the map's tiles answer with.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Point } from "maplibre-gl";
import type { LayerManager } from "../../../../flown/frontend/ui/layerManager";
import type { PathSegment } from "../../../../flown/frontend/types";
import { createDataset, createSegment, type MockApp } from "../../testHelpers";
import { findNearestSegment } from "../../../../flown/frontend/features/layers";
import {
  ALTITUDE,
  ALTITUDE_SELECTED,
  AIRSPEED,
  AIRSPEED_SELECTED,
  turn,
  segmentsAlong,
  drawMode,
  layerManagerHelpers,
  setupLayerManager,
  teardownLayerManager,
} from "./layerManagerTestSetup";

describe("LayerManager hitTest", () => {
  let layerManager: LayerManager;
  let mockApp: MockApp;
  /** Callbacks waiting for the next animation frame, by their handle */
  let frames: Map<number, FrameRequestCallback>;
  const { addSecondPath, features, landed, holdSetData, rendered, pointAt } =
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
    ({ layerManager, mockApp, frames } = setupLayerManager());
  });

  afterEach(() => teardownLayerManager(layerManager));

  describe("hitTest", () => {
    /** One path of two segments that merge into one run, slow then fast */
    function drawMergedRun(): PathSegment[] {
      const segments = [
        createSegment({
          path_id: 1,
          altitude_ft: 3000,
          groundspeed_knots: 90,
          coords: [
            [48, 16],
            [48.1, 16.1],
          ],
        }),
        createSegment({
          path_id: 1,
          altitude_ft: 3000,
          groundspeed_knots: 120,
          coords: [
            [48.1, 16.1],
            [48.2, 16.2],
          ],
        }),
      ];
      mockApp.currentData = createDataset([{ id: 1, year: 2025 }], segments);
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      expect(features(ALTITUDE)).toHaveLength(1);
      return segments;
    }

    it("finds nothing while no colour layer is shown", () => {
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];

      expect(layerManager.hitTest(new Point(10, 10))).toBeNull();
      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();
    });

    it("finds nothing on a layer that is shown but was cleared", () => {
      mockApp.altitudeLayer.setVisible(true);

      expect(layerManager.hitTest(new Point(10, 10))).toBeNull();
      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();
    });

    it("asks for the visible path layers in a box of 5 px around the pointer", async () => {
      drawMergedRun();
      await landed();

      expect(layerManager.hitTest(new Point(100, 50))).toBeNull();

      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenCalledWith(
        [
          [95, 45],
          [105, 55],
        ],
        { layers: [ALTITUDE, ALTITUDE_SELECTED] },
      );
    });

    it("widens the box to 12 px for a finger", () => {
      drawMergedRun();
      (window as { ontouchstart?: unknown }).ontouchstart = null;

      layerManager.hitTest(new Point(100, 50));

      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenCalledWith(
        [
          [88, 38],
          [112, 62],
        ],
        expect.anything(),
      );
    });

    it("returns the path and the segment of the run nearest to the point", () => {
      const [slow, fast] = drawMergedRun();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];

      expect(layerManager.hitTest(pointAt(48.19, 16.19))).toEqual({
        pathId: 1,
        segment: fast,
      });
      expect(layerManager.hitTest(pointAt(48.01, 16.01))).toEqual({
        pathId: 1,
        segment: slow,
      });
    });

    it("gives a point of the curve to the segment it lies on", () => {
      const points = turn(7, 30);
      const segments = segmentsAlong(points);
      mockApp.currentData = createDataset([{ id: 1, year: 2025 }], segments);
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      const line = features(ALTITUDE)[0]!.geometry.coordinates;

      // The points of the line between fix i and fix i + 1 are segment i's
      let segment = 0;
      for (let k = 0; k + 1 < line.length; k++) {
        const [lng0, lat0] = line[k] as [number, number];
        const [lng1, lat1] = line[k + 1] as [number, number];
        const fix = points[segment + 1]!;
        if (k > 0 && lat0 === fix[0] && lng0 === fix[1]) segment++;
        const lat = (lat0 + lat1) / 2;
        const lng = (lng0 + lng1) / 2;
        expect(layerManager.hitTest(pointAt(lat, lng))).toEqual({
          pathId: 1,
          segment: segments[segment],
        });
      }
      expect(segment).toBe(segments.length - 1);
    });

    it("ranks the runs by the curve they are drawn along, not their fixes", () => {
      // A point on the curve of a turn, between two of its fixes, which
      // bulges out of the straight line between them
      const points = turn(7, 30);
      const turning = segmentsAlong(points);
      const line = (): [number, number][] =>
        features(ALTITUDE)[0]!.geometry.coordinates as [number, number][];
      mockApp.currentData = createDataset([{ id: 1, year: 2025 }], turning);
      drawMode(layerManager, "altitude");
      const [a, b] = [line()[20]!, line()[21]!];
      const on: [number, number] = [(a[1] + b[1]) / 2, (a[0] + b[0]) / 2];
      // How far it is from that line, and which way (the map's pixels are
      // degrees here)
      const [from, to] = turning[2]!.coords;
      const along = [to[0] - from[0], to[1] - from[1]];
      const length = Math.hypot(along[0]!, along[1]!);
      const unit = [along[0]! / length, along[1]! / length];
      const t = (on[0] - from[0]) * unit[0]! + (on[1] - from[1]) * unit[1]!;
      const off = [
        on[0] - from[0] - t * unit[0]!,
        on[1] - from[1] - t * unit[1]!,
      ];
      // A second flight, straight, half as far out on the other side
      const passing: [number, number] = [
        on[0] + off[0]! / 2,
        on[1] + off[1]! / 2,
      ];
      const straight = createSegment({
        path_id: 2,
        altitude_ft: 3000,
        coords: [
          [passing[0] - unit[0]! * 0.01, passing[1] - unit[1]! * 0.01],
          [passing[0] + unit[0]! * 0.01, passing[1] + unit[1]! * 0.01],
        ],
      });
      mockApp.currentData = createDataset(
        [
          { id: 1, year: 2025 },
          { id: 2, year: 2025 },
        ],
        [...turning, straight],
      );
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 1, g: 2 }),
        rendered(ALTITUDE, { r: 0, g: 2 }),
      ];

      // Its fixes' straight line is further than the other flight
      expect(findNearestSegment([...turning, straight], ...on)).toBe(straight);
      expect(layerManager.hitTest(pointAt(...on))).toEqual({
        pathId: 1,
        segment: turning[2],
      });
    });

    it("drops features of a generation before the last setData", () => {
      drawMergedRun();
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];

      // Not null: a flight may well be there, the tiles cannot tell yet
      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBe("stale");

      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];
      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toMatchObject({
        pathId: 1,
      });
    });

    it("prefers a current feature over the stale ones beside it", () => {
      drawMergedRun();
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 0, g: 2 }),
      ];

      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toMatchObject({
        pathId: 1,
      });
    });

    it("finds the segment under a point in a copy of the world", () => {
      const [slow] = drawMergedRun();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      // One world to the east: 360 degrees further. Taken as it is, every
      // segment is far away and the eastern one the nearest.
      const point = pointAt(48.01, 16.01 + 360);

      expect(layerManager.hitTest(point)).toEqual({ pathId: 1, segment: slow });
    });

    it("ranks the runs by their distance in the copy of the world hit", () => {
      addSecondPath();
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 1, g: 1 }),
      ];

      // Measured against the primary world, both runs are a world's width
      // away and the one further east, path 1, is the nearer by as much as
      // it lies east. The pointer is on path 2.
      for (const worlds of [1, -1, 2]) {
        expect(
          layerManager.hitTest(pointAt(47.25, 15.25 + 360 * worlds)),
        ).toMatchObject({ pathId: 2 });
        expect(
          layerManager.hitTest(pointAt(48.5, 16.5 + 360 * worlds)),
        ).toMatchObject({ pathId: 1 });
      }
    });

    it("takes a flight across the antimeridian from the copy drawn under the pointer", () => {
      // Two flights either side of 180 degrees, drawn next to each other:
      // the eastern one in the pointer's copy of the world, the western one
      // in the next. One offset for both put the second a world away.
      const east = createSegment({
        path_id: 1,
        altitude_ft: 3000,
        coords: [
          [10, 179.9],
          [10.1, 179.95],
        ],
      });
      const west = createSegment({
        path_id: 2,
        altitude_ft: 1000,
        coords: [
          [10, -179.98],
          [10.1, -179.9],
        ],
      });
      mockApp.currentData = createDataset(
        [
          { id: 1, year: 2025 },
          { id: 2, year: 2025 },
        ],
        [east, west],
      );
      mockApp.map!.setCenter([179.97, 10]);
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 1, g: 1 }),
      ];

      // The pointer stands at 179.97, in the primary world, 0.01 degrees
      // from where the western flight is drawn (180.02) and 0.02 from the
      // eastern one
      expect(layerManager.hitTest(pointAt(10, 179.99))).toMatchObject({
        pathId: 2,
      });
      expect(layerManager.hitTest(pointAt(10, 179.92))).toMatchObject({
        pathId: 1,
      });
    });

    it("cannot tell until the last data has landed, worker and tiles", async () => {
      // The tiles of before have nothing here, where the new data may well
      // have a flight: a filter change that adds flights
      drawMergedRun();
      await landed();
      const workerAnswers = holdSetData(ALTITUDE);
      drawMode(layerManager, "altitude");
      const point = pointAt(48.1, 16.1);

      expect(layerManager.hitTest(point)).toBe("stale");
      // Nor when all the tiles had were features nobody can place
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 7, g: 2 })];
      expect(layerManager.hitTest(point)).toBe("stale");

      // The worker has the data; the tiles in view are still being cut
      mockApp.map!.isSourceLoaded.mockReturnValue(false);
      await workerAnswers();
      expect(layerManager.hitTest(point)).toBe("stale");

      mockApp.map!.isSourceLoaded.mockReturnValue(true);
      expect(layerManager.hitTest(point)).toBeNull();
    });

    it("takes a camera move for none of that", async () => {
      // Tiles load during every pan and zoom, and the source is not loaded
      // then either: a click on the empty map is still one
      drawMergedRun();
      await landed();
      mockApp.map!.isSourceLoaded.mockReturnValue(false);

      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBeNull();
    });

    it("leaves an earlier draw that lands late to the later one", async () => {
      drawMergedRun();
      await landed();
      const first = holdSetData(ALTITUDE);
      drawMode(layerManager, "altitude");
      const second = holdSetData(ALTITUDE);
      drawMode(layerManager, "altitude");

      await first();
      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBe("stale");

      await second();
      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBeNull();
    });

    it("finds the segment under the pointer in a run that crosses the antimeridian", async () => {
      // One run of one colour step: two segments east of 180 degrees as
      // the data has it, one west of it
      const points: [number, number][] = [
        [10, 178],
        [10, 179],
        [10, 179.9],
        [10, -179.9],
        [10, -179],
      ];
      const segments = points.slice(1).map((to, i) =>
        createSegment({
          path_id: 1,
          altitude_ft: 3000,
          coords: [points[i]!, to],
        }),
      );
      mockApp.currentData = createDataset([{ id: 1, year: 2025 }], segments);
      mockApp.map!.setCenter([180, 10]);
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      await landed();
      expect(features(ALTITUDE)).toHaveLength(1);
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];

      // The map reports the pointer unwrapped, east of 180 here. Searched
      // with the wrapped longitude, every eastern segment was 358 degrees
      // away, and searched with the unwrapped one every western one.
      expect(layerManager.hitTest(pointAt(10, 180.5))).toMatchObject({
        segment: segments[3],
      });
      expect(layerManager.hitTest(pointAt(10, 178.4))).toMatchObject({
        segment: segments[0],
      });
      expect(layerManager.hitTest(pointAt(10, 179.5))).toMatchObject({
        segment: segments[1],
      });
    });

    it("drops features whose run is not in the table", async () => {
      drawMergedRun();
      await landed();
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 7, g: 1 }),
        rendered(ALTITUDE, { g: 1 }),
        rendered("replay-trail", { r: 0, g: 1 }),
      ];

      expect(layerManager.hitTest(pointAt(48.1, 16.1))).toBeNull();
    });

    it("measures a run once however many tiles return it", () => {
      drawMergedRun();
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      layerManager.hitTest(pointAt(48.1, 16.1));
      const once = mockApp.map!.project.mock.calls.length;
      mockApp.map!.project.mockClear();

      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 0, g: 1 }),
      ];
      layerManager.hitTest(pointAt(48.1, 16.1));

      expect(mockApp.map!.project.mock.calls.length).toBe(once);
    });

    it("prefers the run that is closest in pixels", () => {
      addSecondPath();
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE, { r: 1, g: 1 }),
      ];

      expect(layerManager.hitTest(pointAt(47.25, 15.25))).toMatchObject({
        pathId: 2,
      });
      expect(layerManager.hitTest(pointAt(48.5, 16.5))).toMatchObject({
        pathId: 1,
      });
    });

    it("lets a selected run win a tie", () => {
      const [, fast] = drawMergedRun();
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.altitudeVisible = true;
      layerManager.updateSelectionStyles();
      // The selection's runs are cut on its own range, like the main ones
      // here; the segment objects tell which table answered
      const project = mockApp.map!.project;
      project.mockClear();
      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE, { r: 0, g: 1 }),
        rendered(ALTITUDE_SELECTED, { r: 0, g: 1 }),
      ];

      const hit = layerManager.hitTest(pointAt(48.19, 16.19));

      expect(hit).toEqual({ pathId: 1, segment: fast });
      // Both runs were measured: two ends each, after `pointAt`
      expect(project).toHaveBeenCalledTimes(5);
    });

    it("ignores the main runs of other paths in share mode", async () => {
      addSecondPath();
      mockApp.altitudeLayer.setVisible(true);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.isolateSelection = true;
      drawMode(layerManager, "altitude");
      await landed();
      // Tiles cut before the filter still show path 2
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 1, g: 1 })];

      expect(layerManager.hitTest(pointAt(47.25, 15.25))).toBeNull();

      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE_SELECTED, { r: 0, g: 1 }),
      ];
      expect(layerManager.hitTest(pointAt(48.5, 16.5))).toMatchObject({
        pathId: 1,
      });
    });

    it("queries both modes when both are shown", () => {
      mockApp.altitudeLayer.setVisible(true);
      mockApp.airspeedLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      drawMode(layerManager, "airspeed");
      mockApp.map!.renderedFeatures = [rendered(AIRSPEED, { r: 0, g: 1 })];

      expect(layerManager.hitTest(pointAt(48.5, 16.5))).toMatchObject({
        pathId: 1,
      });
      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenCalledWith(
        expect.anything(),
        {
          layers: [ALTITUDE, ALTITUDE_SELECTED, AIRSPEED, AIRSPEED_SELECTED],
        },
      );
    });
  });
});
