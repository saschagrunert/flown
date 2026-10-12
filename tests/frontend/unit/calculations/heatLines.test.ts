import { describe, it, expect } from "vitest";
import {
  heatLineFeatures,
  heatLinesAlong,
  heatWeight,
  CRUISE_SPEED_MS,
  segmentSeconds,
} from "../../../../flown/frontend/calculations/heatLines";
import {
  flatCurves,
  FLAT_TURN_STEP_DEG,
} from "../../../../flown/frontend/calculations/curves";
import { smoothFlights } from "../../../../flown/frontend/calculations/smoothing";
import type { PathSegment } from "../../../../flown/frontend/types";
import { createSegment } from "../../testHelpers";

/** Degrees of latitude per metre */
const DEG_PER_M = 1 / 111320;

/**
 * A flight due north from `lat`, `lng`: `count` segments of `stepM` metres,
 * each taking `stepS` seconds, with the log's relative times unless
 * `timed` is false (then only the groundspeed says how long they took).
 * A segment's time is when it starts, as the exporter writes it.
 */
function flight(
  pathId: number,
  {
    lat = 50,
    lng = 8,
    count = 10,
    stepM = 235,
    stepS = 5,
    timed = true,
  }: {
    lat?: number;
    lng?: number;
    count?: number;
    stepM?: number;
    stepS?: number;
    timed?: boolean;
  } = {},
): PathSegment[] {
  const knots = stepM / stepS / (1852 / 3600);
  return Array.from({ length: count }, (_, i) =>
    createSegment({
      path_id: pathId,
      coords: [
        [lat + i * stepM * DEG_PER_M, lng],
        [lat + (i + 1) * stepM * DEG_PER_M, lng],
      ],
      groundspeed_knots: knots,
      time: timed ? i * stepS : undefined,
    }),
  );
}

const all = (): boolean => true;

/** The heat of the line that holds `[lng, lat]` */
function heatAt(
  collection: ReturnType<typeof heatLineFeatures>,
  lat: number,
  lng: number,
): number {
  const feature = collection.features.find((f) =>
    f.geometry.coordinates.some(
      ([x, y]) => Math.abs(x! - lng) < 1e-9 && Math.abs(y! - lat) < 1e-9,
    ),
  );
  expect(feature).toBeDefined();
  return feature!.properties.heat;
}

describe("heatLineFeatures", () => {
  it("draws every fix of a flight, in order, longitude first", () => {
    const segments = flight(1, { count: 4 });

    const lines = heatLineFeatures(segments, all).features.map(
      (feature) => feature.geometry.coordinates,
    );

    // Lines of one flight meet where one heat hands over to the next
    const fixes = lines.flatMap((line, index) =>
      index === 0 ? line : line.slice(1),
    );
    expect(fixes).toEqual([
      ...segments.map((s) => [s.coords[0][1], s.coords[0][0]]),
      [segments[3]!.coords[1][1], segments[3]!.coords[1][0]],
    ]);
  });

  it("merges a stretch of even heat into one line", () => {
    const segments = flight(1, { count: 60 });

    const { features } = heatLineFeatures(segments, all);

    // Only the ends, which have a neighbour on one side, run cooler
    expect(features.length).toBeLessThanOrEqual(3);
  });

  it("makes a place hotter the longer the aircraft stayed there", () => {
    const cruise = flight(1, { lng: 8, stepS: 5 });
    const taxi = flight(2, { lng: 9, stepS: 50 });

    const lines = heatLineFeatures([...cruise, ...taxi], all);

    const middle = 50 + 5 * 235 * DEG_PER_M;
    expect(heatAt(lines, middle, 9)).toBeGreaterThan(
      heatAt(lines, middle, 8) * 4,
    );
  });

  it("takes the time from the groundspeed when the log has none", () => {
    const fast = flight(1, { lng: 8, stepS: 5, timed: false });
    const slow = flight(2, { lng: 9, stepS: 50, timed: false });

    const lines = heatLineFeatures([...fast, ...slow], all);

    const middle = 50 + 5 * 235 * DEG_PER_M;
    expect(heatAt(lines, middle, 9)).toBeGreaterThan(
      heatAt(lines, middle, 8) * 4,
    );
  });

  it("does not count a break in the log as time spent", () => {
    const segments = flight(1, { count: 3 });
    // An hour on the second segment: the logger was off
    segments[2]!.time = 3600;
    const withBreak = heatLineFeatures(segments, all);
    const without = heatLineFeatures(flight(1, { count: 3 }), all);

    // The segment takes what its groundspeed says instead, five seconds
    expect(withBreak).toEqual(without);
  });

  it("counts a wait on the segment that waited, which starts at its time", () => {
    // Two segments of one flight far apart, the first with a wait of 100 s:
    // the time from its start to the start of the next is its own
    const segment = (lat: number, time: number): PathSegment =>
      createSegment({
        path_id: 1,
        coords: [
          [lat, 8],
          [lat + 235 * DEG_PER_M, 8],
        ],
        // Five seconds at its groundspeed
        groundspeed_knots: 235 / 5 / (1852 / 3600),
        time,
      });

    const lines = heatLineFeatures([segment(50, 0), segment(51, 100)], all);

    // The last segment of a flight has no end time: its groundspeed says
    expect(heatAt(lines, 50, 8)).toBeGreaterThan(heatAt(lines, 51, 8) * 16);
  });

  it("carries a line on across the antimeridian", () => {
    const segments = flight(1, { count: 2 });
    segments[0]!.coords = [
      [60, 179.99],
      [60, -180],
    ];
    segments[1]!.coords = [
      [60, -180],
      [60, -179.99],
    ];

    const [line] = heatLineFeatures(segments, all).features;

    // Not back round the world at 180 degrees
    expect(line!.geometry.coordinates.map(([lng]) => lng)).toEqual([
      179.99,
      180,
      expect.closeTo(180.01, 9),
    ]);
  });

  it("adds up the flights over the same place", () => {
    const one = heatLineFeatures(flight(1), all);
    const three = heatLineFeatures(
      [...flight(1), ...flight(2), ...flight(3)],
      all,
    );

    const middle = 50 + 5 * 235 * DEG_PER_M;
    expect(heatAt(three, middle, 8)).toBeGreaterThan(
      heatAt(one, middle, 8) * 2,
    );
  });

  it("rolls the time around each segment off with `tone`, before it is smoothed", () => {
    const flights = Array.from({ length: 8 }, (_, i) => flight(i + 1)).flat();
    const plain = heatLineFeatures(flights, all);
    const halved = heatLineFeatures(
      flights,
      all,
      undefined,
      (seconds) => seconds / 2,
    );

    const middle = 50 + 5 * 235 * DEG_PER_M;
    expect(heatAt(halved, middle, 8)).toBe(heatAt(plain, middle, 8) / 2);
  });

  it("keeps a flight that only crosses a busy place cool", () => {
    // Ten flights stand around one spot, a lone one passes it at speed
    const busy = Array.from({ length: 10 }, (_, i) =>
      flight(i + 1, { count: 2, stepM: 5, stepS: 60 }),
    ).flat();
    const passing = createSegment({
      path_id: 99,
      coords: [
        [50 - 200 * DEG_PER_M, 8],
        [50 + 200 * DEG_PER_M, 8],
      ],
      groundspeed_knots: 100,
    });

    const lines = heatLineFeatures([...busy, passing], all);

    expect(heatAt(lines, 50 + 200 * DEG_PER_M, 8)).toBeLessThan(
      heatAt(lines, 50, 8) / 10,
    );
  });

  it("draws and counts only the flights the filter keeps", () => {
    const segments = [...flight(1), ...flight(2), ...flight(3, { lng: 9 })];

    const both = heatLineFeatures(segments, all);
    const one = heatLineFeatures(segments, (id) => id !== 2);

    const middle = 50 + 5 * 235 * DEG_PER_M;
    expect(heatAt(one, middle, 8)).toBeLessThan(heatAt(both, middle, 8));
    // Path 3 alone at 9 degrees, path 1 alone at 8: the same heat
    expect(heatAt(one, middle, 8)).toBe(heatAt(one, middle, 9));
    expect(heatLineFeatures(segments, () => false).features).toEqual([]);
  });

  it("never joins two flights, even where one starts at the other's end", () => {
    const first = flight(1, { count: 1 });
    const second = flight(2, { count: 1, lat: 50 + 235 * DEG_PER_M });

    expect(heatLineFeatures([...first, ...second], all).features).toHaveLength(
      2,
    );
  });
});

describe("heatLineFeatures along the curve", () => {
  /**
   * A flight of segments of 235 m that turns by `turn` degrees at every
   * fix, taking `stepS` seconds each
   */
  function turning(
    pathId: number,
    lng: number,
    stepS: number[],
    turn = 30,
  ): PathSegment[] {
    let heading = 0;
    let at: [number, number] = [50, lng];
    return stepS.map((_, i) => {
      const from = at;
      const radians = (heading * Math.PI) / 180;
      at = [
        from[0] + 235 * DEG_PER_M * Math.cos(radians),
        from[1] +
          (235 * DEG_PER_M * Math.sin(radians)) /
            Math.cos((50 * Math.PI) / 180),
      ];
      heading += turn;
      return createSegment({
        path_id: pathId,
        coords: [from, at],
        // What `flight` gives its segments, for the last one's time
        groundspeed_knots: 235 / 5 / (1852 / 3600),
        time: stepS.slice(0, i).reduce((sum, s) => sum + s, 0),
      });
    });
  }

  // Slow, then fast, then slow: three heats
  const times = [60, 60, 60, 60, 2, 2, 2, 2, 60, 60, 60, 60];

  it("runs through the fixes along a curve, with more points in a turn", () => {
    const segments = turning(1, 8, times);

    const lines = heatLineFeatures(segments, all).features.map(
      (feature) => feature.geometry.coordinates,
    );
    const points = lines.flatMap((line, index) =>
      index === 0 ? line : line.slice(1),
    );

    // 30 degrees a fix is 8 points of the curve to a segment
    expect(points).toHaveLength(segments.length * 8 + 1);
    segments.forEach((segment, i) => {
      expect(points[i * 8]).toEqual([
        segment.coords[0][1],
        segment.coords[0][0],
      ]);
    });
  });

  it("meets end to end where the heat changes, at a fix", () => {
    const { features } = heatLineFeatures(turning(1, 8, times), all);

    expect(features.length).toBeGreaterThan(1);
    for (let i = 1; i < features.length; i++) {
      const before = features[i - 1]!.geometry.coordinates;
      expect(features[i]!.geometry.coordinates[0]).toEqual(
        before[before.length - 1],
      );
    }
  });

  it("counts the time at the fixes, which the curve adds none to", () => {
    // The same times, turning and straight, far enough apart not to share
    // a cell, and the turn not coming round to where it started: the same
    // heat, stretch for stretch
    const heats = (segments: PathSegment[]): number[] =>
      heatLineFeatures(segments, all).features.map((f) => f.properties.heat);
    const straight = flight(1, { count: times.length }).map((segment, i) => ({
      ...segment,
      time: times.slice(0, i).reduce((sum, s) => sum + s, 0),
    }));

    expect(heats(turning(2, 9, times, 15))).toEqual(heats(straight));
  });
});

describe("heatLinesAlong", () => {
  it("draws the lines of heatLineFeatures along the curves it is handed", () => {
    const segments = [...flight(1), ...flight(2, { lng: 8.001, count: 4 })];
    // Half the heat of the heatmap's, as a weighing of a test
    const weigh = (segment: PathSegment, next: PathSegment | undefined) =>
      heatWeight(segment, next) / 2;
    const tone = (seconds: number): number => seconds / 2;
    // The year decoder is handed the curves the page keeps, and works out
    // none of its own
    const curves = smoothFlights(segments, () => 0, {
      turnStepDeg: FLAT_TURN_STEP_DEG,
    });

    expect(
      heatLinesAlong(curves, segments, (id) => id === 1, weigh, tone),
    ).toEqual(heatLineFeatures(segments, (id) => id === 1, weigh, tone));
    expect(curves).not.toBe(flatCurves(segments));
  });
});

describe("heatLineFeatures smoothing", () => {
  it("does not let one hot cell break a flight into a short hot stretch", () => {
    // A long lone flight, and a second one that shares a single fix of it
    const lone = flight(1, { count: 40 });
    const at = lone[20]!.coords[0];
    const crossing = createSegment({
      path_id: 2,
      coords: [
        [at[0], at[1] - 0.00001],
        [at[0], at[1] + 0.00001],
      ],
      groundspeed_knots: 2,
    });

    const { features } = heatLineFeatures([...lone, crossing], all);

    // The lone flight stays a few long lines, not a string of short ones
    const lines = features.filter((f) => f.geometry.coordinates.length > 2);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("never averages across two flights", () => {
    const cool = flight(1, { count: 5, stepS: 5 });
    const hot = flight(2, {
      count: 5,
      lat: 50 + 5 * 235 * DEG_PER_M,
      stepM: 20,
      stepS: 60,
    });

    const lines = heatLineFeatures([...cool, ...hot], all);

    const coolStart = heatAt(lines, 50, 8);
    const hotEnd = heatAt(lines, 50 + (5 * 235 + 100) * DEG_PER_M, 8);
    expect(hotEnd).toBeGreaterThan(coolStart * 16);
  });
});

describe("heatWeight", () => {
  const [first, second] = flight(1, { count: 2, stepM: 235, stepS: 5 });

  it("counts the seconds spent, as the heat lines always did", () => {
    expect(heatWeight(first!, second)).toBe(segmentSeconds(first!, second));
    expect(heatWeight(first!, second)).toBeCloseTo(5);
  });

  it("counts a track without times or speeds as flown at cruise speed", () => {
    const planned = createSegment({
      groundspeed_knots: 0,
      coords: [
        [50, 8],
        [50 + 514 * DEG_PER_M, 8],
      ],
    });
    expect(segmentSeconds(planned, undefined)).toBe(0);
    expect(heatWeight(planned, undefined)).toBeCloseTo(
      514 / CRUISE_SPEED_MS,
      1,
    );
  });

  it("adds no more for a leg kilometres long than a long stand does", () => {
    const leg = createSegment({
      groundspeed_knots: 0,
      coords: [
        [50, 8],
        [50 + 20000 * DEG_PER_M, 8],
      ],
    });
    const most = heatWeight(
      createSegment({ time: 0, groundspeed_knots: 1 }),
      createSegment({ time: 590 }),
    );
    expect(most).toBe(120);
    expect(heatWeight(leg, undefined)).toBe(most);
  });

  it("draws no line of segments of no heat", () => {
    const taxi = flight(1, { count: 5, stepM: 20, stepS: 5 });
    const air = flight(2, { count: 5, lat: 51 });
    for (const segment of taxi) segment.groundspeed_knots = 10;
    const segments = [...taxi, ...air];
    const at = ([lat, lng]: [number, number]): string => [lng, lat].join();
    const drawn = (weigh = heatWeight): Set<string> =>
      new Set(
        heatLineFeatures(segments, all, weigh).features.flatMap((line) =>
          line.geometry.coordinates.map((point) => point.join()),
        ),
      );

    expect(drawn().has(at(taxi[0]!.coords[0]))).toBe(true);
    const airborne = drawn((segment, next) =>
      segment.groundspeed_knots < 30 ? 0 : heatWeight(segment, next),
    );
    expect(airborne.has(at(taxi[0]!.coords[0]))).toBe(false);
    expect(airborne.has(at(taxi[4]!.coords[1]))).toBe(false);
    expect(airborne.has(at(air[0]!.coords[0]))).toBe(true);
  });
});
