/**
 * The lines of the selected flights over the heatmap: their data follows
 * the selection and the dataset (whether they show is layerVisibility's
 * business, see its tests).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  followSelectionHighlight,
  selectionLines,
  selectionOpacity,
} from "../../../../flown/frontend/ui/selectionHighlight";
import {
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../flown/frontend/utils/constants";
import { flatCurves } from "../../../../flown/frontend/calculations/curves";
import {
  asMapApp,
  createDataset,
  createMockApp,
  createSegment,
  type MockApp,
} from "../../testHelpers";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";

/** Two flights of two segments each that meet, and a third one */
function dataset(): ReturnType<typeof createDataset> {
  return createDataset(
    [
      { id: 1, year: 2025 },
      { id: 2, year: 2025 },
      { id: 3, year: 2024 },
    ],
    [
      createSegment({
        path_id: 1,
        coords: [
          [50, 8],
          [50.1, 8.1],
        ],
      }),
      createSegment({
        path_id: 1,
        coords: [
          [50.1, 8.1],
          [50.2, 8.2],
        ],
      }),
      createSegment({
        path_id: 2,
        coords: [
          [51, 9],
          [51.1, 9.1],
        ],
      }),
      createSegment({
        path_id: 2,
        coords: [
          [51.1, 9.1],
          [51.2, 9.2],
        ],
      }),
      createSegment({
        path_id: 3,
        coords: [
          [52, 10],
          [52.1, 10.1],
        ],
      }),
    ],
  );
}

describe("selection highlight", () => {
  let app: MockApp;

  const lines = (): number[][][] =>
    (
      app.map!.source(MAP_SOURCES.selectionHighlight)
        .data as GeoJSON.FeatureCollection<GeoJSON.LineString>
    ).features.map((feature) => feature.geometry.coordinates);
  const select = (...ids: number[]): void => {
    app.selectedPathIds = new Set(ids);
  };

  beforeEach(() => {
    app = createMockApp({ currentData: dataset() });
    followSelectionHighlight(asMapApp(app));
  });

  afterEach(() => {
    resetMapLibreMock();
  });

  it("draws one line per selected flight, and none without a selection", () => {
    expect(lines()).toEqual([]);

    select(2);
    expect(lines()).toEqual([
      [
        [9, 51],
        [9.1, 51.1],
        [9.2, 51.2],
      ],
    ]);

    select(1, 2);
    expect(lines()).toHaveLength(2);

    select();
    expect(lines()).toEqual([]);
  });

  it("draws no line on a selected flight the filter hides, and draws it as the filter shows it", () => {
    // Share mode keeps it, which the map does not draw: a line stood alone
    // where the filter hid the flight
    app.selectedAircraft = "D-NONE";
    select(2);
    expect(lines()).toEqual([]);

    app.selectedAircraft = "all";
    expect(lines()).toHaveLength(1);
  });

  it("follows another dataset with the same selection", () => {
    select(1);
    const source = app.map!.source(MAP_SOURCES.selectionHighlight);
    source.setData.mockClear();

    app.currentData = createDataset(
      [{ id: 1, year: 2025 }],
      [
        createSegment({
          path_id: 1,
          coords: [
            [40, 1],
            [40.1, 1.1],
          ],
        }),
      ],
    );

    expect(source.setData).toHaveBeenCalledOnce();
    expect(lines()).toEqual([
      [
        [1, 40],
        [1.1, 40.1],
      ],
    ]);
  });

  it("writes nothing while nothing is or was selected", () => {
    const source = app.map!.source(MAP_SOURCES.selectionHighlight);
    source.setData.mockClear();

    app.currentData = dataset();

    expect(source.setData).not.toHaveBeenCalled();
  });

  it("works the lines out only while they show, and as they come to show", () => {
    const source = app.map!.source(MAP_SOURCES.selectionHighlight);
    app.altitudeVisible = true;
    source.setData.mockClear();

    // A colour layer draws the selection itself
    select(1, 2);
    expect(source.setData).not.toHaveBeenCalled();

    app.altitudeVisible = false;
    expect(source.setData).toHaveBeenCalledOnce();
    expect(lines()).toHaveLength(2);
    // Nothing changed since: shown again, they are as they were
    app.replayActive = true;
    app.replayActive = false;
    expect(source.setData).toHaveBeenCalledOnce();

    // Hidden, a cleared selection still takes them away
    app.airspeedVisible = true;
    select();
    expect(lines()).toEqual([]);
  });

  it("steps aside while the 3D view draws the selection as ribbons at its height", () => {
    select(1);
    expect(lines()).toHaveLength(1);

    // ui/selectionRibbons.ts
    app.selectionRibbons = true;
    expect(lines()).toEqual([]);
    select(1, 2);
    expect(lines()).toEqual([]);

    app.selectionRibbons = false;
    expect(lines()).toHaveLength(2);
  });

  it("fades the lines as more flights are selected", () => {
    const opacity = (): unknown =>
      app.map!.layer(MAP_LAYERS.selectionHighlight).paint["line-opacity"];

    // An airport's whole traffic: 25 flights of one segment each
    const ids = Array.from({ length: 25 }, (_, index) => index + 1);
    app.currentData = createDataset(
      ids.map((id) => ({ id, year: 2025 })),
      ids.map((id) =>
        createSegment({
          path_id: id,
          coords: [
            [50, id / 10],
            [50.1, id / 10],
          ],
        }),
      ),
    );

    select(1);
    expect(opacity()).toBe(0.9);
    select(...ids);
    expect(lines()).toHaveLength(25);
    expect(opacity()).toBeCloseTo(0.45);
    // By the lines drawn: none while the 3D view draws ribbons instead
    app.selectionRibbons = true;
    expect(opacity()).toBe(0.9);
    app.selectionRibbons = false;
    select(1, 2);
    expect(opacity()).toBe(0.9);
  });

  it("draws a few flights at full strength and many at half of it", () => {
    expect(selectionOpacity(1)).toBe(0.9);
    expect(selectionOpacity(3)).toBe(0.9);
    expect(selectionOpacity(10)).toBeLessThan(0.9);
    expect(selectionOpacity(10)).toBeGreaterThan(0.45);
    expect(selectionOpacity(20)).toBeCloseTo(0.45);
    expect(selectionOpacity(300)).toBeCloseTo(0.45);
  });

  it("writes the lines again once the map has its WebGL context back", () => {
    select(1);
    const map = app.map!;
    const source = map.source(MAP_SOURCES.selectionHighlight);
    source.setData.mockClear();

    map.emit("webglcontextrestored");
    map.emit("style.load");

    expect(source.setData).toHaveBeenCalledOnce();
    expect(lines()).toHaveLength(1);
  });

  describe("selectionLines", () => {
    it("draws a line per flight", () => {
      const collection = selectionLines([
        createSegment({ path_id: 1 }),
        createSegment({ path_id: 2 }),
      ]);

      expect(collection.features).toHaveLength(2);
    });

    it("draws a flight along the curve through its fixes, like the colour lines", () => {
      // A right angle at the middle fix, which the curve rounds
      const segments = [
        createSegment({
          path_id: 1,
          coords: [
            [50, 8],
            [50.01, 8],
          ],
        }),
        createSegment({
          path_id: 1,
          coords: [
            [50.01, 8],
            [50.01, 8.015],
          ],
        }),
      ];

      const [line] = selectionLines(segments).features;

      const curve = flatCurves(segments);
      expect(line!.geometry.coordinates).toEqual(
        curve.chains[0]!.points.map(([lat, lng]) => [lng, lat]),
      );
      expect(line!.geometry.coordinates.length).toBeGreaterThan(3);
    });

    it("goes on past the antimeridian instead of round the world", () => {
      const collection = selectionLines([
        createSegment({
          path_id: 1,
          coords: [
            [60, 179.9],
            [60, -179.9],
          ],
        }),
        createSegment({
          path_id: 1,
          coords: [
            [60, -179.9],
            [60, -179.7],
          ],
        }),
      ]);

      const [line] = collection.features;
      expect(line!.geometry.coordinates.map(([lng]) => lng)).toEqual([
        179.9, 180.1, 180.3,
      ]);
    });
  });
});
