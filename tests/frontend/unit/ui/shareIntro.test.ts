/**
 * The intro of a link to shared flights: the share of the intro each flight
 * is drawn in, the clock of the run it moves, and the intro itself on the
 * map, with what skips it and what keeps it from playing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  introShares,
  introTime,
  playShareIntro,
  SHARE_INTRO_LEAST_MS,
  SHARE_INTRO_MS,
} from "../../../../flown/frontend/ui/shareIntro";
import * as replayAll from "../../../../flown/frontend/calculations/replayAll";
import {
  LEG_PAUSE_S,
  REPLAY_ALL_POINT_FLOATS,
  type ReplayAllPoints,
} from "../../../../flown/frontend/calculations/replayAll";
import { ReplayAllPlayer } from "../../../../flown/frontend/ui/replayAllPlayer";
import { flightClockOf } from "../../../../flown/frontend/calculations/flightClock";
import { MAP_LAYERS } from "../../../../flown/frontend/utils/constants";
import * as motion from "../../../../flown/frontend/utils/motion";
import * as pathSelection from "../../../../flown/frontend/ui/pathSelection";
import type { PathSegment } from "../../../../flown/frontend/types";
import { mercatorOf } from "../../../../flown/frontend/utils/mercator";
import {
  heldGroundedFlights,
  releaseGroundedFlights,
} from "../../../../flown/frontend/calculations/groundProfile";
import {
  asMapApp,
  createDataset,
  createMockApp,
  type MockApp,
} from "../../testHelpers";

/** The id of the intro's layer on the map */
const LAYER = "share-intro";

vi.mock(
  "../../../../flown/frontend/calculations/replayAll",
  async (original) => {
    const module =
      await original<
        typeof import("../../../../flown/frontend/calculations/replayAll")
      >();
    return { ...module, fitTilted: vi.fn(module.fitTilted) };
  },
);

/** A flight of `path_id` along the latitude `lat`, `fixes` fixes 30 s apart */
function flight(path_id: number, lat: number, fixes = 5): PathSegment[] {
  return Array.from({ length: fixes - 1 }, (_, i) => ({
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

/**
 * The flight of `path_id` with no clock: neither times nor speeds, as a
 * planned route may be (see flightClock)
 */
function untimed(path_id: number, lat: number): PathSegment[] {
  return flight(path_id, lat).map(({ time: _time, ...segment }) => ({
    ...segment,
    groundspeed_knots: 0,
  }));
}

/**
 * The flight of `path_id` along the latitude `lat` out to 0.42 degrees
 * east and back, 30 s a fix: some 30 km out, which cut for a map far out
 * keeps a point every 18 km or so of
 */
function outAndBack(path_id: number, lat: number): PathSegment[] {
  const lngAt = (i: number): number => 11 + 0.021 * (i <= 20 ? i : 40 - i);
  return Array.from({ length: 40 }, (_, i) => ({
    path_id,
    coords: [
      [lat, lngAt(i)],
      [lat, lngAt(i + 1)],
    ],
    altitude_ft: 3000,
    groundspeed_knots: 100,
    time: i * 30,
  }));
}

/**
 * Three flights of 2025, the second the longest, the third of D-EBBB, a
 * fourth and a fifth with no clock, and a sixth out and back
 */
const DATA = createDataset(
  [
    { id: 1, year: 2025, aircraft_registration: "D-EAAA" },
    { id: 2, year: 2025, aircraft_registration: "D-EAAA" },
    { id: 3, year: 2025, aircraft_registration: "D-EBBB" },
    { id: 4, year: 2025, aircraft_registration: "D-EAAA" },
    { id: 5, year: 2025, aircraft_registration: "D-EAAA" },
    { id: 6, year: 2025, aircraft_registration: "D-EAAA" },
  ] as never,
  [
    ...flight(1, 47),
    ...flight(2, 48, 9),
    ...flight(3, 49),
    ...untimed(4, 50),
    ...untimed(5, 51),
    ...outAndBack(6, 52),
  ],
);

/** The seconds of each flight on its own clock */
const SECONDS = flightClockOf(DATA.path_segments).duration;

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

/** Let the render a repaint fires and the promises after it run */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("introShares", () => {
  it("splits the intro by the seconds of each flight, each with its least", () => {
    const shares = introShares([3600, 600, 1800]);

    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(SHARE_INTRO_MS, 6);
    // The hop is drawn in more than its tenth of the seconds would give it
    expect(shares[1]).toBeGreaterThan(SHARE_INTRO_LEAST_MS);
    expect(shares[1]).toBeGreaterThan(SHARE_INTRO_MS / 10);
    // The rest goes by the seconds: the longest flight the longest
    expect(shares[0]).toBeGreaterThan(shares[2]!);
    expect(shares[2]).toBeGreaterThan(shares[1]!);
    expect(shares[0]! - SHARE_INTRO_LEAST_MS).toBeCloseTo(
      2 * (shares[2]! - SHARE_INTRO_LEAST_MS),
      6,
    );
  });

  it("gives a very short flight its least", () => {
    const shares = introShares([10_000, 1]);

    expect(shares[1]).toBeGreaterThanOrEqual(SHARE_INTRO_LEAST_MS);
    expect(shares[0]! + shares[1]!).toBeCloseTo(SHARE_INTRO_MS, 6);
  });

  it("splits evenly where the flights are too many for each to have its least", () => {
    const shares = introShares(Array.from({ length: 20 }, (_, i) => i + 1));

    for (const share of shares) expect(share).toBeCloseTo(SHARE_INTRO_MS / 20);
  });

  it("gives one flight all of it", () => {
    expect(introShares([1234])).toEqual([SHARE_INTRO_MS]);
  });
});

describe("introTime", () => {
  // As sequenceStarts lays them out: a pause on the clock between them
  const legs = new Map([
    [7, 0],
    [8, 3600 + LEG_PAUSE_S],
  ]);
  const durations = new Map([
    [7, 3600],
    [8, 600],
  ]);
  const [first] = introShares([3600, 600]);

  it("starts at the first fix of the first flight", () => {
    expect(introTime(legs, durations, 0)).toBe(0);
  });

  it("moves along each flight in its share of the intro", () => {
    expect(introTime(legs, durations, first! / 2)).toBeCloseTo(1800, 6);
    expect(introTime(legs, durations, first!)).toBeCloseTo(3600, 6);
  });

  it("leaves out the pause: the next flight starts as the one before lands", () => {
    expect(introTime(legs, durations, first! + 1)).toBeGreaterThan(
      3600 + LEG_PAUSE_S,
    );
  });

  it("ends as the last flight lands, and stays there", () => {
    expect(introTime(legs, durations, SHARE_INTRO_MS)).toBeCloseTo(
      3600 + LEG_PAUSE_S + 600,
      6,
    );
    expect(introTime(legs, durations, 2 * SHARE_INTRO_MS)).toBeCloseTo(
      3600 + LEG_PAUSE_S + 600,
      6,
    );
  });
});

describe("playShareIntro", () => {
  let app: MockApp;
  let lifetime: AbortController;
  let frames: ReturnType<typeof clockedFrames>;

  const map = (): NonNullable<MockApp["map"]> => app.map!;
  const onMap = (): boolean => !!map().getLayer(LAYER);
  /** The time the intro's layer was last asked to draw */
  const time = (): number =>
    (
      map()
        .addLayer.mock.calls.filter(
          ([spec]) => (spec as { id: string }).id === LAYER,
        )
        .pop()![0] as unknown as { style: () => { time: number } }
    ).style().time;
  const lines = (): unknown =>
    map().getLayoutProperty(MAP_LAYERS.selectionHighlight, "visibility");
  /** The points the intro's layer was last handed */
  const points = (): ReplayAllPoints =>
    (
      map()
        .addLayer.mock.calls.filter(
          ([spec]) => (spec as { id: string }).id === LAYER,
        )
        .pop()![0] as unknown as { flights: ReplayAllPoints }
    ).flights;

  /** Share the flights `pathIds` */
  function share(...pathIds: number[]): void {
    app.store.batch(() => {
      app.selectedPathIds = new Set([...app.selectedPathIds, ...pathIds]);
      app.isolateSelection = true;
    });
  }

  beforeEach(() => {
    lifetime = new AbortController();
    app = createMockApp({
      signal: lifetime.signal,
      currentData: DATA,
      selectedYear: "all",
    });
    frames = clockedFrames();
    vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
    // The lines of the selection show, as the store has them in share mode
    app.selectionHighlightLayer.setVisible(true);
  });

  afterEach(() => {
    lifetime.abort();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("frames the shared flights and draws them in, one after another", () => {
    share(1, 2);
    map().easeTo.mockClear();

    playShareIntro(asMapApp(app));

    // The camera sets off for the flights, the bearing kept
    expect(map().easeTo).toHaveBeenCalledTimes(1);
    const ease = map().easeTo.mock.calls[0]![0] as {
      bearing?: number;
      duration?: number;
    };
    expect(ease.bearing).toBe(map().getBearing());
    expect(ease.duration).toBeGreaterThan(0);
    // The trails take the place of the lines, from nothing drawn
    expect(onMap()).toBe(true);
    expect(lines()).toBe("none");
    expect(time()).toBe(0);

    frames.run();
    const one = SECONDS.get(1)!;
    const [first] = introShares([one, SECONDS.get(2)!]);
    frames.run(first! / 2);
    // Half way through the first flight, the second not started
    expect(time()).toBeCloseTo(one / 2, 6);
    frames.run(first! / 2 + 1);
    expect(time()).toBeGreaterThan(one + LEG_PAUSE_S);
    expect(lines()).toBe("none");
  });

  it("fits the camera to the flights at the tilt and the bearing of the map, as the replay of all flights does, and cuts the trails for it from the start", () => {
    share(1, 2);
    map().jumpTo({ pitch: 60, bearing: 30, zoom: 3 });
    map().easeTo.mockClear();
    const fit = vi.mocked(replayAll.fitTilted);
    fit.mockClear();
    const aim = vi.spyOn(ReplayAllPlayer.prototype, "aim");

    playShareIntro(asMapApp(app));

    expect(fit).toHaveBeenCalledTimes(1);
    const [, , fitMap] = fit.mock.calls[0]!;
    expect(fitMap).toMatchObject({ pitch: 60, bearing: 30 });
    const camera = fit.mock.results[0]!.value as replayAll.FitCamera;
    const ease = map().easeTo.mock.calls[0]![0] as Record<string, unknown>;
    // The tilt kept, which the map has
    expect(ease).toMatchObject({ ...camera, bearing: 30 });
    expect(ease).not.toHaveProperty("pitch");
    expect(aim).toHaveBeenCalledWith(camera.zoom, true);
  });

  it("fits every fix of the shared flights, of one with no clock as well, which the trails leave out", () => {
    share(1, 4);
    const fit = vi.mocked(replayAll.fitTilted);
    fit.mockClear();

    playShareIntro(asMapApp(app));

    const [fixes] = fit.mock.calls[0]!;
    const segments = DATA.path_segments.filter((s) =>
      [1, 4].includes(s.path_id),
    );
    expect(fixes.count).toBe(2 * segments.length);
    const ys = Array.from(
      { length: fixes.count },
      (_, k) =>
        Number(fixes.points[k * REPLAY_ALL_POINT_FLOATS + 1]) + fixes.origin[1],
    );
    expect(Math.min(...ys)).toBeCloseTo(mercatorOf([50, 11])[1], 6);
  });

  it("frames a flight from a link opened far out as from its own zoom, its turn as well", () => {
    /** The camera the intro eases to from the view `zoom` */
    const framed = (
      zoom: number,
    ): { center: [number, number]; zoom: number } => {
      lifetime.abort();
      lifetime = new AbortController();
      app = createMockApp({
        signal: lifetime.signal,
        currentData: DATA,
        selectedYear: "all",
      });
      share(6);
      // A map of 1280x720 with a margin of 24 px, whose fit of the bounds
      // comes to zoom 9
      vi.spyOn(map().getContainer(), "getBoundingClientRect").mockReturnValue(
        new DOMRect(0, 0, 1280, 720),
      );
      vi.spyOn(pathSelection, "mapChromePadding").mockReturnValue({
        top: 24,
        right: 24,
        bottom: 24,
        left: 24,
      });
      const fit = map().cameraForBounds.getMockImplementation()!;
      map().cameraForBounds.mockImplementation((bounds, options) => ({
        ...fit(bounds, options),
        zoom: 9,
      }));
      map().jumpTo({ zoom, pitch: 50, center: [11.2, 52] });
      map().easeTo.mockClear();
      playShareIntro(asMapApp(app));
      return map().easeTo.mock.calls[0]![0] as never;
    };

    const near = framed(11);
    const far = framed(3);

    expect(far.zoom).toBeCloseTo(near.zoom, 2);
    expect(far.center[0]).toBeCloseTo(near.center[0], 4);
    expect(far.center[1]).toBeCloseTo(near.center[1], 4);
  });

  it("draws the trails in the colours of the colour layer that is on", () => {
    share(1, 2);
    app.altitudeVisible = true;
    playShareIntro(asMapApp(app));

    const run = points();
    for (let k = 0; k < run.count; k++) {
      expect(run.points[k * REPLAY_ALL_POINT_FLOATS + 6]).toBeGreaterThan(0);
    }
  });

  it("draws the trails in their own colour without a colour layer", () => {
    share(1, 2);
    playShareIntro(asMapApp(app));

    const run = points();
    expect(run.count).toBeGreaterThan(0);
    for (let k = 0; k < run.count; k++) {
      expect(run.points[k * REPLAY_ALL_POINT_FLOATS + 6]).toBe(0);
    }
  });

  it("builds the heat up behind the flights meanwhile, and hands it back at the end", () => {
    share(1, 2);
    app.heatmapVisible = true;
    playShareIntro(asMapApp(app));
    frames.run();

    // The cloud steps in for the heatmap on the flat map, no replay of the
    // map that would hold the controls
    expect(app.store.get("heatCloud")).toBe(true);
    expect(app.replayActive).toBe(false);

    frames.run(SHARE_INTRO_MS);
    expect(app.store.get("heatCloud")).toBe(false);
  });

  it("hands over to the lines at the end, and takes the trails away once they are drawn", async () => {
    share(1, 2, 3);
    playShareIntro(asMapApp(app));
    frames.run();
    // The tiles of the lines are on their way
    map().areTilesLoaded.mockReturnValue(false);

    frames.run(SHARE_INTRO_MS);

    expect(lines()).toBe("visible");
    expect(onMap()).toBe(true);
    // Drawn in full: the last flight has landed
    expect(time()).toBeGreaterThan(0);
    expect(frames.pending()).toBe(0);
    await settle();
    expect(onMap()).toBe(true);

    map().areTilesLoaded.mockReturnValue(true);
    map().emit("render");
    await settle();
    expect(onMap()).toBe(false);
  });

  it("gives the lines back what the store had them at", () => {
    app.selectionHighlightLayer.setVisible(false);
    share(1);
    playShareIntro(asMapApp(app));
    frames.run();

    frames.run(SHARE_INTRO_MS);

    expect(lines()).toBe("none");
  });

  it("hides the lines again on every frame, as the store shows them", () => {
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();

    app.selectionHighlightLayer.setVisible(true);
    expect(lines()).toBe("visible");
    frames.run(100);

    expect(lines()).toBe("none");
  });

  for (const type of ["pointerdown", "wheel", "keydown", "touchstart"]) {
    it(`skips to the end on ${type}`, async () => {
      share(1, 2);
      playShareIntro(asMapApp(app));
      frames.run();
      frames.run(500);
      map().isMoving.mockReturnValue(true);
      map().jumpTo.mockClear();

      window.dispatchEvent(new Event(type));

      // The camera where it was going, every flight drawn, the lines back
      expect(map().jumpTo).toHaveBeenCalledTimes(1);
      expect(frames.pending()).toBe(0);
      expect(lines()).toBe("visible");
      await settle();
      expect(onMap()).toBe(false);
    });
  }

  it("is not skipped by Tab or a modifier on its own", () => {
    // Alt or Cmd and Tab to the browser, or a screen reader's keys, ended it
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();
    map().isMoving.mockReturnValue(true);
    map().jumpTo.mockClear();

    for (const key of ["Tab", "Shift", "Control", "Alt", "Meta"]) {
      window.dispatchEvent(new KeyboardEvent("keydown", { key }));
    }

    expect(map().jumpTo).not.toHaveBeenCalled();
    expect(frames.pending()).toBe(1);
    expect(lines()).toBe("none");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp" }));
    expect(frames.pending()).toBe(0);
  });

  it("is skipped by Escape", () => {
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(frames.pending()).toBe(0);
  });

  it("smooths the shared flights alone, not every flight of the dataset", () => {
    // Of the tests before
    releaseGroundedFlights();
    share(1, 2);

    playShareIntro(asMapApp(app));
    frames.run();

    expect(points().flights).toBe(2);
    // On the flat map nothing else draws along the curves of every flight,
    // which for all years took seconds on a phone as the camera set out
    expect(heldGroundedFlights()).toBeNull();
  });

  it("keeps the trails through the rest of the gesture that skipped it", async () => {
    // A tap is a pointerdown and a touchstart: the second took the trails
    // away before the lines were drawn again, and the flights blinked out
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();
    map().areTilesLoaded.mockReturnValue(false);

    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("touchstart"));
    await settle();

    expect(onMap()).toBe(true);
  });

  it("keeps the trails on input while the lines are drawn", async () => {
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();
    map().areTilesLoaded.mockReturnValue(false);
    frames.run(SHARE_INTRO_MS);
    await settle();

    window.dispatchEvent(new Event("wheel"));
    await settle();

    expect(onMap()).toBe(true);
  });

  it("leaves the camera to what the app opened when the map is taken", () => {
    share(1, 2);
    app.heatmapVisible = true;
    playShareIntro(asMapApp(app));
    frames.run();
    expect(app.store.get("heatCloud")).toBe(true);
    map().isMoving.mockReturnValue(true);
    map().jumpTo.mockClear();

    app.replayActive = true;

    expect(frames.pending()).toBe(0);
    expect(map().jumpTo).not.toHaveBeenCalled();
    expect(lines()).toBe("visible");
    // Its trails do not stand over what the replay draws, nor its heat,
    // built up by its clock, over the heatmap
    expect(onMap()).toBe(false);
    expect(app.store.get("heatCloud")).toBe(false);
  });

  it("takes the trails away at once when the map is taken as the lines are drawn", async () => {
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();
    map().areTilesLoaded.mockReturnValue(false);
    frames.run(SHARE_INTRO_MS);
    await settle();
    expect(onMap()).toBe(true);

    // The replay of all flights, started by the click that skipped it
    app.replayActive = true;

    expect(onMap()).toBe(false);
  });

  it("only frames flights with no clock, their lines left as they are", () => {
    share(4, 5);
    map().easeTo.mockClear();

    playShareIntro(asMapApp(app));

    expect(map().easeTo).toHaveBeenCalledTimes(1);
    expect(onMap()).toBe(false);
    expect(frames.pending()).toBe(0);
    expect(lines()).toBe("visible");
  });

  it("draws in the flights with a clock, and shows those without at the end", () => {
    share(1, 4);
    playShareIntro(asMapApp(app));
    frames.run();

    frames.run(SHARE_INTRO_MS / 2);

    // The one flight with a clock takes all of the intro
    expect(time()).toBeCloseTo(SECONDS.get(1)! / 2, 6);
    expect(lines()).toBe("none");
    frames.run(SHARE_INTRO_MS);
    expect(lines()).toBe("visible");
  });

  it("only frames the flights under reduced motion", () => {
    vi.mocked(motion.prefersReducedMotion).mockReturnValue(true);
    vi.mocked(replayAll.fitTilted).mockClear();
    share(1, 2);
    map().easeTo.mockClear();

    playShareIntro(asMapApp(app));

    expect(map().jumpTo).toHaveBeenCalledTimes(1);
    expect(map().easeTo).not.toHaveBeenCalled();
    expect(onMap()).toBe(false);
    expect(frames.pending()).toBe(0);
    expect(lines()).toBe("visible");
    // Fitted without a player: no trails cut, and no layer put on the map
    // for a moment
    expect(replayAll.fitTilted).toHaveBeenCalledTimes(1);
    const added = map().addLayer.mock.calls.filter(
      ([spec]) => (spec as { id: string }).id === LAYER,
    );
    expect(added).toHaveLength(0);
  });

  it("does not play while a replay, the tour or Wrapped holds the map", () => {
    share(1, 2);
    for (const hold of [
      () => (app.replayActive = true),
      () => (app.wrappedVisible = true),
      () => (app.tourView = {} as never),
    ]) {
      hold();
      map().easeTo.mockClear();
      map().jumpTo.mockClear();

      playShareIntro(asMapApp(app));

      expect(map().easeTo).not.toHaveBeenCalled();
      expect(map().jumpTo).not.toHaveBeenCalled();
      expect(onMap()).toBe(false);
      app.replayActive = false;
      app.wrappedVisible = false;
      app.tourView = null;
    }
  });

  it("does not play without share mode", () => {
    app.selectedPathIds = new Set([...app.selectedPathIds, 1]);

    playShareIntro(asMapApp(app));

    expect(onMap()).toBe(false);
    expect(map().easeTo).not.toHaveBeenCalled();
  });

  it("does not play where the filter hides every shared flight", () => {
    share(3);
    app.selectedAircraft = "D-EAAA";

    playShareIntro(asMapApp(app));

    expect(onMap()).toBe(false);
    expect(map().easeTo).not.toHaveBeenCalled();
  });

  it("draws only the shared flights the filter shows", () => {
    share(1, 3);
    app.selectedAircraft = "D-EAAA";
    playShareIntro(asMapApp(app));
    frames.run();

    frames.run(SHARE_INTRO_MS / 2);

    // The one flight takes all of the intro
    expect(time()).toBeCloseTo(SECONDS.get(1)! / 2, 6);
  });

  it("stands down with the app", async () => {
    share(1, 2);
    playShareIntro(asMapApp(app));
    frames.run();

    lifetime.abort();
    await settle();

    expect(onMap()).toBe(false);
    // No frame runs on for a torn down app
    expect(frames.pending()).toBe(0);
  });
});
