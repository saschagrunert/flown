import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { siteData } from "../../../../flown/frontend/state/siteData";
import {
  StatsManager,
  STATS_FAILED_HTML,
} from "../../../../flown/frontend/ui/statsManager";
import * as panelStats from "../../../../flown/frontend/calculations/panelStats";
import type { FilteredStatistics } from "../../../../flown/frontend/types";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  type MockApp,
} from "../../testHelpers";

/** Value of the lead figure with the given label */
function leadValue(panel: HTMLElement, label: string): string | null {
  for (const item of panel.querySelectorAll(".stats-lead-item")) {
    const itemLabel = item.querySelector(".stats-lead-label")?.textContent;
    if (itemLabel === label) {
      return item.querySelector(".stats-lead-value")!.textContent.trim();
    }
  }
  return null;
}

/** Text of the metric row with the given label, as "label value alt" */
function metricRow(panel: HTMLElement, label: string): string | null {
  for (const row of panel.querySelectorAll(".stats-metric")) {
    const rowLabel = row.querySelector(".stats-metric-label")?.textContent;
    if (rowLabel === label) {
      const value = row.querySelector(".stats-metric-value")?.textContent;
      const alt = row.querySelector(".stats-metric-alt")?.textContent;
      return alt ? `${value} (${alt})` : `${value}`;
    }
  }
  return null;
}

describe("StatsManager", () => {
  let statsManager: StatsManager;
  let mockApp: MockApp;
  let statsPanel: HTMLElement;

  beforeEach(() => {
    // A clock that stands still: the statistics of a filter come in slices
    // of a few milliseconds (filterStatisticsInSlices), and a first slice
    // that ran past its time on a loaded machine handed back a promise, so
    // the panel said it was loading where a test read its figures. With the
    // clock held every slice finishes the work; the test of the loading
    // panel moves it on purpose.
    vi.spyOn(performance, "now").mockReturnValue(0);
    // features/airports caches the country map on its first lookup, so every
    // test needs the airport data before the first render happens
    // Each with the code the export found in its name
    siteData.airports = [
      {
        name: "EDAQ Halle-Oppin",
        lat: 51.55,
        lon: 12.05,
        code: "EDAQ",
        country: "DE",
      },
      {
        name: "EDDM Munich",
        lat: 48.35,
        lon: 11.79,
        code: "EDDM",
        country: "DE",
      },
      {
        name: "LOWW Vienna",
        lat: 48.11,
        lon: 16.57,
        code: "LOWW",
        country: "AT",
      },
      { name: "EDDF", lat: 50.03, lon: 8.57, code: "EDDF", country: "DE" },
      { name: "EDDM", lat: 48.35, lon: 11.79, code: "EDDM", country: "DE" },
      { name: "EDDK", lat: 50.87, lon: 7.14, code: "EDDK", country: "DE" },
    ];

    const railTitle = document.createElement("h2");
    railTitle.id = "stats-rail-title";
    railTitle.innerHTML = '<span class="stats-title-text">Statistics</span>';
    document.body.appendChild(railTitle);

    statsPanel = document.createElement("div");
    statsPanel.id = "stats-panel";
    document.body.appendChild(statsPanel);

    mockApp = createMockApp({
      currentData: createDataset(
        [
          {
            id: 1,
            year: 2025,
            aircraft_registration: "D-ABCD",
            start_airport: "EDDF",
            end_airport: "EDDM",
          },
          {
            id: 2,
            year: 2024,
            aircraft_registration: "D-EFGH",
            start_airport: "EDDM",
            end_airport: "EDDK",
          },
        ],
        [
          createSegment({ path_id: 1, altitude_ft: 3000, time: 0 }),
          createSegment({
            path_id: 1,
            altitude_ft: 4000,
            time: 600,
            coords: [
              [50.1, 8.1],
              [50.2, 8.2],
            ],
          }),
          createSegment({
            path_id: 2,
            altitude_ft: 2000,
            coords: [
              [51.0, 9.0],
              [51.1, 9.1],
            ],
          }),
        ],
        1234,
      ),
    });

    statsManager = new StatsManager(asMapApp(mockApp));
  });

  afterEach(() => {
    document.getElementById("stats-rail-title")?.remove();
    statsPanel.remove();
    vi.useRealTimers();
  });

  describe("updateStatsForSelection", () => {
    it("leaves the title of the Flights tab to it when the figures land there", async () => {
      // Worked out in slices, they landed after a switch to the Flights
      // tab and named the rail "Statistics" over the list
      let land!: () => void;
      const spy = vi
        .spyOn(panelStats, "filterStatisticsInSlices")
        .mockImplementation(
          (view) =>
            new Promise<FilteredStatistics>((resolve) => {
              land = () => resolve(panelStats.filterStatistics(view));
            }),
        );
      const title = document.querySelector(
        "#stats-rail-title .stats-title-text",
      )!;
      statsManager.updateStatsForSelection();
      expect(title.textContent).toBe("Statistics");

      // As the tab writes it (ui/flightList.ts)
      mockApp.flightListVisible = true;
      title.textContent = "Flights";
      land();
      await vi.waitFor(() =>
        expect(statsPanel.getAttribute("aria-busy")).toBeNull(),
      );

      expect(title.textContent).toBe("Flights");
      spy.mockRestore();
    });

    it("keeps the title of the Flights tab while the statistics load", () => {
      // The loading state titled the rail "Statistics" over the list
      const spy = vi
        .spyOn(panelStats, "filterStatisticsInSlices")
        .mockImplementation(() => new Promise<FilteredStatistics>(() => {}));
      const title = document.querySelector(
        "#stats-rail-title .stats-title-text",
      )!;
      mockApp.flightListVisible = true;
      title.textContent = "Flights";

      statsManager.updateStatsForSelection();

      expect(statsPanel.getAttribute("aria-busy")).toBe("true");
      expect(title.textContent).toBe("Flights");
      spy.mockRestore();
    });

    it("works the figures out in one go when the slices fail, rather than staying busy", async () => {
      const spy = vi
        .spyOn(panelStats, "filterStatisticsInSlices")
        .mockImplementation(() => Promise.reject(new Error("no slice")));
      mockApp.selectedYear = "2025";

      statsManager.updateStatsForSelection();
      expect(statsPanel.getAttribute("aria-busy")).toBe("true");

      await vi.waitFor(() =>
        expect(statsPanel.getAttribute("aria-busy")).toBeNull(),
      );
      expect(leadValue(statsPanel, "Flights")).toBe("1");

      // The same inputs ask no more
      statsManager.updateStatsForSelection();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });

    it("says so when the figures cannot be worked out at all, and asks again only for new inputs", async () => {
      const slices = vi
        .spyOn(panelStats, "filterStatisticsInSlices")
        .mockImplementation(() => Promise.reject(new Error("no slice")));
      const once = vi
        .spyOn(panelStats, "filterStatistics")
        .mockImplementation(() => {
          throw new Error("no figures");
        });
      mockApp.selectedYear = "2025";

      statsManager.updateStatsForSelection();

      await vi.waitFor(() =>
        expect(statsPanel.getAttribute("aria-busy")).toBeNull(),
      );
      expect(statsPanel.innerHTML).toBe(STATS_FAILED_HTML);
      statsManager.updateStatsForSelection();
      expect(once).toHaveBeenCalledTimes(1);
      expect(slices).toHaveBeenCalledTimes(1);

      // Another year is worked out again
      mockApp.selectedYear = "all";
      statsManager.updateStatsForSelection();
      expect(slices).toHaveBeenCalledTimes(2);
      slices.mockRestore();
      once.mockRestore();
    });

    it("shows filtered statistics for all paths when nothing is selected", () => {
      mockApp.selectedYear = "2025";

      statsManager.updateStatsForSelection();

      expect(
        document.getElementById("stats-rail-title")!.textContent,
      ).toContain("Statistics");
      expect(leadValue(statsPanel, "Flights")).toBe("1");
      expect(statsPanel.textContent).toContain("3 data points");
      expect(statsPanel.textContent).toContain("EDDF");
      expect(statsPanel.textContent).not.toContain("EDDK");
      expect(leadValue(statsPanel, "Total flight time")).toBe("0h 10m");
    });

    it("shows statistics for the selected paths only", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);

      statsManager.updateStatsForSelection();

      expect(
        document.getElementById("stats-rail-title")!.textContent,
      ).toContain("Statistics of the selection");
      expect(statsPanel.textContent).toContain(
        "Showing statistics for 1 selected flight",
      );
      // unique coordinates of the selected segments
      expect(statsPanel.textContent).toContain("2 data points");
      expect(statsPanel.textContent).toContain("EDDK");
      expect(statsPanel.textContent).not.toContain("EDDF");
    });

    it("counts the selected flights the filter shows, as the map and the chip do", () => {
      // Share mode keeps a flight the filter hides, which is not drawn
      mockApp.selectedPathIds = new Set([1, 2]); // path 2 is from 2024
      mockApp.isolateSelection = true;

      statsManager.updateStatsForSelection();
      expect(leadValue(statsPanel, "Flights")).toBe("2");

      mockApp.selectedYear = "2025";
      statsManager.updateStatsForSelection();
      expect(leadValue(statsPanel, "Flights")).toBe("1");
      expect(statsPanel.textContent).not.toContain("D-EFGH");

      // All of them hidden: the statistics of the selection, of nothing
      mockApp.selectedPathIds = new Set(
        [...mockApp.selectedPathIds].filter((id) => id !== 1),
      );
      statsManager.updateStatsForSelection();
      expect(leadValue(statsPanel, "Flights")).toBe("0");
    });

    it("renders an empty selection instead of the previous flight", () => {
      statsPanel.innerHTML = "before";
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 999]);

      statsManager.updateStatsForSelection();

      expect(statsPanel.innerHTML).not.toBe("before");
      expect(statsPanel.textContent).toContain("0 selected flights");
      expect(leadValue(statsPanel, "Flights")).toBe("0");
    });

    it("does not rewrite the panel when the markup is unchanged", () => {
      statsManager.updateStatsForSelection();
      const first = statsPanel.firstElementChild;

      statsManager.updateStatsForSelection();

      // Same nodes, so focus and scroll position inside the panel survive
      expect(statsPanel.firstElementChild).toBe(first);
    });

    it("handles missing data", () => {
      mockApp.currentData = null;

      statsManager.updateStatsForSelection();

      expect(leadValue(statsPanel, "Flights")).toBe("0");
    });
  });

  describe("updateStatsPanel", () => {
    const mockStats: FilteredStatistics = {
      total_points: 10000,
      num_paths: 50,
      num_airports: 3,
      airport_names: ["EDDF", "EDDM", "EDDK"],
      num_aircraft: 2,
      aircraft_list: [
        { registration: "D-ABCD", type: "DA40", flights: 30 },
        { registration: "D-EFGH", flights: 20 }, // No type
      ],
      total_distance_km: 5000,
      total_distance_nm: 2700,
      total_flight_time_str: "25h 30m",
      max_altitude_ft: 10000,
      total_altitude_gain_ft: 50000,
      avg_groundspeed_knots: 120,
      cruise_speed_knots: 125,
      max_groundspeed_knots: 150,
      longest_flight_km: 500,
      longest_flight_nm: 270,
      most_common_cruise_altitude_ft: 5500,
      most_common_cruise_altitude_m: 1676,
    };

    it("lists the landings the flights carry", () => {
      statsManager.updateStatsPanel(
        {
          ...mockStats,
          landings: {
            landings: 115,
            touchAndGoes: 1179,
            goArounds: 5,
            mostTouchAndGoes: 16,
          },
        },
        false,
      );

      const section = [...statsPanel.querySelectorAll("section")].find(
        (candidate) => candidate.textContent?.includes("Landings"),
      );
      const rows = [...section!.querySelectorAll(".stats-metric")].map(
        (row) => row.textContent,
      );
      expect(rows).toEqual([
        "Full-stop landings115",
        "Touch-and-goes1,179",
        "Go-arounds5",
      ]);
    });

    it("leaves the landings out where the flights carry none", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.textContent).not.toContain("Touch-and-goes");
    });

    it("says when the panel has more below it than it can show", () => {
      // The fade at the bottom edge is what says so; it has to go once the
      // panel is scrolled to the end, and the class it keys off is set
      // before any content exists
      Object.defineProperty(statsPanel, "scrollHeight", {
        configurable: true,
        value: 2000,
      });
      Object.defineProperty(statsPanel, "clientHeight", {
        configurable: true,
        value: 800,
      });

      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.classList.contains("is-at-end")).toBe(false);

      statsPanel.scrollTop = 1200;
      statsPanel.dispatchEvent(new Event("scroll"));

      expect(statsPanel.classList.contains("is-at-end")).toBe(true);
    });

    it("renders headings and sections with  classes", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(
        document.getElementById("stats-rail-title")!.textContent,
      ).toContain("Statistics");
      const sections = [
        ...statsPanel.querySelectorAll("h3.stats-section-title"),
      ].map((el) => el.querySelector(".stats-section-label")!.textContent);
      expect(sections).toEqual([
        "Distance",
        "Speed",
        "Altitude",
        "Aircraft",
        "Airports",
      ]);
      // Section titles are real headings, lists are real lists
      expect(statsPanel.querySelector('[role="list"]')).toBeNull();
      expect(statsPanel.querySelector('[role="listitem"]')).toBeNull();
      expect(statsPanel.querySelectorAll("ul.stats-list > li").length).toBe(
        statsPanel.querySelectorAll("ul.stats-list li").length,
      );
      // Every rule lives in the stylesheet, none of it inline
      expect(statsPanel.querySelector("[style]")).toBeNull();
      // Icons carry no accessible name of their own
      expect(statsPanel.querySelectorAll("svg.icon").length).toBeGreaterThan(0);
      for (const svg of statsPanel.querySelectorAll("svg.icon")) {
        expect(svg.getAttribute("aria-hidden")).toBe("true");
      }
    });

    it("leads with distance, flight time, flights and airports", () => {
      statsManager.updateStatsPanel(mockStats, false);

      const labels = [...statsPanel.querySelectorAll(".stats-lead-label")].map(
        (el) => el.textContent,
      );
      expect(labels).toEqual([
        "Distance",
        "Total flight time",
        "Flights",
        "Airports",
      ]);
      expect(leadValue(statsPanel, "Distance")).toBe("2,700.0nm");
      expect(leadValue(statsPanel, "Total flight time")).toBe("25h 30m");
      expect(leadValue(statsPanel, "Flights")).toBe("50");
      expect(leadValue(statsPanel, "Airports")).toBe("3");
      // The metric equivalent of the distance stays on the lead figure
      expect(statsPanel.querySelector(".stats-lead-alt")!.textContent).toBe(
        "5,000.4km",
      );
    });

    it("keeps four lead figures without timing data", () => {
      statsManager.updateStatsPanel(
        { ...mockStats, total_flight_time_str: undefined },
        false,
      );

      // A missing figure still occupies its cell, so the grid stays full
      expect(statsPanel.querySelectorAll(".stats-lead-item")).toHaveLength(4);
      expect(leadValue(statsPanel, "Total flight time")).toBe("—");
      expect(leadValue(statsPanel, "Flights")).toBe("50");
    });

    it("names the year and the aircraft of the filter the figures are of", () => {
      const note = (): string =>
        statsPanel.querySelector(".stats-note")!.textContent;
      mockApp.selectedYear = "all";
      mockApp.selectedAircraft = "all";
      statsManager.updateStatsPanel(mockStats, false);
      expect(note()).toBe("All years · All aircraft");

      mockApp.selectedYear = "2025";
      mockApp.selectedAircraft = "D-<b>X</b>";
      statsManager.updateStatsPanel(mockStats, false);
      expect(note()).toBe("2025 · D-<b>X</b>");
      expect(statsPanel.querySelector(".stats-note b")).toBeNull();

      // A year from the link, before it is checked against the years
      mockApp.selectedYear = '<a href="x">2025</a>';
      mockApp.selectedAircraft = "all";
      statsManager.updateStatsPanel(mockStats, false);
      expect(note()).toBe('<a href="x">2025</a> · All aircraft');
      expect(statsPanel.querySelector(".stats-note a")).toBeNull();
    });

    it("renders the selection indicator", () => {
      statsManager.updateStatsPanel(mockStats, true);

      expect(
        document.getElementById("stats-rail-title")!.textContent,
      ).toContain("Statistics of the selection");
      expect(statsPanel.querySelector(".stats-note")!.textContent).toBe(
        "Showing statistics for 50 selected flights",
      );
    });

    it("pluralises the selection note and the data point count", () => {
      statsManager.updateStatsPanel(
        { ...mockStats, num_paths: 1, total_points: 1 },
        true,
      );

      expect(statsPanel.querySelector(".stats-note")!.textContent).toBe(
        "Showing statistics for 1 selected flight",
      );
      expect(statsPanel.querySelector(".stats-footer")!.textContent).toBe(
        "1 data point",
      );
    });

    it("renders all metrics with both unit systems", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(metricRow(statsPanel, "Average distance per trip")).toBe(
        "54.0nm (100.0km)",
      );
      expect(metricRow(statsPanel, "Longest flight")).toBe("270.0nm (500.0km)");
      expect(metricRow(statsPanel, "Average groundspeed")).toBe(
        "120kt (222km/h)",
      );
      expect(metricRow(statsPanel, "Cruise speed (> 1000 ft AGL)")).toBe(
        "125kt (232km/h)",
      );
      expect(metricRow(statsPanel, "Max groundspeed")).toBe("150kt (278km/h)");
      expect(metricRow(statsPanel, "Max altitude (MSL)")).toBe(
        "10,000ft (3,048m)",
      );
      expect(metricRow(statsPanel, "Elevation gain")).toBe(
        "50,000ft (15,240m)",
      );
      expect(metricRow(statsPanel, "Most common cruise altitude (AGL)")).toBe(
        "5,500ft (1,676m)",
      );
    });

    it("says above field for a cruise measured without terrain (regression)", () => {
      // The height above a flight's own lowest altitude used to be called
      // AGL; it is only that where the export carries the terrain
      statsManager.updateStatsPanel(
        { ...mockStats, cruise_height_above_terrain: false },
        false,
      );

      expect(
        metricRow(statsPanel, "Cruise speed (> 1000 ft above field)"),
      ).toBe("125kt (232km/h)");
      expect(
        metricRow(statsPanel, "Most common cruise altitude (above field)"),
      ).toBe("5,500ft (1,676m)");
      expect(statsPanel.textContent).not.toContain("AGL");
    });

    it("lists every aircraft with registration, type and flights", () => {
      statsManager.updateStatsPanel(mockStats, false);

      const aircraft = [...statsPanel.querySelectorAll(".stats-aircraft")];
      expect(aircraft).toHaveLength(2);
      expect(aircraft[0]!.querySelector(".stats-code")!.textContent).toBe(
        "D-ABCD",
      );
      expect(
        aircraft[0]!.querySelector(".stats-aircraft-type")!.textContent,
      ).toBe("DA40");
      expect(
        aircraft[0]!.querySelector(".stats-metric-value")!.textContent,
      ).toBe("30 flights");
      // The noun in the face of the text, the count in that of the figures
      expect(
        aircraft[0]!.querySelector(".stats-metric-value .stats-noun")!
          .textContent,
      ).toBe("flights");
      // Second aircraft carries no type
      expect(aircraft[1]!.querySelector(".stats-aircraft-type")).toBeNull();
      expect(aircraft[1]!.querySelector(".stats-code")!.textContent).toBe(
        "D-EFGH",
      );
    });

    it("shows a count beside the airports and aircraft headings", () => {
      // A visible number that nothing asserted: dropping the argument to
      // sectionTitle made it disappear with every suite still green
      statsManager.updateStatsPanel(mockStats, false);

      const counts = Array.from(
        statsPanel.querySelectorAll(".stats-section-count"),
      ).map((el) => el.textContent);
      expect(counts).toContain(String(mockStats.num_airports));
      expect(counts).toContain(String(mockStats.aircraft_list.length));
    });

    it("moves the data point count into the footer", () => {
      statsManager.updateStatsPanel(mockStats, false);

      expect(statsPanel.querySelector(".stats-footer")!.textContent).toBe(
        "10,000 data points",
      );
      // And not also one of the lead figures. Match the label the lead grid
      // would render, not the pre-redesign "Data Points:" markup, which
      // nothing emits any more and so could never fail.
      const leadLabels = Array.from(
        statsPanel.querySelectorAll(".stats-lead-label"),
      ).map((el) => el.textContent);
      expect(leadLabels).not.toContain("Data Points");
    });

    it("closes with when and from which commit the site was built", () => {
      mockApp.config.builtOn = "2026-09-21";
      mockApp.config.commit = "5b3ab40";
      mockApp.config.commitUrl =
        "https://github.com/saschagrunert/flown/commit/5b3ab4048d1c";
      statsManager.updateStatsPanel(mockStats, false);

      const build = statsPanel.querySelector(".stats-build")!;
      expect(build.textContent).toBe("Built 21 Sep 2026 from 5b3ab40");
      expect(build.querySelector("time")!.getAttribute("datetime")).toBe(
        "2026-09-21",
      );
      const link = build.querySelector("a")!;
      expect(link.getAttribute("href")).toBe(
        "https://github.com/saschagrunert/flown/commit/5b3ab4048d1c",
      );
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    });

    it("says the visitor's own flights were built in the browser", () => {
      // What the site's build was is not of them
      mockApp.config.builtOn = "2026-09-21";
      mockApp.config.commit = "5b3ab40";
      mockApp.config.localFlights = {
        years: [2025],
        flights: 1,
        airports: 1,
        bounds: [
          [49, 7],
          [51, 9],
        ],
        files: ["a.kml"],
        stamp: "",
        build: undefined,
        builtAt: 1,
      };
      try {
        statsManager.updateStatsPanel(mockStats, false);

        expect(statsPanel.querySelector(".stats-build")!.textContent).toBe(
          "Built in this browser",
        );
      } finally {
        mockApp.config.localFlights = undefined;
      }
    });

    it("links the commit only when the build knew where it is", () => {
      mockApp.config.builtOn = "2026-09-21";
      mockApp.config.commit = "5b3ab40";
      for (const commitUrl of [undefined, "", "javascript:alert(1)"]) {
        mockApp.config.commitUrl = commitUrl;
        statsManager.updateStatsPanel(mockStats, false);

        const build = statsPanel.querySelector(".stats-build")!;
        expect(build.textContent).toBe("Built 21 Sep 2026 from 5b3ab40");
        expect(build.querySelector("a")).toBeNull();
      }
    });

    it("leaves out whatever part of the build information is unknown", () => {
      mockApp.config.builtOn = "2026-09-21";
      mockApp.config.commit = "";
      statsManager.updateStatsPanel(mockStats, false);
      expect(statsPanel.querySelector(".stats-build")!.textContent).toBe(
        "Built 21 Sep 2026",
      );

      mockApp.config.builtOn = "not a date";
      mockApp.config.commit = "5b3ab40";
      statsManager.updateStatsPanel(mockStats, false);
      expect(statsPanel.querySelector(".stats-build")!.textContent).toBe(
        "Built from 5b3ab40",
      );

      // A site built before the stamp existed has neither
      mockApp.config.builtOn = undefined;
      mockApp.config.commit = undefined;
      statsManager.updateStatsPanel(mockStats, false);
      expect(statsPanel.querySelector(".stats-build")).toBeNull();
    });

    /** Statistics for the three airports the country fixture knows */
    const namedAirports: FilteredStatistics = {
      ...mockStats,
      airport_names: ["EDAQ Halle-Oppin", "EDDM Munich", "LOWW Vienna"],
      num_airports: 3,
    };

    it("summarizes the airports above the grouped list", () => {
      statsManager.updateStatsPanel(namedAirports, false);

      // The list is shown outright, not behind a disclosure
      expect(statsPanel.querySelector("details")).toBeNull();
      expect(
        statsPanel.querySelector(".stats-airports-summary")!.textContent,
      ).toBe("3 airports in 2 countries");

      const groups = statsPanel.querySelector(".stats-groups")!;
      expect(groups).not.toBeNull();

      // Every airport keeps its code and its full name
      const airports = [...groups.querySelectorAll(".stats-airport")].map(
        (el) => el.textContent,
      );
      expect(airports).toHaveLength(3);
      expect(airports).toContain("EDAQHalle-Oppin");
      expect(airports).toContain("EDDMMunich");
      expect(airports).toContain("LOWWVienna");
    });

    it("summarizes a single airport without a country", () => {
      statsManager.updateStatsPanel(
        { ...mockStats, airport_names: ["ZZZZ Unknown"], num_airports: 1 },
        false,
      );

      expect(
        statsPanel.querySelector(".stats-airports-summary")!.textContent,
      ).toBe("1 airport");
    });

    it("groups airports by country", () => {
      statsManager.updateStatsPanel(namedAirports, false);

      const groups = [...statsPanel.querySelectorAll(".stats-group")].map(
        (group) => ({
          name: group.querySelector(".stats-group-name")!.textContent,
          count: group.querySelector(".stats-group-count")!.textContent,
          code: group.querySelector(".stats-group-code")!.textContent,
        }),
      );
      expect(groups).toEqual([
        { name: "Germany", count: "2", code: "DE" },
        { name: "Austria", count: "1", code: "AT" },
      ]);

      // Each group lists its own airports
      const lists = statsPanel.querySelectorAll("ul.stats-airport-list");
      expect(
        [...lists[0]!.querySelectorAll(".stats-airport")].map(
          (el) => el.textContent,
        ),
      ).toEqual(["EDAQHalle-Oppin", "EDDMMunich"]);
      expect(
        [...lists[1]!.querySelectorAll(".stats-airport")].map(
          (el) => el.textContent,
        ),
      ).toEqual(["LOWWVienna"]);
    });

    it("groups airports the country data does not know as Other", () => {
      statsManager.updateStatsPanel(
        {
          ...mockStats,
          airport_names: ["EDDM Munich", "ZZZZ Unknown"],
          num_airports: 2,
        },
        false,
      );

      const groups = [...statsPanel.querySelectorAll(".stats-group")].map(
        (group) => group.querySelector(".stats-group-name")!.textContent,
      );
      expect(groups).toEqual(["Germany", "Other"]);
      // Only one country is known, so the summary counts one
      expect(
        statsPanel.querySelector(".stats-airports-summary")!.textContent,
      ).toBe("2 airports in 1 country");
    });

    it("keeps the airport list visible across re-renders", () => {
      statsManager.updateStatsPanel(namedAirports, false);
      const before = statsPanel.querySelectorAll(".stats-airport").length;
      expect(before).toBe(3);

      // Selecting a path rebuilds the panel from scratch
      statsManager.updateStatsPanel(namedAirports, true);

      expect(statsPanel.querySelectorAll(".stats-airport")).toHaveLength(3);
      expect(statsPanel.querySelector("details")).toBeNull();
    });

    it("escapes HTML in the lead figures", () => {
      statsManager.updateStatsPanel(
        { ...mockStats, total_flight_time_str: "<b>1h</b>" },
        false,
      );

      expect(leadValue(statsPanel, "Total flight time")).toBe("<b>1h</b>");
      expect(statsPanel.querySelector("b")).toBeNull();
      expect(statsPanel.innerHTML).toContain("&lt;b&gt;1h&lt;/b&gt;");
    });

    it("escapes HTML in names", () => {
      statsManager.updateStatsPanel(
        {
          ...mockStats,
          airport_names: ["<b>X</b>"],
          num_airports: 1,
          aircraft_list: [{ registration: "<i>", type: "<u>", flights: 1 }],
          num_aircraft: 1,
        },
        false,
      );

      expect(statsPanel.innerHTML).toContain("&lt;b&gt;X&lt;/b&gt;");
      expect(statsPanel.innerHTML).toContain("&lt;i&gt;");
      expect(statsPanel.innerHTML).toContain("&lt;u&gt;");
      expect(statsPanel.querySelector("b")).toBeNull();
      expect(statsPanel.querySelector("i")).toBeNull();
    });

    it("omits optional sections when fields are absent", () => {
      const minimal: FilteredStatistics = {
        total_points: 0,
        num_paths: 0,
        num_airports: 0,
        airport_names: [],
        num_aircraft: 0,
        aircraft_list: [],
        total_distance_km: 0,
        total_distance_nm: 0,
      };

      statsManager.updateStatsPanel(minimal, false);
      const text = statsPanel.textContent;

      expect(leadValue(statsPanel, "Distance")).toBe("0.0nm");
      // The four lead figures always stand, the sections below them do not
      expect(statsPanel.querySelectorAll(".stats-lead-item")).toHaveLength(4);
      expect(leadValue(statsPanel, "Total flight time")).toBe("—");
      expect(statsPanel.querySelectorAll(".stats-section")).toHaveLength(0);
      expect(statsPanel.querySelector("details")).toBeNull();
      expect(text).not.toContain("Average distance");
      expect(text).not.toContain("Longest flight");
      expect(text).not.toContain("Groundspeed");
      expect(text).not.toContain("Max altitude");
      expect(text).toContain("0 data points");
    });

    it("shows the altitude of a flight that stayed at sea level", () => {
      statsManager.updateStatsPanel(
        { ...mockStats, max_altitude_ft: 0, total_altitude_gain_ft: 0 },
        false,
      );

      expect(metricRow(statsPanel, "Max altitude (MSL)")).toContain("0ft");
      expect(metricRow(statsPanel, "Elevation gain")).toContain("0ft");
    });

    it("does nothing if the panel element is missing", () => {
      statsPanel.remove();
      expect(() =>
        statsManager.updateStatsPanel(mockStats, false),
      ).not.toThrow();
    });
  });

  describe("lazy start", () => {
    it("renders straight away when it starts with the panel open", () => {
      // The app starts it on the first opening, once the bundle is in
      const app = createMockApp({ statsPanelVisible: true });
      app.currentData = mockApp.currentData;
      const panel = document.createElement("div");
      panel.id = "stats-panel";
      panel.innerHTML = '<p class="stats-loading">Loading statistics…</p>';
      statsPanel.remove();
      document.body.appendChild(panel);
      try {
        new StatsManager(asMapApp(app));

        expect(panel.querySelector(".stats-loading")).toBeNull();
        expect(leadValue(panel, "Flights")).toBe("2");
      } finally {
        panel.remove();
      }
    });

    it("leaves a closed panel alone", () => {
      const spy = vi.spyOn(panelStats, "filterStatisticsInSlices");

      new StatsManager(asMapApp(mockApp));

      expect(spy).not.toHaveBeenCalled();
      expect(statsPanel.firstChild).toBeNull();
      spy.mockRestore();
    });
  });

  describe("store subscriptions", () => {
    beforeEach(() => {
      mockApp.store.set("statsPanelVisible", true);
    });

    it("re-renders when the data, the filters or the selection change", () => {
      statsManager.updateStatsForSelection();
      expect(leadValue(statsPanel, "Flights")).toBe("2");

      mockApp.selectedYear = "2025";
      expect(leadValue(statsPanel, "Flights")).toBe("1");

      mockApp.selectedAircraft = "D-EFGH";
      expect(leadValue(statsPanel, "Flights")).toBe("0");

      mockApp.selectedAircraft = "all";
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      expect(
        document.getElementById("stats-rail-title")!.textContent,
      ).toContain("Statistics of the selection");

      mockApp.currentData = null;
      expect(leadValue(statsPanel, "Flights")).toBe("0");
    });

    it("renders on opening when the data arrived before the manager", () => {
      const app = createMockApp({ statsPanelVisible: false });
      app.currentData = mockApp.currentData;
      const panel = document.createElement("div");
      panel.id = "stats-panel";
      statsPanel.remove();
      document.body.appendChild(panel);
      try {
        new StatsManager(asMapApp(app));

        app.store.set("statsPanelVisible", true);

        expect(leadValue(panel, "Flights")).toBe("2");
      } finally {
        panel.remove();
      }
    });

    it("renders as soon as data arrives", () => {
      const app = createMockApp({ statsPanelVisible: true });
      const panel = document.createElement("div");
      panel.id = "stats-panel";
      statsPanel.remove();
      document.body.appendChild(panel);
      try {
        new StatsManager(asMapApp(app));
        expect(leadValue(panel, "Flights")).toBe("0");

        app.currentData = mockApp.currentData;

        expect(leadValue(panel, "Flights")).toBe("2");
      } finally {
        panel.remove();
      }
    });

    it("computes once for an update that changes several keys", () => {
      const spy = vi.spyOn(statsManager, "updateStatsForSelection");

      mockApp.store.batch(() => {
        mockApp.selectedYear = "2025";
        mockApp.selectedAircraft = "D-ABCD";
        mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      });

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });

  describe("destroy", () => {
    it("stops following the store and the size of the panel", () => {
      const removed = vi.spyOn(window, "removeEventListener");
      mockApp.store.set("statsPanelVisible", true);
      statsManager.updateStatsForSelection();
      expect(leadValue(statsPanel, "Flights")).toBe("2");

      statsManager.destroy();

      // The watcher of the fade no longer listens to the window
      expect(removed).toHaveBeenCalledWith("resize", expect.any(Function));
      mockApp.selectedYear = "2025";
      expect(leadValue(statsPanel, "Flights")).toBe("2");
      // A resize leaves the panel as it is
      statsPanel.classList.remove("is-at-end");
      window.dispatchEvent(new Event("resize"));
      expect(statsPanel.classList.contains("is-at-end")).toBe(false);
      removed.mockRestore();
    });
  });

  describe("closed panel", () => {
    it("computes nothing while the panel is closed (regression)", () => {
      const spy = vi.spyOn(panelStats, "calculateFilteredStatistics");
      const filterSpy = vi.spyOn(panelStats, "filterStatisticsInSlices");

      mockApp.selectedYear = "2025";
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set();

      expect(spy).not.toHaveBeenCalled();
      expect(filterSpy).not.toHaveBeenCalled();
      expect(statsPanel.firstChild).toBeNull();
      spy.mockRestore();
      filterSpy.mockRestore();
    });

    it("computes nothing behind the Flights tab, and catches up after", () => {
      const spy = vi.spyOn(panelStats, "filterStatisticsInSlices");
      mockApp.flightListVisible = true;
      mockApp.store.set("statsPanelVisible", true);
      mockApp.selectedYear = "2025";

      expect(spy).not.toHaveBeenCalled();
      expect(statsPanel.firstChild).toBeNull();

      mockApp.flightListVisible = false;

      expect(leadValue(statsPanel, "Flights")).toBe("1");
      spy.mockRestore();
    });

    it("renders what changed while closed when the panel opens", () => {
      mockApp.selectedYear = "2025";

      mockApp.store.set("statsPanelVisible", true);

      expect(leadValue(statsPanel, "Flights")).toBe("1");
    });

    it("does not recompute on opening when nothing changed", () => {
      mockApp.store.set("statsPanelVisible", true);
      mockApp.currentData = createDataset(
        mockApp.currentData!.path_info,
        mockApp.currentData!.path_segments,
      );
      mockApp.store.set("statsPanelVisible", false);
      const spy = vi.spyOn(statsManager, "updateStatsPanel");

      mockApp.store.set("statsPanelVisible", true);

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe("memoization", () => {
    beforeEach(() => {
      mockApp.store.set("statsPanelVisible", true);
    });

    it("computes the statistics once for unchanged inputs", () => {
      statsManager.updateStatsForSelection();
      const spy = vi.spyOn(panelStats, "calculateFilteredStatistics");
      const filterSpy = vi.spyOn(panelStats, "filterStatisticsInSlices");

      statsManager.updateStatsForSelection();
      // A mutation notification without an actual change is also a no-op

      expect(spy).not.toHaveBeenCalled();
      expect(filterSpy).not.toHaveBeenCalled();
      spy.mockRestore();
      filterSpy.mockRestore();
    });

    it("recomputes when the selection changes and again when it is cleared", () => {
      // In slices, as a large selection takes as long as a filter
      const spy = vi.spyOn(panelStats, "statisticsInSlices");

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      expect(spy).toHaveBeenCalledTimes(1);

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      expect(spy).toHaveBeenCalledTimes(2);

      // Back to the filter's statistics, computed when the panel opened
      mockApp.selectedPathIds = new Set();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(leadValue(statsPanel, "Flights")).toBe("2");
      spy.mockRestore();
    });

    it("keeps the filter's statistics for the next time a selection is cleared (regression)", () => {
      const spy = vi.spyOn(panelStats, "statisticsInSlices");
      const filterSpy = vi.spyOn(panelStats, "filterStatisticsInSlices");

      for (let i = 0; i < 3; i++) {
        mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
        mockApp.selectedPathIds = new Set();
      }

      // The filter's statistics were computed when the panel opened and are
      // kept with the filter view; only each selection is computed again
      expect(spy).toHaveBeenCalledTimes(3);
      expect(filterSpy).toHaveBeenCalledTimes(3);
      const [first, ...rest] = filterSpy.mock.results.map(
        (result) => result.value as FilteredStatistics,
      );
      for (const stats of rest) expect(stats).toBe(first);
      expect(leadValue(statsPanel, "Flights")).toBe("2");
      spy.mockRestore();
      filterSpy.mockRestore();
    });

    it("treats the same ids in another order as the same selection", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      const spy = vi.spyOn(panelStats, "statisticsInSlices");

      mockApp.selectedPathIds = new Set([1, 2]);

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("says it is loading while a large filter's statistics are worked out", async () => {
      // All the years of flights: longer than a slice
      let finish: (stats: FilteredStatistics) => void = () => {};
      const slices = vi
        .spyOn(panelStats, "filterStatisticsInSlices")
        .mockImplementationOnce(
          () => new Promise<FilteredStatistics>((done) => (finish = done)),
        );

      mockApp.selectedYear = "2025";

      expect(statsPanel.querySelector(".stats-loading")).not.toBeNull();
      expect(statsPanel.getAttribute("aria-busy")).toBe("true");
      finish({
        ...panelStats.calculateFilteredStatistics({
          pathInfo: [],
          segments: [],
        }),
        num_paths: 7,
      });
      await Promise.resolve();
      expect(statsPanel.hasAttribute("aria-busy")).toBe(false);
      expect(leadValue(statsPanel, "Flights")).toBe("7");
      slices.mockRestore();
    });

    it("shows the figures once the slices of a long filter are done", async () => {
      // The real slicing, with a clock that runs past a slice at every
      // step: the first slice hands back a promise and the rest follow in
      // tasks of their own
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => (now += 1000));
      const slices = vi.spyOn(panelStats, "filterStatisticsInSlices");

      mockApp.selectedYear = "2025";

      expect(slices).toHaveBeenCalledTimes(1);
      expect(slices.mock.results[0]!.value).toBeInstanceOf(Promise);
      expect(statsPanel.querySelector(".stats-loading")).not.toBeNull();
      expect(statsPanel.getAttribute("aria-busy")).toBe("true");

      await vi.runAllTimersAsync();

      expect(statsPanel.querySelector(".stats-loading")).toBeNull();
      expect(statsPanel.hasAttribute("aria-busy")).toBe(false);
      expect(leadValue(statsPanel, "Flights")).toBe("1");
    });

    it("works a long selection's statistics out in slices as well", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => (now += 1000));
      const slices = vi.spyOn(panelStats, "statisticsInSlices");

      mockApp.selectedPathIds = new Set([1, 2]);

      expect(slices.mock.results[0]!.value).toBeInstanceOf(Promise);
      expect(statsPanel.getAttribute("aria-busy")).toBe("true");

      await vi.runAllTimersAsync();

      expect(statsPanel.hasAttribute("aria-busy")).toBe(false);
      expect(leadValue(statsPanel, "Flights")).toBe("2");
    });

    it("drops statistics a newer filter has overtaken", async () => {
      let finish: (stats: FilteredStatistics) => void = () => {};
      let signal: AbortSignal | undefined;
      const slices = vi
        .spyOn(panelStats, "filterStatisticsInSlices")
        .mockImplementationOnce((_view, aborted) => {
          signal = aborted;
          return new Promise<FilteredStatistics>((done) => (finish = done));
        });
      mockApp.selectedYear = "2025";

      mockApp.selectedYear = "all";
      expect(signal?.aborted).toBe(true);
      const shown = leadValue(statsPanel, "Flights");
      finish({
        ...panelStats.calculateFilteredStatistics({
          pathInfo: [],
          segments: [],
        }),
        num_paths: 7,
      });
      await Promise.resolve();

      expect(leadValue(statsPanel, "Flights")).toBe(shown);
      slices.mockRestore();
    });

    it("recomputes for a replaced dataset of the same shape", () => {
      const spy = vi.spyOn(panelStats, "filterStatisticsInSlices");

      // The loader always builds new arrays for a new dataset
      mockApp.currentData = createDataset(
        [...mockApp.currentData!.path_info],
        [...mockApp.currentData!.path_segments],
        99,
      );

      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });
});
