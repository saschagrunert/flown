import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AIRPORTS_FAILED_MESSAGE,
  colorSegmentPopups,
  createAirportMarkers,
  loadInitialData,
  resolveYearSelection,
} from "../../../../flown/frontend/appInitializer";
import {
  FilterManager,
  publishDataset,
} from "../../../../flown/frontend/ui/filterManager";
import type {
  Airport,
  KMLDataset,
  Metadata,
} from "../../../../flown/frontend/types";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  syncControlsWithStore,
  type MockApp,
} from "../../testHelpers";
import { Marker as MockMarker } from "../../../mocks/maplibre-gl";
import { NO_DATA_MESSAGE } from "../../../../flown/frontend/ui/actions";

const toastMock = vi.hoisted(() => ({
  showToast: vi.fn(),
  announceStatus: vi.fn(),
  dismissToast: vi.fn(),
}));
vi.mock("../../../../flown/frontend/utils/toast", () => toastMock);

function setupDOM(): void {
  document.body.innerHTML = `
    <select id="year-select"><option value="all">All Years</option></select>
    <button id="airspeed-btn"></button>
    <button id="wrapped-btn" title="Wrapped"></button>
    <div id="altitude-legend"></div>
    <div id="airspeed-legend"></div>
    <div id="map-empty" hidden>
      <p>Could not load the flights</p>
      <button id="map-empty-retry"></button>
    </div>
  `;
}

function yearSelect(): HTMLSelectElement {
  return document.getElementById("year-select") as HTMLSelectElement;
}

const airports: Airport[] = [
  { name: "Frankfurt EDDF", code: "EDDF", lat: 50.1, lon: 8.67 },
  { name: "Munich EDDM", code: "EDDM", lat: 48.35, lon: 11.78 },
];

const metadata: Metadata = {
  available_years: [2024, 2025],
  year_file_bytes: {},
  min_groundspeed_knots: 10,
  max_groundspeed_knots: 150,
  aircraft_models: { "D-ABCD": "Diamond DA40" },
};

describe("appInitializer", () => {
  let app: MockApp;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDOM();
    app = createMockApp({ isInitializing: true });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    document.body.className = "";
  });

  describe("resolveYearSelection", () => {
    it("populates the select and defaults to the latest year", () => {
      resolveYearSelection(asMapApp(app), [2023, 2024]);

      expect([...yearSelect().options].map((o) => o.value)).toEqual([
        "all",
        "2023",
        "2024",
      ]);
      // As attributes too, which the e2e tests read the years off
      expect(
        [...yearSelect().options].map((o) => o.getAttribute("value")),
      ).toEqual(["all", "2023", "2024"]);
      expect(app.selectedYear).toBe("2024");
      expect(yearSelect().value).toBe("2024");
    });

    it("replaces the year the page ships with, and a restored one, with the list", () => {
      // The template names the latest year (site_assets.render_html), and
      // restoreState (ui/stateRestore.ts) adds one of a link
      yearSelect().add(new Option("2024", "2024", true, true));
      yearSelect().add(new Option("1999"));

      resolveYearSelection(asMapApp(app), [2023, 2024]);

      expect([...yearSelect().options].map((o) => o.value)).toEqual([
        "all",
        "2023",
        "2024",
      ]);
      expect(yearSelect().value).toBe("2024");
    });

    it("keeps a restored 'all'", () => {
      app.restoredYearFromState = true;

      resolveYearSelection(asMapApp(app), [2023, 2024]);

      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
    });

    it("remembers the year a first visit opens on, whatever was restored", () => {
      // Reset view goes back to it (MapApp.resetView)
      app.selectedYear = "2023";

      resolveYearSelection(asMapApp(app), [2024, 2023]);

      expect(app.selectedYear).toBe("2023");
      expect(app.defaultYear).toBe("2024");
    });

    it("keeps an available restored year", () => {
      app.selectedYear = "2023";

      resolveYearSelection(asMapApp(app), [2023, 2024]);

      expect(app.selectedYear).toBe("2023");
      expect(yearSelect().value).toBe("2023");
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("falls back to the latest year with a toast for an unavailable year", () => {
      app.selectedYear = "1999";

      resolveYearSelection(asMapApp(app), [2023, 2024]);

      expect(app.selectedYear).toBe("2024");
      expect(yearSelect().value).toBe("2024");
      expect(toastMock.showToast).toHaveBeenCalledWith(
        "Year 1999 is not available, showing 2024",
        "info",
      );
    });

    it("falls back to 'all' when no years exist", () => {
      app.selectedYear = "1999";

      resolveYearSelection(asMapApp(app), []);

      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
    });

    it("takes a year picked before the list came over the one restored", () => {
      app.selectedYear = "2023";
      app.restoredYearFromState = true;
      yearSelect().add(new Option("2023", "2023", true, true));
      yearSelect().value = "all";

      resolveYearSelection(asMapApp(app), [2024, 2025]);

      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
      // Nobody is told the restored year is gone: another one was picked
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("does not take a year the list does not have for a pick", () => {
      yearSelect().add(new Option("2023", "2023"));
      yearSelect().value = "2023";

      resolveYearSelection(asMapApp(app), [2024, 2025]);

      expect(app.selectedYear).toBe("2025");
    });

    it("works without a year select element", () => {
      yearSelect().remove();

      expect(() => resolveYearSelection(asMapApp(app), [2024])).not.toThrow();
      expect(app.selectedYear).toBe("2024");
    });
  });

  describe("createAirportMarkers", () => {
    function create(list: Airport[] = airports): void {
      createAirportMarkers(asMapApp(app), list);
    }

    function eddf(): MockApp["airportMarkers"][string] {
      return app.airportMarkers["Frankfurt EDDF"]!;
    }

    it("creates one marker per airport, on the map and with no popup of its own", () => {
      create();

      expect(Object.keys(app.airportMarkers)).toEqual([
        "Frankfurt EDDF",
        "Munich EDDM",
      ]);
      const marker = eddf().marker as unknown as MockMarker;
      expect(marker).toBeInstanceOf(MockMarker);
      expect(marker.options).toEqual({
        element: eddf().getElement(),
        anchor: "center",
        // Faded out entirely where the relief covers it (the stylesheet)
        opacityWhenCovered: 0,
      });
      // Longitude first for the map, latitude first for the app
      expect(marker.setLngLat).toHaveBeenCalledWith([8.67, 50.1]);
      expect(eddf().getLatLng()).toEqual({ lat: 50.1, lng: 8.67 });
      expect(marker.addTo).toHaveBeenCalledWith(app.map);
      expect(app.map!.getCanvasContainer().contains(eddf().getElement())).toBe(
        true,
      );
      // The popup is AirportManager's, shared and opened by the app;
      // `setPopup` would toggle it a second time on the same click
      expect(marker.setPopup).not.toHaveBeenCalled();
    });

    it("takes the markers of before off the map when made again", () => {
      // A second set over the first stayed on the map for good
      create();
      const first = eddf().marker as unknown as MockMarker;

      create();

      expect(first.remove).toHaveBeenCalledTimes(1);
      expect(Object.keys(app.airportMarkers)).toEqual([
        "Frankfurt EDDF",
        "Munich EDDM",
      ]);
      expect(eddf().marker).not.toBe(first);
      expect(
        app.map!.getCanvasContainer().querySelectorAll("button"),
      ).toHaveLength(2);
    });

    it("makes each marker a button named after its airport", () => {
      create();
      const element = eddf().getElement();
      const button = eddf().getControl() as HTMLButtonElement;

      expect(element.classList.contains("airport-marker-root")).toBe(true);
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect(element.contains(button)).toBe(true);
      expect(button.type).toBe("button");
      expect(button.title).toBe("Frankfurt EDDF");
      expect(button.getAttribute("aria-label")).toBe("Frankfurt EDDF");
      // It opens a popup, which starts out closed
      expect(button.getAttribute("aria-expanded")).toBe("false");
      // The code is a label of the map (see ui/airportLabels.ts)
      expect(element.querySelector(".airport-label")).toBeNull();
    });

    it("does not pre-assign the home base (the airport manager does)", () => {
      create();

      for (const marker of Object.values(app.airportMarkers)) {
        expect(
          marker.getElement().querySelector(".airport-marker-home"),
        ).toBeNull();
      }
    });

    it("switches the home-base styling on the same element", () => {
      create();
      const element = eddf().getElement();

      eddf().setHome(true);
      expect(element.querySelector(".airport-marker-home")).not.toBeNull();

      eddf().setHome(false);
      expect(element.querySelector(".airport-marker-home")).toBeNull();
      expect(eddf().getElement()).toBe(element);
    });

    it("hides a marker without taking it off the map", () => {
      create();

      eddf().setVisible(false);
      expect(eddf().getElement().hidden).toBe(true);
      expect(eddf().marker.remove).not.toHaveBeenCalled();

      eddf().setVisible(true);
      expect(eddf().getElement().hidden).toBe(false);
    });

    it("drives the shared popup of the airport manager", () => {
      create();
      app.airportManager.isPopupOpen.mockReturnValue(true);

      eddf().openPopup();
      eddf().closePopup();

      expect(app.airportManager.openPopup).toHaveBeenCalledWith(
        "Frankfurt EDDF",
      );
      expect(app.airportManager.closePopup).toHaveBeenCalledWith(
        "Frankfurt EDDF",
      );
      expect(eddf().isPopupOpen()).toBe(true);
      expect(app.airportManager.isPopupOpen).toHaveBeenCalledWith(
        "Frankfurt EDDF",
      );
    });

    it("activates its airport on a click, which the airport manager acts on", () => {
      create();

      eddf().getElement().click();

      expect(app.airportManager.activateAirport).toHaveBeenCalledWith(
        "Frankfurt EDDF",
        false,
      );
    });

    it("tells the airport manager of a finger's tap, which only opens", () => {
      create();
      // WebKit's click for a tap may say "mouse"; the touch came just before
      app.touchClock.note(new Event("touchend"));

      eddf()
        .getElement()
        .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

      expect(app.airportManager.activateAirport).toHaveBeenCalledWith(
        "Frankfurt EDDF",
        true,
      );
    });

    it("activates its airport on a press on its code, which is part of it", () => {
      create();
      const element = eddf().getElement();

      element
        .querySelector(".airport-code")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

      expect(element.querySelector(".airport-code")!.textContent).toBe("EDDF");
      expect(app.airportManager.activateAirport).toHaveBeenCalledWith(
        "Frankfurt EDDF",
        false,
      );
    });

    it("ignores the later clicks of a double click or a double tap", () => {
      create();
      const element = eddf().getElement();

      element.dispatchEvent(
        new MouseEvent("click", { bubbles: true, detail: 2 }),
      );

      expect(app.airportManager.activateAirport).not.toHaveBeenCalled();
    });

    it("ignores a second tap that WebKit reports as a single click", () => {
      create();
      const element = eddf().getElement();

      for (let tap = 0; tap < 2; tap++) {
        element.dispatchEvent(
          new MouseEvent("click", { bubbles: true, detail: 1 }),
        );
      }

      expect(app.airportManager.activateAirport).toHaveBeenCalledTimes(1);
    });

    it("stops none of its events on their way to the map", () => {
      // A press goes through so a drag that starts on a marker moves the
      // map; the map's own handlers tell a marker by the event's target
      create();
      const onMap = vi.fn();
      const container = app.map!.getCanvasContainer();
      const types = ["click", "mousemove", "dblclick", "mousedown"];
      for (const type of types) container.addEventListener(type, onMap);

      for (const type of types) {
        eddf()
          .getElement()
          .dispatchEvent(new MouseEvent(type, { bubbles: true }));
      }

      expect(onMap).toHaveBeenCalledTimes(types.length);
    });

    it("acts on a click alone, which is also Enter and Space on a button", () => {
      const listen = vi.spyOn(HTMLDivElement.prototype, "addEventListener");

      create([airports[0]!]);

      // The keys are Escape, and Enter and Space on the code's chip while
      // it is the target (onChipKey), which press it; the stylesheet lights
      // up the dot and the code of the marker under the pointer
      expect(listen.mock.calls.map(([type]) => type).sort()).toEqual([
        "click",
        "keydown",
      ]);
      listen.mockRestore();

      // The keys arrive as the click the browser makes of them, and not a
      // second time through a key listener
      eddf()
        .getControl()
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        );
      expect(app.airportManager.activateAirport).not.toHaveBeenCalled();
    });

    it("closes its popup on Escape from the focused marker", () => {
      create();
      const element = eddf().getElement();

      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
      expect(app.airportManager.closePopup).not.toHaveBeenCalled();

      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(app.airportManager.closePopup).toHaveBeenCalledWith(
        "Frankfurt EDDF",
      );
    });

    it("handles an empty list and missing names", () => {
      create([]);
      expect(app.airportMarkers).toEqual({});

      create([{ name: "", lat: 1, lon: 2 }]);
      expect(Object.keys(app.airportMarkers)).toEqual([""]);
    });

    it("creates nothing without a map", () => {
      app.map = null;

      create();

      expect(app.airportMarkers).toEqual({});
    });

    it("places airports either side of the antimeridian where they are", () => {
      create([
        { name: "Nadi NFFN", lat: -17.76, lon: 177.44 },
        { name: "Funafuti NGFU", lat: -8.52, lon: -179.2 },
      ]);

      // Not wrapped into one world: each marker stands on its own side
      expect(app.airportMarkers["Nadi NFFN"]!.getLatLng()).toEqual({
        lat: -17.76,
        lng: 177.44,
      });
      expect(app.airportMarkers["Funafuti NGFU"]!.getLatLng()).toEqual({
        lat: -8.52,
        lng: -179.2,
      });
    });
  });

  describe("loadInitialData", () => {
    let filterManager: FilterManager;
    const data: KMLDataset = createDataset(
      [{ id: 1, year: 2025, aircraft_registration: "D-ABCD" }],
      [createSegment({ path_id: 1 })],
      10,
    );

    beforeEach(() => {
      app.dataManager.loadAirports.mockResolvedValue(airports);
      app.dataManager.loadMetadata.mockResolvedValue(metadata);
      app.dataManager.loadData.mockResolvedValue(data);
      // The first load is a switch to the year the dropdown shows
      // (FilterManager.loadShownYear)
      filterManager = new FilterManager(asMapApp(app));
      app.filterManager = filterManager as unknown as MockApp["filterManager"];
    });

    /**
     * The first load (or a Retry) asked for `year`, with no Retry action
     * but for all years, some of which can fail with the rest on the map
     */
    const loadedFirst = (year: string): unknown[] => [
      year,
      expect.any(AbortSignal),
      year === "all" ? expect.objectContaining({ label: "Retry" }) : undefined,
    ];

    it("loads everything in order and stores the results", async () => {
      const order: string[] = [];
      for (const [name, fn] of [
        ["loadAirports", app.dataManager.loadAirports],
        ["loadMetadata", app.dataManager.loadMetadata],
        ["loadData", app.dataManager.loadData],
      ] as const) {
        const original = fn.getMockImplementation();
        fn.mockImplementation((...args: unknown[]) => {
          order.push(name);
          return original ? (original(...args) as unknown) : Promise.resolve();
        });
      }
      vi.spyOn(filterManager, "updateAircraftDropdown").mockImplementation(() =>
        order.push("dropdown"),
      );
      app.airportManager.updateAirportMarkerSizes.mockImplementation(() =>
        order.push("markerSizes"),
      );

      await loadInitialData(asMapApp(app));

      expect(order).toEqual([
        "loadAirports",
        "loadMetadata",
        "loadData",
        "dropdown",
        "markerSizes",
      ]);
      expect(app.aircraftModels).toBe(metadata.aircraft_models);
      expect(app.hasTimingData).toBe(true);
      expect(app.selectedYear).toBe("2025");
      expect(app.dataManager.loadData).toHaveBeenCalledWith(
        ...loadedFirst("2025"),
      );
      expect(app.currentData).toBe(data);
      expect(Object.keys(app.airportMarkers)).toHaveLength(2);
      expect(app.airspeedRange).toEqual({ min: 10, max: 150 });
    });

    it("says which year it shows once the flights are there", async () => {
      await loadInitialData(asMapApp(app));

      // The loading indicator's region went quiet after a load (regression)
      expect(toastMock.announceStatus).toHaveBeenCalledWith("Showing 2025");
    });

    it("settles the speed range before the dataset draws the layers", async () => {
      // Publishing the dataset is what draws the layers (DataManager
      // follows the store), so what they are drawn with comes first
      const atPublish: unknown[] = [];
      app.store.subscribe("currentData", () =>
        atPublish.push({ ...app.airspeedRange }, app.hasTimingData),
      );

      await loadInitialData(asMapApp(app));

      expect(atPublish).toEqual([{ min: 10, max: 150 }, true]);
    });

    it("publishes the dataset and the aircraft list in one update", async () => {
      vi.spyOn(filterManager, "updateAircraftDropdown").mockImplementation(
        () => {
          app.selectedAircraft = "all";
        },
      );
      app.selectedAircraft = "D-GONE";
      const listener = vi.fn();
      app.store.subscribeKeys(["currentData", "selectedAircraft"], listener);

      await loadInitialData(asMapApp(app));

      expect(listener).toHaveBeenCalledTimes(1);
      expect(app.currentData).toBe(data);
      expect(app.selectedAircraft).toBe("all");
    });

    it("falls back to no models for metadata from an older export", async () => {
      const { aircraft_models: _, ...older } = metadata;
      app.dataManager.loadMetadata.mockResolvedValue(older);

      await loadInitialData(asMapApp(app));

      expect(app.aircraftModels).toEqual({});
    });

    it("publishes the dataset after the markers exist, so their popups can follow it", async () => {
      const markersAtPublish: string[][] = [];
      app.store.subscribe("currentData", () => {
        markersAtPublish.push(Object.keys(app.airportMarkers));
      });

      await loadInitialData(asMapApp(app));

      expect(markersAtPublish).toEqual([["Frankfurt EDDF", "Munich EDDM"]]);
    });

    it("enables the airspeed button with timing data and leaves its look to the store", async () => {
      syncControlsWithStore(app);

      await loadInitialData(asMapApp(app));

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.getAttribute("aria-disabled")).toBe("false");
      expect(btn.hasAttribute("aria-describedby")).toBe(false);
      // Off, and available: no style of its own, the stylesheet draws it
      expect(btn.style.opacity).toBe("");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    });

    it("keeps the airspeed button lit when airspeed is visible", async () => {
      app.airspeedVisible = true;
      syncControlsWithStore(app);

      await loadInitialData(asMapApp(app));

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.classList.contains("active")).toBe(true);
      expect(document.getElementById("airspeed-legend")!.hidden).toBe(false);
    });

    it("marks the airspeed button unavailable without timing data", async () => {
      app.dataManager.loadMetadata.mockResolvedValue({
        ...metadata,
        max_groundspeed_knots: 0,
      });

      await loadInitialData(asMapApp(app));

      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      // aria-disabled, so it stays reachable and says why
      expect(btn.disabled).toBe(false);
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.getAttribute("aria-describedby")).toBe("airspeed-reason");
      // A pointer reads why as well, not what it would colour
      expect(btn.title).toBe("No timing data in the flights");
      expect(app.airspeedRange).toEqual({ min: 0, max: 200 });
    });

    it("tolerates a missing airspeed button", async () => {
      document.getElementById("airspeed-btn")!.remove();
      await expect(loadInitialData(asMapApp(app))).resolves.toBeUndefined();
    });

    it("gets through without a map", async () => {
      app.map = null;

      await expect(loadInitialData(asMapApp(app))).resolves.toBeUndefined();
      expect(app.airportManager.updateAirportMarkerSizes).toHaveBeenCalled();
    });

    it("restores the stats panel through the store key the rail follows", async () => {
      app.savedState = { statsPanelVisible: true };

      await loadInitialData(asMapApp(app));

      expect(app.store.get("statsPanelVisible")).toBe(true);
    });

    it("keeps the stats panel closed over a load that failed", async () => {
      app.savedState = { statsPanelVisible: true };
      app.dataManager.loadData.mockResolvedValue(null);

      await loadInitialData(asMapApp(app));

      // It would open on zeros while its button says the flights are missing
      expect(app.store.get("statsPanelVisible")).toBe(false);
      expect(document.body.classList.contains("flights-failed")).toBe(true);
      // And the restored flag goes, which the saves and the link kept
      // writing while the rail was closed
      expect(app.savedState).toEqual({});
    });

    it("hides the colour legends until the first dataset is in", async () => {
      let during: boolean | undefined;
      app.dataManager.loadData.mockImplementation(() => {
        during = document.body.classList.contains("no-data");
        return Promise.resolve(data);
      });

      await loadInitialData(asMapApp(app));

      // They showed their scale over the empty map while it loaded
      expect(during).toBe(true);
      expect(document.body.classList.contains("no-data")).toBe(false);
    });

    it("keeps the colour legends hidden when the first year fails", async () => {
      app.dataManager.loadData.mockResolvedValue(null);

      await loadInitialData(asMapApp(app));

      expect(document.body.classList.contains("no-data")).toBe(true);
      app.currentData = data;
      expect(document.body.classList.contains("no-data")).toBe(false);
    });

    it("shows the year the page ships with as all years without a list of years", async () => {
      // The template names the latest year from the first paint
      yearSelect().add(new Option("2025", "2025", true, true));
      app.dataManager.loadMetadata.mockResolvedValue(null);

      await loadInitialData(asMapApp(app));

      // The map loads all of them, and the dropdown said 2025
      expect(app.dataManager.loadData).toHaveBeenCalledWith(
        ...loadedFirst("all"),
      );
      expect(yearSelect().value).toBe("all");
      // A first visit asked for no year, so nothing is taken back
      expect(toastMock.showToast).not.toHaveBeenCalled();
    });

    it("handles null metadata and data", async () => {
      app.dataManager.loadMetadata.mockResolvedValue(null);
      app.dataManager.loadData.mockResolvedValue(null);

      await loadInitialData(asMapApp(app));

      expect(app.aircraftModels).toEqual({});
      expect(app.hasTimingData).toBe(false);
      expect(app.currentData).toBeNull();
      expect(app.selectedYear).toBe("all");
      // No Retry on the toast: the panel on the map has the one
      expect(app.dataManager.loadData).toHaveBeenCalledWith(
        ...loadedFirst("all"),
      );
      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.getAttribute("aria-disabled")).toBe("true");
    });

    it("does not load a year that failed a second time for the layers (regression)", async () => {
      app.dataManager.loadData.mockResolvedValue(null);

      await loadInitialData(asMapApp(app));

      expect(app.dataManager.loadData).toHaveBeenCalledTimes(1);
      expect(app.dataManager.updateLayers).not.toHaveBeenCalled();
    });

    it("keeps created markers accessible for the airport manager", async () => {
      await loadInitialData(asMapApp(app));

      const marker = app.airportMarkers["Frankfurt EDDF"]!;
      expect(marker.getLatLng()).toEqual({ lat: 50.1, lng: 8.67 });
    });

    it("stretches the speed scale over the speeds of the dataset", async () => {
      const segments = Array.from({ length: 101 }, (_, i) =>
        createSegment({ path_id: 1, groundspeed_knots: 40 + i }),
      );
      app.dataManager.loadData.mockResolvedValue(
        createDataset(
          [{ id: 1, year: 2025, aircraft_registration: "D-ABCD" }],
          segments,
        ),
      );

      await loadInitialData(asMapApp(app));

      // The 5th and the 95th of 40 to 140 kt, not the metadata's 10 to 150
      expect(app.airspeedRange).toMatchObject({ min: 45, max: 135 });
    });

    it("gives a year of one speed the metadata's scale, not the year before's", async () => {
      await loadInitialData(asMapApp(app));
      app.airspeedRange = { min: 45, max: 135 };

      publishDataset(
        asMapApp(app),
        createDataset(
          [{ id: 1, year: 2024 }],
          [createSegment({ path_id: 1, groundspeed_knots: 90 })],
        ),
      );

      expect(app.airspeedRange).toEqual({ min: 10, max: 150 });
    });

    it("drops its dataset when the year was switched while it loaded", async () => {
      // A switch that went ahead during the first load had its year
      // covered by this one's dataset
      const newer = createDataset([{ id: 2, year: 2024 }]);
      let loads = 0;
      let switched: Promise<boolean> | undefined;
      app.dataManager.loadData.mockImplementation(() => {
        if (loads++ > 0) return Promise.resolve(newer);
        switched = filterManager.filterByYear("2024");
        return Promise.resolve(data);
      });

      await loadInitialData(asMapApp(app));
      await switched;

      expect(app.selectedYear).toBe("2024");
      expect(app.currentData).toBe(newer);
    });

    it("writes the dropdown before the store announces the year", async () => {
      // The Filter sheet mirrors the dropdown when the store says the year
      // changed, and read the one of before
      const seen: string[] = [];
      app.store.subscribe("selectedYear", () => seen.push(yearSelect().value));

      await loadInitialData(asMapApp(app));

      expect(seen).toEqual(["2025"]);
    });

    describe("when the airports fail to load", () => {
      /** The Retry of the toast that says so */
      const retryOfToast = (): (() => unknown) => {
        const calls = toastMock.showToast.mock.calls as [
          string,
          string,
          { run: () => unknown },
        ][];
        const call = calls
          .filter(([message]) => message === AIRPORTS_FAILED_MESSAGE)
          .pop();
        if (!call) throw new Error("No toast said the airports failed");
        expect(call[1]).toBe("error");
        return call[2].run;
      };

      it("says so with a Retry that puts them on the map", async () => {
        // They were missing without a word, and never asked for again
        app.dataManager.loadAirports.mockResolvedValueOnce(null);
        await loadInitialData(asMapApp(app));
        expect(Object.keys(app.airportMarkers)).toHaveLength(0);
        const retry = retryOfToast();
        app.airportManager.updateAirportPopups.mockClear();
        app.airportManager.updateAirportMarkerSizes.mockClear();

        retry();

        await vi.waitFor(() =>
          expect(Object.keys(app.airportMarkers)).toHaveLength(2),
        );
        expect(app.dataManager.loadAirports).toHaveBeenCalledTimes(2);
        // The home base and the sizes of the zoom, as on the first load
        expect(app.airportManager.updateAirportPopups).toHaveBeenCalled();
        expect(app.airportManager.updateAirportMarkerSizes).toHaveBeenCalled();
        expect(toastMock.dismissToast).toHaveBeenCalledWith(
          AIRPORTS_FAILED_MESSAGE,
        );
      });

      it("loads them once for a double click on its Retry", async () => {
        // The button stays clickable while the toast fades: two loads put
        // a second set of markers on the map
        app.dataManager.loadAirports.mockResolvedValueOnce(null);
        await loadInitialData(asMapApp(app));
        const retry = retryOfToast();
        let resolve!: (list: Airport[]) => void;
        app.dataManager.loadAirports.mockReturnValueOnce(
          new Promise<Airport[]>((r) => (resolve = r)),
        );

        retry();
        retry();
        resolve(airports);

        await vi.waitFor(() =>
          expect(Object.keys(app.airportMarkers)).toHaveLength(2),
        );
        await Promise.resolve();
        expect(app.dataManager.loadAirports).toHaveBeenCalledTimes(2);
        const container = app.map!.getCanvasContainer();
        for (const marker of Object.values(app.airportMarkers)) {
          expect(container.contains(marker.getElement())).toBe(true);
        }
        expect(container.querySelectorAll("button")).toHaveLength(2);
      });

      it("says so under the flights of a year picked after both failed", async () => {
        // Nothing said it then: no airports, no word, no Retry
        app.dataManager.loadAirports.mockResolvedValue(null);
        app.dataManager.loadData.mockResolvedValue(null);
        await loadInitialData(asMapApp(app));
        expect(toastMock.showToast).not.toHaveBeenCalled();
        app.dataManager.loadData.mockResolvedValue(data);

        yearSelect().value = "2024";
        await filterManager.filterByYear();

        expect(app.currentData).toBe(data);
        expect(retryOfToast()).toBeTypeOf("function");
        // Once per failure, not at every load
        toastMock.showToast.mockClear();
        app.dataManager.loadData.mockResolvedValue(
          createDataset([{ id: 2, year: 2025 }], [], 1),
        );
        yearSelect().value = "2025";
        await filterManager.filterByYear();
        expect(toastMock.showToast).not.toHaveBeenCalledWith(
          AIRPORTS_FAILED_MESSAGE,
          expect.anything(),
          expect.anything(),
        );
      });

      it("says so again when the Retry fails as well", async () => {
        app.dataManager.loadAirports.mockResolvedValue(null);
        await loadInitialData(asMapApp(app));
        const retry = retryOfToast();
        toastMock.showToast.mockClear();

        retry();

        await vi.waitFor(() => expect(retryOfToast()).toBeTypeOf("function"));
        expect(app.dataManager.loadAirports).toHaveBeenCalledTimes(2);
        expect(Object.keys(app.airportMarkers)).toHaveLength(0);
      });
    });

    describe("when the year fails to load", () => {
      beforeEach(() => {
        app.dataManager.loadData.mockResolvedValue(null);
      });

      it("keeps the year that failed in the dropdown, which the panel loads again", async () => {
        await loadInitialData(asMapApp(app));

        expect(app.selectedYear).toBe("2025");
        // It showed an empty "Year" placeholder, so that picking the year
        // again was a change; the panel's Retry does that
        expect(yearSelect().value).toBe("2025");
        expect(
          [...yearSelect().options].some((option) => option.disabled),
        ).toBe(false);
      });

      it("says what failed on the panel, in place of a toast", async () => {
        app.dataManager.loadData.mockImplementation(() => {
          // The data manager hands it failures while the map has no flights
          app.dataManager.failureNote!("Could not load the flights of 2025");
          // Heard once the panel is there, and not while it is hidden: a
          // load of all years that brings some hides it unseen
          expect(toastMock.announceStatus).not.toHaveBeenCalled();
          return Promise.resolve(null);
        });

        await loadInitialData(asMapApp(app));

        expect(document.querySelector("#map-empty p")!.textContent).toBe(
          "Could not load the flights of 2025",
        );
        // Heard, as the toast was, and once
        expect(toastMock.announceStatus).toHaveBeenCalledExactlyOnceWith(
          "Could not load the flights of 2025",
        );
        expect(toastMock.showToast).not.toHaveBeenCalled();

        // A failure while it is on screen is heard at once
        app.dataManager.failureNote!("Could not load the flights of 2024");
        expect(toastMock.announceStatus).toHaveBeenLastCalledWith(
          "Could not load the flights of 2024",
        );
      });

      it("says nothing loaded, where a load that worked says which year", async () => {
        await loadInitialData(asMapApp(app));

        expect(toastMock.announceStatus).not.toHaveBeenCalledWith(
          expect.stringMatching(/^Showing/),
        );
      });

      it("hides every airport, which no flights say to show", async () => {
        await loadInitialData(asMapApp(app));

        expect(app.airportManager.showAirports).toHaveBeenCalled();
      });

      it("keeps a year someone picked during the load", async () => {
        app.dataManager.loadData.mockImplementation(() => {
          yearSelect().value = "2024";
          return Promise.resolve(null);
        });

        await loadInitialData(asMapApp(app));

        // Applied once the load is over (applyPendingFilterChanges)
        expect(yearSelect().value).toBe("2024");
      });

      it("says so on the map, and loads the year again from there", async () => {
        const panel = document.getElementById("map-empty")!;
        const loaded = createDataset([{ id: 1, year: 2025 }]);
        await loadInitialData(asMapApp(app));
        expect(panel.hidden).toBe(false);
        const retry = vi
          .spyOn(filterManager, "loadShownYear")
          .mockImplementation(() => {
            // Hidden while it loads: the loading indicator takes its place
            expect(panel.hidden).toBe(true);
            app.currentData = loaded;
            return Promise.resolve(true);
          });

        document.getElementById("map-empty-retry")!.click();

        expect(retry).toHaveBeenCalledTimes(1);
        // The failures of loads it said are being acted on, and no other
        // error on screen is taken with them (regression)
        expect(app.dataManager.dismissFailures).toHaveBeenCalled();
        expect(toastMock.dismissToast).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(panel.hidden).toBe(true));
      });

      it("offers no second Retry on the toast of the failure", async () => {
        await loadInitialData(asMapApp(app));

        // The panel's Retry is the one; two of them at once, styled apart,
        // were two ways of doing one thing
        expect(app.dataManager.loadData).toHaveBeenCalledWith(
          ...loadedFirst("2025"),
        );
      });

      it("takes the keyboard to its Retry as it appears", async () => {
        await loadInitialData(asMapApp(app));

        expect(document.activeElement).toBe(
          document.getElementById("map-empty-retry"),
        );
      });

      it("leaves the focus where someone put it meanwhile", async () => {
        const elsewhere = document.createElement("button");
        document.body.append(elsewhere);
        app.dataManager.loadData.mockImplementation(() => {
          elsewhere.focus();
          return Promise.resolve(null);
        });

        await loadInitialData(asMapApp(app));

        expect(document.activeElement).toBe(elsewhere);
        elsewhere.remove();
      });

      it("shows the panel again when the retry fails too", async () => {
        const panel = document.getElementById("map-empty")!;
        await loadInitialData(asMapApp(app));
        vi.spyOn(filterManager, "loadShownYear").mockResolvedValue(false);

        document.getElementById("map-empty-retry")!.click();

        expect(panel.hidden).toBe(true);
        await vi.waitFor(() => expect(panel.hidden).toBe(false));
      });

      it("shows what is made of the flights unavailable until a Retry brings them", async () => {
        const wrapped = document.getElementById("wrapped-btn")!;
        await loadInitialData(asMapApp(app));
        vi.spyOn(filterManager, "loadShownYear").mockImplementation(() => {
          app.currentData = createDataset([{ id: 1, year: 2025 }]);
          return Promise.resolve(true);
        });

        expect(wrapped.getAttribute("aria-disabled")).toBe("true");
        expect(wrapped.title).toBe(NO_DATA_MESSAGE);

        document.getElementById("map-empty-retry")!.click();

        await vi.waitFor(() =>
          expect(wrapped.getAttribute("aria-disabled")).toBe("false"),
        );
        expect(wrapped.title).toBe("Wrapped");
      });

      it("stays out of the way of a year picked from the dropdown", async () => {
        // It came back next to the loading indicator, saying the old
        // failure, while the year picked loaded (and once a Retry that
        // such a pick replaced was over)
        const panel = document.getElementById("map-empty")!;
        await loadInitialData(asMapApp(app));
        expect(panel.hidden).toBe(false);
        let resolve!: (loaded: KMLDataset | null) => void;
        app.dataManager.loadData.mockReturnValue(
          new Promise((done) => (resolve = done)),
        );
        const announced = toastMock.announceStatus.mock.calls.length;

        const switching = filterManager.filterByYear("2024");

        expect(panel.hidden).toBe(true);
        resolve(null);
        await switching;
        expect(panel.hidden).toBe(false);
        // Said again as it comes back with the failure of the year picked
        expect(toastMock.announceStatus.mock.calls.length).toBe(announced + 1);
      });

      it("loads the airports again with the flights when they failed too", async () => {
        app.dataManager.loadAirports.mockResolvedValueOnce(null);
        await loadInitialData(asMapApp(app));
        expect(Object.keys(app.airportMarkers)).toHaveLength(0);
        const markersAtPublish: number[] = [];
        app.store.subscribe("currentData", () =>
          markersAtPublish.push(Object.keys(app.airportMarkers).length),
        );
        app.dataManager.loadData.mockResolvedValue(data);

        document.getElementById("map-empty-retry")!.click();

        await vi.waitFor(() => expect(app.currentData).toBe(data));
        // There before the dataset that says which of them show
        expect(markersAtPublish).toEqual([2]);
        expect(app.dataManager.loadAirports).toHaveBeenCalledTimes(2);
      });

      it("says the airports are missing when they fail again under flights that came", async () => {
        // No toast beside the note on the map, whose Retry loads both
        app.dataManager.loadAirports.mockResolvedValue(null);
        await loadInitialData(asMapApp(app));
        expect(toastMock.showToast).not.toHaveBeenCalled();
        app.dataManager.loadData.mockResolvedValue(data);

        document.getElementById("map-empty-retry")!.click();

        await vi.waitFor(() =>
          expect(toastMock.showToast).toHaveBeenCalledWith(
            AIRPORTS_FAILED_MESSAGE,
            "error",
            expect.objectContaining({ label: "Retry" }),
          ),
        );
        expect(app.currentData).toBe(data);
      });

      it("leaves airports that are there alone on a Retry", async () => {
        await loadInitialData(asMapApp(app));

        document.getElementById("map-empty-retry")!.click();
        await vi.waitFor(() =>
          expect(app.dataManager.loadData).toHaveBeenCalledTimes(2),
        );

        expect(app.dataManager.loadAirports).toHaveBeenCalledTimes(1);
      });

      it("hands the focus of its Retry to the map as it hides", async () => {
        document.body.append(app.map!.getCanvas());
        app.map!.getCanvas().tabIndex = 0;
        await loadInitialData(asMapApp(app));
        const retry = document.getElementById("map-empty-retry")!;
        retry.focus();

        retry.click();

        expect(document.activeElement).toBe(app.map!.getCanvas());
      });
    });

    it("takes in the list of years that a load of all years brings after all", async () => {
      // metadata.json failed once; the load of all years asks for it again
      // (DataLoader.loadAllYears), and the page went on without years,
      // speeds and model names, with the toast saying they were missing
      app.selectedYear = "2025";
      yearSelect().add(new Option("2025", "2025", true, true));
      app.dataManager.loadMetadata.mockResolvedValue(null);
      const atPublish: unknown[] = [];
      app.store.subscribe("currentData", () =>
        atPublish.push(app.hasTimingData, { ...app.metadataAirspeedRange }),
      );
      app.dataManager.loadData.mockImplementation(() => {
        app.dataManager.onMetadata!(metadata);
        return Promise.resolve(data);
      });

      await loadInitialData(asMapApp(app));

      expect([...yearSelect().options].map((option) => option.value)).toEqual([
        "all",
        "2024",
        "2025",
      ]);
      // The dropdown keeps the year loading, which is the one published
      expect(yearSelect().value).toBe("all");
      expect(app.selectedYear).toBe("all");
      // Taken in before the dataset draws the layers
      expect(atPublish).toEqual([true, { min: 10, max: 150 }]);
      expect(app.aircraftModels).toBe(metadata.aircraft_models);
      const btn = document.getElementById("airspeed-btn") as HTMLButtonElement;
      expect(btn.getAttribute("aria-disabled")).toBe("false");
      expect(toastMock.dismissToast).toHaveBeenCalledWith(
        "The list of years is unavailable, showing all years",
      );
      // Reset view goes to the newest year, as on a first visit with the
      // list; it stayed at all years
      expect(app.defaultYear).toBe("2025");
    });

    it("brings back a restored speed layer with late metadata that has speeds", async () => {
      app.airspeedVisible = true;
      app.dataManager.loadMetadata.mockResolvedValue(null);
      const atPublish: boolean[] = [];
      app.store.subscribe("currentData", () =>
        atPublish.push(app.airspeedVisible),
      );
      app.dataManager.loadData.mockImplementation(() => {
        // Put away while it was not known whether there are speeds
        expect(app.airspeedVisible).toBe(false);
        app.dataManager.onMetadata!(metadata);
        return Promise.resolve(data);
      });

      await loadInitialData(asMapApp(app));

      expect(atPublish).toEqual([true]);
    });

    it("waits for no late list of years when the first load had one", async () => {
      await loadInitialData(asMapApp(app));

      expect(app.dataManager.onMetadata).toBeNull();
    });

    it("keeps a year picked before the list of years came", async () => {
      // The template names the latest year; "All years" was picked while
      // the list loaded, which the bound handler leaves to the first load
      yearSelect().add(new Option("2025", "2025", true, true));
      app.dataManager.loadMetadata.mockImplementation(() => {
        yearSelect().value = "all";
        return Promise.resolve(metadata);
      });

      await loadInitialData(asMapApp(app));

      expect(app.selectedYear).toBe("all");
      expect(yearSelect().value).toBe("all");
      expect(app.dataManager.loadData).toHaveBeenCalledExactlyOnceWith(
        ...loadedFirst("all"),
      );
    });

    it("drops a restored path whose flight is gone, and isolation with the last", async () => {
      // A link to every year: only their dataset knows every flight
      app.selectedYear = "all";
      (app as { restoredYearFromState: boolean }).restoredYearFromState = true;
      app.selectedPathIds = new Set([840108108563]);
      app.isolateSelection = true;

      await loadInitialData(asMapApp(app));

      expect(app.selectedYear).toBe("all");
      expect(app.selectedPathIds.size).toBe(0);
      expect(app.isolateSelection).toBe(false);
    });

    it("keeps a shared flight a year's dataset does not have, which another year may", async () => {
      app.selectedPathIds = new Set([840108108563]);
      app.isolateSelection = true;

      await loadInitialData(asMapApp(app));

      // The chip says the filter hides it; the link still hands it on
      expect(app.selectedYear).not.toBe("all");
      expect([...app.selectedPathIds]).toEqual([840108108563]);
      expect(app.isolateSelection).toBe(true);
    });

    it("keeps no restored path the dataset does not have", async () => {
      app.selectedPathIds = new Set([1, 99]);
      const selections: number[][] = [];
      app.store.subscribe("currentData", () => {
        selections.push([...app.selectedPathIds]);
      });

      await loadInitialData(asMapApp(app));

      // Nobody sees the new dataset with the stale id still selected
      expect(selections).toEqual([[1]]);
    });
  });

  describe("colorSegmentPopups", () => {
    it("colours a metric as it is written into a popup", async () => {
      const map = document.createElement("div");
      map.id = "map";
      map.innerHTML = '<div class="maplibregl-popup"></div>';
      document.body.appendChild(map);

      const lifetime = new AbortController();
      colorSegmentPopups(lifetime.signal);
      const content = document.createElement("div");
      content.innerHTML =
        '<div class="kh-popup-metric-colored" data-metric-color="rgb(1, 2, 3)"></div>';
      map.firstElementChild!.appendChild(content);
      await Promise.resolve();

      const metric = content.firstElementChild as HTMLElement;
      expect(metric.style.getPropertyValue("--kh-metric-color")).toBe(
        "rgb(1, 2, 3)",
      );

      // Not once the app is gone
      lifetime.abort();
      const later = document.createElement("div");
      later.innerHTML =
        '<div class="kh-popup-metric-colored" data-metric-color="rgb(4, 5, 6)"></div>';
      map.firstElementChild!.appendChild(later);
      await Promise.resolve();
      expect(
        (later.firstElementChild as HTMLElement).style.getPropertyValue(
          "--kh-metric-color",
        ),
      ).toBe("");
      map.remove();
    });

    it("does nothing without a map", () => {
      expect(() =>
        colorSegmentPopups(new AbortController().signal),
      ).not.toThrow();
    });
  });
});
