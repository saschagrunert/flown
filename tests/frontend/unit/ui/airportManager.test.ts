import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  AirportManager,
  popupOffsets,
} from "../../../../flown/frontend/ui/airportManager";
import { createAirportMarkers } from "../../../../flown/frontend/appInitializer";
import {
  resetSiteData,
  siteData,
} from "../../../../flown/frontend/state/siteData";
import {
  DOUBLE_TAP_MS,
  panPopupIntoView,
} from "../../../../flown/frontend/utils/mapHelpers";
import * as motion from "../../../../flown/frontend/utils/motion";
import type { AirportMarker, PathInfo } from "../../../../flown/frontend/types";
import { MAP_SOURCES } from "../../../../flown/frontend/utils/constants";
import { AirportCodes } from "../../../../flown/frontend/ui/airportLabels";
import {
  createMockApp,
  createDataset,
  asMapApp,
  type MockApp,
} from "../../testHelpers";
import type { Popup as MockPopup } from "../../../mocks/maplibre-gl";
import { REPLAY_CAMERA_MOVE } from "../../../../flown/frontend/utils/mapHelpers";

const { loadFeatures, listFlights } = vi.hoisted(() => ({
  listFlights: vi.fn(),
  loadFeatures: vi.fn(),
}));
vi.mock("../../../../flown/frontend/ui/airportFlights", () => ({
  listFlights,
}));
vi.mock("../../../../flown/frontend/services/featureLoader", () => ({
  loadedFeatures: () => null,
  loadFeatures,
}));
vi.mock(
  "../../../../flown/frontend/utils/mapHelpers",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../../../../flown/frontend/utils/mapHelpers")
    >()),
    panPopupIntoView: vi.fn(),
  }),
);

/** The count the popup shows, as its markup */
function countHtml(count: number): string {
  return `<span class="popup-metric-value kh-popup-accent">${count}</span>`;
}

/** Let the feature bundle "load" */
/** jsdom does not track how focus arrived; say it here */
function focusVisible(element: HTMLElement, visible: boolean): void {
  Object.defineProperty(element, "matches", {
    configurable: true,
    value: (selector: string) => visible && selector === ":focus-visible",
  });
}

describe("AirportManager", () => {
  let airportManager: AirportManager;
  let mockApp: MockApp;
  let markers: Record<string, AirportMarker>;
  let mapContainer: HTMLElement;
  /** The popup the manager shares between the airports */
  let popup: MockPopup;

  const pathInfo: PathInfo[] = [
    {
      id: 1,
      year: 2025,
      aircraft_registration: "D-ABCD",
      start_airport: "EDDF",
      end_airport: "EDDM",
    },
    {
      id: 2,
      year: 2025,
      aircraft_registration: "D-EFGH",
      start_airport: "EDDM",
      end_airport: "EDDF",
    },
    {
      id: 3,
      year: 2024,
      aircraft_registration: "D-ABCD",
      start_airport: "EDDF",
      end_airport: "EDDK",
    },
  ];

  const airports = [
    { name: "EDDF", lat: 50.1, lon: 8.67, code: "EDDF" },
    { name: "EDDM", lat: 48.35, lon: 11.78, code: "EDDM" },
    { name: "EDDK", lat: 50.87, lon: 7.14, code: "EDDK" },
    { name: "LOWW", lat: 48.11, lon: 16.57, code: "LOWW" },
  ];

  function isHome(name: string): boolean {
    return (
      markers[name]!.getElement().querySelector(".airport-marker-home") !== null
    );
  }

  beforeEach(() => {
    // In the document, so that the markers and the popup can take focus
    mapContainer = document.createElement("div");
    mapContainer.id = "map";
    document.body.appendChild(mapContainer);

    siteData.airports = airports.map((airport) => ({ ...airport }));
    mockApp = createMockApp({ currentData: createDataset(pathInfo) });
    airportManager = new AirportManager(asMapApp(mockApp));
    // The markers are the app's own, wired to this manager like the app's
    (mockApp as unknown as { airportManager: AirportManager }).airportManager =
      airportManager;
    createAirportMarkers(asMapApp(mockApp), siteData.airports);
    markers = mockApp.airportMarkers;
    popup = (airportManager as unknown as { popup: MockPopup }).popup;
  });

  afterEach(() => {
    resetSiteData();
    document.body.innerHTML = "";
    listFlights.mockReset();
    loadFeatures.mockClear();
    vi.mocked(panPopupIntoView).mockClear();
  });

  describe("the shared popup", () => {
    it("is one popup that leaves focus and width to the app", () => {
      const { offset, ...options } = popup.options;
      expect(options).toEqual({
        focusAfterOpen: false,
        maxWidth: "none",
        // MapLibre would close it in the click on the marker that opened
        // it; MapApp's click dispatcher closes it instead
        closeOnClick: false,
      });
      // Every side MapLibre may hang it on: one left out would be [0, 0],
      // over the dot. At the edge of the dot's pointer target until there
      // is a code to clear (popupOffsets)
      expect(offset).toEqual({
        center: [0, 0],
        top: [0, 12],
        "top-left": [0, 12],
        "top-right": [0, 12],
        bottom: [0, -12],
        "bottom-left": [0, -12],
        "bottom-right": [0, -12],
        left: [12, 0],
        right: [-12, 0],
      });
      // `setPopup` brings click and key handling that would toggle twice
      for (const marker of Object.values(markers)) {
        expect(marker.marker.getPopup()).toBeNull();
      }
    });

    it("opens on the marker with the counts of the current filter", () => {
      markers["EDDF"]!.openPopup();

      expect(popup.isOpen()).toBe(true);
      expect(popup.map).toBe(mockApp.map);
      expect(popup.getLngLat()).toMatchObject({ lng: 8.67, lat: 50.1 });
      const html = popup.getElement().innerHTML;
      expect(html).toContain("EDDF");
      expect(html).toContain(countHtml(3));
      expect(html).toContain("https://www.google.com/maps?q=50.1,8.67");
      expect(html).toContain("HOME");
      expect(markers["EDDF"]!.isPopupOpen()).toBe(true);
      expect(markers["EDDM"]!.isPopupOpen()).toBe(false);
      expect(airportManager.isPopupOpen()).toBe(true);
    });

    it("closes once the globe has turned its airport away", () => {
      mockApp.map!.setProjection({ type: "globe" });
      markers["EDDF"]!.openPopup();

      mockApp.map!.jumpTo({ center: [60, 40] });
      mockApp.map!.emit("move");
      expect(popup.isOpen()).toBe(true);

      mockApp.map!.jumpTo({ center: [-160, 40] });
      mockApp.map!.emit("move");
      expect(popup.isOpen()).toBe(false);
      expect(airportManager.isPopupOpen()).toBe(false);
    });

    it("writes the content when it opens, not before", () => {
      airportManager.updateAirportPopups();

      expect(popup.setHTML).not.toHaveBeenCalled();
    });

    it("moves to another airport without closing in between", () => {
      const closed = vi.fn();
      popup.on("close", closed);
      markers["EDDF"]!.openPopup();
      markers["EDDF"]!.getControl().focus();

      markers["EDDM"]!.openPopup();

      expect(popup.addTo).toHaveBeenCalledTimes(1);
      expect(closed).not.toHaveBeenCalled();
      expect(popup.getLngLat()).toMatchObject({ lng: 11.78, lat: 48.35 });
      expect(popup.getElement().innerHTML).toContain("EDDM");
      expect(popup.getElement().innerHTML).not.toContain("HOME");
      expect(markers["EDDF"]!.isPopupOpen()).toBe(false);
      expect(markers["EDDM"]!.isPopupOpen()).toBe(true);
    });

    it("shows zero flights for airports outside the filter", () => {
      markers["LOWW"]!.openPopup();

      expect(popup.getElement().innerHTML).toContain(countHtml(0));
    });

    it("rewrites the open popup when the filter changes", () => {
      markers["EDDF"]!.openPopup();
      // The filter change reaches the manager through the store
      mockApp.selectedAircraft = "D-EFGH";

      expect(popup.setHTML).toHaveBeenCalledTimes(2);
      expect(popup.addTo).toHaveBeenCalledTimes(1);
      expect(popup.getElement().innerHTML).toContain(countHtml(1));
    });

    it("leaves a closed popup alone when the filter changes", () => {
      markers["EDDF"]!.openPopup();
      markers["EDDF"]!.closePopup();
      popup.setHTML.mockClear();

      mockApp.selectedAircraft = "D-EFGH";

      expect(popup.setHTML).not.toHaveBeenCalled();
    });

    it("closes only for the airport it is open for", () => {
      markers["EDDF"]!.openPopup();

      markers["EDDM"]!.closePopup();
      expect(popup.isOpen()).toBe(true);

      markers["EDDF"]!.closePopup();
      expect(popup.isOpen()).toBe(false);
      expect(markers["EDDF"]!.isPopupOpen()).toBe(false);
      expect(airportManager.isPopupOpen()).toBe(false);
    });

    it("does nothing for an unknown airport or without a map", () => {
      airportManager.openPopup("NOPE");
      expect(popup.isOpen()).toBe(false);

      mockApp.map = null;
      airportManager.openPopup("EDDF");
      expect(popup.isOpen()).toBe(false);
    });

    it("recounts when the dataset is replaced, even at the same size", () => {
      markers["EDDF"]!.openPopup();
      expect(popup.getElement().innerHTML).toContain(countHtml(3));

      // Same year, same aircraft filter and the same number of paths, but a
      // different dataset: counts keyed on the size alone would go stale
      mockApp.currentData = createDataset([
        { id: 1, year: 2025, start_airport: "EDDM", end_airport: "EDDK" },
        { id: 2, year: 2025, start_airport: "EDDM", end_airport: "EDDK" },
        { id: 3, year: 2025, start_airport: "EDDM", end_airport: "EDDK" },
      ]);

      expect(popup.getElement().innerHTML).toContain(countHtml(0));
      markers["EDDM"]!.openPopup();
      expect(popup.getElement().innerHTML).toContain(countHtml(3));
    });
  });

  describe("the flight list and the pan into view", () => {
    it("lists the flights once the content is written, then pans", () => {
      const order: string[] = [];
      popup.setHTML.mockImplementationOnce((html: string) => {
        order.push("setHTML");
        popup
          .getElement()
          .querySelector(".maplibregl-popup-content")!.innerHTML = html;
        return popup;
      });
      popup.addTo.mockImplementationOnce(function (this: MockPopup) {
        order.push("addTo");
        return this;
      });
      listFlights.mockImplementation(() => order.push("listFlights"));
      vi.mocked(panPopupIntoView).mockImplementation(() => {
        order.push("pan");
      });
      popup.setLngLat.mockClear();

      markers["EDDF"]!.openPopup();

      expect(listFlights).toHaveBeenCalledWith(mockApp, popup, "EDDF");
      // The list goes into the element of a popup that is on the map
      expect(order).toEqual(["setHTML", "addTo", "listFlights", "pan"]);
      // Placed, then laid out again for the height the list added
      expect(popup.setLngLat).toHaveBeenCalledTimes(2);
      expect(popup.getLngLat()).toMatchObject({ lng: 8.67, lat: 50.1 });
      expect(panPopupIntoView).toHaveBeenCalledWith(
        mockApp.map,
        popup,
        50,
        true,
      );
    });

    it("fetches no bundle for the list (regression)", () => {
      // The list lived in the feature bundle, which the first popup fetched
      // with its stylesheet: 15 KB gzipped for a list of a few buttons
      markers["EDDF"]!.openPopup();

      expect(listFlights).toHaveBeenCalledTimes(1);
      expect(loadFeatures).not.toHaveBeenCalled();
    });

    it("lists them again whenever the content is rewritten", () => {
      markers["EDDF"]!.openPopup();
      mockApp.selectedAircraft = "D-EFGH";

      expect(listFlights).toHaveBeenCalledTimes(2);
      expect(panPopupIntoView).toHaveBeenCalledTimes(2);
    });

    it("pans without animation under reduced motion", () => {
      const reduced = vi
        .spyOn(motion, "prefersReducedMotion")
        .mockReturnValue(true);

      markers["EDDF"]!.openPopup();
      reduced.mockRestore();

      expect(panPopupIntoView).toHaveBeenCalledWith(
        mockApp.map,
        popup,
        50,
        false,
      );
    });

    it("lists nothing for a closed popup", () => {
      markers["EDDF"]!.openPopup();
      markers["EDDF"]!.closePopup();
      listFlights.mockClear();

      mockApp.selectedAircraft = "D-EFGH";

      expect(listFlights).not.toHaveBeenCalled();
    });

    it("lists the flights of the airport the popup moved to", () => {
      markers["EDDF"]!.openPopup();
      markers["EDDM"]!.openPopup();

      expect(listFlights).toHaveBeenCalledTimes(2);
      expect(listFlights).toHaveBeenLastCalledWith(mockApp, popup, "EDDM");
    });
  });

  describe("a second activation of a marker", () => {
    let clickAt = 0;

    /**
     * A click as the browser reports it: `detail` counts a burst of them.
     * Each comes later than a double tap would, so only `detail` makes one.
     */
    function click(name: string, detail = 1): void {
      const event = new MouseEvent("click", { bubbles: true, detail });
      clickAt += DOUBLE_TAP_MS;
      Object.defineProperty(event, "timeStamp", { value: clickAt });
      markers[name]!.getElement().dispatchEvent(event);
    }

    function expanded(name: string): string | null {
      return markers[name]!.getControl().getAttribute("aria-expanded");
    }

    it("closes the popup it opened, as the airplane's does", () => {
      expect(expanded("EDDF")).toBe("false");

      click("EDDF");
      expect(popup.isOpen()).toBe(true);
      expect(expanded("EDDF")).toBe("true");

      click("EDDF");
      expect(popup.isOpen()).toBe(false);
      expect(expanded("EDDF")).toBe("false");
      // Closing selects nothing a second time
      expect(mockApp.pathSelection.selectPathsByAirport).toHaveBeenCalledTimes(
        1,
      );
    });

    it("moves the popup to another airport without closing it", () => {
      const closed = vi.fn();
      popup.on("close", closed);
      click("EDDF");

      click("EDDM");

      expect(closed).not.toHaveBeenCalled();
      expect(popup.addTo).toHaveBeenCalledTimes(1);
      expect(markers["EDDM"]!.isPopupOpen()).toBe(true);
      expect(expanded("EDDF")).toBe("false");
      expect(expanded("EDDM")).toBe("true");
      // The marker whose popup is open names it
      const controls = (name: string): string | null =>
        markers[name]!.getControl().getAttribute("aria-controls");
      expect(controls("EDDF")).toBeNull();
      expect(controls("EDDM")).toBe("airport-popup");
    });

    it("keeps the popup open through a double click or a double tap", () => {
      click("EDDF", 1);
      click("EDDF", 2);
      click("EDDF", 3);

      expect(popup.isOpen()).toBe(true);
      expect(expanded("EDDF")).toBe("true");
    });

    it("closes from the keyboard and leaves focus on the marker", () => {
      const element = markers["EDDF"]!.getControl();
      element.focus();
      // Enter and Space reach a button as a click with a `detail` of 0
      click("EDDF", 0);
      expect(popup.isOpen()).toBe(true);

      element.focus();
      click("EDDF", 0);

      expect(popup.isOpen()).toBe(false);
      expect(document.activeElement).toBe(element);
      expect(expanded("EDDF")).toBe("false");
    });

    it("reports a popup closed by its button or the map as closed", () => {
      click("EDDF");

      // The close button and a click on the map both end in `remove`
      popup.remove();

      expect(expanded("EDDF")).toBe("false");
    });
  });

  describe("popup keyboard access", () => {
    it("moves focus into a popup opened from the keyboard", () => {
      const element = markers["EDDF"]!.getControl();
      element.focus();
      focusVisible(element, true);

      markers["EDDF"]!.openPopup();

      const container = popup.getElement().querySelector(".popup-container");
      expect(container).not.toBeNull();
      expect(document.activeElement).toBe(container);
    });

    it("leaves focus alone when a pointer opened the popup", () => {
      const element = markers["EDDF"]!.getControl();
      element.focus();
      focusVisible(element, false);

      markers["EDDF"]!.openPopup();

      expect(document.activeElement).toBe(element);
    });

    it("puts focus back on the marker when the popup had it", () => {
      markers["EDDF"]!.openPopup();
      popup
        .getElement()
        .querySelector<HTMLElement>(".popup-container")!
        .focus();

      // Closing takes the popup, and the focus in it, out of the document
      popup.remove();

      expect(document.activeElement).toBe(markers["EDDF"]!.getControl());
    });

    it("puts focus back on the marker rather than on the page", () => {
      markers["EDDF"]!.openPopup();
      (document.activeElement as HTMLElement | null)?.blur();

      markers["EDDF"]!.closePopup();

      expect(document.activeElement).toBe(markers["EDDF"]!.getControl());
    });

    it("does not take focus from wherever the user went", () => {
      markers["EDDF"]!.openPopup();
      const elsewhere = document.createElement("button");
      document.body.append(elsewhere);
      elsewhere.focus();

      markers["EDDF"]!.closePopup();

      expect(document.activeElement).toBe(elsewhere);
    });

    it("leaves focus alone when nothing was open", () => {
      airportManager.closePopup();

      expect(document.activeElement).toBe(document.body);
    });

    it("closes the popup on Escape from the marker", () => {
      const element = markers["EDDF"]!.getElement();
      markers["EDDF"]!.openPopup();

      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
      );
      expect(popup.isOpen()).toBe(true);

      element.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(popup.isOpen()).toBe(false);
    });

    it("keeps another airport's popup on Escape", () => {
      markers["EDDM"]!.openPopup();

      markers["EDDF"]!.getElement().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      expect(popup.isOpen()).toBe(true);
    });
  });

  describe("updateAirportPopups", () => {
    it("marks the home base on its marker", () => {
      airportManager.updateAirportPopups();

      expect(isHome("EDDF")).toBe(true);
      for (const name of ["EDDM", "EDDK", "LOWW"]) {
        expect(isHome(name)).toBe(false);
      }
    });

    it("moves the home base when the filter changes, on the same elements", () => {
      airportManager.updateAirportPopups();
      const eddf = markers["EDDF"]!.getElement();

      // Only path 2 (EDDM -> EDDF) matches: tie, first wins (EDDM)
      mockApp.selectedAircraft = "D-EFGH";

      expect(isHome("EDDF")).toBe(false);
      expect(isHome("EDDM")).toBe(true);
      expect(markers["EDDF"]!.getElement()).toBe(eddf);
    });

    it("skips airports without markers", () => {
      siteData.airports!.push({ name: "NEW", lat: 1, lon: 1 });
      expect(() => airportManager.updateAirportPopups()).not.toThrow();
    });
  });

  describe("showAirports", () => {
    function hidden(): string[] {
      return Object.keys(markers).filter(
        (name) => markers[name]!.getElement().hidden,
      );
    }

    it("shows all airports when no filters or selection", () => {
      for (const marker of Object.values(markers)) marker.setVisible(false);

      airportManager.showAirports();

      expect(hidden()).toEqual([]);
    });

    it("shows none without a dataset, whose flights would say which", () => {
      // A first load that failed left the dots of every year on the map,
      // unlabelled (regression)
      mockApp.currentData = null;

      airportManager.showAirports();

      expect(hidden()).toEqual(Object.keys(markers));
    });

    it("shows only airports matching the year filter", () => {
      mockApp.selectedYear = "2024";

      expect(hidden()).toEqual(["EDDM", "LOWW"]);
    });

    it("shows only airports matching the aircraft filter", () => {
      mockApp.selectedAircraft = "D-EFGH";

      expect(hidden()).toEqual(["EDDK", "LOWW"]);
    });

    it("adds no airport of a selected flight the filter hides", () => {
      // Share mode keeps such a flight, which the map does not draw; its
      // airports showed all the same
      mockApp.selectedYear = "2025";
      // Path 3 flew in 2024, to EDDK
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 3]);

      airportManager.showAirports();

      expect(hidden()).toEqual(["EDDK", "LOWW"]);
    });

    it("keeps every airport for a selection without a filter (regression)", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 3]);

      airportManager.showAirports();

      expect(hidden()).toEqual([]);
    });

    it("only shows airports of selected paths in share mode", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 3]);
      mockApp.isolateSelection = true;

      expect(hidden()).toEqual(["EDDM", "LOWW"]);

      // Of those the filter shows: none, where it hides the one shared
      mockApp.selectedYear = "2025";
      expect(hidden()).toEqual(["EDDF", "EDDM", "EDDK", "LOWW"]);
    });

    it("shows hidden markers that become visible again", () => {
      mockApp.selectedYear = "2024";
      expect(hidden()).toEqual(["EDDM", "LOWW"]);

      mockApp.selectedYear = "all";

      expect(hidden()).toEqual([]);
    });

    it("never takes a marker off the map", () => {
      mockApp.selectedYear = "2024";

      for (const marker of Object.values(markers)) {
        expect(marker.marker.remove).not.toHaveBeenCalled();
      }
    });

    it("closes the popup of a marker that gets hidden", () => {
      markers["EDDM"]!.openPopup();

      mockApp.selectedYear = "2024";

      expect(popup.isOpen()).toBe(false);
    });

    it("keeps a shared airport whose last flight is unticked in its popup until it closes", () => {
      // Share mode with two flights: path 3 is the only one at EDDK
      mockApp.selectedPathIds = new Set([2, 3]);
      mockApp.isolateSelection = true;
      expect(hidden()).toEqual(["LOWW"]);
      markers["EDDK"]!.openPopup();
      const labels = mockApp.map!.source(MAP_SOURCES.airportLabels).setData;

      mockApp.selectedPathIds = new Set([2]);

      // The popup and the focus in it stay for the next tick
      expect(popup.isOpen()).toBe(true);
      expect(hidden()).toEqual(["LOWW"]);
      const shown = (
        labels.mock.lastCall![0] as GeoJSON.FeatureCollection<
          GeoJSON.Point,
          { name: string }
        >
      ).features.map((label) => label.properties.name);
      expect(shown).toContain("EDDK");

      // Closed, the airport goes. The focus, which was in the popup, falls
      // to the page with it, and goes to the map rather than the marker.
      (document.activeElement as HTMLElement | null)?.blur();
      const canvas = mockApp.map!.getCanvas();
      canvas.tabIndex = 0;
      document.body.append(canvas);
      popup.remove();
      expect(hidden()).toEqual(["EDDK", "LOWW"]);
      expect(document.activeElement).toBe(mockApp.map!.getCanvas());
    });

    it("hides the airport a kept popup moves away from", () => {
      mockApp.selectedPathIds = new Set([2, 3]);
      mockApp.isolateSelection = true;
      markers["EDDK"]!.openPopup();
      mockApp.selectedPathIds = new Set([2]);

      markers["EDDF"]!.openPopup();

      expect(hidden()).toEqual(["EDDK", "LOWW"]);
      expect(airportManager.isPopupOpen("EDDF")).toBe(true);
    });

    it("keeps the popup of a marker that stays", () => {
      markers["EDDF"]!.openPopup();

      mockApp.selectedYear = "2024";

      expect(popup.isOpen()).toBe(true);
      expect(markers["EDDF"]!.isPopupOpen()).toBe(true);
    });
  });

  describe("updateAirportMarkerSizes", () => {
    it("does nothing if map is not initialized", () => {
      mockApp.map = null;
      airportManager.updateAirportMarkerSizes();
      expect(mapContainer.dataset["zoomSize"]).toBeUndefined();
    });

    // Map units: one below the Leaflet zooms the sizes were tuned at
    it.each([
      [13, "xlarge"],
      [12.9, "large"],
      [11, "large"],
      [9, "medium"],
      [7, "medium-small"],
      [5, "small"],
      [4.9, ""],
      [2, ""],
      // A continent in a few hundred pixels: a clump of dots
      [1.9, "hidden"],
      [0, "hidden"],
    ])("sets data-zoom-size for zoom %s", (zoom, expected) => {
      mockApp.map!.getZoom.mockReturnValue(zoom);

      airportManager.updateAirportMarkerSizes();

      expect(mapContainer.dataset["zoomSize"]).toBe(expected);
    });

    it("does nothing without a map container", () => {
      mapContainer.remove();
      expect(() => airportManager.updateAirportMarkerSizes()).not.toThrow();
    });
  });

  describe("activateAirport", () => {
    it("selects the airport's paths, then opens its popup", () => {
      const order: string[] = [];
      mockApp.pathSelection.selectPathsByAirport.mockImplementation(() =>
        order.push("select"),
      );
      const open = vi
        .spyOn(airportManager, "openPopup")
        .mockImplementation(() => order.push("open"));

      airportManager.activateAirport("EDDF");

      expect(mockApp.pathSelection.selectPathsByAirport).toHaveBeenCalledWith(
        "EDDF",
      );
      expect(open).toHaveBeenCalledWith("EDDF");
      expect(order).toEqual(["select", "open"]);
    });

    it("only opens the popup for a finger, which never selects", () => {
      airportManager.activateAirport("EDDF", true);

      expect(mockApp.pathSelection.selectPathsByAirport).not.toHaveBeenCalled();
      expect(airportManager.isPopupOpen("EDDF")).toBe(true);
    });

    it("closes the popup it has open and selects nothing", () => {
      airportManager.openPopup("EDDF");
      mockApp.pathSelection.selectPathsByAirport.mockClear();

      airportManager.activateAirport("EDDF");

      expect(popup.isOpen()).toBe(false);
      expect(mockApp.pathSelection.selectPathsByAirport).not.toHaveBeenCalled();
    });

    it("moves the popup to another airport", () => {
      airportManager.openPopup("EDDF");

      airportManager.activateAirport("EDDM");

      expect(airportManager.isPopupOpen("EDDM")).toBe(true);
    });

    it("opens the popup but leaves the selection alone while replay runs", () => {
      mockApp.replayActive = true;

      airportManager.activateAirport("EDDF");

      expect(mockApp.pathSelection.selectPathsByAirport).not.toHaveBeenCalled();
      expect(airportManager.isPopupOpen("EDDF")).toBe(true);
    });

    it("opens the popup but leaves the selection alone while the hotspot tour runs", () => {
      mockApp.tourView = {} as NonNullable<MockApp["tourView"]>;

      airportManager.activateAirport("EDDF");

      expect(mockApp.pathSelection.selectPathsByAirport).not.toHaveBeenCalled();
      expect(airportManager.isPopupOpen("EDDF")).toBe(true);
    });

    it("only opens the popup over a selection, in share mode or not", () => {
      // The home base's hundreds of flights joined the two or three picked
      mockApp.selectedPathIds = new Set([7]);

      airportManager.activateAirport("EDDF");
      expect(airportManager.isPopupOpen("EDDF")).toBe(true);

      mockApp.isolateSelection = true;
      airportManager.activateAirport("EDDM");

      expect(mockApp.pathSelection.selectPathsByAirport).not.toHaveBeenCalled();
      expect(airportManager.isPopupOpen("EDDM")).toBe(true);
    });
  });

  describe("airport labels", () => {
    type Label = GeoJSON.Feature<GeoJSON.Point, Record<string, unknown>>;
    const labels = (): Label[] =>
      (
        mockApp.map!.source(MAP_SOURCES.airportLabels)
          .data as GeoJSON.FeatureCollection<GeoJSON.Point>
      ).features as Label[];
    const label = (name: string): Label | undefined =>
      labels().find((feature) => feature.properties["name"] === name);
    const labelSource = () => mockApp.map!.source(MAP_SOURCES.airportLabels);

    it("tells the map of every airport shown, the home base and the busier first", () => {
      airportManager.showAirports();

      expect(labels().map((feature) => feature.properties["name"])).toEqual(
        // EDDF has three flights, EDDM two, EDDK one, LOWW none
        ["EDDF", "EDDM", "EDDK", "LOWW"],
      );
      expect(label("EDDK")!.geometry.coordinates).toEqual([7.14, 50.87]);
    });

    describe("its code on the map", () => {
      beforeEach(() => {
        const map = mockApp.map!;
        map.jumpTo({ center: [8.5, 50.5], zoom: 6 });
        const container = map.getContainer();
        Object.defineProperty(container, "clientWidth", { value: 800 });
        Object.defineProperty(container, "clientHeight", { value: 600 });
      });

      it("draws the code of an airport in view, and tells the map of its room", () => {
        airportManager.updateLabels();

        // EDDF is 170 by 400 pixels from the middle; the others are off
        const arm =
          markers["EDDF"]!.getElement().querySelector(".airport-code-arm")!;
        expect(arm.classList.contains("is-hidden")).toBe(false);
        expect(label("EDDF")!.properties["icao"]).toBe("EDDF");
        expect(label("EDDF")!.properties["o"]).toHaveLength(2);
        expect(label("EDDM")!.properties).not.toHaveProperty("o");
      });

      it("points the popup past the code of its airport", () => {
        airportManager.updateLabels();
        popup.setOffset.mockClear();

        markers["EDDF"]!.openPopup();

        const offsets = (
          popup.setOffset.mock.lastCall as unknown[]
        )[0] as Record<string, [number, number]>;
        // The code is above the dot: a popup above clears it, one below
        // points at the dot
        expect(offsets["bottom"]![1]).toBeLessThan(-12);
        expect(offsets["top"]).toEqual([0, 12]);
      });

      it("points the popup past its code again when the code moves", () => {
        markers["EDDF"]!.openPopup();
        popup.setOffset.mockClear();

        airportManager.updateLabels();

        expect(popup.setOffset).toHaveBeenCalled();
      });
    });

    it("leaves out the airports towards the horizon of a steeply tilted map", async () => {
      await mockApp.mapReady;
      await Promise.resolve();
      const map = mockApp.map!;
      Object.defineProperty(map.getContainer(), "clientHeight", {
        value: 800,
      });
      const names = (): unknown[] =>
        labels().map((feature) => feature.properties["name"]);
      airportManager.showAirports();

      // Looking north over EDDF: EDDK is up at the horizon, three times as
      // far from the camera as EDDF; the others are to the south, near.
      // Nothing is measured or written while the map moves, only at rest.
      map.jumpTo({ center: [8.67, 50.1], pitch: 80 });
      const labelWrites = labelSource().setData.mock.calls.length;
      map.emit("move");
      expect(markers["EDDK"]!.getElement().hidden).toBe(false);
      expect(labelSource().setData).toHaveBeenCalledTimes(labelWrites);
      map.emit("moveend");

      expect(markers["EDDK"]!.getElement().hidden).toBe(true);
      expect(markers["EDDF"]!.getElement().hidden).toBe(false);
      expect(names()).toEqual(["EDDF", "EDDM", "LOWW"]);

      // Flatter, it is back, marker and label
      map.jumpTo({ pitch: 45 });
      map.emit("moveend");

      expect(markers["EDDK"]!.getElement().hidden).toBe(false);
      expect(names()).toEqual(airports.map((airport) => airport.name));
    });

    it("keeps the airport the keyboard is on, however far it is", async () => {
      await mockApp.mapReady;
      await Promise.resolve();
      const map = mockApp.map!;
      Object.defineProperty(map.getContainer(), "clientHeight", {
        value: 800,
      });
      markers["EDDK"]!.getControl().focus();

      map.jumpTo({ center: [8.67, 50.1], pitch: 80 });
      map.emit("moveend");

      expect(markers["EDDK"]!.getElement().hidden).toBe(false);
      expect(document.activeElement).toBe(markers["EDDK"]!.getControl());
    });

    it("keeps an airport the filter hides hidden as it comes back from the horizon", async () => {
      await mockApp.mapReady;
      await Promise.resolve();
      const map = mockApp.map!;
      Object.defineProperty(map.getContainer(), "clientHeight", {
        value: 800,
      });
      map.jumpTo({ center: [8.67, 50.1], pitch: 80 });
      map.emit("moveend");
      // 2024 has no flight to LOWW
      mockApp.selectedYear = "2024";

      map.jumpTo({ pitch: 0 });
      map.emit("moveend");

      expect(markers["LOWW"]!.getElement().hidden).toBe(true);
      expect(markers["EDDK"]!.getElement().hidden).toBe(false);
    });

    it("leaves the frames of the replay's camera to its own rest", async () => {
      await mockApp.mapReady;
      await Promise.resolve();
      const map = mockApp.map!;
      Object.defineProperty(map.getContainer(), "clientHeight", {
        value: 800,
      });
      map.jumpTo({ center: [8.67, 50.1], pitch: 80 });

      map.emit("moveend", REPLAY_CAMERA_MOVE);
      expect(markers["EDDK"]!.getElement().hidden).toBe(false);

      map.emit("moveend");
      expect(markers["EDDK"]!.getElement().hidden).toBe(true);
    });

    it("writes the labels again once the map has its style back after a lost WebGL context", async () => {
      await mockApp.mapReady;
      await Promise.resolve();
      const map = mockApp.map!;
      airportManager.showAirports();
      // What changed during the loss had no source to go to
      const getSource = map.getSource.getMockImplementation()!;
      map.getSource.mockImplementation(() => undefined);
      mockApp.selectedYear = "2024";
      map.getSource.mockImplementation(getSource);
      expect(labels()).toHaveLength(airports.length);

      map.emit("webglcontextrestored");
      map.emit("style.load");

      expect(labels().map((feature) => feature.properties["name"])).toEqual([
        "EDDF",
        "EDDK",
      ]);
    });

    it("stops following the map once destroyed", async () => {
      await mockApp.mapReady;
      await Promise.resolve();
      const map = mockApp.map!;
      const listening = {
        moveend: map.listenerCount("moveend"),
        move: map.listenerCount("move"),
        resize: map.listenerCount("resize"),
      };

      airportManager.destroy();

      // Its own rest and that of the codes
      expect(map.listenerCount("moveend")).toBe(listening.moveend - 2);
      expect(map.listenerCount("move")).toBe(listening.move - 1);
      expect(map.listenerCount("resize")).toBe(listening.resize - 1);
    });

    it("leaves out the airports the filter hides, like their markers", () => {
      mockApp.selectedYear = "2024";

      expect(labels().map((feature) => feature.properties["name"])).toEqual([
        "EDDF",
        "EDDK",
      ]);
    });
  });

  describe("popupOffsets", () => {
    const place = (angle: number) => ({
      angle,
      from: 4,
      to: 9,
      at: 17,
      hw: 20,
      hh: 8,
      narrow: false,
      level: 0,
      scale: 1,
    });

    it("clears a code above the dot only for a popup above it", () => {
      const offsets = popupOffsets(place(-90));

      expect(offsets.bottom).toEqual([0, -29]);
      expect(offsets.top).toEqual([0, 12]);
      // Beside the dot the popup is clear of its half width
      expect(offsets.left).toEqual([24, 0]);
      expect(offsets.right).toEqual([-24, 0]);
    });

    it("clears a code below or beside the dot on that side", () => {
      expect(popupOffsets(place(90)).top).toEqual([0, 29]);
      expect(popupOffsets(place(90)).bottom).toEqual([0, -12]);
      expect(popupOffsets(place(0)).left[0]).toBeCloseTo(41);
      expect(popupOffsets(place(180)).right[0]).toBeCloseTo(-41);
    });

    it("keeps to the dot's pointer target with no code", () => {
      expect(popupOffsets(null).bottom).toEqual([0, -12]);
    });
  });

  describe("store subscriptions", () => {
    it("refreshes once, and writes the labels once, for an update that changes several keys (regression)", () => {
      const labels = mockApp.map!.source(MAP_SOURCES.airportLabels).setData;
      mockApp.selectedPathIds = new Set([1]);
      labels.mockClear();

      // What a year switch publishes
      mockApp.store.batch(() => {
        mockApp.selectedYear = "2024";
        mockApp.currentData = createDataset(pathInfo.slice(2));
        mockApp.selectedAircraft = "D-ABCD";
        mockApp.selectedPathIds = new Set();
      });

      expect(labels).toHaveBeenCalledTimes(1);
      expect(isHome("EDDF")).toBe(true);
    });

    it("closes the popup when the airports are hidden", () => {
      markers["EDDF"]!.openPopup();

      mockApp.airportsVisible = false;

      expect(popup.isOpen()).toBe(false);
    });

    it("places the codes again once the airports are back on", () => {
      vi.useFakeTimers({
        toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
      });
      try {
        const placed = vi.spyOn(
          AirportCodes.prototype as unknown as { place(settle: boolean): void },
          "place",
        );
        mockApp.airportsVisible = false;
        placed.mockClear();

        mockApp.airportsVisible = true;
        expect(placed).not.toHaveBeenCalled();
        // Once the markers show again, at the next frame
        vi.advanceTimersToNextFrame();

        expect(placed).toHaveBeenCalledTimes(1);
        expect(placed).toHaveBeenCalledWith(true);
        placed.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });

    it("counts the home base again, and refreshes the visibility, when the filter changes", () => {
      const placed = vi.spyOn(AirportCodes.prototype, "update");
      markers["EDDF"]!.openPopup();
      popup.setHTML.mockClear();
      placed.mockClear();

      mockApp.selectedYear = "2024";

      expect(popup.setHTML).toHaveBeenCalledTimes(1);
      expect(placed).toHaveBeenCalledTimes(1);
      expect(markers["EDDM"]!.getElement().hidden).toBe(true);

      mockApp.selectedAircraft = "D-ABCD";

      expect(popup.setHTML).toHaveBeenCalledTimes(2);
      expect(placed).toHaveBeenCalledTimes(2);
      placed.mockRestore();
    });

    it("refreshes only the visibility for a selection change, and only where it changes", () => {
      const labels = mockApp.map!.source(MAP_SOURCES.airportLabels).setData;
      airportManager.showAirports();
      markers["EDDF"]!.openPopup();
      popup.setHTML.mockClear();
      labels.mockClear();

      // Without a filter every airport shows, the selected flight's too
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 3]);

      expect(labels).not.toHaveBeenCalled();
      expect(markers["EDDM"]!.getElement().hidden).toBe(false);

      mockApp.isolateSelection = true;

      expect(popup.setHTML).not.toHaveBeenCalled();
      expect(labels).toHaveBeenCalledTimes(1);
      expect(markers["EDDM"]!.getElement().hidden).toBe(true);
    });

    it("marks the home base and hides the markers as soon as a dataset arrives", () => {
      mockApp.selectedYear = "2024";

      mockApp.currentData = createDataset(pathInfo.slice(2));

      expect(isHome("EDDF")).toBe(true);
      expect(markers["EDDM"]!.getElement().hidden).toBe(true);
    });
  });
});
