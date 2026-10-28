/**
 * The replay of all flights: the player that plays every flight of a run at
 * once on the map, and the control and panel that make it a replay of the
 * map, holding the filters and the selection meanwhile.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  REPLAY_ALL_NOTHING_MESSAGE,
  REPLAY_ALL_ORBIT_REDUCED_MOTION_MESSAGE,
  REPLAY_ALL_UNAVAILABLE_MESSAGE,
  ReplayAllControls,
  replayAllClock,
  toggleReplayAll,
} from "../../../../flown/frontend/ui/replayAll";
import { featurePart } from "../../../../flown/frontend/ui/lazyBundles";
import { flightClock } from "../../../../flown/frontend/calculations/flightClock";
import {
  REPLAY_ALL_SPEED,
  ReplayAllPlayer,
} from "../../../../flown/frontend/ui/replayAllPlayer";
import {
  REPLAY_ALL_LAYER,
  type ReplayAllLayer,
} from "../../../../flown/frontend/ui/replayAllLayer";
import * as motion from "../../../../flown/frontend/utils/motion";
import {
  FEET_TO_METERS,
  MAP_LAYERS,
} from "../../../../flown/frontend/utils/constants";
import { HEAT_CLOUD_LAYER } from "../../../../flown/frontend/ui/heatCloudLayer";
import { REPLAY_PANEL_HEIGHT_VAR } from "../../../../flown/frontend/ui/replayManager";
import {
  restingPitch,
  returnToView,
} from "../../../../flown/frontend/ui/replayState";
import {
  groundedFlights,
  heldGroundedFlights,
  releaseGroundedFlights,
} from "../../../../flown/frontend/calculations/groundProfile";
import { REPLAY_CAMERA_MOVE } from "../../../../flown/frontend/utils/mapHelpers";
import {
  fitTilted,
  LEG_PAUSE_S,
} from "../../../../flown/frontend/calculations/replayAll";
import { MAP_MAX_ZOOM } from "../../../../flown/frontend/utils/constants";
import {
  LIFT_MAX_ZOOM,
  liftExaggeration,
} from "../../../../flown/frontend/calculations/lift";
import type { PathSegment } from "../../../../flown/frontend/types";
import {
  getColorForAirspeed,
  getColorForAltitude,
} from "../../../../flown/frontend/utils/colors";
import { calculateAirspeedRange } from "../../../../flown/frontend/features/layers";
import {
  asMapApp,
  createDataset,
  createMockApp,
  isHeld,
  mountElements,
  type MockApp,
} from "../../testHelpers";

const toast = vi.hoisted(() => ({
  showToast: vi.fn(),
  announceStatus: vi.fn(),
}));
/**
 * Every cut of the curves, counted, and the zoom and relief levels and the
 * colours of the last
 */
const cuts = vi.hoisted(() => ({
  count: 0,
  detail: null as number | null,
  level: null as number | null,
  colourOf: undefined as ((segment: PathSegment) => number) | undefined,
}));
vi.mock(
  "../../../../flown/frontend/calculations/replayAll",
  async (original) => {
    const module =
      await original<
        typeof import("../../../../flown/frontend/calculations/replayAll")
      >();
    return {
      ...module,
      replayAllPoints: (...args: Parameters<typeof module.replayAllPoints>) => {
        cuts.count++;
        cuts.detail = args[4];
        cuts.level = args[5];
        cuts.colourOf = args[7];
        return module.replayAllPoints(...args);
      },
    };
  },
);
vi.mock("../../../../flown/frontend/utils/toast", async (original) => ({
  ...(await original<object>()),
  showToast: toast.showToast,
  announceStatus: toast.announceStatus,
}));

/** A flight of `path_id` along the latitude `lat`: five fixes 30 s apart */
function flight(path_id: number, lat: number): PathSegment[] {
  return [0, 1, 2, 3].map((i) => ({
    path_id,
    coords: [
      [lat, 11 + i * 0.01],
      [lat, 11 + (i + 1) * 0.01],
    ],
    altitude_ft: 3000,
    groundspeed_knots: 100,
    time: i * 30,
  }));
}

/** Two flights in 2025, one of them of another aircraft, one in 2026 */
const DATA = createDataset(
  [
    { id: 1, year: 2025, aircraft_registration: "D-EAAA" },
    { id: 2, year: 2025, aircraft_registration: "D-EBBB" },
    { id: 3, year: 2026, aircraft_registration: "D-EAAA" },
  ] as never,
  [...flight(1, 47), ...flight(2, 48), ...flight(3, 49)],
);

/** Animation frames run by hand, `ms` apart */
function clockedFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let handle = 0;
  let now = 1000;
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
  return {
    run(ms = 100, times = 1): void {
      for (let n = 0; n < times; n++) {
        now += ms;
        const due = [...frames.values()];
        frames.clear();
        for (const frame of due) frame(now);
      }
    },
    pending: () => frames.size,
  };
}

/** Held while every flight replays */
const HELD = [
  // The heat is not the replay's to count again
  "heatmap-btn",
  "altitude-btn",
  "airspeed-btn",
  "year-select",
  "aircraft-select",
  "isolate-btn",
  "wrapped-btn",
  "replay-btn",
];

/** The three bytes of an `rgb(...)` colour in one number */
function packed(rgb: string): number {
  const [r, g, b] = rgb.match(/\d+/g)!.map(Number);
  return (r! << 16) | (g! << 8) | b!;
}

describe("the replay of all flights", () => {
  let app: MockApp;
  let lifetime: AbortController;
  let frames: ReturnType<typeof clockedFrames>;
  let unmount: () => void;

  const map = (): NonNullable<MockApp["map"]> => app.map!;
  /** The layer the player put on the map, as it was handed to it */
  const layer = (): ReplayAllLayer | null =>
    (
      map().getLayer(REPLAY_ALL_LAYER) as unknown as {
        implementation?: ReplayAllLayer;
      } | null
    )?.implementation ??
    (map()
      .addLayer.mock.calls.filter(
        ([spec]) => (spec as { id: string }).id === REPLAY_ALL_LAYER,
      )
      .pop()?.[0] as unknown as ReplayAllLayer | undefined) ??
    null;
  const onMap = (): boolean => !!map().getLayer(REPLAY_ALL_LAYER);

  beforeEach(() => {
    lifetime = new AbortController();
    app = createMockApp({
      signal: lifetime.signal,
      currentData: DATA,
      selectedYear: "all",
    });
    frames = clockedFrames();
    unmount = mountElements({
      ...Object.fromEntries(
        HELD.map((id) => [id, id.endsWith("select") ? "select" : "button"]),
      ),
      "replay-all-btn": "button",
    });
    toast.showToast.mockClear();
  });

  afterEach(() => {
    lifetime.abort();
    unmount();
    document.getElementById("replay-all-controls")?.remove();
    document.body.className = "";
  });

  describe("the player", () => {
    let player: ReplayAllPlayer;

    beforeEach(() => {
      player = new ReplayAllPlayer(asMapApp(app));
    });

    it("plays every flight the filters keep, from their first fixes", () => {
      void player.start();

      expect(player.flights).toBe(3);
      expect(player.playing).toBe(true);
      expect(player.time).toBe(0);
      expect(player.speed).toBe(REPLAY_ALL_SPEED);
      // Next to the heat cloud, below the flights in the air
      const order = map().getLayersOrder();
      expect(order.indexOf(REPLAY_ALL_LAYER)).toBe(
        order.indexOf(MAP_LAYERS.pathsAltitudeRibbons) - 1,
      );
    });

    it("keeps to the year and aircraft filters", () => {
      app.store.set("selectedYear", "2025");
      app.store.set("selectedAircraft", "D-EAAA");

      void player.start();

      expect(player.flights).toBe(1);
      expect(player.run!.bounds![1]).toBe(47);
    });

    it("plays the isolated selection alone", () => {
      app.store.batch(() => {
        app.selectedPathIds = new Set([...app.selectedPathIds, 2]);
        app.isolateSelection = true;
      });

      void player.start();

      expect(player.flights).toBe(1);
      expect(player.run!.bounds![1]).toBe(48);
    });

    it("plays the flights it is given, whatever the filters", () => {
      app.store.set("selectedYear", "2026");

      void player.start({ pathIds: [1, 2], speed: 500 });

      expect(player.flights).toBe(2);
      expect(player.speed).toBe(500);
    });

    it("moves the clock by the seconds of the frames times the speed", () => {
      void player.start({ speed: 100 });
      // The first frame starts the clock
      frames.run();
      expect(player.time).toBe(0);

      frames.run(50, 2);

      expect(player.time).toBeCloseTo(10, 6);
      expect(map().triggerRepaint).toHaveBeenCalled();
    });

    it("never moves it by more than a tenth of a second of a stalled frame", () => {
      void player.start({ speed: 100 });
      frames.run();

      frames.run(5000);

      expect(player.time).toBeCloseTo(10, 6);
    });

    it("says it has played once the last flight has landed, and stops once the trails have faded", async () => {
      const ended = player.start({ speed: 500 });
      let landed: boolean | null = null;
      void ended.then((value) => (landed = value));
      frames.run();

      // Some 135 s of flight, a third of a second at 500 times
      frames.run(100, 3);
      await Promise.resolve();
      expect(landed).toBe(true);
      expect(player.playing).toBe(true);

      // The trails fade over 3 s
      frames.run(100, 35);
      expect(player.playing).toBe(false);
      expect(player.time).toBeCloseTo(player.duration + 1500, 6);
      expect(frames.pending()).toBe(0);
    });

    it("fades the trails over no more than 25 minutes of flight at a thousand times", () => {
      void player.start({ speed: 1000 });
      frames.run();

      frames.run(100, 30);

      expect(player.playing).toBe(false);
      expect(player.time).toBeCloseTo(player.duration + 1500, 6);
    });

    it("jumps to a time into every flight, backwards as well, and draws from there", () => {
      void player.start({ speed: 100 });
      frames.run();
      frames.run(100, 5);
      map().triggerRepaint.mockClear();

      player.seek(80);
      expect(player.time).toBe(80);
      expect(map().triggerRepaint).toHaveBeenCalled();
      player.seek(20);
      expect(player.time).toBe(20);
      // Not past the landing of the last, nor before the start
      player.seek(1e6);
      expect(player.time).toBe(player.duration);
      player.seek(-5);
      expect(player.time).toBe(0);

      // Playing on from there
      frames.run(100);
      expect(player.time).toBeCloseTo(10, 6);
    });

    it("starts again from the beginning once it has played to the end", () => {
      void player.start({ speed: 500 });
      frames.run(100, 50);
      expect(player.playing).toBe(false);

      player.resume();

      expect(player.time).toBe(0);
      expect(player.playing).toBe(true);
    });

    it("holds the clock while paused", () => {
      void player.start({ speed: 100 });
      frames.run(100, 3);
      const held = player.time;

      player.pause();
      frames.run(100, 3);

      expect(player.time).toBe(held);
      expect(frames.pending()).toBe(0);
      player.resume();
      frames.run(100, 2);
      expect(player.time).toBeCloseTo(held + 10, 6);
    });

    it("takes the run off the map as it stops, and says it did not play to the end", async () => {
      const ended = player.start();

      player.stop();

      await expect(ended).resolves.toBe(false);
      expect(onMap()).toBe(false);
      expect(player.active).toBe(false);
      expect(player.playing).toBe(false);
    });

    it("stops when another dataset comes, which is not what it plays", async () => {
      const ended = player.start();

      app.store.set("currentData", createDataset([], flight(9, 50)));

      await expect(ended).resolves.toBe(false);
      expect(onMap()).toBe(false);
    });

    it("has nothing to play where no flight has a clock", async () => {
      app.store.set(
        "currentData",
        createDataset(
          [{ id: 1, year: 2025 }] as never,
          flight(1, 47).map(({ time: _, ...segment }) => ({
            ...segment,
            groundspeed_knots: 0,
          })),
        ),
      );

      await expect(player.start()).resolves.toBe(false);
      expect(player.flights).toBe(0);
      expect(onMap()).toBe(false);
    });

    it("stops its frames with the app, which leaves the map as it is", () => {
      void player.start();
      frames.run();

      lifetime.abort();

      expect(frames.pending()).toBe(0);
      expect(player.playing).toBe(false);
      frames.run();
      expect(frames.pending()).toBe(0);
    });

    it("goes back right below the ribbons, over the heat cloud, where a new style left it", () => {
      void player.start();
      const ribbons = MAP_LAYERS.pathsAltitudeRibbons;
      const order = (): string[] => map().getLayersOrder();

      // The heat cloud puts itself right below the replay
      map().addLayer(
        { id: HEAT_CLOUD_LAYER, type: "custom" },
        REPLAY_ALL_LAYER,
      );
      map().emit("styledata");
      expect(map().moveLayer).not.toHaveBeenCalled();

      map().moveLayer(REPLAY_ALL_LAYER);
      map().emit("styledata");

      expect(order().indexOf(REPLAY_ALL_LAYER)).toBe(
        order().indexOf(ribbons) - 1,
      );
    });

    it("smooths a few of the flights alone, holding none of the dataset", () => {
      // Of the runs before
      releaseGroundedFlights();
      void player.start({ pathIds: [1, 3] });

      expect(player.flights).toBe(2);
      expect(heldGroundedFlights()).toBeNull();
    });

    it("draws along the flights held for the 3D view, and lets go of them on the flat map as it stops", () => {
      groundedFlights(DATA.path_segments, app.terrainActive, app.reliefLevel);
      void player.start();
      expect(player.flights).toBe(3);
      expect(heldGroundedFlights()).toBe(DATA.path_segments);

      player.stop();

      expect(heldGroundedFlights()).toBeNull();
    });

    it("cuts the curves anew for another zoom, and keeps the cuts of the last ones", () => {
      void player.start();
      const drawn = vi.spyOn(layer()!, "setPoints");

      map().setZoom(14);
      map().emit("zoomend");
      map().setZoom(6);
      map().emit("zoomend");
      map().emit("zoomend");

      expect(drawn).toHaveBeenCalledTimes(2);
      map().setZoom(14.5);
      map().emit("zoomend");
      // The cut of zoom 14 again, as it was
      expect(drawn).toHaveBeenCalledTimes(3);
      expect(drawn.mock.calls[2]![0]).toBe(drawn.mock.calls[0]![0]);
    });

    it("cuts the curves as for a map further out, once a zoom under way ends", () => {
      map().setZoom(8.6);
      void player.start();
      expect(cuts.detail).toBe(8);

      // A tilt shows them smaller: a whole level of it
      player.thinOut(0.96);
      expect(cuts.detail).toBe(7);
      map().setZoom(10.2);
      map().emit("zoomend");
      expect(cuts.detail).toBe(9);

      // Not while a zoom goes on, where it ends
      map().isZooming.mockReturnValue(true);
      player.thinOut(2.2);
      expect(cuts.detail).toBe(9);
      map().isZooming.mockReturnValue(false);
      map().emit("zoomend");
      expect(cuts.detail).toBe(8);

      // None closer in, and none left for the next run
      player.thinOut(-1);
      expect(cuts.detail).toBe(10);
      player.thinOut(3);
      player.stop();
      void player.start();
      expect(cuts.detail).toBe(10);
    });

    it("cuts the curves ahead for the zoom a camera on its way sets out for, and draws them as it comes near", () => {
      // A camera setting off from far out for zoom 9
      map().setZoom(1);
      cuts.count = 0;
      void player.start({ zoom: 9 });
      // For where it is, and ahead for where it goes
      expect(cuts.count).toBe(2);
      const drawn = vi.spyOn(layer()!, "setPoints");

      // Far out it draws the curves cut for far out
      map().setZoom(5);
      map().emit("zoom");
      expect(drawn).not.toHaveBeenCalled();
      // Near, those cut ahead, cut no more
      map().setZoom(7.1);
      map().emit("zoom");
      map().setZoom(8);
      map().emit("zoom");
      expect(drawn).toHaveBeenCalledOnce();
      expect(cuts.count).toBe(2);
      // Where it comes to rest: the same
      map().setZoom(9.4);
      map().emit("zoomend", REPLAY_CAMERA_MOVE);
      expect(drawn).toHaveBeenCalledOnce();
      expect(cuts.count).toBe(2);
      // From there on the map's zoom, as without it
      map().setZoom(3);
      map().emit("zoom");
      expect(drawn).toHaveBeenCalledOnce();
      map().emit("zoomend");
      expect(drawn).toHaveBeenCalledTimes(2);
    });

    it("cuts the curves once for a run that sets out near its zoom, and for the map's alone without one", () => {
      map().setZoom(8);
      cuts.count = 0;
      void player.start({ zoom: 9 });
      expect(cuts.count).toBe(1);
      player.stop();

      map().setZoom(1);
      cuts.count = 0;
      void player.start();
      expect(cuts.count).toBe(1);
      const drawn = vi.spyOn(layer()!, "setPoints");
      // Nothing is cut while the map zooms, only as it comes to rest
      map().setZoom(9.4);
      map().emit("zoom");
      expect(drawn).not.toHaveBeenCalled();
      map().emit("zoomend");
      expect(drawn).toHaveBeenCalledOnce();
    });

    it("cuts the curves for a zoom it is aimed at once it has started, now or near it", () => {
      map().setZoom(1);
      void player.start();
      const drawn = vi.spyOn(layer()!, "setPoints");
      cuts.count = 0;

      // Cut ahead of the camera, drawn from two levels short of it
      player.aim(11);
      expect(cuts.count).toBe(1);
      expect(cuts.detail).toBe(11);
      expect(drawn).not.toHaveBeenCalled();
      map().setZoom(9.2);
      map().emit("zoom");
      expect(drawn).toHaveBeenCalledOnce();
      expect(cuts.count).toBe(1);

      // Or at once
      player.stop();
      map().setZoom(1);
      void player.start();
      cuts.count = 0;
      player.aim(12, true);
      expect(cuts.count).toBe(1);
      expect(cuts.detail).toBe(12);
      // The map's own zoom from the end of a zoom on
      map().setZoom(12.3);
      map().emit("zoomend");
      expect(cuts.detail).toBe(12);
    });

    it("colours the trails as the colour layer that is on colours the flights, on the range of its legend, and in their own amber without one or unasked", () => {
      const segment = DATA.path_segments.find((s) => s.path_id === 2)!;
      app.altitudeVisible = true;
      void player.start({ colour: true });
      const range = app.altitudeRange;
      expect(cuts.colourOf?.(segment)).toBe(
        packed(getColorForAltitude(3000, range.min, range.max, range.ranks)),
      );

      // The selection's range where one is shown, as its legend names it
      player.stop();
      app.store.batch(() => {
        app.altitudeVisible = false;
        app.airspeedVisible = true;
        app.selectedPathIds = new Set([...app.selectedPathIds, 2]);
        app.isolateSelection = true;
      });
      void player.start({ colour: true });
      const speeds = calculateAirspeedRange(
        DATA.path_segments.filter((s) => s.path_id === 2),
        app.airspeedRange,
      );
      expect(cuts.colourOf?.(segment)).toBe(
        packed(getColorForAirspeed(100, speeds.min, speeds.max, speeds.ranks)),
      );

      player.stop();
      void player.start();
      expect(cuts.colourOf).toBeUndefined();
      player.stop();
      app.airspeedVisible = false;
      void player.start({ colour: true });
      expect(cuts.colourOf).toBeUndefined();
    });

    it("leaves the trail out where the Groundspeed layer draws no line, at no speed, as the altitude layer does not", () => {
      const segment = DATA.path_segments.find((s) => s.path_id === 2)!;
      const taxiing = { ...segment, groundspeed_knots: 0 };
      app.airspeedVisible = true;
      void player.start({ colour: true });

      // Negated: the stretch is not drawn, its head in the ramp's low end
      expect(cuts.colourOf!(segment)).toBeGreaterThan(0);
      const low = cuts.colourOf!(taxiing);
      expect(low).toBeLessThan(0);
      const range = app.airspeedRange;
      expect(-low).toBe(
        packed(getColorForAirspeed(0, range.min, range.max, range.ranks)),
      );

      player.stop();
      app.store.batch(() => {
        app.airspeedVisible = false;
        app.altitudeVisible = true;
      });
      void player.start({ colour: true });
      expect(cuts.colourOf!(taxiing)).toBeGreaterThan(0);
    });

    it("draws the flights at their height without the 3D view too, on the relief only where it is drawn", async () => {
      const style = (): { groundM: number; liftM: number } =>
        (
          layer() as unknown as {
            style: () => { groundM: number; liftM: number };
          }
        ).style();
      /** Metres a foot is lifted by at the relief level `level` */
      const liftM = (level: number): number =>
        liftExaggeration(level) * FEET_TO_METERS;
      // The heat cloud follows where the map comes to rest from here on
      await app.mapReady;
      map().setZoom(9.4);
      map().emit("zoomend");
      void player.start();

      // Flat ground, lifted as the heat cloud is: at the level of the zoom
      // the map came to rest at, not at those of a scripted camera
      expect(style()).toEqual(
        expect.objectContaining({ groundM: 0, liftM: liftM(9) }),
      );
      map().setZoom(2);
      map().emit("zoomend", REPLAY_CAMERA_MOVE);
      expect(style().liftM).toBe(liftM(9));
      // From where the 3D view draws them flat too, handed over as the
      // cloud and the ribbons are, once the zoom has ended
      map().setZoom(LIFT_MAX_ZOOM);
      expect(style().liftM).toBe(liftM(9));
      map().emit("zoomend", REPLAY_CAMERA_MOVE);
      expect(style().liftM).toBe(0);

      map().setZoom(9.4);
      map().emit("zoomend", REPLAY_CAMERA_MOVE);
      app.store.batch(() => {
        app.threeDVisible = true;
        app.terrainActive = true;
        app.reliefLevel = 8;
      });
      expect(style()).toEqual(
        expect.objectContaining({ groundM: liftM(8), liftM: liftM(8) }),
      );
      // The relief's own exaggeration, which it switches as a zoom ends
      map().terrain = { source: "terrain", exaggeration: 3 };
      expect(style().liftM).toBeCloseTo(3 * FEET_TO_METERS, 9);
    });

    it("thins the curves for the height of the level they are lifted as, on the flat map as well", async () => {
      await app.mapReady;
      map().setZoom(9.4);
      map().emit("zoomend");

      void player.start();

      expect(cuts.level).toBe(9);
      app.store.batch(() => {
        app.threeDVisible = true;
        app.reliefLevel = 6;
      });
      expect(cuts.level).toBe(6);
    });

    it("cuts the curves for the level the heat cloud takes as a zoom ends, from its first run on", async () => {
      // Started in the task the player was made in, before the cloud it
      // follows has the map ready
      app = createMockApp({
        signal: lifetime.signal,
        currentData: DATA,
        selectedYear: "all",
      });
      void new ReplayAllPlayer(asMapApp(app)).start();
      await app.mapReady;
      expect(cuts.level).toBe(0);

      map().setZoom(9.4);
      map().emit("zoomend");

      expect(cuts.level).toBe(9);
    });

    it("turns the camera slowly round the flights while it plays, when asked", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
      void player.start();
      player.orbit = true;
      frames.run();

      frames.run(100, 10);

      expect(map().getBearing()).toBeCloseTo(3, 6);
      expect(map().jumpTo.mock.lastCall?.[1]).toBe(REPLAY_CAMERA_MOVE);
    });

    it("tells the map the camera has come to rest once the orbit stops turning it", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
      void player.start();
      player.orbit = true;
      frames.run();
      frames.run(100, 3);
      const rests = (): number =>
        map().fire.mock.calls.filter(([type]) => type === "moveend").length;
      expect(rests()).toBe(0);

      player.orbit = false;
      frames.run();
      frames.run();

      // Once, untagged, so the saved view and the link follow
      expect(rests()).toBe(1);
      expect(map().fire).toHaveBeenLastCalledWith("moveend");
    });

    it("does not turn the camera under reduced motion", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      void player.start();
      player.orbit = true;

      frames.run(100, 10);

      expect(map().jumpTo).not.toHaveBeenCalled();
    });
  });

  describe("the control and its panel", () => {
    let controls: ReplayAllControls;

    const panel = (): HTMLElement =>
      document.getElementById("replay-all-controls")!;
    const clock = (): string =>
      document.getElementById("replay-all-clock")!.textContent ?? "";
    const held = (id: string): boolean => isHeld(document.getElementById(id));

    beforeEach(() => {
      controls = new ReplayAllControls(asMapApp(app));
    });

    it("plays every flight as a replay of the map, and holds the filters", () => {
      controls.show();

      expect(controls.isOpen).toBe(true);
      expect(app.replayActive).toBe(true);
      expect(app.replayState.all).toBe(true);
      for (const id of HELD) expect(held(id), id).toBe(true);
      expect(panel().hidden).toBe(false);
      expect(document.body.classList).toContain("replay-all-active");
      const button = document.getElementById("replay-all-btn")!;
      expect(button.getAttribute("aria-pressed")).toBe("true");
      expect(button.dataset["icon"]).toBe("stop");
      expect(onMap()).toBe(true);
    });

    /** The camera the replay moved the map to as it opened */
    const fitted = () =>
      map().easeTo.mock.calls.find(([options]) => "zoom" in options)?.[0];

    it("fits the camera to the flights, north up, from the fit of their bounds", () => {
      map().jumpTo({ bearing: 40 });

      controls.show();

      expect(map().cameraForBounds).toHaveBeenCalledWith(
        [
          [11, 47],
          [expect.closeTo(11.04, 6), 49],
        ],
        expect.objectContaining({ bearing: 0 }),
      );
      // A map of no size has no room to fit them into any closer
      expect(fitted()).toMatchObject({
        center: [expect.closeTo(11.02, 6), 48],
        bearing: 0,
      });
    });

    it("fits the flights themselves on the tilted map, clear of the panel under them", () => {
      const width = 1200;
      const height = 800;
      vi.spyOn(map().getContainer(), "getBoundingClientRect").mockReturnValue(
        DOMRect.fromRect({ width, height }),
      );
      vi.spyOn(
        HTMLElement.prototype,
        "getBoundingClientRect",
      ).mockImplementation(function (this: HTMLElement) {
        return this.id === "replay-all-controls"
          ? DOMRect.fromRect({ y: 700, width: 600, height: 60 })
          : DOMRect.fromRect();
      });
      // Where the fit of the bounds of the flights puts it (the fake's
      // cameraForBounds keeps the zoom)
      map().jumpTo({ zoom: 7 });

      controls.show();

      // Measured from the fit of the bounds, with a margin at every edge
      // and above the panel (see calculations/replayAll.test.ts for how
      // they fill it)
      const run = controls.player.run!;
      const expected = fitTilted(
        run,
        { center: [11.02, 48], zoom: 7 },
        {
          width,
          height,
          padding: { top: 24, right: 24, bottom: 800 - 700 + 24, left: 24 },
          pitch: 50,
          fov: map().getVerticalFieldOfView(),
        },
        MAP_MAX_ZOOM,
      );
      const camera = fitted() as typeof expected;
      expect(camera.zoom).toBeCloseTo(expected.zoom, 6);
      expect(camera.zoom).not.toBeCloseTo(7, 1);
      expect(camera.center[0]).toBeCloseTo(expected.center[0], 6);
      expect(camera.center[1]).toBeCloseTo(expected.center[1], 6);
      // The curves are cut as for the fit of the flat map, which the tilt
      // shows the flights as large as: fewer points to draw every frame
      const levels = Math.round(camera.zoom - 7);
      expect(levels).toBeGreaterThan(0);
      expect(cuts.detail).toBe(Math.floor(camera.zoom) - levels);
    });

    it("tilts a flat map as the 3D view does, so the heights show, and lays it flat again as it closes", () => {
      controls.show();

      expect(fitted()).toMatchObject({ pitch: 50 });
      expect(map().getPitch()).toBe(50);

      controls.close();

      expect(map().easeTo).toHaveBeenLastCalledWith({ pitch: 0 });
      expect(map().getPitch()).toBe(0);
    });

    it("keeps a map tilted enough already as it is, and leaves it so", () => {
      map().jumpTo({ pitch: 30 });

      controls.show();
      expect(fitted()).toMatchObject({ pitch: 30 });
      map().easeTo.mockClear();
      controls.close();

      expect(map().easeTo).not.toHaveBeenCalled();
      expect(map().getPitch()).toBe(30);
    });

    it("leaves the tilt the user gave the map meanwhile, and the 3D view's", () => {
      const byHand = { originalEvent: new MouseEvent("mousemove") };
      map().jumpTo({ pitch: 5 });
      controls.show();
      // Its own moves are not the user's, nor is a turn by a right drag
      // that strays a little up or down
      map().emit("pitchstart", {});
      map().jumpTo({ pitch: 20 });
      map().emit("pitchend", {});
      map().emit("pitchstart", byHand);
      map().jumpTo({ pitch: 24 });
      map().emit("pitchend", byHand);
      controls.close();
      expect(map().easeTo).toHaveBeenLastCalledWith({ pitch: 5 });

      controls.show();
      map().emit("pitchstart", byHand);
      map().jumpTo({ pitch: 70 });
      map().emit("pitchend", byHand);
      map().easeTo.mockClear();
      controls.close();
      expect(map().easeTo).not.toHaveBeenCalled();
      expect(map().getPitch()).toBe(70);

      map().jumpTo({ pitch: 0 });
      controls.show();
      app.threeDVisible = true;
      app.threeDVisible = false;
      map().easeTo.mockClear();
      controls.close();
      expect(map().easeTo).not.toHaveBeenCalled();
      expect(map().getPitch()).toBe(50);
    });

    it("lays back a map it tilted in the 3D view as well", () => {
      app.threeDVisible = true;
      map().jumpTo({ pitch: 10 });

      controls.show();
      expect(map().getPitch()).toBe(50);
      controls.close();

      expect(map().easeTo).toHaveBeenLastCalledWith({ pitch: 10 });
    });

    it("tilts from where it laid the map back to, opened again on the way there", () => {
      controls.show();
      controls.close();
      // Half way back
      map().jumpTo({ pitch: 25 });
      map().isMoving.mockReturnValue(true);

      controls.show();
      expect(map().getPitch()).toBe(50);
      controls.close();

      expect(map().easeTo).toHaveBeenLastCalledWith({ pitch: 0 });
    });

    it("keeps the tilt from before in the link and the saved state while the map is tilted for it", () => {
      map().jumpTo({ pitch: 5 });
      controls.show();

      expect(app.replayState.pitchBefore).toBe(5);
      controls.close();
      expect(app.replayState.pitchBefore).toBeNull();
      // Laid back
      map().emit("moveend");

      map().jumpTo({ pitch: 30 });
      controls.show();
      expect(app.replayState.pitchBefore).toBeNull();
    });

    it("forgets the tilt it laid the map back to once it is there", () => {
      controls.show();
      controls.close();
      expect(restingPitch(asMapApp(app))).toBe(0);
      map().emit("moveend");
      // Tilted by hand since, and opened again while the map still moves
      map().jumpTo({ pitch: 30 });
      map().isMoving.mockReturnValue(true);

      map().easeTo.mockClear();
      controls.show();

      expect(fitted()).toMatchObject({ pitch: 30 });
      expect(app.replayState.pitchBefore).toBeNull();
    });

    it("takes the tilt of a camera flying back to the user's view as where it goes", () => {
      // A chase or the tour easing back to a flat map, half way there
      map().jumpTo({ pitch: 40 });
      returnToView(asMapApp(app), {
        center: { lat: 47, lng: 11 },
        zoom: 9,
        bearing: 0,
        pitch: 0,
      });
      controls.show();

      expect(app.replayState.pitchBefore).toBe(0);
      controls.close();
      expect(map().easeTo).toHaveBeenLastCalledWith({ pitch: 0 });
    });

    it("reads the time into every flight on its clock", () => {
      controls.show();
      expect(clock()).toBe("0:00 into every flight");

      frames.run();
      frames.run(100, 3);

      // 60 s of flight at 200 times
      expect(clock()).toBe("0:01 into every flight");
    });

    it("pauses and plays from its button, which says what a press does", () => {
      controls.show();
      const play = document.getElementById("replay-all-play-btn")!;
      expect(play.getAttribute("aria-label")).toBe(
        "Pause the replay of all flights",
      );

      play.click();

      expect(controls.player.playing).toBe(false);
      expect(play.dataset["icon"]).toBe("play");
      expect(play.getAttribute("aria-label")).toBe(
        "Play the replay of all flights",
      );
      expect(play.title).toBe(play.getAttribute("aria-label"));
      play.click();
      expect(controls.player.playing).toBe(true);
    });

    it("says every flight has landed each time it plays to the end", () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        controls.show();
        const live = document.getElementById("replay-all-live")!;
        const play = document.getElementById("replay-all-play-btn")!;
        frames.run();
        frames.run(100, 50);
        vi.runAllTimers();
        expect(live.textContent).toBe("Every flight has landed");
        expect(controls.player.playing).toBe(false);

        // From the start again: a second play-through says it again
        play.click();
        vi.runAllTimers();
        expect(live.textContent).toBe("Playing");
        frames.run();
        frames.run(100, 50);
        vi.runAllTimers();
        expect(live.textContent).toBe("Every flight has landed");
      } finally {
        vi.useRealTimers();
      }
    });

    it("plays at the speed picked", () => {
      controls.show();
      const speed = document.getElementById(
        "replay-all-speed",
      ) as HTMLSelectElement;
      expect([...speed.options].map((option) => option.value)).toEqual([
        "100",
        "200",
        "300",
        "500",
        "1000",
      ]);

      speed.value = "500";
      speed.dispatchEvent(new Event("change"));

      expect(controls.player.speed).toBe(500);
    });

    it("moves its slider with the clock, which it reads out as the time into every flight", () => {
      controls.show();
      const slider = document.getElementById(
        "replay-all-time",
      ) as HTMLInputElement;
      expect(slider.type).toBe("range");
      expect(slider.getAttribute("aria-label")).toBe("Time into every flight");
      // To the landing of the last, some 105 s in, in steps of a minute
      expect(slider.max).toBe("120");
      expect(slider.step).toBe("60");
      expect(slider.getAttribute("aria-valuetext")).toBe(
        "0:00 into every flight",
      );

      frames.run();
      frames.run(100, 4);

      // 80 s of flight at 200 times
      expect(Number(slider.value)).toBeCloseTo(80, 6);
      expect(slider.getAttribute("aria-valuetext")).toBe(
        "0:01 into every flight",
      );
    });

    it("looks up none of its parts in a frame", () => {
      controls.show();
      frames.run();
      const lookups = vi.spyOn(panel(), "querySelector");

      frames.run(100, 4);

      expect(clock()).toBe("0:01 into every flight");
      expect(lookups).not.toHaveBeenCalled();
    });

    it("jumps to where its slider is moved, and plays on from there", () => {
      controls.show();
      const slider = document.getElementById(
        "replay-all-time",
      ) as HTMLInputElement;
      frames.run();

      slider.value = "60";
      slider.dispatchEvent(new Event("input"));

      expect(controls.player.time).toBe(60);
      expect(controls.player.playing).toBe(true);
      expect(clock()).toBe("0:01 into every flight");
      // No further than the last landing
      slider.value = "120";
      slider.dispatchEvent(new Event("input"));
      expect(controls.player.time).toBe(controls.player.duration);
      slider.value = "0";
      slider.dispatchEvent(new Event("input"));
      expect(controls.player.time).toBe(0);
    });

    it("holds the clock while its slider is dragged, and plays on as it is let go", () => {
      controls.show();
      const slider = document.getElementById(
        "replay-all-time",
      ) as HTMLInputElement;

      slider.dispatchEvent(new Event("pointerdown"));
      expect(controls.player.playing).toBe(false);
      slider.value = "60";
      slider.dispatchEvent(new Event("input"));
      frames.run(100, 3);
      expect(controls.player.time).toBe(60);

      window.dispatchEvent(new Event("pointerup"));
      expect(controls.player.playing).toBe(true);

      // A paused replay stays paused
      controls.player.pause();
      slider.dispatchEvent(new Event("pointerdown"));
      window.dispatchEvent(new Event("pointerup"));
      expect(controls.player.playing).toBe(false);
    });

    it("colours its trails as the colour layer that is on", () => {
      cuts.colourOf = undefined;
      app.altitudeVisible = true;
      toggleReplayAll(asMapApp(app));
      expect(cuts.colourOf).toBeDefined();
    });

    it("tells the heat its clock only while it is open", () => {
      // As the heat cloud reads it (ui/heatCloud.ts)
      const time = () => featurePart(asMapApp(app), "replayAll")?.time ?? null;
      expect(time()).toBeNull();
      toggleReplayAll(asMapApp(app));
      expect(time()).toBe(0);

      toggleReplayAll(asMapApp(app));

      expect(time()).toBeNull();
    });

    it("turns the orbit on and off, and a camera the user moves turns it off", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
      controls.show();
      const orbit = document.getElementById("replay-all-orbit-btn")!;
      expect(orbit.getAttribute("aria-pressed")).toBe("false");

      orbit.click();
      expect(controls.player.orbit).toBe(true);
      expect(orbit.getAttribute("aria-pressed")).toBe("true");

      // Its own jumps are not the user's
      map().emit("movestart", {});
      expect(controls.player.orbit).toBe(true);
      map().emit("movestart", { originalEvent: new MouseEvent("mousedown") });
      expect(controls.player.orbit).toBe(false);
      expect(orbit.getAttribute("aria-pressed")).toBe("false");
    });

    it("keeps the orbit off under reduced motion, and says why as it is pressed", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      controls.show();
      const orbit = document.getElementById(
        "replay-all-orbit-btn",
      ) as HTMLButtonElement;
      // Still in the tab order, so a keyboard can find out why
      expect(orbit.disabled).toBe(false);

      orbit.click();

      expect(controls.player.orbit).toBe(false);
      expect(orbit.getAttribute("aria-pressed")).toBe("false");
      expect(toast.showToast).toHaveBeenCalledWith(
        REPLAY_ALL_ORBIT_REDUCED_MOTION_MESSAGE,
        "info",
      );
    });

    it("opens again with the orbit off", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
      controls.show();
      document.getElementById("replay-all-orbit-btn")!.click();
      controls.close();

      controls.show();

      expect(controls.player.orbit).toBe(false);
      expect(
        document
          .getElementById("replay-all-orbit-btn")!
          .getAttribute("aria-pressed"),
      ).toBe("false");
    });

    it("stacks the toasts above its panel while it is open", () => {
      controls.show();
      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toMatch(/px$/);

      controls.close();

      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toBe("");
    });

    it("gives the page back as it was when closed", () => {
      controls.show();

      document.getElementById("replay-all-close-btn")!.click();

      expect(controls.isOpen).toBe(false);
      expect(app.replayActive).toBe(false);
      expect(app.replayState.all).toBe(false);
      for (const id of HELD) expect(held(id), id).toBe(false);
      expect(panel().hidden).toBe(true);
      expect(document.body.classList).not.toContain("replay-all-active");
      const button = document.getElementById("replay-all-btn")!;
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(document.activeElement).toBe(button);
      expect(onMap()).toBe(false);
    });

    it("leaves focus the user took elsewhere where it is as it closes", () => {
      controls.show();
      const elsewhere = document.createElement("button");
      document.body.append(elsewhere);
      elsewhere.focus();

      controls.close();

      expect(controls.isOpen).toBe(false);
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });

    it("gives a control back disabled when it was before (regression)", () => {
      // The speed layer on a site without timing data: closing the replay
      // turned it on
      const speed = document.getElementById(
        "airspeed-btn",
      ) as HTMLButtonElement;
      speed.disabled = true;
      controls.show();
      expect(held("airspeed-btn")).toBe(true);

      controls.close();

      expect(held("airspeed-btn")).toBe(true);
      expect(held("altitude-btn")).toBe(false);
    });

    it("closes on Escape, but not from the speed picker or a text field", () => {
      controls.show();
      const speed = document.getElementById("replay-all-speed")!;
      const search = document.createElement("input");
      search.type = "search";
      document.body.append(search);

      for (const target of [speed, search]) {
        const escape = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(escape);
        expect(escape.defaultPrevented).toBe(false);
      }
      expect(controls.isOpen).toBe(true);
      search.remove();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(controls.isOpen).toBe(false);
    });

    it("closes when the player stops from elsewhere", () => {
      controls.show();

      controls.player.stop();

      expect(controls.isOpen).toBe(false);
      expect(app.replayActive).toBe(false);
    });

    it("says so when there is nothing to play, and holds nothing", () => {
      app.store.set("currentData", createDataset([], []));

      controls.show();

      expect(toast.showToast).toHaveBeenCalledWith(
        REPLAY_ALL_NOTHING_MESSAGE,
        "info",
      );
      expect(controls.isOpen).toBe(false);
      expect(app.replayActive).toBe(false);
      expect(held("year-select")).toBe(false);
    });

    it("says so where its shaders do not work", async () => {
      const layer = (
        controls.player as unknown as {
          layer: { failed: (error: unknown) => void };
        }
      ).layer;
      vi.spyOn(console, "error").mockImplementation(() => {});
      layer.failed(new Error("no WebGL 2"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      controls.show();

      expect(toast.showToast).toHaveBeenCalledWith(
        REPLAY_ALL_UNAVAILABLE_MESSAGE,
        "error",
      );
      expect(controls.isOpen).toBe(false);
    });

    it("says so as its shaders fail in the run they were first tried in, and closes", async () => {
      controls.show();
      expect(controls.isOpen).toBe(true);
      const layer = (
        controls.player as unknown as {
          layer: { failed: (error: unknown) => void };
        }
      ).layer;
      vi.spyOn(console, "error").mockImplementation(() => {});
      // In the first frame of the layer on the map
      layer.failed(new Error("the replay's shader did not compile"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(controls.isOpen).toBe(false);
      expect(app.replayActive).toBe(false);
      expect(toast.showToast).toHaveBeenCalledOnce();
      expect(toast.showToast).toHaveBeenCalledWith(
        REPLAY_ALL_UNAVAILABLE_MESSAGE,
        "error",
      );
    });

    it("says nothing of the shaders as it closes where they worked", () => {
      controls.show();
      controls.close();

      expect(toast.showToast).not.toHaveBeenCalled();
    });

    it("plays again in the context the map gets back after a loss, which is what its shaders may have failed with", async () => {
      const layer = (
        controls.player as unknown as {
          layer: { failed: (error: unknown) => void };
        }
      ).layer;
      vi.spyOn(console, "error").mockImplementation(() => {});
      layer.failed(new Error("the replay's buffers could not be made"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(controls.player.unavailable).toBe(true);
      app.map!.emit("webglcontextlost");

      app.map!.emit("webglcontextrestored");
      app.map!.emit("style.load");
      controls.show();

      expect(controls.player.unavailable).toBe(false);
      expect(controls.isOpen).toBe(true);
    });

    it("stays shut while the replay of one flight runs", () => {
      app.replayActive = true;

      controls.show();

      expect(controls.isOpen).toBe(false);
      expect(onMap()).toBe(false);
    });

    it("stays shut while the hotspot tour holds the map", () => {
      // A click whose bundle came after the tour's
      app.tourView = {
        center: { lat: 51, lng: 12 },
        zoom: 8,
        bearing: 0,
        pitch: 0,
        globeVisible: false,
        threeDVisible: false,
        heatmapVisible: true,
      };

      controls.show();

      expect(controls.isOpen).toBe(false);
      expect(app.replayActive).toBe(false);
      expect(onMap()).toBe(false);
    });

    it("opens and closes from one toggle for each app", () => {
      toggleReplayAll(asMapApp(app));
      expect(app.replayActive).toBe(true);

      toggleReplayAll(asMapApp(app));
      expect(app.replayActive).toBe(false);
    });
  });

  describe("a player of flights one after another, the share intro's", () => {
    /**
     * A day of four flights, read in the order 2, 1, 4, 5: 2 and 1 timed,
     * 4 without times, and 5 logged 1,000 s apart standing still, which
     * its clock counts as no time at all
     */
    const DAY = createDataset(
      [
        { id: 2, year: 2025, start_airport: "EDDS", end_airport: "EDTF" },
        { id: 1, year: 2025, start_airport: "EDTF", end_airport: "EDDS" },
        { id: 4, year: 2025, start_airport: "EDDS", end_airport: "EDDS" },
        { id: 5, year: 2025, start_airport: "EDDS", end_airport: "EDDS" },
      ],
      [
        ...flight(1, 47),
        ...flight(2, 48),
        ...flight(4, 49).map((segment) => {
          delete segment.time;
          return segment;
        }),
        ...flight(5, 50)
          .slice(0, 2)
          .map((segment, i) => ({
            ...segment,
            groundspeed_knots: 0,
            time: i * 1000,
          })),
      ],
    );
    const seconds = (pathId: number): number =>
      flightClock(DAY.path_segments).duration.get(pathId)!;
    const start = (...ids: number[]): ReplayAllPlayer => {
      app.currentData = DAY;
      const player = new ReplayAllPlayer(asMapApp(app));
      void player.start({ pathIds: ids, sequence: true });
      return player;
    };

    it("plays them in the order given, each after the one before has landed", () => {
      const player = start(2, 1, 5);

      // The clock of 5 is too short to play by (sequenceStarts)
      expect([...player.legs!]).toEqual([
        [2, 0],
        [1, seconds(2) + LEG_PAUSE_S],
      ]);
      expect(player.flights).toBe(2);
      expect(player.duration).toBeCloseTo(
        seconds(2) + LEG_PAUSE_S + seconds(1),
        3,
      );
    });

    it("ends as the last of them lands, with every trail still drawn", () => {
      const player = start(2, 1);

      frames.run();
      frames.run(100, 60);

      expect(player.playing).toBe(false);
      expect(player.time).toBeCloseTo(player.duration, 6);
      // The trails fade over twice the run: the first a quarter as bright
      const style = (
        layer() as unknown as { style: () => { fade: number } | null }
      ).style()!;
      expect(style.fade).toBeCloseTo(2 * player.duration, 6);
    });
  });
});

describe("replayAllClock", () => {
  it("reads hours and minutes into every flight", () => {
    expect(replayAllClock(0)).toBe("0:00 into every flight");
    expect(replayAllClock(42 * 60 + 59)).toBe("0:42 into every flight");
    expect(replayAllClock(3 * 3600 + 5 * 60)).toBe("3:05 into every flight");
  });
});
