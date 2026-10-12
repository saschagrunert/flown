import { describe, it, expect } from "vitest";
import {
  countryMark,
  generateStatsHtml,
  generateFunFactsHtml,
  calculateAircraftColorClass,
  generateAircraftFleetHtml,
  generateHomeBaseHtml,
  generateDestinationsHtml,
} from "../../../../flown/frontend/utils/wrappedHtml";
import type { AirportCount } from "../../../../flown/frontend/utils/htmlGenerators";
import type {
  FilteredStatistics,
  FunFact,
  YearStats,
} from "../../../../flown/frontend/types";
import { icon } from "../../../../flown/frontend/utils/icons";
import { markup } from "../../../../flown/frontend/utils/markup";
import { generateFunFacts } from "../../../../flown/frontend/features/wrapped";

/**
 * The ICAO code the export writes for an airport (airports.json's `code`).
 * The names here lead with it where they have one.
 */
const exportedCode = (name: string): string | undefined =>
  /^[A-Z]{4}(?= )/.exec(name)?.[0];

describe("wrappedHtml", () => {
  describe("generateStatsHtml", () => {
    const mockYearStats: YearStats = {
      total_flights: 42,
      num_airports: 10,
      total_distance_nm: 12345.67,
      flight_time: "123h 45m",
      airport_names: ["EDDF", "EDDH"],
      aircraft_list: [],
    };

    const mockFilteredStats: FilteredStatistics = {
      total_distance_km: 22870.5,
      total_distance_nm: 12345.67,
      total_points: 1000,
      num_paths: 42,
      num_airports: 10,
      airport_names: ["EDDF", "EDDH"],
      num_aircraft: 2,
      aircraft_list: [],
      min_altitude_m: 0,
      max_altitude_m: 11000,
      min_altitude_ft: 0,
      max_altitude_ft: 36090,
      max_groundspeed_knots: 450,
    };

    it("generates stats HTML without timing data", () => {
      const html = generateStatsHtml(mockYearStats, mockFilteredStats, false);

      expect(html).toContain('<div class="stat-card">');
      expect(html).toContain('<div class="stat-value">42</div>');
      expect(html).toContain('<div class="stat-label">Flights</div>');
      expect(html).toContain('<div class="stat-value">10</div>');
      expect(html).toContain('<div class="stat-label">Airports</div>');
      expect(html).toContain(
        '<div class="stat-value">12,345.7<span class="stat-unit">nm</span></div>',
      );
      expect(html).toContain('<div class="stat-label">Distance</div>');
      // 11000 m in feet, grouped, with the unit in its own element
      expect(html).toContain(
        '<div class="stat-value">36,089<span class="stat-unit">ft</span></div>',
      );
      expect(html).toContain(
        '<div class="stat-label">Max altitude (MSL)</div>',
      );

      // Should not include timing data
      expect(html).not.toContain("Flight time");
      expect(html).not.toContain("Max groundspeed");
    });

    it("generates stats HTML with timing data", () => {
      const html = generateStatsHtml(mockYearStats, mockFilteredStats, true);

      expect(html).toContain(
        '123<span class="stat-unit">h</span> 45<span class="stat-unit">m</span>',
      );
      expect(html).toContain('<div class="stat-label">Flight time</div>');
      expect(html).toContain(
        '<div class="stat-value">450<span class="stat-unit">kt</span></div>',
      );
      expect(html).toContain('<div class="stat-label">Max groundspeed</div>');
    });

    it("leaves out the altitude card without statistics", () => {
      const html = generateStatsHtml(mockYearStats, null, false);

      expect(html).toContain("42");
      expect(html).not.toContain("Max altitude");
      expect(html).not.toContain('<span class="stat-unit">ft</span>');
    });

    it("leaves out the altitude card when no path has an altitude", () => {
      const withoutAltitude: FilteredStatistics = {
        ...mockFilteredStats,
        max_altitude_m: undefined,
      };

      const html = generateStatsHtml(mockYearStats, withoutAltitude, false);

      expect(html).not.toContain("Max altitude");
    });

    it("handles missing max_groundspeed_knots", () => {
      const statsWithoutGroundspeed: FilteredStatistics = {
        ...mockFilteredStats,
        max_groundspeed_knots: undefined,
      };

      const html = generateStatsHtml(
        mockYearStats,
        statsWithoutGroundspeed,
        true,
      );

      expect(html).toContain('0<span class="stat-unit">kt</span>');
    });

    it("formats distance like the statistics panel", () => {
      const stats: YearStats = {
        ...mockYearStats,
        total_distance_nm: 9999.999,
      };

      const html = generateStatsHtml(stats, mockFilteredStats, false);

      // One decimal and grouped digits, so the card and the panel agree
      expect(html).toContain("10,000.0");
    });
  });

  describe("generateFunFactsHtml", () => {
    it("generates fun facts HTML", () => {
      const funFacts: FunFact[] = [
        {
          category: "distance",
          text: markup`You flew 10,000 miles!`,
          priority: 1,
        },
        {
          category: "altitude",
          text: markup`Reached 35,000 feet`,
          priority: 2,
        },
      ];

      const html = generateFunFactsHtml(funFacts);

      expect(html).toContain(
        '<h2 id="wrapped-fun-facts-title" class="fun-facts-title">',
      );
      expect(html).toContain(
        '<span class="section-title-text">Facts</span></h2>',
      );
      expect(html).toContain('<div class="fun-fact" data-category="distance">');
      // The category names the icon, drawn from the one icon family
      expect(html).toContain(
        '<span class="fun-fact-icon">' + icon("distance", 20) + "</span>",
      );
      expect(html).toContain(
        '<span class="fun-fact-text">You flew 10,000 miles!</span>',
      );
      expect(html).toContain('data-category="altitude"');
      expect(html).toContain(
        '<span class="fun-fact-icon">' + icon("altitude", 20) + "</span>",
      );
      expect(html).toContain(
        '<span class="fun-fact-text">Reached 35,000 feet</span>',
      );
    });

    it("handles empty fun facts array", () => {
      const html = generateFunFactsHtml([]);

      expect(html).toContain(
        '<h2 id="wrapped-fun-facts-title" class="fun-facts-title">',
      );
      expect(html).toContain(
        '<span class="section-title-text">Facts</span></h2>',
      );
      expect(html).not.toContain("fun-fact-text");
    });

    it("renders the markup of a fact's text, and escapes the category", () => {
      const funFacts: FunFact[] = [
        {
          category: 'a"b',
          text: markup`Flew <strong>${"far"}</strong>`,
          priority: 1,
        },
      ];

      const rendered = generateFunFactsHtml(funFacts);

      // The text is markup made with its values escaped; the category
      // lands in an attribute and is escaped here
      expect(rendered).toContain("Flew <strong>far</strong>");
      expect(rendered).toContain('data-category="a&quot;b"');
    });

    it("writes a value of the data into a fact as text, never as markup", () => {
      const registration = "<img src=x onerror=alert(1)>";
      const facts = generateFunFacts({
        total_flights: 2,
        total_distance_nm: 100,
        num_airports: 1,
        airport_names: [],
        flight_time: "1h 0m",
        aircraft_list: [
          { registration, type: "C172", model: "C172", flights: 2 },
        ],
      });

      const rendered = generateFunFactsHtml(facts);

      expect(rendered).toContain(
        "Loyal to <strong>&lt;img src=x onerror=alert(1)&gt;</strong>, all 2 flights in this C172!",
      );
      expect(rendered).not.toContain("<img");
    });
  });

  describe("calculateAircraftColorClass", () => {
    it("returns high class for the top quarter of the range", () => {
      expect(calculateAircraftColorClass(8, 10, 1)).toBe("fleet-aircraft-high");
      expect(calculateAircraftColorClass(10, 10, 1)).toBe(
        "fleet-aircraft-high",
      );
    });

    it("returns medium-high class for the third quarter", () => {
      expect(calculateAircraftColorClass(5.5, 10, 1)).toBe(
        "fleet-aircraft-medium-high",
      );
      expect(calculateAircraftColorClass(7.5, 10, 1)).toBe(
        "fleet-aircraft-medium-high",
      );
    });

    it("returns medium-low class for the second quarter", () => {
      expect(calculateAircraftColorClass(4, 10, 1)).toBe(
        "fleet-aircraft-medium-low",
      );
    });

    it("returns low class for the bottom quarter", () => {
      expect(calculateAircraftColorClass(1, 10, 1)).toBe("fleet-aircraft-low");
      expect(calculateAircraftColorClass(3, 10, 1)).toBe("fleet-aircraft-low");
    });

    it("returns high class when every aircraft has the same count", () => {
      expect(calculateAircraftColorClass(5, 5, 5)).toBe("fleet-aircraft-high");
    });
  });

  describe("generateAircraftFleetHtml", () => {
    it("generates aircraft fleet HTML", () => {
      const yearStats: YearStats = {
        total_flights: 50,
        num_airports: 5,
        total_distance_nm: 10000,
        flight_time: "100h",
        airport_names: [],
        aircraft_list: [
          {
            registration: "D-EABC",
            model: "Cessna 172",
            type: "C172",
            flights: 20,
            flight_time_str: "50h 30m",
          },
          {
            registration: "D-EXYZ",
            model: "Piper PA-28",
            type: "PA28",
            flights: 10,
            flight_time_str: "25h 15m",
          },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      expect(html).toContain(
        '<h2 id="wrapped-aircraft-fleet-title" class="aircraft-fleet-title">',
      );
      expect(html).toContain(
        '<span class="section-title-text">Fleet</span></h2>',
      );
      expect(html).toContain('class="fleet-aircraft fleet-aircraft-high"');
      expect(html).toContain("D-EABC");
      expect(html).toContain("Cessna 172");
      expect(html).toContain("20 flights");
      expect(html).toContain("50h 30m");
      expect(html).toContain("D-EXYZ");
      expect(html).toContain("Piper PA-28");
      expect(html).toContain("10 flights");
      expect(html).toContain("25h 15m");
    });

    it("uses type when model is not available", () => {
      const yearStats: YearStats = {
        total_flights: 10,
        num_airports: 2,
        total_distance_nm: 1000,
        flight_time: "10h",
        airport_names: [],
        aircraft_list: [
          {
            registration: "D-EABC",
            type: "C172",
            flights: 10,
          },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      expect(html).toContain("C172");
      expect(html).not.toContain("undefined");
    });

    it("shows the flight time the aircraft data carries", () => {
      const yearStats: YearStats = {
        total_flights: 30,
        num_airports: 2,
        total_distance_nm: 1000,
        flight_time: "100h 0m",
        airport_names: [],
        aircraft_list: [
          {
            registration: "D-EABC",
            type: "C172",
            flights: 20,
            flight_time_str: "25h 34m",
          },
          {
            registration: "D-EXYZ",
            type: "PA28",
            flights: 10,
            flight_time_str: "8h 35m",
          },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      expect(html).toContain('<div class="fleet-aircraft-time">25h 34m</div>');
      expect(html).toContain('<div class="fleet-aircraft-time">8h 35m</div>');
      // Not the total divided by the flights or any other derived value
      expect(html).not.toContain("100h 0m");
      expect(html).not.toContain("5h 0m");
    });

    it("shows --- for missing flight time", () => {
      const yearStats: YearStats = {
        total_flights: 10,
        num_airports: 2,
        total_distance_nm: 1000,
        flight_time: "10h",
        airport_names: [],
        aircraft_list: [
          {
            registration: "D-EABC",
            type: "C172",
            flights: 10,
          },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      expect(html).toContain("---");
    });

    it("applies correct color classes based on flight count", () => {
      const yearStats: YearStats = {
        total_flights: 100,
        num_airports: 5,
        total_distance_nm: 10000,
        flight_time: "100h",
        airport_names: [],
        aircraft_list: [
          { registration: "HIGH", flights: 100 },
          { registration: "MED-HIGH", flights: 70 },
          { registration: "MED-LOW", flights: 40 },
          { registration: "LOW", flights: 10 },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      // Check that different color classes are applied
      expect(html).toContain("fleet-aircraft-high");
      expect(html).toContain("fleet-aircraft-medium-high");
      expect(html).toContain("fleet-aircraft-medium-low");
      expect(html).toContain("fleet-aircraft-low");
    });

    it("returns empty string for empty aircraft list", () => {
      const yearStats: YearStats = {
        total_flights: 0,
        num_airports: 0,
        total_distance_nm: 0,
        flight_time: "0h",
        airport_names: [],
        aircraft_list: [],
      };

      const html = generateAircraftFleetHtml(yearStats);

      expect(html).toBe("");
    });

    it("returns empty string for undefined aircraft list", () => {
      const yearStats = {
        total_flights: 0,
        num_airports: 0,
        total_distance_nm: 0,
        flight_time: "0h",
        airport_names: [],
      };

      const html = generateAircraftFleetHtml(yearStats as unknown as YearStats);

      expect(html).toBe("");
    });

    it("handles single aircraft (no flight range)", () => {
      const yearStats: YearStats = {
        total_flights: 10,
        num_airports: 2,
        total_distance_nm: 1000,
        flight_time: "10h",
        airport_names: [],
        aircraft_list: [
          {
            registration: "D-EABC",
            model: "Cessna 172",
            flights: 10,
          },
        ],
      };

      const html = generateAircraftFleetHtml(yearStats);

      // With single aircraft, normalized = 1, should get high class
      expect(html).toContain("fleet-aircraft-high");
    });
  });

  describe("generateHomeBaseHtml", () => {
    it("generates home base HTML", () => {
      const homeBase: AirportCount = {
        name: "EDDF",
        flight_count: 25,
      };

      const html = generateHomeBaseHtml(homeBase);

      expect(html).toContain(
        '<h2 id="wrapped-top-airports-title" class="top-airports-title">',
      );
      expect(html).toContain(
        '<span class="section-title-text">Home base</span></h2>',
      );
      expect(html).toContain(
        '<div class="top-airport-name"><span class="top-airport-place">EDDF</span></div>',
      );
      expect(html).toContain('<div class="top-airport-count">25 flights</div>');
    });

    it("handles singular flight count", () => {
      const homeBase: AirportCount = {
        name: "EDDH",
        flight_count: 1,
      };

      const html = generateHomeBaseHtml(homeBase);

      expect(html).toContain("1 flight");
      expect(html).not.toContain("1 flights");
    });

    it("splits the ICAO code from the home base name", () => {
      const html = generateHomeBaseHtml(
        { name: "EDAQ Halle-Oppin", flight_count: 25 },
        "EDAQ",
      );

      expect(html).toContain(
        '<span class="top-airport-code">EDAQ</span>' +
          '<span class="top-airport-place">Halle-Oppin</span>',
      );
      expect(html).toContain("25 flights");
    });

    it("escapes the home base name", () => {
      const html = generateHomeBaseHtml({
        name: "<b>x</b>",
        flight_count: 2,
      });

      expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
      expect(html).not.toContain("<b>");
    });

    it("handles zero flights", () => {
      const homeBase: AirportCount = {
        name: "EDDK",
        flight_count: 0,
      };

      const html = generateHomeBaseHtml(homeBase);

      expect(html).toContain("0 flights");
    });
  });

  describe("generateDestinationsHtml", () => {
    const identity = (code: string) => code;
    const noFlags = () => null;
    const plain = {
      countryName: identity,
      flagSrc: noFlags,
      airportCode: exportedCode,
    };

    it("generates grouped destinations HTML", () => {
      const grouped = new Map([
        ["DE", ["EDDH Hamburg", "EDDM Munich"]],
        ["AT", ["LOWW Vienna"]],
      ]);

      const html = generateDestinationsHtml(grouped, plain);

      expect(html).toContain(
        '<h2 id="wrapped-airports-grid-title" class="airports-grid-title">',
      );
      expect(html).toContain(
        '<span class="section-title-text">Destinations</span></h2>',
      );
      expect(html).toContain('<div class="country-group"');
      expect(html).toContain('<span class="country-name">DE</span>');
      expect(html).toContain('<span class="country-count">2</span>');
      expect(html).toContain('<span class="country-name">AT</span>');
      expect(html).toContain('<span class="country-count">1</span>');
    });

    it("renders one row per airport with code and full name", () => {
      const grouped = new Map([["DE", ["EDDH Hamburg Helmut Schmidt"]]]);

      const html = generateDestinationsHtml(grouped, plain);

      expect(html).toContain('<ul class="country-airports">');
      expect(html).toContain(
        '<li class="destination"><span class="destination-code">EDDH</span>' +
          '<span class="destination-name">Hamburg Helmut Schmidt</span></li>',
      );
    });

    it("shows the exported code and reads none from the name", () => {
      const grouped = new Map([["DE", ["EDDH Hamburg", "EDDM Munich"]]]);

      const html = generateDestinationsHtml(grouped, {
        ...plain,
        airportCode: (name) => (name === "EDDH Hamburg" ? "EDDH" : undefined),
      });

      expect(html).toContain('<span class="destination-code">EDDH</span>');
      expect(html).toContain(
        '<span class="destination-name">EDDM Munich</span>',
      );
      expect(html.match(/destination-code/g)).toHaveLength(1);
    });

    it("keeps the whole label as the name when there is no code", () => {
      const grouped = new Map([["Other", ["Some Field"]]]);

      const html = generateDestinationsHtml(grouped, plain);

      expect(html).toContain(
        '<span class="destination-name">Some Field</span>',
      );
      expect(html).not.toContain("destination-code");
      expect(html).toContain('<span class="country-name">Other</span>');
    });

    it("accents the home base and the furthest destination", () => {
      const grouped = new Map([
        ["DE", ["EDAQ Home", "EDDM Munich", "EDDH Ham"]],
      ]);

      const html = generateDestinationsHtml(grouped, {
        ...plain,
        homeBase: "EDAQ Home",
        furthest: "EDDM Munich",
      });

      expect(html).toContain(
        '<li class="destination is-home"><span class="destination-code">EDAQ</span>' +
          '<span class="destination-name">Home</span>' +
          '<span class="destination-tag">Home</span></li>',
      );
      expect(html).toContain(
        '<li class="destination is-furthest"><span class="destination-code">EDDM</span>' +
          '<span class="destination-name">Munich</span>' +
          '<span class="destination-tag">Furthest</span></li>',
      );
      // Only those two accents, nothing else is marked
      expect(html.match(/destination-tag/g)).toHaveLength(2);
      expect(html).toContain(
        '<li class="destination"><span class="destination-code">EDDH</span>',
      );
    });

    it("never marks the home base as the furthest destination", () => {
      const grouped = new Map([["DE", ["EDAQ Home"]]]);

      const html = generateDestinationsHtml(grouped, {
        ...plain,
        homeBase: "EDAQ Home",
        furthest: "EDAQ Home",
      });

      expect(html).toContain('class="destination is-home"');
      expect(html).not.toContain("is-furthest");
    });

    it("gives every destination a code, a name and nothing else", () => {
      const grouped = new Map([
        ["DE", ["EDDH Hamburg", "EDDM Munich", "Grass strip"]],
      ]);

      const container = document.createElement("div");
      container.innerHTML = generateDestinationsHtml(grouped, {
        ...plain,
        homeBase: "EDDH Hamburg",
      });

      const rows = [...container.querySelectorAll("li.destination")].map(
        (row) =>
          [...row.children].map((child) => [
            child.className,
            child.textContent,
          ]),
      );
      expect(rows).toEqual([
        // The home base carries the one extra element, its tag
        [
          ["destination-code", "EDDH"],
          ["destination-name", "Hamburg"],
          ["destination-tag", "Home"],
        ],
        [
          ["destination-code", "EDDM"],
          ["destination-name", "Munich"],
        ],
        // A label without a code keeps its full text as the name
        [["destination-name", "Grass strip"]],
      ]);
    });

    it("returns empty string for empty map", () => {
      const html = generateDestinationsHtml(new Map(), plain);

      expect(html).toBe("");
    });

    it("shows the country's flag where the site carries one", () => {
      const grouped = new Map([["DE", ["EDDF Frankfurt"]]]);

      const html = generateDestinationsHtml(grouped, {
        countryName: () => "Germany",
        flagSrc: (code) => `flags/${code.toLowerCase()}.svg`,
        airportCode: exportedCode,
      });

      expect(html).toContain('<img class="country-flag" src="flags/de.svg"');
      // Decoration: the name beside it says the country
      expect(html).toContain('alt=""');
      expect(html).not.toContain("country-code");
    });

    it("marks a country by a flag or a code that a screen reader skips", () => {
      // The name beside it says the country: "DE Germany" said it twice
      expect(countryMark("DE", "flags/de.svg", "country", 18, 14)).toBe(
        '<img class="country-flag" src="flags/de.svg" alt="" width="18" height="14" loading="lazy">',
      );
      expect(countryMark("DE", null, "kh-stats-group", 16, 12)).toBe(
        '<span class="kh-stats-group-code" aria-hidden="true">DE</span>',
      );
    });

    it("labels a group with the ISO code and the country name", () => {
      const grouped = new Map([["DE", ["EDDF Frankfurt"]]]);
      const displayName = (code: string) => (code === "DE" ? "Germany" : code);

      const html = generateDestinationsHtml(grouped, {
        countryName: displayName,
        flagSrc: () => null,
        airportCode: exportedCode,
      });

      // A code chip rather than a flag emoji: Windows renders no flags
      expect(html).toContain(
        '<span class="country-code" aria-hidden="true">DE</span>',
      );
      expect(html).toContain('<span class="country-name">Germany</span>');
      expect(html).toContain("EDDF");
      expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("escapes country and airport names", () => {
      const grouped = new Map([["XX", ["<img src=x>"]]]);

      const html = generateDestinationsHtml(grouped, {
        countryName: () => "<b>Country</b>",
        flagSrc: () => null,
        airportCode: exportedCode,
      });

      expect(html).toContain("&lt;b&gt;Country&lt;/b&gt;");
      expect(html).toContain("&lt;img src=x&gt;");
      expect(html).not.toContain("<img");
    });

    it("carries no style attribute, which the CSP would block", () => {
      const grouped = new Map([
        ["DE", ["EDDH Hamburg"]],
        ["AT", ["LOWW Vienna"]],
      ]);

      expect(generateDestinationsHtml(grouped, plain)).not.toContain("style=");
    });

    it("preserves airport order within groups", () => {
      const grouped = new Map([["DE", ["ZULU", "ALPHA", "MIKE"]]]);

      const html = generateDestinationsHtml(grouped, plain);

      const zuluIndex = html.indexOf("ZULU");
      const alphaIndex = html.indexOf("ALPHA");
      const mikeIndex = html.indexOf("MIKE");

      expect(zuluIndex).toBeLessThan(alphaIndex);
      expect(alphaIndex).toBeLessThan(mikeIndex);
    });
  });
});
