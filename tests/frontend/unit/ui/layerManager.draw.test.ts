/**
 * LayerManager: the legends, the runs of the altitude and speed paths,
 * the selection's layer, clearing a mode and the redraw after a lost
 * WebGL context.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Point, type Map as MapLibreMap } from "maplibre-gl";
import { Map as MockMap, mockControl } from "../../../mocks/maplibre-gl";
import { LayerManager } from "../../../../flown/frontend/ui/layerManager";
import { addDataLayers } from "../../../../flown/frontend/mapLayers";
import {
  airspeedColorAt,
  altitudeColorAt,
  getColorForAltitude,
} from "../../../../flown/frontend/utils/colors";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  type MockApp,
} from "../../testHelpers";
import {
  ALTITUDE,
  ALTITUDE_SELECTED,
  AIRSPEED,
  AIRSPEED_SELECTED,
  stepColor,
  zigZag,
  turn,
  segmentsAlong,
  drawMode,
  segA,
  layerManagerHelpers,
  setupLayerManager,
  teardownLayerManager,
} from "./layerManagerTestSetup";

describe("LayerManager drawing", () => {
  let layerManager: LayerManager;
  let mockApp: MockApp;
  /** Callbacks waiting for the next animation frame, by their handle */
  let frames: Map<number, FrameRequestCallback>;
  const {
    addSecondPath,
    features,
    drawn,
    selectionFilter,
    setDataCalls,
    paint,
    landed,
    rendered,
    pointAt,
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
    ({ layerManager, mockApp, frames } = setupLayerManager());
  });

  afterEach(() => teardownLayerManager(layerManager));

  describe("legend updates", () => {
    it("formats altitude legend with ft and m", () => {
      layerManager.updateAltitudeLegend({ min: 1000, max: 5000 });

      expect(document.getElementById("legend-min")!.textContent).toBe(
        "1,000 ft\n(305 m)",
      );
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5,000 ft\n(1,524 m)",
      );
    });

    it("names the median in the middle, in both units as the ends", () => {
      layerManager.updateAltitudeLegend({
        min: 0,
        max: 10000,
        ranks: Array.from({ length: 33 }, (_, i) =>
          i < 16 ? i * 100 : i * 300,
        ),
      });
      // With the second unit the ends have (it went without it)
      expect(document.getElementById("legend-mid")!.textContent).toBe(
        "4,800 ft\n(1,463 m)",
      );
      // Evenly from end to end, halfway between them
      layerManager.updateAirspeedLegend({ min: 100, max: 200 });
      expect(document.getElementById("airspeed-legend-mid")!.textContent).toBe(
        "150 kt\n(278 km/h)",
      );
    });

    it("formats airspeed legend with kt and km/h", () => {
      layerManager.updateAirspeedLegend({ min: 100, max: 200 });

      expect(document.getElementById("airspeed-legend-min")!.textContent).toBe(
        "100 kt\n(185 km/h)",
      );
      expect(document.getElementById("airspeed-legend-max")!.textContent).toBe(
        "200 kt\n(370 km/h)",
      );
    });

    it("rounds legend values", () => {
      layerManager.updateAltitudeLegend({ min: 1234.6, max: 5678.4 });
      expect(document.getElementById("legend-min")!.textContent).toBe(
        "1,235 ft\n(376 m)",
      );
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5,678 ft\n(1,731 m)",
      );
    });

    it("tolerates missing legend elements", () => {
      document.getElementById("legend-min")?.remove();
      expect(() =>
        layerManager.updateAltitudeLegend({ min: 0, max: 1 }),
      ).not.toThrow();
    });
  });

  describe("drawing the altitude paths", () => {
    it("returns early if no currentData", () => {
      mockApp.currentData = null;

      drawMode(layerManager, "altitude");

      expect(setDataCalls(ALTITUDE)).toBe(0);
      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
      expect(drawn("altitude")).toEqual([]);
    });

    it("hands the main source one LineString per run, longitude first", () => {
      drawMode(layerManager, "altitude");

      const color = stepColor(altitudeColorAt, 3000, 0, 5000);
      expect(features(ALTITUDE)).toEqual([
        {
          type: "Feature",
          properties: { r: 0, g: 1, pathId: 1, color },
          geometry: {
            type: "LineString",
            coordinates: [
              [16, 48],
              [17, 49],
            ],
          },
        },
      ]);
      // Nothing is selected: the selection's source stays as it was created
      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
      expect(setDataCalls(AIRSPEED)).toBe(0);
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.85);
      expect(selectionFilter(ALTITUDE)).toBeNull();
      expect(drawn("altitude")).toEqual([
        { pathId: 1, options: { color, weight: 4, opacity: 0.85 } },
      ]);
    });

    it("has the year worker write the lines of every flight, and writes the selection's itself", () => {
      mockApp.selectedPathIds = new Set([1]);
      const runsSource = vi.fn(() => "lines");
      mockApp.dataManager.askWorker.mockImplementation(
        (ask: (decoder: object) => unknown, take: (answer: unknown) => void) =>
          take(ask({ runsSource })),
      );

      drawMode(layerManager, "altitude");

      expect(runsSource).toHaveBeenCalledOnce();
      // A failure is logged as one of the lines, not of the heat
      expect(mockApp.dataManager.askWorker).toHaveBeenCalledWith(
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        "the lines of the flights",
      );
      expect(runsSource).toHaveBeenCalledWith(
        mockApp.currentData!.path_segments,
        [expect.objectContaining({ start: 0, end: 1, pathId: 1 })],
        1,
      );
      const source = mockApp.map!.source(ALTITUDE);
      expect(mockApp.dataManager.writeSource).toHaveBeenCalledWith(
        source,
        "lines",
      );
      // The selection's few in the frame of the click
      expect(features(ALTITUDE_SELECTED)).toHaveLength(1);
    });

    it("writes no lines of every flight the year worker answers for runs drawn again since", async () => {
      const answers: ((answer: unknown) => void)[] = [];
      mockApp.dataManager.askWorker.mockImplementation(
        (_ask: unknown, take: (answer: unknown) => void) => answers.push(take),
      );
      const source = mockApp.map!.source(ALTITUDE);

      drawMode(layerManager, "altitude");
      drawMode(layerManager, "altitude");
      answers[0]!({ type: "FeatureCollection", features: ["of before"] });

      expect(source.setData).not.toHaveBeenCalled();
      answers[1]!({ type: "FeatureCollection", features: [] });
      expect(source.setData).toHaveBeenCalledOnce();
      // Cleared meanwhile: the answer for the runs of before is not written
      drawMode(layerManager, "altitude");
      layerManager.clearLayer("altitude");
      answers[2]!({ type: "FeatureCollection", features: ["of before"] });
      await landed();
      expect(features(ALTITUDE)).toEqual([]);
    });

    it("writes the lines of every flight itself when the year worker fails", () => {
      const failures: (() => void)[] = [];
      mockApp.dataManager.askWorker.mockImplementation(
        (_ask: unknown, _take: unknown, fail: () => void) =>
          failures.push(fail),
      );

      drawMode(layerManager, "altitude");
      drawMode(layerManager, "altitude");
      // The failure of runs drawn again since writes nothing
      failures[0]!();
      expect(mockApp.map!.source(ALTITUDE).setData).not.toHaveBeenCalled();
      // That of the last ones writes their lines here, not those of before
      failures[1]!();
      expect(features(ALTITUDE)).toHaveLength(1);
      expect(features(ALTITUDE)[0]!.properties.g).toBe(2);
    });

    it("leaves the visibility of the layers to their handle", () => {
      drawMode(layerManager, "altitude");

      expect(mockApp.map!.setLayoutProperty).not.toHaveBeenCalled();
      expect(mockApp.altitudeLayer.setVisible).not.toHaveBeenCalled();
    });

    it("counts the generation of a source up with every setData", () => {
      drawMode(layerManager, "altitude");
      drawMode(layerManager, "altitude");

      expect(features(ALTITUDE)[0]!.properties.g).toBe(2);
    });

    it("merges contiguous segments in the same colour step into one run", () => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        [
          createSegment({
            path_id: 1,
            altitude_ft: 3000,
            coords: [
              [48, 16],
              [48.1, 16.1],
            ],
          }),
          // 5000 / 32 ft to a step: 3100 ft is still in the one of 3000
          createSegment({
            path_id: 1,
            altitude_ft: 3100,
            coords: [
              [48.1, 16.1],
              [48.2, 16.2],
            ],
          }),
          // another colour step: new run
          createSegment({
            path_id: 1,
            altitude_ft: 3500,
            coords: [
              [48.2, 16.2],
              [48.3, 16.3],
            ],
          }),
          // same step but not contiguous: new run
          createSegment({
            path_id: 1,
            altitude_ft: 3500,
            coords: [
              [49, 17],
              [49.1, 17.1],
            ],
          }),
        ],
      );

      drawMode(layerManager, "altitude");

      const runs = features(ALTITUDE);
      expect(runs.map((f) => f.geometry.coordinates)).toEqual([
        [
          [16, 48],
          [16.1, 48.1],
          [16.2, 48.2],
        ],
        [
          [16.2, 48.2],
          [16.3, 48.3],
        ],
        [
          [17, 49],
          [17.1, 49.1],
        ],
      ]);
      expect(runs.map((f) => f.properties.r)).toEqual([0, 1, 2]);
      expect(drawn("altitude")).toHaveLength(3);
    });

    it("draws a groundspeed that wanders within a colour step as one run", () => {
      // A step of 0..200 kt is 6.25 kt: 100.1 to 101.9 kt used to be two
      // runs per whole knot crossed
      const points = zigZag(6, 0.01);
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        points.slice(1).map((end, i) =>
          createSegment({
            path_id: 1,
            groundspeed_knots: 100.1 + i * 0.4,
            coords: [points[i]!, end],
          }),
        ),
      );

      drawMode(layerManager, "airspeed");

      expect(features(AIRSPEED)).toHaveLength(1);
      // Along the curve through the fixes (see calculations/curves.ts): the
      // fixes are points of the line, in order, with the curve's between
      const line = features(AIRSPEED)[0]!.geometry.coordinates;
      expect(line.length).toBeGreaterThan(points.length);
      let at = 0;
      for (const [lat, lng] of points) {
        at = line.findIndex((p, i) => i >= at && p[0] === lng && p[1] === lat);
        expect(at).toBeGreaterThanOrEqual(0);
      }
    });

    it("draws the runs of a turn along one curve, cut at the fixes", () => {
      const points = turn(7, 30);
      const draw = (altitudes: number[]): [number, number][][] => {
        mockApp.currentData = createDataset(
          [{ id: 1, year: 2025 }],
          points.slice(1).map((end, i) =>
            createSegment({
              path_id: 1,
              altitude_ft: altitudes[i]!,
              coords: [points[i]!, end],
            }),
          ),
        );
        drawMode(layerManager, "altitude");
        return features(ALTITUDE).map(
          (feature) => feature.geometry.coordinates as [number, number][],
        );
      };
      const [whole] = draw([3000, 3000, 3000, 3000, 3000, 3000]);
      // A point every 4 degrees of the turn at most, 8 to a segment
      expect(whole).toHaveLength(6 * 8 + 1);

      const runs = draw([3000, 5000, 3000, 5000, 3000, 5000]);
      expect(runs).toHaveLength(6);
      runs.forEach((run, i) => {
        // A colour changes at a fix, where one run ends and the next starts
        expect(run[0]).toEqual([points[i]![1], points[i]![0]]);
        expect(run[run.length - 1]).toEqual([
          points[i + 1]![1],
          points[i + 1]![0],
        ]);
      });
      // End to end they are the line of the whole flight, point for point
      expect(runs.flatMap((run, i) => (i === 0 ? run : run.slice(1)))).toEqual(
        whole,
      );
    });

    it("carries a flight on across the antimeridian instead of round the world", () => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        segmentsAlong([
          [60, 179.98],
          [60, 179.99],
          [60, -179.99],
          [60, -179.98],
        ]),
      );

      drawMode(layerManager, "altitude");

      expect(
        features(ALTITUDE)[0]!.geometry.coordinates.map(([lng]) => lng),
      ).toEqual([
        179.98,
        179.99,
        expect.closeTo(180.01, 9),
        expect.closeTo(180.02, 9),
      ]);
    });

    it("keeps every exported point, leaving simplification to the map", () => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        // Kinks of about 5 m, well below a pixel at an overview zoom
        segmentsAlong(zigZag(40, 0.00005)),
      );

      drawMode(layerManager, "altitude");

      expect(features(ALTITUDE)[0]!.geometry.coordinates).toHaveLength(40);
      expect(mockApp.map!.listenerCount("zoom")).toBe(0);
    });

    it("colours no run further than half a step from its values", () => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        segmentsAlong(zigZag(3, 0.01), 5000),
      );

      drawMode(layerManager, "altitude");

      // The top of the range falls in the last step, not past it
      expect(features(ALTITUDE)[0]!.properties.color).toBe(
        getColorForAltitude(5000 - 5000 / 64, 0, 5000),
      );
    });

    it("never merges segments of different paths", () => {
      mockApp.currentData = createDataset(
        [
          { id: 1, year: 2025 },
          { id: 2, year: 2025 },
        ],
        [
          createSegment({
            path_id: 1,
            coords: [
              [48, 16],
              [48.1, 16.1],
            ],
          }),
          createSegment({
            path_id: 2,
            coords: [
              [48.1, 16.1],
              [48.2, 16.2],
            ],
          }),
        ],
      );

      drawMode(layerManager, "altitude");

      expect(features(ALTITUDE).map((f) => f.properties.pathId)).toEqual([
        1, 2,
      ]);
    });

    it("draws a selected path on the selection's layer, on its own range", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      drawMode(layerManager, "altitude");

      // The main source keeps the path, cut on the full range
      expect(features(ALTITUDE)[0]!.properties.color).toBe(
        stepColor(altitudeColorAt, 3000, 0, 5000),
      );
      const color = stepColor(altitudeColorAt, 3000, 3000, 3000, [3000]);
      expect(features(ALTITUDE_SELECTED)).toEqual([
        {
          type: "Feature",
          properties: { r: 0, g: 1, pathId: 1, color },
          geometry: {
            type: "LineString",
            coordinates: [
              [16, 48],
              [17, 49],
            ],
          },
        },
      ]);
      expect(paint(ALTITUDE_SELECTED)).toMatchObject({
        "line-width": 6,
        "line-opacity": 1,
      });
      // Drawn once, not a second time dimmed below itself
      expect(selectionFilter(ALTITUDE)).toEqual([
        "!",
        ["in", ["get", "pathId"], ["literal", [1]]],
      ]);
      expect(drawn("altitude")).toEqual([
        { pathId: 1, options: { color, weight: 6, opacity: 1 } },
      ]);
      expect(document.getElementById("legend-min")!.textContent).toBe(
        "3,000 ft\n(914 m)",
      );
    });

    it("dims unselected paths when a selection exists", () => {
      addSecondPath();
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      drawMode(layerManager, "altitude");

      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.1);
      expect(paint(ALTITUDE)["line-width"]).toBe(4);
      expect(
        drawn("altitude").map(({ pathId, options }) => [
          pathId,
          options.weight,
          options.opacity,
        ]),
      ).toEqual([
        [2, 4, 0.1],
        [1, 6, 1],
      ]);
    });

    it("filters segments by year and aircraft", () => {
      mockApp.selectedYear = "2024";
      drawMode(layerManager, "altitude");
      expect(features(ALTITUDE)).toEqual([]);

      mockApp.selectedYear = "all";
      mockApp.selectedAircraft = "D-EFGH";
      drawMode(layerManager, "altitude");
      expect(features(ALTITUDE)).toEqual([]);

      mockApp.selectedAircraft = "D-ABCD";
      drawMode(layerManager, "altitude");
      expect(features(ALTITUDE)).toHaveLength(1);
    });

    it("keeps a selected path the filter hides off the selection's layer", () => {
      addSecondPath();
      mockApp.currentData!.path_info[1]!.year = 2024;
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      mockApp.selectedYear = "2025";

      drawMode(layerManager, "altitude");

      expect(features(ALTITUDE).map((f) => f.properties.pathId)).toEqual([1]);
      expect(features(ALTITUDE_SELECTED)).toEqual([]);
    });

    it("skips segments without path info when a filter is active", () => {
      mockApp.currentData = createDataset([], [segA()]);
      mockApp.selectedYear = "2025";

      drawMode(layerManager, "altitude");

      expect(features(ALTITUDE)).toEqual([]);
    });

    it("does not compute statistics or airport visibility (callers do)", () => {
      drawMode(layerManager, "altitude");

      expect(
        mockApp.statsManager.updateStatsForSelection,
      ).not.toHaveBeenCalled();
      expect(mockApp.airportManager.showAirports).not.toHaveBeenCalled();
    });

    it("updates the altitude legend with the full range", () => {
      drawMode(layerManager, "altitude");

      expect(document.getElementById("legend-min")!.textContent).toBe(
        "0 ft\n(0 m)",
      );
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5,000 ft\n(1,524 m)",
      );
    });

    it("shows only the selected runs in share mode, at normal weight", () => {
      addSecondPath();
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.isolateSelection = true;

      drawMode(layerManager, "altitude");

      // The main layer shows nothing; its visibility is the handle's
      expect(selectionFilter(ALTITUDE)).toEqual(["literal", false]);
      expect(mockApp.map!.setLayoutProperty).not.toHaveBeenCalled();
      expect(features(ALTITUDE_SELECTED)).toHaveLength(1);
      expect(paint(ALTITUDE_SELECTED)).toMatchObject({
        "line-width": 4,
        "line-opacity": 0.85,
      });
      expect(drawn("altitude")).toEqual([
        {
          pathId: 1,
          options: {
            color: stepColor(altitudeColorAt, 3000, 3000, 3000, [3000]),
            weight: 4,
            opacity: 0.85,
          },
        },
      ]);
    });

    it("brings the other paths back when share mode ends", () => {
      addSecondPath();
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.isolateSelection = true;
      drawMode(layerManager, "altitude");

      mockApp.isolateSelection = false;
      drawMode(layerManager, "altitude");

      expect(features(ALTITUDE).map((f) => f.properties.pathId)).toEqual([
        1, 2,
      ]);
      expect(selectionFilter(ALTITUDE)).toEqual([
        "!",
        ["in", ["get", "pathId"], ["literal", [1]]],
      ]);
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.1);
      expect(paint(ALTITUDE_SELECTED)["line-width"]).toBe(6);
      expect(drawn("altitude").map((entry) => entry.pathId)).toEqual([2, 1]);

      mockApp.selectedPathIds = new Set();
      drawMode(layerManager, "altitude");

      expect(selectionFilter(ALTITUDE)).toBeNull();
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.85);
    });

    it("sets the filter of the main layer only when it changes", () => {
      drawMode(layerManager, "altitude");
      drawMode(layerManager, "altitude");
      expect(mockApp.map!.setFilter).not.toHaveBeenCalled();

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      drawMode(layerManager, "altitude");
      drawMode(layerManager, "altitude");
      // Once for the lines and once for the ribbons of the same source
      expect(mockApp.map!.setFilter).toHaveBeenCalledTimes(2);
    });

    it("falls back to the full range when selected segments are empty", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 999]);

      drawMode(layerManager, "altitude");

      expect(features(ALTITUDE)[0]!.properties.color).toBe(
        stepColor(altitudeColorAt, 3000, 0, 5000),
      );
      expect(features(ALTITUDE_SELECTED)).toEqual([]);
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5,000 ft\n(1,524 m)",
      );
    });

    it("finds the selected paths in a dataset that is not grouped by path", () => {
      addSecondPath();
      mockApp.currentData!.path_segments.push(
        createSegment({
          path_id: 1,
          altitude_ft: 4000,
          coords: [
            [49, 17],
            [49.5, 17.5],
          ],
        }),
      );
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      drawMode(layerManager, "altitude");

      expect(
        features(ALTITUDE_SELECTED).map((f) => f.properties.pathId),
      ).toEqual([1, 1]);
    });
  });

  describe("drawing the speed paths", () => {
    it("returns early if no currentData", () => {
      mockApp.currentData = null;

      drawMode(layerManager, "airspeed");

      expect(setDataCalls(AIRSPEED)).toBe(0);
    });

    it("draws with airspeed colours and updates the airspeed legend", () => {
      drawMode(layerManager, "airspeed");

      expect(setDataCalls(ALTITUDE)).toBe(0);
      expect(features(AIRSPEED)[0]!.properties.color).toBe(
        stepColor(airspeedColorAt, 100, 0, 200),
      );
      expect(document.getElementById("airspeed-legend-max")!.textContent).toBe(
        "200 kt\n(370 km/h)",
      );
    });

    it("uses selected paths' airspeed range when paths are selected", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      drawMode(layerManager, "airspeed");

      expect(features(AIRSPEED_SELECTED)[0]!.properties.color).toBe(
        stepColor(airspeedColorAt, 100, 100, 100, [100]),
      );
    });

    it("skips segments with zero groundspeed", () => {
      mockApp.currentData!.path_segments[0]!.groundspeed_knots = 0;
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      drawMode(layerManager, "airspeed");

      expect(features(AIRSPEED)).toEqual([]);
      expect(features(AIRSPEED_SELECTED)).toEqual([]);
    });

    it("falls back to the full airspeed range when selection has no speed data", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 999]);

      drawMode(layerManager, "airspeed");

      expect(features(AIRSPEED)[0]!.properties.color).toBe(
        stepColor(airspeedColorAt, 100, 0, 200),
      );
    });
  });

  describe("before the style has loaded", () => {
    it("draws once the sources exist", async () => {
      layerManager.destroy();
      mockControl.autoLoadStyle = false;
      const map = new MockMap({ container: document.createElement("div") });
      mockControl.autoLoadStyle = true;
      let ready!: (map: MapLibreMap) => void;
      mockApp = createMockApp({
        map,
        currentData: mockApp.currentData,
        altitudeRange: { min: 0, max: 5000 },
      });
      (mockApp as { mapReady: Promise<MapLibreMap> }).mapReady = new Promise(
        (resolve) => (ready = resolve),
      );
      layerManager = new LayerManager(asMapApp(mockApp));

      expect(() => {
        drawMode(layerManager, "altitude");
        drawMode(layerManager, "airspeed");
        layerManager.clearLayer("airspeed");
        layerManager.updateSelectionStyles();
      }).not.toThrow();
      expect(layerManager.hitTest(new Point(0, 0))).toBeNull();

      map.finishStyleLoad();
      addDataLayers(map as unknown as MapLibreMap);
      ready(map as unknown as MapLibreMap);
      await Promise.resolve();

      expect(features(ALTITUDE)).toHaveLength(1);
      // Cleared last, so it stays empty
      expect(features(AIRSPEED)).toEqual([]);
    });

    it("logs what goes wrong once the map is ready, and rejects nothing", async () => {
      layerManager.destroy();
      mockControl.autoLoadStyle = false;
      const map = new MockMap({ container: document.createElement("div") });
      mockControl.autoLoadStyle = true;
      let ready!: (map: MapLibreMap) => void;
      mockApp = createMockApp({
        map,
        currentData: mockApp.currentData,
        altitudeRange: { min: 0, max: 5000 },
      });
      (mockApp as { mapReady: Promise<MapLibreMap> }).mapReady = new Promise(
        (resolve) => (ready = resolve),
      );
      layerManager = new LayerManager(asMapApp(mockApp));
      drawMode(layerManager, "altitude");
      const error = vi.spyOn(console, "error").mockImplementation(() => {});

      // The sources are there, and one of them refuses its data: a source
      // that went missing in a style swap throws the same way
      map.finishStyleLoad();
      addDataLayers(map as unknown as MapLibreMap);
      map.source(ALTITUDE).setData.mockImplementation(() => {
        throw new Error("source is gone");
      });
      ready(map as unknown as MapLibreMap);
      await Promise.resolve();
      await Promise.resolve();

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("Path layers"),
        expect.objectContaining({ message: "source is gone" }),
      );
      error.mockRestore();
    });

    it("cuts its runs without throwing in an app without a map", async () => {
      layerManager.destroy();
      mockApp = createMockApp({
        map: null,
        currentData: mockApp.currentData,
      });
      layerManager = new LayerManager(asMapApp(mockApp));

      expect(() => drawMode(layerManager, "altitude")).not.toThrow();
      await Promise.resolve();
    });
  });

  describe("clearLayer", () => {
    it("empties both sources of the mode", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      drawMode(layerManager, "altitude");
      drawMode(layerManager, "airspeed");
      expect(features(ALTITUDE_SELECTED)).toHaveLength(1);

      layerManager.clearLayer("altitude");

      expect(features(ALTITUDE)).toEqual([]);
      expect(features(ALTITUDE_SELECTED)).toEqual([]);
      expect(drawn("altitude")).toEqual([]);
      // The other mode is not touched
      expect(features(AIRSPEED)).toHaveLength(1);
    });

    it("leaves a source alone that is empty already", () => {
      layerManager.clearLayer("altitude");

      expect(setDataCalls(ALTITUDE)).toBe(0);
      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
    });
  });

  describe("updateSelectionStyles", () => {
    beforeEach(() => {
      addSecondPath();
    });

    it("rebuilds only the selection's source and dims the main layer", () => {
      mockApp.altitudeVisible = true;
      drawMode(layerManager, "altitude");
      const before = features(ALTITUDE);

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      layerManager.updateSelectionStyles();

      // The main source keeps the data and the generation it had
      expect(setDataCalls(ALTITUDE)).toBe(1);
      expect(features(ALTITUDE)).toBe(before);
      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(1);
      // Path 1 is cut at the colour steps of the selection's range now
      expect(features(ALTITUDE_SELECTED).map((f) => f.properties)).toEqual([
        {
          r: 0,
          g: 1,
          pathId: 1,
          color: stepColor(altitudeColorAt, 3000, 3000, 3000, [3000]),
        },
      ]);
      expect(mockApp.map!.setPaintProperty).toHaveBeenCalledWith(
        ALTITUDE,
        "line-opacity",
        0.1,
      );
      expect(selectionFilter(ALTITUDE)).toEqual([
        "!",
        ["in", ["get", "pathId"], ["literal", [1]]],
      ]);
      expect(drawn("altitude")).toEqual([
        {
          pathId: 2,
          options: {
            color: stepColor(altitudeColorAt, 2000, 0, 5000),
            weight: 4,
            opacity: 0.1,
          },
        },
        {
          pathId: 1,
          options: {
            color: stepColor(altitudeColorAt, 3000, 3000, 3000, [3000]),
            weight: 6,
            opacity: 1,
          },
        },
      ]);
      expect(document.getElementById("legend-min")!.textContent).toBe(
        "3,000 ft\n(914 m)",
      );
    });

    it("cuts a selected path at the colour steps of its own range", () => {
      // 3000 and 3100 ft share one of 32 steps of 0..5000 ft, but are the
      // two ends of the selected path's range
      const points = zigZag(3, 0.01);
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025, min_altitude_ft: 3000, max_altitude_ft: 3100 }],
        [
          createSegment({
            path_id: 1,
            altitude_ft: 3000,
            coords: [points[0]!, points[1]!],
          }),
          createSegment({
            path_id: 1,
            altitude_ft: 3100,
            coords: [points[1]!, points[2]!],
          }),
        ],
      );
      mockApp.altitudeVisible = true;
      drawMode(layerManager, "altitude");
      expect(features(ALTITUDE)).toHaveLength(1);

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      layerManager.updateSelectionStyles();

      expect(
        features(ALTITUDE_SELECTED).map((f) => f.properties.color),
      ).toEqual([
        stepColor(altitudeColorAt, 3000, 3000, 3100, [3000, 3100]),
        stepColor(altitudeColorAt, 3100, 3000, 3100, [3000, 3100]),
      ]);
    });

    it("returns a path to the main layer when it is deselected", () => {
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      drawMode(layerManager, "altitude");

      mockApp.selectedPathIds = new Set();
      layerManager.updateSelectionStyles();

      expect(setDataCalls(ALTITUDE)).toBe(1);
      expect(features(ALTITUDE_SELECTED)).toEqual([]);
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.85);
      expect(selectionFilter(ALTITUDE)).toBeNull();
      expect(drawn("altitude").map((entry) => entry.options)).toEqual([
        {
          color: stepColor(altitudeColorAt, 3000, 0, 5000),
          weight: 4,
          opacity: 0.85,
        },
        {
          color: stepColor(altitudeColorAt, 2000, 0, 5000),
          weight: 4,
          opacity: 0.85,
        },
      ]);
      expect(document.getElementById("legend-max")!.textContent).toBe(
        "5,000 ft\n(1,524 m)",
      );
    });

    it("counts the selection's generation up, leaving stale features behind", () => {
      mockApp.altitudeVisible = true;
      drawMode(layerManager, "altitude");

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      layerManager.updateSelectionStyles();
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      layerManager.updateSelectionStyles();

      expect(features(ALTITUDE_SELECTED).map((f) => f.properties.g)).toEqual([
        2, 2,
      ]);
      expect(features(ALTITUDE)[0]!.properties.g).toBe(1);
    });

    it("skips hidden layers", () => {
      mockApp.altitudeVisible = false;
      drawMode(layerManager, "altitude");

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      layerManager.updateSelectionStyles();

      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
      expect(paint(ALTITUDE)["line-opacity"]).toBe(0.85);
    });

    it("does nothing for a visible layer that was never drawn", () => {
      mockApp.altitudeVisible = true;
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      layerManager.updateSelectionStyles();

      expect(setDataCalls(ALTITUDE)).toBe(0);
      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
    });

    it("does nothing for a layer that was cleared", () => {
      mockApp.altitudeVisible = true;
      drawMode(layerManager, "altitude");
      layerManager.clearLayer("altitude");

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      layerManager.updateSelectionStyles();

      expect(features(ALTITUDE_SELECTED)).toEqual([]);
    });

    it("updates the airspeed layer when visible", () => {
      mockApp.airspeedVisible = true;
      drawMode(layerManager, "airspeed");

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      layerManager.updateSelectionStyles();

      expect(setDataCalls(ALTITUDE_SELECTED)).toBe(0);
      expect(features(AIRSPEED_SELECTED).map((f) => f.properties)).toEqual([
        {
          r: 0,
          g: 1,
          pathId: 2,
          color: stepColor(airspeedColorAt, 80, 80, 80, [80]),
        },
      ]);
      expect(paint(AIRSPEED)["line-opacity"]).toBe(0.1);
      expect(document.getElementById("airspeed-legend-min")!.textContent).toBe(
        "80 kt\n(148 km/h)",
      );
    });
  });

  describe("a lost WebGL context", () => {
    /**
     * The map as MapLibre leaves it until the style is back: no style, so
     * no source. Restored, the sources hold the data of before the loss.
     */
    function loseContext(): () => void {
      const map = mockApp.map!;
      const getSource = map.getSource.getMockImplementation()!;
      map.getSource.mockImplementation(() => undefined);
      return () => {
        map.getSource.mockImplementation(getSource);
        map.emit("webglcontextrestored");
        map.emit("style.load");
      };
    }

    it("does not let the features of before answer for the runs of a redraw", async () => {
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      await landed();
      const restore = loseContext();

      addSecondPath();
      drawMode(layerManager, "altitude");
      restore();
      // Features the restored tiles hold, from the data of before
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];

      // Written again, as a new generation
      expect(features(ALTITUDE).map((f) => f.properties.pathId)).toEqual([
        1, 2,
      ]);
      expect(features(ALTITUDE)[0]!.properties.g).toBeGreaterThan(1);
      expect(layerManager.hitTest(pointAt(48.5, 16.5))).toBe("stale");
    });

    it("empties a mode cleared during the loss, and leaves a hidden one for later", () => {
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      drawMode(layerManager, "airspeed");
      const restore = loseContext();

      layerManager.clearLayer("altitude");
      restore();

      expect(features(ALTITUDE)).toEqual([]);
      // Hidden: drawn once it shows
      expect(setDataCalls(AIRSPEED)).toBe(1);
    });

    it("sets the filters again, whatever the map came back with", () => {
      mockApp.altitudeLayer.setVisible(true);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      drawMode(layerManager, "altitude");
      const restore = loseContext();
      mockApp.map!.setFilter.mockClear();

      restore();

      const filter = ["!", ["in", ["get", "pathId"], ["literal", [1]]]];
      expect(mockApp.map!.setFilter).toHaveBeenCalledWith(ALTITUDE, filter);
      expect(mockApp.map!.setFilter).toHaveBeenCalledWith(
        "paths-altitude-3d",
        filter,
      );
    });

    it("writes nothing once the manager is gone", () => {
      mockApp.altitudeLayer.setVisible(true);
      drawMode(layerManager, "altitude");
      const restore = loseContext();
      layerManager.destroy();

      restore();

      expect(setDataCalls(ALTITUDE)).toBe(1);
    });
  });
});
