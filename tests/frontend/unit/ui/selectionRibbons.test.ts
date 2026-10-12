/**
 * The lines of a selection at their height in the 3D view: cut as the
 * colour layers' ribbons from the flights the heat cloud is drawn along,
 * following the relief as the other ribbons do, in place of the flat
 * lines, and worked out only while they show.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  followSelectionRibbons,
  selectionRibbons,
} from "../../../../flown/frontend/ui/selectionRibbons";
import { followSelectionHighlight } from "../../../../flown/frontend/ui/selectionHighlight";
import { followTerrain } from "../../../../flown/frontend/ui/terrain";
import {
  groundedFlights,
  heldGroundedFlights,
  releaseGroundProfiles,
} from "../../../../flown/frontend/calculations/groundProfile";
import {
  LIFT_MAX_ZOOM,
  liftExaggeration,
  ribbonId,
} from "../../../../flown/frontend/calculations/lift";
import {
  ribbonOf,
  ribbonProperties,
} from "../../../../flown/frontend/calculations/ribbons";
import { EXAGGERATION_STATE } from "../../../../flown/frontend/calculations/ribbonPaint";
import { MAP_SOURCES } from "../../../../flown/frontend/utils/constants";
import { REPLAY_CAMERA_MOVE } from "../../../../flown/frontend/utils/mapHelpers";
import type { PathSegment } from "../../../../flown/frontend/types";
import {
  asMapApp,
  createDataset,
  createMockApp,
  type MockApp,
} from "../../testHelpers";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";

/**
 * A flight of `path_id` along the latitude `lat` at 1,900 ft, over ground
 * sampled at 400 ft rising to 1,000 ft, and taxiing at both ends, its
 * segments `step` degrees of longitude each from 11 degrees east
 */
function flight(
  path_id: number,
  lat: number,
  count = 12,
  step = 0.01,
): PathSegment[] {
  return Array.from({ length: count }, (_, i) => {
    const taxi = i < 3 || i >= count - 3;
    return {
      path_id,
      coords: [
        [lat, 11 + i * step],
        [lat, 11 + (i + 1) * step],
      ],
      altitude_ft: taxi ? 400 : 1900,
      groundspeed_knots: taxi ? 10 : 100,
      ground_ft: 400 + i * 50,
      time: i * 5,
    };
  });
}

const DATA = createDataset(
  [
    { id: 1, year: 2026 },
    { id: 2, year: 2026 },
  ],
  [...flight(1, 47), ...flight(2, 48)],
);

/** The first and the last segment of the flight `pathId` in DATA, + 1 */
function stretchOf(pathId: number): [number, number] {
  const segments = DATA.path_segments;
  const start = segments.findIndex((s) => s.path_id === pathId);
  let end = start;
  while (segments[end]?.path_id === pathId) end++;
  return [start, end];
}

describe("the ribbons of a selection", () => {
  let app: MockApp;
  let lifetime: AbortController;

  const map = (): NonNullable<MockApp["map"]> => app.map!;
  const collection = (id: string): GeoJSON.FeatureCollection =>
    map().source(id).data as GeoJSON.FeatureCollection;
  const ribbons = (): GeoJSON.Feature[] =>
    collection(MAP_SOURCES.selectionHighlightRibbons).features;
  const lines = (): GeoJSON.Feature[] =>
    collection(MAP_SOURCES.selectionHighlight).features;
  const writes = (): number =>
    map().source(MAP_SOURCES.selectionHighlightRibbons).setData.mock.calls
      .length;
  const select = (...ids: number[]): void => {
    app.selectedPathIds = new Set(ids);
  };

  /**
   * The ribbon of the flight `pathId` as the layer manager cuts a colour
   * layer's, from the flights smoothed on the ground `sampled` at the
   * relief level `level`, as wide as the zoom level `widthZoom` asks
   */
  function expected(
    pathId: number,
    sampled: boolean,
    level: number,
    widthZoom: number,
  ): GeoJSON.Feature[] {
    const flights = groundedFlights(DATA.path_segments, sampled, level);
    const [start, end] = stretchOf(pathId);
    return ribbonOf(flights, start, end, widthZoom, true).map((piece) => ({
      type: "Feature",
      properties: ribbonProperties(piece, level, app.relief.epoch),
      geometry: piece.geometry,
    }));
  }

  /**
   * The 3D view on the relief at the map zoom `zoom`, as the manager has
   * it, over both flights (the fake map's view is two degrees across)
   */
  function enter3D(zoom: number): void {
    map().jumpTo({ zoom, center: [11.06, 47.5] });
    app.store.batch(() => {
      app.threeDVisible = true;
      app.relief.moveTo(Math.min(Math.floor(zoom), 11), true);
    });
  }

  async function follow(): Promise<void> {
    followTerrain(asMapApp(app));
    followSelectionHighlight(asMapApp(app));
    followSelectionRibbons(asMapApp(app));
    await app.mapReady;
  }

  beforeEach(() => {
    lifetime = new AbortController();
    app = createMockApp({ signal: lifetime.signal, currentData: DATA });
  });

  afterEach(() => {
    lifetime.abort();
    releaseGroundProfiles();
    resetMapLibreMock();
  });

  it("draw a selected flight at its height in the 3D view, cut from the flights the heat cloud is drawn along, and the flat lines step aside", async () => {
    await follow();
    enter3D(9);
    select(2);

    expect(app.store.get("selectionRibbons")).toBe(true);
    expect(lines()).toEqual([]);
    expect(ribbons().length).toBeGreaterThan(0);
    expect(ribbons()).toEqual(expected(2, true, 9, 9));
    // In the air, above the ground they took off from
    const heights = ribbons().map((f) => f.properties!["h"] as number);
    expect(Math.max(...heights)).toBeGreaterThan(1000);
    expect(ribbons().every((f) => f.properties!["l"] === 9)).toBe(true);
  });

  it("draw no ribbon of a shared flight the filter hides, and draw it as the filter shows it again", async () => {
    await follow();
    enter3D(9);
    // Share mode keeps it under a filter that hides it, where nothing of
    // it is drawn: its ribbon stood alone on the map
    app.selectedYear = "2025";
    select(2);
    expect(ribbons()).toEqual([]);

    app.selectedYear = "all";
    expect(ribbons()).toEqual(expected(2, true, 9, 9));
  });

  it("smooth the selected flights alone, unless they are most of the dataset or every flight is smoothed for the level already", async () => {
    await follow();
    enter3D(9);
    select(1);
    // Not every flight of the dataset for a few of them
    expect(heldGroundedFlights()).toBeNull();
    const alone = ribbons();

    // Every flight, and held for the colour layers and the heat cloud
    select(1, 2);
    expect(heldGroundedFlights()).toBe(DATA.path_segments);
    const all = groundedFlights(DATA.path_segments, true, 9);
    expect(ribbons()).toEqual([
      ...expected(1, true, 9, 9),
      ...expected(2, true, 9, 9),
    ]);

    // Held, they serve a few flights as well
    select(1);
    expect(ribbons()).toEqual(alone);
    expect(groundedFlights(DATA.path_segments, true, 9)).toBe(all);
  });

  it("stand on the line between the fields on the globe, as the other ribbons do", async () => {
    await follow();
    map().jumpTo({ zoom: 9, center: [11.06, 47.5] });
    app.store.batch(() => {
      app.threeDVisible = true;
      app.relief.moveTo(9, false);
    });
    select(1);

    expect(ribbons()).toEqual(expected(1, false, 9, 9));
    expect(lines()).toEqual([]);
  });

  it("take the exaggeration of a new relief level with the relief, and are cut for it in the same update", async () => {
    await follow();
    enter3D(9);
    select(1);
    const cut = ribbonId(9, app.relief.epoch);
    expect(ribbons().every((f) => f.properties!["k"] === cut)).toBe(true);

    map().jumpTo({ zoom: 8.5 });
    app.relief.moveTo(8);

    // The cut of level 9 is drawn at the exaggeration of level 8 until the
    // new one has landed, in the frame the relief switches
    expect(map().getTerrain()?.exaggeration).toBe(liftExaggeration(8));
    expect(
      map().featureStates.get(
        `${MAP_SOURCES.selectionHighlightRibbons}:${cut}`,
      ),
    ).toEqual({ [EXAGGERATION_STATE]: liftExaggeration(8) });
    expect(ribbons()).toEqual(expected(1, true, 8, 8));
    expect(
      ribbons().every(
        (f) => f.properties!["k"] === ribbonId(8, app.relief.epoch),
      ),
    ).toBe(true);
  });

  it("are cut again for another zoom level at the end of a zoom", async () => {
    await follow();
    enter3D(12);
    select(1);
    const before = writes();

    // The same relief level, the deepest, but ribbons as wide as 13 asks
    map().jumpTo({ zoom: 13.2 });
    map().emit("zoomend");

    expect(writes()).toBe(before + 1);
    expect(ribbons()).toEqual(expected(1, true, 11, 13));
    // Nothing to cut again where the zoom stays in its level
    map().jumpTo({ zoom: 13.7 });
    map().emit("zoomend");
    expect(writes()).toBe(before + 1);
  });

  it("hand over to the flat lines out of the 3D view, and zoomed in to where the flights lie flat", async () => {
    await follow();
    enter3D(9);
    select(1);
    expect(lines()).toEqual([]);

    app.threeDVisible = false;
    expect(app.store.get("selectionRibbons")).toBe(false);
    expect(ribbons()).toEqual([]);
    expect(lines()).toHaveLength(1);

    app.threeDVisible = true;
    expect(ribbons().length).toBeGreaterThan(0);
    expect(lines()).toEqual([]);

    map().jumpTo({ zoom: LIFT_MAX_ZOOM + 0.5 });
    map().emit("zoomend");
    expect(ribbons()).toEqual([]);
    expect(lines()).toHaveLength(1);
  });

  it("are worked out only while they show, and as they come to show", async () => {
    await follow();
    app.altitudeVisible = true;
    enter3D(9);
    const before = writes();

    // A colour layer draws the selection itself
    select(1, 2);
    expect(writes()).toBe(before);

    app.altitudeVisible = false;
    expect(writes()).toBe(before + 1);
    expect(ribbons()).toEqual([
      ...expected(1, true, 9, 9),
      ...expected(2, true, 9, 9),
    ]);
    // Nothing changed since: shown again, they are as they were
    app.replayActive = true;
    app.replayActive = false;
    expect(writes()).toBe(before + 1);

    // Hidden, ribbons on ground they no longer fit are taken away, so they
    // do not show on it for a moment as the lines show again
    app.airspeedVisible = true;
    map().jumpTo({ zoom: 8.5 });
    app.relief.moveTo(8);
    expect(ribbons()).toEqual([]);
    app.airspeedVisible = false;
    expect(ribbons()).toEqual([
      ...expected(1, true, 8, 8),
      ...expected(2, true, 8, 8),
    ]);

    // And a cleared selection takes them away
    select();
    expect(ribbons()).toEqual([]);
  });

  it("are cut once as the 3D view comes, on the ground the relief switches to with it", async () => {
    // The layer manager, made with the app, moves the relief as it hears
    // of the 3D view, and the store tells of the relief after the view
    app.store.subscribe("threeDVisible", (on) => {
      if (on) app.relief.moveTo(9, true);
    });
    await follow();
    select(1);
    const before = writes();

    map().jumpTo({ zoom: 9, center: [11.06, 47.5] });
    app.threeDVisible = true;

    expect(writes()).toBe(before + 1);
    expect(ribbons()).toEqual(expected(1, true, 9, 9));
  });

  it("cut nothing as a zoom ends where the flights lie flat, on the relief level the layer manager moves to first", async () => {
    await follow();
    enter3D(9);
    select(1);
    const before = writes();

    // LayerManager.handleZoomEnd hears of the zoom first
    map().jumpTo({ zoom: LIFT_MAX_ZOOM + 0.5 });
    app.relief.moveTo(11);
    map().emit("zoomend");

    // Only taken away, not cut for the level and zoom they do not show at
    expect(writes()).toBe(before + 1);
    expect(ribbons()).toEqual([]);
    expect(lines()).toHaveLength(1);
  });

  describe("zoomed in", () => {
    /** A flight of 12 segments of a degree each, from 11 to 23 east */
    const LONG = createDataset([{ id: 3, year: 2026 }], flight(3, 47, 12, 1));

    /** The ribbon of the segments `start` to `end` of LONG's flight */
    function cutOf(start: number, end: number): GeoJSON.Feature[] {
      const flights = groundedFlights(LONG.path_segments, true, 9);
      return ribbonOf(flights, start, end, 9, true).map((piece) => ({
        type: "Feature",
        properties: ribbonProperties(piece, 9, app.relief.epoch),
        geometry: piece.geometry,
      }));
    }

    beforeEach(async () => {
      app.currentData = LONG;
      await follow();
      // The fake map's view is two degrees across, and the ribbons are cut
      // for a quarter of it more on every side: 15.5 to 18.5 east
      map().jumpTo({ zoom: 9, center: [17, 47] });
      app.store.batch(() => {
        app.threeDVisible = true;
        app.relief.moveTo(9, true);
      });
      select(3);
    });

    it("cut only the stretches of the selected flights around the view", () => {
      // The segments from 15 to 19 east
      expect(ribbons()).toEqual(cutOf(4, 8));
    });

    it("are cut again as the view leaves the part of the map they were cut for, and not before", () => {
      const before = writes();

      map().jumpTo({ center: [17.3, 47] });
      map().emit("moveend");
      expect(writes()).toBe(before);

      // Not for a frame of the replay's camera
      map().jumpTo({ center: [18, 47] });
      map().emit("moveend", REPLAY_CAMERA_MOVE);
      expect(writes()).toBe(before);

      map().emit("moveend");
      expect(writes()).toBe(before + 1);
      // 16.5 to 19.5 east
      expect(ribbons()).toEqual(cutOf(5, 9));
    });

    it("are taken away, hidden, as the view leaves them, and cut again as they show", () => {
      app.altitudeVisible = true;
      map().jumpTo({ center: [21, 47] });
      map().emit("moveend");
      expect(ribbons()).toEqual([]);

      app.altitudeVisible = false;
      // 19.5 to 22.5 east
      expect(ribbons()).toEqual(cutOf(8, 12));
    });
  });

  it("are written again once the map has its WebGL context back", async () => {
    await follow();
    enter3D(9);
    select(1);
    const before = writes();

    map().emit("webglcontextrestored");
    map().emit("style.load");

    expect(writes()).toBe(before + 1);
    expect(ribbons()).toEqual(expected(1, true, 9, 9));
  });

  it("stop following the store and the map with the app", async () => {
    await follow();
    enter3D(9);
    lifetime.abort();
    const before = writes();

    select(1);
    map().emit("zoomend");

    expect(writes()).toBe(before);
  });

  it("cut the flights of a dataset that is not grouped by flight", () => {
    const [first, second] = [flight(1, 47, 6), flight(2, 48, 6)];
    // The segments of flight 1 on either side of flight 2's
    const segments = [...first.slice(0, 3), ...second, ...first.slice(3)];
    app.currentData = createDataset(
      [
        { id: 1, year: 2026 },
        { id: 2, year: 2026 },
      ],
      segments,
    );
    app.threeDVisible = true;
    app.relief.moveTo(9, true);
    select(2);

    const flights = groundedFlights(segments, true, 9);
    expect(selectionRibbons(asMapApp(app), 9)).toEqual(
      ribbonOf(flights, 3, 9, 9, true).map((piece) => ({
        type: "Feature",
        properties: ribbonProperties(piece, 9, app.relief.epoch),
        geometry: piece.geometry,
      })),
    );
  });
});
