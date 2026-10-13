import { describe, it, expect } from "vitest";
import { escapeHtml } from "../../../../flown/frontend/utils/escape";
import {
  generateAirportPopupHtml,
  applyMetricColors,
  generateSegmentPopupHtml,
  pluralFlights,
  pluralize,
  type SegmentPopupParams,
} from "../../../../flown/frontend/utils/htmlGenerators";
import {
  markFlightTimeUnits,
  splitAirportName,
} from "../../../../flown/frontend/utils/statsFormat";
import {
  getColorForAirspeed,
  getColorForAltitude,
  rgbToRgba,
} from "../../../../flown/frontend/utils/colors";
import { icon } from "../../../../flown/frontend/utils/icons";
import { ddToDms } from "../../../../flown/frontend/utils/geometry";

describe("htmlGenerators", () => {
  describe("escapeHtml", () => {
    it("escapes ampersands", () => {
      expect(escapeHtml("A&B")).toBe("A&amp;B");
    });

    it("escapes angle brackets", () => {
      expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
    });

    it("escapes double quotes", () => {
      expect(escapeHtml('a"b')).toBe("a&quot;b");
    });

    it("escapes single quotes", () => {
      expect(escapeHtml("a'b")).toBe("a&#39;b");
    });

    it("escapes all entities in a single string", () => {
      expect(escapeHtml(`<img src="x" onerror='alert(1)'>&`)).toBe(
        "&lt;img src=&quot;x&quot; onerror=&#39;alert(1)&#39;&gt;&amp;",
      );
    });

    it("returns strings without special characters unchanged", () => {
      expect(escapeHtml("Cessna 172")).toBe("Cessna 172");
    });

    it("handles empty string", () => {
      expect(escapeHtml("")).toBe("");
    });
  });

  describe("splitAirportName", () => {
    it("splits the airport's code from the airport name", () => {
      expect(splitAirportName("EDAQ Halle-Oppin", "EDAQ")).toEqual({
        code: "EDAQ",
        name: "Halle-Oppin",
      });
    });

    it("keeps multi-word names intact", () => {
      expect(splitAirportName("LFGA Colmar Houssen airport", "LFGA")).toEqual({
        code: "LFGA",
        name: "Colmar Houssen airport",
      });
    });

    it("keeps the whole label when there is no code", () => {
      expect(splitAirportName("Halle Oppin")).toEqual({
        code: "",
        name: "Halle Oppin",
      });
      expect(splitAirportName("EDAQ", "EDAQ")).toEqual({
        code: "",
        name: "EDAQ",
      });
      expect(splitAirportName("", "EDAQ")).toEqual({ code: "", name: "" });
    });

    it("guesses no code from the label (regression)", () => {
      // What looked like a code was taken for one: a three-letter word, or
      // a code the export did not find the airport's
      expect(splitAirportName("OLD Airfield")).toEqual({
        code: "",
        name: "OLD Airfield",
      });
      expect(splitAirportName("EDAQ Halle-Oppin")).toEqual({
        code: "",
        name: "EDAQ Halle-Oppin",
      });
      // A code further on is the airport's, but there is no name to split
      expect(splitAirportName("Halle EDAQ", "EDAQ")).toEqual({
        code: "",
        name: "Halle EDAQ",
      });
    });
  });

  describe("markFlightTimeUnits", () => {
    it("wraps the hour and minute units", () => {
      expect(markFlightTimeUnits("47h 44m", "stat-unit")).toBe(
        '47<span class="stat-unit">h</span> 44<span class="stat-unit">m</span>',
      );
    });

    it("leaves a time without both units alone", () => {
      expect(markFlightTimeUnits("44m", "stat-unit")).toBe("44m");
      expect(markFlightTimeUnits("", "stat-unit")).toBe("");
    });

    it("escapes the text before marking it up", () => {
      expect(markFlightTimeUnits("<b>1h 2m</b>", "stats-lead-unit")).toBe(
        '&lt;b&gt;1<span class="stats-lead-unit">h</span> 2<span class="stats-lead-unit">m</span>&lt;/b&gt;',
      );
    });
  });

  describe("pluralize", () => {
    it("uses the singular for one", () => {
      expect(pluralize(1, "data point")).toBe("1 data point");
    });

    it("uses the plural otherwise", () => {
      expect(pluralize(0, "data point")).toBe("0 data points");
      expect(pluralize(2, "selected path")).toBe("2 selected paths");
    });

    it("takes an irregular plural", () => {
      expect(pluralize(1, "country", "countries")).toBe("1 country");
      expect(pluralize(3, "country", "countries")).toBe("3 countries");
    });
  });

  describe("pluralFlights", () => {
    it("uses the singular for one flight", () => {
      expect(pluralFlights(1)).toBe("1 flight");
    });

    it("uses the plural otherwise", () => {
      expect(pluralFlights(0)).toBe("0 flights");
      expect(pluralFlights(12)).toBe("12 flights");
    });
  });

  describe("generateAirportPopupHtml", () => {
    const params = {
      name: "Frankfurt EDDF",
      lat: 50.1,
      lon: 8.67,
      latDms: "50°6'0.0\"N",
      lonDms: "8°40'12.0\"E",
      flightCount: 20,
      isHomeBase: false,
    };

    it("renders name, coordinates link and flight count with classes only", () => {
      const html = generateAirportPopupHtml(params);

      expect(html).toContain('class="popup-container popup-airport"');
      // Focus lands on it, so it has a name a screen reader can say
      expect(html).toContain('role="group"');
      expect(html).toContain('class="popup-header popup-header-airport"');
      expect(html).toContain("Frankfurt EDDF");
      expect(html).toContain('href="https://www.google.com/maps?q=50.1,8.67"');
      expect(html).toContain('class="popup-link"');
      expect(html).toContain(params.latDms);
      expect(html).toContain('class="popup-metric-label">Flights shown');
      expect(html).toContain('class="popup-metric-value popup-accent">20');
      expect(html).not.toContain("style=");
      expect(html).not.toContain("HOME");
    });

    it("renders the home badge for the home base", () => {
      const html = generateAirportPopupHtml({ ...params, isHomeBase: true });
      expect(html).toContain('<span class="popup-home-badge">HOME</span>');
      // Its header in the home colour, like its marker and badge, where it
      // was in the green of every other airport's (regression)
      expect(html).toContain("popup-header-home");
      expect(generateAirportPopupHtml(params)).not.toContain(
        "popup-header-home",
      );
    });

    it("escapes the name and falls back to Unknown", () => {
      expect(generateAirportPopupHtml({ ...params, name: "<b>" })).toContain(
        "&lt;b&gt;",
      );
      expect(generateAirportPopupHtml({ ...params, name: "" })).toContain(
        "Unknown",
      );
    });
  });

  describe("generateSegmentPopupHtml", () => {
    const fullParams: SegmentPopupParams = {
      segment: {
        path_id: 1,
        altitude_ft: 3000,
        groundspeed_knots: 120,
        coords: [
          [48.0, 11.0],
          [49.0, 12.0],
        ],
      },
      altRange: { min: 0, max: 5000 },
      speedRange: { min: 0, max: 200 },
    };

    it("renders altitude and groundspeed with their colours as data", () => {
      const html = generateSegmentPopupHtml(fullParams);

      expect(html).toContain("3,000 ft");
      expect(html).toContain("(914 m)");
      expect(html).toContain("120 kt");
      expect(html).toContain("222 km/h");
      expect(html).toContain("Altitude (MSL)");
      expect(html).toContain("Groundspeed");

      const altColor = getColorForAltitude(3000, 0, 5000);
      const speedColor = getColorForAirspeed(120, 0, 200);
      expect(html).toContain(
        `class="popup-metric popup-metric-colored" data-metric-color="${altColor}"`,
      );
      expect(html).toContain(
        `class="popup-metric popup-metric-colored" data-metric-color="${speedColor}"`,
      );
      // The CSP would block a style attribute
      expect(html).not.toContain("style=");
      expect(html).toContain('class="popup-header popup-header-segment"');
    });

    it("applyMetricColors carries the colours into custom properties", () => {
      const host = document.createElement("div");
      host.innerHTML = generateSegmentPopupHtml(fullParams);
      applyMetricColors(host);

      const altColor = getColorForAltitude(3000, 0, 5000);
      const metric = host.querySelector<HTMLElement>("[data-metric-color]")!;
      expect(metric.style.getPropertyValue("--metric-color")).toBe(altColor);
      expect(metric.style.getPropertyValue("--metric-bg")).toBe(
        rgbToRgba(altColor, 0.15),
      );
    });

    it("rounds altitude to 50 ft steps", () => {
      const html = generateSegmentPopupHtml({
        ...fullParams,
        segment: { ...fullParams.segment, altitude_ft: 3024 },
      });
      expect(html).toContain("3,000 ft");

      const html2 = generateSegmentPopupHtml({
        ...fullParams,
        segment: { ...fullParams.segment, altitude_ft: 3026 },
      });
      expect(html2).toContain("3,050 ft");
    });

    it("uses default title and icon", () => {
      const html = generateSegmentPopupHtml(fullParams);

      expect(html).toContain("On this flight");
      expect(html).toContain(icon("aircraft", 20));
      // Drawn from the icon family rather than an emoji, which renders at a
      // different weight and baseline on every platform
      expect(html).toContain("<svg");
      expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("uses custom title and icon when provided", () => {
      const html = generateSegmentPopupHtml({
        ...fullParams,
        title: "Current position",
        icon: icon("airport", 20),
      });

      expect(html).toContain("Current position");
      expect(html).toContain(icon("airport", 20));
      expect(html).not.toContain("On this flight");
      expect(html).not.toContain(icon("aircraft", 20));
    });

    it("shows a sea-level altitude, and no groundspeed where there is none", () => {
      // A log without timing: the build writes its unknown speeds as 0
      const html = generateSegmentPopupHtml({
        ...fullParams,
        segment: {
          ...fullParams.segment,
          altitude_ft: 0,
          groundspeed_knots: 0,
        },
      });

      expect(html).toContain("0 ft");
      expect(html).toContain("(0 m)");
      expect(html).not.toContain("Groundspeed");
      expect(html).not.toContain(" kt");
      expect(html).toContain(
        `data-metric-color="${getColorForAltitude(0, 0, 5000)}"`,
      );
    });

    it("computes track from segment coordinates", () => {
      const html = generateSegmentPopupHtml(fullParams);

      expect(html).toContain('<span class="popup-track">Track: 033°</span>');
      expect(html).not.toContain("N/A");
    });

    it("never reads a track just short of north as 360", () => {
      // Due north but a hair west of it: 359.6 degrees used to round to 360
      const html = generateSegmentPopupHtml({
        ...fullParams,
        segment: {
          ...fullParams.segment,
          coords: [
            [48.0, 11.0],
            [49.0, 10.992],
          ],
        },
      });

      expect(html).toContain("Track: 000°");
      expect(html).not.toContain("360°");
    });

    it("shows the given position instead of the segment's end", () => {
      const html = generateSegmentPopupHtml({
        ...fullParams,
        position: [48.5, 11.5],
      });

      expect(html).toContain(ddToDms(48.5, true));
      expect(html).toContain(ddToDms(11.5, false));
      expect(html).not.toContain(ddToDms(49.0, true));
    });

    it("formats the end position in DMS", () => {
      const html = generateSegmentPopupHtml(fullParams);

      expect(html).toContain("49°0'0.0\"N 12°0'0.0\"E");
    });
  });
});
