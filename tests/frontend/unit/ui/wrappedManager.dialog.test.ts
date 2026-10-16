/**
 * WrappedManager: opening and closing the dialog, focus, the inert page
 * behind it, the map hand-over and the timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resetSiteData } from "../../../../flown/frontend/state/siteData";
import { WrappedManager } from "../../../../flown/frontend/ui/wrappedManager";
import {
  TOAST_ALERT_ID,
  TOAST_STACK_ID,
  TOAST_STATUS_ID,
  showToast,
} from "../../../../flown/frontend/utils/toast";
import * as motion from "../../../../flown/frontend/utils/motion";
import * as statistics from "../../../../flown/frontend/calculations/panelStats";
import * as logger from "../../../../flown/frontend/utils/logger";
import { STATS_FAILED_HTML } from "../../../../flown/frontend/ui/statsManager";
import { HIDEABLE_CONTROL_IDS } from "../../../../flown/frontend/ui/wrappedChrome";
import { LngLat, Popup } from "../../../mocks/maplibre-gl";
import { asMapApp, type MockApp } from "../../testHelpers";
import type { AirportMarker } from "../../../../flown/frontend/types";
import {
  createFlightHistory,
  createWrappedMockApp,
  el,
  installAirports,
  mountWrappedDom,
} from "./wrappedTestSetup";

describe("WrappedManager dialog", () => {
  let wrappedManager: WrappedManager;
  let mockApp: MockApp;

  beforeEach(() => {
    vi.useFakeTimers();
    installAirports();
    mountWrappedDom();
    mockApp = createWrappedMockApp();
    wrappedManager = new WrappedManager(asMapApp(mockApp));
  });

  afterEach(() => {
    wrappedManager.destroy();
    vi.useRealTimers();
    document.body.innerHTML = "";
    resetSiteData();
  });

  function openWrapped(): void {
    wrappedManager.showWrapped();
    vi.advanceTimersByTime(50);
  }

  describe("More below", () => {
    /** The column with the button in its first card */
    function column(): HTMLElement {
      const cards = el("wrapped-cards-column");
      const first = document.createElement("section");
      const second = document.createElement("section");
      first.append(el("wrapped-more-btn"));
      cards.append(first, second);
      cards.getBoundingClientRect = () => ({ top: 60 }) as DOMRect;
      // Below the column's top: the first card is taller than the column
      second.getBoundingClientRect = () => ({ top: 772 }) as DOMRect;
      cards.scrollBy = vi.fn();
      return cards;
    }

    it("brings the next card to the top of the column", () => {
      openWrapped();
      const cards = column();

      el("wrapped-more-btn").click();

      // As far as the next card is below the column's top, not a page
      // down: the first card may be taller than the column
      expect(cards.scrollBy).toHaveBeenCalledWith({
        top: 712,
        behavior: "smooth",
      });
    });

    it("jumps there under reduced motion", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);
      openWrapped();
      const cards = column();

      el("wrapped-more-btn").click();

      expect(cards.scrollBy).toHaveBeenCalledWith({
        top: 712,
        behavior: "instant",
      });
    });
  });

  describe("opening", () => {
    it("shows the modal and records it in the store", () => {
      wrappedManager.showWrapped();

      expect(el("wrapped-modal").hidden).toBe(false);
      expect(mockApp.store.get("wrappedVisible")).toBe(true);
    });

    it("does not open twice while already open", () => {
      wrappedManager.showWrapped();
      el("wrapped-stats").innerHTML = "rendered once";

      wrappedManager.showWrapped();

      expect(el("wrapped-stats").innerHTML).toBe("rendered once");
    });

    it("does not open twice on a page without controls to hide", () => {
      for (const id of HIDEABLE_CONTROL_IDS)
        document.getElementById(id)?.remove();
      wrappedManager.showWrapped();
      el("wrapped-stats").innerHTML = "rendered once";

      wrappedManager.showWrapped();

      expect(el("wrapped-stats").innerHTML).toBe("rendered once");
      expect(mockApp.map!.fitBounds).toHaveBeenCalledOnce();
    });

    /** A clock that has run past a slice of the statistics at every look */
    function slowClock(): () => number {
      let now = 0;
      const clock = vi
        .spyOn(performance, "now")
        .mockImplementation(() => (now += 1000));
      return () => clock.mock.calls.length;
    }

    /** The figure of the stats card labelled `label` */
    function statValue(label: string): string | undefined {
      return Array.from(el("wrapped-stats").querySelectorAll(".stat-card"))
        .find(
          (card) => card.querySelector(".stat-label")?.textContent === label,
        )
        ?.querySelector(".stat-value")
        ?.textContent.trim();
    }

    it("opens at once and says it prepares the cards of a long filter", async () => {
      mockApp.currentData = createFlightHistory();
      slowClock();

      wrappedManager.showWrapped();

      // Open, titled and focused while the statistics are worked out
      expect(el("wrapped-modal").hidden).toBe(false);
      expect(mockApp.store.get("wrappedVisible")).toBe(true);
      expect(document.activeElement).toBe(
        el("wrapped-modal").querySelector(".close-btn"),
      );
      expect(el("wrapped-year").textContent).toBe("2024");
      expect(el("wrapped-cards-column").getAttribute("aria-busy")).toBe("true");
      const loading = el("wrapped-stats").querySelector(".stats-loading");
      expect(loading?.getAttribute("role")).toBe("status");
      expect(loading?.textContent).toBe("Preparing your year…");
      expect(statValue("Flights")).toBeUndefined();

      // A second click while they are worked out changes nothing
      wrappedManager.showWrapped();
      expect(mockApp.map!.fitBounds).toHaveBeenCalledOnce();

      await vi.runAllTimersAsync();
      expect(el("wrapped-cards-column").hasAttribute("aria-busy")).toBe(false);
      expect(el("wrapped-stats").querySelector(".stats-loading")).toBeNull();
      expect(statValue("Flights")).toBe("3");
    });

    it("says so when the statistics of the cards fail, rather than preparing them for good", async () => {
      mockApp.currentData = createFlightHistory();
      const failure = new Error("bad data");
      const slices = vi
        .spyOn(statistics, "filterStatisticsInSlices")
        .mockReturnValue(Promise.reject(failure));
      const logged = vi.spyOn(logger, "logError").mockImplementation(() => {});
      try {
        wrappedManager.showWrapped();
        await vi.runAllTimersAsync();

        expect(logged).toHaveBeenCalledWith(failure);
        expect(el("wrapped-cards-column").hasAttribute("aria-busy")).toBe(
          false,
        );
        expect(el("wrapped-stats").innerHTML).toBe(STATS_FAILED_HTML);
      } finally {
        slices.mockRestore();
        logged.mockRestore();
      }
    });

    it("prepares the flight history for all the years", () => {
      mockApp.selectedYear = "all";
      mockApp.currentData = createFlightHistory();
      slowClock();

      wrappedManager.showWrapped();

      expect(el("wrapped-stats").textContent).toBe(
        "Preparing your flight history…",
      );
    });

    it("hides the cards of the last opening while it prepares new ones", () => {
      openWrapped();
      wrappedManager.closeWrapped();
      expect(el("wrapped-fun-facts").innerHTML).not.toBe("");
      mockApp.currentData = createFlightHistory();
      slowClock();

      wrappedManager.showWrapped();

      expect(statValue("Flights")).toBeUndefined();
      // Hidden until renderContent says which have anything: emptied, they
      // were blank tiles meanwhile
      const cards = ["facts", "fleet", "airports"].map((card) =>
        el("wrapped-card-" + card),
      );
      expect(cards.map((card) => card.hidden)).toEqual([true, true, true]);
    });

    it("shows the cards again that have anything once they are ready", async () => {
      mockApp.currentData = createFlightHistory();
      slowClock();
      wrappedManager.showWrapped();

      await vi.runAllTimersAsync();

      expect(el("wrapped-card-facts").hidden).toBe(false);
      // The history has aircraft and airports, so both have something
      expect(el("wrapped-card-fleet").hidden).toBe(false);
      expect(el("wrapped-card-airports").hidden).toBe(false);
    });

    it("stops preparing the cards when it closes while they load", async () => {
      mockApp.currentData = createFlightHistory();
      const looks = slowClock();

      wrappedManager.showWrapped();
      wrappedManager.closeWrapped();
      const looksAtClose = looks();
      await vi.runAllTimersAsync();

      // Not a slice more of the work, and no cards in a closed dialog
      expect(looks()).toBe(looksAtClose);
      expect(el("wrapped-modal").hidden).toBe(true);
      expect(statValue("Flights")).toBeUndefined();
    });

    it("prepares the cards anew when it reopens after a close while they loaded", async () => {
      mockApp.currentData = createFlightHistory();
      slowClock();

      wrappedManager.showWrapped();
      wrappedManager.closeWrapped();
      vi.advanceTimersByTime(100);
      wrappedManager.showWrapped();
      await vi.runAllTimersAsync();

      expect(el("wrapped-modal").hidden).toBe(false);
      expect(el("wrapped-cards-column").hasAttribute("aria-busy")).toBe(false);
      expect(statValue("Flights")).toBe("3");
    });

    it("fills the cards from the data that loaded while they were prepared", async () => {
      mockApp.currentData = createFlightHistory();
      slowClock();
      wrappedManager.showWrapped();

      const history = createFlightHistory();
      history.path_info = history.path_info.filter((path) => path.id !== 3);
      history.path_segments = history.path_segments.filter(
        (segment) => segment.path_id !== 3,
      );
      mockApp.currentData = history;
      await vi.runAllTimersAsync();

      expect(statValue("Flights")).toBe("2");
    });

    it("does not fill the cards for statistics that arrive after the teardown", async () => {
      mockApp.currentData = createFlightHistory();
      slowClock();

      wrappedManager.showWrapped();
      wrappedManager.destroy();
      await vi.runAllTimersAsync();

      expect(statValue("Flights")).toBeUndefined();
      expect(el("wrapped-cards-column").getAttribute("aria-busy")).toBe("true");
    });

    it("hides the control elements behind the dialog", () => {
      wrappedManager.showWrapped();

      expect(el("left-buttons").style.display).toBe("none");
      expect(el("right-buttons").style.display).toBe("none");
      expect(el("altitude-legend").style.display).toBe("none");
      // The buttons go with their columns, not one by one
      expect(el("stats-btn").style.display).toBe("");
    });

    it("focuses the close button and makes the page behind inert", () => {
      el("wrapped-btn").focus();

      wrappedManager.showWrapped();

      expect(document.activeElement).toBe(
        el("wrapped-modal").querySelector(".close-btn"),
      );
      expect(el("left-buttons").hasAttribute("inert")).toBe(true);
      expect(el("right-buttons").hasAttribute("inert")).toBe(true);
      expect(el("github-footer").hasAttribute("inert")).toBe(true);
      expect(el("app-container").hasAttribute("inert")).toBe(true);
      expect(el("wrapped-modal").hasAttribute("inert")).toBe(false);
    });

    it("makes an element added to the page while it is open inert too", async () => {
      // Crossing the breakpoint with the dialog open mounts the mobile bar
      // onto the body. A one-time snapshot missed it, and its tabs joined the
      // dialog's tab cycle and stayed operable.
      wrappedManager.showWrapped();

      const bar = document.createElement("div");
      bar.className = "mobile-bar";
      bar.innerHTML = '<button id="mobile-tab-stats">Stats</button>';
      document.body.appendChild(bar);
      await Promise.resolve();

      expect(bar.hasAttribute("inert")).toBe(true);
    });

    it("keeps toasts live while the dialog is open", async () => {
      wrappedManager.showWrapped();

      showToast("Link copied", "info");
      await Promise.resolve();

      const region = document.getElementById(TOAST_STATUS_ID)!;
      expect(region.hasAttribute("inert")).toBe(false);
      expect(region.getAttribute("role")).toBe("status");
      expect(
        document.getElementById(TOAST_STACK_ID)!.hasAttribute("inert"),
      ).toBe(false);
    });

    it("keeps the toasts of the real page out of what it makes inert", () => {
      // In the page's <main> they went inert with it (regression)
      wrappedManager.destroy();
      document.body.innerHTML = new DOMParser().parseFromString(
        readFileSync(
          join(process.cwd(), "flown/templates/map_template.html"),
          "utf8",
        ),
        "text/html",
      ).body.innerHTML;
      wrappedManager = new WrappedManager(asMapApp(mockApp));

      wrappedManager.showWrapped();

      expect(document.querySelector("main")!.hasAttribute("inert")).toBe(true);
      for (const id of [TOAST_STACK_ID, TOAST_STATUS_ID, TOAST_ALERT_ID]) {
        expect(document.getElementById(id)!.closest("[inert]"), id).toBeNull();
      }
    });

    it("leaves the loading indicator to the data manager", () => {
      // Restoring the display saved on opening stranded the indicator when
      // a load finished while the dialog was open
      el("loading").style.display = "block";
      openWrapped();
      el("loading").style.display = "none";

      wrappedManager.closeWrapped();

      expect(el("loading").style.display).toBe("none");
    });

    it("does not open while a replay runs", () => {
      mockApp.replayActive = true;

      wrappedManager.showWrapped();

      expect(el("wrapped-modal").hidden).toBe(true);
      expect(mockApp.store.get("wrappedVisible")).toBe(false);
      expect(mockApp.map!.fitBounds).not.toHaveBeenCalled();
    });

    it("does not open while the hotspot tour runs", () => {
      // A click on Wrapped whose bundle came after the tour had started
      mockApp.tourView = {
        center: { lat: 51, lng: 12 },
        zoom: 8,
        bearing: 0,
        pitch: 0,
        globeVisible: false,
        threeDVisible: false,
        heatmapVisible: true,
      };

      wrappedManager.showWrapped(true);

      expect(el("wrapped-modal").hidden).toBe(true);
      expect(mockApp.store.get("wrappedVisible")).toBe(false);
    });

    it("refreshes the cards when data finishes loading while it is open", () => {
      const flightCount = (): string | undefined =>
        Array.from(el("wrapped-stats").querySelectorAll(".stat-card"))
          .find(
            (card) =>
              card.querySelector(".stat-label")?.textContent === "Flights",
          )
          ?.querySelector(".stat-value")
          ?.textContent.trim();
      openWrapped();
      expect(flightCount()).toBe("3");

      // Only the data changes, with the year left as it was, so the cards
      // follow the data and not a filter change that came with it
      const history = createFlightHistory();
      history.path_info = history.path_info.filter((path) => path.id !== 3);
      history.path_segments = history.path_segments.filter(
        (segment) => segment.path_id !== 3,
      );
      mockApp.currentData = history;

      expect(flightCount()).toBe("2");
      expect(el("wrapped-year").textContent).toBe("2024");
    });

    it("fits the map to the data that finished loading while it is open", () => {
      openWrapped();
      const fitBounds = mockApp.map!.fitBounds;
      const opened = fitBounds.mock.calls.at(-1)![0];
      fitBounds.mockClear();

      // The flights of before kept the map: hovering off a destination flew
      // back to their bounds as well
      const history = createFlightHistory();
      history.path_info = history.path_info.filter((path) => path.id === 1);
      history.path_segments = history.path_segments.filter(
        (segment) => segment.path_id === 1,
      );
      mockApp.currentData = history;

      expect(fitBounds).toHaveBeenCalledTimes(1);
      const refitted = fitBounds.mock.calls[0]![0];
      expect(refitted).not.toEqual(opened);
    });

    it("refreshes the cards when the aircraft changes without new data", () => {
      openWrapped();
      el("wrapped-year").textContent = "stale";

      // An aircraft held while a year loaded, applied as that load failed
      mockApp.selectedAircraft = "D-EFGH";

      expect(el("wrapped-year").textContent).toBe("2024");
    });

    it("leaves the cards alone when data loads while it is closed", () => {
      openWrapped();
      wrappedManager.closeWrapped();
      el("wrapped-year").textContent = "untouched";

      mockApp.currentData = createFlightHistory();

      expect(el("wrapped-year").textContent).toBe("untouched");
    });

    it("fits the map without animation for reduced motion", () => {
      vi.spyOn(motion, "prefersReducedMotion").mockReturnValue(true);

      openWrapped();
      vi.advanceTimersByTime(100);

      expect(mockApp.map!.fitBounds).toHaveBeenCalledTimes(2);
      for (const call of mockApp.map!.fitBounds.mock.calls) {
        expect((call as unknown[])[1]).toMatchObject({ animate: false });
      }
    });

    it("keeps the map interactive: it leaves the inert page for the dialog", () => {
      const main = document.createElement("main");
      main.appendChild(el("map"));
      document.body.appendChild(main);

      openWrapped();

      expect(main.hasAttribute("inert")).toBe(true);
      expect(el("map").closest("[inert]")).toBeNull();
    });

    it("moves the map into the dialog after the layout has settled", () => {
      const mapEl = el("map");
      const originalParent = mapEl.parentElement;

      wrappedManager.showWrapped();
      expect(el("wrapped-map-container").contains(mapEl)).toBe(false);

      vi.advanceTimersByTime(50);

      expect(el("wrapped-map-container").contains(mapEl)).toBe(true);
      expect(mapEl.style.width).toBe("100%");
      expect(mapEl.style.height).toBe("100%");
      expect(mapEl.style.borderRadius).toBe("var(--radius-sheet)");
      expect(mapEl.style.overflow).toBe("hidden");

      wrappedManager.closeWrapped();

      expect(originalParent?.contains(mapEl)).toBe(true);
    });

    it("remeasures the map and fits the bounds once it is inside", () => {
      wrappedManager.showWrapped();
      expect(mockApp.map!.fitBounds).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(150);

      expect(mockApp.map!.resize).toHaveBeenCalled();
      expect(mockApp.map!.fitBounds).toHaveBeenCalledTimes(2);
      // The 2024 flights, not the whole dataset the config bounds cover,
      // and longitude first the way the map wants its corners
      expect(mockApp.map!.fitBounds).toHaveBeenCalledWith(
        [
          [8, 48],
          [12, 51],
        ],
        // North up and flat, whatever the user's view was
        { padding: 80, bearing: 0, pitch: 0, animate: true },
      );
      expect(mockApp.map!.resize.mock.invocationCallOrder[0]!).toBeLessThan(
        mockApp.map!.fitBounds.mock.invocationCallOrder[1]!,
      );
    });

    it("fits the map to the whole dataset in the All Years view", () => {
      mockApp.selectedYear = "all";

      wrappedManager.showWrapped();
      vi.advanceTimersByTime(150);

      expect(mockApp.map!.fitBounds).toHaveBeenCalledTimes(2);
      for (const call of mockApp.map!.fitBounds.mock.calls) {
        expect(call[0]).toEqual([
          [8, 50],
          [10, 52],
        ]);
      }
    });

    it("fits the map to the flights of the selected aircraft", () => {
      mockApp.selectedYear = "all";
      mockApp.selectedAircraft = "D-EFGH";

      wrappedManager.showWrapped();

      expect(mockApp.map!.fitBounds).toHaveBeenCalledWith(
        [
          [9, 50],
          [10, 51],
        ],
        expect.anything(),
      );
    });

    it("leaves persistence to the store subscription", () => {
      wrappedManager.showWrapped();
      vi.advanceTimersByTime(150);
      wrappedManager.closeWrapped();
      vi.advanceTimersByTime(150);

      expect(mockApp.stateManager.saveMapState).not.toHaveBeenCalled();
      expect(mockApp.stateManager.flush).not.toHaveBeenCalled();
    });

    it("skips the remeasure when the map disappears before the timeout", () => {
      wrappedManager.showWrapped();
      vi.advanceTimersByTime(50);
      mockApp.map = null;

      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    });

    it("returns early if the map container element is missing", () => {
      el("map").remove();

      wrappedManager.showWrapped();

      expect(el("wrapped-modal").hidden).toBe(true);
      expect(el("stats-btn").style.display).toBe("");
    });

    it("returns early if the wrapped map container is missing", () => {
      el("wrapped-map-container").remove();

      wrappedManager.showWrapped();

      expect(el("wrapped-modal").hidden).toBe(true);
      expect(mockApp.store.get("wrappedVisible")).toBe(false);
    });
  });

  describe("closing", () => {
    it("moves the map back and restores its styling", () => {
      const mapEl = el("map");
      const originalParent = mapEl.parentElement!;
      openWrapped();
      expect(mapEl.style.width).toBe("100%");

      wrappedManager.closeWrapped();

      expect(originalParent.contains(mapEl)).toBe(true);
      expect(mapEl.style.width).toBe("");
      expect(mapEl.style.height).toBe("");
      expect(mapEl.style.borderRadius).toBe("");
      expect(mapEl.style.overflow).toBe("");
    });

    it("puts the map back before what followed it, after the page changed around it", () => {
      // The map on the body, with the panel that follows it, as on the page
      const mapEl = el("map");
      const empty = document.createElement("div");
      empty.id = "map-empty";
      document.body.prepend(mapEl, empty);

      openWrapped();
      // The mobile bar goes in ahead of where the map was, as it does when
      // the window crosses the breakpoint
      const bar = document.createElement("nav");
      document.body.insertBefore(bar, empty);
      wrappedManager.closeWrapped();

      // An index taken at the first opening put the map after the bar and
      // before nothing it followed (regression)
      expect(mapEl.nextElementSibling).toBe(empty);
      expect(bar.nextElementSibling).toBe(mapEl);

      // Taken again on the next opening, with the bar gone
      bar.remove();
      openWrapped();
      wrappedManager.closeWrapped();
      expect(mapEl.nextElementSibling).toBe(empty);
    });

    it("restores the control elements to what they were", () => {
      el("altitude-legend").style.display = "block";
      openWrapped();
      expect(el("altitude-legend").style.display).toBe("none");

      wrappedManager.closeWrapped();

      expect(el("left-buttons").style.display).toBe("");
      expect(el("right-buttons").style.display).toBe("");
      expect(el("altitude-legend").style.display).toBe("block");
    });

    it("keeps a control hidden that was hidden before", () => {
      el("airspeed-legend").style.display = "none";

      openWrapped();
      wrappedManager.closeWrapped();

      expect(el("airspeed-legend").style.display).toBe("none");
    });

    it("hides the modal and records it in the store", () => {
      openWrapped();

      wrappedManager.closeWrapped();

      expect(el("wrapped-modal").hidden).toBe(true);
      expect(mockApp.store.get("wrappedVisible")).toBe(false);
    });

    it("releases inert siblings and restores focus to the opener", () => {
      el("wrapped-btn").focus();
      openWrapped();
      expect(el("left-buttons").hasAttribute("inert")).toBe(true);

      wrappedManager.closeWrapped();

      expect(el("left-buttons").hasAttribute("inert")).toBe(false);
      expect(el("right-buttons").hasAttribute("inert")).toBe(false);
      expect(el("github-footer").hasAttribute("inert")).toBe(false);
      expect(document.activeElement).toBe(el("wrapped-btn"));
    });

    it("releases an element that arrived while it was open", async () => {
      wrappedManager.showWrapped();
      const bar = document.createElement("div");
      bar.className = "mobile-bar";
      document.body.appendChild(bar);
      await Promise.resolve();
      expect(bar.hasAttribute("inert")).toBe(true);

      wrappedManager.closeWrapped();

      expect(bar.hasAttribute("inert")).toBe(false);
    });

    it("stops watching the page once it closes", async () => {
      wrappedManager.showWrapped();
      wrappedManager.closeWrapped();

      const late = document.createElement("div");
      document.body.appendChild(late);
      await Promise.resolve();

      expect(late.hasAttribute("inert")).toBe(false);
    });

    it("focuses the Wrapped button when nothing opened it", () => {
      // Restored from a link: focus is on the page itself
      (document.activeElement as HTMLElement | null)?.blur();
      openWrapped();

      wrappedManager.closeWrapped();

      expect(document.activeElement).toBe(el("wrapped-btn"));
    });

    it("focuses the Wrapped tab of the bar when the columns are gone", () => {
      el("wrapped-btn").remove();
      const tab = document.createElement("button");
      tab.id = "mobile-tab-wrapped";
      document.body.appendChild(tab);
      openWrapped();

      wrappedManager.closeWrapped();

      expect(document.activeElement).toBe(tab);
    });

    it("focuses the Wrapped tab once the dialog is hidden", () => {
      // The bar is hidden under the dialog (wrapped.css) and its tab cannot
      // take focus until the dialog is gone (regression)
      el("wrapped-btn").remove();
      const tab = document.createElement("button");
      tab.id = "mobile-tab-wrapped";
      document.body.appendChild(tab);
      const focus = tab.focus.bind(tab);
      tab.focus = () => {
        if (el("wrapped-modal").hidden) focus();
      };
      openWrapped();

      wrappedManager.closeWrapped();

      expect(document.activeElement).toBe(tab);
    });

    it("takes the airport markers out of the tab order while open, and only them", () => {
      // MapLibre listens on the canvas container for every drag, pinch and
      // wheel. Inert, it would freeze the overview map of the dialog.
      const canvasContainer = mockApp.map!.getCanvasContainer();
      const markers = [0, 1].map(() => {
        const marker = document.createElement("button");
        marker.className = "maplibregl-marker";
        canvasContainer.appendChild(marker);
        return marker;
      });
      expect(el("map").contains(canvasContainer)).toBe(true);

      openWrapped();
      for (const marker of markers) {
        expect(marker.hasAttribute("inert")).toBe(true);
      }
      expect(canvasContainer.hasAttribute("inert")).toBe(false);
      expect(mockApp.map!.getCanvas().closest("[inert]")).toBeNull();
      expect(el("map").hasAttribute("inert")).toBe(false);

      wrappedManager.closeWrapped();
      for (const marker of markers) {
        expect(marker.hasAttribute("inert")).toBe(false);
      }
    });

    it("takes the markers and popups out that come while it is open, from the Retry of the airports", async () => {
      openWrapped();
      // The toast with Retry stays above the dialog
      const marker = document.createElement("button");
      marker.className = "maplibregl-marker";
      mockApp.map!.getCanvasContainer().appendChild(marker);
      const popup = document.createElement("div");
      popup.className = "maplibregl-popup";
      mockApp.map!.getContainer().appendChild(popup);
      // Anything else the map adds keeps taking gestures
      const other = document.createElement("div");
      mockApp.map!.getContainer().appendChild(other);
      await Promise.resolve();

      expect(marker.hasAttribute("inert")).toBe(true);
      expect(popup.hasAttribute("inert")).toBe(true);
      expect(other.hasAttribute("inert")).toBe(false);

      wrappedManager.closeWrapped();
      expect(marker.hasAttribute("inert")).toBe(false);
      expect(popup.hasAttribute("inert")).toBe(false);
      popup.remove();
      other.remove();
    });

    it("puts away the values a hover or a tap left on a flight", () => {
      // The popup of a tapped flight has a close button: a tab stop below
      // #map, which the observer of the body's children never sees
      openWrapped();

      expect(mockApp.layerManager.closeSegmentPopup).toHaveBeenCalledTimes(1);
    });

    it("leaves a marker alone that was inert before the dialog opened", () => {
      const marker = document.createElement("button");
      marker.className = "maplibregl-marker";
      marker.setAttribute("inert", "");
      mockApp.map!.getCanvasContainer().appendChild(marker);

      openWrapped();
      wrappedManager.closeWrapped();

      expect(marker.hasAttribute("inert")).toBe(true);
    });

    it("closes an open airport popup before the dialog covers the map", () => {
      let open = true;
      const airport = {
        isPopupOpen: vi.fn(() => open),
        closePopup: vi.fn(() => {
          open = false;
        }),
      };
      const closed = { isPopupOpen: vi.fn(() => false), closePopup: vi.fn() };
      mockApp.airportMarkers["EDDF Frankfurt"] =
        airport as unknown as AirportMarker;
      mockApp.airportMarkers["EDDM Munich"] =
        closed as unknown as AirportMarker;

      openWrapped();

      expect(airport.closePopup).toHaveBeenCalledTimes(1);
      expect(closed.closePopup).not.toHaveBeenCalled();
    });

    it("makes a popup that stays on the map inert while open", () => {
      // The segment tooltip belongs to no airport; popups are children of
      // the map itself, outside the canvas container
      const popup = new Popup().setLngLat([8, 50]).addTo(mockApp.map!);
      const popupEl = popup.getElement();
      expect(popupEl.parentElement).toBe(el("map"));

      openWrapped();
      expect(popupEl.hasAttribute("inert")).toBe(true);

      wrappedManager.closeWrapped();
      expect(popupEl.hasAttribute("inert")).toBe(false);
    });

    it("does not restore focus to an opener that left the document", () => {
      el("wrapped-btn").focus();
      openWrapped();
      el("wrapped-btn").remove();

      expect(() => wrappedManager.closeWrapped()).not.toThrow();
      expect(document.activeElement).toBe(document.body);
    });

    it("puts the user's view back once the map is back in the page", () => {
      mockApp.map!.getCenter.mockReturnValue(new LngLat(11.6, 48.1));
      mockApp.map!.getZoom.mockReturnValue(12);
      openWrapped();
      vi.advanceTimersByTime(100);

      wrappedManager.closeWrapped();
      expect(mockApp.map!.jumpTo).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);

      // After the remeasure, so the view is fitted to the page-sized map.
      // Longitude first, and the zoom as the map gave it: no state unit here.
      const remeasured = mockApp.map!.resize.mock.invocationCallOrder.at(-1)!;
      expect(mockApp.map!.jumpTo).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.jumpTo).toHaveBeenCalledWith({
        center: [11.6, 48.1],
        zoom: 12,
        bearing: 0,
        pitch: 0,
      });
      expect(mockApp.map!.jumpTo.mock.invocationCallOrder[0]!).toBeGreaterThan(
        remeasured,
      );
    });

    it("lays a turned and tilted map flat for the overview and turns it back", () => {
      mockApp.map!.jumpTo({ center: [11.6, 48.1], bearing: 120, pitch: 45 });
      mockApp.map!.jumpTo.mockClear();

      openWrapped();
      vi.advanceTimersByTime(200);

      expect(mockApp.map!.getBearing()).toBe(0);
      expect(mockApp.map!.getPitch()).toBe(0);
      expect(wrappedManager.userMapView()).toMatchObject({
        bearing: 120,
        pitch: 45,
      });

      wrappedManager.closeWrapped();
      vi.advanceTimersByTime(100);

      expect(mockApp.map!.getBearing()).toBe(120);
      expect(mockApp.map!.getPitch()).toBe(45);
    });

    it("keeps the tilt the replay of all flights is laying the map back to", () => {
      // Opened half way back from the tilt of that replay
      mockApp.map!.jumpTo({ pitch: 25 });
      mockApp.replayState.layingBack = 0;

      openWrapped();

      expect(wrappedManager.userMapView()).toMatchObject({ pitch: 0 });
    });

    it("keeps the user's view through a reopening before it was put back", () => {
      mockApp.map!.getCenter.mockReturnValue(new LngLat(11.6, 48.1));
      mockApp.map!.getZoom.mockReturnValue(12);
      openWrapped();
      wrappedManager.closeWrapped();

      // Reopened before the restore ran: the map still shows the fitted view
      mockApp.map!.getCenter.mockReturnValue(new LngLat(9, 51));
      mockApp.map!.getZoom.mockReturnValue(6.75);
      openWrapped();
      wrappedManager.closeWrapped();
      vi.advanceTimersByTime(100);

      expect(mockApp.map!.jumpTo).toHaveBeenCalledTimes(1);
      expect(mockApp.map!.jumpTo).toHaveBeenCalledWith({
        center: [11.6, 48.1],
        zoom: 12,
        bearing: 0,
        pitch: 0,
      });
    });

    it("remeasures the map once it is back in the page", () => {
      openWrapped();
      mockApp.map!.resize.mockClear();

      wrappedManager.closeWrapped();
      vi.advanceTimersByTime(100);

      expect(mockApp.map!.resize).toHaveBeenCalled();
    });

    it("leaves the dialog open when the map container is missing", () => {
      openWrapped();
      el("map").remove();

      wrappedManager.closeWrapped();

      expect(el("wrapped-modal").hidden).toBe(false);
      expect(el("left-buttons").style.display).toBe("none");
      expect(el("left-buttons").hasAttribute("inert")).toBe(true);
    });

    it("appends the map when its original position is gone", () => {
      const mapEl = el("map");
      const originalParent = mapEl.parentElement!;
      openWrapped();
      while (originalParent.firstChild) {
        originalParent.removeChild(originalParent.firstChild);
      }

      wrappedManager.closeWrapped();

      expect(originalParent.contains(mapEl)).toBe(true);
      expect(originalParent.lastElementChild).toBe(mapEl);
    });

    it("does not remeasure a map that is gone by the time the timer fires", () => {
      openWrapped();
      vi.advanceTimersByTime(150);
      const resize = mockApp.map!.resize;
      resize.mockClear();

      wrappedManager.closeWrapped();
      mockApp.map = null;

      expect(() => vi.advanceTimersByTime(100)).not.toThrow();
      expect(resize).not.toHaveBeenCalled();
    });

    it("drops the pending remeasure when the dialog reopens at once", () => {
      openWrapped();
      vi.advanceTimersByTime(150);
      mockApp.map!.resize.mockClear();

      wrappedManager.closeWrapped();
      wrappedManager.showWrapped();
      vi.advanceTimersByTime(100);

      // Only the reopening's own timers may run; the close timer would have
      // remeasured a map that is already inside the dialog again
      expect(mockApp.map!.resize).not.toHaveBeenCalled();
    });
  });

  describe("map placeholder", () => {
    const awaiting = (): boolean =>
      el("wrapped-map-container").classList.contains("is-awaiting-map");
    /** The map's `render` listeners, which the wait adds one to */
    let renders = 0;

    /** Open with a map that still has tiles of the fitted view in flight */
    async function openWithBusyMap(): Promise<void> {
      mockApp.map!.areTilesLoaded.mockReturnValue(false);
      renders = mockApp.map!.listenerCount("render");
      openWrapped();
      await vi.advanceTimersByTimeAsync(100);
    }

    it("holds the placeholder from the opening on", () => {
      wrappedManager.showWrapped();

      expect(awaiting()).toBe(true);
    });

    it("reveals the map once it comes to rest with its tiles drawn", async () => {
      await openWithBusyMap();
      expect(awaiting()).toBe(true);
      expect(mockApp.map!.listenerCount("render")).toBe(renders + 1);

      mockApp.map!.areTilesLoaded.mockReturnValue(true);
      mockApp.map!.emit("render");
      await vi.advanceTimersByTimeAsync(0);

      expect(awaiting()).toBe(false);
      expect(mockApp.map!.listenerCount("render")).toBe(renders);
    });

    it("reveals at once a map that is already at rest", async () => {
      // No frame is coming for such a map
      openWrapped();
      expect(awaiting()).toBe(true);

      await vi.advanceTimersByTimeAsync(100);

      expect(awaiting()).toBe(false);
    });

    it("waits for a map that is still moving into the fit", async () => {
      mockApp.map!.isMoving.mockReturnValue(true);
      openWrapped();
      await vi.advanceTimersByTimeAsync(100);

      expect(awaiting()).toBe(true);

      mockApp.map!.isMoving.mockReturnValue(false);
      mockApp.map!.emit("render");
      await vi.advanceTimersByTimeAsync(0);
      expect(awaiting()).toBe(false);
    });

    it("waits for the heat the year worker is still drawing", async () => {
      // The map is at rest meanwhile, with the heat of before
      mockApp.dataManager.heatRequests = 1;
      openWrapped();
      await vi.advanceTimersByTimeAsync(100);
      expect(awaiting()).toBe(true);
      mockApp.map!.emit("render");
      await vi.advanceTimersByTimeAsync(0);
      expect(awaiting()).toBe(true);

      mockApp.dataManager.heatRequests = 0;
      mockApp.map!.emit("render");
      await vi.advanceTimersByTimeAsync(0);
      expect(awaiting()).toBe(false);
    });

    it("gives up waiting for a map that never comes to rest", async () => {
      await openWithBusyMap();

      await vi.advanceTimersByTimeAsync(1199);
      expect(awaiting()).toBe(true);
      await vi.advanceTimersByTimeAsync(1);

      expect(awaiting()).toBe(false);
      expect(mockApp.map!.listenerCount("render")).toBe(renders);
    });

    it("drops the listener and the placeholder on close", async () => {
      await openWithBusyMap();

      wrappedManager.closeWrapped();

      expect(awaiting()).toBe(false);
      expect(mockApp.map!.listenerCount("render")).toBe(renders);
    });

    it("keeps the placeholder of a reopening from the wait of the close", async () => {
      // The wait of the closed dialog settles after the close; it must not
      // reveal the map of the next opening before its own tiles
      await openWithBusyMap();
      wrappedManager.closeWrapped();
      wrappedManager.showWrapped();
      await vi.advanceTimersByTimeAsync(0);

      expect(awaiting()).toBe(true);
    });

    it("drops the listener on destroy", async () => {
      await openWithBusyMap();

      wrappedManager.destroy();

      expect(mockApp.map!.listenerCount("render")).toBe(renders);
    });
  });

  describe("userMapView", () => {
    it("offers the user's view while the map is fitted, until it is put back", () => {
      const view = {
        center: { lat: 48.1, lng: 11.6 },
        zoom: 12,
        bearing: 0,
        pitch: 0,
        globeVisible: false,
        threeDVisible: false,
      };
      mockApp.map!.getCenter.mockReturnValue(new LngLat(11.6, 48.1));
      mockApp.map!.getZoom.mockReturnValue(12);
      expect(wrappedManager.userMapView()).toBeNull();

      openWrapped();
      // The map shows the fitted overview now
      mockApp.map!.getCenter.mockReturnValue(new LngLat(9, 51));
      mockApp.map!.getZoom.mockReturnValue(6.75);
      // The app's shape of a position, and the zoom in the map's own unit
      expect(wrappedManager.userMapView()).toEqual(view);

      wrappedManager.closeWrapped();
      // Still the user's until the close has put it back, so a save that
      // runs in between (the dialog state changed) keeps it
      expect(wrappedManager.userMapView()).toEqual(view);
      vi.advanceTimersByTime(100);
      expect(wrappedManager.userMapView()).toBeNull();
    });
  });

  describe("keyboard", () => {
    it("closes on Escape and ignores other keys", () => {
      openWrapped();

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(el("wrapped-modal").hidden).toBe(false);

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(el("wrapped-modal").hidden).toBe(true);
    });

    it("ignores Escape after the dialog was closed", () => {
      openWrapped();
      wrappedManager.closeWrapped();
      el("left-buttons").style.display = "block";

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      // A second close would have restored the controls again
      expect(el("left-buttons").style.display).toBe("block");
      expect(el("wrapped-modal").hidden).toBe(true);
    });
  });

  describe("destroy", () => {
    it("cancels the pending map hand-over", () => {
      wrappedManager.showWrapped();

      wrappedManager.destroy();
      vi.advanceTimersByTime(500);

      expect(el("wrapped-map-container").contains(el("map"))).toBe(false);
    });

    it("drops the Escape handler", () => {
      openWrapped();

      wrappedManager.destroy();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

      expect(el("wrapped-modal").hidden).toBe(false);
    });
  });

  describe("cards column scroll", () => {
    it("starts a reopened dialog at the title", () => {
      const column = el("wrapped-cards-column");
      Object.defineProperty(column, "scrollHeight", {
        value: 2500,
        configurable: true,
      });
      Object.defineProperty(column, "clientHeight", {
        value: 600,
        configurable: true,
      });

      wrappedManager.showWrapped();
      column.scrollTop = 900;
      wrappedManager.closeWrapped();

      wrappedManager.showWrapped();

      // The column keeps its position across openings, so it has to be put
      // back or Wrapped reopens halfway down a card
      expect(column.scrollTop).toBe(0);
    });

    it("starts a reopened stacked dialog at the top", () => {
      // Below the desktop layout the content row scrolls, not the column
      const content = el("wrapped-content");
      Object.defineProperty(content, "scrollHeight", {
        value: 3300,
        configurable: true,
      });
      Object.defineProperty(content, "clientHeight", {
        value: 780,
        configurable: true,
      });

      openWrapped();
      content.scrollTop = 1770;
      wrappedManager.closeWrapped();

      openWrapped();

      expect(content.scrollTop).toBe(0);
    });

    it("drops the bottom fade once the end is reached", () => {
      const column = el("wrapped-cards-column");
      Object.defineProperty(column, "scrollHeight", {
        value: 2500,
        configurable: true,
      });
      Object.defineProperty(column, "clientHeight", {
        value: 600,
        configurable: true,
      });

      wrappedManager.showWrapped();
      expect(column.classList.contains("is-at-end")).toBe(false);

      column.scrollTop = 1900;
      column.dispatchEvent(new Event("scroll"));

      expect(column.classList.contains("is-at-end")).toBe(true);
    });

    it("stops following the scroll once the dialog is closed", () => {
      const column = el("wrapped-cards-column");
      Object.defineProperty(column, "scrollHeight", {
        value: 2500,
        configurable: true,
      });
      Object.defineProperty(column, "clientHeight", {
        value: 600,
        configurable: true,
      });
      wrappedManager.showWrapped();
      wrappedManager.closeWrapped();

      column.scrollTop = 1900;
      column.dispatchEvent(new Event("scroll"));

      expect(column.classList.contains("is-at-end")).toBe(false);
    });
  });
});
