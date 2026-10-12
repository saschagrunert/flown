/**
 * WrappedManager: the content of the year in review, rendered by the real
 * generators from a small flight history.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  resetSiteData,
  siteData,
} from "../../../../flown/frontend/state/siteData";
import type { Metadata } from "../../../../flown/frontend/types";
import { WrappedManager } from "../../../../flown/frontend/ui/wrappedManager";
import { datasetIndex } from "../../../../flown/frontend/calculations/datasetIndex";
import * as statistics from "../../../../flown/frontend/calculations/panelStats";
import { createDataset, asMapApp, type MockApp } from "../../testHelpers";
import {
  createWrappedMockApp,
  el,
  installAirports,
  mountWrappedDom,
} from "./wrappedTestSetup";

/** Text of every stat card, keyed by its label */
function statCards(): Record<string, string> {
  const cards: Record<string, string> = {};
  for (const card of el("wrapped-stats").querySelectorAll(".stat-card")) {
    const label = card.querySelector(".stat-label")!.textContent;
    cards[label] = card.querySelector(".stat-value")!.textContent.trim();
  }
  return cards;
}

describe("WrappedManager content", () => {
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

  it("returns early when the map is null", () => {
    mockApp.map = null;

    wrappedManager.showWrapped();

    expect(el("wrapped-modal").style.display).toBe("");
    expect(el("wrapped-stats").innerHTML).toBe("");
  });

  it("titles a single year as the year in flight", () => {
    wrappedManager.showWrapped();

    // The card is titled by its words alone; the mark that used to open the
    // line sat low beside type this size
    expect(el("wrapped-title").textContent).toBe("Your Year in Flight");
    expect(el("wrapped-title").querySelector("svg")).toBeNull();
    expect(el("wrapped-year").textContent).toBe("2024");
  });

  it("titles all years as the flight history", () => {
    mockApp.selectedYear = "all";

    wrappedManager.showWrapped();

    expect(el("wrapped-title").textContent).toBe("Your Flight History");
    expect(el("wrapped-year").textContent).toBe("All years");
  });

  it("counts the flights and airports of the selected year", () => {
    wrappedManager.showWrapped();

    const cards = statCards();
    expect(cards["Flights"]).toBe("3");
    expect(cards["Airports"]).toBe("3");
    expect(cards["Flight time"]).toBe("3h 0m");
    expect(cards["Max groundspeed"]).toBe("120kt");
    expect(cards["Distance"]).toMatch(/^\d[\d,]*\.\dnm$/);
  });

  it("reuses the statistics the panel computed for the same filter", () => {
    const view = datasetIndex(mockApp.currentData!).filter("2024", "all");
    const panelStats = statistics.filterStatistics(view);
    const spy = vi.spyOn(statistics, "filterStatisticsInSlices");

    wrappedManager.showWrapped();

    // The same filter view, so the statistics it keeps, at once
    expect(spy).toHaveBeenCalledWith(view, expect.any(AbortSignal));
    expect(spy.mock.results[0]!.value).toBe(panelStats);
    expect(statCards()["Flights"]).toBe(String(panelStats.num_paths));
    spy.mockRestore();
  });

  it("counts every year when all years are selected", () => {
    mockApp.selectedYear = "all";

    wrappedManager.showWrapped();

    const cards = statCards();
    expect(cards["Flights"]).toBe("4");
    expect(cards["Airports"]).toBe("4");
  });

  it("respects the aircraft filter", () => {
    mockApp.selectedAircraft = "D-EFGH";

    wrappedManager.showWrapped();

    expect(statCards()["Flights"]).toBe("1");
    const fleet = [
      ...el("wrapped-aircraft-fleet").querySelectorAll(
        ".fleet-aircraft-registration",
      ),
    ].map((node) => node.textContent);
    expect(fleet).toEqual(["D-EFGH"]);
  });

  it("omits the timing cards when the data carries no groundspeed", () => {
    mockApp.currentData = createDataset(
      mockApp.currentData!.path_info,
      mockApp.currentData!.path_segments.map((segment) => ({
        ...segment,
        groundspeed_knots: 0,
        time: undefined,
      })),
    );

    wrappedManager.showWrapped();

    const cards = statCards();
    expect(cards["Flights"]).toBe("3");
    expect(cards["Flight time"]).toBeUndefined();
    expect(cards["Max groundspeed"]).toBeUndefined();
  });

  it("renders the fun facts from the year's statistics", () => {
    wrappedManager.showWrapped();

    const facts = [...el("wrapped-fun-facts").querySelectorAll(".fun-fact")];
    expect(facts.length).toBeGreaterThanOrEqual(2);
    const texts = facts.map((fact) => fact.textContent);
    // Two aircraft and two countries in 2024
    expect(texts.some((t) => t.includes("2 different aircraft"))).toBe(true);
    expect(texts.some((t) => t.includes("2 countries"))).toBe(true);
  });

  it("names the airspace new in a year once the page holds the years before", () => {
    siteData.metadata = { available_years: [2023, 2024] } as Metadata;
    wrappedManager.showWrapped();
    vi.runOnlyPendingTimers();
    // Not known: the page has not loaded 2023
    expect(el("wrapped-fun-facts").textContent).not.toContain("new airspace");
    expect(mockApp.dataManager.cachedData).toHaveBeenCalledWith("2023");
    wrappedManager.closeWrapped();

    // 2023 flew nowhere, so all of 2024 is new. Counted once the dialog is
    // open: the first count is longer than the statistics it waits for.
    mockApp.dataManager.cachedData.mockReturnValue(createDataset([], []));
    wrappedManager.showWrapped();
    expect(el("wrapped-fun-facts").textContent).not.toContain("new airspace");
    vi.runOnlyPendingTimers();
    const fact = /[\d,]+ km² of new airspace in 2024/;
    expect(el("wrapped-fun-facts").textContent).toMatch(fact);
    wrappedManager.closeWrapped();

    // Counted once: a reopening has it at once
    mockApp.dataManager.cachedData.mockClear();
    wrappedManager.showWrapped();
    expect(el("wrapped-fun-facts").textContent).toMatch(fact);
    expect(mockApp.dataManager.cachedData).not.toHaveBeenCalled();
  });

  it("adds no new airspace to cards it was not counted for", () => {
    siteData.metadata = { available_years: [2023, 2024] } as Metadata;
    mockApp.dataManager.cachedData.mockReturnValue(createDataset([], []));
    wrappedManager.showWrapped();
    wrappedManager.closeWrapped();

    vi.runOnlyPendingTimers();

    expect(mockApp.dataManager.cachedData).not.toHaveBeenCalled();
  });

  it("lists the fleet busiest first with the model from the metadata", () => {
    wrappedManager.showWrapped();

    const entries = [
      ...el("wrapped-aircraft-fleet").querySelectorAll(".fleet-aircraft"),
    ].map((entry) => ({
      registration: entry.querySelector(".fleet-aircraft-registration")!
        .textContent,
      model: entry.querySelector(".fleet-aircraft-model")!.textContent,
      flights: entry.querySelector(".fleet-aircraft-flights")!.textContent,
    }));
    expect(entries).toEqual([
      { registration: "D-ABCD", model: "Diamond DA40", flights: "2 flights" },
      { registration: "D-EFGH", model: "Cessna 172", flights: "1 flight" },
    ]);
  });

  it("names the home base with its flight count", () => {
    wrappedManager.showWrapped();

    const home = el("wrapped-top-airports");
    expect(home.querySelector(".top-airport-code")!.textContent).toBe("EDDF");
    expect(home.querySelector(".top-airport-place")!.textContent).toBe(
      "Frankfurt",
    );
    // Every 2024 flight touched Frankfurt
    expect(home.querySelector(".top-airport-count")!.textContent).toBe(
      "3 flights",
    );
  });

  it("counts the home base flights of the selected year only", () => {
    mockApp.selectedYear = "all";

    wrappedManager.showWrapped();

    expect(
      el("wrapped-top-airports").querySelector(".top-airport-count")!
        .textContent,
    ).toBe("4 flights");
  });

  it("groups the destinations by country and accents home and furthest", () => {
    wrappedManager.showWrapped();

    const grid = el("wrapped-airports-grid");
    const groups = [...grid.querySelectorAll(".country-group")].map(
      (group) => ({
        name: group.querySelector(".country-name")!.textContent,
        count: group.querySelector(".country-count")!.textContent,
        airports: [...group.querySelectorAll(".destination")].map((row) => [
          row.querySelector(".destination-code")!.textContent,
          row.querySelector(".destination-tag")?.textContent ?? "",
        ]),
      }),
    );
    expect(groups).toEqual([
      {
        name: "Germany",
        count: "2",
        airports: [
          ["EDDF", "Home"],
          ["EDDM", ""],
        ],
      },
      { name: "Austria", count: "1", airports: [["LOWW", "Furthest"]] },
    ]);
  });

  it("staggers the country groups through the CSSOM", () => {
    wrappedManager.showWrapped();

    const delays = [
      ...el("wrapped-airports-grid").querySelectorAll<HTMLElement>(
        ".country-group",
      ),
    ].map((group) => group.style.animationDelay);
    expect(delays).toEqual(["0s", "0.1s"]);
  });

  it("marks no destination as furthest without airport coordinates", () => {
    resetSiteData();

    wrappedManager.showWrapped();

    expect(el("wrapped-airports-grid").textContent).not.toContain("Furthest");
    expect(el("wrapped-airports-grid").textContent).toContain("Home");
  });

  it("clears the conditional sections of the previous year", () => {
    wrappedManager.showWrapped();
    expect(el("wrapped-aircraft-fleet").innerHTML).not.toBe("");
    expect(el("wrapped-top-airports").innerHTML).not.toBe("");
    expect(el("wrapped-airports-grid").innerHTML).not.toBe("");
    expect(el("wrapped-card-fleet").hidden).toBe(false);
    expect(el("wrapped-card-airports").hidden).toBe(false);
    wrappedManager.closeWrapped();

    // A year without flights must not keep showing the previous one
    mockApp.selectedYear = "2019";
    wrappedManager.showWrapped();

    expect(statCards()["Flights"]).toBe("0");
    expect(el("wrapped-aircraft-fleet").innerHTML).toBe("");
    expect(el("wrapped-top-airports").innerHTML).toBe("");
    expect(el("wrapped-airports-grid").innerHTML).toBe("");
    // An empty card is hidden rather than a blank tile without its heading
    expect(el("wrapped-card-fleet").hidden).toBe(true);
    expect(el("wrapped-card-airports").hidden).toBe(true);
    wrappedManager.closeWrapped();

    // and comes back with a year that fills it
    mockApp.selectedYear = "all";
    wrappedManager.showWrapped();
    expect(el("wrapped-card-fleet").hidden).toBe(false);
    expect(el("wrapped-card-airports").hidden).toBe(false);
  });

  it("skips the airport sections when no flight has an airport", () => {
    mockApp.currentData = createDataset(
      [{ id: 1, year: 2024, aircraft_registration: "D-ABCD" }],
      mockApp.currentData!.path_segments.slice(0, 2),
    );

    wrappedManager.showWrapped();

    expect(statCards()["Flights"]).toBe("1");
    expect(el("wrapped-top-airports").innerHTML).toBe("");
    expect(el("wrapped-airports-grid").innerHTML).toBe("");
  });
});
