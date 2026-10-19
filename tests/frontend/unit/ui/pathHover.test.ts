/**
 * The flight under the pointer, found among the layers and runs the layer
 * manager hands over (DrawnRuns), without a layer manager; then the
 * tooltip of a hover, through the LayerManager that listens to the map
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { LngLat, Map as MapLibreMap, Point } from "maplibre-gl";
import {
  PathHover,
  type HoverRun,
  type RunsOnLayer,
} from "../../../../flown/frontend/ui/pathHover";
import type { LayerManager } from "../../../../flown/frontend/ui/layerManager";
import type {
  PathHit,
  PathRunProperties,
  PathSegment,
} from "../../../../flown/frontend/types";
import { getColorForAltitude } from "../../../../flown/frontend/utils/colors";
import * as statistics from "../../../../flown/frontend/calculations/statistics";
import {
  createDataset,
  createMapLibreMock,
  createSegment,
  segmentOf,
  type MockApp,
} from "../../testHelpers";
import {
  resetMapLibreMock,
  type Popup as MockPopup,
} from "../../../mocks/maplibre-gl";
import {
  ALTITUDE,
  ALTITUDE_SELECTED,
  drawMode,
  layerManagerHelpers,
  setupLayerManager,
  teardownLayerManager,
} from "./layerManagerTestSetup";

describe("PathHover", () => {
  afterEach(() => resetMapLibreMock());

  /** Three segments east from 16 degrees at 48 north, 0.01 degrees each */
  const segments: PathSegment[] = [0, 1, 2].map((i) =>
    segmentOf({
      path_id: i < 2 ? 1 : 2,
      coords: [
        [48, 16 + i * 0.01],
        [48, 16 + (i + 1) * 0.01],
      ],
    }),
  );
  const runs: HoverRun[] = [
    { start: 0, end: 2, pathId: 1 },
    { start: 2, end: 3, pathId: 2 },
  ];

  /** A layer's runs, as the layer manager describes them */
  const onLayer = (fields: Partial<RunsOnLayer> = {}): RunsOnLayer => ({
    table: { runs, g: 1 },
    segments,
    selected: false,
    lift: null,
    only: null,
    ...fields,
  });

  function setup(
    layers: Record<string, RunsOnLayer>,
    stale = false,
  ): { hover: PathHover; map: ReturnType<typeof createMapLibreMock> } {
    const map = createMapLibreMock();
    map.jumpTo({ center: [16.015, 48], zoom: 12 });
    const hover = new PathHover(
      {
        map: map as unknown as MapLibreMap,
        wrappedVisible: false,
        reliefLevel: 0,
      },
      {
        readyMap: () => map as unknown as MapLibreMap,
        drawnRuns: () => ({ layers: new Map(Object.entries(layers)), stale }),
        describe: (segment) => `segment ${segments.indexOf(segment)}`,
      },
    );
    return { hover, map };
  }

  const pointAt = (
    map: ReturnType<typeof createMapLibreMock>,
    lat: number,
    lng: number,
  ): Point => map.project([lng, lat]) as unknown as Point;

  const rendered = (
    layer: string,
    properties: Partial<PathRunProperties>,
  ): unknown => ({ layer: { id: layer }, properties });

  it("finds the segment nearest to the pointer, of the run of the feature", () => {
    const { hover, map } = setup({ lines: onLayer() });
    map.renderedFeatures = [rendered("lines", { r: 0, g: 1 })];

    expect(hover.hitTest(pointAt(map, 48, 16.015))).toEqual({
      pathId: 1,
      segment: segments[1],
    });
  });

  it("finds nothing beside every flight, or stale while the tiles cannot tell", () => {
    expect(
      setup({ lines: onLayer() }).hover.hitTest({ x: 0, y: 0 } as Point),
    ).toBeNull();
    expect(
      setup({ lines: onLayer() }, true).hover.hitTest({ x: 0, y: 0 } as Point),
    ).toBe("stale");
    // No layer to look in at all
    expect(setup({}, true).hover.hitTest({ x: 0, y: 0 } as Point)).toBeNull();
  });

  it("takes a feature of an older generation for stale, not for a flight", () => {
    const { hover, map } = setup({ lines: onLayer() });
    map.renderedFeatures = [rendered("lines", { r: 0, g: 0 })];

    expect(hover.hitTest(pointAt(map, 48, 16.015))).toBe("stale");
  });

  it("leaves out a path an isolated selection does not show", () => {
    const { hover, map } = setup({ lines: onLayer({ only: new Set([2]) }) });
    map.renderedFeatures = [
      rendered("lines", { r: 0, g: 1 }),
      rendered("lines", { r: 1, g: 1 }),
    ];

    expect(hover.hitTest(pointAt(map, 48, 16.015))).toMatchObject({
      pathId: 2,
    });
  });

  it("gives a tie to the selection's layer, which is on top", () => {
    // The selection's layer draws the same flight, from runs and segments
    // of its own
    const copies = segments.map((segment) => ({ ...segment }));
    const { hover, map } = setup({
      lines: onLayer(),
      selection: onLayer({
        selected: true,
        segments: copies,
        table: { runs: runs.map((run) => ({ ...run })), g: 1 },
      }),
    });
    const point = pointAt(map, 48, 16.015);
    map.renderedFeatures = [
      rendered("lines", { r: 0, g: 1 }),
      rendered("selection", { r: 0, g: 1 }),
    ];

    const segmentHit = (): unknown => {
      const hit = hover.hitTest(point);
      return hit !== null && hit !== "stale" && hit.segment;
    };
    expect(segmentHit()).toBe(copies[1]);
    map.renderedFeatures.reverse();
    expect(segmentHit()).toBe(copies[1]);
  });

  describe("a flight about to be picked", () => {
    const prepare = vi.fn();

    beforeEach(() => {
      prepare.mockClear();
      vi.useFakeTimers({
        toFake: [
          "setTimeout",
          "clearTimeout",
          "requestAnimationFrame",
          "cancelAnimationFrame",
        ],
      });
    });
    afterEach(() => vi.useRealTimers());

    /** A hover whose paths are told a pick is near */
    function preparing(): {
      hover: PathHover;
      map: ReturnType<typeof createMapLibreMock>;
      moveTo: (lng: number) => void;
    } {
      const { hover, map } = setup({ lines: onLayer() });
      (hover as unknown as { paths: { prepare: () => void } }).paths.prepare =
        prepare;
      hover.listen(map as unknown as MapLibreMap);
      const moveTo = (lng: number): void => {
        map.renderedFeatures = [
          rendered("lines", { r: lng < 16.02 ? 0 : 1, g: 1 }),
        ];
        map.emit("mousemove", { point: pointAt(map, 48, lng) });
        vi.advanceTimersToNextFrame();
      };
      return { hover, map, moveTo };
    }

    it("is told once a pointer has rested on one flight", () => {
      const { moveTo } = preparing();

      // Each move waits for a frame of 16 ms
      moveTo(16.005);
      vi.advanceTimersByTime(200);
      // Another segment of the same flight: the wait goes on
      moveTo(16.015);
      vi.advanceTimersByTime(80);
      expect(prepare).not.toHaveBeenCalled();
      vi.advanceTimersByTime(20);
      expect(prepare).toHaveBeenCalledTimes(1);
    });

    it("is not told by a pointer that passes over flights", () => {
      const { map, moveTo } = preparing();

      moveTo(16.005);
      vi.advanceTimersByTime(250);
      // On to the next flight: its wait starts over
      moveTo(16.025);
      vi.advanceTimersByTime(250);
      map.emit("mouseout");
      vi.advanceTimersByTime(1000);

      expect(prepare).not.toHaveBeenCalled();
    });

    it("is told as a tap shows a flight's values", () => {
      const { hover, map } = preparing();

      hover.showTapped(
        { pathId: 1, segment: segments[0]! },
        map.unproject(pointAt(map, 48, 16.005)) as unknown as LngLat,
      );

      expect(prepare).toHaveBeenCalledTimes(1);
    });
  });
});

const popups = vi.hoisted((): unknown[] => []);
vi.mock("maplibre-gl", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../mocks/maplibre-gl")>();
  class Popup extends actual.Popup {
    constructor(options: Record<string, unknown> = {}) {
      super(options);
      popups.push(this);
    }
  }
  return { ...actual, Popup, default: { ...actual.default, Popup } };
});

// A tap, or a pointer that rests on a flight, fetches the feature bundle
// ahead of a pick (HoverPaths.prepare): not the real one here
const loadFeatures = vi.hoisted(() => vi.fn(() => Promise.resolve(null)));
vi.mock(
  "../../../../flown/frontend/services/featureLoader",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../flown/frontend/services/featureLoader")
    >()),
    loadFeatures,
  }),
);

describe("PathHover through the LayerManager", () => {
  let layerManager: LayerManager;
  let mockApp: MockApp;
  /** Callbacks waiting for the next animation frame, by their handle */
  let frames: Map<number, FrameRequestCallback>;
  const { runFrames, rendered, pointAt, moveTo, tooltips } =
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
      popups,
    });

  beforeEach(() => {
    popups.length = 0;
    ({ layerManager, mockApp, frames } = setupLayerManager());
  });

  afterEach(() => teardownLayerManager(layerManager));

  describe("hover tooltip", () => {
    beforeEach(() => {
      mockApp.currentData = createDataset(
        [{ id: 1, year: 2025 }],
        [
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
        ],
      );
      mockApp.altitudeLayer.setVisible(true);
      mockApp.altitudeVisible = true;
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
    });

    function content(popup: MockPopup): string {
      return popup.getElement().querySelector(".maplibregl-popup-content")!
        .innerHTML;
    }

    it("keeps the tooltip while the tiles only answer with stale features", () => {
      moveTo(pointAt(48.19, 16.19));
      const tooltip = tooltips()[0]!;
      // Drawn again: generation 2, and the tiles still hold generation 1
      drawMode(layerManager, "altitude");

      moveTo(pointAt(48.18, 16.18));

      expect(tooltip.isOpen()).toBe(true);
      expect(content(tooltip)).toContain("120 kt");
    });

    it("opens one popup that tracks the pointer, with the segment's values", () => {
      const point = pointAt(48.19, 16.19);
      moveTo(point);

      expect(tooltips()).toHaveLength(1);
      const tooltip = tooltips()[0]!;
      expect(tooltip.options).toMatchObject({
        closeButton: false,
        closeOnClick: false,
        className: "segment-details segment-tooltip",
        maxWidth: "none",
        offset: 10,
      });
      expect(tooltip.isOpen()).toBe(true);
      expect(tooltip.map).toBe(mockApp.map);
      // Placed under the pointer first: a tracking popup has no position
      // of its own until the pointer moves again
      expect(tooltip.getLngLat()).toEqual(mockApp.map!.unproject(point));
      expect(tooltip.tracksPointer).toBe(true);
      expect(content(tooltip)).toContain("120 kt");
      expect(mockApp.map!.getCanvas().style.cursor).toBe("pointer");
    });

    it("looks under the pointer once per frame", () => {
      mockApp.map!.emit("mousemove", { point: pointAt(48.19, 16.19) });
      mockApp.map!.emit("mousemove", { point: pointAt(48.18, 16.18) });
      mockApp.map!.emit("mousemove", { point: pointAt(48.01, 16.01) });

      expect(requestAnimationFrame).toHaveBeenCalledOnce();
      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();

      runFrames();

      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenCalledOnce();
      // The last position counts
      expect(content(tooltips()[0]!)).toContain("90 kt");
    });

    it("works the selection's colour ranges out once, not for every segment it shows", () => {
      // A second flight of the year, as a new dataset: the views of the
      // filter are kept per dataset
      const data = mockApp.currentData!;
      mockApp.currentData = {
        ...data,
        path_info: [...data.path_info, { id: 2, year: 2025 }],
      };
      const slices = vi.spyOn(statistics, "segmentsForPathIds");
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      layerManager.updateSelectionStyles();
      // The altitude range, which the selection's runs are cut on
      expect(slices).toHaveBeenCalledOnce();

      moveTo(pointAt(48.19, 16.19));
      moveTo(pointAt(48.01, 16.01));
      moveTo(pointAt(48.19, 16.19));
      // The speed range, once, for the first segment the tooltip showed
      expect(slices).toHaveBeenCalledTimes(2);

      // Another selection has ranges of its own
      mockApp.selectedPathIds = new Set(
        [...mockApp.selectedPathIds].filter((id) => id !== 1),
      );
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      layerManager.updateSelectionStyles();
      expect(slices).toHaveBeenCalledTimes(3);
    });

    it("works the colour range out of the selected flights the filter shows", () => {
      // Share mode keeps a flight the filter hides, which no layer draws
      const data = mockApp.currentData!;
      mockApp.currentData = {
        ...data,
        path_info: [...data.path_info, { id: 2, year: 2024 }],
      };
      mockApp.selectedYear = "2025";
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      const slices = vi.spyOn(statistics, "segmentsForPathIds");

      layerManager.updateSelectionStyles();

      // The full range: nothing of the selection is drawn
      expect(slices).not.toHaveBeenCalled();
    });

    it("sets the content only when the nearest segment changes", () => {
      moveTo(pointAt(48.19, 16.19));
      const tooltip = tooltips()[0]!;
      expect(tooltip.setHTML).toHaveBeenCalledOnce();

      // Same nearest segment: no content update
      moveTo(pointAt(48.18, 16.18));
      expect(tooltip.setHTML).toHaveBeenCalledOnce();
      expect(tooltip.addTo).toHaveBeenCalledOnce();

      moveTo(pointAt(48.01, 16.01));
      expect(tooltip.setHTML).toHaveBeenCalledTimes(2);
      expect(content(tooltip)).toContain("90 kt");
      expect(tooltips()).toHaveLength(1);
    });

    it("closes beside every flight and reuses the popup on the next one", () => {
      moveTo(pointAt(48.19, 16.19));
      const tooltip = tooltips()[0]!;

      mockApp.map!.renderedFeatures = [];
      moveTo(pointAt(40, 10));

      expect(tooltip.isOpen()).toBe(false);
      expect(mockApp.map!.getCanvas().style.cursor).toBe("");

      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 1 })];
      moveTo(pointAt(48.19, 16.19));

      expect(tooltips()).toHaveLength(1);
      expect(tooltip.isOpen()).toBe(true);
      expect(tooltip.tracksPointer).toBe(true);
      expect(content(tooltip)).toContain("120 kt");
    });

    it("closes when the pointer leaves the map", () => {
      moveTo(pointAt(48.19, 16.19));

      mockApp.map!.emit("mouseout");

      expect(tooltips()[0]!.isOpen()).toBe(false);
    });

    it("does not look while the map moves, and looks again at rest", () => {
      moveTo(pointAt(48.19, 16.19));
      const tooltip = tooltips()[0]!;
      const map = mockApp.map!;
      map.queryRenderedFeatures.mockClear();
      map.isMoving.mockReturnValue(true);

      moveTo(pointAt(48.01, 16.01));
      moveTo(pointAt(48.02, 16.02));

      expect(tooltip.isOpen()).toBe(false);
      expect(map.queryRenderedFeatures).not.toHaveBeenCalled();

      map.isMoving.mockReturnValue(false);
      map.emit("moveend");

      expect(map.queryRenderedFeatures).toHaveBeenCalledOnce();
      expect(tooltip.isOpen()).toBe(true);
      expect(content(tooltip)).toContain("90 kt");
    });

    it("does not look while a button is held down", () => {
      const map = mockApp.map!;
      map.emit("mousemove", {
        point: pointAt(48.19, 16.19),
        originalEvent: new MouseEvent("mousemove", { buttons: 1 }),
      });
      runFrames();

      expect(map.queryRenderedFeatures).not.toHaveBeenCalled();
      expect(tooltips()).toHaveLength(0);
    });

    it("tells the flight profile the segment it comes to describe", () => {
      const told: (PathSegment | null)[] = [];
      layerManager.pathHover.onHover = (segment) => told.push(segment);

      moveTo(pointAt(48.19, 16.19));
      // The same segment again: nothing new to tell
      moveTo(pointAt(48.18, 16.18));
      mockApp.map!.emit("mouseout");

      const segments = mockApp.currentData!.path_segments;
      expect(told).toEqual([segments[1], null]);
    });

    it("colours the tooltip chips on the range the runs use", () => {
      // Path 2 is selected: its range, not the full one, colours the map.
      // A dataset of its own: one is never changed once drawn
      const { path_info, path_segments } = mockApp.currentData!;
      mockApp.currentData = createDataset(
        [
          ...path_info,
          { id: 2, year: 2025, min_altitude_ft: 1000, max_altitude_ft: 1000 },
        ],
        [
          ...path_segments,
          createSegment({
            path_id: 2,
            altitude_ft: 1000,
            groundspeed_knots: 50,
            coords: [
              [47, 15],
              [47.5, 15.5],
            ],
          }),
        ],
      );
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      drawMode(layerManager, "altitude");
      mockApp.map!.renderedFeatures = [rendered(ALTITUDE, { r: 0, g: 2 })];

      moveTo(pointAt(48.19, 16.19));

      const html = content(tooltips()[0]!);
      const chip = (color: string): string => {
        const probe = document.createElement("span");
        probe.style.color = color;
        return probe.style.color;
      };
      expect(html).toContain("3,000 ft");
      expect(
        [
          getColorForAltitude(3000, 1000, 1000),
          chip(getColorForAltitude(3000, 1000, 1000)),
        ].some((color) => html.includes(color)),
      ).toBe(true);
      expect(html).not.toContain(getColorForAltitude(3000, 0, 5000));
    });

    it("shows no hover tooltip on touch devices", () => {
      (window as { ontouchstart?: unknown }).ontouchstart = null;

      moveTo(pointAt(48.19, 16.19));

      expect(tooltips()).toHaveLength(0);
    });

    it("follows the run that replaces the hovered one after a selection", () => {
      // Selecting rebuilds the runs of the path, and the tiles answer with
      // the old ones until the map has drawn the new data
      mockApp.pathSelection.togglePathSelection.mockImplementation(
        (id: number) => {
          mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, id]);
          layerManager.updateSelectionStyles();
        },
      );
      const point = pointAt(48.19, 16.19);
      moveTo(point);
      const tooltip = tooltips()[0]!;
      const hit = layerManager.hitTest(point) as PathHit;
      mockApp.map!.queryRenderedFeatures.mockClear();

      layerManager.onPathClick(hit, mockApp.map!.unproject(point) as LngLat);

      expect(mockApp.map!.listenerCount("idle")).toBe(1);
      expect(mockApp.map!.queryRenderedFeatures).not.toHaveBeenCalled();

      mockApp.map!.renderedFeatures = [
        rendered(ALTITUDE_SELECTED, { r: 0, g: 1 }),
      ];
      mockApp.map!.emit("idle");

      expect(mockApp.map!.queryRenderedFeatures).toHaveBeenCalledOnce();
      expect(tooltip.isOpen()).toBe(true);
      // Written again: the range the chips are coloured on has changed
      expect(tooltip.setHTML).toHaveBeenCalledTimes(2);
      expect(mockApp.map!.listenerCount("idle")).toBe(0);
    });

    it("does not wait for idle without a pointer on the map", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      layerManager.updateSelectionStyles();

      expect(mockApp.map!.listenerCount("idle")).toBe(0);
    });
  });
});
