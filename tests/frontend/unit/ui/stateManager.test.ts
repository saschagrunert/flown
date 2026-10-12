import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  StateManager,
  sanitizeSavedState,
  storageKey,
} from "../../../../flown/frontend/ui/stateManager";
import { LngLat } from "../../../mocks/maplibre-gl";
import { createDefaultState } from "../../../../flown/frontend/state/store";
import { TOGGLE_KEYS } from "../../../../flown/frontend/state/toggles";
import { createMockApp, asMapApp, type MockApp } from "../../testHelpers";

describe("sanitizeSavedState", () => {
  it("returns an empty object for non-objects", () => {
    expect(sanitizeSavedState(null)).toEqual({});
    expect(sanitizeSavedState("x")).toEqual({});
    expect(sanitizeSavedState(42)).toEqual({});
  });

  it("keeps only known, well-typed fields", () => {
    expect(
      sanitizeSavedState({
        selectedYear: "2025",
        selectedAircraft: 5,
        zoom: "12",
        center: { lat: 50, lng: 8 },
        heatmapVisible: "yes",
        altitudeVisible: true,
        wrappedVisible: false,
        schemaVersion: 3,
        selectedPathIds: [1, "2", NaN, 3],
        unknown: true,
      }),
    ).toEqual({
      selectedYear: "2025",
      center: { lat: 50, lng: 8 },
      altitudeVisible: true,
      wrappedVisible: false,
      selectedPathIds: [1, 3],
    });
  });

  it("keeps only ids a link could carry: whole, not negative, below 2^40", () => {
    expect(
      sanitizeSavedState({
        schemaVersion: 4,
        selectedPathIds: [0, 1.5, -1, 2 ** 40, 2 ** 40 - 1, Infinity],
      }),
    ).toEqual({ selectedPathIds: [0, 2 ** 40 - 1] });
  });

  it("keeps the line of the cross-section as a link writes it, and nothing else", () => {
    expect(
      sanitizeSavedState({ crossSectionLine: "51.5,12.1,51.6,12.3" }),
    ).toEqual({ crossSectionLine: "51.5,12.1,51.6,12.3" });
    for (const crossSectionLine of ["", "51.5,12.1", "a,b,c,d", 51, null]) {
      expect(sanitizeSavedState({ crossSectionLine })).toEqual({});
    }
  });

  it("drops the band of heights an older session saved", () => {
    expect(
      sanitizeSavedState({ threeDVisible: true, heightBand: "500-3000" }),
    ).toEqual({ threeDVisible: true });
  });

  it("drops path ids saved with an older id scheme", () => {
    // Version 2 ids were positions in the export, not content hashes
    expect(
      sanitizeSavedState({ schemaVersion: 2, selectedPathIds: [1, 2] }),
    ).toEqual({});
    expect(sanitizeSavedState({ selectedPathIds: [1, 2] })).toEqual({});
  });

  it("rejects non-finite numbers", () => {
    expect(
      sanitizeSavedState({ zoom: Infinity, center: { lat: NaN, lng: 8 } }),
    ).toEqual({});
  });

  it("drops a centre off the globe and keeps the rest", () => {
    // MapLibre throws for a latitude past the poles, and would on every
    // reload: nothing clears an entry the map never got to overwrite
    for (const center of [
      { lat: 91, lng: 8 },
      { lat: -90.5, lng: 8 },
      { lat: 50, lng: Infinity },
    ]) {
      expect(sanitizeSavedState({ zoom: 7, center })).toEqual({ zoom: 7 });
    }
    // Builds that saved the map's centre as it was left a longitude like
    // this behind after a pan across the antimeridian: a place, not damage
    expect(
      sanitizeSavedState({ center: { lat: 50, lng: 190 } }).center,
    ).toEqual({ lat: 50, lng: -170 });
    expect(
      sanitizeSavedState({ center: { lat: -90, lng: 180 } }).center,
    ).toEqual({ lat: -90, lng: 180 });
  });

  it("keeps a bearing, a pitch and the globe, held to what the map takes", () => {
    expect(
      sanitizeSavedState({ bearing: -40.5, pitch: 35, globeVisible: true }),
    ).toEqual({ bearing: -40.5, pitch: 35, globeVisible: true });
    // A bearing is the same direction a full turn on, a pitch is not
    expect(sanitizeSavedState({ bearing: 270, pitch: 89 })).toEqual({
      bearing: -90,
      pitch: 85,
    });
    expect(sanitizeSavedState({ bearing: -540, pitch: -5 })).toEqual({
      bearing: -180,
      pitch: 0,
    });
  });

  it("drops an orientation that is no number and keeps the rest", () => {
    expect(
      sanitizeSavedState({
        zoom: 7,
        bearing: "90",
        pitch: NaN,
        globeVisible: "yes",
      }),
    ).toEqual({ zoom: 7 });
    expect(sanitizeSavedState({ bearing: Infinity, pitch: null })).toEqual({});
  });

  it("reads a state saved before the map could turn as it always did", () => {
    const saved = sanitizeSavedState({
      schemaVersion: 4,
      center: { lat: 50, lng: 8 },
      zoom: 10,
      heatmapVisible: true,
    });

    expect(saved).toEqual({
      center: { lat: 50, lng: 8 },
      zoom: 10,
      heatmapVisible: true,
    });
    for (const key of ["bearing", "pitch", "globeVisible"]) {
      expect(saved).not.toHaveProperty(key);
    }
  });
});

describe("storageKey", () => {
  it("keys the state by the directory of the page", () => {
    expect(storageKey("/a/")).toBe("flown-state:/a/");
    // The page itself and its folder are the same map
    expect(storageKey("/a/index.html")).toBe("flown-state:/a/");
    expect(storageKey("/b/")).not.toBe(storageKey("/a/"));
  });

  it("keeps the original key for a map at the root of its origin", () => {
    expect(storageKey("/")).toBe("flown-state");
    expect(storageKey("/index.html")).toBe("flown-state");
  });
});

describe("StateManager", () => {
  const DEFAULTS = createDefaultState();
  let stateManager: StateManager;
  let mockApp: MockApp;
  let mockLocalStorage: { [key: string]: string };

  // Redefining window.location makes the property non-configurable for the
  // rest of the worker, which rules out sharing one jsdom between files. The
  // real history API moves the location instead; the tests below stub
  // history.replaceState to observe what the manager writes, so the original
  // is captured here before that happens.
  const navigate = window.history.replaceState.bind(window.history);
  function setLocation(search: string, pathname = "/"): void {
    navigate(null, "", pathname + search);
  }

  /** Storage key of the map the tests run at, the root of the origin */
  const KEY = "flown-state";

  beforeEach(() => {
    mockLocalStorage = {};
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => mockLocalStorage[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        mockLocalStorage[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete mockLocalStorage[key];
      }),
      clear: vi.fn(),
      length: 0,
      key: vi.fn(),
    });
    vi.stubGlobal("history", { replaceState: vi.fn() });
    setLocation("");

    mockApp = createMockApp();
    mockApp.map!.getCenter.mockReturnValue(new LngLat(8.0, 50.0));
    // The map's own unit; the state carries one more (see ZOOM_OFFSET)
    mockApp.map!.getZoom.mockReturnValue(9);

    stateManager = new StateManager(asMapApp(mockApp));
  });

  afterEach(() => {
    vi.useRealTimers();
    setLocation("");
  });

  function savedState(): Record<string, unknown> {
    return JSON.parse(mockLocalStorage[KEY]!) as Record<string, unknown>;
  }

  describe("store subscriptions", () => {
    it("subscribes to all persisted store keys on construction", () => {
      const subscribe = vi.fn(() => () => {});
      const app = createMockApp();
      vi.spyOn(app.store, "subscribe").mockImplementation(subscribe);

      new StateManager(asMapApp(app));

      const keys = subscribe.mock.calls.map((c) => (c as unknown[])[0]);
      expect(keys).toEqual([
        "selectedYear",
        "selectedAircraft",
        "selectedPathIds",
        "heatmapVisible",
        "airportsVisible",
        "altitudeVisible",
        "airspeedVisible",
        "aviationVisible",
        "globeVisible",
        "threeDVisible",
        "satelliteVisible",
        "isolateSelection",
        "statsPanelVisible",
        "flightListVisible",
        "wrappedVisible",
        "crossSectionLine",
      ]);
    });

    it("auto-saves (debounced) when a subscribed key changes", () => {
      vi.useFakeTimers();
      const saveSpy = vi.spyOn(stateManager, "saveMapState");

      mockApp.selectedYear = "2025";

      expect(saveSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });

    it("coalesces multiple key changes into one save", () => {
      vi.useFakeTimers();
      const saveSpy = vi.spyOn(stateManager, "saveMapState");

      mockApp.selectedYear = "2025";
      mockApp.heatmapVisible = false;
      mockApp.store.set("wrappedVisible", true);
      vi.advanceTimersByTime(300);

      expect(saveSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("flush", () => {
    it("saves at once and drops the pending debounced save", () => {
      vi.useFakeTimers();
      stateManager.scheduleSave();
      expect(mockLocalStorage[KEY]).toBeUndefined();

      stateManager.flush();

      expect(mockLocalStorage[KEY]).toBeDefined();
      const saveSpy = vi.spyOn(stateManager, "saveMapState");
      vi.advanceTimersByTime(1000);
      expect(saveSpy).not.toHaveBeenCalled();
    });

    it("saves even when nothing was scheduled", () => {
      stateManager.flush();

      expect(mockLocalStorage[KEY]).toBeDefined();
    });

    it("saves a change still waiting for the debounce when the page goes away", () => {
      vi.useFakeTimers();
      mockApp.selectedYear = "2025";
      expect(mockLocalStorage[KEY]).toBeUndefined();

      window.dispatchEvent(new Event("pagehide"));

      expect(JSON.parse(mockLocalStorage[KEY]!)).toMatchObject({
        selectedYear: "2025",
      });
    });

    it("does not save on pagehide when nothing is pending", () => {
      const saveSpy = vi.spyOn(stateManager, "saveMapState");

      window.dispatchEvent(new Event("pagehide"));

      expect(saveSpy).not.toHaveBeenCalled();
    });
  });

  describe("teardown", () => {
    it("stops listening for pagehide once the app is gone", () => {
      const lifetime = new AbortController();
      const app = createMockApp({ signal: lifetime.signal });
      const manager = new StateManager(asMapApp(app));
      manager.scheduleSave();
      const flush = vi.spyOn(manager, "flush");

      lifetime.abort();
      window.dispatchEvent(new Event("pagehide"));

      expect(flush).not.toHaveBeenCalled();
      manager.cancelSave();
    });

    it("drops a pending save on cancelSave", () => {
      vi.useFakeTimers();
      const saveSpy = vi.spyOn(stateManager, "saveMapState");
      mockApp.selectedYear = "2025";

      stateManager.cancelSave();
      vi.advanceTimersByTime(1000);

      expect(saveSpy).not.toHaveBeenCalled();
    });
  });

  describe("panels a restored state reopens later", () => {
    beforeEach(() => {
      // Statistics and Wrapped open in the link: v flags 6 and 7
      setLocation("?y=2024&v=100101100&lat=50&lng=8&z=10");
      mockApp.savedState = stateManager.loadState();
    });

    it("saves them as open while the app has not reopened them yet", () => {
      // The restore batch schedules a save long before the data is in
      mockApp.selectedYear = "2024";

      stateManager.flush();

      expect(savedState()).toMatchObject({
        statsPanelVisible: true,
        wrappedVisible: true,
      });
    });

    it("hands over to the store once the panel has been reopened", () => {
      mockApp.store.set("statsPanelVisible", true);
      // The user closes it again right away
      mockApp.store.set("statsPanelVisible", false);

      stateManager.flush();

      expect(savedState()["statsPanelVisible"]).toBe(false);
      expect(savedState()["wrappedVisible"]).toBe(true);
    });

    it("hands over to the store once the app gave up reopening one", () => {
      delete mockApp.savedState!.wrappedVisible;

      stateManager.flush();

      expect(savedState()["wrappedVisible"]).toBe(false);
    });

    it("writes the store without a restored state", () => {
      mockApp.savedState = null;

      stateManager.flush();

      expect(savedState()).toMatchObject({
        statsPanelVisible: false,
        wrappedVisible: false,
      });
    });
  });

  describe("a visit from a link to shared flights", () => {
    it("saves nothing for the next visit while it shares the sender's flights, and from the end of share mode on", () => {
      mockApp.selectedPathIds = new Set([7]);
      mockApp.isolateSelection = true;
      stateManager.visiting = true;

      const shared = stateManager.saveMapState();

      expect(localStorage.setItem).not.toHaveBeenCalled();
      // The link follows the state as ever, and Copy link gets it
      expect(history.replaceState).toHaveBeenCalledTimes(1);
      expect(shared).toMatchObject({
        isolateSelection: true,
        selectedPathIds: [7],
      });

      // Out of share mode the flights are the visitor's own, and so they
      // stay, should they share some again
      mockApp.isolateSelection = false;
      stateManager.saveMapState();
      expect(savedState()["selectedPathIds"]).toEqual([7]);
      mockApp.isolateSelection = true;
      stateManager.saveMapState();
      expect(savedState()["isolateSelection"]).toBe(true);
      expect(stateManager.visiting).toBe(false);
    });
  });

  describe("saveMapState", () => {
    it("wraps a centre panned past the antimeridian into the link", () => {
      // The map reports the unwrapped longitude after a pan across 180
      mockApp.map!.getCenter.mockReturnValue(new LngLat(190, -17));

      stateManager.saveMapState();

      expect(savedState()["center"]).toEqual({ lat: -17, lng: -170 });
      const url = String(vi.mocked(history.replaceState).mock.calls[0]![2]);
      expect(url).toContain("lng=-170.000000");
    });

    it("wraps a centre panned past it to the west as well", () => {
      mockApp.map!.getCenter.mockReturnValue(new LngLat(-185.5, 60));

      stateManager.saveMapState();

      expect(savedState()["center"]).toEqual({ lat: 60, lng: 174.5 });
    });

    it("saves a centre inside the range exactly as the map reports it", () => {
      // The wrap is arithmetic and would add rounding noise to any value
      mockApp.map!.getCenter.mockReturnValue(new LngLat(8.123456789, 50.1));

      stateManager.saveMapState();

      expect(savedState()["center"]).toEqual({ lat: 50.1, lng: 8.123456789 });
    });

    it("saves the zoom in the unit links have always carried", () => {
      // One above the map's, so a link from before the map library changed
      // still shows the same area
      mockApp.map!.getZoom.mockReturnValue(12);

      stateManager.saveMapState();

      expect(savedState()["zoom"]).toBe(13);
      const url = String(vi.mocked(history.replaceState).mock.calls[0]![2]);
      expect(url).toContain("z=13.00");
    });

    it("saves the user's own view while Wrapped has the map fitted", () => {
      // With the fitted overview saved, a reload or a shared link landed on
      // the overview once the dialog was closed
      mockApp.wrappedManager.userMapView.mockReturnValue({
        center: { lat: 48.1, lng: 11.6 },
        zoom: 12,
        bearing: 25,
        pitch: 40,
      });

      stateManager.saveMapState();

      // The overview itself is north up and flat
      expect(savedState()).toMatchObject({
        center: { lat: 48.1, lng: 11.6 },
        zoom: 13,
        bearing: 25,
        pitch: 40,
      });
      expect(mockApp.map!.getCenter).not.toHaveBeenCalled();
      expect(mockApp.map!.getBearing).not.toHaveBeenCalled();
    });

    it("saves the user's globe and 3D switches while Wrapped's intro has changed them", () => {
      // The intro turns the globe on for as long as the dialog is open; a
      // reload or a shared link must not keep it
      mockApp.store.set("globeVisible", true);
      mockApp.store.set("forcedHeatCloud", true);
      mockApp.wrappedManager.userMapView.mockReturnValue({
        center: { lat: 48.1, lng: 11.6 },
        zoom: 12,
        bearing: 0,
        pitch: 0,
        globeVisible: false,
        threeDVisible: true,
      });

      stateManager.saveMapState();

      expect(savedState()).toMatchObject({
        globeVisible: false,
        threeDVisible: true,
      });
      expect(savedState()).not.toHaveProperty("forcedHeatCloud");
      const url = String(vi.mocked(history.replaceState).mock.calls[0]![2]);
      const params = new URLSearchParams(url);
      expect(params.has("g")).toBe(false);
      expect(params.get("d")).toBe("1");
    });

    it("saves the line of the cross-section, and carries it in the link", () => {
      mockApp.store.set("crossSectionLine", "51.5,12.1,51.6,12.3");

      stateManager.saveMapState();

      expect(savedState()).toMatchObject({
        crossSectionLine: "51.5,12.1,51.6,12.3",
      });
      const url = String(vi.mocked(history.replaceState).mock.calls[0]![2]);
      expect(new URLSearchParams(url).get("x")).toBe("51.5,12.1,51.6,12.3");
    });

    it("saves the view and the switches the hotspot tour started from while it runs", () => {
      // The tour turns the 3D view and the heatmap on and flies the map
      // from place to place; a reload or a link keeps the user's
      mockApp.store.set("threeDVisible", true);
      mockApp.store.set("heatmapVisible", true);
      mockApp.tourView = {
        center: { lat: 51.2, lng: 12.4 },
        zoom: 9,
        bearing: 10,
        pitch: 0,
        globeVisible: false,
        threeDVisible: false,
        heatmapVisible: false,
      };

      stateManager.saveMapState();

      expect(savedState()).toMatchObject({
        center: { lat: 51.2, lng: 12.4 },
        zoom: 10,
        bearing: 10,
        threeDVisible: false,
        heatmapVisible: false,
      });
      expect(mockApp.map!.getCenter).not.toHaveBeenCalled();
    });

    it("saves the user's own view while the replay's chase view flies the map", () => {
      // A camera half way along a flight, tilted and turned with it, is no
      // view to come back to
      mockApp.replayManager.userMapView.mockReturnValue({
        center: { lat: 51.5, lng: 12.1 },
        zoom: 10,
        bearing: 0,
        pitch: 0,
      });

      stateManager.saveMapState();

      expect(savedState()).toMatchObject({
        center: { lat: 51.5, lng: 12.1 },
        zoom: 11,
        bearing: 0,
        pitch: 0,
      });
      expect(mockApp.map!.getPitch).not.toHaveBeenCalled();
    });

    it("saves the 3D view and links it", () => {
      mockApp.store.set("threeDVisible", true);

      stateManager.saveMapState();

      expect(savedState()).toMatchObject({ threeDVisible: true });
      const url = String(vi.mocked(history.replaceState).mock.calls[0]![2]);
      expect(url).toContain("&d=1");
    });

    it("saves the bearing, the pitch and the globe, and links them", () => {
      mockApp.map!.jumpTo({ bearing: -40.26, pitch: 35 });
      mockApp.store.set("globeVisible", true);

      stateManager.saveMapState();

      expect(savedState()).toMatchObject({
        bearing: -40.26,
        pitch: 35,
        globeVisible: true,
      });
      const url = String(vi.mocked(history.replaceState).mock.calls[0]![2]);
      expect(url).toContain("&b=-40.3&t=35&g=1");
    });

    it("saves and links the tilt from before the replay of every flight tilted the map", () => {
      mockApp.map!.jumpTo({ pitch: 50 });
      mockApp.replayState.pitchBefore = 0;

      stateManager.saveMapState();

      expect(savedState()).toMatchObject({ pitch: 0 });
      const url = String(vi.mocked(history.replaceState).mock.calls[0]![2]);
      expect(url).not.toMatch(/[?&]t=/);
    });

    it("saves a reset view as a first visit's and links it without the flags", () => {
      // What MapApp.resetView leaves behind: the flags a session keeps back
      // at their defaults, the newest year and the fitted view
      vi.useFakeTimers();
      mockApp.store.batch(() => {
        for (const key of TOGGLE_KEYS) mockApp.store.set(key, !DEFAULTS[key]);
        mockApp.selectedAircraft = "D-ABCD";
      });
      mockApp.map!.jumpTo({ bearing: 30, pitch: 40 });
      vi.advanceTimersByTime(300);
      vi.mocked(history.replaceState).mockClear();

      mockApp.store.batch(() => {
        for (const key of TOGGLE_KEYS) mockApp.store.set(key, DEFAULTS[key]);
        mockApp.selectedAircraft = "all";
        mockApp.selectedYear = "2025";
      });
      mockApp.map!.jumpTo({ bearing: 0, pitch: 0 });
      vi.advanceTimersByTime(300);

      expect(savedState()).toMatchObject({
        ...Object.fromEntries(TOGGLE_KEYS.map((key) => [key, DEFAULTS[key]])),
        selectedYear: "2025",
        selectedAircraft: "all",
        bearing: 0,
        pitch: 0,
      });
      expect(history.replaceState).toHaveBeenCalledWith(
        null,
        "",
        "?y=2025&lat=50.000000&lng=8.000000&z=10.00",
      );
    });

    it("saves current state to localStorage and the URL", () => {
      mockApp.selectedYear = "2025";
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);

      stateManager.saveMapState();

      expect(savedState()).toEqual({
        schemaVersion: 4,
        center: { lat: 50, lng: 8 },
        zoom: 10,
        bearing: 0,
        pitch: 0,
        globeVisible: false,
        threeDVisible: false,
        satelliteVisible: false,
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        selectedYear: "2025",
        selectedAircraft: "all",
        selectedPathIds: [1, 2],
        statsPanelVisible: false,
        flightListVisible: false,
        wrappedVisible: false,
        isolateSelection: false,
        crossSectionLine: "",
      });
      // North up, flat and Mercator are the defaults and stay out of the link
      expect(history.replaceState).toHaveBeenCalledWith(
        null,
        "",
        "?y=2025&p=1%2C2&sv=4&lat=50.000000&lng=8.000000&z=10.00",
      );
    });

    it("reads stats panel visibility from the store", () => {
      mockApp.store.set("statsPanelVisible", true);

      stateManager.saveMapState();

      expect(savedState()["statsPanelVisible"]).toBe(true);
    });

    it("reads wrapped visibility from the store when set", () => {
      mockApp.store.set("wrappedVisible", true);

      stateManager.saveMapState();

      expect(savedState()["wrappedVisible"]).toBe(true);
    });

    it("saves Wrapped as closed before the Wrapped manager published it", () => {
      expect(mockApp.store.get("wrappedVisible")).toBe(false);

      stateManager.saveMapState();

      expect(savedState()["wrappedVisible"]).toBe(false);
    });

    it("saves under the key of the page's directory", () => {
      setLocation("", "/b/index.html");

      stateManager.saveMapState();

      expect(Object.keys(mockLocalStorage)).toEqual(["flown-state:/b/"]);
    });

    it("does nothing if map is not initialized", () => {
      mockApp.map = null;

      stateManager.saveMapState();

      expect(localStorage.setItem).not.toHaveBeenCalled();
      expect(history.replaceState).not.toHaveBeenCalled();
    });

    it("handles localStorage errors gracefully", () => {
      vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
        throw new Error("localStorage is full");
      });

      expect(() => stateManager.saveMapState()).not.toThrow();
      expect(history.replaceState).toHaveBeenCalled();
    });
  });

  describe("loadMapState", () => {
    it("loads saved state from localStorage", () => {
      const state = {
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        heatmapVisible: false,
        selectedYear: "2024",
        selectedPathIds: [1, 2],
      };
      // schemaVersion is a storage detail and is not returned
      mockLocalStorage[KEY] = JSON.stringify({
        schemaVersion: 3,
        ...state,
      });

      expect(stateManager.loadMapState()).toEqual(state);
    });

    it("drops unknown or invalid fields", () => {
      mockLocalStorage[KEY] = JSON.stringify({
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        heatmapVisible: "true",
        evil: "<script>",
      });

      expect(stateManager.loadMapState()).toEqual({
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
      });
    });

    it("returns null if no saved state exists", () => {
      expect(stateManager.loadMapState()).toBeNull();
    });

    it("returns null if saved state is corrupted", () => {
      mockLocalStorage[KEY] = "{not json";
      expect(stateManager.loadMapState()).toBeNull();
    });

    it("keeps the rest of the state when the view is unusable", () => {
      // The map then opens on the bounds, as it does without saved state
      mockLocalStorage[KEY] = JSON.stringify({
        schemaVersion: 3,
        center: { lat: 95, lng: 11 },
        zoom: 12,
        selectedYear: "2024",
        selectedPathIds: [1, 2],
        airportsVisible: false,
      });
      expect(stateManager.loadMapState()).toEqual({
        zoom: 12,
        selectedYear: "2024",
        selectedPathIds: [1, 2],
        airportsVisible: false,
      });
    });

    it("wraps a longitude saved from a repeated world", () => {
      mockLocalStorage[KEY] = JSON.stringify({
        center: { lat: 48, lng: 190 },
        zoom: 12,
        selectedYear: "2024",
      });
      expect(stateManager.loadMapState()).toEqual({
        center: { lat: 48, lng: -170 },
        zoom: 12,
        selectedYear: "2024",
      });
    });

    it("returns null if nothing of the saved state is usable", () => {
      mockLocalStorage[KEY] = JSON.stringify({ evil: "<script>", zoom: "7" });
      expect(stateManager.loadMapState()).toBeNull();
    });

    it("handles localStorage errors gracefully", () => {
      vi.spyOn(localStorage, "getItem").mockImplementationOnce(() => {
        throw new Error("denied");
      });
      expect(stateManager.loadMapState()).toBeNull();
    });
  });

  describe("updateUrl", () => {
    it("never writes the mark of the intro of shared flights back", () => {
      // A link opened with it, if the app had not taken it off yet
      setLocation("?y=2025&p=1&sv=4&v=100100001&i=1");
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.isolateSelection = true;

      stateManager.saveMapState();

      const link = String(vi.mocked(history.replaceState).mock.calls[0]![2]);
      expect(new URLSearchParams(link.slice(1)).has("i")).toBe(false);
      expect(savedState()).not.toHaveProperty("i");
      expect(JSON.stringify(savedState())).not.toMatch(/intro/i);
    });

    it("updates browser URL with encoded state", () => {
      stateManager.updateUrl({ selectedYear: "2025", zoom: 9 });

      expect(history.replaceState).toHaveBeenCalledWith(
        null,
        "",
        "?y=2025&z=9.00",
      );
    });

    it("falls back to the pathname when no params are produced", () => {
      stateManager.updateUrl({});

      expect(history.replaceState).toHaveBeenCalledWith(null, "", "/");
    });

    it("handles history API errors gracefully", () => {
      vi.mocked(history.replaceState).mockImplementationOnce(() => {
        throw new Error("nope");
      });

      expect(() =>
        stateManager.updateUrl({ selectedYear: "2025" }),
      ).not.toThrow();
    });
  });

  describe("loadState", () => {
    it("prioritizes URL parameters over localStorage", () => {
      mockLocalStorage[KEY] = JSON.stringify({
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        selectedYear: "2024",
      });
      setLocation("?y=2025&a=D-ABCD");

      expect(stateManager.loadState()).toEqual({
        selectedYear: "2025",
        selectedAircraft: "D-ABCD",
      });
    });

    it("falls back to localStorage if no URL params", () => {
      const state = {
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        selectedYear: "2024",
        selectedAircraft: "D-EFGH",
        selectedPathIds: [],
        statsPanelVisible: false,
      };
      mockLocalStorage[KEY] = JSON.stringify({
        schemaVersion: 3,
        ...state,
      });

      expect(stateManager.loadState()).toEqual(state);
    });

    it("keeps the satellite imagery through the saved state and the link", () => {
      mockApp.store.set("satelliteVisible", true);
      stateManager.saveMapState();

      expect(savedState()["satelliteVisible"]).toBe(true);
      const link = vi.mocked(history.replaceState).mock.calls.at(-1)![2];
      expect(new URLSearchParams(link as string).get("s")).toBe("1");
      // From this device, and from the link alone
      expect(stateManager.loadState()).toMatchObject({
        satelliteVisible: true,
      });
      mockLocalStorage = {};
      setLocation(link as string);
      expect(stateManager.loadState()).toMatchObject({
        satelliteVisible: true,
      });
      // Anything but a flag is dropped
      expect(sanitizeSavedState({ satelliteVisible: "1" })).toEqual({});
    });

    it("returns null if no state is available", () => {
      expect(stateManager.loadState()).toBeNull();
    });

    it("does not restore the state of another map on the same origin (regression)", () => {
      mockLocalStorage["flown-state:/a/"] = JSON.stringify({
        schemaVersion: 3,
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        selectedYear: "2024",
        selectedPathIds: [3],
      });
      setLocation("", "/b/");

      expect(stateManager.loadState()).toBeNull();

      setLocation("", "/a/index.html");
      expect(stateManager.loadState()).toMatchObject({ selectedYear: "2024" });
    });

    it("leaves the state of the map at the root to that map", () => {
      // Releases before the per-directory key saved every map under the
      // plain key; that is the root map's key now, and no other adopts it
      mockLocalStorage[KEY] = JSON.stringify({
        schemaVersion: 3,
        center: { lat: 48.0, lng: 11.0 },
        zoom: 12,
        selectedYear: "2024",
      });
      setLocation("", "/flown/");

      expect(stateManager.loadState()).toBeNull();
      expect(Object.keys(mockLocalStorage)).toEqual([KEY]);
    });

    it("parses the full URL state including visibility flags", () => {
      setLocation("?y=2025&p=1,2&sv=3&v=011010111&lat=50.5&lng=8.5&z=12.25");

      expect(stateManager.loadState()).toEqual({
        selectedYear: "2025",
        selectedPathIds: [1, 2],
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: true,
        airportsVisible: false,
        aviationVisible: true,
        statsPanelVisible: false,
        wrappedVisible: true,
        // The legacy control-visibility flag is parsed and then dropped
        isolateSelection: true,
        center: { lat: 50.5, lng: 8.5 },
        zoom: 12.25,
      });
    });

    it("falls back to localStorage when URL params contain no state", () => {
      setLocation("?debug=true");
      mockLocalStorage[KEY] = JSON.stringify({
        center: { lat: 1, lng: 2 },
        zoom: 3,
      });

      expect(stateManager.loadState()).toEqual({
        center: { lat: 1, lng: 2 },
        zoom: 3,
      });
    });
  });
});
