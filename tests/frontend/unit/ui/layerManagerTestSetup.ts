/**
 * The fixture the LayerManager test files share (layerManager.*.test.ts,
 * and the describes of terrain.test.ts and pathHover.test.ts that drive
 * the manager): the app double with one flight, the animation frames of the
 * map held for the test to run, and the helpers that read what the manager
 * wrote to the map. The mocks of maplibre-gl's Popup and of the feature
 * bundle stay in the test files, where vi.mock is hoisted; a file hands the
 * popups it records to the helpers through its bindings.
 */
import { expect, vi } from "vitest";
import type { Point } from "maplibre-gl";
import { LayerManager } from "../../../../flown/frontend/ui/layerManager";
import type { LayerMode } from "../../../../flown/frontend/ui/pathRuns";
import { scalePosition } from "../../../../flown/frontend/utils/colors";
import type {
  PathRunProperties,
  PathSegment,
} from "../../../../flown/frontend/types";
import { rankValues } from "../../../../flown/frontend/features/layers";
import {
  asMapApp,
  createDataset,
  createMockApp,
  createSegment,
  type MockApp,
} from "../../testHelpers";
import type { Popup as MockPopup } from "../../../mocks/maplibre-gl";

export interface RunFeature {
  type: "Feature";
  properties: PathRunProperties;
  geometry:
    | { type: "LineString"; coordinates: [number, number][] }
    | { type: "MultiPolygon"; coordinates: number[][][][] };
}

export const ALTITUDE = "paths-altitude";
export const ALTITUDE_SELECTED = "paths-altitude-selected";
export const AIRSPEED = "paths-airspeed";
export const AIRSPEED_SELECTED = "paths-airspeed-selected";

/**
 * The colour of a run of `value`, cut at and shown on one range from `min`
 * to `max`: the middle of the one of 32 equal steps of the ramp it falls in.
 * A selection's range is spread by the values of its segments (`sample`),
 * the full range of these tests runs evenly (see scalePosition).
 */
export function stepColor(
  colorAt: (position: number) => string,
  value: number,
  min: number,
  max: number,
  sample?: number[],
): string {
  const ranks = sample
    ? rankValues(
        [...sample].sort((a, b) => a - b),
        min,
        max,
      )
    : undefined;
  const position = scalePosition(value, min, max, ranks);
  const step = Math.min(Math.max(Math.floor(position * 32), 0), 31);
  return colorAt((step + 0.5) / 32);
}

/** A zig-zag with a kink of `offset` degrees at every other point */
export function zigZag(count: number, offset: number): [number, number][] {
  return Array.from({ length: count }, (_, i) => [
    48 + (i % 2) * offset,
    16 + i * 0.01,
  ]);
}

/**
 * Points of a turn: `count` of them round a circle of a kilometre, `step`
 * degrees of turn apart
 */
export function turn(count: number, step: number): [number, number][] {
  return Array.from({ length: count }, (_, i) => {
    const angle = (i * step * Math.PI) / 180;
    return [
      48 + 0.01 * Math.sin(angle),
      16 + (0.01 * Math.cos(angle)) / Math.cos((48 * Math.PI) / 180),
    ];
  });
}

/** Consecutive segments of one path along `points`, all at `altitude` */
export function segmentsAlong(
  points: [number, number][],
  altitude = 3000,
): PathSegment[] {
  return points.slice(1).map((end, i) =>
    createSegment({
      path_id: 1,
      altitude_ft: altitude,
      coords: [points[i]!, end],
    }),
  );
}

/**
 * Draw every flight of a mode as the manager does for a mode that shows
 * (see syncModes), without touching the visibility that goes with it
 */
export function drawMode(manager: LayerManager, mode: LayerMode): void {
  (manager as unknown as { redrawPaths(mode: LayerMode): void }).redrawPaths(
    mode,
  );
}

/** The one flight of the fixture: 3,000 ft at 100 kt, north-east */
export const segA = (): PathSegment =>
  createSegment({
    path_id: 1,
    altitude_ft: 3000,
    groundspeed_knots: 100,
    coords: [
      [48, 16],
      [49, 17],
    ],
  });

/**
 * What a test file binds the helpers to. Read at every call, not once, so
 * a test may replace the app or the manager with one of its own.
 */
export interface LayerManagerBindings {
  readonly layerManager: LayerManager;
  readonly mockApp: MockApp;
  /** Callbacks waiting for the next animation frame, by their handle */
  readonly frames: Map<number, FrameRequestCallback>;
  /** The popups the code under test made, in a file that records them */
  readonly popups?: unknown[];
}

/** The helpers that read and drive the manager of the bindings */
export function layerManagerHelpers(b: LayerManagerBindings) {
  /** A second flight, lower and slower than the first */
  function addSecondPath(): void {
    b.mockApp.currentData!.path_info.push({
      id: 2,
      year: 2025,
      aircraft_registration: "D-ABCD",
      min_altitude_ft: 2000,
      max_altitude_ft: 2000,
    });
    b.mockApp.currentData!.path_segments.push(
      createSegment({
        path_id: 2,
        altitude_ft: 2000,
        groundspeed_knots: 80,
        coords: [
          [47, 15],
          [47.5, 15.5],
        ],
      }),
    );
  }

  function features(sourceId: string): RunFeature[] {
    const data = b.mockApp.map!.source(sourceId).data as {
      type: string;
      features: RunFeature[];
    };
    expect(data.type).toBe("FeatureCollection");
    return data.features;
  }

  /** Whether a feature passes a filter of the shapes the manager writes */
  function passes(filter: unknown, properties: PathRunProperties): boolean {
    const evaluate = (expression: unknown): unknown => {
      if (!Array.isArray(expression)) return expression;
      const [op, ...args] = expression as [string, ...unknown[]];
      if (op === "literal") return args[0];
      if (op === "get") return properties[args[0] as keyof PathRunProperties];
      if (op === "!") return !evaluate(args[0]);
      if (op === "all") return args.every((arg) => evaluate(arg) === true);
      if (op === "has") return (args[0] as string) in properties;
      if (op === "in") {
        return (evaluate(args[1]) as unknown[]).includes(evaluate(args[0]));
      }
      throw new Error(`unknown expression "${op}"`);
    };
    return filter == null || evaluate(filter) === true;
  }

  /**
   * What the map is told to draw of a mode, in drawing order: every feature
   * of the two sources that its layer's filter lets through, with the width
   * and opacity of that layer's paint
   */
  function drawn(mode: "altitude" | "airspeed"): {
    pathId: number;
    options: { color: string; weight: number; opacity: number };
  }[] {
    const layers =
      mode === "altitude"
        ? [ALTITUDE, ALTITUDE_SELECTED]
        : [AIRSPEED, AIRSPEED_SELECTED];
    return layers.flatMap((id) => {
      const layer = b.mockApp.map!.layer(id);
      return features(id)
        .filter((feature) => passes(layer.filter, feature.properties))
        .map(({ properties }) => ({
          pathId: properties.pathId,
          options: {
            color: properties.color,
            weight: layer.paint["line-width"] as number,
            opacity: layer.paint["line-opacity"] as number,
          },
        }));
    });
  }

  /** A main layer's filter, which follows the selection; null for none */
  function selectionFilter(layerId: string): unknown {
    return b.mockApp.map!.layer(layerId).filter ?? null;
  }

  function setDataCalls(sourceId: string): number {
    return b.mockApp.map!.source(sourceId).setData.mock.calls.length;
  }

  function paint(layerId: string): Record<string, unknown> {
    return b.mockApp.map!.layer(layerId).paint;
  }

  function runFrames(): void {
    const due = [...b.frames.values()];
    b.frames.clear();
    for (const callback of due) callback(0);
  }

  /**
   * Let the data of the last draw land: the fake's `setData` settles at
   * once, and the manager hears of it a microtask later
   */
  function landed(): Promise<void> {
    return Promise.resolve();
  }

  /** A `setData` that stays with the worker until the test lets it go */
  function holdSetData(sourceId: string): () => Promise<void> {
    let release!: () => void;
    b.mockApp
      .map!.source(sourceId)
      .setData.mockReturnValueOnce(
        new Promise<void>((resolve) => (release = resolve)),
      );
    return async () => {
      release();
      await landed();
    };
  }

  /** What the map answers a query with: a feature of a drawn run */
  function rendered(layerId: string, properties: Partial<PathRunProperties>) {
    return { layer: { id: layerId }, properties };
  }

  /** Where the map draws a position of the data */
  function pointAt(lat: number, lng: number): Point {
    return b.mockApp.map!.project([lng, lat]) as unknown as Point;
  }

  function moveTo(point: Point): void {
    b.mockApp.map!.emit("mousemove", { point });
    runFrames();
  }

  /** The popups the code under test made, in a file that records them */
  function tooltips(): MockPopup[] {
    if (!b.popups) throw new Error("this test file records no popups");
    return b.popups as MockPopup[];
  }

  /**
   * Until the relief's code has arrived with the feature bundle: from
   * any zoom, the 3D view cuts the flights once it has
   */
  const terrainCode = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve));

  /**
   * Let the map draw a frame with every source loaded: the relief's code
   * shows the ribbons it hid as they went onto the relief (ui/terrain.ts)
   */
  const settled = (): void => {
    b.mockApp.map!.emit("render");
  };

  return {
    addSecondPath,
    features,
    drawn,
    selectionFilter,
    setDataCalls,
    paint,
    runFrames,
    landed,
    holdSetData,
    rendered,
    pointAt,
    moveTo,
    tooltips,
    terrainCode,
    settled,
  };
}

/**
 * The manager of a fresh app double with the one flight, its animation
 * frames held, and the legend elements it writes: what every test starts
 * from (see teardownLayerManager)
 */
export function setupLayerManager(): Pick<
  LayerManagerBindings,
  "layerManager" | "mockApp" | "frames"
> {
  const frames = new Map<number, FrameRequestCallback>();
  let handle = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++handle, callback);
      return handle;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );

  for (const id of [
    "legend-min",
    "legend-mid",
    "legend-max",
    "airspeed-legend-min",
    "airspeed-legend-mid",
    "airspeed-legend-max",
  ]) {
    const el = document.createElement("span");
    el.id = id;
    document.body.appendChild(el);
  }

  const mockApp = createMockApp({
    currentData: createDataset(
      // The exact altitude range of the path, as the exporter writes it
      [
        {
          id: 1,
          year: 2025,
          aircraft_registration: "D-ABCD",
          min_altitude_ft: 3000,
          max_altitude_ft: 3000,
        },
      ],
      [segA()],
    ),
    altitudeRange: { min: 0, max: 5000 },
    airspeedRange: { min: 0, max: 200 },
  });

  // Attaching the handles is setup, not something the manager did
  mockApp.map!.setLayoutProperty.mockClear();

  const layerManager = new LayerManager(asMapApp(mockApp));
  return { layerManager, mockApp, frames };
}

/** Undo setupLayerManager; the stubbed globals are undone by the config */
export function teardownLayerManager(layerManager: LayerManager): void {
  layerManager.destroy();
  document.body.innerHTML = "";
}
