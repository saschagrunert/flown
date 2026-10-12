/**
 * The profile of one flight and the figures of its stats row
 * (calculations/flightProfile.ts): the lowest height above the ground en
 * route and the time spent low, both leaving out FIELD_RADIUS_KM around
 * every field.
 */
import { describe, it, expect } from "vitest";
import {
  FIELD_RADIUS_KM,
  flightOrder,
  flightProfile,
  joinProfiles,
  LEG_GAP_SHARE,
  locate,
  snapToLegs,
  valueAt,
  type FlightProfile,
} from "../../../../flown/frontend/calculations/flightProfile";
import { heightsAboveGround } from "../../../../flown/frontend/calculations/statistics";
import type { PathSegment } from "../../../../flown/frontend/types";

/** A hundredth of a degree of latitude, in km: 1.11 */
const STEP_KM = 1.112;

/**
 * A flight due north from a field at 50.00 N to one at 50.10 N, one fix a
 * hundredth of a degree (1.11 km) after the other, a minute apart, over
 * ground at 300 ft. Segment i ends at fix i + 1, which its altitude and
 * ground are of.
 */
const ALTITUDES = [800, 1500, 2500, 1100, 1200, 3000, 3000, 1800, 600, 300];

function flight(
  options: {
    altitudes?: number[];
    ground?: number[] | null;
    timed?: boolean;
  } = {},
): PathSegment[] {
  const altitudes = options.altitudes ?? ALTITUDES;
  return altitudes.map((altitude, i) => ({
    path_id: 7,
    coords: [
      [50 + i / 100, 8],
      [50 + (i + 1) / 100, 8],
    ],
    altitude_ft: altitude,
    groundspeed_knots: 90,
    ...(options.timed === false ? {} : { time: i * 60 }),
    ...(options.ground === null
      ? {}
      : { ground_ft: options.ground?.[i] ?? 300 }),
  }));
}

describe("flightProfile", () => {
  it("leaves out the first and last 2 km around each end of the flight", () => {
    // Fix 1 is 1.1 km from the departure field and fixes 9 and 10 within
    // 2 km of the arrival: the 500 ft of the climb-out and the 300 ft of
    // the approach are not en route
    const profile = flightProfile(flight(), [])!;

    expect(profile.timed).toBe(true);
    expect(profile.fromTerrain).toBe(true);
    // The dip to 1,100 ft over ground at 300
    expect(profile.lowestEnRouteFt).toBe(800);
    // Segments 3 and 4 are below 1,000 ft above the ground, a minute each
    expect(profile.lowSeconds).toBe(120);
    expect(profile.maxAltitudeFt).toBe(3000);
    expect(Array.from(profile.altitudeFt)).toEqual(ALTITUDES);
    expect(Array.from(profile.groundFt)).toEqual(ALTITUDES.map(() => 300));
    expect(Array.from(profile.x)).toEqual(ALTITUDES.map((_, i) => i * 60));
  });

  it("leaves out the fields it is given as well", () => {
    // A field under fix 4: fixes 3 to 5 are within 2 km of it, the dip
    // with them
    const profile = flightProfile(flight(), [[50.04, 8]])!;

    expect(profile.lowestEnRouteFt).toBe(1200);
    expect(profile.lowSeconds).toBe(0);
  });

  it("measures a field far off in latitude not at all", () => {
    const profile = flightProfile(flight(), [[51, 8]])!;

    expect(profile.lowestEnRouteFt).toBe(800);
  });

  it("measures the radius along the ground", () => {
    expect(FIELD_RADIUS_KM).toBeLessThan(2 * STEP_KM);
    expect(FIELD_RADIUS_KM).toBeGreaterThan(STEP_KM);
  });

  it("takes the exact highest altitude where the export has it", () => {
    expect(flightProfile(flight(), [], 3040)!.maxAltitudeFt).toBe(3040);
  });

  it("stands a flight without terrain on its field", () => {
    // The field level is the lowest of the flight's altitudes (the first
    // percentile of ten), 300 ft: the same heights as over the terrain
    const profile = flightProfile(flight({ ground: null }), [])!;

    expect(profile.fromTerrain).toBe(false);
    expect(profile.lowestEnRouteFt).toBe(800);
    expect(Array.from(profile.groundFt)).toEqual(ALTITUDES.map(() => 300));
  });

  it("measures a height below the ground as none", () => {
    // The elevation model is off by more than the flight is above it
    const ground = ALTITUDES.map(() => 300);
    ground[3] = 1150;
    const profile = flightProfile(flight({ ground }), [])!;

    expect(profile.lowestEnRouteFt).toBe(0);
  });

  it("runs along the distance for a flight without times", () => {
    const profile = flightProfile(flight({ timed: false }), [])!;

    expect(profile.timed).toBe(false);
    expect(profile.lowSeconds).toBeNull();
    expect(profile.lowestEnRouteFt).toBe(800);
    expect(profile.x[0]).toBe(0);
    expect(profile.x[1]).toBeCloseTo(STEP_KM, 2);
    expect(profile.x[9]).toBeCloseTo(9 * STEP_KM, 1);
  });

  it("takes a flight whose times never move on as one without", () => {
    const segments = flight().map((segment) => ({ ...segment, time: 0 }));

    expect(flightProfile(segments, [])!.timed).toBe(false);
  });

  it("has no en-route figure for a flight that never left the field", () => {
    const profile = flightProfile(flight({ altitudes: [300, 400] }), [])!;

    expect(profile.lowestEnRouteFt).toBeNull();
    expect(profile.lowSeconds).toBe(0);
  });

  it("has no profile for fewer than two segments", () => {
    expect(flightProfile(flight({ altitudes: [300] }), [])).toBeNull();
    expect(flightProfile([], [])).toBeNull();
  });
});

describe("heightsAboveGround", () => {
  it("measures over the terrain where every segment has it", () => {
    const heights = heightsAboveGround(flight());

    expect(heights.heightFt(flight()[2]!, 2500)).toBe(2200);
    expect(heights.fromTerrain).toBe(true);
  });

  it("measures over the field where a segment has no terrain", () => {
    const segments = flight({ ground: null });
    const heights = heightsAboveGround(segments);

    expect(heights.heightFt(segments[2]!, 2500)).toBe(2200);
    expect(heights.fromTerrain).toBe(false);
  });
});

describe("locate and valueAt", () => {
  const xs = [0, 10, 20, 40];
  const x = (i: number): number => xs[i]!;

  it("finds the segment a value falls in, and how far on", () => {
    expect(locate(4, x, 15)).toEqual({ index: 1, fraction: 0.5 });
    expect(locate(4, x, 30)).toEqual({ index: 2, fraction: 0.5 });
    expect(locate(4, x, 10)).toEqual({ index: 1, fraction: 0 });
  });

  it("stops at either end", () => {
    expect(locate(4, x, -5)).toEqual({ index: 0, fraction: 0 });
    expect(locate(4, x, 40)).toEqual({ index: 3, fraction: 0 });
    expect(locate(4, x, 400)).toEqual({ index: 3, fraction: 0 });
    expect(locate(1, x, 5)).toEqual({ index: 0, fraction: 0 });
  });

  it("gives the value between two starts back", () => {
    expect(valueAt(x, 4, { index: 1, fraction: 0.5 })).toBe(15);
    expect(valueAt(x, 4, locate(4, x, 33))).toBe(33);
    // The last segment has no next start to go towards
    expect(valueAt(x, 4, { index: 3, fraction: 0.5 })).toBe(40);
  });
});

describe("flightOrder", () => {
  it("orders the flights by year, then as the files were read", () => {
    const pathInfo = [
      { id: 5, year: 2025 },
      { id: 2, year: 2024 },
      { id: 9, year: 2025 },
      { id: 4, year: 2024 },
      { id: 1, year: 2023 },
    ];

    expect(flightOrder(pathInfo, new Set([9, 4, 5]))).toEqual([4, 5, 9]);
    expect(flightOrder(pathInfo, new Set([9, 5, 1]))).toEqual([1, 5, 9]);
    expect(flightOrder(pathInfo, new Set([3]))).toEqual([]);
  });
});

describe("joinProfiles", () => {
  /** Nine minutes north, then two of a short hop that climbs to 4,000 ft */
  const first = (): FlightProfile => flightProfile(flight(), [])!;
  const second = (): FlightProfile =>
    flightProfile(flight({ altitudes: [500, 4000, 600] }), [])!;
  /** 3 % of the 540 s and 120 s of the two */
  const GAP_S = (540 + 120) * LEG_GAP_SHARE;

  it("puts the flights one after another with a narrow gap between them", () => {
    const joined = joinProfiles([first(), second()]);

    expect(joined.timed).toBe(true);
    expect(joined.legs).toEqual([
      { first: 0, last: 9, timed: true },
      { first: 10, last: 12, timed: true },
    ]);
    expect(joined.segments).toHaveLength(13);
    expect([...joined.x.slice(0, 10)]).toEqual([
      0, 60, 120, 180, 240, 300, 360, 420, 480, 540,
    ]);
    // Each flight from 0, after the gap: never the time on the ground
    expect(joined.x[10]).toBeCloseTo(540 + GAP_S, 9);
    expect(joined.x[12]).toBeCloseTo(540 + GAP_S + 120, 9);
    expect(joined.altitudeFt[11]).toBe(4000);
    expect(joined.groundFt[11]).toBe(300);
  });

  it("gives the figures of all the flights", () => {
    const a = first();
    const joined = joinProfiles([a, second()]);

    expect(joined.maxAltitudeFt).toBe(4000);
    // The hop never gets 2 km from both its ends: the first's lowest
    expect(joined.lowestEnRouteFt).toBe(a.lowestEnRouteFt);
    expect(joined.lowSeconds).toBe(a.lowSeconds);
    expect(joined.fromTerrain).toBe(true);
  });

  it("runs along the distance once a flight has no times", () => {
    const joined = joinProfiles([
      first(),
      flightProfile(flight({ timed: false }), [])!,
    ]);

    expect(joined.timed).toBe(false);
    expect(joined.lowSeconds).toBeNull();
    // The timed one by its km as well
    expect(joined.x[1]).toBeCloseTo(STEP_KM, 2);
    const gap = 18 * STEP_KM * LEG_GAP_SHARE;
    expect(joined.x[10]).toBeCloseTo(9 * STEP_KM + gap, 1);
  });

  it("finds the nearer flight in a gap", () => {
    const joined = joinProfiles([first(), second()]);
    const { x, legs } = joined;

    expect(snapToLegs(x, legs, 300)).toBe(300);
    expect(snapToLegs(x, legs, 545)).toBe(540);
    expect(snapToLegs(x, legs, 540 + GAP_S - 1)).toBe(x[10]);
    expect(snapToLegs(x, legs, -10)).toBe(0);
    expect(snapToLegs(x, legs, 5000)).toBe(x[12]);
  });
});
