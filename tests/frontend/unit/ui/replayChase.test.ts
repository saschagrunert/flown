/**
 * ReplayManager: the chase view, from its control to the camera it drives
 * and gives back.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReplayManager } from "../../../../flown/frontend/ui/replayManager";
import { CHASE_REDUCED_MOTION_MESSAGE } from "../../../../flown/frontend/ui/replayManager";
import {
  CHASE_PITCH,
  CHASE_ZOOM,
} from "../../../../flown/frontend/ui/chaseCamera";
import * as motion from "../../../../flown/frontend/utils/motion";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  followContextLoss,
  isReplayCameraMove,
} from "../../../../flown/frontend/utils/mapHelpers";
import {
  createReplayManager,
  createReplayMockApp,
  el,
  liveRegionText,
  mockAnimationFrame,
  mountReplayDom,
  unmountReplayDom,
  type MockApp,
} from "./replayTestSetup";

vi.mock("../../../../flown/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

describe("ReplayManager chase view", () => {
  let replayManager: ReplayManager;
  let mockApp: MockApp;

  /** The replay open, at `time` into the flight, the map where it was */
  function openReplay(time = 30): void {
    mockApp.selectedPathIds = new Set([1]);
    replayManager.toggleReplay();
    replayManager.seekReplay(String(time));
    mockApp.map!.jumpTo({
      center: [16.05, 48.05],
      zoom: 11,
      bearing: 20,
      pitch: 30,
    });
    vi.mocked(mockApp.map!.jumpTo).mockClear();
    vi.mocked(mockApp.map!.easeTo).mockClear();
  }

  /** Run the frames of `seconds` of a paused chase settling, 16 ms each */
  function settle(seconds = 4): void {
    vi.advanceTimersByTime(seconds * 1000);
  }

  function camera() {
    const map = mockApp.map!;
    return {
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mountReplayDom();
    mockAnimationFrame();
    mockApp = createReplayMockApp();
    replayManager = createReplayManager(mockApp);
  });

  afterEach(() => {
    replayManager.destroy();
    vi.useRealTimers();
    unmountReplayDom();
  });

  it("is off by default, and its control says so", () => {
    openReplay();
    const button = el("replay-chase-btn");
    expect(replayManager.state.chase).toBe(false);
    expect(button.getAttribute("aria-pressed")).toBe("false");
  });

  it("switches on from its control, pressed, and announces it", () => {
    openReplay();
    el("replay-chase-btn").click();
    expect(replayManager.state.chase).toBe(true);
    expect(el("replay-chase-btn").getAttribute("aria-pressed")).toBe("true");
    expect(liveRegionText()).toBe("Chase view on, 10x");
  });

  it("slows a fast replay down, and gives the speed back as it ends", () => {
    openReplay();
    const select = el("replay-speed") as HTMLSelectElement;
    expect(replayManager.state.speed).toBe(50);

    replayManager.toggleChase();
    expect(select.value).toBe("10");
    expect(replayManager.state.speed).toBe(10);

    replayManager.toggleChase();
    expect(select.value).toBe("50");
    expect(replayManager.state.speed).toBe(50);
  });

  it("keeps a speed chosen while it chased", () => {
    openReplay();
    const select = el("replay-speed") as HTMLSelectElement;
    replayManager.toggleChase();
    select.value = "1";
    replayManager.changeReplaySpeed();
    replayManager.toggleChase();
    expect(replayManager.state.speed).toBe(1);
  });

  it("leaves a slow replay at its speed", () => {
    openReplay();
    const select = el("replay-speed") as HTMLSelectElement;
    select.value = "1";
    replayManager.changeReplaySpeed();
    replayManager.toggleChase();
    expect(replayManager.state.speed).toBe(1);
    expect(liveRegionText()).toBe("Chase view on");
  });

  it("flies the camera behind the airplane, even while paused", () => {
    openReplay();
    replayManager.toggleChase();
    settle();
    const { zoom, bearing, pitch } = camera();
    expect(zoom).toBeCloseTo(CHASE_ZOOM, 2);
    expect(pitch).toBeCloseTo(CHASE_PITCH, 1);
    // Along the track the airplane shows: the flight heads north-east
    expect(bearing).toBeCloseTo(replayManager.state.lastBearing!, 0);
    expect(bearing).toBeGreaterThan(20);
    expect(bearing).toBeLessThan(40);
    // Moved by one jump a frame, never an animation that restarts on each
    expect(mockApp.map!.easeTo).not.toHaveBeenCalled();
    // And the airplane stands up in the screen, set once and not on every
    // frame: a marker lays itself out anew for each
    const marker = replayManager.state.airplaneMarker!.marker;
    expect(marker.setPitchAlignment).toHaveBeenCalledExactlyOnceWith(
      "viewport",
    );
  });

  it("tells the map once it has come to rest, and not at every frame of the chase", () => {
    openReplay();
    const map = mockApp.map!;
    const ends: string[] = [];
    for (const type of ["moveend", "zoomend"]) {
      map.on(type, (event) => {
        if (!isReplayCameraMove(event as object)) ends.push(type);
      });
    }
    replayManager.toggleChase();
    replayManager.playReplay();
    vi.advanceTimersByTime(160);
    // Asked of the map a second on at most, the chase zooming in on the way
    expect(ends).toEqual([]);

    replayManager.pauseReplay();
    settle();
    expect(ends).toEqual(["zoomend", "moveend"]);
  });

  /** The untagged ends of a move the map is told of, from now on */
  function restsOf(map: NonNullable<MockApp["map"]>): string[] {
    const ends: string[] = [];
    for (const type of ["moveend", "zoomend"]) {
      map.on(type, (event) => {
        if (!isReplayCameraMove(event as object)) {
          // And whether the view from before the chase was eased to yet
          ends.push(
            type + (vi.mocked(map.easeTo).mock.calls.length ? "*" : ""),
          );
        }
      });
    }
    return ends;
  }

  it("is at rest where the chase left the map before it eases back to the view from before it (regression)", () => {
    openReplay();
    const map = mockApp.map!;
    const ends = restsOf(map);
    replayManager.toggleChase();
    replayManager.playReplay();
    vi.advanceTimersByTime(160);

    replayManager.toggleReplay();

    // Told once, before the ease; the ease ends in a `moveend` of its own
    expect(ends).toEqual(["zoomend", "moveend"]);
    expect(map.easeTo).toHaveBeenCalledTimes(1);
  });

  it("leaves a map without its WebGL context alone as the replay closes, and tells it of the rest once it is back", () => {
    openReplay();
    const map = mockApp.map!;
    followContextLoss(map as unknown as MapLibreMap);
    const ends = restsOf(map);
    replayManager.toggleChase();
    replayManager.playReplay();
    vi.advanceTimersByTime(160);
    vi.mocked(map.jumpTo).mockClear();

    map.emit("webglcontextlost");
    replayManager.toggleReplay();
    settle();
    expect(ends).toEqual([]);
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(map.jumpTo).not.toHaveBeenCalled();

    map.emit("webglcontextrestored");
    map.emit("style.load");
    settle(1);
    expect(ends).toEqual(["zoomend", "moveend"]);
  });

  it("tells a map the app has let go of nothing", () => {
    const lifetime = new AbortController();
    Object.assign(mockApp, { signal: lifetime.signal });
    openReplay();
    const ends = restsOf(mockApp.map!);
    replayManager.toggleChase();
    replayManager.playReplay();
    vi.advanceTimersByTime(160);

    lifetime.abort();
    replayManager.destroy();
    settle();

    expect(ends).toEqual([]);
  });

  it("moves a paused chase on as the map resizes under it", () => {
    openReplay();
    replayManager.toggleChase();
    settle();
    const map = mockApp.map!;
    const center = map.getCenter();
    vi.mocked(map.jumpTo).mockClear();
    settle(1);
    expect(map.jumpTo).not.toHaveBeenCalled();

    // A phone turned: the replay panel now covers the lower half of the map
    el("replay-controls").getBoundingClientRect = () =>
      ({ top: map.getContainer().clientHeight / 2 }) as DOMRect;
    map.emit("resize");
    settle();
    expect(map.jumpTo).toHaveBeenCalled();
    expect(map.getCenter().lat).not.toBeCloseTo(center.lat, 6);
  });

  it("drives the camera on every frame while the replay plays", () => {
    openReplay();
    replayManager.toggleChase();
    replayManager.playReplay();
    const map = mockApp.map!;
    vi.mocked(map.jumpTo).mockClear();
    vi.advanceTimersByTime(160);
    expect(vi.mocked(map.jumpTo).mock.calls.length).toBeGreaterThanOrEqual(9);
    // At the airplane's height, which the map does not clamp to the ground
    const [last] = vi.mocked(map.jumpTo).mock.calls.at(-1)!;
    expect(typeof last.elevation).toBe("number");
  });

  it("holds while the user's hand is on the map, then picks up from there", () => {
    openReplay();
    replayManager.toggleChase();
    settle();
    const map = mockApp.map!;
    map.getCanvasContainer().dispatchEvent(new Event("mousedown"));
    vi.mocked(map.jumpTo).mockClear();
    replayManager.playReplay();
    vi.advanceTimersByTime(200);
    // Every camera move ends a gesture: none while it lasts
    expect(map.jumpTo).not.toHaveBeenCalled();
    expect(map.easeTo).not.toHaveBeenCalled();

    // The user has turned the map and zoomed out while they held it
    map.jumpTo({ bearing: 200, zoom: 12.5 });
    vi.mocked(map.jumpTo).mockClear();
    window.dispatchEvent(new Event("mouseup"));
    vi.advanceTimersByTime(16);
    expect(map.jumpTo).toHaveBeenCalledTimes(1);
    // From where they left it, not a jump back behind the airplane
    expect(Math.abs(map.getBearing() - 200)).toBeLessThan(10);
    // Their zoom is the chase's from now on
    vi.advanceTimersByTime(3000);
    expect(map.getZoom()).toBeCloseTo(12.5, 1);
  });

  it("gives back the zoom, turn and tilt over the airplane when switched off", () => {
    openReplay();
    replayManager.toggleChase();
    settle();
    const map = mockApp.map!;
    replayManager.toggleChase();
    expect(map.setCenterClampedToGround).toHaveBeenLastCalledWith(true);
    const [lat, lon] = replayManager.state.airplaneMarker!.position();
    expect(map.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        center: { lng: lon, lat },
        zoom: 11,
        bearing: 20,
        pitch: 30,
      }),
    );
    expect(camera()).toEqual({ zoom: 11, bearing: 20, pitch: 30 });
    expect(
      replayManager.state.airplaneMarker!.marker.setPitchAlignment,
    ).toHaveBeenLastCalledWith("map");
    // And nothing chases any more
    vi.mocked(map.jumpTo).mockClear();
    settle(1);
    expect(map.jumpTo).not.toHaveBeenCalled();
  });

  it("gives back the whole view from before when the replay closes", () => {
    openReplay();
    replayManager.toggleChase();
    settle();
    replayManager.toggleReplay();
    expect(mockApp.replayActive).toBe(false);
    expect(mockApp.map!.easeTo).toHaveBeenLastCalledWith(
      expect.objectContaining({
        center: { lng: 16.05, lat: 48.05 },
        zoom: 11,
        bearing: 20,
        pitch: 30,
      }),
    );
    expect(mockApp.map!.setCenterClampedToGround).toHaveBeenLastCalledWith(
      true,
    );
    // The choice stays for the next replay of the session
    expect(replayManager.state.chase).toBe(true);
  });

  it("gives back the view from before a chase that ended a moment ago", () => {
    openReplay();
    replayManager.toggleChase();
    settle();
    replayManager.toggleReplay();
    // Half way back to the view from before the chase
    mockApp.map!.jumpTo({
      center: [16.2, 48.2],
      zoom: 13,
      bearing: 60,
      pitch: 50,
    });

    // Opened again at once, still chasing: it saved the half-restored view
    // and gave that back
    replayManager.toggleReplay();
    replayManager.seekReplay("30");
    settle(0.1);

    expect(replayManager.userMapView()).toEqual({
      center: { lng: 16.05, lat: 48.05 },
      zoom: 11,
      bearing: 20,
      pitch: 30,
    });
  });

  it("does not move the camera towards the start as a paused chase closes", () => {
    openReplay(60);
    replayManager.toggleChase();
    settle();
    vi.mocked(mockApp.map!.jumpTo).mockClear();
    replayManager.toggleReplay();
    // The chase only eases back from where it looked
    expect(mockApp.map!.jumpTo).not.toHaveBeenCalled();
    expect(mockApp.map!.easeTo).toHaveBeenCalled();
    expect(replayManager.state.currentTime).toBe(0);
    expect(el("replay-slider")).toHaveProperty("value", "0");
  });

  it("ends as the flight does, fitting it the way the map was before", () => {
    openReplay(239);
    replayManager.toggleChase();
    settle();
    replayManager.playReplay();
    vi.advanceTimersByTime(2000);
    expect(replayManager.state.playing).toBe(false);
    expect(mockApp.map!.fitBounds).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ bearing: 20, pitch: 30 }),
    );
    // A finished replay starts no chase of its own
    vi.mocked(mockApp.map!.jumpTo).mockClear();
    settle(1);
    expect(mockApp.map!.jumpTo).not.toHaveBeenCalled();
  });

  it("keeps the user's own view as the one to save while it chases", () => {
    openReplay();
    expect(replayManager.userMapView()).toBeNull();
    replayManager.toggleChase();
    settle();
    expect(replayManager.userMapView()).toEqual({
      center: { lng: 16.05, lat: 48.05 },
      zoom: 11,
      bearing: 20,
      pitch: 30,
    });
    replayManager.toggleChase();
    expect(replayManager.userMapView()).toBeNull();
  });

  it("stays off with reduced motion, and says why", () => {
    vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
    openReplay();
    replayManager.toggleChase();
    expect(replayManager.state.chase).toBe(false);
    expect(document.querySelector(".toast-notification")?.textContent).toBe(
      CHASE_REDUCED_MOTION_MESSAGE,
    );
    settle(1);
    expect(mockApp.map!.jumpTo).not.toHaveBeenCalled();
  });

  it("lets go of the camera once reduced motion is asked for", () => {
    openReplay();
    replayManager.toggleChase();
    settle();
    vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
    replayManager.playReplay();
    vi.advanceTimersByTime(100);
    expect(mockApp.map!.setCenterClampedToGround).toHaveBeenLastCalledWith(
      true,
    );
    expect(replayManager.userMapView()).toBeNull();
  });
});
