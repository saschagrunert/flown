/**
 * ReplayManager: activation, initialization and layer handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ReplayManager } from "../../../../flown/frontend/ui/replayManager";
import {
  REPLAY_LEGEND_HEIGHT_VAR,
  REPLAY_PANEL_HEIGHT_VAR,
} from "../../../../flown/frontend/ui/replayManager";
import {
  REPLAY_PRECONDITION_MESSAGE,
  REPLAY_TOO_MANY_MESSAGE,
} from "../../../../flown/frontend/ui/replayButton";
import { STILL_LOADING_MESSAGE } from "../../../../flown/frontend/ui/actions";
import {
  LIVE_REGION_DELAY_MS,
  TOAST_STATUS_ID,
} from "../../../../flown/frontend/utils/toast";
import {
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../flown/frontend/utils/constants";
import type { AirportMarker } from "../../../../flown/frontend/types";
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
import {
  asMapApp,
  createDataset,
  createMockApp,
  isHeld,
  segmentOf,
} from "../../testHelpers";
import { setColorLayer } from "../../../../flown/frontend/ui/layerVisibility";
import * as motion from "../../../../flown/frontend/utils/motion";

vi.mock("../../../../flown/frontend/utils/htmlGenerators", () => ({
  generateSegmentPopupHtml: vi.fn(() => "<div>popup</div>"),
}));

function toastText(): string | null {
  return document.querySelector(".toast-notification")?.textContent ?? null;
}

describe("ReplayManager activation", () => {
  let replayManager: ReplayManager;
  let mockApp: MockApp;

  beforeEach(() => {
    vi.useFakeTimers();
    mountReplayDom();
    mockAnimationFrame();
    mockApp = createReplayMockApp();
    replayManager = createReplayManager(mockApp);
  });

  afterEach(() => {
    vi.useRealTimers();
    unmountReplayDom();
  });

  describe("constructor", () => {
    it("initializes with default replay state", () => {
      expect(mockApp.replayActive).toBe(false);
      expect(replayManager.state.playing).toBe(false);
      expect(replayManager.state.currentTime).toBe(0);
      expect(replayManager.state.maxTime).toBe(0);
      expect(replayManager.state.speed).toBe(50.0);
      expect(replayManager.state.layerActive).toBe(false);
      expect(replayManager.state.trailRuns).toEqual([]);
      expect(replayManager.state.segments).toEqual([]);
      expect(replayManager.state.airplaneMarker).toBeNull();
      expect(replayManager.state.lastDrawnIndex).toBe(-1);
      expect(replayManager.state.autoZoom).toBe(false);
    });

    it("announces the position when a slider drag ends", () => {
      replayManager.state.currentTime = 65;

      el("replay-slider").dispatchEvent(new Event("change"));

      expect(liveRegionText()).toBe("Moved to 1:05");
    });

    it("stops listening to the slider once the app is gone", () => {
      // A fresh panel, so only the manager of the ended app listens to it
      unmountReplayDom();
      mountReplayDom();
      const lifetime = new AbortController();
      const manager = createReplayManager(
        createMockApp({ signal: lifetime.signal }),
      );
      manager.state.currentTime = 65;

      lifetime.abort();
      el("replay-slider").dispatchEvent(new Event("change"));

      expect(liveRegionText()).toBe("");
    });
  });

  describe("toggleReplay", () => {
    it("returns early if replay-controls panel not found", () => {
      el("replay-controls").remove();
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      expect(mockApp.replayActive).toBe(false);
    });

    it("shows an explanatory toast when no path is selected, and the flights to pick from", () => {
      mockApp.selectedPathIds = new Set();

      replayManager.toggleReplay();

      expect(mockApp.replayActive).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
      expect(mockApp.statsPanelVisible).toBe(true);
      expect(mockApp.flightListVisible).toBe(true);
    });

    it("says Replay all is the one for more than a day of flights", () => {
      mockApp.selectedPathIds = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      replayManager.toggleReplay();

      expect(mockApp.replayActive).toBe(false);
      expect(toastText()).toBe(REPLAY_TOO_MANY_MESSAGE);
    });

    it("shows an explanatory toast when none of several selected has timing data", () => {
      mockApp.selectedPathIds = new Set([1, 2]);
      mockApp.hasTimingData = false;

      replayManager.toggleReplay();

      expect(mockApp.replayActive).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
      // They are picked already
      expect(mockApp.statsPanelVisible).toBe(false);
    });

    it("shows an explanatory toast for a flight that takes no time", () => {
      // A single timed segment: replay would finish the moment it started
      mockApp.currentData = createDataset(
        [{ id: 1 }],
        createSegments().slice(0, 1),
      );
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      expect(mockApp.replayActive).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("refuses to initialize a flight whose times are all 0", () => {
      const segments = createSegments().map((s) => ({ ...s, time: 0 }));
      mockApp.currentData = createDataset([{ id: 1 }], segments);
      mockApp.selectedPathIds = new Set([1]);

      expect(replayManager.initializeReplay()).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("refuses to initialize a flight with one time for every point", () => {
      // It passed as timed and finished at once, nothing drawn
      const segments = createSegments().map((s) => ({ ...s, time: 600 }));
      mockApp.currentData = createDataset([{ id: 1 }], segments);
      mockApp.selectedPathIds = new Set([1]);

      expect(replayManager.initializeReplay()).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("shows an explanatory toast when the selection has no timing data", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.hasTimingData = false;

      replayManager.toggleReplay();

      expect(mockApp.replayActive).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("activates replay when exactly one path is selected", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      expect(mockApp.replayActive).toBe(true);
      expect(el("replay-controls").style.display).toBe("block");
      expect(document.body.classList.contains("replay-active")).toBe(true);
    });

    it("stays shut while the hotspot tour holds the map", () => {
      // A click whose bundle came after the tour's
      mockApp.selectedPathIds = new Set([1]);
      mockApp.tourView = {
        center: { lat: 48, lng: 16 },
        zoom: 8,
        bearing: 0,
        pitch: 0,
        globeVisible: false,
        threeDVisible: false,
        heatmapVisible: true,
      };

      replayManager.toggleReplay();

      expect(mockApp.replayActive).toBe(false);
      expect(el("replay-controls").style.display).not.toBe("block");
    });

    it("stays shut under Wrapped, which opened while its bundle came", () => {
      // A press on the flight profile, then Wrapped before the bundle
      mockApp.selectedPathIds = new Set([1]);
      mockApp.wrappedVisible = true;

      replayManager.toggleReplay(false);

      expect(mockApp.replayActive).toBe(false);
      expect(el("replay-controls").style.display).not.toBe("block");
    });

    it("goes to the start of the flight, unless asked to stay", () => {
      mockApp.selectedPathIds = new Set([1]);
      const easeTo = vi.mocked(mockApp.map!.easeTo);
      easeTo.mockClear();

      replayManager.toggleReplay();
      expect(easeTo).toHaveBeenCalledWith(
        expect.objectContaining({ center: [16.0, 48.0] }),
      );
      replayManager.toggleReplay();
      easeTo.mockClear();

      // The flight profile opens it where the map is, and seeks from there
      replayManager.toggleReplay(false);
      expect(mockApp.replayActive).toBe(true);
      expect(easeTo).not.toHaveBeenCalled();
    });

    it("keeps the tilt of the map, or the one a lay-back it cuts short goes to", () => {
      mockApp.selectedPathIds = new Set([1]);
      const easeTo = vi.mocked(mockApp.map!.easeTo);
      mockApp.map!.jumpTo({ pitch: 25 });
      easeTo.mockClear();

      replayManager.toggleReplay();
      expect(easeTo).toHaveBeenCalledWith(
        expect.objectContaining({ pitch: 25 }),
      );
      replayManager.toggleReplay();

      // The replay of all flights lays the map back flat
      mockApp.replayState.layingBack = 0;
      easeTo.mockClear();
      replayManager.toggleReplay();
      expect(easeTo).toHaveBeenCalledWith(
        expect.objectContaining({ pitch: 0 }),
      );
    });

    it("leaves persistence to the store subscription", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();
      replayManager.toggleReplay();

      // Replay state itself is not persisted, and the layer state reaches
      // the state manager through the store
      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
    });

    it("takes the speed from the select on activation", () => {
      (el("replay-speed") as HTMLSelectElement).value = "100";
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      expect(replayManager.state.speed).toBe(100);
    });

    it("swaps the replay button to stop without losing its label", () => {
      mockApp.selectedPathIds = new Set([1]);
      // As the template names it
      el("replay-btn").setAttribute("aria-label", "Replay selected flights");

      replayManager.toggleReplay();

      const replayBtn = el("replay-btn");
      expect(replayBtn.dataset["icon"]).toBe("stop");
      expect(replayBtn.querySelectorAll("svg.icon")).toHaveLength(1);
      expect(replayBtn.querySelector(".control-label")!.textContent).toBe(
        "Replay",
      );
      expect(replayBtn.getAttribute("aria-pressed")).toBe("true");
      // A toggle keeps its name: "Stop replay, pressed" said the opposite
      // of what a press does. aria-pressed carries the state.
      expect(replayBtn.getAttribute("aria-label")).toBe(
        "Replay selected flights",
      );
      expect(replayBtn.title).toBe("Replay selected flights");
    });

    it("restores the replay button on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      el("replay-btn").setAttribute("aria-label", "Replay selected flights");
      replayManager.toggleReplay();

      replayManager.toggleReplay();

      const replayBtn = el("replay-btn");
      expect(replayBtn.dataset["icon"]).toBe("play");
      expect(replayBtn.querySelectorAll("svg.icon")).toHaveLength(1);
      expect(replayBtn.querySelector(".control-label")!.textContent).toBe(
        "Replay",
      );
      expect(replayBtn.getAttribute("aria-pressed")).toBe("false");
      expect(replayBtn.getAttribute("aria-label")).toBe(
        "Replay selected flights",
      );
    });

    it("announces the close through the page, not the hidden panel", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();

      replayManager.toggleReplay();

      // The panel's region is hidden with the panel and would not be read
      vi.advanceTimersByTime(LIVE_REGION_DELAY_MS);
      expect(document.getElementById(TOAST_STATUS_ID)!.textContent).toBe(
        "Replay closed",
      );
      expect(liveRegionText()).not.toBe("Replay closed");
    });

    it("hands the panel height to the stylesheet while replay is open", () => {
      mockApp.selectedPathIds = new Set([1]);
      Object.defineProperty(el("replay-controls"), "offsetHeight", {
        value: 167,
        configurable: true,
      });

      replayManager.toggleReplay();
      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toBe("167px");

      replayManager.toggleReplay();
      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toBe("");
    });

    it("measures the panel again as it wraps anew, a phone turned", () => {
      const observers: {
        callback: () => void;
        observed: Element[];
        disconnect: () => void;
      }[] = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          observed: Element[] = [];
          disconnect = vi.fn();
          observe = (target: Element) => this.observed.push(target);
          constructor(readonly callback: () => void) {
            observers.push(this);
          }
        },
      );
      mockApp.selectedPathIds = new Set([1]);
      const panel = el("replay-controls");
      let height = 167;
      Object.defineProperty(panel, "offsetHeight", {
        get: () => height,
        configurable: true,
      });
      replayManager.toggleReplay();
      const watch = observers.find((o) => o.observed.includes(panel))!;

      height = 220;
      watch.callback();
      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toBe("220px");

      replayManager.toggleReplay();
      expect(watch.disconnect).toHaveBeenCalled();
      expect(
        document.body.style.getPropertyValue(REPLAY_PANEL_HEIGHT_VAR),
      ).toBe("");
      vi.unstubAllGlobals();
    });

    it("hands the height of the legend on screen to the stylesheet too", () => {
      // Where the legend stands on the panel, the toasts stood on the
      // legend (regression)
      mockApp.selectedPathIds = new Set([1]);
      Object.defineProperty(el("altitude-legend"), "offsetHeight", {
        value: 95,
        configurable: true,
      });

      replayManager.toggleReplay();
      expect(
        document.body.style.getPropertyValue(REPLAY_LEGEND_HEIGHT_VAR),
      ).toBe("95px");

      replayManager.toggleReplay();
      expect(
        document.body.style.getPropertyValue(REPLAY_LEGEND_HEIGHT_VAR),
      ).toBe("");
    });

    it("closes on Escape, as Wrapped and the sheets do", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      expect(mockApp.replayActive).toBe(true);

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );

      expect(mockApp.replayActive).toBe(false);
    });

    it("leaves Escape to the replay of every flight, which has its own", () => {
      mockApp.replayState.all = true;
      mockApp.replayActive = true;

      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );

      expect(mockApp.replayActive).toBe(true);
      mockApp.replayState.all = false;
    });

    it("leaves Escape to the speed picker, a text field and a popup", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      const popup = document.createElement("div");
      popup.className = "maplibregl-popup";
      const inside = document.createElement("button");
      popup.append(inside);
      const search = document.createElement("input");
      search.type = "search";
      document.body.append(popup, search);

      for (const target of [el("replay-speed"), inside, search]) {
        const escape = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(escape);
        // Nor kept from the field, which empties itself on it
        expect(escape.defaultPrevented).toBe(false);
      }

      expect(mockApp.replayActive).toBe(true);
      popup.remove();
      search.remove();
    });

    it("syncs the auto-zoom button with the autoZoom state on activation", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.autoZoom = true;

      replayManager.toggleReplay();

      const autoZoomBtn = el("replay-autozoom-btn");
      expect(autoZoomBtn.classList.contains("active")).toBe(true);
      expect(autoZoomBtn.getAttribute("aria-pressed")).toBe("true");
    });

    it("shows the auto-zoom button off when auto-zoom is off", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.autoZoom = false;

      replayManager.toggleReplay();

      const autoZoomBtn = el("replay-autozoom-btn");
      // Off, not unavailable: no accent, and nothing dims it
      expect(autoZoomBtn.classList.contains("active")).toBe(false);
      expect(autoZoomBtn.style.opacity).toBe("");
      expect(autoZoomBtn.getAttribute("aria-pressed")).toBe("false");
    });

    it("hides other layers during replay activation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.heatmapVisible = true;
      mockApp.altitudeVisible = true;
      mockApp.heatmapLayer.setVisible(true);
      mockApp.altitudeLayer.setVisible(true);

      replayManager.toggleReplay();

      expect(mockApp.heatmapLayer.isVisible()).toBe(false);
      expect(mockApp.altitudeLayer.isVisible()).toBe(false);
      expect(mockApp.map!.layer(MAP_LAYERS.heat).layout["visibility"]).toBe(
        "none",
      );
      // What the user had on is remembered by the store, for the restore
      expect(mockApp.heatmapVisible).toBe(true);
      expect(mockApp.altitudeVisible).toBe(true);
    });

    it("deactivates replay when already active", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      expect(mockApp.replayActive).toBe(true);

      replayManager.toggleReplay();

      expect(mockApp.replayActive).toBe(false);
      expect(el("replay-controls").style.display).toBe("none");
      expect(document.body.classList.contains("replay-active")).toBe(false);
    });

    it("removes the airplane marker on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      const marker = replayManager.state.airplaneMarker!;
      marker.openPopup();
      const canvasContainer = mockApp.map!.getCanvasContainer();
      expect(canvasContainer.contains(marker.getElement())).toBe(true);

      replayManager.toggleReplay();

      expect(canvasContainer.contains(marker.getElement())).toBe(false);
      expect(marker.isPopupOpen()).toBe(false);
      expect(replayManager.state.airplaneMarker).toBeNull();
    });

    it("lays the dimmed route down once, when replay opens", () => {
      // Replay hides the heat bloom and the paths, so without the route the
      // map is empty ahead of the aircraft
      mockApp.selectedPathIds = new Set([1]);
      const { route, trail } = replaySources(mockApp);

      replayManager.toggleReplay();

      expect(route.setData).toHaveBeenCalledTimes(1);
      // One point per segment, plus the end of the last one; longitude first
      expect(featuresOf(route)).toHaveLength(1);
      expect(featuresOf(route)[0]!.geometry).toEqual({
        type: "LineString",
        coordinates: [
          [16.0, 48.0],
          [16.1, 48.1],
          [16.2, 48.2],
          [16.3, 48.3],
        ],
      });
      expect(featuresOf(trail)).toEqual([]);

      // Playing, seeking and stopping never touch it again
      replayManager.seekReplay("100");
      replayManager.seekReplay("20");
      replayManager.stopReplay();
      vi.advanceTimersByTime(100);
      expect(route.setData).toHaveBeenCalledTimes(1);
    });

    it("empties both replay sources on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      const { route, trail } = replaySources(mockApp);
      replayManager.toggleReplay();
      replayManager.seekReplay("100");
      vi.advanceTimersByTime(16);
      expect(featuresOf(trail)).toHaveLength(2);

      replayManager.toggleReplay();

      expect(replayManager.state.layerActive).toBe(false);
      expect(featuresOf(route)).toEqual([]);
      expect(featuresOf(trail)).toEqual([]);
    });

    it("drops a trail write that was still pending when replay closed", () => {
      mockApp.selectedPathIds = new Set([1]);
      const { trail } = replaySources(mockApp);
      replayManager.toggleReplay();
      replayManager.seekReplay("100");

      replayManager.toggleReplay();
      trail.setData.mockClear();
      vi.advanceTimersByTime(100);

      expect(trail.setData).not.toHaveBeenCalled();
      expect(featuresOf(trail)).toEqual([]);
    });

    it("restores layer visibility on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.heatmapVisible = true;

      replayManager.toggleReplay();
      mockApp.dataManager.showHeatmap.mockClear();
      replayManager.toggleReplay();

      // The data manager adds it, with the points of the filter changes
      // made during the replay and the dimming its new canvas has lost
      expect(mockApp.dataManager.showHeatmap).toHaveBeenCalledTimes(1);
    });

    it("leaves the colour layers off when neither was on before replay", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      replayManager.toggleReplay();
      replayManager.toggleReplay();
      vi.advanceTimersByTime(500);

      // Closing replay used to switch the altitude layer on unasked
      expect(mockApp.altitudeVisible).toBe(false);
      expect(el("altitude-btn").getAttribute("aria-pressed")).toBe("false");
      expect(el("altitude-legend").hidden).toBe(true);
      expect(mockApp.altitudeLayer.isVisible()).toBe(false);
    });

    it("shows the altitude scale for the trail while neither layer is on", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;

      replayManager.toggleReplay();

      // The trail is drawn in altitude colours, so its scale is shown
      expect(el("altitude-legend").hidden).toBe(false);
      expect(el("airspeed-legend").hidden).toBe(true);
    });

    it("moves the trail's scale along when a colour layer is toggled", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = false;
      replayManager.toggleReplay();

      // Speed switched on during replay colours the trail by speed: its
      // scale replaces the altitude one instead of stacking on top of it
      mockApp.airspeedVisible = true;
      expect(el("altitude-legend").hidden).toBe(true);
      expect(el("airspeed-legend").hidden).toBe(false);

      // And back off, the trail is coloured by altitude again
      mockApp.airspeedVisible = false;
      expect(el("altitude-legend").hidden).toBe(false);
      expect(el("airspeed-legend").hidden).toBe(true);
    });

    it("stops following the colour layers once replay is closed", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      replayManager.toggleReplay();
      const redraw = vi.spyOn(replayManager, "redrawReplayPath");

      mockApp.airspeedVisible = true;
      mockApp.threeDVisible = true;

      expect(redraw).not.toHaveBeenCalled();
      expect(el("altitude-legend").hidden).toBe(true);
    });

    it("colours the flown trail by the colour layer that is on", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      const redraw = vi.spyOn(replayManager, "redrawReplayPath");

      // The toggle writes both keys in one update: one redraw
      setColorLayer(asMapApp(mockApp), "airspeed", true);
      expect(redraw).toHaveBeenLastCalledWith("airspeed");
      expect(redraw).toHaveBeenCalledTimes(1);

      setColorLayer(asMapApp(mockApp), "altitude", true);
      expect(redraw).toHaveBeenLastCalledWith("altitude");

      // With neither on, the trail keeps its altitude colours
      setColorLayer(asMapApp(mockApp), "altitude", false);
      expect(redraw).toHaveBeenLastCalledWith("altitude");
    });

    it("brings an open airplane popup to the new scale", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      const update = vi.spyOn(replayManager, "updateReplayAirplanePopup");

      mockApp.airspeedVisible = true;
      expect(update).not.toHaveBeenCalled();

      replayManager.state.airplaneMarker!.openPopup();
      update.mockClear();
      mockApp.airspeedVisible = false;
      expect(update).toHaveBeenCalledTimes(1);
    });

    it("closes a popup left open on the map", () => {
      mockApp.selectedPathIds = new Set([1]);

      const airport = (open: boolean) =>
        ({
          isPopupOpen: vi.fn(() => open),
          closePopup: vi.fn(),
        }) as unknown as AirportMarker;
      const open = airport(true);
      const closed = airport(false);
      mockApp.airportMarkers["EDDF"] = open;
      mockApp.airportMarkers["LOWW"] = closed;

      replayManager.toggleReplay();

      // A path tapped on a phone left its popup over the replay controls
      expect(mockApp.layerManager.closeSegmentPopup).toHaveBeenCalledTimes(1);
      // So did an airport
      expect(open.closePopup).toHaveBeenCalledTimes(1);
      expect(closed.closePopup).not.toHaveBeenCalled();
    });

    it("follows the user's hand on the map from the start to the close", () => {
      const map = mockApp.map!;
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();
      // Before any frame: a press that is already down has to be seen
      expect(map.listenerCount("movestart")).toBe(1);

      replayManager.toggleReplay();
      expect(map.listenerCount("movestart")).toBe(0);
    });

    it("leaves the legends to the layers when the speed layer colours the trail", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = false;
      mockApp.airspeedVisible = true;

      replayManager.toggleReplay();

      expect(el("altitude-legend").hidden).toBe(true);
      expect(el("airspeed-legend").hidden).toBe(false);
    });

    it("hands the colour layers back to the layer manager on deactivation", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.altitudeVisible = true;
      replayManager.toggleReplay();
      expect(mockApp.altitudeLayer.isVisible()).toBe(false);
      vi.mocked(mockApp.layerManager.syncModes).mockClear();

      replayManager.toggleReplay();

      // It shows and redraws them (see layerVisibility.test.ts)
      expect(mockApp.layerManager.syncModes).toHaveBeenCalled();
      expect(mockApp.altitudeLayer.isVisible()).toBe(true);
      expect(mockApp.airspeedLayer.isVisible()).toBe(false);
    });

    it("cancels the frame loop and stops following the store on destroy", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      replayManager.playReplay();
      const redraw = vi.spyOn(replayManager, "redrawReplayPath");

      replayManager.destroy();
      mockApp.airspeedVisible = true;

      expect(redraw).not.toHaveBeenCalled();
      expect(replayManager.state.animationFrameId).toBeNull();
    });
  });

  describe("replay chrome", () => {
    function activate(): HTMLElement {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      return el("replay-controls");
    }

    it("adds an exit control away from the transport controls", () => {
      const panel = activate();

      const exit = panel.querySelector<HTMLButtonElement>(".replay-exit")!;
      expect(exit).not.toBeNull();
      // First child so it lands in the top corner, not next to play/stop
      expect(panel.firstElementChild).toBe(exit);
      expect(exit.getAttribute("aria-label")).toBe("Close replay");
    });

    it("closes replay from the exit control", () => {
      const panel = activate();

      panel.querySelector<HTMLButtonElement>(".replay-exit")!.click();

      expect(mockApp.replayActive).toBe(false);
      expect(panel.style.display).toBe("none");
    });

    it("adds a readout strip that is not a live region", () => {
      const panel = activate();

      const readout = panel.querySelector<HTMLElement>(".replay-readout")!;
      expect(
        Array.from(readout.querySelectorAll(".replay-readout-label")).map(
          (cell) => cell.textContent,
        ),
      ).toEqual(["Altitude", "Groundspeed", "Track"]);
      // The frame loop writes this many times a second
      expect(readout.getAttribute("aria-live")).toBeNull();
      expect(readout.closest("[aria-live]")).toBeNull();
    });

    it("keeps the readout beside the live region, never inside it", () => {
      const panel = activate();

      const live = el("replay-live");
      // The assertion above is only worth anything while this holds
      expect(live.getAttribute("aria-live")).toBe("polite");

      const readout = panel.querySelector<HTMLElement>(".replay-readout")!;
      expect(live.contains(readout)).toBe(false);
      expect(readout.parentElement).toBe(el("replay-controls-inner"));
    });

    it("fills the readout on the first activation", () => {
      // The chrome has to exist before initializeReplay() writes to it, or
      // the strip shows placeholder dashes for the whole first replay
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();

      expect(el("replay-readout-altitude").textContent).toBe("3,000 ft");
    });

    it("moves focus into the panel and back out again", () => {
      const panel = activate();

      const exit = panel.querySelector<HTMLButtonElement>(".replay-exit")!;
      expect(document.activeElement).toBe(exit);

      // Closing hides the panel the focused control lives in; without a
      // hand-off focus would drop to <body>
      exit.click();

      expect(document.activeElement).toBe(el("replay-btn"));
    });

    it("hands focus on from the airplane, which leaves as it closes", () => {
      activate();
      // Escape on the airplane with its popup closed ends the replay
      const airplane = replayManager.state.airplaneMarker!.getElement();
      if (!airplane.isConnected) document.body.append(airplane);
      airplane.focus();
      expect(document.activeElement).toBe(airplane);

      replayManager.toggleReplay();

      expect(document.activeElement).toBe(el("replay-btn"));
    });

    it("leaves focus the user took elsewhere where it is as it closes", () => {
      activate();
      // The flight profile, say, outside the panel
      const elsewhere = document.createElement("button");
      document.body.append(elsewhere);
      elsewhere.focus();

      replayManager.toggleReplay();

      expect(mockApp.replayActive).toBe(false);
      expect(document.activeElement).toBe(elsewhere);
      elsewhere.remove();
    });

    it("reports the values of the current position", () => {
      activate();

      replayManager.state.currentTime = 65;
      replayManager.updateReplayDisplay();

      expect(el("replay-readout-altitude").textContent).toBe("4,000 ft");
      expect(el("replay-readout-speed").textContent).toBe("120 kt");
      expect(el("replay-readout-track").textContent).toMatch(/^\d{3}°$/);
      // Both unit systems, as on every other surface
      expect(el("replay-readout-altitude-alt").textContent).toBe("1,219 m");
      expect(el("replay-readout-speed-alt").textContent).toBe("222 km/h");
    });

    it("shows placeholders before the first segment", () => {
      activate();

      replayManager.state.currentTime = -1;
      replayManager.updateReplayDisplay();

      expect(el("replay-readout-altitude").textContent).toBe("—");
      expect(el("replay-readout-track").textContent).toBe("—");
    });

    it("builds the chrome once across activations", () => {
      const panel = activate();
      replayManager.toggleReplay();
      replayManager.toggleReplay();

      expect(panel.querySelectorAll(".replay-exit")).toHaveLength(1);
      expect(panel.querySelectorAll(".replay-readout")).toHaveLength(1);
    });
  });

  describe("initializeReplay", () => {
    it("returns false and says the flights are still loading if no data is loaded", () => {
      mockApp.currentData = null;
      mockApp.selectedPathIds = new Set([1]);

      const result = replayManager.initializeReplay();

      expect(result).toBe(false);
      // As every control says it meanwhile, and what to do next
      expect(toastText()).toBe(
        `${STILL_LOADING_MESSAGE}. Try again in a moment.`,
      );
    });

    it("returns false when no path is selected", () => {
      mockApp.selectedPathIds = new Set();

      expect(replayManager.initializeReplay()).toBe(false);
      expect(toastText()).toBeNull();
    });

    it("returns false with a toast if no segments match the selected path", () => {
      mockApp.currentData!.path_info.push({ id: 999 });
      mockApp.selectedPathIds = new Set([999]);

      const result = replayManager.initializeReplay();

      expect(result).toBe(false);
      expect(toastText()).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("filters segments by selected path id", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.currentData!.path_segments.push(
        segmentOf({
          path_id: 2,
          coords: [
            [49.0, 17.0],
            [49.1, 17.1],
          ],
          time: 10,
        }),
      );

      replayManager.initializeReplay();

      expect(replayManager.state.segments.length).toBe(3);
      expect(replayManager.state.segments.every((s) => s.path_id === 1)).toBe(
        true,
      );
    });

    it("ignores segments without timing data", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.currentData!.path_segments.push(
        segmentOf({
          path_id: 1,
          coords: [
            [48.3, 16.3],
            [48.4, 16.4],
          ],
        }),
      );

      replayManager.initializeReplay();

      expect(replayManager.state.segments.length).toBe(3);
    });

    it("sorts segments by time", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.currentData!.path_segments.push(
        segmentOf({
          path_id: 1,
          coords: [
            [48.4, 16.4],
            [48.5, 16.5],
          ],
          altitude_ft: 2000,
          time: -10,
        }),
      );

      replayManager.initializeReplay();

      // In order, at their times from the first fix, which the replay
      // smooths by a hair here (see replayCurve): the first and the last as
      // they are
      expect(replayManager.state.segments.map((s) => s.time)).toEqual([
        0,
        expect.closeTo(10, 1),
        expect.closeTo(70, 1),
        130,
      ]);
    });

    it("calculates the colour ranges from the path's own segments", () => {
      mockApp.selectedPathIds = new Set([1]);
      // Another path's segments must not widen the ranges
      mockApp.currentData = createDataset(
        [
          { id: 1, min_altitude_ft: 3000, max_altitude_ft: 5000 },
          { id: 2, min_altitude_ft: 9000, max_altitude_ft: 9000 },
        ],
        [
          ...createSegments(),
          {
            path_id: 2,
            coords: [
              [49.0, 17.0],
              [49.1, 17.1],
            ],
            altitude_ft: 9000,
            groundspeed_knots: 200,
            time: 0,
          },
        ],
      );

      replayManager.initializeReplay();

      expect(replayManager.state.colorAltRange).toMatchObject({
        min: 3000,
        max: 5000,
      });
      expect(replayManager.state.colorSpeedRange).toMatchObject({
        min: 100,
        max: 130,
      });
      // Spread by rank, as the colour layers draw the flight selected
      expect(replayManager.state.colorAltRange.ranks).toBeDefined();
      expect(replayManager.state.colorSpeedRange.ranks).toBeDefined();
    });

    it("uses the app's airspeed range when the path has no groundspeeds", () => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.currentData = createDataset(
        [{ id: 1 }],
        createSegments().map((seg) => ({ ...seg, groundspeed_knots: 0 })),
      );

      replayManager.initializeReplay();

      expect(replayManager.state.colorSpeedRange).toBe(mockApp.airspeedRange);
    });

    it("sets replayMaxTime from the end of the last segment and updates the slider", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      // The last segment, which starts at 120 s, takes as long as its 13 km
      // at its 130 kt do, held to LAST_SEGMENT_MAX_S (see replayCurve)
      expect(replayManager.state.maxTime).toBe(240);
      const slider = el("replay-slider") as HTMLInputElement;
      expect(slider.max).toBe("240");
      expect(el("replay-slider-end").textContent).toBe("4:00");
      expect(slider.getAttribute("aria-valuetext")).toBe("0:00 of 4:00");
    });

    it("sets the replay layer up with the route and an empty trail", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(replayManager.state.layerActive).toBe(true);
      expect(featuresOf(replaySources(mockApp).route)).toHaveLength(1);
      expect(featuresOf(replaySources(mockApp).trail)).toEqual([]);
    });

    it("creates an accessible airplane marker at the first segment", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      const airplane = replayManager.state.airplaneMarker!;
      expect(airplane.position()).toEqual([48.0, 16.0]);
      const button = airplane.getElement();
      expect(button.tagName).toBe("BUTTON");
      expect(button.getAttribute("aria-label")).toBe("Aircraft position");
      expect(button.classList.contains("replay-airplane-root")).toBe(true);
      expect(button.querySelector(".replay-airplane-icon")).not.toBeNull();
      expect(mockApp.map!.getCanvasContainer().contains(button)).toBe(true);
    });

    it("resets replay state on initialization", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.currentTime = 50;
      replayManager.state.lastDrawnIndex = 5;
      replayManager.state.lastBearing = 180;

      replayManager.initializeReplay();

      expect(replayManager.state.currentTime).toBe(0);
      expect(replayManager.state.lastDrawnIndex).toBe(-1);
      // The initial display update recomputes the heading for the start position
      expect(replayManager.state.lastBearing).not.toBe(180);
      expect(typeof replayManager.state.lastBearing).toBe("number");
    });

    it("sets initial zoom when autoZoom is enabled", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.autoZoom = true;

      replayManager.initializeReplay();

      // The follow zoom in map units (16 under Leaflet); 0.8 s in ms
      expect(mockApp.map!.easeTo).toHaveBeenCalledWith({
        center: [16.0, 48.0],
        zoom: 15,
        pitch: 0,
        duration: 800,
        animate: true,
      });
    });

    it("moves to the start without animation for reduced motion", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();
      replayManager.state.autoZoom = true;
      replayManager.initializeReplay();

      const moves = mockApp.map!.easeTo.mock.calls.map(([options]) => options);
      expect(moves).toHaveLength(2);
      expect(moves[0]).toMatchObject({ center: [16.0, 48.0], animate: false });
      expect(moves[0]).not.toHaveProperty("zoom");
      expect(moves[1]).toMatchObject({
        center: [16.0, 48.0],
        zoom: 15,
        animate: false,
      });
    });

    it("pans to start position without changing zoom when autoZoom is disabled", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.autoZoom = false;

      replayManager.initializeReplay();

      expect(mockApp.map!.easeTo).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.easeTo).toHaveBeenCalledWith({
        center: [16.0, 48.0],
        pitch: 0,
        duration: 800,
        animate: true,
      });
    });

    it("updates altitude and airspeed legends with the replay ranges", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();

      expect(mockApp.layerManager.updateAltitudeLegend).toHaveBeenCalledWith(
        replayManager.state.colorAltRange,
      );
      expect(mockApp.layerManager.updateAirspeedLegend).toHaveBeenCalledWith(
        replayManager.state.colorSpeedRange,
      );
      expect(replayManager.state.colorAltRange).toMatchObject({
        min: 3000,
        max: 5000,
      });
    });

    it("removes old airplane marker if it exists before creating new one", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.initializeReplay();
      const firstMarker = replayManager.state.airplaneMarker!;

      replayManager.initializeReplay();

      expect(
        mockApp.map!.getCanvasContainer().contains(firstMarker.getElement()),
      ).toBe(false);
      expect(replayManager.state.airplaneMarker).not.toBe(firstMarker);
      expect(
        mockApp
          .map!.getCanvasContainer()
          .querySelectorAll(".replay-airplane-root"),
      ).toHaveLength(1);
    });

    it("returns true on success", () => {
      mockApp.selectedPathIds = new Set([1]);

      expect(replayManager.initializeReplay()).toBe(true);
    });
  });

  describe("in the 3D view", () => {
    it("lifts the trail when the replay opens in 3D", () => {
      mockApp.threeDVisible = true;
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      expect(mockApp.replayActive).toBe(true);
      expect(replayManager.state.lifted).toBe(true);
      expect(replayManager.state.smoothed?.chains).toHaveLength(1);
    });

    /** The features of a replay source */
    const featuresOf = (id: string): GeoJSON.Feature[] =>
      (mockApp.map!.source(id).data as GeoJSON.FeatureCollection).features;

    /** Fly the replay to its end and let the trail be written */
    const flyToTheEnd = (): void => {
      replayManager.state.currentTime = replayManager.state.maxTime;
      replayManager.updateReplayDisplay();
      vi.advanceTimersByTime(100);
    };

    it("stands the replayed flight on its own ground", () => {
      mockApp.selectedPathIds = new Set([1]);

      replayManager.toggleReplay();

      const altitudes = replayManager.state.segments.map(
        (s) => s.altitude_ft ?? 0,
      );
      // One height per segment, among the flight's own
      const ground = [...replayManager.state.groundFt];
      expect(ground).toHaveLength(altitudes.length);
      for (const height of ground) {
        expect(height).toBeGreaterThanOrEqual(Math.min(...altitudes));
        expect(height).toBeLessThanOrEqual(Math.max(...altitudes));
      }
    });

    it("lifts the flown trail and puts it back as 3D comes and goes", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      replayManager.state.currentTime = replayManager.state.maxTime;
      replayManager.updateReplayDisplay();
      // The flight's curve, as one chain, flat or lifted
      const curve = replayManager.state.smoothed;
      expect(curve?.chains).toHaveLength(1);

      mockApp.store.set("threeDVisible", true);
      vi.advanceTimersByTime(100);

      expect(replayManager.state.lifted).toBe(true);
      // Worked out once per replay, and the trail's ribbons cut from it
      expect(replayManager.state.smoothed).toBe(curve);
      expect(replayManager.state.trailRuns.length).toBeGreaterThan(0);
      // Written to the ribbons' source, and gone from the lines'
      expect(featuresOf(MAP_SOURCES.replayTrail)).toEqual([]);
      expect(featuresOf(MAP_SOURCES.replayTrailRibbons).length).toBeGreaterThan(
        0,
      );

      mockApp.store.set("threeDVisible", false);
      vi.advanceTimersByTime(100);

      expect(replayManager.state.lifted).toBe(false);
      expect(replayManager.state.smoothed).toBe(curve);
      expect(featuresOf(MAP_SOURCES.replayTrailRibbons)).toEqual([]);
      expect(featuresOf(MAP_SOURCES.replayTrail).length).toBeGreaterThan(0);
    });

    it("stands the flight on the sampled ground while the relief is drawn", () => {
      for (const segment of mockApp.currentData!.path_segments) {
        segment.ground_ft = 123;
      }
      mockApp.threeDVisible = true;
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      flyToTheEnd();
      const flat = replayManager.state.smoothed!;
      const times = replayManager.state.segments.map((s) => s.time);
      expect(replayManager.state.groundFt).not.toContain(123);

      mockApp.store.set("terrainActive", true);
      vi.advanceTimersByTime(100);

      expect([...new Set(replayManager.state.groundFt)]).toEqual([123]);
      expect(replayManager.state.smoothed).not.toBe(flat);
      // Only the heights are worked out anew: the times the curve smoothed
      // from the logged ones stay, and are not smoothed a second time
      expect(replayManager.state.smoothed!.times).toBe(flat.times);
      expect(replayManager.state.segments.map((s) => s.time)).toEqual(times);
      expect(replayManager.state.smoothed!.chains[0]!.heights).not.toEqual(
        flat.chains[0]!.heights,
      );

      // And back off the relief, on the line between the fields again
      mockApp.store.set("terrainActive", false);
      vi.advanceTimersByTime(100);

      expect(replayManager.state.groundFt).not.toContain(123);
      expect(replayManager.state.smoothed!.times).toBe(flat.times);
      expect(replayManager.state.smoothed!.chains[0]!.heights).toEqual(
        flat.chains[0]!.heights,
      );
      expect(featuresOf(MAP_SOURCES.replayTrailRibbons).length).toBeGreaterThan(
        0,
      );
    });

    it("smooths the sampled ground as coarsely as the relief of the level", () => {
      mockApp.currentData!.path_segments.forEach((segment, i) => {
        segment.ground_ft = i % 2 ? 900 : 100;
      });
      mockApp.threeDVisible = true;
      mockApp.store.set("reliefLevel", 11);
      mockApp.store.set("terrainActive", true);
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      flyToTheEnd();
      const spread = (): number =>
        Math.max(...replayManager.state.groundFt) -
        Math.min(...replayManager.state.groundFt);
      expect(spread()).toBe(800);
      const sharp = replayManager.state.smoothed!;

      mockApp.store.set("reliefLevel", 4);
      vi.advanceTimersByTime(100);

      expect(spread()).toBeLessThan(800);
      expect(replayManager.state.smoothed).not.toBe(sharp);
      expect(replayManager.state.smoothed!.times).toBe(sharp.times);
    });

    it("empties the trail's ribbons as the replay closes", () => {
      mockApp.threeDVisible = true;
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      flyToTheEnd();
      expect(featuresOf(MAP_SOURCES.replayTrailRibbons).length).toBeGreaterThan(
        0,
      );

      replayManager.toggleReplay();

      expect(featuresOf(MAP_SOURCES.replayTrailRibbons)).toEqual([]);
    });
  });

  describe("toggleAutoZoom", () => {
    /** A replay in progress, with the aircraft away from the start */
    function replayInProgress(
      position: [number, number] = [47.5, 15.5],
    ): [number, number] {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.initializeReplay();
      replayManager.state.autoZoom = false;
      replayManager.state.airplaneMarker!.setLatLng(position);
      mockApp.map!.easeTo.mockClear();
      return position;
    }

    it("goes to the aircraft at the follow zoom when switched on", () => {
      // The renderer only ever zooms out, so without this the control did
      // nothing to the map until the flight left the viewport
      const [lat, lon] = replayInProgress();

      replayManager.toggleAutoZoom();

      expect(mockApp.map!.easeTo).toHaveBeenCalledWith({
        center: [lon, lat],
        zoom: 15,
        // Flat: nothing lifts the airplane off the ground under it
        offset: [0, 0],
        duration: 800,
        animate: true,
      });
    });

    it("brings the airplane itself to the middle in the 3D view", () => {
      replayInProgress();
      mockApp.map!.jumpTo({ pitch: 60 });
      replayManager.state.airplaneHeightFt = 3000;

      replayManager.toggleAutoZoom();

      // The ground under it goes as far below the middle as the airplane
      // is drawn above it at the follow zoom
      const { offset } = mockApp.map!.easeTo.mock.calls[0]![0] as {
        offset: [number, number];
      };
      expect(offset[0]).toBe(0);
      expect(offset[1]).toBeGreaterThan(100);
    });

    it("arrives where a replay that started with it on would be", () => {
      // Same zoom as initializeReplay uses, so the two agree
      const zoomOfFirstMove = (): unknown =>
        (mockApp.map!.easeTo.mock.calls[0]?.[0] as { zoom?: number }).zoom;

      replayInProgress();
      replayManager.toggleAutoZoom();
      const switchedOn = zoomOfFirstMove();
      expect(switchedOn).toBeTypeOf("number");

      replayManager.state.autoZoom = true;
      mockApp.map!.easeTo.mockClear();
      replayManager.initializeReplay();

      expect(switchedOn).toBe(zoomOfFirstMove());
    });

    it("leaves the map alone when switched off", () => {
      replayInProgress();
      replayManager.toggleAutoZoom();
      mockApp.map!.easeTo.mockClear();

      replayManager.toggleAutoZoom();

      expect(replayManager.state.autoZoom).toBe(false);
      expect(mockApp.map!.easeTo).not.toHaveBeenCalled();
    });

    it("does not animate for reduced motion", () => {
      replayInProgress();
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);

      replayManager.toggleAutoZoom();

      expect(mockApp.map!.easeTo).toHaveBeenCalledWith(
        expect.objectContaining({ zoom: 15, animate: false }),
      );
    });

    it("does nothing without an aircraft on the map", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.state.airplaneMarker = null;

      replayManager.toggleAutoZoom();

      expect(replayManager.state.autoZoom).toBe(true);
      expect(mockApp.map!.easeTo).not.toHaveBeenCalled();
    });
  });

  describe("while replay runs", () => {
    function activate(): void {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
    }

    it("hides the heatmap and the colour layers, and keeps the flags", () => {
      mockApp.altitudeVisible = true;
      expect(mockApp.heatmapLayer.isVisible()).toBe(true);

      activate();

      expect(mockApp.heatmapLayer.isVisible()).toBe(false);
      expect(mockApp.altitudeLayer.isVisible()).toBe(false);
      for (const id of [
        MAP_LAYERS.heat,
        MAP_LAYERS.pathsAltitude,
        MAP_LAYERS.pathsAltitudeSelected,
      ]) {
        expect(mockApp.map!.layer(id).layout["visibility"]).toBe("none");
      }
      expect(mockApp.heatmapVisible).toBe(true);
      expect(mockApp.altitudeVisible).toBe(true);
    });

    it("leaves the airports and the aviation chart the way they are", () => {
      mockApp.aviationVisible = true;

      activate();

      expect(mockApp.airportLayer.isVisible()).toBe(true);
      expect(mockApp.aviationLayer.isVisible()).toBe(true);
    });

    it("disables layer buttons and filters", () => {
      activate();

      expect(isHeld(el("heatmap-btn"))).toBe(true);
      expect(isHeld(el("airports-btn"))).toBe(true);
      expect(isHeld(el("aviation-btn"))).toBe(true);
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(true);
      expect((el("aircraft-select") as HTMLSelectElement).disabled).toBe(true);
    });

    it("disables the controls that would change the selection", () => {
      // Clearing it dimmed the running replay's Stop button and switched
      // the statistics to another view
      activate();

      expect(isHeld(el("isolate-btn"))).toBe(true);
      expect(isHeld(el("selection-clear-btn"))).toBe(true);
      expect(isHeld(el("reset-view-btn"))).toBe(true);

      replayManager.toggleReplay();

      expect(isHeld(el("isolate-btn"))).toBe(false);
      expect(isHeld(el("selection-clear-btn"))).toBe(false);
      expect(isHeld(el("reset-view-btn"))).toBe(false);
    });

    it("gives each control back as it was before the replay", () => {
      // Something else had it off, for a reason of its own
      (el("year-select") as HTMLSelectElement).disabled = true;
      activate();

      replayManager.toggleReplay();

      expect((el("year-select") as HTMLSelectElement).disabled).toBe(true);
      expect(isHeld(el("heatmap-btn"))).toBe(false);
    });

    it("disables Wrapped, which would take the map away from the replay", () => {
      activate();

      expect(isHeld(el("wrapped-btn"))).toBe(true);
    });

    it("lets the stylesheet dim the disabled toggles", () => {
      activate();

      // Nothing inline to beat the disabled look, so no toggle looks live
      expect(isHeld(el("airports-btn"))).toBe(true);
      expect(el("airports-btn").style.opacity).toBe("");
      expect(el("heatmap-btn").style.opacity).toBe("");
    });

    it("does not report the hidden heatmap as on", () => {
      activate();

      const heatmapBtn = el("heatmap-btn");
      expect(heatmapBtn.getAttribute("aria-pressed")).toBe("false");
      expect(heatmapBtn.classList.contains("active")).toBe(false);
      // The user's setting is kept for when replay ends
      expect(mockApp.heatmapVisible).toBe(true);
    });
  });

  describe("closing replay", () => {
    function openAndClose(): void {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      replayManager.toggleReplay();
    }

    it("brings the heatmap back through the data manager when it was on", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      mockApp.dataManager.showHeatmap.mockClear();

      replayManager.toggleReplay();

      expect(mockApp.dataManager.showHeatmap).toHaveBeenCalledTimes(1);
      expect(mockApp.heatmapLayer.isVisible()).toBe(true);
    });

    it("leaves a heatmap that was off hidden", () => {
      mockApp.heatmapVisible = false;

      openAndClose();

      expect(mockApp.heatmapLayer.isVisible()).toBe(false);
      expect(el("heatmap-btn").getAttribute("aria-pressed")).toBe("false");
    });

    it("shows a colour layer that was switched on during the replay", () => {
      mockApp.selectedPathIds = new Set([1]);
      replayManager.toggleReplay();
      // The toggle only records the wish while replay runs
      mockApp.altitudeVisible = true;
      expect(mockApp.altitudeLayer.isVisible()).toBe(false);

      replayManager.toggleReplay();

      expect(mockApp.altitudeLayer.isVisible()).toBe(true);
    });

    it("re-enables disabled buttons and filters", () => {
      openAndClose();

      expect(isHeld(el("heatmap-btn"))).toBe(false);
      expect((el("year-select") as HTMLSelectElement).disabled).toBe(false);
      expect((el("aircraft-select") as HTMLSelectElement).disabled).toBe(false);
      expect(isHeld(el("wrapped-btn"))).toBe(false);
    });

    it("hands the toggles their state back", () => {
      mockApp.airportsVisible = false;

      openAndClose();

      const heatmapBtn = el("heatmap-btn");
      expect(heatmapBtn.getAttribute("aria-pressed")).toBe("true");
      expect(el("airports-btn").getAttribute("aria-pressed")).toBe("false");
      expect(heatmapBtn.style.opacity).toBe("");
      expect(el("airports-btn").style.opacity).toBe("");
    });
  });
});
