import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  FLAGS,
  packShareToken,
  resolveShareToken,
  SHARE_TOKEN_PARAM,
  unpackShareToken,
} from "../../../../flown/frontend/state/shareToken";
import {
  encodeStateToUrl,
  parseUrlParams,
  STATE_SCHEMA_VERSION,
} from "../../../../flown/frontend/state/urlState";
import { TOGGLES } from "../../../../flown/frontend/state/toggles";
import type { AppState } from "../../../../flown/frontend/types";

/** Path ids are 40-bit content hashes, which fc.integer cannot reach */
const pathId = fc
  .tuple(fc.nat({ max: 2 ** 20 - 1 }), fc.nat({ max: 2 ** 20 - 1 }))
  .map(([high, low]) => high * 2 ** 20 + low);

/** The state a link reads as, the selection sorted as a token keeps it */
function stateOf(query: string | URLSearchParams): AppState | null {
  const state = parseUrlParams(query);
  if (state?.selectedPathIds) {
    state.selectedPathIds = [...new Set(state.selectedPathIds)].sort(
      (a, b) => a - b,
    );
  }
  return state;
}

/** The state of the link a query's token resolves to */
function viaToken(query: string): AppState | null {
  const token = packShareToken(query);
  expect(token, query).not.toBeNull();
  return stateOf(unpackShareToken(token!)!);
}

const VIEW: AppState = {
  selectedYear: "2025",
  selectedAircraft: "D-EAGJ",
  heatmapVisible: true,
  altitudeVisible: true,
  airportsVisible: false,
  center: { lat: 51.123456, lng: 13.654321 },
  zoom: 10.5,
  bearing: -40.26,
  pitch: 35.04,
  globeVisible: true,
  threeDVisible: true,
  crossSectionLine: "51.50000,12.10000,51.60000,12.30000",
};

describe("the token of a shared link", () => {
  it("resolves to the link it was packed from", () => {
    const ids = [365, 69, 840108108563];
    const query = encodeStateToUrl({ ...VIEW, selectedPathIds: ids }) + "&i=1";

    expect(viaToken(query)).toEqual(stateOf(query));
    expect(unpackShareToken(packShareToken(query)!)!.get("i")).toBe("1");
  });

  it("holds every value of the link at the precision the link writes it", () => {
    const query =
      "y=all&a=D-EAGJ&p=a5%2C1x&sv=4&v=100100001&lat=-33.856784" +
      "&lng=151.215297&z=12.25&b=-179.9&t=84.9&g=1&d=1&s=1&l=1" +
      "&x=-33.85678%2C151.21530%2C-33.86000%2C151.20000&i=1";

    const resolved = unpackShareToken(packShareToken(query)!)!;

    expect(Object.fromEntries(resolved)).toEqual({
      ...Object.fromEntries(new URLSearchParams(query)),
      // The selection, sorted
      p: "1x,a5",
    });
  });

  it("is far shorter than the link", () => {
    // 100 flights spread over the whole range of the ids
    const ids = Array.from({ length: 100 }, (_, i) => i * 10995116277 + 7);
    const query = encodeStateToUrl({ ...VIEW, selectedPathIds: ids });

    expect(packShareToken(query)!.length).toBeLessThan(query.length * 0.55);
    // A view alone takes a few dozen characters
    expect(
      packShareToken("y=2025&lat=50.000000&lng=8.000000&z=9.00")!.length,
    ).toBeLessThan(20);
  });

  it("leaves debug out", () => {
    const token = packShareToken("debug=true&y=2025")!;

    expect(unpackShareToken(token)!.toString()).toBe("y=2025");
  });

  it("holds a parameter given twice as the page reads it, the first", () => {
    const token = packShareToken("y=2024&y=2025&z=3.00&z=4.00")!;

    expect(unpackShareToken(token)!.toString()).toBe("y=2024&z=3.00");
  });

  it("writes a centre past the antimeridian in the world the page reads it in", () => {
    const token = packShareToken("lat=10.000000&lng=190.000000&z=3.00")!;

    expect(unpackShareToken(token)!.get("lng")).toBe("-170.000000");
  });

  it("holds any aircraft, a registration in fewer characters", () => {
    const registration = packShareToken("a=D-EAGJ")!;
    const other = packShareToken("a=Pa%C3%9Fagier")!;

    expect(unpackShareToken(registration)!.get("a")).toBe("D-EAGJ");
    expect(unpackShareToken(other)!.get("a")).toBe("Paßagier");
    const lowerCase = packShareToken("a=d-eagj")!;
    expect(registration.length).toBeLessThan(lowerCase.length);
  });

  it("is not packed when the link holds what it has no room for", () => {
    for (const query of [
      "foo=1",
      "y=20x5",
      "g=2",
      "v=1001",
      "z=30.00",
      "b=-200",
      "x=1,2,3",
      "p=a5&sv=1",
      `a=${"A".repeat(300)}`,
    ]) {
      expect(packShareToken(query), query).toBeNull();
    }
  });

  it("does not resolve from text that is not a token", () => {
    // The last, flights only, holds the id 2^40, one past what an id holds
    for (const token of ["!", "A", "BAAA", "z", "AgIT9I5+g", "AAIKEAAAAAAA"]) {
      expect(unpackShareToken(token), token).toBeNull();
    }
  });

  it("holds the ids of the selection's current schema", () => {
    // The token does not write the schema of its ids: a STATE_SCHEMA_VERSION
    // that gives the same ids another meaning takes a new FORMAT_VERSION in
    // state/shareToken.ts, or the tokens shared so far would resolve to the
    // wrong flights. One that only writes the ids differently does not.
    expect(STATE_SCHEMA_VERSION).toBe(4);
  });

  it("has a flag for every switch a link writes as a parameter", () => {
    for (const toggle of TOGGLES) {
      if ("param" in toggle.url) {
        expect(FLAGS).toContain(toggle.url.param);
      }
    }
  });

  describe("on opening", () => {
    const original = window.location.pathname + window.location.search;
    afterEach(() => {
      window.history.replaceState(null, "", original);
    });

    it("turns the token in the address bar into the link", () => {
      const token = packShareToken("y=2025&p=a5&sv=4&i=1")!;
      window.history.replaceState(
        null,
        "",
        `/?debug=true&${SHARE_TOKEN_PARAM}=${token}`,
      );

      resolveShareToken();

      expect(window.location.search).toBe("?y=2025&p=a5&sv=4&i=1&debug=true");
    });

    it("drops a token that does not resolve", () => {
      window.history.replaceState(null, "", `/?${SHARE_TOKEN_PARAM}=!!`);

      resolveShareToken();

      expect(window.location.search).toBe("");
    });

    it("leaves a link without a token as it is", () => {
      window.history.replaceState(null, "", "/?y=2025&p=a5&sv=4");

      resolveShareToken();

      expect(window.location.search).toBe("?y=2025&p=a5&sv=4");
    });
  });
});

describe("the token of a shared link (fast-check)", () => {
  const state = fc.record(
    {
      selectedYear: fc.oneof(
        fc.constant("all"),
        fc.integer({ min: 1990, max: 2100 }).map(String),
      ),
      selectedAircraft: fc.oneof(
        fc.constantFrom("all", "D-EAGJ", "N172SP", "OE-KXY"),
        fc.string({ maxLength: 40 }),
      ),
      selectedPathIds: fc.array(pathId, { maxLength: 60 }),
      heatmapVisible: fc.boolean(),
      airportsVisible: fc.boolean(),
      statsPanelVisible: fc.boolean(),
      isolateSelection: fc.boolean(),
      center: fc.record({
        lat: fc.double({ min: -90, max: 90, noNaN: true }),
        lng: fc.double({ min: -540, max: 540, noNaN: true }),
      }),
      zoom: fc.double({ min: 1, max: 20, noNaN: true }),
      bearing: fc.double({ min: -180, max: 180, noNaN: true }),
      pitch: fc.double({ min: 0, max: 85, noNaN: true }),
      globeVisible: fc.boolean(),
      threeDVisible: fc.boolean(),
      satelliteVisible: fc.boolean(),
      flightListVisible: fc.boolean(),
    },
    { requiredKeys: [] },
  );

  it("resolves to a link that reads as the state it was packed from", () => {
    fc.assert(
      fc.property(state, fc.boolean(), (state, intro) => {
        const query = encodeStateToUrl(state) + (intro ? "&i=1" : "");
        const token = packShareToken(query);
        expect(token).not.toBeNull();
        const resolved = unpackShareToken(token!)!;
        const expected = stateOf(query);
        const actual = stateOf(resolved);
        // A centre past the antimeridian comes back wrapped, as the page
        // wraps it anyway
        if (expected?.center && actual?.center) {
          expect(actual.center.lat).toBeCloseTo(expected.center.lat, 6);
          expect(actual.center.lng).toBeCloseTo(expected.center.lng, 5);
          delete expected.center;
          delete actual.center;
        }
        expect(actual).toEqual(expected);
        expect(resolved.get("i")).toBe(intro ? "1" : null);
      }),
    );
  });

  it("never throws on any text, nor resolves to a path id past 40 bits", () => {
    // Any text, and text of the token's own characters after the "A" of
    // this format's version, which resolves now and then, flights and all.
    // The ids are read off `p` itself: parseUrlParams would drop a bad one.
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), fc.stringMatching(/^A[\w-]*$/)),
        (text) => {
          const params = unpackShareToken(text);
          for (const id of params?.get("p")?.split(",") ?? []) {
            expect(
              /^[0-9a-z]+$/.test(id) && parseInt(id, 36) < 2 ** 40,
              id,
            ).toBe(true);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });
});
