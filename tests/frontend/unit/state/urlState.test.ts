import { describe, it, expect, afterEach } from "vitest";
import {
  isSectionLine,
  parseUrlParams,
  encodeStateToUrl,
  SHARE_INTRO_PARAM,
  takeShareIntro,
} from "../../../../flown/frontend/state/urlState";
import { MAX_ZOOM, MIN_ZOOM } from "../../../../flown/frontend/utils/constants";
import {
  initialToggles,
  TOGGLES,
  type ToggleKey,
} from "../../../../flown/frontend/state/toggles";
import type { AppState } from "../../../../flown/frontend/types";

/**
 * Small seeded PRNG (mulberry32) so the property test is reproducible
 * without adding a dependency.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomState(rnd: () => number): AppState {
  const bool = (): boolean => rnd() < 0.5;
  const years = ["all", "2020", "2024", "2025"];
  const aircraft = ["D-EAGJ", "N123AB", "OE-XYZ", "HB-1", "G-ABCD"];
  const pathCount = Math.floor(rnd() * 6);
  const pathIds = Array.from({ length: pathCount }, () =>
    Math.floor(rnd() * 5000),
  );
  return {
    selectedYear: years[Math.floor(rnd() * years.length)]!,
    selectedAircraft: aircraft[Math.floor(rnd() * aircraft.length)]!,
    selectedPathIds: pathIds,
    heatmapVisible: bool(),
    altitudeVisible: bool(),
    airspeedVisible: bool(),
    airportsVisible: bool(),
    aviationVisible: bool(),
    statsPanelVisible: bool(),
    wrappedVisible: bool(),
    isolateSelection: bool(),
    center: {
      lat: Math.round((rnd() * 180 - 90) * 1e6) / 1e6,
      lng: Math.round((rnd() * 360 - 180) * 1e6) / 1e6,
    },
    zoom: Math.round((MIN_ZOOM + rnd() * (MAX_ZOOM - MIN_ZOOM)) * 100) / 100,
    // Half of the views are north up and flat, like most real ones
    bearing: bool() ? 0 : Math.round((rnd() * 360 - 180) * 10) / 10,
    pitch: bool() ? 0 : Math.round(rnd() * 850) / 10,
    globeVisible: bool(),
    threeDVisible: bool(),
    satelliteVisible: bool(),
    flightListVisible: bool(),
  };
}

describe("URL state management", () => {
  describe("parseUrlParams", () => {
    it("returns null for empty params", () => {
      expect(parseUrlParams("")).toBeNull();
      expect(parseUrlParams(new URLSearchParams())).toBeNull();
    });

    it("parses year parameter", () => {
      expect(parseUrlParams("y=2025")).toEqual({ selectedYear: "2025" });
      expect(parseUrlParams("y=all")).toEqual({ selectedYear: "all" });
    });

    it("ignores empty year and aircraft values", () => {
      expect(parseUrlParams("y=&a=")).toEqual({});
    });

    it("parses aircraft parameter", () => {
      expect(parseUrlParams("a=D-EAGJ")).toEqual({
        selectedAircraft: "D-EAGJ",
      });
    });

    it("parses path IDs when the schema version matches", () => {
      expect(parseUrlParams("p=5&sv=4")).toEqual({ selectedPathIds: [5] });
      expect(parseUrlParams("p=a5,1x&sv=4")).toEqual({
        selectedPathIds: [365, 69],
      });
      // Schema 3 named the same flights in decimal and is still read
      expect(parseUrlParams("p=5&sv=3")).toEqual({ selectedPathIds: [5] });
      expect(parseUrlParams("p=1,5,12,25&sv=3")).toEqual({
        selectedPathIds: [1, 5, 12, 25],
      });
    });

    it("parses content hash ids exactly", () => {
      expect(parseUrlParams("p=840108108563,1099511627775&sv=3")).toEqual({
        selectedPathIds: [840108108563, 1099511627775],
      });
    });

    it("ignores path IDs without a current schema version", () => {
      // Ids from an older release were positions in the export and would
      // select different flights, so they are dropped rather than applied
      expect(parseUrlParams("p=1,5,12")).toEqual({});
      expect(parseUrlParams("p=1,5,12&sv=1")).toEqual({});
      expect(parseUrlParams("p=1,5,12&sv=2")).toEqual({});
      expect(parseUrlParams("y=2025&p=1,5")).toEqual({ selectedYear: "2025" });
    });

    it("filters out invalid path IDs", () => {
      expect(parseUrlParams("p=1,invalid,5,NaN,,12&sv=3")).toEqual({
        selectedPathIds: [1, 5, 12],
      });
    });

    it("parses the nine visibility flags", () => {
      expect(parseUrlParams("v=101010101")).toEqual({
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: true,
        airportsVisible: false,
        aviationVisible: true,
        statsPanelVisible: false,
        wrappedVisible: true,
        isolateSelection: true,
      });
    });

    it("reads nothing from slot 7, which the control chrome had", () => {
      expect(parseUrlParams("v=100100010")).toEqual(
        parseUrlParams("v=100100000"),
      );
    });

    it("ignores the shorter visibility strings of older releases", () => {
      // 6 to 8 flags, from before Wrapped, the chrome and isolating
      expect(parseUrlParams("v=101010")).toEqual({});
      expect(parseUrlParams("v=1010101")).toEqual({});
      expect(parseUrlParams("y=2025&v=10101011")).toEqual({
        selectedYear: "2025",
      });
    });

    it("ignores visibility string with wrong length", () => {
      expect(parseUrlParams("v=101")).toEqual({});
      expect(parseUrlParams("v=1010101010")).toEqual({});
      expect(parseUrlParams("v=10101")).toEqual({});
    });

    it("parses map center", () => {
      expect(parseUrlParams("lat=51.5&lng=13.4")).toEqual({
        center: { lat: 51.5, lng: 13.4 },
      });
    });

    it("validates latitude and longitude ranges", () => {
      expect(parseUrlParams("lat=45.5&lng=10.0")!.center).toEqual({
        lat: 45.5,
        lng: 10.0,
      });
      expect(parseUrlParams("lat=91&lng=10")!.center).toBeUndefined();
      expect(parseUrlParams("lat=-91&lng=10")!.center).toBeUndefined();
      // A longitude of another copy of the world is the same place
      expect(parseUrlParams("lat=45&lng=181")!.center).toEqual({
        lat: 45,
        lng: -179,
      });
      expect(parseUrlParams("lat=45&lng=-181")!.center).toEqual({
        lat: 45,
        lng: 179,
      });
      expect(parseUrlParams("lat=abc&lng=10")!.center).toBeUndefined();
    });

    it("requires both lat and lng for center", () => {
      expect(parseUrlParams("lat=45")!.center).toBeUndefined();
      expect(parseUrlParams("lng=10")!.center).toBeUndefined();
    });

    it("parses zoom level", () => {
      expect(parseUrlParams("z=12.5")).toEqual({ zoom: 12.5 });
      expect(parseUrlParams("z=abc")).toEqual({});
    });

    it("clamps zoom to the map's zoom range", () => {
      expect(parseUrlParams("z=0.5")!.zoom).toBe(MIN_ZOOM);
      expect(parseUrlParams("z=19.5")!.zoom).toBe(19.5);
      expect(parseUrlParams("z=20")!.zoom).toBe(MAX_ZOOM);
      expect(parseUrlParams("z=25")!.zoom).toBe(MAX_ZOOM);
      expect(parseUrlParams("z=10")!.zoom).toBe(10);
    });

    it("parses complete state", () => {
      const url =
        "y=2025&a=D-EAGJ&p=1,5,12&sv=3&v=010101000&lat=51.5&lng=13.4&z=10.5";
      expect(parseUrlParams(url)).toEqual({
        selectedYear: "2025",
        selectedAircraft: "D-EAGJ",
        selectedPathIds: [1, 5, 12],
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: true,
        wrappedVisible: false,
        isolateSelection: false,
        center: { lat: 51.5, lng: 13.4 },
        zoom: 10.5,
      });
    });

    it("parses the bearing, the pitch and the globe", () => {
      expect(parseUrlParams("b=-40.5&t=35&g=1")).toEqual({
        bearing: -40.5,
        pitch: 35,
        globeVisible: true,
      });
    });

    it("parses the satellite imagery, and leaves a link without it on the dark map", () => {
      expect(parseUrlParams("s=1")).toEqual({ satelliteVisible: true });
      expect(parseUrlParams("y=2025&s=0")).toEqual({ selectedYear: "2025" });
      // The visibility flags keep their nine slots; the imagery has none
      expect(parseUrlParams("v=100100000&s=1")).toMatchObject({
        heatmapVisible: true,
        isolateSelection: false,
        satelliteVisible: true,
      });
    });

    it("wraps a bearing and holds a pitch to what the map tilts to", () => {
      expect(parseUrlParams("b=270")!.bearing).toBe(-90);
      expect(parseUrlParams("b=-190")!.bearing).toBe(170);
      expect(parseUrlParams("b=180")!.bearing).toBe(180);
      expect(parseUrlParams("t=89")!.pitch).toBe(85);
      expect(parseUrlParams("t=-10")!.pitch).toBe(0);
    });

    it("ignores an orientation that is no number and a globe that is not 1", () => {
      expect(parseUrlParams("y=2025&b=north&t=&g=yes")).toEqual({
        selectedYear: "2025",
      });
      expect(parseUrlParams("b=Infinity&g=0")).toEqual({});
    });

    it("opens a link from before the map could turn north up and flat", () => {
      const state = parseUrlParams("y=2025&lat=51.5&lng=13.4&z=10.5")!;

      for (const key of ["bearing", "pitch", "globeVisible"]) {
        expect(state).not.toHaveProperty(key);
      }
    });

    it("accepts URLSearchParams object", () => {
      expect(parseUrlParams(new URLSearchParams("y=2025&a=D-EAGJ"))).toEqual({
        selectedYear: "2025",
        selectedAircraft: "D-EAGJ",
      });
    });
  });

  describe("encodeStateToUrl", () => {
    it("encodes year parameter (including 'all')", () => {
      expect(encodeStateToUrl({ selectedYear: "2025" })).toBe("y=2025");
      expect(encodeStateToUrl({ selectedYear: "all" })).toBe("y=all");
    });

    it("encodes aircraft parameter and omits 'all'", () => {
      expect(
        encodeStateToUrl({ selectedYear: "all", selectedAircraft: "D-EAGJ" }),
      ).toBe("y=all&a=D-EAGJ");
      expect(
        encodeStateToUrl({ selectedYear: "2025", selectedAircraft: "all" }),
      ).toBe("y=2025");
    });

    it("encodes path IDs in base 36 and omits an empty list", () => {
      expect(
        encodeStateToUrl({ selectedYear: "all", selectedPathIds: [1, 5, 12] }),
      ).toBe("y=all&p=1%2C5%2Cc&sv=4");
      expect(
        encodeStateToUrl({ selectedYear: "all", selectedPathIds: [] }),
      ).toBe("y=all");
    });

    it("keeps a large selection far shorter than decimal would", () => {
      // 40-bit content hashes: 13 digits each in decimal, 8 in base 36
      const ids = Array.from(
        { length: 200 },
        (_, i) => 2 ** 39 + i * 1234567891,
      );

      const encoded = encodeStateToUrl({ selectedPathIds: ids });

      const decimal = ids.join(",").length;
      const written = new URLSearchParams(encoded).get("p")!.length;
      expect(written).toBeLessThan(decimal * 0.7);
      // and it still round-trips
      expect(parseUrlParams(encoded)?.selectedPathIds).toEqual(ids);
    });

    it("encodes visibility flags", () => {
      expect(
        encodeStateToUrl({
          heatmapVisible: true,
          altitudeVisible: false,
          airspeedVisible: true,
          airportsVisible: false,
          aviationVisible: true,
          statsPanelVisible: false,
        }),
      ).toBe("v=101010000");
    });

    it("omits default visibility (100100000)", () => {
      expect(
        encodeStateToUrl({
          heatmapVisible: true,
          altitudeVisible: false,
          airspeedVisible: false,
          airportsVisible: true,
          aviationVisible: false,
          statsPanelVisible: false,
          wrappedVisible: false,
          isolateSelection: false,
        }),
      ).toBe("");
    });

    it("encodes wrappedVisible and isolateSelection, and slot 7 as 0", () => {
      const base = {
        heatmapVisible: true,
        altitudeVisible: false,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: false,
      };
      expect(encodeStateToUrl({ ...base, wrappedVisible: true })).toBe(
        "v=100100100",
      );
      expect(encodeStateToUrl({ ...base, isolateSelection: true })).toBe(
        "v=100100001",
      );
    });

    it("encodes map center with 6 decimal places and zoom with 2", () => {
      const url = encodeStateToUrl({
        center: { lat: 51.507351, lng: -0.127758 },
        zoom: 12.567,
      });
      expect(url).toBe("lat=51.507351&lng=-0.127758&z=12.57");
    });

    it("preserves the debug parameter of the current URL", () => {
      const original = window.location.search;
      window.history.replaceState(null, "", "/?debug=true&y=1999");
      try {
        expect(encodeStateToUrl({ selectedYear: "2025" })).toBe(
          "debug=true&y=2025",
        );
      } finally {
        window.history.replaceState(null, "", "/" + original);
      }
    });

    it("encodes complete state", () => {
      const params = new URLSearchParams(
        encodeStateToUrl({
          selectedYear: "2025",
          selectedAircraft: "D-EAGJ",
          selectedPathIds: [1, 5],
          heatmapVisible: false,
          altitudeVisible: true,
          airspeedVisible: false,
          airportsVisible: true,
          aviationVisible: false,
          statsPanelVisible: true,
          wrappedVisible: false,
          center: { lat: 51.5, lng: 13.4 },
          zoom: 10.5,
        }),
      );

      expect(params.get("y")).toBe("2025");
      expect(params.get("a")).toBe("D-EAGJ");
      expect(params.get("p")).toBe("1,5");
      expect(params.get("v")).toBe("010101000");
      expect(params.get("lat")).toBe("51.500000");
      expect(params.get("lng")).toBe("13.400000");
      expect(params.get("z")).toBe("10.50");
    });

    it("encodes the bearing and the pitch to a tenth of a degree", () => {
      expect(encodeStateToUrl({ bearing: -40.26, pitch: 35.04 })).toBe(
        "b=-40.3&t=35",
      );
    });

    it("keeps north up, flat and Mercator out of the link", () => {
      expect(
        encodeStateToUrl({ bearing: 0, pitch: 0, globeVisible: false }),
      ).toBe("");
      // Closer to north than a link tells apart, from either side
      expect(encodeStateToUrl({ bearing: -0.04, pitch: 0.04 })).toBe("");
      expect(encodeStateToUrl({ globeVisible: true })).toBe("g=1");
      expect(encodeStateToUrl({ threeDVisible: false })).toBe("");
      expect(encodeStateToUrl({ threeDVisible: true })).toBe("d=1");
      expect(encodeStateToUrl({ satelliteVisible: false })).toBe("");
      expect(encodeStateToUrl({ satelliteVisible: true })).toBe("s=1");
    });

    it("returns an empty string for an empty state", () => {
      expect(encodeStateToUrl({})).toBe("");
    });
  });

  describe("the intro of a link to shared flights", () => {
    const original = window.location.pathname + window.location.search;
    afterEach(() => {
      window.history.replaceState(null, "", original);
    });

    it("is taken off the address bar as it is read, the rest of the link kept", () => {
      const link = "?y=2025&p=a5%2C1x&sv=4&v=100100001&lat=50.000000";
      window.history.replaceState(null, "", "/" + link + "&i=1");

      expect(takeShareIntro()).toBe(true);
      expect(window.location.search).toBe(link);
      // A reload of it plays nothing
      expect(takeShareIntro()).toBe(false);
    });

    it("is not there on a link without it, which stays as it is", () => {
      window.history.replaceState(null, "", "/?y=2025&p=a5&sv=4");

      expect(takeShareIntro()).toBe(false);
      expect(window.location.search).toBe("?y=2025&p=a5&sv=4");
    });

    it("is no part of the state, and never written into a link", () => {
      window.history.replaceState(null, "", "/?y=2025&p=a5&sv=4&i=1");

      const state = parseUrlParams(window.location.search)!;
      expect(state).toEqual(parseUrlParams("y=2025&p=a5&sv=4"));
      const link = new URLSearchParams(
        encodeStateToUrl({ ...state, isolateSelection: true }),
      );
      expect(link.has(SHARE_INTRO_PARAM)).toBe(false);
    });
  });

  describe("parseUrlParams and encodeStateToUrl round-trip", () => {
    it("maintains a full state through encode/decode cycle", () => {
      const original: AppState = {
        selectedYear: "2025",
        selectedAircraft: "D-EAGJ",
        selectedPathIds: [1, 5, 12],
        heatmapVisible: false,
        altitudeVisible: true,
        airspeedVisible: false,
        airportsVisible: true,
        aviationVisible: false,
        statsPanelVisible: true,
        wrappedVisible: true,
        isolateSelection: true,
        center: { lat: 51.5, lng: 13.4 },
        zoom: 10.5,
        bearing: -135.5,
        pitch: 42.3,
        globeVisible: true,
        threeDVisible: true,
        satelliteVisible: true,
      };

      const decoded = parseUrlParams(encodeStateToUrl(original));

      expect(decoded).toEqual(original);
    });

    it("round-trips 200 pseudo-random states (seeded property test)", () => {
      const rnd = mulberry32(20250909);

      for (let i = 0; i < 200; i++) {
        const state = randomState(rnd);
        const decoded = parseUrlParams(encodeStateToUrl(state));

        expect(decoded, `case ${i}`).not.toBeNull();
        const expected: AppState = { ...state };
        if (state.selectedAircraft === "all") delete expected.selectedAircraft;
        if (state.selectedPathIds!.length === 0)
          delete expected.selectedPathIds;
        // The defaults are not encoded, so nothing is decoded
        if (state.bearing === 0) delete expected.bearing;
        if (state.pitch === 0) delete expected.pitch;
        if (!state.globeVisible) delete expected.globeVisible;
        if (!state.threeDVisible) delete expected.threeDVisible;
        if (!state.satelliteVisible) delete expected.satelliteVisible;
        if (!state.flightListVisible) delete expected.flightListVisible;
        const flags = [
          state.heatmapVisible,
          state.altitudeVisible,
          state.airspeedVisible,
          state.airportsVisible,
          state.aviationVisible,
          state.statsPanelVisible,
          state.wrappedVisible,
          false,
          state.isolateSelection,
        ];
        const isDefaultVisibility =
          flags.map((f) => (f ? "1" : "0")).join("") === "100100000";
        if (isDefaultVisibility) {
          // default visibility is not encoded, so nothing is decoded
          for (const key of [
            "heatmapVisible",
            "altitudeVisible",
            "airspeedVisible",
            "airportsVisible",
            "aviationVisible",
            "statsPanelVisible",
            "wrappedVisible",
            "isolateSelection",
          ] as const) {
            delete expected[key];
          }
        }
        expect(decoded, `case ${i}`).toEqual(expected);
      }
    });
  });

  describe("links of every toggle", () => {
    /**
     * The link of a state as the app saves it (every toggle set) with one
     * toggle flipped from what a first visit shows. Written out rather than
     * derived, so a change to the table that moves a slot or renames a
     * parameter breaks the links already shared, and this test with them.
     */
    const LINK_OF_TOGGLE: Record<ToggleKey, string> = {
      heatmapVisible: "v=000100000",
      airportsVisible: "v=100000000",
      altitudeVisible: "v=110100000",
      airspeedVisible: "v=101100000",
      aviationVisible: "v=100110000",
      globeVisible: "g=1",
      threeDVisible: "d=1",
      satelliteVisible: "s=1",
      isolateSelection: "v=100100001",
      statsPanelVisible: "v=100101000",
      flightListVisible: "l=1",
      wrappedVisible: "v=100100100",
    };

    it("covers the whole table", () => {
      expect(Object.keys(LINK_OF_TOGGLE).sort()).toEqual(
        TOGGLES.map((toggle) => toggle.key).sort(),
      );
    });

    for (const toggle of TOGGLES) {
      it(`writes and reads ${toggle.key} the way shared links have it`, () => {
        const state: AppState = { ...initialToggles() };
        state[toggle.key] = !toggle.initial;

        const link = encodeStateToUrl(state);

        expect(link).toBe(LINK_OF_TOGGLE[toggle.key]);
        const parsed = parseUrlParams(link)!;
        // What the link leaves out is what a first visit shows
        for (const other of TOGGLES) {
          expect(parsed[other.key] ?? other.initial, other.key).toBe(
            state[other.key],
          );
        }
      });
    }

    it("writes nothing for a first visit's toggles", () => {
      expect(encodeStateToUrl(initialToggles())).toBe("");
    });

    it("keeps reading the links shared so far", () => {
      const links: [string, AppState][] = [
        [
          "y=2025&p=1,2&sv=3&v=011010111&lat=50.5&lng=8.5&z=12.25",
          {
            selectedYear: "2025",
            selectedPathIds: [1, 2],
            heatmapVisible: false,
            altitudeVisible: true,
            airspeedVisible: true,
            airportsVisible: false,
            aviationVisible: true,
            statsPanelVisible: false,
            wrappedVisible: true,
            isolateSelection: true,
            center: { lat: 50.5, lng: 8.5 },
            zoom: 12.25,
          },
        ],
        [
          // Slot 7 set by a release whose controls could hide
          "y=all&a=D-EAGJ&p=a5%2C1x&sv=4&v=100100011&b=-40.3&t=35&g=1&d=1&s=1",
          {
            selectedYear: "all",
            selectedAircraft: "D-EAGJ",
            selectedPathIds: [365, 69],
            heatmapVisible: true,
            altitudeVisible: false,
            airspeedVisible: false,
            airportsVisible: true,
            aviationVisible: false,
            statsPanelVisible: false,
            wrappedVisible: false,
            isolateSelection: true,
            bearing: -40.3,
            pitch: 35,
            globeVisible: true,
            threeDVisible: true,
            satelliteVisible: true,
          },
        ],
        [
          "y=2024&v=100100000",
          {
            selectedYear: "2024",
            heatmapVisible: true,
            altitudeVisible: false,
            airspeedVisible: false,
            airportsVisible: true,
            aviationVisible: false,
            statsPanelVisible: false,
            wrappedVisible: false,
            isolateSelection: false,
          },
        ],
        [
          // The heat counted by distance, which is gone: its flag is left
          // alone, and the link opens as it would without it
          "y=2024&r=1",
          { selectedYear: "2024" },
        ],
      ];
      for (const [link, state] of links) {
        expect(parseUrlParams(link), link).toEqual(state);
      }
      // and writes the same link back, bar the retired slot
      expect(encodeStateToUrl(parseUrlParams(links[1]![0])!)).toBe(
        "y=all&a=D-EAGJ&p=a5%2C1x&sv=4&v=100100001&b=-40.3&t=35&g=1&d=1&s=1",
      );
    });
  });

  it("ignores the band of heights an older link carries", () => {
    expect(parseUrlParams("y=2025&d=1&h=500-3000")).toEqual({
      selectedYear: "2025",
      threeDVisible: true,
    });
  });

  describe("the line of the cross-section", () => {
    it("is two ends, latitude first", () => {
      expect(isSectionLine("51.5,12.1,51.6,12.3")).toBe(true);
      expect(isSectionLine("-90,-180,90,180")).toBe(true);
    });

    it("is none for anything but four numbers of two places", () => {
      for (const text of [
        "",
        "51.5,12.1,51.6",
        "51.5,12.1,51.6,12.3,1",
        "a,b,c,d",
        "91,12,51,12",
        "51,190,51,12",
        "51.5,,51.6,12.3",
        null,
      ]) {
        expect(isSectionLine(text), String(text)).toBe(false);
      }
    });

    it("comes back from a link as it was written", () => {
      const state: AppState = {
        selectedYear: "2025",
        crossSectionLine: "51.50000,12.10000,51.60000,12.30000",
      };
      const link = encodeStateToUrl(state);
      expect(link).toBe("y=2025&x=51.50000%2C12.10000%2C51.60000%2C12.30000");
      expect(parseUrlParams(link)).toEqual(state);
      expect(parseUrlParams("y=2025&x=51.5,12.1,51.6,12.3")).toEqual({
        selectedYear: "2025",
        crossSectionLine: "51.5,12.1,51.6,12.3",
      });
      expect(parseUrlParams("y=2025&x=51.5,12.1")).toEqual({
        selectedYear: "2025",
      });
    });
  });
});
