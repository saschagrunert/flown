/**
 * The hotspots of the heat: where the time goes, how neighbouring cells
 * merge into one place and places stay apart, what the filters keep, and
 * how a place is named and its time put.
 */
import { describe, it, expect } from "vitest";
import {
  compassPoint,
  findHotspots,
  hotspotDetail,
  hotspotName,
  HOTSPOT_APART_M,
  MAX_HOTSPOTS,
  type Hotspot,
} from "../../../../flown/frontend/calculations/hotspots";
import type { Airport, PathSegment } from "../../../../flown/frontend/types";
import {
  heatWeight,
  type SegmentWeight,
} from "../../../../flown/frontend/calculations/heatLines";
import { planarMetres } from "../../../../flown/frontend/utils/geometry";
import { segmentOf } from "../../testHelpers";

/** Degrees of latitude in a kilometre */
const KM = 1 / 111.32;

/** Home, a field in the middle of Germany */
const HOME: [number, number] = [51.55, 12.05];

/**
 * A flight of `path_id` that spends `minutes` circling tightly round
 * `[lat, lng]`, a fix a minute, `radiusKm` out from it. Its last segment
 * has no time to its end, and counts as flown at CRUISE_SPEED_MS: a few
 * seconds.
 */
function stay(
  path_id: number,
  [lat, lng]: [number, number],
  minutes: number,
  radiusKm = 0.2,
): PathSegment[] {
  const at = (i: number): [number, number] => {
    const angle = (i / 8) * 2 * Math.PI;
    return [
      lat + radiusKm * KM * Math.sin(angle),
      lng + (radiusKm * KM * Math.cos(angle)) / Math.cos((lat * Math.PI) / 180),
    ];
  };
  return Array.from({ length: minutes }, (_, i) =>
    segmentOf({ path_id, coords: [at(i), at(i + 1)], time: i * 60 }),
  );
}

/** A point `km` east of `[lat, lng]` */
function east([lat, lng]: [number, number], km: number): [number, number] {
  return [lat, lng + (km * KM) / Math.cos((lat * Math.PI) / 180)];
}

/** A point `km` north of `[lat, lng]` */
function north([lat, lng]: [number, number], km: number): [number, number] {
  return [lat + km * KM, lng];
}

const all = (): boolean => true;

describe("findHotspots", () => {
  it("finds none where there is no heat", () => {
    expect(findHotspots([], all)).toEqual([]);
    // A track without times that never moved has no heat anywhere
    const still = segmentOf({ path_id: 1, coords: [HOME, HOME] });
    expect(findHotspots([still, still], all)).toEqual([]);
  });

  it("puts a place where its time was spent, with all of it", () => {
    const [hotspot, ...rest] = findHotspots(stay(1, HOME, 31), all);

    expect(rest).toEqual([]);
    expect(planarMetres(hotspot!.center, HOME)).toBeLessThan(100);
    // A minute a segment, and seconds for the last one of the flight
    expect(hotspot!.seconds).toBeGreaterThan(30 * 60);
    expect(hotspot!.seconds).toBeLessThan(30 * 60 + 10);
    expect(hotspot!.share).toBeCloseTo(1);
    expect(hotspot!.radiusM).toBeLessThan(1000);
  });

  it("counts a flight without times by its length at its groundspeed", () => {
    // A kilometre at 60 knots is about a minute
    const segment = segmentOf({
      path_id: 1,
      coords: [HOME, east(HOME, 1)],
      groundspeed_knots: 60,
    });

    const [hotspot] = findHotspots([segment], all);

    expect(hotspot!.seconds).toBeCloseTo(1000 / (60 * (1852 / 3600)), 0);
  });

  it("merges a field, its circuit and its holding point into one place", () => {
    const segments = [
      ...stay(1, HOME, 30),
      // The circuit, two kilometres out, and a holding point north
      ...stay(2, east(HOME, 2), 20, 1),
      ...stay(3, north(HOME, 1.5), 10),
    ];

    const hotspots = findHotspots(segments, all);

    expect(hotspots).toHaveLength(1);
    expect(hotspots[0]!.share).toBeCloseTo(1);
    expect(hotspots[0]!.radiusM).toBeGreaterThan(500);
  });

  it("puts a place across the antimeridian on it, not half the world away", () => {
    // A field on the line, its traffic a kilometre either side of it
    const segments = [
      ...stay(1, [-16.5, 179.99], 30),
      ...stay(2, [-16.5, -179.99], 30),
    ];

    const hotspots = findHotspots(segments, all);

    expect(hotspots).toHaveLength(1);
    expect(planarMetres(hotspots[0]!.center, [-16.5, 180])).toBeLessThan(1000);
    expect(Math.abs(hotspots[0]!.center[1])).toBeLessThanOrEqual(180);
  });

  it("keeps places apart, busiest first, and leaves out one too close to a busier one", () => {
    const away = east(HOME, 30);
    const close = north(HOME, 5);
    const segments = [
      ...stay(1, away, 20),
      ...stay(2, HOME, 60),
      // Past the reach of home's cells, but not HOTSPOT_APART_M from it
      ...stay(3, close, 15),
    ];

    const hotspots = findHotspots(segments, all);

    expect(hotspots).toHaveLength(2);
    expect(planarMetres(hotspots[0]!.center, HOME)).toBeLessThan(100);
    expect(planarMetres(hotspots[1]!.center, away)).toBeLessThan(100);
    expect(hotspots[0]!.seconds).toBeGreaterThan(hotspots[1]!.seconds);
    expect(
      planarMetres(hotspots[0]!.center, hotspots[1]!.center),
    ).toBeGreaterThan(HOTSPOT_APART_M);
    // Their shares are of all the time, the place left out's included
    expect(hotspots[0]!.share + hotspots[1]!.share).toBeLessThan(1);
  });

  it("leaves out a place whose middle its own cells draw too close to a busier one", () => {
    const segments = [
      ...stay(1, HOME, 60),
      // A seed far enough from home, and time on the way that is neither
      // home's nor far enough from it, which pulls the place's middle to
      // about 7.6 km from home
      ...stay(2, north(HOME, 8.5), 20),
      ...stay(3, north(HOME, 5.8), 10),
    ];

    const hotspots = findHotspots(segments, all);

    expect(hotspots).toHaveLength(1);
    expect(planarMetres(hotspots[0]!.center, HOME)).toBeLessThan(100);
  });

  it("seeds a place by the time around a cell, not in it", () => {
    // A field whose time spreads over its circuit outweighs one visited
    // with more time in a single cell but less around it
    const spread = east(HOME, 40);
    const segments = [
      ...stay(1, HOME, 25),
      ...stay(2, spread, 15),
      ...stay(3, east(spread, 1.2), 15),
      ...stay(4, north(spread, 1.2), 15),
    ];

    const hotspots = findHotspots(segments, all);

    expect(planarMetres(hotspots[0]!.center, spread)).toBeLessThan(1500);
    expect(hotspots[0]!.seconds).toBeGreaterThan(hotspots[1]!.seconds);
  });

  it("keeps at most MAX_HOTSPOTS places, and none with a sliver of the time", () => {
    const segments = [
      ...Array.from({ length: MAX_HOTSPOTS + 2 }, (_, i) =>
        stay(i + 1, east(HOME, i * 20), 30 - i),
      ).flat(),
      // A two minute stop among hours of flying elsewhere
      ...stay(99, north(HOME, 200), 3),
    ];

    const hotspots = findHotspots(segments, all);

    expect(hotspots).toHaveLength(MAX_HOTSPOTS);
    const minutes = hotspots.map((hotspot) => Math.round(hotspot.seconds / 60));
    expect(minutes).toEqual([29, 28, 27, 26, 25]);

    const sliver = findHotspots(
      [...stay(1, HOME, 1000), ...stay(2, east(HOME, 50), 2)],
      all,
    );
    expect(sliver).toHaveLength(1);
  });

  it("weighs the heat as it is asked to", () => {
    // An hour standing at home, creeping round at a walking pace, and
    // half an hour's cruise away over 90 km
    const ground = stay(1, HOME, 61, 0.02).map((segment) => ({
      ...segment,
      groundspeed_knots: 5,
    }));
    const away = east(HOME, 50);
    const cruise = Array.from({ length: 31 }, (_, i) =>
      segmentOf({
        path_id: 2,
        coords: [east(away, i * 3), east(away, (i + 1) * 3)],
        groundspeed_knots: 100,
        time: i * 60,
      }),
    );
    const segments = [...ground, ...cruise];
    const nearHome = (hotspot: Hotspot): boolean =>
      planarMetres(hotspot.center, HOME) < 1000;

    // By time the stand at home is the busiest place
    expect(nearHome(findHotspots(segments, all)[0]!)).toBe(true);
    // A weighing that leaves the ground out finds the cruise instead
    const airborne: SegmentWeight = (segment, next) =>
      segment.groundspeed_knots < 30 ? 0 : heatWeight(segment, next);
    const routes = findHotspots(segments, all, airborne);
    expect(nearHome(routes[0]!)).toBe(false);
    expect(routes.some(nearHome)).toBe(false);
  });

  it("counts only the flights it is asked to, as the filters keep them", () => {
    const away = east(HOME, 30);
    const segments = [...stay(1, HOME, 60), ...stay(2, away, 20)];

    const hotspots = findHotspots(segments, (pathId) => pathId === 2);

    expect(hotspots).toHaveLength(1);
    expect(planarMetres(hotspots[0]!.center, away)).toBeLessThan(100);
    expect(hotspots[0]!.share).toBeCloseTo(1);
  });
});

describe("naming a place", () => {
  const airports: Airport[] = [
    { name: "EDAQ Halle-Oppin", code: "EDAQ", lat: HOME[0], lon: HOME[1] },
    {
      name: "EDAU Riesa-Göhlis",
      code: "EDAU",
      lat: 51.29,
      lon: 13.36,
    },
  ];

  it("names the airport a place is at, and the home field as such", () => {
    expect(hotspotName(east(HOME, 1), airports, "EDAQ Halle-Oppin")).toBe(
      "Home field EDAQ Halle-Oppin",
    );
    expect(hotspotName([51.29, 13.36], airports, "EDAQ Halle-Oppin")).toBe(
      "EDAU Riesa-Göhlis",
    );
    expect(hotspotName(east(HOME, 1), airports, null)).toBe("EDAQ Halle-Oppin");
  });

  it("puts a place away from any airport by its distance and direction from the nearest", () => {
    expect(hotspotName(north(HOME, -12), airports, null)).toBe(
      "12 km south of EDAQ Halle-Oppin",
    );
    expect(hotspotName(east(north(HOME, 7), 7), airports, null)).toBe(
      "10 km north-east of EDAQ Halle-Oppin",
    );
  });

  it("gives the position of a place no airport of the site is near", () => {
    expect(hotspotName([47.26, 11.39], airports, null)).toBe(
      "47.26° N, 11.39° E",
    );
    expect(hotspotName([-33.95, -18.6], [], null)).toBe("33.95° S, 18.60° W");
  });

  it("takes the point of the compass nearest a bearing", () => {
    expect(compassPoint(0)).toBe("north");
    expect(compassPoint(350)).toBe("north");
    expect(compassPoint(44)).toBe("north-east");
    expect(compassPoint(180)).toBe("south");
    expect(compassPoint(-90)).toBe("west");
    expect(compassPoint(300)).toBe("north-west");
  });
});

describe("the time of a place", () => {
  it("puts it as the page puts a length of time, never a time of day", () => {
    const detail = (seconds: number): string =>
      hotspotDetail({ center: HOME, seconds, share: 0.5, radiusM: 0 });
    expect(detail(41.4 * 3600)).toBe("41 h, 50% of the time");
    // Hours and minutes under ten hours, as the profile and the
    // cross-section say them (utils/duration.ts)
    expect(detail(2.46 * 3600)).toBe("2 h 28 min, 50% of the time");
    expect(detail(35 * 60)).toBe("35 min, 50% of the time");
    expect(detail(20)).toBe("20 s, 50% of the time");
  });

  it("says its share of the time, a sliver as under a percent", () => {
    const hotspot = (seconds: number, share: number): Hotspot => ({
      center: HOME,
      seconds,
      share,
      radiusM: 0,
    });

    expect(hotspotDetail(hotspot(32 * 3600, 0.224))).toBe(
      "32 h, 22% of the time",
    );
    expect(hotspotDetail(hotspot(40 * 60, 0.004))).toBe(
      "40 min, under 1% of the time",
    );
  });
});
