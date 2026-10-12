/**
 * Property tests of the links (state/urlState.ts): whatever state the app
 * can hold comes back from its link, and the parser of the cross-section's
 * line takes exactly what the app writes. fast-check prints the seed and
 * the smallest failing state when a property fails; pass it back with
 * `{ seed, path }` in the options of fc.assert to replay that run.
 */
import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  encodeStateToUrl,
  isSectionLine,
  parseUrlParams,
} from "../../../../flown/frontend/state/urlState";
import {
  initialToggles,
  TOGGLES,
  type ToggleKey,
} from "../../../../flown/frontend/state/toggles";
import {
  MAP_MAX_PITCH,
  MAX_ZOOM,
  MIN_ZOOM,
} from "../../../../flown/frontend/utils/constants";
import type { AppState } from "../../../../flown/frontend/types";

/** Path ids are 40-bit content hashes, which fc.integer cannot reach */
const pathId = fc
  .tuple(fc.nat({ max: 2 ** 20 - 1 }), fc.nat({ max: 2 ** 20 - 1 }))
  .map(([high, low]) => high * 2 ** 20 + low);

/** A whole number of `step` from `min` to `max`, as the link rounds it */
function stepped(min: number, max: number, step: number) {
  return fc
    .integer({ min: Math.round(min / step), max: Math.round(max / step) })
    .map((n) => n * step);
}

/** Degrees with six decimals, as the link writes the centre */
const micro = (limit: number) =>
  fc.integer({ min: -limit * 1e6, max: limit * 1e6 }).map((n) => n / 1e6);

/** Two ends of the cross-section, latitude first, as ui/crossSection.ts writes them */
const sectionLine = fc
  .tuple(
    fc.double({ min: -90, max: 90, noNaN: true }),
    fc.double({ min: -180, max: 180, noNaN: true }),
    fc.double({ min: -90, max: 90, noNaN: true }),
    fc.double({ min: -180, max: 180, noNaN: true }),
  )
  .map((ends) => ends.map((value) => value.toFixed(5)).join(","));

/** Every toggle, on or off, as the app saves them */
const toggles = fc.record(
  Object.fromEntries(TOGGLES.map((toggle) => [toggle.key, fc.boolean()])) as {
    [K in ToggleKey]: fc.Arbitrary<boolean>;
  },
);

/** The rest of a state, each field there or not */
const view = fc.record(
  {
    selectedYear: fc.oneof(
      fc.constant("all"),
      fc.integer({ min: 1990, max: 2100 }).map(String),
    ),
    // Any text a registration could be written in, "all" among them
    selectedAircraft: fc.oneof(
      fc.constant("all"),
      fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }),
    ),
    selectedPathIds: fc.array(pathId, { maxLength: 8 }),
    center: fc.record({ lat: micro(90), lng: micro(180) }),
    zoom: stepped(MIN_ZOOM, MAX_ZOOM, 0.01).map(
      (z) => Math.round(z * 100) / 100,
    ),
    // Most views are north up and flat, which the link leaves out; a
    // uniform draw would hardly ever hit them
    bearing: fc.oneof(
      fc.constant(0),
      stepped(-180, 180, 0.1).map((b) => Math.round(b * 10) / 10),
    ),
    pitch: fc.oneof(
      fc.constant(0),
      stepped(0, MAP_MAX_PITCH, 0.1).map((p) => Math.round(p * 10) / 10),
    ),
    crossSectionLine: sectionLine,
  },
  { requiredKeys: [] },
);

const SLOT_TOGGLES = TOGGLES.filter((toggle) => "slot" in toggle.url);
const PARAM_TOGGLES = TOGGLES.filter((toggle) => "param" in toggle.url);
const INITIAL = initialToggles();

/**
 * What a link of `state` reads back as: the state without what a link
 * leaves out because it is the default (see encodeStateToUrl)
 */
function expectedFromLink(state: AppState): AppState {
  const expected: AppState = { ...state };
  if (expected.selectedAircraft === "all") delete expected.selectedAircraft;
  if (expected.selectedPathIds?.length === 0) delete expected.selectedPathIds;
  if (expected.bearing === 0) delete expected.bearing;
  if (expected.pitch === 0) delete expected.pitch;
  for (const toggle of PARAM_TOGGLES) {
    if (!expected[toggle.key]) delete expected[toggle.key];
  }
  const asOnFirstVisit = SLOT_TOGGLES.every(
    (toggle) => !!state[toggle.key] === INITIAL[toggle.key],
  );
  if (asOnFirstVisit) {
    for (const toggle of SLOT_TOGGLES) delete expected[toggle.key];
  }
  return expected;
}

describe("links, for any state (fast-check)", () => {
  it("parseUrlParams(encodeStateToUrl(state)) restores every field", () => {
    fc.assert(
      fc.property(toggles, view, (flags, rest) => {
        const state: AppState = { ...flags, ...rest };
        const link = encodeStateToUrl(state);
        // A state that is all defaults has an empty link, which reads as none
        expect(parseUrlParams(link) ?? {}).toEqual(expectedFromLink(state));
      }),
    );
  });

  it("writes every path id in base 36 and reads it back, within 40 bits", () => {
    fc.assert(
      fc.property(fc.array(pathId, { minLength: 1, maxLength: 20 }), (ids) => {
        const link = encodeStateToUrl({ selectedPathIds: ids });
        expect(parseUrlParams(link)).toEqual({ selectedPathIds: ids });
      }),
    );
  });
});

describe("the parser of the line (fast-check)", () => {
  it("takes every line within the map's range, and reads it back from a link", () => {
    fc.assert(
      fc.property(sectionLine, (line) => {
        expect(isSectionLine(line)).toBe(true);
        expect(parseUrlParams(new URLSearchParams({ x: line }))).toEqual({
          crossSectionLine: line,
        });
      }),
    );
  });

  it("refuses a line with an end past the poles or the antimeridian", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -90, max: 90, noNaN: true }), {
          minLength: 4,
          maxLength: 4,
        }),
        fc.nat({ max: 3 }),
        fc.double({ min: 1e-3, max: 1e3, noNaN: true }),
        (values, at, beyond) => {
          const limit = at % 2 ? 180 : 90;
          const ends = values.map((value) => value.toFixed(5));
          ends[at] = (limit + beyond).toFixed(5);
          expect(isSectionLine(ends.join(","))).toBe(false);
        },
      ),
    );
  });
});
