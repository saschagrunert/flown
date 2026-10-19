/**
 * ReplayManager: several selected flights played one after another, on one
 * clock, in the panel of the replay of one flight.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  legTrack,
  REPLAY_LEG_PAUSE_S,
  type ReplayManager,
} from "../../../../flown/frontend/ui/replayManager";
import type { PathSegment } from "../../../../flown/frontend/types";
import { AUTO_ZOOM_FOLLOW } from "../../../../flown/frontend/utils/constants";
import * as motion from "../../../../flown/frontend/utils/motion";
import { LngLatBounds } from "../../../mocks/maplibre-gl";
import type { ReplayCamera } from "../../../../flown/frontend/ui/replayCamera";
import { createDataset } from "../../testHelpers";
import {
  createReplayManager,
  createReplayMockApp,
  createSegments,
  el,
  featuresOf,
  liveRegionText,
  mockAnimationFrame,
  mountReplayDom,
  replaySources,
  unmountReplayDom,
  type MockApp,
} from "./replayTestSetup";

vi.mock("../../../../flown/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

/**
 * The three segments of createSegments as the flight `pathId`, moved
 * `east` degrees, at `feet` more
 */
function flight(pathId: number, east: number, feet = 0): PathSegment[] {
  return createSegments().map((segment) => ({
    ...segment,
    path_id: pathId,
    altitude_ft: segment.altitude_ft + feet,
    coords: segment.coords.map(([lat, lon]) => [lat, lon + east]) as [
      [number, number],
      [number, number],
    ],
  }));
}

/**
 * A day of three flights, read in the order 2, 1, 3: 2 from EDDS to EDTF
 * a degree west of 1, which flies back, and 3 a degree east of it, higher
 */
function day(): ReturnType<typeof createDataset> {
  return createDataset(
    [
      {
        id: 2,
        start_airport: "EDDS",
        end_airport: "EDTF",
        min_altitude_ft: 3000,
        max_altitude_ft: 5000,
      },
      {
        id: 1,
        start_airport: "EDTF",
        end_airport: "EDDS",
        min_altitude_ft: 3000,
        max_altitude_ft: 5000,
      },
      {
        id: 3,
        start_airport: "EDDS",
        end_airport: "EDDS",
        min_altitude_ft: 5000,
        max_altitude_ft: 7000,
      },
    ] as never,
    [...flight(1, 0), ...flight(2, -1), ...flight(3, 1, 2000)],
  );
}

describe("ReplayManager with several flights", () => {
  let replayManager: ReplayManager;
  let mockApp: MockApp;

  const legs = () => replayManager.state.smoothed!.legs;
  /** The follow held for a move of the replay's own (ReplayCamera.hold) */
  const holds = () =>
    vi.spyOn(
      (replayManager as unknown as { renderer: { camera: ReplayCamera } })
        .renderer.camera,
      "hold",
    );
  const time = (): string => el("replay-time-display").textContent;
  const open = (...ids: number[]): void => {
    mockApp.selectedPathIds = new Set(ids);
    replayManager.toggleReplay();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    mountReplayDom();
    mockAnimationFrame();
    mockApp = createReplayMockApp();
    mockApp.currentData = day();
    replayManager = createReplayManager(mockApp);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    unmountReplayDom();
  });

  it("plays them one after another in the order of their files, on one clock", () => {
    open(1, 2, 3);

    expect(mockApp.replayActive).toBe(true);
    expect(replayManager.state.segments.map((s) => s.path_id)).toEqual([
      2, 2, 2, 1, 1, 1, 3, 3, 3,
    ]);
    const [first, second, third] = legs();
    expect(first!.start).toBe(0);
    expect(second!.start).toBe(first!.finish + REPLAY_LEG_PAUSE_S);
    expect(third!.start).toBe(second!.finish + REPLAY_LEG_PAUSE_S);
    expect(replayManager.state.maxTime).toBe(third!.finish);
    // Which flies, and the time into it: never a date or an hour
    expect(time()).toBe("1 of 3, EDDS → EDTF: 0:00 in");
    expect(el("replay-slider").getAttribute("aria-valuetext")).toBe(
      "1 of 3, EDDS → EDTF: 0:00 in",
    );
    // A route of each, none from a landing to the next start
    expect(featuresOf(replaySources(mockApp).route)).toHaveLength(3);
    // The timeline shows where each flight is, and the pauses (legTrack),
    // which jsdom does not parse
    expect(el("replay-slider").style.backgroundColor).toBe("transparent");
  });

  it("colours the trail on the ranges of all of them", () => {
    open(1, 3);

    expect(replayManager.state.colorAltRange.min).toBe(3000);
    expect(replayManager.state.colorAltRange.max).toBe(7000);
  });

  it("waits at its landing through the pause, then starts the next at its first fix", () => {
    open(1, 2, 3);
    const [first, second] = legs();

    replayManager.seekReplay(String(first!.finish + REPLAY_LEG_PAUSE_S / 2));
    const [lat, lon] = replayManager.state.airplaneMarker!.position();
    expect(lat).toBeCloseTo(48.3, 6);
    expect(lon).toBeCloseTo(15.3, 6);
    // Still the flight that landed, all of it flown
    expect(time()).toMatch(/^1 of 3, EDDS → EDTF: \d:\d\d in$/);

    replayManager.seekReplay(String(second!.start));
    const [lat2, lon2] = replayManager.state.airplaneMarker!.position();
    expect(lat2).toBeCloseTo(48.0, 6);
    expect(lon2).toBeCloseTo(16.0, 6);

    replayManager.seekReplay(String(second!.start + 42));
    expect(time()).toBe("2 of 3, EDTF → EDDS: 0:42 in");
  });

  it("keeps the trails of the flights before, a run of their own each", () => {
    open(1, 2, 3);
    const state = replayManager.state;

    replayManager.seekReplay(String(legs()[2]!.start + 30));

    // Every segment flown up to the third flight's first is on the trail
    expect(state.lastDrawnIndex).toBe(6);
    const flights = state.trailRuns.map(
      (run) => state.segments[run.firstIndex]!.path_id,
    );
    expect(new Set(flights)).toEqual(new Set([2, 1, 3]));
    for (const run of state.trailRuns) {
      expect(state.segments[run.lastIndex]!.path_id).toBe(
        state.segments[run.firstIndex]!.path_id,
      );
    }
  });

  it("leaves out a flight without times, and says so", () => {
    mockApp.currentData = day();
    for (const segment of mockApp.currentData.path_segments) {
      if (segment.path_id === 3) delete segment.time;
    }

    open(1, 2, 3);

    expect(legs()).toHaveLength(2);
    expect(document.querySelector(".toast-notification")?.textContent).toBe(
      "Left out 1 of the 3 selected flights: not enough timing data",
    );
  });

  it("says each flight as the airplane goes on to it, and takes auto-zoom there", () => {
    open(1, 2);
    replayManager.toggleAutoZoom();
    const map = mockApp.map!;
    replayManager.state.speed = 500;
    replayManager.seekReplay(String(legs()[1]!.start - 1e-3));

    replayManager.playReplay();
    // The first frame takes its time, at the landing of the first flight,
    // where the follow may move the map; the next moves the clock on
    vi.advanceTimersByTime(16);
    map.easeTo.mockClear();
    map.jumpTo.mockClear();
    vi.advanceTimersByTime(16);

    expect(liveRegionText()).toBe("Flight 2 of 2, EDTF → EDDS");
    // To the airplane, a few seconds into the second flight from its start
    expect(map.easeTo).toHaveBeenCalledOnce();
    const { center, zoom } = map.easeTo.mock.calls[0]![0] as {
      center: [number, number];
      zoom: number;
    };
    expect(zoom).toBe(AUTO_ZOOM_FOLLOW);
    expect(center[0]).toBeCloseTo(16, 1);
    expect(center[1]).toBeCloseTo(48, 1);
    // The follow leaves the map to that move, rather than jump after the
    // airplane and zoom out as it found it off the map
    expect(map.jumpTo).not.toHaveBeenCalled();
    expect(map.getZoom()).toBe(AUTO_ZOOM_FOLLOW);
  });

  it("plays none of the flights the filter hides, which share mode keeps selected", () => {
    mockApp.currentData = day();
    for (const path of mockApp.currentData.path_info) {
      path.aircraft_registration = path.id === 1 ? "D-EFGH" : "D-EABC";
    }
    mockApp.selectedAircraft = "D-EABC";

    open(1, 2, 3);

    expect(legs()).toHaveLength(2);
    expect(new Set(replayManager.state.segments.map((s) => s.path_id))).toEqual(
      new Set([2, 3]),
    );
    expect(time()).toBe("1 of 2, EDDS → EDTF: 0:00 in");
    // Hidden is not left out for want of times
    expect(document.querySelector(".toast-notification")).toBeNull();
  });

  it("leaves the map to the user's hand as the next flight starts", () => {
    open(1, 2);
    replayManager.toggleAutoZoom();
    const map = mockApp.map!;
    replayManager.seekReplay(String(legs()[1]!.start - 1e-3));
    map.easeTo.mockClear();
    // A drag under way, which a camera move would end
    map.getCanvasContainer().dispatchEvent(new MouseEvent("mousedown"));
    const hold = holds();

    replayManager.playReplay();
    vi.advanceTimersByTime(32);

    expect(liveRegionText()).toBe("Flight 2 of 2, EDTF → EDDS");
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });

  it("stops a frame at the start of each flight it would pass, and says each", () => {
    open(1, 2, 3);
    replayManager.seekReplay(String(legs()[1]!.start - 1e-3));
    // A frame that would fly the second and the third flight whole
    replayManager.state.speed = 1e5;
    const announce = vi.spyOn(
      replayManager as unknown as { announce: (message: string) => void },
      "announce",
    );

    replayManager.playReplay();
    // The first frame takes its time, the second moves the clock on
    vi.advanceTimersByTime(32);
    expect(replayManager.state.currentTime).toBe(legs()[1]!.start);
    vi.advanceTimersByTime(16);
    expect(replayManager.state.currentTime).toBe(legs()[2]!.start);

    expect(announce.mock.calls.map(([message]) => message)).toEqual([
      "Replay playing",
      "Flight 2 of 3, EDTF → EDDS",
      "Flight 3 of 3, EDDS → EDDS",
    ]);
  });

  it("ends on all of them, with nothing taking the view from the fit", () => {
    open(1, 2);
    replayManager.toggleAutoZoom();
    const map = mockApp.map!;
    replayManager.seekReplay(String(legs()[1]!.start - 1e-3));
    replayManager.state.speed = 1e5;

    replayManager.playReplay();
    // To the start of the second flight, then to the end in one frame
    vi.advanceTimersByTime(32);
    map.easeTo.mockClear();
    vi.advanceTimersByTime(16);

    expect(replayManager.state.currentTime).toBe(replayManager.state.maxTime);
    expect(liveRegionText()).toBe("Replay finished");
    expect(map.fitBounds).toHaveBeenCalledOnce();
    expect(map.easeTo).not.toHaveBeenCalled();
  });

  it("holds the follow only for a move to the next flight", () => {
    open(1, 2);
    const map = mockApp.map!;
    const hold = holds();
    /**
     * Across the start of the second flight, with the map over the landing
     * of the first, where the follow leaves it, and with `shown` the
     * bounds of the map
     */
    const across = (
      shown: [number, number, number, number],
      world = 0,
    ): void => {
      replayManager.pauseReplay();
      replayManager.seekReplay(String(legs()[1]!.start - 1e-3));
      map.jumpTo({ center: [15.3 + world, 48.3], zoom: 9 });
      map.getBounds.mockReturnValue(
        new LngLatBounds([shown[0], shown[1]], [shown[2], shown[3]]),
      );
      map.easeTo.mockClear();
      hold.mockClear();
      replayManager.playReplay();
      vi.advanceTimersByTime(32);
    };

    // Without auto-zoom, the next start on the map: no move, and the
    // follow keeps the airplane in view all along
    across([15, 47, 17, 49]);
    expect(liveRegionText()).toBe("Flight 2 of 2, EDTF → EDDS");
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    // Nor on another copy of the world, as a view across the antimeridian
    // has its bounds past 180: the start is on the map all the same
    across([375, 47, 377, 49], 360);
    expect(map.easeTo).not.toHaveBeenCalled();

    // Off the map: over to it at the map's zoom, the follow held meanwhile
    vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
    across([15, 48, 15.5, 48.5]);
    expect(map.easeTo).toHaveBeenCalledOnce();
    expect(map.easeTo.mock.calls[0]![0]).toMatchObject({ zoom: 9 });
    expect(hold).toHaveBeenCalledOnce();

    // With reduced motion the move is a jump, and nothing is held
    vi.mocked(motion.prefersReducedMotion).mockReturnValue(true);
    across([15, 48, 15.5, 48.5]);
    expect(map.easeTo).toHaveBeenCalledOnce();
    expect(map.easeTo.mock.calls[0]![0]).toMatchObject({ animate: false });
    expect(hold).not.toHaveBeenCalled();
  });

  it("writes the time of each flight as wide as the longest, the panel keeping its width", () => {
    mockApp.currentData = day();
    // The third flight over an hour long
    for (const segment of mockApp.currentData.path_segments) {
      if (segment.path_id === 3) segment.time = segment.time! * 40;
    }
    open(1, 2, 3);

    // The first, of minutes, in hours as the third
    expect(time()).toBe("1 of 3, EDDS → EDTF: 0:00:00 in");
    const lengths = legs().map(({ start }) => {
      replayManager.seekReplay(String(start + 1));
      expect(el("replay-time-display").title).toBe(time());
      return time().length;
    });
    expect(el("replay-time-display").style.width).toBe(
      `${Math.max(...lengths) + 1}ch`,
    );
  });

  it("measures the time at the end of the longest flight, where it has the most digits", () => {
    mockApp.currentData = day();
    // The third flight a quarter of an hour long: "15:00" against "0:00"
    for (const segment of mockApp.currentData.path_segments) {
      if (segment.path_id === 3) segment.time = segment.time! * 10;
    }
    open(1, 2, 3);
    const third = legs()[2]!;
    expect(third.finish - third.start).toBeGreaterThanOrEqual(600);
    expect(third.finish - third.start).toBeLessThan(3600);

    replayManager.seekReplay(String(third.finish));
    expect(el("replay-time-display").style.width).toBe(
      `${time().length + 1}ch`,
    );
  });

  it("leaves the camera to the chase when auto-zoom goes on", () => {
    open(1, 2);
    const map = mockApp.map!;
    replayManager.state.chase = true;
    map.easeTo.mockClear();

    replayManager.toggleAutoZoom();

    expect(replayManager.state.autoZoom).toBe(true);
    expect(map.easeTo).not.toHaveBeenCalled();

    // Without the chase it goes to the airplane
    replayManager.state.chase = false;
    replayManager.toggleAutoZoom();
    replayManager.toggleAutoZoom();
    expect(map.easeTo).toHaveBeenCalled();
  });

  it("leaves the chase to fly over to the next flight", () => {
    vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(false);
    open(1, 2);
    replayManager.toggleChase();
    const map = mockApp.map!;
    replayManager.seekReplay(String(legs()[1]!.start - 1e-3));
    map.easeTo.mockClear();
    const hold = holds();

    replayManager.playReplay();
    vi.advanceTimersByTime(32);

    expect(liveRegionText()).toBe("Flight 2 of 2, EDTF → EDDS");
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });

  it("says where it paused with the flight", () => {
    open(1, 2);
    replayManager.seekReplay(String(legs()[1]!.start + 42));
    replayManager.playReplay();

    replayManager.pauseReplay();

    expect(liveRegionText()).toBe(
      "Replay paused at 2 of 2, EDTF → EDDS: 0:42 in",
    );
  });

  it("reads as the replay of one flight with one selected", () => {
    open(1);

    expect(legs()).toHaveLength(1);
    expect(time()).toMatch(/^0:00 \/ \d:\d\d$/);
    expect(el("replay-slider").style.backgroundColor).toBe("");
    expect(el("replay-time-display").style.width).toBe("");
    expect(el("replay-time-display").title).toBe("");
  });
});

describe("legTrack", () => {
  it("draws each flight's part of the timeline, and leaves out the pauses", () => {
    expect(
      legTrack(
        [
          { first: 0, end: 3, start: 0, finish: 400 },
          { first: 3, end: 6, start: 450, finish: 1000 },
        ],
        1000,
      ),
    ).toBe(
      "linear-gradient(to right,var(--color-text-dim) 0.00% 40.00%,transparent 0 45.00%,var(--color-text-dim) 45.00% 100%)",
    );
  });

  it("widens a pause too short to see", () => {
    expect(
      legTrack(
        [
          { first: 0, end: 3, start: 0, finish: 5000 },
          { first: 3, end: 6, start: 5010, finish: 10000 },
        ],
        10000,
      ),
    ).toContain("transparent 0 50.55%");
  });

  it("leaves the track of one flight to the stylesheet", () => {
    expect(legTrack([{ first: 0, end: 3, start: 0, finish: 10 }], 10)).toBe("");
  });
});
