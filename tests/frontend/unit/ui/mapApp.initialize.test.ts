/**
 * MapApp.initialize: data loading, year selection and restored state.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createDefaultState } from "../../../../kml_heatmap/frontend/state/store";
import {
  MAP_STALL_MESSAGE,
  MAP_STALL_MS,
  MapApp,
  RESET_VIEW_DONE_MESSAGE,
  startViewPadding,
} from "../../../../kml_heatmap/frontend/mapApp";
import { resetSafeArea } from "../../../../kml_heatmap/frontend/utils/safeArea";
import { measureSafeArea } from "../../testHelpers";
import {
  Marker as MockMarker,
  resetMapLibreMock,
  type Map as MockMap,
} from "../../../mocks/maplibre-gl";
import {
  loadFeatures,
  loadWrapped,
} from "../../../../kml_heatmap/frontend/services/featureLoader";
import * as motion from "../../../../kml_heatmap/frontend/utils/motion";
import { INPUT_EVENTS } from "../../../../kml_heatmap/frontend/utils/constants";
import * as toast from "../../../../kml_heatmap/frontend/utils/toast";

// The instances the mocked manager constructors hand out live in the setup
// module, which is loaded before the mocks are registered
const m = await vi.hoisted(() => import("./mapAppTestSetup"));

vi.mock("../../../../kml_heatmap/frontend/utils/logger", () =>
  m.modules.logger(),
);
vi.mock("../../../../kml_heatmap/frontend/utils/domCache", () =>
  m.modules.domCache(),
);
vi.mock("../../../../kml_heatmap/frontend/utils/toast", () =>
  m.modules.toast(),
);
vi.mock("../../../../kml_heatmap/frontend/ui/mobileBar", () =>
  m.modules.mobileBar(),
);
vi.mock("../../../../kml_heatmap/frontend/ui/dataManager", () =>
  m.modules.dataManager(),
);
vi.mock("../../../../kml_heatmap/frontend/ui/filterManager", () =>
  m.modules.filterManager(),
);
vi.mock("../../../../kml_heatmap/frontend/ui/airportManager", () =>
  m.modules.airportManager(),
);
vi.mock("../../../../kml_heatmap/frontend/ui/replayManager", () =>
  m.modules.replayManager(),
);
vi.mock("../../../../kml_heatmap/frontend/ui/layerManager", () =>
  m.modules.layerManager(),
);
vi.mock("../../../../kml_heatmap/frontend/ui/stateManager", () =>
  m.modules.stateManager(),
);
vi.mock("../../../../kml_heatmap/frontend/ui/wrappedManager", () =>
  m.modules.wrappedManager(),
);
vi.mock("../../../../kml_heatmap/frontend/services/featureLoader", () =>
  m.modules.featureLoader(),
);
vi.mock("../../../../kml_heatmap/frontend/ui/uiToggles", () =>
  m.modules.uiToggles(),
);
vi.mock("../../../../kml_heatmap/frontend/ui/pathSelection", () =>
  m.modules.pathSelection(),
);
/** What the start view keeps off the edges with no panels over them */
const START_PADDING = { top: 48, right: 48, bottom: 48, left: 48 };

const toastMock = vi.mocked(toast);

const {
  createApp,
  defaultAirports,
  defaultData,
  defaultMetadata,
  initializeApp,
  mockAirportManagerInstance,
  mockDataManagerInstance,
  mockFilterManagerInstance,
  mockLayerManagerInstance,
  mockMap,
  mockPathSelectionInstance,
  mockReplayManagerInstance,
  mockStateManagerInstance,
  mockStatsManagerInstance,
  mockWrappedManagerInstance,
  resetManagerMocks,
  setupDOM,
  yearSelect,
} = m;

function visibility(app: MapApp, id: string): unknown {
  return mockMap(app).layer(id).layout["visibility"];
}

describe("MapApp.initialize", () => {
  let app: MapApp;

  beforeEach(() => {
    resetManagerMocks();
    m.mobileBar.mountFor.mockReturnValue(null);
    setupDOM();
    app = createApp(MapApp);
  });

  afterEach(() => {
    app.destroy();
    document.body.innerHTML = "";
    vi.useRealTimers();
    resetMapLibreMock();
  });

  describe("a map that does not draw", () => {
    it("says so once the map has not gone idle in time", async () => {
      vi.useFakeTimers();
      await initializeApp(app);
      // The worker never answered: the sources are not loaded
      mockMap(app).loaded.mockReturnValue(false);

      vi.advanceTimersByTime(MAP_STALL_MS - 1);
      expect(toastMock.showToast).not.toHaveBeenCalledWith(
        MAP_STALL_MESSAGE,
        "error",
      );
      vi.advanceTimersByTime(1);
      expect(toastMock.showToast).toHaveBeenCalledWith(
        MAP_STALL_MESSAGE,
        "error",
      );
    });

    it("takes the notice away once the map has drawn after all", async () => {
      vi.useFakeTimers();
      await initializeApp(app);
      mockMap(app).loaded.mockReturnValue(false);
      vi.advanceTimersByTime(MAP_STALL_MS);
      toastMock.dismissToast.mockClear();

      // An error stays until dismissed, and this one is no longer true
      mockMap(app).emit("idle");

      expect(toastMock.dismissToast).toHaveBeenCalledWith(MAP_STALL_MESSAGE);
    });

    it("says nothing once the map has drawn", async () => {
      vi.useFakeTimers();
      await initializeApp(app);
      mockMap(app).loaded.mockReturnValue(false);
      mockMap(app).emit("idle");

      vi.advanceTimersByTime(MAP_STALL_MS);
      expect(toastMock.showToast).not.toHaveBeenCalledWith(
        MAP_STALL_MESSAGE,
        "error",
      );
    });

    it("says nothing for a map that has all it needs, or is gone", async () => {
      vi.useFakeTimers();
      await initializeApp(app);
      // No idle since the data came, but nothing is missing either
      vi.advanceTimersByTime(MAP_STALL_MS);

      const other = createApp(MapApp);
      await initializeApp(other);
      mockMap(other).loaded.mockReturnValue(false);
      other.destroy();
      vi.advanceTimersByTime(MAP_STALL_MS);

      expect(toastMock.showToast).not.toHaveBeenCalledWith(
        MAP_STALL_MESSAGE,
        "error",
      );
    });
  });

  describe("the intro of a link to shared flights", () => {
    const original = window.location.pathname + window.location.search;
    afterEach(() => {
      window.history.replaceState(null, "", original);
      m.playShareIntro.mockClear();
      vi.restoreAllMocks();
    });

    /**
     * The signals of the listeners for input the app puts on the window
     * before the intro, from here on: aborted, they are removed
     */
    function inputListeners(): () => (AbortSignal | undefined)[] {
      const add = vi.spyOn(window, "addEventListener");
      return () =>
        add.mock.calls
          .filter(
            ([type, , options]) =>
              (INPUT_EVENTS as readonly string[]).includes(type) &&
              typeof options === "object" &&
              options.capture === true,
          )
          .map(([, , options]) => (options as AddEventListenerOptions).signal);
    }

    it("plays once the flights are in, the mark taken off the link at once", async () => {
      window.history.replaceState(null, "", "/?y=2025&p=a5&sv=4&i=1");

      let restoredFrom = "";
      mockStateManagerInstance.loadState.mockImplementation(() => {
        restoredFrom = window.location.search;
        return null;
      });

      const listeners = inputListeners();
      await initializeApp(app);

      // Before the state is read, let alone saved 300 ms on
      expect(restoredFrom).toBe("?y=2025&p=a5&sv=4");
      expect(window.location.search).toBe("?y=2025&p=a5&sv=4");
      await vi.waitFor(() =>
        expect(m.playShareIntro).toHaveBeenCalledWith(app),
      );
      // Listened for input until it started, and no longer
      expect(listeners()).toHaveLength(INPUT_EVENTS.length);
      expect(listeners().every((signal) => signal?.aborted)).toBe(true);
    });

    it("reads a shared link's token as the link it packs", async () => {
      // y=2025&p=a5&sv=4&i=1, packed by Copy link (state/shareToken.ts)
      window.history.replaceState(null, "", "/?c=AgIT9I52g");

      let restoredFrom = "";
      mockStateManagerInstance.loadState.mockImplementation(() => {
        restoredFrom = window.location.search;
        return null;
      });

      await initializeApp(app);

      expect(restoredFrom).toBe("?y=2025&p=a5&sv=4");
      await vi.waitFor(() =>
        expect(m.playShareIntro).toHaveBeenCalledWith(app),
      );
    });

    it("does not play once the visitor moved the view before the bundle came", async () => {
      window.history.replaceState(null, "", "/?y=2025&p=a5&sv=4&i=1");
      // A wheel over the map as the page opens, the data and the bundle
      // still on their way
      mockStateManagerInstance.loadState.mockImplementation(() => {
        window.dispatchEvent(new WheelEvent("wheel"));
        return null;
      });

      const listeners = inputListeners();
      await initializeApp(app);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(m.playShareIntro).not.toHaveBeenCalled();
      expect(listeners()).toHaveLength(INPUT_EVENTS.length);
      expect(listeners().every((signal) => signal?.aborted)).toBe(true);
    });

    it("plays after Tab or a modifier on its own, which move no view", async () => {
      window.history.replaceState(null, "", "/?y=2025&p=a5&sv=4&i=1");
      // Alt or Cmd and Tab from the app the link came in to
      mockStateManagerInstance.loadState.mockImplementation(() => {
        for (const key of ["Tab", "Alt", "Meta", "Shift", "Control"]) {
          window.dispatchEvent(new KeyboardEvent("keydown", { key }));
        }
        return null;
      });

      await initializeApp(app);

      await vi.waitFor(() =>
        expect(m.playShareIntro).toHaveBeenCalledWith(app),
      );
    });

    it("does not play after Escape, which the visitor pressed to have none", async () => {
      window.history.replaceState(null, "", "/?y=2025&p=a5&sv=4&i=1");
      mockStateManagerInstance.loadState.mockImplementation(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        return null;
      });

      await initializeApp(app);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(m.playShareIntro).not.toHaveBeenCalled();
    });

    it("keeps the sender's flights out of what the visitor's next visit opens on, and the statistics closed", async () => {
      window.history.replaceState(null, "", "/?y=2025&p=a5&sv=4&i=1");
      mockStateManagerInstance.loadState.mockReturnValueOnce({
        selectedYear: "2025",
        selectedPathIds: [365],
        isolateSelection: true,
        statsPanelVisible: true,
      });

      await initializeApp(app);

      expect(mockStateManagerInstance.visiting).toBe(true);
      // The sheet of a phone would hide the map the intro plays on
      expect(app.statsPanelVisible).toBe(false);
      expect(app.savedState).not.toHaveProperty("statsPanelVisible");
    });

    it("does not fetch it over a load that failed, the mark gone all the same", async () => {
      window.history.replaceState(null, "", "/?y=2025&p=a5&sv=4&i=1");
      vi.mocked(loadFeatures).mockClear();

      const listeners = inputListeners();
      await initializeApp(app, undefined, undefined, null);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(window.location.search).toBe("?y=2025&p=a5&sv=4");
      expect(m.playShareIntro).not.toHaveBeenCalled();
      expect(loadFeatures).not.toHaveBeenCalled();
      // Nor does it listen for input any longer
      expect(listeners().every((signal) => signal?.aborted)).toBe(true);
    });

    it("does not play from a link without the mark", async () => {
      window.history.replaceState(null, "", "/?y=2025&p=a5&sv=4");
      mockStateManagerInstance.visiting = false;

      const listeners = inputListeners();
      await initializeApp(app);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(m.playShareIntro).not.toHaveBeenCalled();
      // Nor listens for input on its account
      expect(listeners()).toHaveLength(0);
      // The flights of a link of the visitor's own are theirs to keep
      expect(mockStateManagerInstance.visiting).toBe(false);
    });
  });

  describe("data loading", () => {
    it("loads airports, metadata and the selected year's data in order", async () => {
      await initializeApp(app);

      expect(mockDataManagerInstance.loadAirports).toHaveBeenCalledTimes(1);
      expect(mockDataManagerInstance.loadMetadata).toHaveBeenCalledTimes(1);
      expect(mockDataManagerInstance.loadData).toHaveBeenCalledWith("2025");
      expect(app.aircraftModels).toBe(defaultMetadata.aircraft_models);
      expect(app.hasTimingData).toBe(true);
      expect(app.currentData).toBe(defaultData);
      expect(app.fullPathInfo).toBe(defaultData.path_info);
      expect(app.fullPathSegments).toBe(defaultData.path_segments);
      expect(app.isInitializing).toBe(false);
    });

    it("leaves persistence to the store subscription and the map events", async () => {
      await initializeApp(app);

      // No direct save: the state manager subscribes to the store and the
      // map's moveend, so an extra call here would only be a second write
      expect(mockStateManagerInstance.saveMapState).not.toHaveBeenCalled();
    });

    it("keeps currentData null and continues when data fails to load", async () => {
      await initializeApp(app, defaultAirports, defaultMetadata, null);

      expect(app.currentData).toBeNull();
      expect(app.isInitializing).toBe(false);
    });

    it("publishes the dataset with its aircraft list, in one update", async () => {
      // The layers follow the store: they are drawn once, for the final
      // combination of dataset and aircraft filter
      const seen: unknown[] = [];
      mockFilterManagerInstance.updateAircraftDropdown.mockImplementation(() =>
        seen.push(app.currentData),
      );
      const listener = vi.fn();
      app.store.subscribeKeys(["currentData", "selectedAircraft"], listener);

      await initializeApp(app);

      expect(seen).toEqual([defaultData]);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(
        mockAirportManagerInstance.updateAirportMarkerSizes,
      ).toHaveBeenCalled();
    });

    it("publishes the dataset through the store, where the managers listen", async () => {
      const fn = vi.fn();
      app.store.subscribe("currentData", fn);

      await initializeApp(app);

      expect(fn).toHaveBeenCalledWith(defaultData, null);
    });

    it("creates airport markers", async () => {
      await initializeApp(app);

      expect(Object.keys(app.airportMarkers)).toEqual([
        "Frankfurt EDDF",
        "Munich EDDM",
      ]);
      const markers = Object.values(app.airportMarkers).map(
        (entry) => entry.marker as unknown as MockMarker,
      );
      expect(markers).toHaveLength(2);
      for (const marker of markers) {
        expect(marker).toBeInstanceOf(MockMarker);
        expect(marker.addTo).toHaveBeenCalledWith(app.map);
      }
    });

    it("handles null metadata gracefully", async () => {
      await initializeApp(app, defaultAirports, null);

      expect(yearSelect().options).toHaveLength(1);
      expect(app.aircraftModels).toEqual({});
      expect(app.hasTimingData).toBe(false);
      expect(app.selectedYear).toBe("all");
      expect(mockDataManagerInstance.loadData).toHaveBeenCalledWith("all");
    });
  });

  describe("without a data index", () => {
    it("falls back to all years, says so and keeps the dropdown in step", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedYear: "2024",
      });

      await initializeApp(app, defaultAirports, null);

      // The dropdown had only "All years" to show while the map loaded 2024
      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "The list of years is unavailable, showing all years",
        "error",
      );
      expect(mockDataManagerInstance.loadData).toHaveBeenCalledWith("all");
    });
  });

  describe("year selection", () => {
    it("populates the year dropdown and defaults to the latest year", async () => {
      await initializeApp(app);

      expect([...yearSelect().options].map((o) => o.value)).toEqual([
        "all",
        "2024",
        "2025",
      ]);
      expect(yearSelect().options[2]!.textContent).toBe("2025");
      expect(app.selectedYear).toBe("2025");
      expect(yearSelect().value).toBe("2025");
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("keeps a restored year and syncs the dropdown", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedYear: "2024",
      });

      await initializeApp(app);

      expect(app.selectedYear).toBe("2024");
      expect(yearSelect().value).toBe("2024");
      expect(app.restoredYearFromState).toBe(true);
    });

    it("names a restored year in the dropdown before the list of years is in", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedYear: "2024",
      });
      let shown: string[] = [];
      mockDataManagerInstance.loadMetadata.mockImplementation(() => {
        shown = [yearSelect().value, yearSelect().selectedOptions[0]!.text];
        return Promise.resolve(null);
      });
      mockDataManagerInstance.loadAirports.mockResolvedValue(defaultAirports);

      await app.initialize();

      // It said "All years" until the metadata was in, then the year
      expect(shown).toEqual(["2024", "2024"]);
    });

    it('keeps "all" when it was restored from state', async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedYear: "all",
      });

      await initializeApp(app);

      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
    });

    it("falls back to the latest year with a toast when the restored year is unavailable", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedYear: "2019",
      });

      await initializeApp(app);

      expect(app.selectedYear).toBe("2025");
      expect(yearSelect().value).toBe("2025");
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Year 2019 is not available, showing 2025",
        "info",
      );
      expect(mockDataManagerInstance.loadData).toHaveBeenCalledWith("2025");
    });

    it('falls back to "all" when no years are available', async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedYear: "2019",
      });

      await initializeApp(app, defaultAirports, {
        ...defaultMetadata,
        available_years: [],
      });

      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Year 2019 is not available, showing all years",
        "info",
      );
    });

    it("applies a year change made through the select during initialization", async () => {
      mockAirportManagerInstance.updateAirportMarkerSizes.mockImplementation(
        () => {
          // user picks another year while data is loading
          yearSelect().value = "2024";
        },
      );

      await initializeApp(app);

      expect(mockFilterManagerInstance.filterByYear).toHaveBeenCalledTimes(1);
      expect(mockFilterManagerInstance.filterByAircraft).not.toHaveBeenCalled();
    });

    it("applies an aircraft change made through the select during initialization", async () => {
      const aircraftSelect = document.getElementById(
        "aircraft-select",
      ) as HTMLSelectElement;
      const option = document.createElement("option");
      option.value = "D-ABCD";
      aircraftSelect.appendChild(option);
      mockAirportManagerInstance.updateAirportMarkerSizes.mockImplementation(
        () => {
          aircraftSelect.value = "D-ABCD";
        },
      );

      await initializeApp(app);

      expect(mockFilterManagerInstance.filterByAircraft).toHaveBeenCalledTimes(
        1,
      );
      expect(mockFilterManagerInstance.filterByYear).not.toHaveBeenCalled();
    });
  });

  describe("resetView", () => {
    /**
     * The year switch as FilterManager does it, reduced to what resetView
     * relies on: the year and whatever `also` sets land in one batch. It
     * keeps the selected flights the year shows, so the selection is
     * `also`'s to clear.
     */
    function switchYearsInOneBatch(): void {
      mockFilterManagerInstance.filterByYear.mockImplementation(
        (year: string, also?: () => void) => {
          app.store.batch(() => {
            app.selectedYear = year;
            also?.();
          });
          return Promise.resolve(true);
        },
      );
    }

    /** Everything a visitor can change, changed */
    function changeEverything(): void {
      app.store.batch(() => {
        app.selectedYear = "2024";
        app.selectedAircraft = "D-ABCD";
        app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
        app.isolateSelection = true;
        app.heatmapVisible = false;
        app.altitudeVisible = true;
        app.airspeedVisible = true;
        app.airportsVisible = false;
        app.aviationVisible = true;
        app.globeVisible = true;
        app.threeDVisible = true;
        app.satelliteVisible = true;
        app.store.set("statsPanelVisible", true);
      });
      mockMap(app).jumpTo({ bearing: 40, pitch: 60 });
    }

    it("goes back to the newest year and every default, in one update", async () => {
      await initializeApp(app);
      switchYearsInOneBatch();
      changeEverything();
      // As PathSelection clears it
      mockPathSelectionInstance.clearSelection.mockImplementationOnce(() => {
        app.selectedPathIds = new Set();
      });
      const defaults = createDefaultState();
      const keys = [
        "selectedAircraft",
        "isolateSelection",
        "heatmapVisible",
        "altitudeVisible",
        "airspeedVisible",
        "airportsVisible",
        "aviationVisible",
        "globeVisible",
        "threeDVisible",
        "satelliteVisible",
        "statsPanelVisible",
      ] as const;
      const listener = vi.fn();
      app.store.subscribeKeys([...keys, "selectedYear"], listener);

      await app.resetView();

      // The newest year of the metadata, as a first visit opens on
      expect(mockFilterManagerInstance.filterByYear).toHaveBeenCalledWith(
        "2025",
        expect.any(Function),
      );
      expect(app.selectedYear).toBe("2025");
      for (const key of keys) {
        expect(app.store.get(key), key).toBe(defaults[key]);
      }
      // Through the one way to clear it, inside the same batch
      expect(mockPathSelectionInstance.clearSelection).toHaveBeenCalledTimes(1);
      expect(app.selectedPathIds.size).toBe(0);
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("fits all the flights north up and flat once the year is in", async () => {
      await initializeApp(app);
      changeEverything();
      let publish!: (applied: boolean) => void;
      mockFilterManagerInstance.filterByYear.mockReturnValue(
        new Promise<boolean>((resolve) => {
          publish = resolve;
        }),
      );
      const fitBounds = mockMap(app).fitBounds;

      const reset = app.resetView();
      await Promise.resolve();
      expect(fitBounds).not.toHaveBeenCalled();
      publish(true);
      await reset;

      // The bounds and padding of the start view (see the initialize tests)
      expect(fitBounds).toHaveBeenCalledWith(
        [
          [8, 50],
          [10, 52],
        ],
        { padding: START_PADDING, pitch: 0 },
      );
      expect(app.map!.getBearing()).toBe(0);
      expect(app.map!.getPitch()).toBe(0);
    });

    it("leaves everything as it was when the year fails to load", async () => {
      await initializeApp(app);
      changeEverything();
      // FilterManager puts the dropdown back and changes nothing
      mockFilterManagerInstance.filterByYear.mockResolvedValue(false);
      const fitBounds = mockMap(app).fitBounds;

      await app.resetView();

      expect(fitBounds).not.toHaveBeenCalled();
      expect(app.map!.getPitch()).toBe(60);
      expect(app.selectedAircraft).toBe("D-ABCD");
      expect(app.threeDVisible).toBe(true);
      expect(app.globeVisible).toBe(true);
      expect(app.store.get("statsPanelVisible")).toBe(true);
      expect(app.isReset()).toBe(false);
    });

    it("leaves the camera to a filter change made while the year loads", async () => {
      await initializeApp(app);
      changeEverything();
      let settle!: (applied: boolean) => void;
      mockFilterManagerInstance.filterByYear.mockReturnValue(
        new Promise<boolean>((resolve) => {
          settle = resolve;
        }),
      );
      const fitBounds = mockMap(app).fitBounds;

      const reset = app.resetView();
      // Another year picked, and the camera moved, before the reset's
      // year is in: FilterManager drops the reset's year
      app.selectedYear = "2023";
      mockMap(app).jumpTo({ center: [9.5, 51], zoom: 3 });
      settle(false);
      await reset;

      expect(fitBounds).not.toHaveBeenCalled();
      expect(app.selectedYear).toBe("2023");
      expect(app.map!.getZoom()).toBe(3);
      expect(app.map!.getPitch()).toBe(60);
    });

    it('opens on "all" years when there is no list of years', async () => {
      await initializeApp(app, defaultAirports, null);
      switchYearsInOneBatch();
      changeEverything();

      await app.resetView();

      expect(mockFilterManagerInstance.filterByYear).toHaveBeenCalledWith(
        "all",
        expect.any(Function),
      );
    });
  });

  describe("Reset view availability", () => {
    const button = (): HTMLElement =>
      document.getElementById("reset-view-btn")!;

    /**
     * Unavailable like Share mode and Replay: announced, which the stylesheet
     * dims; nothing is written into the button's own style
     */
    function expectAvailable(available: boolean): void {
      expect(button().getAttribute("aria-disabled")).toBe(String(!available));
      expect(button().style.opacity).toBe("");
    }

    /** A camera change by hand: the map says so once it has come to rest */
    function moveCamera(options: Parameters<MockMap["jumpTo"]>[0]): void {
      mockMap(app).jumpTo(options);
      mockMap(app).emit("moveend");
    }

    it("is unavailable on a first visit, where there is nothing to reset", async () => {
      await initializeApp(app);

      expectAvailable(false);
      expect(app.isReset()).toBe(true);
      // It says why, as Share mode does, and so does a press
      expect(button().title).toBe(RESET_VIEW_DONE_MESSAGE);
      await app.resetView();
      expect(toastMock.showToast).toHaveBeenCalledWith(RESET_VIEW_DONE_MESSAGE);
    });

    it.each([
      ["another year", () => (app.selectedYear = "2024")],
      ["an aircraft", () => (app.selectedAircraft = "D-ABCD")],
      ["a layer", () => (app.aviationVisible = true)],
      ["the heatmap off", () => (app.heatmapVisible = false)],
      ["3D flights", () => (app.threeDVisible = true)],
      ["the globe", () => (app.globeVisible = true)],
      ["the satellite imagery", () => (app.satelliteVisible = true)],
      ["the statistics", () => app.store.set("statsPanelVisible", true)],
      [
        "a selection",
        () => {
          app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
        },
      ],
      ["a pan", () => moveCamera({ center: [9.5, 51] })],
      ["a zoom", () => moveCamera({ zoom: 3 })],
      ["a rotation", () => moveCamera({ bearing: 30 })],
      ["a tilt", () => moveCamera({ pitch: 40 })],
    ])("is available after %s", async (_change, change) => {
      await initializeApp(app);

      change();

      expectAvailable(true);
    });

    it("has the phone's open sheet read its row again", async () => {
      const bar = { refreshSheet: vi.fn(), destroy: vi.fn() };
      m.mobileBar.mountFor.mockReturnValue(bar);
      await initializeApp(app);
      bar.refreshSheet.mockClear();

      // The end of the first load and of a camera move are no store keys
      // the sheet follows
      moveCamera({ center: [9.5, 51] });

      expect(bar.refreshSheet).toHaveBeenCalledTimes(1);
    });

    it("stays unavailable through a move that ends where it started", async () => {
      await initializeApp(app);

      // A resize, or Wrapped handing the view back as it was
      moveCamera({ center: [9, 51] });

      expectAvailable(false);
    });

    it("is unavailable again once the fit of a reset has ended", async () => {
      await initializeApp(app);
      app.aviationVisible = true;
      moveCamera({ center: [9.5, 51], zoom: 3, bearing: 30, pitch: 40 });
      mockFilterManagerInstance.filterByYear.mockImplementation(
        (_year: string, also?: () => void) => {
          app.store.batch(() => also?.());
          return Promise.resolve(true);
        },
      );

      await app.resetView();

      // The store is back, the camera still on its way to the start view
      expectAvailable(true);
      mockMap(app).emit("moveend");
      expectAvailable(false);
    });

    it("does nothing when pressed with nothing to reset", async () => {
      await initializeApp(app);

      await app.resetView();

      expect(mockFilterManagerInstance.filterByYear).not.toHaveBeenCalled();
      expect(mockMap(app).fitBounds).not.toHaveBeenCalled();
    });

    it("is available on a page a link opens somewhere else", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        center: { lat: 50.5, lng: 8.5 },
        zoom: 12,
      });

      await initializeApp(app);

      expectAvailable(true);
    });

    it("is unavailable on a reload of the start view", async () => {
      // What a first visit saves: the centre of the bounds, at the zoom of
      // the fit (the mock's fit keeps the zoom, 0 here, one below the state)
      mockStateManagerInstance.loadState.mockReturnValue({
        center: { lat: 51, lng: 9 },
        zoom: 1,
      });

      await initializeApp(app);

      expectAvailable(false);
    });

    it("leaves the button to a running replay and takes it back after", async () => {
      await initializeApp(app);
      app.replayActive = true;

      // The replay has disabled it; the move does not touch it
      moveCamera({ bearing: 30 });
      expect(button().getAttribute("aria-disabled")).toBe("true");

      app.replayActive = false;
      expectAvailable(true);
    });

    it("is unavailable until the first load is over", async () => {
      // The actions that need data wait for it (ui/actions.ts), and a
      // pressed Reset view switched the year under the load
      mockStateManagerInstance.loadState.mockReturnValue({
        aviationVisible: true,
      });
      const during: boolean[] = [];
      app.store.subscribe("currentData", () => during.push(app.canResetView()));

      await initializeApp(app);

      expect(during).toEqual([false]);
      expectAvailable(true);
    });

    it("is available when the first year failed to load", async () => {
      // An empty map is not what a first visit shows, and Reset view loads
      // the newest year again; it was left unavailable as if all was well
      await initializeApp(app, defaultAirports, defaultMetadata, null);

      expect(app.currentData).toBeNull();
      expect(app.isReset()).toBe(false);
      expectAvailable(true);
    });
  });

  describe("airspeed availability", () => {
    it("sets the airspeed range before the dataset draws the layers", async () => {
      let range: unknown = null;
      app.store.subscribe("currentData", () => {
        range = { ...app.airspeedRange };
      });

      await initializeApp(app);

      expect(app.airspeedRange).toEqual({ min: 0, max: 150 });
      expect(range).toEqual({ min: 0, max: 150 });
      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      // The button state itself follows the store
      expect(btn.style.opacity).toBe("");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    });

    it("marks the airspeed button unavailable without timing data", async () => {
      await initializeApp(app, defaultAirports, {
        ...defaultMetadata,
        max_groundspeed_knots: 0,
      });

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(
        mockLayerManagerInstance.updateAirspeedLegend,
      ).not.toHaveBeenCalled();
    });

    it("releases a restored speed layer without timing data (regression)", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        airspeedVisible: true,
      });

      await initializeApp(app, defaultAirports, {
        ...defaultMetadata,
        max_groundspeed_knots: 0,
      });

      // The button is unavailable, so a pressed state could never have been
      // released, and the empty layer showed a legend with placeholders
      expect(app.airspeedVisible).toBe(false);
      expect(app.airspeedLayer.isVisible()).toBe(false);
      expect(visibility(app, "paths-airspeed")).toBe("none");
      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(document.getElementById("airspeed-legend")!.hidden).toBe(true);
    });

    it("keeps the airspeed button lit when airspeed is visible", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        airspeedVisible: true,
      });

      await initializeApp(app);

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.classList.contains("active")).toBe(true);
      expect(btn.getAttribute("aria-pressed")).toBe("true");
    });
  });

  describe("restored layer state", () => {
    it("keeps altitude alone when both colour layers are restored", async () => {
      // `v=111111111` turned both on, which the toggles never leave
      mockStateManagerInstance.loadState.mockReturnValue({
        altitudeVisible: true,
        airspeedVisible: true,
      });

      await initializeApp(app);

      expect(app.altitudeVisible).toBe(true);
      expect(app.airspeedVisible).toBe(false);
      expect(
        document.getElementById("airspeed-btn")!.getAttribute("aria-pressed"),
      ).toBe("false");
    });

    it("adds the altitude layer and shows its legend", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        altitudeVisible: true,
      });

      await initializeApp(app);

      expect(app.altitudeVisible).toBe(true);
      // The layer manager shows the colour layers the store asks for
      expect(mockLayerManagerInstance.syncModes).toHaveBeenCalled();
      expect(document.getElementById("altitude-legend")!.hidden).toBe(false);
      expect(document.getElementById("airspeed-legend")!.hidden).toBe(true);
    });

    it("steps the heatmap back for a restored colour layer", async () => {
      // Nothing toggled anything here: the emphasis follows the store keys,
      // not the control that usually writes them
      mockStateManagerInstance.loadState.mockReturnValue({
        altitudeVisible: true,
      });

      await initializeApp(app);

      expect(mockDataManagerInstance.applyHeatmapEmphasis).toHaveBeenCalled();
    });

    it("steps it back again when a colour layer is switched off", async () => {
      await initializeApp(app);
      mockDataManagerInstance.applyHeatmapEmphasis.mockClear();

      app.altitudeVisible = true;
      app.altitudeVisible = false;

      expect(
        mockDataManagerInstance.applyHeatmapEmphasis,
      ).toHaveBeenCalledTimes(2);
    });

    it("adds the airspeed layer and shows its legend", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        airspeedVisible: true,
      });

      await initializeApp(app);

      expect(app.airspeedVisible).toBe(true);
      expect(mockLayerManagerInstance.syncModes).toHaveBeenCalled();
      expect(document.getElementById("airspeed-legend")!.hidden).toBe(false);
    });

    it("keeps the legends in step with the store after initialization", async () => {
      await initializeApp(app);
      const legend = document.getElementById("altitude-legend")!;
      expect(legend.hidden).toBe(true);

      app.altitudeVisible = true;
      expect(legend.hidden).toBe(false);

      app.altitudeVisible = false;
      expect(legend.hidden).toBe(true);
    });

    it("shows the aviation layer when visible", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        aviationVisible: true,
      });

      await initializeApp(app);

      expect(visibility(app, "aviation")).toBe("visible");
    });

    it("creates the aviation layer hidden otherwise", async () => {
      await initializeApp(app);

      expect(app.aviationLayer.isVisible()).toBe(false);
      expect(visibility(app, "aviation")).toBe("none");
    });

    it("hides the airport markers when airports are not visible", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        airportsVisible: false,
      });

      await initializeApp(app);

      expect(app.airportLayer.isVisible()).toBe(false);
      expect(
        mockMap(app).getContainer().classList.contains("airports-hidden"),
      ).toBe(true);
    });

    it("shows the airport markers by default", async () => {
      await initializeApp(app);

      expect(
        mockMap(app).getContainer().classList.contains("airports-hidden"),
      ).toBe(false);
    });

    it("restores selected paths and share mode into the store", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedPathIds: [1, 2],
        isolateSelection: true,
      });

      await initializeApp(app, defaultAirports, defaultMetadata, {
        ...defaultData,
        path_info: [...defaultData.path_info, { id: 2, year: 2025 }],
      });

      expect([...app.selectedPathIds]).toEqual([1, 2]);
      expect(app.isolateSelection).toBe(true);
    });

    // What the first load keeps of a restored selection is FilterManager's
    // (see loadShownYear), and tested with it in appInitializer.test.ts

    it("drops a restored isolate flag without a selection (regression)", async () => {
      // A link written before path ids were versioned loses its paths but
      // still carries the isolate flag
      mockStateManagerInstance.loadState.mockReturnValue({
        isolateSelection: true,
      });

      await initializeApp(app);

      expect(app.isolateSelection).toBe(false);
    });

    it("restores the stats panel and starts its manager", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        statsPanelVisible: true,
      });

      await initializeApp(app);

      expect(app.store.get("statsPanelVisible")).toBe(true);
      await vi.waitFor(() =>
        expect(app.statsManager).toBe(mockStatsManagerInstance),
      );
    });

    it("leaves the stats panel closed, and its code unloaded, when not saved", async () => {
      await initializeApp(app);

      expect(app.store.get("statsPanelVisible")).toBe(false);
      expect(loadWrapped).not.toHaveBeenCalled();
      expect(app.statsManager).toBeUndefined();
    });

    it("reopens the wrapped modal after a delay when it was open", async () => {
      vi.useFakeTimers();
      mockStateManagerInstance.loadState.mockReturnValue({
        wrappedVisible: true,
      });

      await initializeApp(app);

      expect(mockWrappedManagerInstance.showWrapped).not.toHaveBeenCalled();
      // The timer fetches the Wrapped bundle first, so let the promise settle
      await vi.advanceTimersByTimeAsync(500);
      expect(mockWrappedManagerInstance.showWrapped).toHaveBeenCalledTimes(1);
      // Without the intro, which only its button plays
      expect(mockWrappedManagerInstance.showWrapped).toHaveBeenCalledWith();
      // From then on the saves write what the store says
      expect(app.savedState).not.toHaveProperty("wrappedVisible");
    });

    it("does not reopen the wrapped modal over a load that failed", async () => {
      vi.useFakeTimers();
      mockStateManagerInstance.loadState.mockReturnValue({
        wrappedVisible: true,
      });

      await initializeApp(app, defaultAirports, defaultMetadata, null);
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWrappedManagerInstance.showWrapped).not.toHaveBeenCalled();
      expect(app.savedState).not.toHaveProperty("wrappedVisible");
    });

    it("is done with the restore of the wrapped modal when it fails to open", async () => {
      vi.useFakeTimers();
      mockStateManagerInstance.loadState.mockReturnValue({
        wrappedVisible: true,
      });
      mockWrappedManagerInstance.showWrapped.mockImplementationOnce(() => {
        throw new Error("no dialog");
      });

      await initializeApp(app);
      await vi.advanceTimersByTimeAsync(500);

      // A save writes what the store says, not the flag restored
      expect(app.savedState).not.toHaveProperty("wrappedVisible");
    });

    it("does not reopen the wrapped modal once the app is destroyed", async () => {
      vi.useFakeTimers();
      mockStateManagerInstance.loadState.mockReturnValue({
        wrappedVisible: true,
      });

      await initializeApp(app);
      app.destroy();
      await vi.advanceTimersByTimeAsync(500);

      expect(mockWrappedManagerInstance.showWrapped).not.toHaveBeenCalled();
      // Neither feature was ever opened, so neither manager exists; destroy
      // has to cope with that rather than reach through an undefined
      expect(mockReplayManagerInstance.destroy).not.toHaveBeenCalled();
      expect(mockWrappedManagerInstance.destroy).not.toHaveBeenCalled();
    });

    it("gets Wrapped's intro ready as its button is pointed at or focused, unless motion is unwelcome", async () => {
      const prepareWrappedIntro = vi.fn();
      const bundle = { prepareWrappedIntro } as never;
      vi.mocked(loadWrapped)
        .mockResolvedValueOnce(bundle)
        .mockResolvedValueOnce(bundle);
      const button = document.createElement("button");
      button.id = "wrapped-btn";
      const other = document.createElement("button");
      document.body.append(button, other);
      await initializeApp(app);

      button.dispatchEvent(new Event("pointerenter"));
      button.focus();
      other.dispatchEvent(new Event("pointerenter"));
      await vi.waitFor(() =>
        expect(prepareWrappedIntro).toHaveBeenCalledTimes(2),
      );
      expect(prepareWrappedIntro).toHaveBeenCalledWith(app);

      // No intro plays under reduced motion, so nothing is fetched for it
      vi.mocked(loadWrapped).mockClear();
      const reduced = vi
        .spyOn(motion, "prefersReducedMotion")
        .mockReturnValue(true);
      button.dispatchEvent(new Event("pointerenter"));
      reduced.mockRestore();
      expect(loadWrapped).not.toHaveBeenCalled();
    });

    it("restores the map view from saved center and zoom", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        center: { lat: 50.5, lng: 8.5 },
        zoom: 12,
      });

      await initializeApp(app);

      // Longitude first, and one level below the zoom the state carries
      expect(mockMap(app).options).toMatchObject({
        center: [8.5, 50.5],
        zoom: 11,
      });
      expect(mockMap(app).options).not.toHaveProperty("bounds");
    });

    it("treats a saved zoom of 0 as a view, not as a missing one", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        center: { lat: 50.5, lng: 8.5 },
        zoom: 0,
      });

      await initializeApp(app);

      // State zoom 0 is below what the map can show, so it opens as far
      // out as the map goes rather than at the default zoom
      expect(mockMap(app).options).toMatchObject({
        center: [8.5, 50.5],
        zoom: 0,
      });
      expect(mockMap(app).options).not.toHaveProperty("bounds");
    });

    it("centres a link that carries no zoom at the default zoom", async () => {
      // A hand-written or cut-short link: lat and lng, no z
      mockStateManagerInstance.loadState.mockReturnValue({
        center: { lat: 50.5, lng: 8.5 },
      });

      await initializeApp(app);

      expect(mockMap(app).options).toMatchObject({
        center: [8.5, 50.5],
        zoom: 9,
      });
      expect(mockMap(app).options).not.toHaveProperty("bounds");
    });

    it("fits the configured bounds without a saved view", async () => {
      await initializeApp(app);

      expect(mockMap(app).options).toMatchObject({
        bounds: [
          [8, 50],
          [10, 52],
        ],
        fitBoundsOptions: { padding: START_PADDING },
      });
      expect(mockMap(app).options).not.toHaveProperty("center");
      expect(mockMap(app).options).not.toHaveProperty("zoom");
    });
  });
});

describe("startViewPadding", () => {
  /** Have the safe area's probe measure `top` and `bottom` */
  const insets = (top: number, bottom: number) =>
    measureSafeArea({ top, bottom });

  beforeEach(() => resetSafeArea());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty("--mobile-bar-h");
    resetSafeArea();
  });

  it("counts no inset on top of what the panels' padding holds already", () => {
    // mapChromePadding takes the safe area in (see its own tests)
    insets(59, 34);

    expect(startViewPadding(document.body)).toEqual(START_PADDING);
  });

  it("keeps the flights clear of a phone's bar, by its height in the stylesheet", () => {
    insets(59, 34);
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: true, query }));
    document.documentElement.style.setProperty("--mobile-bar-h", "56px");

    // The bar is not on the page yet when the first view is fitted
    expect(startViewPadding(document.body).bottom).toBe(48 + 56);
  });
});
