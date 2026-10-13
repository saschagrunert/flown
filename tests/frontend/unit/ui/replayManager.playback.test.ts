/**
 * ReplayManager: play, pause, stop, seek, speed and auto-zoom.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MAX_FRAME_DELTA_MS,
  type ReplayManager,
} from "../../../../flown/frontend/ui/replayManager";
import * as mapHelpers from "../../../../flown/frontend/utils/mapHelpers";
import { AUTO_ZOOM_FOLLOW } from "../../../../flown/frontend/utils/constants";
import {
  createReplayManager,
  createReplayMockApp,
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

describe("ReplayManager playback", () => {
  let replayManager: ReplayManager;
  let mockApp: MockApp;

  beforeEach(() => {
    vi.useFakeTimers();
    mountReplayDom();
    mockAnimationFrame();
    mockApp = createReplayMockApp();
    replayManager = createReplayManager(mockApp);
    mockApp.selectedPathIds = new Set([1]);
    replayManager.initializeReplay();
    mockApp.replayActive = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    unmountReplayDom();
  });

  describe("playReplay", () => {
    it("returns early if not active", () => {
      mockApp.replayActive = false;

      replayManager.playReplay();

      expect(replayManager.state.playing).toBe(false);
      expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    it("returns early if no map", () => {
      mockApp.map = null;

      replayManager.playReplay();

      expect(replayManager.state.playing).toBe(false);
    });

    it("sets playing state, swaps play/pause buttons and announces", () => {
      replayManager.playReplay();

      expect(replayManager.state.playing).toBe(true);
      expect(el("replay-play-btn").hidden).toBe(true);
      expect(el("replay-pause-btn").hidden).toBe(false);
      expect(liveRegionText()).toBe("Replay playing");
    });

    it("starts a single animation frame loop", () => {
      replayManager.playReplay();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(replayManager.state.animationFrameId).not.toBeNull();
    });

    it("does not start a second loop while already playing", () => {
      replayManager.playReplay();
      const firstFrameId = replayManager.state.animationFrameId;

      replayManager.playReplay();

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(replayManager.state.animationFrameId).toBe(firstFrameId);
    });

    it("does not persist state when playing", () => {
      replayManager.playReplay();

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("restarts from beginning when at the end", () => {
      replayManager.state.currentTime = replayManager.state.maxTime;
      replayManager.state.lastDrawnIndex = 2;
      replayManager.state.currentIndex = 2;

      replayManager.playReplay();

      expect(replayManager.state.currentTime).toBe(0);
      expect(replayManager.state.lastDrawnIndex).toBe(-1);
      expect(replayManager.state.currentIndex).toBe(-1);
    });

    it("takes the flown trail off the map when restarting, and keeps the route", () => {
      const { route, trail } = replaySources(mockApp);
      replayManager.seekReplay(String(replayManager.state.maxTime));
      vi.advanceTimersByTime(16);
      expect(featuresOf(trail)).toHaveLength(3);
      route.setData.mockClear();

      replayManager.playReplay();
      vi.advanceTimersByTime(16);

      expect(featuresOf(trail)).toEqual([]);
      expect(route.setData).not.toHaveBeenCalled();
      expect(featuresOf(route)).toHaveLength(1);
    });

    it("resets airplane to start when restarting from end", () => {
      replayManager.state.currentTime = replayManager.state.maxTime;

      replayManager.state.airplaneMarker!.setLatLng([48.3, 16.3]);

      replayManager.playReplay();
      // The first frame of the replay, at its start
      vi.advanceTimersToNextFrame();

      const [lat, lng] = replayManager.state.airplaneMarker!.position();
      expect(lat).toBeCloseTo(48.0, 3);
      expect(lng).toBeCloseTo(16.0, 3);
    });

    it("resets to initial zoom when restarting with autoZoom enabled", () => {
      replayManager.state.currentTime = replayManager.state.maxTime;
      replayManager.state.autoZoom = true;

      replayManager.playReplay();

      // The follow zoom in map units, over half a second in milliseconds
      expect(AUTO_ZOOM_FOLLOW).toBe(15);
      expect(mockApp.map!.easeTo).toHaveBeenLastCalledWith({
        center: [16.0, 48.0],
        zoom: AUTO_ZOOM_FOLLOW,
        duration: 500,
        animate: true,
      });
    });

    it("advances time with the configured speed and keeps looping", () => {
      replayManager.state.speed = 50;
      replayManager.playReplay();

      // First frame only records the timestamp, the second one advances
      vi.advanceTimersByTime(16);
      vi.advanceTimersByTime(16);

      expect(replayManager.state.playing).toBe(true);
      expect(replayManager.state.currentTime).toBeGreaterThan(0);
      expect(replayManager.state.currentTime).toBeLessThan(
        replayManager.state.maxTime,
      );
      // Three of the loop, and one that hands the first segment to the
      // map; the camera looks for its rest after its pans in frames of its
      // own
      const frames = vi
        .mocked(requestAnimationFrame)
        .mock.calls.filter(([callback]) => callback.name !== "lookForRest");
      expect(frames).toHaveLength(4);
    });

    it("keeps the user's bearing and pitch through the fit at the end", () => {
      // A fit of MapLibre turns the map north up unless it names a bearing
      mockApp.map!.jumpTo({ bearing: 120, pitch: 45 });
      replayManager.state.currentTime = replayManager.state.maxTime - 0.001;
      replayManager.state.speed = 1000;

      replayManager.playReplay();
      vi.advanceTimersByTime(50);

      expect(mockApp.map!.fitBounds).toHaveBeenCalledOnce();
      expect(mockApp.map!.getBearing()).toBe(120);
      expect(mockApp.map!.getPitch()).toBe(45);
    });

    it("pauses, fits bounds and announces when reaching max time", () => {
      replayManager.state.currentTime = replayManager.state.maxTime - 0.001;
      replayManager.state.speed = 1000;

      replayManager.playReplay();
      vi.advanceTimersByTime(50);

      expect(replayManager.state.playing).toBe(false);
      expect(replayManager.state.currentTime).toBe(replayManager.state.maxTime);
      // South-west and north-east corner, longitude first; one second
      expect(mockApp.map!.fitBounds).toHaveBeenCalledWith(
        [
          [16.0, 48.0],
          [16.3, 48.3],
        ],
        { bearing: 0, padding: 50, duration: 1000, animate: true },
      );
      expect(liveRegionText()).toBe("Replay finished");
      expect(el("replay-play-btn").hidden).toBe(false);
    });

    it("advances a frame after a stall by at most the frame cap", () => {
      replayManager.state.speed = 10;
      vi.mocked(requestAnimationFrame).mockRestore();
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
      });

      replayManager.playReplay();
      frames.shift()!(1000);
      // The page froze for five seconds before the next frame
      frames.shift()!(6000);

      // 100 ms of wall-clock time at 10x, not the 50 s the stall was worth
      expect(replayManager.state.currentTime).toBeCloseTo(
        (MAX_FRAME_DELTA_MS / 1000) * 10,
        5,
      );
    });

    it("does not count the time the tab was hidden", () => {
      replayManager.state.speed = 500;
      vi.mocked(requestAnimationFrame).mockRestore();
      const frames: FrameRequestCallback[] = [];
      vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
        frames.push(cb);
        return frames.length;
      });
      replayManager.playReplay();
      frames.shift()!(1000);
      frames.shift()!(1016);
      const beforeHiding = replayManager.state.currentTime;

      Object.defineProperty(document, "hidden", {
        value: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Reflect.deleteProperty(document, "hidden");
      // A minute later the tab is shown again and frames resume
      frames.shift()!(61016);

      expect(replayManager.state.currentTime).toBe(beforeHiding);
    });

    it("stops listening for visibility changes once destroyed", () => {
      replayManager.destroy();
      replayManager.state.lastFrameTime = 1234;

      Object.defineProperty(document, "hidden", {
        value: true,
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Reflect.deleteProperty(document, "hidden");

      // A destroyed manager no longer listens
      expect(replayManager.state.lastFrameTime).toBe(1234);
    });

    it("stops the loop when playing is set to false", () => {
      replayManager.playReplay();
      replayManager.state.playing = false;

      vi.advanceTimersByTime(20);

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(replayManager.state.currentTime).toBe(0);
    });
  });

  describe("airplane popup panning", () => {
    it("lets an open popup pan the map only while paused", () => {
      const pan = vi.spyOn(mapHelpers, "panPopupIntoView");
      replayManager.updateReplayAirplanePopup();
      pan.mockClear();

      // The popup is rebuilt as the airplane reaches the second segment
      replayManager.playReplay();
      replayManager.state.currentTime = 61;
      replayManager.updateReplayDisplay();
      expect(pan).not.toHaveBeenCalled();

      replayManager.pauseReplay();
      replayManager.seekReplay("121");
      expect(pan).toHaveBeenCalledTimes(1);
    });
  });

  describe("pauseReplay", () => {
    it("sets playing to false and swaps buttons", () => {
      replayManager.playReplay();

      replayManager.pauseReplay();

      expect(replayManager.state.playing).toBe(false);
      expect(el("replay-play-btn").hidden).toBe(false);
      expect(el("replay-pause-btn").hidden).toBe(true);
    });

    it("stops the frame loop, so the time no longer advances", () => {
      replayManager.playReplay();
      vi.advanceTimersByTime(16);
      vi.advanceTimersByTime(16);
      const timeAtPause = replayManager.state.currentTime;
      expect(timeAtPause).toBeGreaterThan(0);

      replayManager.pauseReplay();
      vi.advanceTimersByTime(200);

      expect(replayManager.state.animationFrameId).toBeNull();
      expect(replayManager.state.currentTime).toBe(timeAtPause);
    });

    it("hands focus from Play to Pause and back", () => {
      el("replay-play-btn").focus();

      replayManager.playReplay();
      // Play is hidden now; focus must not drop to <body>
      expect(document.activeElement).toBe(el("replay-pause-btn"));

      replayManager.pauseReplay();
      expect(document.activeElement).toBe(el("replay-play-btn"));
    });

    it("hands focus to Play when the replay finishes on Pause", () => {
      replayManager.state.currentTime = replayManager.state.maxTime - 0.001;
      replayManager.state.speed = 1000;
      replayManager.playReplay();
      el("replay-pause-btn").focus();

      vi.advanceTimersByTime(50);

      expect(replayManager.state.playing).toBe(false);
      expect(document.activeElement).toBe(el("replay-play-btn"));
    });

    it("leaves focus elsewhere alone", () => {
      el("replay-speed").focus();

      replayManager.playReplay();
      replayManager.pauseReplay();

      expect(document.activeElement).toBe(el("replay-speed"));
    });

    it("resets frame time", () => {
      replayManager.state.lastFrameTime = 12345;

      replayManager.pauseReplay();

      expect(replayManager.state.lastFrameTime).toBeNull();
    });

    it("announces the paused position when it was playing", () => {
      replayManager.playReplay();
      replayManager.state.currentTime = 65;

      replayManager.pauseReplay();

      expect(liveRegionText()).toBe("Replay paused at 1:05");
    });

    it("does not announce when it was not playing", () => {
      replayManager.pauseReplay();

      expect(liveRegionText()).toBe("");
    });

    it("does not persist state when pausing", () => {
      replayManager.playReplay();
      replayManager.pauseReplay();

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });
  });

  describe("stopReplay", () => {
    it("pauses and resets time", () => {
      replayManager.state.currentTime = 50;

      replayManager.stopReplay();

      expect(replayManager.state.playing).toBe(false);
      expect(replayManager.state.currentTime).toBe(0);
      expect(replayManager.state.lastDrawnIndex).toBe(-1);
      expect(liveRegionText()).toBe("Replay stopped");
    });

    it("writes the route and the trail again once the map has its style back after a lost WebGL context", () => {
      const { route, trail } = replaySources(mockApp);
      const map = mockApp.map!;
      const getSource = map.getSource.getMockImplementation()!;
      // Written while the context was lost: no source to go to
      map.getSource.mockImplementation(() => undefined);
      replayManager.seekReplay("100");
      vi.advanceTimersByTime(16);
      map.getSource.mockImplementation(getSource);
      void route.setData({ type: "FeatureCollection", features: [] });
      expect(featuresOf(trail)).toEqual([]);

      map.emit("webglcontextrestored");
      map.emit("style.load");
      vi.advanceTimersByTime(16);

      expect(featuresOf(route)).toHaveLength(1);
      expect(featuresOf(trail)).toHaveLength(2);
    });

    it("empties the route and the trail the style brings back, once a replay closed while the WebGL context was lost", () => {
      const { route, trail } = replaySources(mockApp);
      const map = mockApp.map!;
      replayManager.seekReplay("100");
      vi.advanceTimersByTime(16);
      expect(featuresOf(trail)).toHaveLength(2);
      const getSource = map.getSource.getMockImplementation()!;
      map.getSource.mockImplementation(() => undefined);
      replayManager.toggleReplay();
      expect(mockApp.replayActive).toBe(false);
      map.getSource.mockImplementation(getSource);
      expect(featuresOf(route)).toHaveLength(1);

      map.emit("webglcontextrestored");
      map.emit("style.load");

      expect(featuresOf(route)).toEqual([]);
      expect(featuresOf(trail)).toEqual([]);
    });

    it("writes nothing to a map the app has let go of after a lost WebGL context", () => {
      const { route } = replaySources(mockApp);
      const map = mockApp.map!;
      const lifetime = new AbortController();
      Object.assign(mockApp, { signal: lifetime.signal });
      lifetime.abort();
      route.setData.mockClear();

      map.emit("webglcontextrestored");
      map.emit("style.load");

      expect(route.setData).not.toHaveBeenCalled();
    });

    it("takes the trail off the map and keeps the route", () => {
      const { route, trail } = replaySources(mockApp);
      replayManager.seekReplay("100");
      vi.advanceTimersByTime(16);
      expect(featuresOf(trail)).toHaveLength(2);

      replayManager.stopReplay();
      vi.advanceTimersByTime(16);

      expect(replayManager.state.trailRuns).toEqual([]);
      expect(featuresOf(trail)).toEqual([]);
      expect(featuresOf(route)).toHaveLength(1);
    });

    it("resets airplane to start position", () => {
      replayManager.seekReplay("100");

      replayManager.stopReplay();

      expect(replayManager.state.airplaneMarker!.position()).toEqual([
        48.0, 16.0,
      ]);
    });

    it("resets the slider and time display", () => {
      replayManager.seekReplay("50");
      expect((el("replay-slider") as HTMLInputElement).value).toBe("50");

      replayManager.stopReplay();

      expect((el("replay-slider") as HTMLInputElement).value).toBe("0");
      expect(el("replay-time-display").textContent).toBe("0:00 / 4:00");
    });
  });

  describe("seekReplay", () => {
    it("sets current time from string value", () => {
      replayManager.seekReplay("60.5");

      expect(replayManager.state.currentTime).toBe(60.5);
      expect((el("replay-slider") as HTMLInputElement).value).toBe("60.5");
    });

    it("removes only the segments after the new time when seeking backward", () => {
      replayManager.seekReplay("100");
      expect(replayManager.state.lastDrawnIndex).toBe(1);
      vi.advanceTimersByTime(16);
      const { trail } = replaySources(mockApp);
      const firstRun = replayManager.state.trailRuns[0];
      trail.setData.mockClear();

      replayManager.seekReplay("30");
      vi.advanceTimersByTime(16);

      // Starting over would colour the whole flight on every drag event
      expect(replayManager.state.trailRuns[0]).toBe(firstRun);
      expect(replayManager.state.currentTime).toBe(30);
      // Only the segment at t=0 is visible again
      expect(replayManager.state.lastDrawnIndex).toBe(0);
      expect(replayManager.state.trailRuns).toHaveLength(1);
      expect(trail.setData).toHaveBeenCalledTimes(1);
      expect(featuresOf(trail)).toHaveLength(1);
    });

    it("writes one trail per frame for a drag back and forth", () => {
      const { trail } = replaySources(mockApp);
      trail.setData.mockClear();

      for (const value of ["100", "30", "125", "70"]) {
        replayManager.seekReplay(value);
      }
      vi.advanceTimersByTime(16);

      expect(trail.setData).toHaveBeenCalledTimes(1);
      expect(featuresOf(trail)).toHaveLength(2);
    });

    it("keeps the flown trail when seeking forward", () => {
      replayManager.seekReplay("30");
      const firstRun = replayManager.state.trailRuns[0];

      // The start of the second segment, as the replay has timed it
      replayManager.seekReplay(String(replayManager.state.segments[1]!.time));

      expect(replayManager.state.trailRuns[0]).toBe(firstRun);
      expect(replayManager.state.lastDrawnIndex).toBe(1);
    });

    it("does not persist state when seeking", () => {
      replayManager.seekReplay("30");

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("does not announce every seek step", () => {
      replayManager.seekReplay("30");

      expect(liveRegionText()).toBe("");
    });

    it("ignores non-finite values", () => {
      replayManager.state.currentTime = 42;

      replayManager.seekReplay("not-a-number");

      expect(replayManager.state.currentTime).toBe(42);
    });

    it("ignores Infinity", () => {
      replayManager.state.currentTime = 42;

      replayManager.seekReplay("Infinity");

      expect(replayManager.state.currentTime).toBe(42);
    });
  });

  describe("timeline keys", () => {
    function press(key: string): KeyboardEvent {
      const event = new KeyboardEvent("keydown", { key, cancelable: true });
      el("replay-slider").dispatchEvent(event);
      return event;
    }

    beforeEach(() => {
      // A three hour flight: the native step of one second took over ten
      // thousand presses end to end
      replayManager.state.maxTime = 12000;
      (el("replay-slider") as HTMLInputElement).max = "12000";
      replayManager.seekReplay("6000");
    });

    it("moves a hundredth of the flight per arrow", () => {
      expect(press("ArrowRight").defaultPrevented).toBe(true);
      expect(replayManager.state.currentTime).toBe(6120);
      press("ArrowUp");
      expect(replayManager.state.currentTime).toBe(6240);
      press("ArrowLeft");
      press("ArrowDown");
      expect(replayManager.state.currentTime).toBe(6000);
    });

    it("moves a tenth of the flight per page key", () => {
      press("PageUp");
      expect(replayManager.state.currentTime).toBe(7200);
      press("PageDown");
      press("PageDown");
      expect(replayManager.state.currentTime).toBe(4800);
      expect((el("replay-slider") as HTMLInputElement).value).toBe("4800");
    });

    it("stops at either end of the flight", () => {
      for (let i = 0; i < 20; i++) press("PageUp");
      expect(replayManager.state.currentTime).toBe(12000);
      for (let i = 0; i < 20; i++) press("PageDown");
      expect(replayManager.state.currentTime).toBe(0);
    });

    it("moves at least a second on a short flight", () => {
      replayManager.state.maxTime = 40;
      replayManager.seekReplay("10");

      press("ArrowRight");

      expect(replayManager.state.currentTime).toBe(11);
    });

    it("leaves Home, End and other keys to the browser", () => {
      expect(press("Home").defaultPrevented).toBe(false);
      expect(press("Tab").defaultPrevented).toBe(false);
      expect(replayManager.state.currentTime).toBe(6000);
    });
  });

  describe("changeReplaySpeed", () => {
    it("updates speed from select element", () => {
      (el("replay-speed") as HTMLSelectElement).value = "100";

      replayManager.changeReplaySpeed();

      expect(replayManager.state.speed).toBe(100);
      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("keeps the speed if no speed select element", () => {
      el("replay-speed").remove();

      replayManager.changeReplaySpeed();

      expect(replayManager.state.speed).toBe(50.0);
    });

    it("ignores non-finite speed values", () => {
      (el("replay-speed") as HTMLSelectElement).value = "abc";

      replayManager.changeReplaySpeed();

      expect(replayManager.state.speed).toBe(50.0);
    });

    it("ignores zero speed", () => {
      (el("replay-speed") as HTMLSelectElement).value = "0";

      replayManager.changeReplaySpeed();

      expect(replayManager.state.speed).toBe(50.0);
    });

    it("ignores negative speed", () => {
      (el("replay-speed") as HTMLSelectElement).value = "-10";

      replayManager.changeReplaySpeed();

      expect(replayManager.state.speed).toBe(50.0);
    });
  });

  describe("toggleAutoZoom", () => {
    it("toggles autoZoom on and marks the button pressed", () => {
      replayManager.state.autoZoom = false;

      replayManager.toggleAutoZoom();

      expect(replayManager.state.autoZoom).toBe(true);
      const btn = el("replay-autozoom-btn");
      expect(btn.classList.contains("active")).toBe(true);
      expect(btn.getAttribute("aria-pressed")).toBe("true");
    });

    it("toggles autoZoom off", () => {
      replayManager.state.autoZoom = true;
      const btn = el("replay-autozoom-btn");
      btn.title = "Auto-zoom: zoom in on the aircraft and keep it in view";

      replayManager.toggleAutoZoom();

      expect(replayManager.state.autoZoom).toBe(false);
      expect(btn.classList.contains("active")).toBe(false);
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      // The title says what the control does, aria-pressed whether it is on
      expect(btn.title).toBe(
        "Auto-zoom: zoom in on the aircraft and keep it in view",
      );
    });

    it("does not persist state", () => {
      replayManager.toggleAutoZoom();

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("works without the auto-zoom button", () => {
      el("replay-autozoom-btn").remove();

      replayManager.toggleAutoZoom();

      expect(replayManager.state.autoZoom).toBe(true);
    });
  });
});
