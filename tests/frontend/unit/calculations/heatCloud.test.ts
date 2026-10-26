/**
 * The points of the heat cloud of the 3D view: the fixes of the flights the
 * heatmap shows, at the heights of the ribbons, merged for the level, with
 * the seconds spent on each stretch between them, the time each was flown
 * at, how strongly each may draw the marks of the way flown, and the heat
 * of the busiest cells for the exposure. How the marks are weighed is
 * cloudCells.test.ts'.
 */
import { describe, it, expect } from "vitest";
import {
  CLOUD_MERGE_HEAT,
  CLOUD_MERGE_MAX_PX,
  CLOUD_MERGE_PX,
  CLOUD_POINT_FLOATS,
  CLOUD_STEP_PX,
  cloudPoints,
  nthSmallest,
  type CloudPoints,
} from "../../../../flown/frontend/calculations/heatCloud";
import {
  chainTimes,
  flightClock,
} from "../../../../flown/frontend/calculations/flightClock";
import { levelGroundFt } from "../../../../flown/frontend/calculations/groundProfile";
import {
  heatWeight,
  CRUISE_SPEED_MS,
  segmentSeconds,
  type SegmentWeight,
} from "../../../../flown/frontend/calculations/heatLines";
import {
  HEAT_KNEE,
  heatTone,
} from "../../../../flown/frontend/calculations/heatTone";
import { liftFt } from "../../../../flown/frontend/calculations/lift";
import { segmentDistance } from "../../../../flown/frontend/calculations/statistics";
import { smoothFlights } from "../../../../flown/frontend/calculations/smoothing";
import {
  DEGREES_TO_RADIANS,
  metresPerPixel,
  type Coordinate,
} from "../../../../flown/frontend/utils/geometry";
import { mercatorOf } from "../../../../flown/frontend/utils/mercator";
import type { PathSegment } from "../../../../flown/frontend/types";

/**
 * A weighing of the tests: each segment by its length, at a cruise, as
 * the heat of a track without times is counted, and at most two minutes
 */
const byLength: SegmentWeight = (segment) =>
  Math.min((segmentDistance(segment) * 1000) / CRUISE_SPEED_MS, 120);

/** A point of the cloud, read back from its floats */
interface Point {
  x: number;
  y: number;
  ground: number;
  lift: number;
  heat: number;
  time: number;
  marks: number;
}

/** The points of a cloud, without the empty one before and after them */
function pointsOf(cloud: CloudPoints): Point[] {
  const out: Point[] = [];
  for (let k = 1; k <= cloud.count; k++) {
    const at = k * CLOUD_POINT_FLOATS;
    const p = cloud.points;
    out.push({
      x: p[at]! + cloud.origin[0],
      y: p[at + 1]! + cloud.origin[1],
      ground: p[at + 2]!,
      lift: p[at + 3]!,
      heat: p[at + 4]!,
      time: p[at + 5]!,
      marks: p[at + 6]!,
    });
  }
  return out;
}

/**
 * A flight of `path_id` through `fixes`, a segment from each to the next,
 * `seconds` apart, at the altitudes `altitudes` (the one a segment ends at)
 */
function flight(
  path_id: number,
  fixes: Coordinate[],
  altitudes: number[] = fixes.slice(1).map(() => 3000),
  seconds = 5,
): PathSegment[] {
  return fixes.slice(1).map((to, i) => ({
    path_id,
    coords: [fixes[i]!, to],
    altitude_ft: altitudes[i]!,
    groundspeed_knots: 100,
    time: i * seconds,
  }));
}

/**
 * `segments` in runs of `run` flown at the speed of their times and at a
 * quarter of it by turns: a metre of the one carries four times the heat
 * of a metre of the other, so no two runs are merged into one stretch
 * (see CLOUD_MERGE_HEAT), and each shows as it is kept
 */
function byTurns(segments: PathSegment[], run = 1, seconds = 5): PathSegment[] {
  let time = 0;
  return segments.map((segment, i) => {
    const slow = Math.floor(i / run) % 2 === 1;
    const turn = { ...segment, time, groundspeed_knots: slow ? 25 : 100 };
    time += slow ? 4 * seconds : seconds;
    return turn;
  });
}

/** `count` fixes `stepDeg` of longitude apart along the latitude `lat` */
function line(
  count: number,
  lat = 47,
  lng = 11,
  stepDeg = 0.003,
): Coordinate[] {
  return Array.from({ length: count }, (_, i) => [lat, lng + i * stepDeg]);
}

const everything = (): boolean => true;

/**
 * The cloud of `segments` along their curves smoothed on the ground
 * `ground` (by segment, see smoothFlights), as groundedFlights smooths them
 */
function cloudOf(
  segments: PathSegment[],
  keep: (pathId: number) => boolean,
  ground: ArrayLike<number>,
  level: number,
): CloudPoints {
  const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
    groundOf: (i) => ground[i]!,
  });
  return cloudPoints(segments, flights, keep, level);
}

/**
 * The seconds of every segment as the heat lines count them: the time to
 * the next of its path, and the last at its groundspeed
 */
function secondsOf(segments: PathSegment[]): number[] {
  return segments.map((segment, i) => segmentSeconds(segment, segments[i + 1]));
}

describe("cloudPoints", () => {
  it("keeps its origin and points finite for a fix at the pole", () => {
    const fixes: Coordinate[] = [...line(4, 89.99), [90, 11.009]];
    const cloud = cloudOf(flight(1, fixes), everything, [0, 0, 0, 0], 8);
    expect(cloud.count).toBeGreaterThan(1);
    expect(cloud.origin.every(Number.isFinite)).toBe(true);
    expect(cloud.points.every(Number.isFinite)).toBe(true);
  });

  it("is empty without segments, or where the filter keeps none", () => {
    expect(cloudOf([], everything, [], 8).count).toBe(0);
    const segments = flight(1, line(4));
    const none = cloudOf(segments, () => false, [0, 0, 0], 8);
    expect(none.count).toBe(0);
    // The empty point before and after is there all the same
    expect(none.points).toHaveLength(2 * CLOUD_POINT_FLOATS);
  });

  it("keeps every fix where they are further apart than the step, the first at the start of the first segment", () => {
    const fixes = line(4);
    const segments = byTurns(flight(1, fixes));
    const cloud = cloudOf(segments, everything, [0, 0, 0], 11);
    const points = pointsOf(cloud);
    expect(points).toHaveLength(4);
    points.forEach((point, i) => {
      const [x, y] = mercatorOf(fixes[i]!);
      expect(point.x).toBeCloseTo(x, 9);
      expect(point.y).toBeCloseTo(y, 9);
    });
  });

  it("gives the points from an origin in the middle of them, and has an empty point before and after them", () => {
    const segments = flight(1, line(3, 47, 11, 0.5));
    const cloud = cloudOf(segments, everything, [0, 0], 11);
    const west = mercatorOf([47, 11])[0];
    const east = mercatorOf([47, 12])[0];
    expect(cloud.origin[0]).toBeCloseTo((west + east) / 2, 12);
    expect(cloud.origin[1]).toBeCloseTo(mercatorOf([47, 11])[1], 12);
    const floats = cloud.points;
    expect(floats).toHaveLength((cloud.count + 2) * CLOUD_POINT_FLOATS);
    const empty = new Array(CLOUD_POINT_FLOATS).fill(0);
    expect([...floats.slice(0, CLOUD_POINT_FLOATS)]).toEqual(empty);
    expect([...floats.slice(-CLOUD_POINT_FLOATS)]).toEqual(empty);
    // Small numbers around the origin, which a 32-bit float holds exactly
    expect(Math.abs(floats[CLOUD_POINT_FLOATS]!)).toBeLessThan(0.002);
  });

  it("stands every point on the ground under it, at its altitude above that, never below", () => {
    // Far enough apart for the curve to climb and sink as they did (see
    // MAX_SLOPE in smoothing.ts)
    const segments = flight(1, line(4, 47, 11, 0.05), [2500, 1500, 4000]);
    // The ground under the end of each segment
    const ground = [2000, 1800, 1000];
    const points = pointsOf(cloudOf(segments, everything, ground, 11));
    // The first fix takes the altitude and the ground of the first segment,
    // as the ribbons do (see smoothFlights)
    expect(points.map((p) => p.ground)).toEqual([2000, 2000, 1800, 1000]);
    expect(points.map((p) => p.lift)).toEqual([
      liftFt(2500, 2000),
      500,
      0,
      3000,
    ]);
  });

  it("stands on the ground of the relief level it is cut for, the one the ribbons stand on", () => {
    const fixes = line(40, 46.5, 10, 0.01);
    const segments = flight(
      1,
      fixes,
      fixes.slice(1).map(() => 9000),
    ).map((segment, i) => ({
      ...segment,
      ground_ft: 3000 + 1500 * Math.sin(i),
    }));
    const level = 11;
    const ground = levelGroundFt(segments, true, level);
    const points = pointsOf(cloudOf(segments, everything, ground, level));
    expect(points.slice(1).map((p) => p.ground)).toEqual(
      [...ground].map((feet) => Math.fround(feet)),
    );
    // At its altitude, over whatever ground
    for (const point of points) {
      expect(point.ground + point.lift).toBeCloseTo(9000, 2);
    }
  });

  it("carries the seconds spent on a stretch on the point it starts from, and none on the last of a flight", () => {
    const segments = byTurns(flight(1, line(4)), 1, 7);
    const points = pointsOf(cloudOf(segments, everything, [0, 0, 0], 11));
    const seconds = secondsOf(segments);
    // The last segment of a path has no next: it is at its groundspeed
    expect(seconds.slice(0, 2)).toEqual([7, 28]);
    expect(points.map((p) => p.heat)).toEqual(
      [...seconds, 0].map((s) => Math.fround(s)),
    );
  });

  it("merges the fixes closer than the step at the level, with their heat, keeping the ends", () => {
    // 300 m apart, where a step at level 4 is kilometres
    const fixes = line(21, 47, 11, 0.004);
    const segments = flight(1, fixes, undefined, 6);
    const points = pointsOf(
      cloudOf(segments, everything, new Array(20).fill(0), 4),
    );
    expect(points.length).toBeLessThan(21);
    expect(points.length).toBeGreaterThanOrEqual(2);
    const [x0] = mercatorOf(fixes[0]!);
    const [xn] = mercatorOf(fixes[20]!);
    expect(points[0]!.x).toBeCloseTo(x0, 9);
    expect(points[points.length - 1]!.x).toBeCloseTo(xn, 9);
    // Every second of the flight is on a stretch still
    const total = points.reduce((sum, p) => sum + p.heat, 0);
    const seconds = secondsOf(segments).reduce((sum, s) => sum + s, 0);
    expect(total).toBeCloseTo(seconds, 3);
  });

  it("keeps a fix a step apart from the last kept, the step being pixels of the level", () => {
    const level = 6;
    const lat = 47;
    const stepM =
      CLOUD_STEP_PX *
      metresPerPixel(level + 0.5) *
      Math.cos(lat * DEGREES_TO_RADIANS);
    // Fixes a third of a step apart: every third is kept
    const stepDeg = stepM / 3 / (111320 * Math.cos(lat * DEGREES_TO_RADIANS));
    const segments = byTurns(flight(1, line(11, lat, 11, stepDeg * 1.0001)), 3);
    const points = pointsOf(
      cloudOf(segments, everything, new Array(10).fill(0), level),
    );
    // And the last, at the end of the flight
    expect(points).toHaveLength(5);
  });

  it("keeps a climb a climb: a fix where the height has changed by a pixel since the last kept", () => {
    // Far enough apart to climb as steeply as they do (see MAX_SLOPE in
    // smoothing.ts)
    const fixes = line(21, 47, 11, 0.02);
    const level = 4;
    const flat = flight(1, fixes);
    // Up by 800 ft a fix, then level at the top
    const climbing = flight(
      1,
      fixes,
      fixes.slice(1).map((_, i) => 1000 + 800 * Math.min(i, 10)),
    );
    const ground = new Array(20).fill(0);
    const cloud = (segments: PathSegment[]): Point[] =>
      pointsOf(cloudOf(segments, everything, ground, level));
    // A straight line, level or climbing, is one stretch; the top of the
    // climb is where it levels off
    expect(cloud(flat)).toHaveLength(2);
    const lifts = cloud(climbing).map((p) => p.lift);
    expect(lifts.length).toBeGreaterThan(2);
    expect(lifts).toContain(9000);
    expect(lifts.filter((lift) => lift > 1000 && lift < 9000)).toEqual([]);
  });

  it("follows the filter, flight by flight", () => {
    const segments = [
      ...flight(1, line(3, 47)),
      ...flight(2, line(3, 48)),
      ...flight(3, line(3, 49)),
    ];
    const ground = new Array(segments.length).fill(0);
    const points = pointsOf(cloudOf(segments, (id) => id !== 2, ground, 11));
    // Each a straight line, one stretch
    expect(points).toHaveLength(4);
    const ys = points.map((p) => p.y);
    expect(
      ys.filter((y) => Math.abs(y - mercatorOf([48, 11])[1]) < 1e-9),
    ).toEqual([]);
  });

  it("starts a flight anew where the next segment does not start where the last ended, or is of another path", () => {
    const a = byTurns(flight(1, line(3, 47)));
    // The same path again, somewhere else: a gap in the log
    const b = byTurns(flight(1, line(3, 47.5)));
    const c = flight(2, [line(3, 47.5)[2]!, [47.6, 11]]);
    const segments = [...a, ...b, ...c];
    const points = pointsOf(
      cloudOf(segments, everything, new Array(segments.length).fill(0), 11),
    );
    expect(points).toHaveLength(3 + 3 + 2);
    // No stretch from the end of one to the start of the next
    const seconds = secondsOf(segments).map((s) => Math.fround(s));
    expect(points.map((p) => p.heat)).toEqual([
      ...seconds.slice(0, 2),
      0,
      ...seconds.slice(2, 4),
      0,
      seconds[4],
      0,
    ]);
    expect(points[0]!.heat).toBe(5);
  });

  it("takes a flight across the antimeridian the short way", () => {
    const segments = flight(1, [
      [10, 179.99],
      [10, -179.99],
    ]);
    const points = pointsOf(cloudOf(segments, everything, [0], 11));
    // Past 1 rather than back across the world
    expect(points[1]!.x - points[0]!.x).toBeCloseTo(0.02 / 360, 9);
  });

  it("counts a stretch without times or speeds as flown at cruise speed, as the heatmap does", () => {
    const segments = flight(1, line(3)).map((segment) => ({
      ...segment,
      time: undefined,
      groundspeed_knots: 0,
    }));
    const points = pointsOf(cloudOf(segments, everything, [0, 0], 11));
    const cruise = segments.reduce(
      (sum, segment) => sum + heatWeight(segment, undefined),
      0,
    );
    expect(cruise).toBeGreaterThan(1);
    expect(points.reduce((sum, point) => sum + point.heat, 0)).toBeCloseTo(
      cruise,
      3,
    );
  });

  it("lies on the curve the ribbons are cut from, where a flight turns, not on the chords between its fixes", () => {
    // A right angle over three fixes a kilometre apart
    const fixes: Coordinate[] = [
      [47, 11],
      [47, 11.0132],
      [47.009, 11.0132],
    ];
    const segments = flight(1, fixes, undefined, 20);
    const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    const curve = flights.chains[0]!.points;
    // The spline adds points in the bend
    expect(curve.length).toBeGreaterThan(fixes.length);
    // At a level where no point of the curve is within a step of the next
    const points = pointsOf(cloudPoints(segments, flights, everything, 16));
    expect(points).toHaveLength(curve.length);
    points.forEach((point, j) => {
      const [x, y] = mercatorOf(curve[j]!);
      expect(point.x).toBeCloseTo(x, 9);
      expect(point.y).toBeCloseTo(y, 9);
    });
  });

  it("spreads the seconds of a segment over the stretches of the curve along it by their length", () => {
    const fixes: Coordinate[] = [
      [47, 11],
      [47, 11.0132],
      [47.009, 11.0132],
      [47.018, 11.0132],
    ];
    const segments = flight(1, fixes, undefined, 20);
    const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    const points = pointsOf(cloudPoints(segments, flights, everything, 16));
    const total = points.reduce((sum, p) => sum + p.heat, 0);
    const seconds = secondsOf(segments).reduce((sum, t) => sum + t, 0);
    expect(total).toBeCloseTo(seconds, 3);
    // The segment into the bend is cut into pieces of a few seconds each
    const { from, to } = flights;
    const pieces = to[1]! - from[1]!;
    expect(pieces).toBeGreaterThan(1);
    const bend = points.slice(from[1], to[1]).map((p) => p.heat);
    expect(bend.reduce((sum, t) => sum + t, 0)).toBeCloseTo(20, 3);
    for (const heat of bend) expect(heat).toBeLessThan(20);
  });

  it("weighs a stretch as it is asked to, by its time or by its length", () => {
    /** The same stretch flown a segment every `seconds`, at that speed */
    const flown = (path: number, seconds: number): PathSegment[] =>
      flight(path, line(3), undefined, seconds).map((segment) => ({
        ...segment,
        groundspeed_knots:
          (segmentDistance(segment) * 1000) / seconds / (1852 / 3600),
      }));
    const heatOf = (segments: PathSegment[], route: boolean): number =>
      pointsOf(
        cloudPoints(
          segments,
          smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
            groundOf: () => 0,
          }),
          everything,
          11,
          11,
          null,
          undefined,
          route ? byLength : heatWeight,
        ),
      ).reduce((sum, point) => sum + point.heat, 0);
    const [fast, slow] = [flown(1, 5), flown(2, 60)];

    expect(heatOf(slow, false)).toBeCloseTo(heatOf(fast, false) * 12, 3);
    expect(heatOf(slow, true)).toBeCloseTo(heatOf(fast, true), 3);
  });
});

/** Mercator units in pixels of the zoom level `level`, in its middle */
const pixelsOf = (level: number): number => 512 * 2 ** (level + 0.5);

/** How far `point` is from the line through `line`, in Mercator units */
function offLine(point: { x: number; y: number }, line: Point[]): number {
  let least = Infinity;
  for (let k = 0; k + 1 < line.length; k++) {
    const a = line[k]!;
    const b = line[k + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t =
      length > 0
        ? Math.min(
            Math.max(((point.x - a.x) * dx + (point.y - a.y) * dy) / length, 0),
            1,
          )
        : 0;
    least = Math.min(
      least,
      Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy),
    );
  }
  return least;
}

/** The curve of the one flight of `segments`, on flat ground */
function curveOf(segments: PathSegment[]): {
  flights: ReturnType<typeof smoothFlights>;
  curve: Coordinate[];
} {
  const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
    groundOf: () => 0,
  });
  return { flights, curve: flights.chains[0]!.points };
}

/** `count` fixes `metres` apart on a circle of `radius` metres around 47, 11 */
function circle(count: number, radius: number): Coordinate[] {
  const perDegree = 111320;
  return Array.from({ length: count }, (_, i) => {
    const angle = (2 * Math.PI * i) / count;
    return [
      47 + (radius * Math.sin(angle)) / perDegree,
      11 +
        (radius * Math.cos(angle)) /
          (perDegree * Math.cos(47 * DEGREES_TO_RADIANS)),
    ];
  });
}

describe("the stretches of the cloud", () => {
  it("merges the steps along a straight run into one stretch, with their heat, from the time of its first", () => {
    const segments = flight(1, line(5));
    const points = pointsOf(cloudOf(segments, everything, [0, 0, 0, 0], 11));
    expect(points).toHaveLength(2);
    const seconds = secondsOf(segments).reduce((sum, s) => sum + s, 0);
    expect(points[0]!.heat).toBeCloseTo(seconds, 3);
    expect(points[1]!.heat).toBe(0);
    expect(points.map((p) => p.time)).toEqual(
      [0, flightClock(segments).duration.get(1)!].map((s) => Math.fround(s)),
    );
  });

  it("merges a last fix written again a moment later where it was", () => {
    // A step of no length had a heat per metre of Infinity, which broke
    // off the stretch it ended
    const fixes = line(5);
    const segments = flight(1, [...fixes, fixes.at(-1)!, fixes.at(-1)!]);
    segments[5]!.time = segments[4]!.time! + 0.5;
    const points = pointsOf(
      cloudOf(segments, everything, [0, 0, 0, 0, 0, 0], 11),
    );
    expect(points).toHaveLength(2);
  });

  it("is no longer than CLOUD_MERGE_MAX_PX of the level", () => {
    const level = 11;
    const points = pointsOf(
      cloudOf(flight(1, line(41)), everything, new Array(40).fill(0), level),
    );
    // 40 fixes 12 px apart
    expect(points.length).toBeGreaterThanOrEqual(
      Math.ceil((40 * 12) / CLOUD_MERGE_MAX_PX) + 1,
    );
    for (let k = 0; k + 1 < points.length; k++) {
      const length = Math.hypot(
        points[k + 1]!.x - points[k]!.x,
        points[k + 1]!.y - points[k]!.y,
      );
      expect(length * pixelsOf(level)).toBeLessThanOrEqual(CLOUD_MERGE_MAX_PX);
    }
  });

  it("stays within CLOUD_MERGE_PX of every point of the curve it merges, around a bend", () => {
    // Six fixes 150 m apart to the east, and six turning off by 30 degrees
    const metres = 150 / (111320 * Math.cos(47 * DEGREES_TO_RADIANS));
    const fixes: Coordinate[] = line(6, 47, 11, metres);
    const turn = 30 * DEGREES_TO_RADIANS;
    for (let i = 1; i <= 6; i++) {
      fixes.push([
        47 + (i * 150 * Math.sin(turn)) / 111320,
        fixes[5]![1] + i * metres * Math.cos(turn),
      ]);
    }
    const segments = flight(1, fixes);
    const { flights, curve } = curveOf(segments);
    // A level where every piece of the curve is a step of its own
    const level = 13;
    const points = pointsOf(cloudPoints(segments, flights, everything, level));
    expect(points.length).toBeLessThan(curve.length);
    expect(points.length).toBeGreaterThan(3);
    for (const fix of curve) {
      const [x, y] = mercatorOf(fix);
      expect(offLine({ x, y }, points) * pixelsOf(level)).toBeLessThan(
        CLOUD_MERGE_PX + 1e-3,
      );
    }
  });

  it("does not merge steps whose heat per metre differs by more than CLOUD_MERGE_HEAT", () => {
    // Two segments alike but for the time spent on the second
    const kept = (factor: number): number => {
      const segments = flight(1, line(4)).map((segment, i) => ({
        ...segment,
        time: i === 0 ? 0 : 10 + (i - 1) * 10 * factor,
      }));
      return cloudOf(segments, everything, [0, 0, 0], 11).count;
    };
    expect(kept(CLOUD_MERGE_HEAT * 0.9)).toBe(kept(1));
    expect(kept(CLOUD_MERGE_HEAT * 1.1)).toBe(kept(1) + 1);
  });

  it("keeps a point where the pulses would run off it by the time it was flown at, though its heat is alike", () => {
    // Two minutes of heat each (see segmentSeconds), and the clock in full
    const kept = (times: number[]): number => {
      const segments = flight(1, line(4)).map((segment, i) => ({
        ...segment,
        time: times[i]!,
      }));
      return cloudOf(segments, everything, [0, 0, 0], 11).count;
    };
    expect(kept([0, 150, 600])).toBe(kept([0, 150, 300]) + 1);
  });
});

describe("the cloud cut for a zoom level, and around the view", () => {
  it("follows the curve at a closer zoom level than the relief level's, on its ground", () => {
    // A circuit of a kilometre across, a fix every 130 m
    const segments = flight(1, circle(25, 500));
    const { flights, curve } = curveOf(segments);
    const cut = (detail: number): Point[] =>
      pointsOf(cloudPoints(segments, flights, everything, 11, detail));
    // At the relief level's, merged into chords of 6 px of it (110 m)
    expect(cut(11).length).toBeLessThan(curve.length / 2);
    // At 15 every point of the curve, a pixel apart at most
    const close = cut(15);
    expect(close).toHaveLength(curve.length);
    for (const fix of curve) {
      const [x, y] = mercatorOf(fix);
      expect(offLine({ x, y }, close) * pixelsOf(15)).toBeLessThan(
        CLOUD_MERGE_PX + 1e-3,
      );
    }
    for (const point of close) {
      expect(point.ground).toBe(0);
      expect(point.lift).toBe(3000);
    }
  });

  it("keeps only the stretches in the box, on the line of all of them, with the heat there, and the exposure of all of them", () => {
    const fixes = line(61);
    const segments = flight(1, fixes);
    const { flights } = curveOf(segments);
    const all = cloudPoints(segments, flights, everything, 11);
    // Around the fixes 25 to 35
    const box = [fixes[25]![1], 46.9, fixes[35]![1], 47.1] as const;
    const boxed = cloudPoints(segments, flights, everything, 11, 11, box);
    const whole = pointsOf(all);
    const inBox = pointsOf(boxed);
    expect(inBox.length).toBeGreaterThan(1);
    expect(inBox.length).toBeLessThan(whole.length);
    // Across the box and no further than a step beyond it, on the line
    const [west] = mercatorOf([47, box[0]]);
    const [east] = mercatorOf([47, box[2]]);
    const step = (CLOUD_STEP_PX + CLOUD_MERGE_MAX_PX) / pixelsOf(11);
    expect(inBox[0]!.x).toBeLessThanOrEqual(west);
    expect(inBox[0]!.x).toBeGreaterThan(west - step);
    expect(inBox[inBox.length - 1]!.x).toBeGreaterThanOrEqual(east);
    expect(inBox[inBox.length - 1]!.x).toBeLessThan(east + step);
    for (const point of inBox) {
      expect(offLine(point, whole) * pixelsOf(11)).toBeLessThan(1e-3);
    }
    // The heat of every second flown between its ends
    const secondsAt = (x: number): number => {
      const k = whole.findIndex((p) => p.x >= x - 1e-12);
      const a = whole[k - 1]!;
      const b = whole[k]!;
      return a.time + ((x - a.x) / (b.x - a.x)) * (b.time - a.time);
    };
    const heat = inBox.reduce((sum, p) => sum + p.heat, 0);
    expect(heat).toBeCloseTo(
      secondsAt(inBox[inBox.length - 1]!.x) - secondsAt(inBox[0]!.x),
      1,
    );
    expect(boxed.busiest).toBe(all.busiest);
  });

  it("breaks the line where a flight leaves the box, and starts it again where it comes back", () => {
    // East through the box, far away, and back west through it
    const out = line(31);
    const back = line(31, 47.3).reverse();
    const segments = flight(1, [...out, ...back]);
    const { flights } = curveOf(segments);
    const box = [out[10]![1], 46.9, out[20]![1], 47.4] as const;
    const points = pointsOf(
      cloudPoints(segments, flights, everything, 11, 11, box),
    );
    // Each way through it ends in a point of no heat
    const ends = points.flatMap((p, k) => (p.heat === 0 ? [k] : []));
    expect(ends).toEqual([ends[0], points.length - 1]);
    const [, south] = mercatorOf([47, 11]);
    const [, north] = mercatorOf([47.3, 11]);
    points.forEach((point, k) => {
      expect(point.y).toBeCloseTo(k <= ends[0]! ? south : north, 9);
    });
  });

  it("keeps a step that crosses the box with neither end in it", () => {
    // Fixes two kilometres apart, and a box of a few hundred metres
    // between two of them, as close in at app zoom 17
    const fixes = line(4, 47, 11, 0.026);
    const segments = flight(1, fixes);
    const { flights } = curveOf(segments);
    const middle = (fixes[1]![1] + fixes[2]![1]) / 2;
    const box = [middle - 0.002, 46.998, middle + 0.002, 47.002] as const;
    const points = pointsOf(
      cloudPoints(segments, flights, everything, 11, 16, box),
    );
    expect(points).toHaveLength(2);
    expect(points[0]!.x).toBeLessThan(mercatorOf([47, box[0]])[0]);
    expect(points[1]!.x).toBeGreaterThan(mercatorOf([47, box[2]])[0]);
    expect(points[0]!.heat).toBeGreaterThan(0);
  });

  it("has the exposure of the relief level at every zoom level closer in, in a box or not", () => {
    const segments = [
      ...flight(1, circle(25, 500)),
      ...flight(2, line(61, 47.01)),
    ];
    const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    const at = (
      detail: number,
      box: readonly [number, number, number, number] | null = null,
    ) => cloudPoints(segments, flights, everything, 11, detail, box).busiest;
    const busiest = at(11);
    expect(busiest).toBeGreaterThan(0);
    for (const detail of [12, 14, 17]) expect(at(detail)).toBe(busiest);
    expect(at(15, [20, 20, 21, 21])).toBe(busiest);
  });

  it("keeps the exposure it is given, and cuts the flights in the box as it would without it", () => {
    const circuit = flight(1, circle(25, 500));
    const away = flight(2, line(61, 48));
    const segments = [...circuit, ...away];
    const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    // Around the circuit, not the cruise a degree north of it
    const box = [10.98, 46.98, 11.02, 47.02] as const;
    const cut = cloudPoints(segments, flights, everything, 11, 15, box);
    const given = cloudPoints(segments, flights, everything, 11, 15, box, 0.5);
    expect(given.busiest).toBe(0.5);
    expect(given.count).toBe(cut.count);
    expect(pointsOf(given)).toEqual(pointsOf(cut));
    expect(
      pointsOf(given).every(
        (p) => Math.abs(p.y - mercatorOf([47, 11])[1]) < 1e-4,
      ),
    ).toBe(true);
  });

  it("takes a flight across the antimeridian the short way, zoomed out and in, and in a box across it", () => {
    const fixes: Coordinate[] = Array.from({ length: 21 }, (_, i) => {
      const lng = 179.95 + i * 0.005;
      return [10, lng > 180 ? lng - 360 : lng];
    });
    const segments = flight(1, fixes);
    const { flights } = curveOf(segments);
    const steps = (points: Point[]): number[] =>
      points.slice(1).map((p, k) => Math.abs(p.x - points[k]!.x));
    for (const level of [4, 11, 15]) {
      const points = pointsOf(
        cloudPoints(segments, flights, everything, level),
      );
      expect(points.length).toBeGreaterThan(1);
      expect(Math.max(...steps(points))).toBeLessThan(0.2 / 360);
    }
    const east = pointsOf(
      cloudPoints(
        segments,
        flights,
        everything,
        15,
        15,
        [179.98, 9.9, 180.02, 10.1],
      ),
    );
    const west = pointsOf(
      cloudPoints(
        segments,
        flights,
        everything,
        15,
        15,
        [-180.02, 9.9, -179.98, 10.1],
      ),
    );
    expect(east.length).toBeGreaterThan(1);
    expect(west).toEqual(east);
    expect(Math.max(...steps(east))).toBeLessThan(0.2 / 360);
  });
});

/** The seconds each of `seconds` adds up to, from 0 */
function runningSum(seconds: number[]): number[] {
  let sum = 0;
  return [0, ...seconds.map((s) => (sum += s))];
}

/** The seconds of every segment by the clock replay all plays them by */
function clockSecondsOf(segments: PathSegment[]): number[] {
  return Array.from(flightClock(segments).spent);
}

describe("the time of the cloud's points", () => {
  it("is the seconds into its flight each was flown at, from 0 at the first fix", () => {
    const segments = byTurns(flight(1, line(4)), 1, 7);
    const points = pointsOf(cloudOf(segments, everything, [0, 0, 0], 11));
    expect(points.map((p) => p.time)).toEqual(
      runningSum(clockSecondsOf(segments)).map((s) => Math.fround(s)),
    );
  });

  it("is replay all's clock: a long step of the log counts in full, where the heat stops at two minutes", () => {
    const segments = flight(1, line(4), undefined, 300);
    const points = pointsOf(cloudOf(segments, everything, [0, 0, 0], 11));
    // The two logged steps in one stretch, and the last at its groundspeed
    expect(points.map((p) => p.time).slice(0, 2)).toEqual([0, 600]);
    expect(points[0]!.heat).toBe(240);
    const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    const times = chainTimes(flights, flightClock(segments), 0, 3);
    expect(points.map((p) => p.time)).toEqual(
      [flights.from[0]!, flights.to[1]!, flights.to[2]!].map((j) =>
        Math.fround(times[j]!),
      ),
    );
  });

  it("runs on across a gap in the log, and starts anew with the next flight", () => {
    const a = byTurns(flight(1, line(3, 47)));
    const b = byTurns(flight(1, line(3, 47.5)));
    const c = flight(2, [line(3, 47.5)[2]!, [47.6, 11]]);
    const segments = [...a, ...b, ...c];
    const points = pointsOf(
      cloudOf(segments, everything, new Array(segments.length).fill(0), 11),
    );
    const seconds = clockSecondsOf(segments);
    const times = points.map((p) => p.time);
    // The first path's two chains on one clock, the second chain from
    // where the first ended, and the second path on its own
    const run = runningSum(seconds.slice(0, 4)).map((t) => Math.fround(t));
    expect(times.slice(0, 6)).toEqual([
      run[0],
      run[1],
      run[2],
      run[2],
      run[3],
      run[4],
    ]);
    expect(times.slice(6)).toEqual([0, Math.fround(seconds[4]!)]);
  });

  it("is the same for a flight whatever else the filter keeps", () => {
    const segments = [
      ...flight(1, line(3, 47), undefined, 9),
      ...flight(2, line(3, 48)),
    ];
    const ground = new Array(segments.length).fill(0);
    const alone = pointsOf(cloudOf(segments, (id) => id === 1, ground, 11));
    const both = pointsOf(cloudOf(segments, everything, ground, 11));
    expect(alone.map((p) => p.time)).toEqual(
      both.slice(0, 3).map((p) => p.time),
    );
  });

  it("keeps running through the fixes merged at a level, to the whole flight's seconds at the last", () => {
    const fixes = line(21, 47, 11, 0.004);
    const segments = flight(1, fixes, undefined, 6);
    const points = pointsOf(
      cloudOf(segments, everything, new Array(20).fill(0), 4),
    );
    expect(points.length).toBeLessThan(21);
    const times = points.map((p) => p.time);
    expect(times[0]).toBe(0);
    for (let k = 1; k < times.length; k++) {
      // The time of a point is the one before and the seconds between them
      expect(times[k]).toBeCloseTo(times[k - 1]! + points[k - 1]!.heat, 3);
    }
    expect(times[times.length - 1]).toBeCloseTo(
      flightClock(segments).duration.get(1)!,
      3,
    );
  });

  it("is the log's own time where it has one, from chain to chain", () => {
    const a = flight(1, line(3, 47));
    // A fix on its own, logged at 10 s: a segment of no length
    const alone: PathSegment = {
      ...a[0]!,
      coords: [
        [47.5, 11],
        [47.5, 11],
      ],
      time: 10,
    };
    const b = flight(1, line(3, 48)).map((segment) => ({
      ...segment,
      time: segment.time! + 20,
    }));
    const segments = [...a, alone, ...b];
    const points = pointsOf(
      cloudOf(segments, everything, new Array(segments.length).fill(0), 11),
    );
    // Each chain a straight line, one stretch
    expect(points.map((p) => p.time).slice(0, 5)).toEqual([0, 10, 10, 20, 20]);
  });

  it("stands still over a stretch without times or speeds", () => {
    const segments = flight(1, line(3)).map((segment) => ({
      ...segment,
      time: undefined,
      groundspeed_knots: 0,
    }));
    const points = pointsOf(cloudOf(segments, everything, [0, 0], 11));
    expect(points.map((p) => p.time)).toEqual([0, 0]);
  });

  it("stays on the replay's clock however the heat is weighed", () => {
    // Slow enough for the distance to weigh it less
    const segments = flight(1, line(4), undefined, 60);
    const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    const cloud = (weigh = heatWeight): Point[] =>
      pointsOf(
        cloudPoints(
          segments,
          flights,
          everything,
          11,
          11,
          null,
          undefined,
          weigh,
        ),
      );
    const timed = cloud();
    const byRoute = cloud(byLength);
    expect(byRoute.map((p) => p.heat)).not.toEqual(timed.map((p) => p.heat));
    expect(byRoute.map((p) => p.time)).toEqual(timed.map((p) => p.time));
  });

  it("draws no stretch of segments of no heat, and a new one after it", () => {
    // A cruise, a taxi across, and a cruise again
    const segments = flight(1, line(6), undefined, 5);
    segments[2] = { ...segments[2]!, groundspeed_knots: 10 };
    segments[3] = { ...segments[3]!, groundspeed_knots: 10 };
    const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    const points = pointsOf(
      cloudPoints(
        segments,
        flights,
        everything,
        11,
        11,
        null,
        undefined,
        (segment, next) =>
          segment.groundspeed_knots < 30 ? 0 : heatWeight(segment, next),
      ),
    );

    // Two runs, each ending at a point of no heat, none over the taxi
    const ends = points.filter((p) => p.heat === 0);
    expect(ends).toHaveLength(2);
    const taxiStart = segments[2].coords[0];
    const taxiEnd = segments[3].coords[1];
    const [xs, xe] = [mercatorOf(taxiStart)[0], mercatorOf(taxiEnd)[0]];
    for (const point of points) {
      if (point.heat === 0) continue;
      const x = point.x;
      expect(x >= Math.min(xs, xe) - 1e-12 && x < Math.max(xs, xe) - 1e-9).toBe(
        false,
      );
    }
  });
});

describe("the busiest heat of the cloud", () => {
  /** 100 kt in metres per second, the groundspeed of flight() */
  const CRUISE_MS = (100 * 1852) / 3600;
  /** A cruise along the latitude 47 at 100 kt, a fix every 100 m */
  function cruise(path_id: number, count = 200, lat = 47): PathSegment[] {
    const stepDeg = 100 / (111320 * Math.cos(lat * DEGREES_TO_RADIANS));
    return flight(
      path_id,
      line(count, lat, 11, stepDeg),
      undefined,
      100 / CRUISE_MS,
    );
  }
  const busiest = (segments: PathSegment[], level = 11): number =>
    cloudOf(segments, everything, new Array(segments.length).fill(0), level)
      .busiest;

  it("is none without any heat", () => {
    expect(busiest([])).toBe(0);
    expect(
      cloudOf(cruise(1), () => false, new Array(199).fill(0), 11).busiest,
    ).toBe(0);
  });

  it("is about the seconds a cruise spends on a metre, over its cells", () => {
    const heat = busiest(cruise(1)) * CRUISE_MS;
    expect(heat).toBeGreaterThan(0.9);
    expect(heat).toBeLessThan(1.5);
  });

  it("adds up the flights that overlap, and the time a slower one spends", () => {
    const once = busiest(cruise(1));
    expect(busiest([...cruise(1), ...cruise(2)])).toBeCloseTo(2 * once, 9);
    const slow = cruise(1).map((segment) => ({
      ...segment,
      time: segment.time! * 2,
      groundspeed_knots: 50,
    }));
    expect(busiest(slow)).toBeCloseTo(2 * once, 9);
  });

  it("is as much over thousands of cells as over a few hundred", () => {
    // A thousand kilometres, some 3,400 cells at level 11
    const long = busiest(cruise(1, 10000));
    expect(long / busiest(cruise(1))).toBeCloseTo(1, 2);
  });

  it("is not set by the few busiest cells alone", () => {
    // Ten minutes on one spot, next to a long cruise
    const standing = flight(3, [
      [47.5, 11],
      [47.5, 11.00001],
    ]).map((segment) => ({ ...segment, groundspeed_knots: 0, time: 0 }));
    const next = { ...standing[0]!, time: 600 };
    const cruising = [
      ...cruise(1, 400),
      ...cruise(2, 400, 47.2),
      ...standing,
      { ...next, coords: [standing[0]!.coords[1], [47.5, 11.00002]] },
    ] as PathSegment[];
    const cruiseOnly = busiest([...cruise(1, 400), ...cruise(2, 400, 47.2)]);
    expect(busiest(cruising)).toBeCloseTo(cruiseOnly, 9);
  });

  it("is of cells as wide as the glow at the level, so a closer one tells the flights apart", () => {
    // Two cruises 400 m apart: one cell out at level 6, two at 11
    const stepDeg = 400 / 111320;
    const apart = [...cruise(1), ...cruise(2, 200, 47 + stepDeg)];
    const alone = cruise(1);
    expect(busiest(apart, 6) / busiest(alone, 6)).toBeCloseTo(2, 1);
    expect(busiest(apart, 11) / busiest(alone, 11)).toBeCloseTo(1, 1);
  });

  it("rolls the heat of the stretches off for the scale it is drawn at, and not the busiest", () => {
    const flights = Array.from({ length: 40 }, (_, i) => cruise(i + 1)).flat();
    const smoothed = smoothFlights(flights, (i) => flights[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    const heatOf = (cloud: CloudPoints): number =>
      pointsOf(cloud).reduce((sum, point) => sum + point.heat, 0);
    const plain = cloudPoints(flights, smoothed, everything, 11);
    const scales: number[] = [];
    const rolled = cloudPoints(
      flights,
      smoothed,
      everything,
      11,
      11,
      null,
      undefined,
      undefined,
      (busiest) => {
        scales.push(busiest);
        return 1;
      },
    );
    // Asked once, for the busiest heat it hands on as it is
    expect(scales).toEqual([plain.busiest]);
    expect(rolled.busiest).toBe(plain.busiest);
    // Forty cruises over the same cells, drawn as they are, are forty
    // flights' worth there, rolled off to what heatTone gives forty
    expect(plain.busiest * CRUISE_SPEED_MS).toBeGreaterThan(HEAT_KNEE);
    expect(heatOf(rolled) / heatOf(plain)).toBeCloseTo(heatTone(40) / 40, 2);
    // A lone cruise, under the knee, keeps its heat
    const one = cruise(1);
    const lone = smoothFlights(one, (i) => one[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    expect(
      heatOf(
        cloudPoints(
          one,
          lone,
          everything,
          11,
          11,
          null,
          undefined,
          undefined,
          () => 1,
        ),
      ),
    ).toBeCloseTo(heatOf(cloudPoints(one, lone, everything, 11)), 6);
  });
});

describe("the marks of the cloud's points", () => {
  const marksOf = (segments: PathSegment[], weigh = heatWeight): number[] => {
    const flights = smoothFlights(segments, (i) => segments[i]!.altitude_ft, {
      groundOf: () => 0,
    });
    return pointsOf(
      cloudPoints(
        segments,
        flights,
        everything,
        11,
        11,
        null,
        undefined,
        weigh,
      ),
    ).map((p) => p.marks);
  };

  it("are in full along a flight alone, the last point of it taking those of the stretch before", () => {
    const marks = marksOf(flight(1, line(8)));
    expect(marks.length).toBeGreaterThan(1);
    expect(marks).toEqual(new Array(marks.length).fill(1));
  });

  it("are none where the same track is flown out and back as much, wherever the stretches of either were merged", () => {
    const out = line(8);
    // The way back from half a step on, so no stretch of it starts or
    // ends where one of the way out does
    const back = line(8, 47, 11 + 0.0015).reverse();
    const marks = marksOf([...flight(1, out), ...flight(2, back)]);
    expect(marks).toEqual(new Array(marks.length).fill(0));
  });

  it("weigh the flights by their heat as the heatmap weighs it, and leave out what it leaves out", () => {
    const out = flight(1, line(8));
    // The way back taxied: twelve times the seconds of the way out
    const back = flight(2, line(8).reverse(), undefined, 60).map((segment) => ({
      ...segment,
      groundspeed_knots: 10,
    }));
    const count = (weigh: SegmentWeight): number[] =>
      marksOf([...out, ...back], weigh);
    const timed = count(heatWeight);
    // The slow way back is most of the time along the track: its marks
    // show, and not those of the way out
    expect(timed[0]).toBe(0);
    expect(timed.at(-1)).toBe(1);
    // Counted by the kilometre both ways are as much, and neither shows
    const routes = count(byLength);
    expect(routes).toEqual(new Array(routes.length).fill(0));
  });
});

describe("nthSmallest", () => {
  it("is the value at that place of the values sorted, with repeats and all", () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (const size of [1, 2, 3, 10, 101, 1000]) {
      for (const spread of [3, 1000]) {
        const values = Float64Array.from({ length: size }, () =>
          Math.floor(random() * spread),
        );
        const sorted = Float64Array.from(values).sort();
        const places = [0, size >> 1, Math.floor(0.99 * (size - 1)), size - 1];
        for (const n of places) {
          expect(nthSmallest(Float64Array.from(values), n)).toBe(sorted[n]);
        }
      }
    }
  });

  it("finds its value in values sorted either way, or all alike", () => {
    const up = Float64Array.from({ length: 50 }, (_, i) => i);
    expect(nthSmallest(up, 49)).toBe(49);
    const down = Float64Array.from({ length: 50 }, (_, i) => 50 - i);
    expect(nthSmallest(down, 0)).toBe(1);
    expect(nthSmallest(new Float64Array(20).fill(2), 13)).toBe(2);
  });
});
