/**
 * The readout of the heat cloud: the grid that finds the segments near a
 * place, and the time, flights and heights within the radius of the line
 * of sight through the pointer.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  formatTimeSpent,
  insideFraction,
  makeSegmentGrid,
  readoutAt,
  readoutData,
  readoutRadiusM,
  readoutText,
  releaseReadoutData,
  segmentGrid,
  sightLine,
  type CloudReadout,
  type ReadoutData,
  type SightLine,
} from "../../../../flown/frontend/calculations/cloudReadout";
import {
  DEGREES_TO_RADIANS,
  EARTH_CIRCUMFERENCE_M,
  planarMetres,
  type Coordinate,
} from "../../../../flown/frontend/utils/geometry";
import type { PathSegment } from "../../../../flown/frontend/types";
import {
  CRUISE_SPEED_MS,
  heatWeight,
  type SegmentWeight,
} from "../../../../flown/frontend/calculations/heatLines";

/** Metres of a degree of latitude, as the module counts them */
const DEGREE_M = EARTH_CIRCUMFERENCE_M / 360;
const LAT = 50;
const LNG = 8;
/** Metres of a degree of longitude at LAT */
const LNG_M = DEGREE_M * Math.cos(LAT * DEGREES_TO_RADIANS);

/**
 * A flight of `path_id` along the latitude `lat` from `fromLng` to
 * `toLng` in `count` segments, `step` seconds each, at `altitude` feet
 */
function flight(
  path_id: number,
  {
    lat = LAT,
    fromLng = LNG - 0.05,
    toLng = LNG + 0.05,
    count = 10,
    step = 10,
    altitude = 1000,
  } = {},
): PathSegment[] {
  const width = (toLng - fromLng) / count;
  return Array.from({ length: count }, (_, i) => ({
    path_id,
    coords: [
      [lat, fromLng + i * width],
      [lat, fromLng + (i + 1) * width],
    ],
    altitude_ft: altitude,
    groundspeed_knots: 100,
    time: i * step,
  }));
}

/** The readout data of `segments` at the heights `heightFt` gives them */
function data(
  segments: PathSegment[],
  heightFt: (segment: PathSegment) => number = (s) => s.altitude_ft,
): ReadoutData {
  const prepared = readoutData(segments, false, 10);
  const heightsFt = Float32Array.from(segments, heightFt);
  return { ...prepared, heightsFt, topFt: Math.max(...heightsFt) };
}

/** Looking straight down at a place */
function down(place: Coordinate): SightLine {
  return { places: [place], stepFt: 0 };
}

const everyone = (): boolean => true;

/** A number generator that gives the same numbers on every run */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 2 ** 32;
    return state / 2 ** 32;
  };
}

/** Metres from `place` to the segment `segment`, on the plane */
function distanceM(segment: PathSegment, [lat, lng]: Coordinate): number {
  const across = DEGREE_M * Math.cos(lat * DEGREES_TO_RADIANS);
  const [[lat0, lng0], [lat1, lng1]] = segment.coords;
  const ax = (lng0 - lng) * across;
  const ay = (lat0 - lat) * DEGREE_M;
  const dx = (lng1 - lng0) * across;
  const dy = (lat1 - lat0) * DEGREE_M;
  const length = dx * dx + dy * dy;
  const t =
    length > 0 ? Math.min(Math.max(-(ax * dx + ay * dy) / length, 0), 1) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}

afterEach(() => releaseReadoutData());

describe("readoutRadiusM", () => {
  it("picks the round radius nearest to the pixels asked for", () => {
    expect(readoutRadiusM(50, 20)).toBe(1000);
    expect(readoutRadiusM(10, 20)).toBe(250);
    expect(readoutRadiusM(30, 20)).toBe(500);
    // The glow of a field's circuit, narrow close in
    expect(readoutRadiusM(30, 7.5)).toBe(250);
  });

  it("stays within the radii it knows", () => {
    expect(readoutRadiusM(0.01, 20)).toBe(100);
    expect(readoutRadiusM(1e5, 20)).toBe(50000);
  });
});

describe("insideFraction", () => {
  const R = 100;

  it("is the part of a segment through the middle that is within", () => {
    expect(insideFraction(-2 * R, 0, 2 * R, 0, R)).toBeCloseTo(0.5);
    expect(insideFraction(0, 0, 2 * R, 0, R)).toBeCloseTo(0.5);
    expect(insideFraction(-R / 2, 0, R / 2, 0, R)).toBe(1);
  });

  it("is the chord of a segment that passes beside the middle", () => {
    // At 60 % of the radius off the middle, the chord is 1.6 radii long
    expect(insideFraction(-2 * R, 0.6 * R, 2 * R, 0.6 * R, R)).toBeCloseTo(
      1.6 / 4,
    );
  });

  it("is none for a segment that passes by, or stops short", () => {
    expect(insideFraction(-2 * R, 1.01 * R, 2 * R, 1.01 * R, R)).toBe(0);
    expect(insideFraction(2 * R, 0, 3 * R, 0, R)).toBe(0);
  });

  it("is all or nothing for a segment of no length", () => {
    expect(insideFraction(R / 2, 0, R / 2, 0, R)).toBe(1);
    expect(insideFraction(2 * R, 0, 2 * R, 0, R)).toBe(0);
  });
});

describe("makeSegmentGrid", () => {
  /** Random segments around LAT, LNG, some short, some long */
  function scattered(count: number): PathSegment[] {
    const random = seeded(7);
    return Array.from({ length: count }, (_, i) => {
      const lat = LAT + (random() - 0.5) * 0.4;
      const lng = LNG + (random() - 0.5) * 0.6;
      const reach = random() < 0.1 ? 0.3 : 0.005;
      return {
        path_id: i,
        coords: [
          [lat, lng],
          [
            lat + (random() - 0.5) * reach,
            lng + (random() - 0.5) * reach * 1.5,
          ],
        ],
        altitude_ft: 0,
        groundspeed_knots: 0,
      };
    });
  }

  it("visits every segment within the reach of a place, and each once", () => {
    const segments = scattered(2000);
    const random = seeded(11);
    for (const cellM of [500, 2000, 10000]) {
      const grid = makeSegmentGrid(segments, cellM);
      for (let n = 0; n < 20; n++) {
        const place: Coordinate = [
          LAT + (random() - 0.5) * 0.3,
          LNG + (random() - 0.5) * 0.4,
        ];
        const reachM = cellM / 2;
        const visited: number[] = [];
        grid([place], reachM, (index) => visited.push(index));
        expect(new Set(visited).size).toBe(visited.length);
        const within = segments
          .map((segment, index) => [segment, index] as const)
          .filter(([segment]) => distanceM(segment, place) <= reachM)
          .map(([, index]) => index);
        expect(visited).toEqual(expect.arrayContaining(within));
        // A grid, not a scan of all of them (the cells of 10 km are a
        // quarter of the area)
        if (cellM < 10000) {
          expect(visited.length).toBeLessThan(segments.length / 4);
        }
      }
    }
  });

  it("visits a segment near several places once", () => {
    const segments = flight(1);
    const grid = makeSegmentGrid(segments, 1000);
    const visited: number[] = [];
    grid(
      [
        [LAT, LNG],
        [LAT, LNG + 0.001],
        [LAT + 0.001, LNG],
      ],
      500,
      (index) => visited.push(index),
    );
    expect(visited.length).toBeGreaterThan(0);
    expect(new Set(visited).size).toBe(visited.length);
    // And again on the next call
    const again: number[] = [];
    grid([[LAT, LNG]], 500, (index) => again.push(index));
    expect(again.length).toBeGreaterThan(0);
  });

  it("finds a long segment in the middle, far from both of its ends", () => {
    const segments = flight(1, { fromLng: 7, toLng: 9, count: 1 });
    const visited: number[] = [];
    makeSegmentGrid(segments, 200)([[LAT, LNG]], 100, (index) =>
      visited.push(index),
    );
    expect(visited).toEqual([0]);
  });

  it("puts a segment across the antimeridian into the cells of its ends", () => {
    const segments: PathSegment[] = [
      {
        path_id: 1,
        coords: [
          [LAT, 179.99],
          [LAT, -179.99],
        ],
        altitude_ft: 0,
        groundspeed_knots: 0,
      },
    ];
    const visited: number[] = [];
    makeSegmentGrid(segments, 1000)([[LAT, -179.99]], 500, (index) =>
      visited.push(index),
    );
    expect(visited).toEqual([0]);
  });

  it("finds a segment just across the antimeridian from a place", () => {
    const segments: PathSegment[] = [
      {
        path_id: 1,
        coords: [
          [LAT, -179.998],
          [LAT, -179.99],
        ],
        altitude_ft: 0,
        groundspeed_knots: 0,
      },
    ];
    for (const lng of [179.999, -179.98]) {
      const visited: number[] = [];
      makeSegmentGrid(segments, 1000)([[LAT, lng]], 500, (index) =>
        visited.push(index),
      );
      expect(visited).toEqual([0]);
    }
  });
});

describe("readoutAt", () => {
  const R = 500;

  it("counts the time spent within the radius, from the part of each segment inside it", () => {
    // 0.01 degrees of longitude in 10 s, crossing the place
    const segments = flight(1);
    const prepared = data(segments);
    const readout = readoutAt(
      prepared,
      segmentGrid(segments, R),
      down([LAT, LNG]),
      R,
      everyone,
    )!;
    const speed = (0.01 * LNG_M) / 10;
    expect(readout.seconds).toBeCloseTo((2 * R) / speed, 1);
    expect(readout.flights).toBe(1);
    expect(readout.radiusM).toBe(R);
  });

  it("counts a segment at most for the seconds the cloud does", () => {
    // One segment across the place, with a pause of 500 s before the next
    // fix: the cloud counts 120 s of it (segmentSeconds)
    const segments = flight(1, { count: 2, step: 500 });
    const readout = readoutAt(
      data(segments),
      segmentGrid(segments, 100000),
      down([LAT, LNG - 0.025]),
      100000,
      everyone,
    )!;
    expect(readout.seconds).toBeLessThanOrEqual(240);
    expect(readout.seconds).toBeGreaterThan(120);
  });

  it("counts each flight once, and only those kept", () => {
    const segments = [
      ...flight(1),
      ...flight(2, { lat: LAT + 0.001 }),
      ...flight(3, { lat: LAT + 1 }),
    ];
    const prepared = data(segments);
    const grid = segmentGrid(segments, R);
    expect(
      readoutAt(prepared, grid, down([LAT, LNG]), R, everyone)!.flights,
    ).toBe(2);
    const onlyOne = readoutAt(
      prepared,
      grid,
      down([LAT, LNG]),
      R,
      (pathId) => pathId === 2,
    )!;
    expect(onlyOne.flights).toBe(1);
  });

  it("is null where no flight comes within the radius", () => {
    const segments = flight(1);
    expect(
      readoutAt(
        data(segments),
        segmentGrid(segments, R),
        down([LAT + 0.1, LNG]),
        R,
        everyone,
      ),
    ).toBeNull();
    expect(
      readoutAt(
        data(segments),
        segmentGrid(segments, R),
        down([LAT, LNG]),
        R,
        () => false,
      ),
    ).toBeNull();
  });

  it("measures a flight against the place of the line of sight at its own height", () => {
    // The line of sight stands on LAT at the ground and on LAT + 0.1 at
    // 3,000 ft, as it does in a view tilted to the north
    const sight: SightLine = {
      places: [
        [LAT, LNG],
        [LAT + 0.05, LNG],
        [LAT + 0.1, LNG],
      ],
      stepFt: 1500,
    };
    const high = flight(1, { lat: LAT + 0.1, altitude: 3000 });
    const low = flight(2, { lat: LAT + 0.1, altitude: 0 });
    const middle = flight(3, { lat: LAT + 0.05, altitude: 1500 });
    const between = flight(4, { lat: LAT + 0.075, altitude: 2250 });
    const taxi = flight(5, { lat: LAT, altitude: 0 });
    const segments = [...high, ...low, ...middle, ...between, ...taxi];
    const readout = readoutAt(
      data(segments),
      segmentGrid(segments, R),
      sight,
      R,
      everyone,
    )!;
    // All but the low one, whose place is LAT, 11 km south
    expect(readout.flights).toBe(4);
    const alone = readoutAt(data(low), segmentGrid(low, R), sight, R, everyone);
    expect(alone).toBeNull();
  });

  /** Segments through `lngs` at 17 S, 10 s each, at `altitude` feet */
  function through(lngs: number[], altitude = 1000): PathSegment[] {
    return lngs.slice(1).map((lng, i) => ({
      path_id: 1,
      coords: [
        [-17, lngs[i]!],
        [-17, lng],
      ],
      altitude_ft: altitude,
      groundspeed_knots: 100,
      time: i * 10,
    }));
  }

  it("counts the segments either side of the antimeridian as near as they are", () => {
    const fiji = through([179.99, 179.998, -179.995, -179.99]);
    // The same flight half the world round, where nothing wraps
    const greenwich = through([-0.01, -0.002, 0.005, 0.01]);
    const seconds = (segments: PathSegment[], place: Coordinate): number =>
      readoutAt(
        data(segments),
        segmentGrid(segments, 1000),
        down(place),
        1000,
        everyone,
      )!.seconds;

    expect(seconds(fiji, [-17, 179.999])).toBeCloseTo(
      seconds(greenwich, [-17, -0.001]),
      6,
    );
    expect(seconds(fiji, [-17, -179.999])).toBeCloseTo(
      seconds(greenwich, [-17, 0.001]),
      6,
    );
  });

  it("follows a line of sight across the antimeridian the short way", () => {
    // Halfway up, the line of sight is on the antimeridian, not at 0
    const seconds = (west: number, east: number, lngs: number[]): number => {
      const segments = through(lngs, 500);
      const sight: SightLine = {
        places: [
          [-17, west],
          [-17, east],
        ],
        stepFt: 1000,
      };
      return readoutAt(
        data(segments),
        segmentGrid(segments, R),
        sight,
        R,
        everyone,
      )!.seconds;
    };

    expect(seconds(179.99, -179.99, [179.995, 179.999, -179.999])).toBeCloseTo(
      seconds(-0.01, 0.01, [-0.005, -0.001, 0.001]),
      6,
    );
  });

  it("names the 400 ft band that holds most of the time", () => {
    const segments = [
      ...flight(1, { altitude: 900 }),
      ...flight(2, { altitude: 950, lat: LAT + 0.001 }),
      ...flight(3, { altitude: 3000, lat: LAT - 0.001 }),
    ];
    const readout = readoutAt(
      data(segments),
      segmentGrid(segments, R),
      down([LAT, LNG]),
      R,
      everyone,
    )!;
    expect(readout.band).toMatchObject({ fromFt: 700, toFt: 1100 });
    expect(readout.band.share).toBeCloseTo(2 / 3, 1);
  });

  it("counts no segment of no heat, which the cloud leaves out", () => {
    const taxi = flight(1).map((segment) => ({
      ...segment,
      groundspeed_knots: 10,
    }));
    const segments = [...taxi, ...flight(2)];
    const airborne: SegmentWeight = (segment, next) =>
      segment.groundspeed_knots < 30 ? 0 : heatWeight(segment, next);
    expect(
      readoutAt(
        readoutData(taxi, false, 10, airborne),
        segmentGrid(taxi, R),
        down([LAT, LNG]),
        R,
        everyone,
      ),
    ).toBeNull();
    expect(
      readoutAt(
        readoutData(segments, false, 10, airborne),
        segmentGrid(segments, R),
        down([LAT, LNG]),
        R,
        everyone,
      ),
    ).toMatchObject({ flights: 1 });
    // Weighed by time both count
    expect(
      readoutAt(
        readoutData(segments, false, 10),
        segmentGrid(segments, R),
        down([LAT, LNG]),
        R,
        everyone,
      ),
    ).toMatchObject({ flights: 2 });
  });

  it("counts a track without times as flown at a cruise, as the cloud does", () => {
    const untimed = flight(1).map((segment) => ({
      ...segment,
      time: undefined,
      groundspeed_knots: 0,
    }));
    const readout = readoutAt(
      readoutData(untimed, false, 10),
      segmentGrid(untimed, R),
      down([LAT, LNG]),
      R,
      everyone,
    )!;
    expect(readout.seconds).toBeCloseTo((2 * R) / CRUISE_SPEED_MS, 0);
  });

  it("counts the heat as it is asked to weigh it", () => {
    // 100 s over the kilometre across the place at the logged times, or
    // half that weighed at half
    const segments = flight(1, { step: 100 });
    const at = (weigh?: SegmentWeight) =>
      readoutAt(
        readoutData(segments, false, 10, weigh),
        segmentGrid(segments, R),
        down([LAT, LNG]),
        R,
        everyone,
      )!.seconds;
    expect(at()).toBeGreaterThan(100);
    expect(at((segment, next) => heatWeight(segment, next) / 2)).toBeCloseTo(
      at() / 2,
      6,
    );
  });
});

describe("readoutData", () => {
  /** A flight whose every segment has the ground the build sampled */
  const sampled = flight(1, { altitude: 2000 }).map((segment, i) => ({
    ...segment,
    ground_ft: i === 0 ? 2500 : 500,
  }));

  it("gives heights above the sampled ground, never below it", () => {
    // At the deepest level, the ground as sampled
    const { heightsFt, topFt, seconds } = readoutData(sampled, true, 11);
    expect(heightsFt[0]).toBe(0);
    expect(heightsFt[1]).toBe(1500);
    expect(topFt).toBe(1500);
    expect(seconds[0]).toBe(10);
  });

  it("keeps them with the dataset, until let go", () => {
    const first = readoutData(sampled, true, 11);
    expect(readoutData(sampled, true, 11).heightsFt).toBe(first.heightsFt);
    expect(segmentGrid(sampled, 500)).toBe(segmentGrid(sampled, 500));
    releaseReadoutData();
    expect(readoutData(sampled, true, 11).heightsFt).not.toBe(first.heightsFt);
  });

  it("keeps the grids of the three radii asked for last", () => {
    const at500 = segmentGrid(sampled, 500);
    const at1000 = segmentGrid(sampled, 1000);
    segmentGrid(sampled, 2000);
    // Asked for again, 500 m is the last one asked for
    expect(segmentGrid(sampled, 500)).toBe(at500);
    segmentGrid(sampled, 5000);
    // 1 km was the oldest, and made anew
    expect(segmentGrid(sampled, 500)).toBe(at500);
    expect(segmentGrid(sampled, 1000)).not.toBe(at1000);
  });

  it("stops the line of sight at 15,000 ft", () => {
    const high = flight(1, { altitude: 40000 }).map((segment) => ({
      ...segment,
      ground_ft: 0,
    }));
    expect(readoutData(high, true, 11).topFt).toBe(15000);
  });
});

describe("sightLine", () => {
  /** The screen as the map: y down to the south, a degree per 1,000 px */
  const placeAt = (x: number, y: number): Coordinate => [
    LAT - y / 1000,
    LNG + x / 1000,
  ];

  it("is one place looking straight down, or at flights drawn flat", () => {
    expect(sightLine(10, 20, 3000, 0, 20, 500, placeAt)).toEqual({
      places: [[LAT - 0.02, LNG + 0.01]],
      stepFt: 0,
    });
  });

  it("stands on the ground further down the screen the higher it is", () => {
    // 3,000 ft are 30 px, sampled every 10 px
    const sight = sightLine(0, 0, 3000, 0.01, 10, 1000, placeAt)!;
    expect(sight.stepFt).toBe(1000);
    expect(sight.places).toEqual([
      [LAT, LNG],
      [LAT - 0.01, LNG],
      [LAT - 0.02, LNG],
      [LAT - 0.03, LNG],
    ]);
  });

  it("is sampled at 48 heights over the ground at most", () => {
    expect(sightLine(0, 0, 15000, 1, 1, 1e5, placeAt)!.places).toHaveLength(49);
  });

  it("is none where the pointer is on no ground, as over the sky", () => {
    // The sky above the horizon at y 0, where MapLibre would answer with
    // ground behind the camera
    const sky = (x: number, y: number): Coordinate | null =>
      y < 0 ? null : placeAt(x, y);
    expect(sightLine(0, -5, 3000, 0.01, 10, 1000, sky)).toBeNull();
    expect(sightLine(0, -5, 3000, 0, 10, 1000, sky)).toBeNull();
    // Below it the line stands on the ground
    expect(sightLine(0, 5, 3000, 0.01, 10, 1000, sky)!.places).toHaveLength(4);
  });

  it("is none where the ground runs off towards the horizon", () => {
    // A metre a pixel down the screen from y 0, and up it ever more, as on
    // a map tilted steeply: y * y metres north, so that from 45 px up
    // places 10 px apart are more than eight radii of 100 m apart
    const tilted = (_x: number, y: number): Coordinate => [
      LAT + (y < 0 ? y * y : -y) / DEGREE_M,
      LNG,
    ];
    // A radius is a few pixels there, and the search would span the map
    expect(sightLine(0, -500, 3000, 0.1, 10, 100, tilted)).toBeNull();
    // Nearer, every place is at most eight radii from the one before
    const sight = sightLine(0, -40, 3000, 0.1, 10, 100, tilted)!;
    expect(sight.places).toHaveLength(31);
    for (let k = 1; k < sight.places.length; k++) {
      expect(
        planarMetres(sight.places[k - 1]!, sight.places[k]!),
      ).toBeLessThanOrEqual(800);
    }
  });

  it("ends at the first place without ground", () => {
    // Off the world copy the cloud is drawn in from 100 px down
    const copy = (x: number, y: number): Coordinate | null =>
      y > 100 ? null : placeAt(x, y);
    const sight = sightLine(0, 0, 3000, 0.1, 10, 1000, copy)!;
    expect(sight.stepFt).toBe(100);
    expect(sight.places).toHaveLength(11);
  });
});

describe("the words of a readout", () => {
  it("says the time to the minute, to five minutes over an hour", () => {
    expect(formatTimeSpent(20)).toBe("Under a minute");
    expect(formatTimeSpent(62)).toBe("About 1 min");
    expect(formatTimeSpent(42 * 60 + 10)).toBe("About 42 min");
    expect(formatTimeSpent(3600 + 23 * 60)).toBe("About 1 h 25 min");
    expect(formatTimeSpent(2 * 3600 + 60)).toBe("About 2 h");
    expect(formatTimeSpent(123.4 * 3600)).toBe("About 123 h");
  });

  const readout: CloudReadout = {
    radiusM: 1000,
    seconds: 42 * 60,
    flights: 17,
    band: { fromFt: 800, toFt: 1200, share: 0.6 },
  };

  it("says the time within the radius, the flights and the band", () => {
    expect(readoutText(readout)).toEqual({
      time: "About 42 min within 1 km",
      detail: "17 flights · mostly 800 to 1,200 ft AGL",
    });
  });

  it("says a band that holds less than half the time is the most frequent", () => {
    expect(
      readoutText({
        ...readout,
        radiusM: 500,
        flights: 1,
        band: { fromFt: 0, toFt: 400, share: 0.3 },
      }),
    ).toEqual({
      time: "About 42 min within 500 m",
      detail: "1 flight · most often 0 to 400 ft AGL",
    });
  });

  it("says a radius of kilometres in km", () => {
    expect(readoutText({ ...readout, radiusM: 50000 }).time).toBe(
      "About 42 min within 50 km",
    );
  });
});
