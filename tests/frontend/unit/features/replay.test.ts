import { describe, it, expect } from "vitest";
import {
  legAt,
  liftReplayCurve,
  prepareReplaySegments,
  replayCurve,
  replayPoint,
} from "../../../../flown/frontend/features/replay";
import { calculateBearing } from "../../../../flown/frontend/utils/geometry";
import type { PathSegment } from "../../../../flown/frontend/types";
import { segmentOf } from "../../testHelpers";

describe("replay feature", () => {
  const mockSegments: PathSegment[] = [
    {
      path_id: 1,
      time: 1000,
      coords: [
        [50.0, 8.0],
        [50.1, 8.1],
      ],
      altitude_ft: 5000,
      groundspeed_knots: 120,
    },
    {
      path_id: 1,
      time: 1100,
      coords: [
        [50.1, 8.1],
        [50.2, 8.2],
      ],
      altitude_ft: 6000,
      groundspeed_knots: 130,
    },
    {
      path_id: 1,
      time: 1200,
      coords: [
        [50.2, 8.2],
        [50.3, 8.3],
      ],
      altitude_ft: 7000,
      groundspeed_knots: 140,
    },
    {
      path_id: 2,
      time: 2000,
      coords: [
        [51.0, 9.0],
        [51.1, 9.1],
      ],
      altitude_ft: 4000,
      groundspeed_knots: 110,
    },
  ];

  describe("prepareReplaySegments", () => {
    it("filters and sorts segments by path ID", () => {
      const prepared = prepareReplaySegments(mockSegments, 1);

      expect(prepared).toHaveLength(3);
      expect(prepared.every((s) => s.path_id === 1)).toBe(true);
    });

    it("sorts segments by time", () => {
      const unsorted: PathSegment[] = [
        segmentOf({ path_id: 1, time: 1200 }),
        segmentOf({ path_id: 1, time: 1000 }),
        segmentOf({ path_id: 1, time: 1100 }),
      ];

      const prepared = prepareReplaySegments(unsorted, 1);

      expect(prepared.map((s) => s.time)).toEqual([1000, 1100, 1200]);
    });

    it("filters out segments without time", () => {
      const segments: PathSegment[] = [
        segmentOf({ path_id: 1, time: 1000 }),
        segmentOf({ path_id: 1, time: undefined }),
        segmentOf({ path_id: 1 }),
        segmentOf({ path_id: 1, time: 1100 }),
      ];

      const prepared = prepareReplaySegments(segments, 1);

      expect(prepared).toHaveLength(2);
    });

    it("returns empty array for non-existent path ID", () => {
      const prepared = prepareReplaySegments(mockSegments, 999);

      expect(prepared).toHaveLength(0);
    });
  });

  describe("replayCurve and replayPoint", () => {
    /** Segments of one path through `points`, `seconds` apart */
    function flight(
      points: [number, number][],
      seconds: number[],
    ): PathSegment[] {
      let time = 0;
      return points.slice(1).map((end, i) => {
        const segment: PathSegment = {
          path_id: 1,
          time,
          coords: [points[i]!, end],
          altitude_ft: 0,
          groundspeed_knots: 0,
        };
        time += seconds[i] ?? 0;
        return segment;
      });
    }

    /** Metres between two `[lat, lng]` points */
    function metres(a: [number, number], b: [number, number]): number {
      return Math.hypot(
        (b[1] - a[1]) * 111320 * Math.cos((a[0] * Math.PI) / 180),
        (b[0] - a[0]) * 111320,
      );
    }

    /** A right-hand turn of 90 degrees in six fixes, and straight after */
    const turn: [number, number][] = [
      [50, 8],
      [50.002, 8],
      [50.0038, 8.0012],
      [50.0048, 8.0032],
      [50.005, 8.0055],
      [50.005, 8.008],
      [50.005, 8.011],
    ];

    it("puts the airplane on its fixes at their times, and nowhere else", () => {
      const segments = flight(turn, [2, 2, 2, 2, 2, 2]);
      const curve = replayCurve(segments, () => 0);

      segments.forEach((segment, i) => {
        expect(replayPoint(curve, i, 0)!.position).toEqual(segment.coords[0]);
        // The end of one segment is the start of the next
        const end = replayPoint(curve, i, 1)!.position;
        expect(end[0]).toBeCloseTo(segment.coords[1][0], 12);
        expect(end[1]).toBeCloseTo(segment.coords[1][1], 12);
      });
    });

    it("ends the last segment after the time its length takes, at its own speed or the one before", () => {
      const segments = flight(turn, [2, 2, 2, 2, 2, 2]);
      const last = segments.length - 1;
      const start = (curve: { times: Float64Array }) => curve.times[last]!;
      const length = metres(turn[last]!, turn[last + 1]!);
      // On the whole second after it, a step of the timeline's slider
      const endsAfter = (curve: ReturnType<typeof replayCurve>, s: number) => {
        expect(Number.isInteger(curve.end)).toBe(true);
        expect(curve.end - start(curve)).toBeGreaterThanOrEqual(s);
        expect(curve.end - start(curve)).toBeLessThan(s + 1);
      };

      // No speed logged: as fast as the 0.0025 degrees before it in 2 s
      endsAfter(
        replayCurve(segments, () => 0),
        2.4,
      );

      // At its logged speed, and flown, not jumped to its end
      segments[last]!.groundspeed_knots = 20;
      const logged = replayCurve(segments, () => 0);
      endsAfter(logged, length / ((20 * 1852) / 3600));
      const halfway = replayPoint(logged, last, 0.5)!.position[1];
      expect(halfway).toBeGreaterThan(8.0085);
      expect(halfway).toBeLessThan(8.0105);

      // A crawl holds the replay for two minutes at most
      segments[last]!.groundspeed_knots = 1;
      const crawl = replayCurve(segments, () => 0);
      expect(crawl.end - start(crawl)).toBe(120);
    });

    it("puts several flights on one clock, each timed as it is alone", () => {
      const one = flight(turn, [2, 3, 2, 2, 4, 2]);
      // A second flight back the other way, logged from 0 as every flight
      const two = flight([...turn].reverse(), [3, 2, 2, 5, 2, 2]).map(
        (segment) => ({ ...segment, path_id: 2 }),
      );
      const alone = [one, two].map((segments) =>
        replayCurve(segments, () => 0),
      );
      const curve = replayCurve(
        [...one, ...two],
        () => 0,
        undefined,
        undefined,
        60,
      );

      // The first from its own first fix, the second where the first has
      // landed and a minute has passed
      expect(curve.legs).toEqual([
        { first: 0, end: 6, start: 0, finish: alone[0]!.end },
        {
          first: 6,
          end: 12,
          start: alone[0]!.end + 60,
          finish: alone[0]!.end + 60 + alone[1]!.end,
        },
      ]);
      expect(curve.end).toBe(curve.legs[1]!.finish);
      // Each with its own smoothed times, its slopes and the time of its
      // last segment, which waits for no next one
      for (let i = 0; i < 6; i++) {
        expect(curve.times[i]).toBeCloseTo(alone[0]!.times[i]!, 9);
        expect(curve.times[6 + i]).toBeCloseTo(
          curve.legs[1]!.start + alone[1]!.times[i]!,
          9,
        );
        expect(curve.startSlope[6 + i]).toBeCloseTo(
          alone[1]!.startSlope[i]!,
          9,
        );
        expect(curve.endSlope[i]).toBeCloseTo(alone[0]!.endSlope[i]!, 9);
      }
      expect(curve.spent[5]).toBe(alone[0]!.spent[5]);
      expect(curve.times[5]! + curve.spent[5]!).toBe(curve.legs[0]!.finish);
      // A curve of each, never one from the landing to the next start
      expect(curve.chainOf[5]).not.toBe(curve.chainOf[6]);
    });

    it("tells which flight the clock is on, the one that landed through the pause after it", () => {
      const legs = [
        { first: 0, end: 3, start: 0, finish: 100 },
        { first: 3, end: 5, start: 160, finish: 300 },
        { first: 5, end: 9, start: 360, finish: 400 },
      ];

      expect(legAt(legs, -1)).toBe(0);
      expect(legAt(legs, 0)).toBe(0);
      expect(legAt(legs, 130)).toBe(0);
      expect(legAt(legs, 160)).toBe(1);
      expect(legAt(legs, 359)).toBe(1);
      expect(legAt(legs, 400)).toBe(2);
      expect(legAt([], 10)).toBe(0);
    });

    it("changes speed smoothly across a fix, where each segment had its own", () => {
      // 10 m/s, then 30 m/s: moved evenly along each, the airplane tripled
      // its speed at the fix
      const segments = flight(
        [
          [50, 8],
          [50.0009, 8],
          [50.0036, 8],
          [50.0045, 8],
        ],
        [10, 10, 10],
      );
      const curve = replayCurve(segments, () => 0);
      const at = (index: number, fraction: number): [number, number] =>
        replayPoint(curve, index, fraction)!.position;
      // The segments' times as the replay has smoothed them
      const first = curve.times[1]! - curve.times[0]!;
      const second = curve.times[2]! - curve.times[1]!;
      // Metres per second over a thousandth of a segment on either side
      const before = metres(at(0, 0.998), at(0, 0.999)) / (0.001 * first);
      const across =
        metres(at(0, 0.999), at(1, 0.001)) / (0.001 * (first + second));
      const after = metres(at(1, 0.001), at(1, 0.002)) / (0.001 * second);

      expect(across / before).toBeGreaterThan(0.99);
      expect(across / before).toBeLessThan(1.01);
      expect(after / across).toBeGreaterThan(0.99);
      expect(after / across).toBeLessThan(1.01);
      // Between the two segments' own speeds
      expect(across).toBeGreaterThan(metres(at(0, 0), at(0, 1)) / first);
      expect(across).toBeLessThan(metres(at(1, 0), at(1, 1)) / second);
      // Faster on the segment that is flown faster, and never backwards
      let last = 0;
      for (let k = 0; k <= 100; k++) {
        const flown = metres([50, 8], at(1, k / 100));
        expect(flown).toBeGreaterThanOrEqual(last);
        last = flown;
      }
    });

    it("evens out logged times that disagree with the distance flown", () => {
      // 100 m every 5 s, but every third fix logged 2 s early
      const points = Array.from({ length: 13 }, (_, i): [number, number] => [
        50 + i * 0.0009,
        8,
      ]);
      const logged = points.map((_, i) => i * 5 - (i % 3 === 1 ? 2 : 0));
      const segments = flight(
        points,
        logged.slice(1).map((time, i) => time - logged[i]!),
      );

      const { times } = replayCurve(segments, () => 0);

      // The first and the last as they were, the others in order
      expect(times[0]).toBe(0);
      expect(times[11]).toBe(logged[11]);
      const steps = [...times].slice(1).map((time, i) => time - times[i]!);
      for (const step of steps) expect(step).toBeGreaterThan(0);
      // Logged, the segments took 3, 7 and 5 s by turns; smoothed, all of
      // them within a second of the 5 they took
      for (const step of steps.slice(1, -1)) {
        expect(Math.abs(step - 5)).toBeLessThan(1);
      }
    });

    it("turns the track evenly through a turn, along the curve", () => {
      const segments = flight(turn, [2, 2, 2, 2, 2, 2]);
      const curve = replayCurve(segments, () => 0);

      let previous: number | null = null;
      let largest = 0;
      for (let i = 0; i < segments.length; i++) {
        for (let k = 0; k < 100; k++) {
          const { track } = replayPoint(curve, i, k / 100)!;
          if (previous !== null) {
            const change = Math.abs(((track! - previous + 540) % 360) - 180);
            largest = Math.max(largest, change);
          }
          previous = track;
        }
      }
      // A turn of 90 degrees in 12 s, sampled every 0.02 s
      expect(largest).toBeLessThan(1);
      // North into the turn and east out of it, give or take the curve
      const off = (track: number | null, from: number): number =>
        Math.abs(((track! - from + 540) % 360) - 180);
      expect(off(replayPoint(curve, 0, 0)!.track, 0)).toBeLessThan(2);
      expect(off(replayPoint(curve, 5, 1)!.track, 90)).toBeLessThan(2);
    });

    it("heads the way the curve goes, not towards a fix further on", () => {
      const segments = flight(turn, [2, 2, 2, 2, 2, 2]);
      const curve = replayCurve(segments, () => 0);

      for (let i = 0; i < segments.length; i++) {
        for (const fraction of [0.2, 0.5, 0.8]) {
          const here = replayPoint(curve, i, fraction)!;
          const ahead = replayPoint(curve, i, fraction + 0.01)!.position;
          const moving =
            (Math.atan2(
              (ahead[1] - here.position[1]) *
                Math.cos((here.position[0] * Math.PI) / 180),
              ahead[0] - here.position[0],
            ) *
              180) /
            Math.PI;
          const off = Math.abs(((here.track! - moving + 540) % 360) - 180);
          expect(off).toBeLessThan(2.5);
        }
      }
    });

    it("has no track where the flight stands", () => {
      const standing = flight(
        [
          [50, 8],
          [50, 8],
          [50, 8],
        ],
        [5, 5],
      );

      expect(
        replayPoint(
          replayCurve(standing, () => 0),
          0,
          0.5,
        ),
      ).toMatchObject({ position: [50, 8], track: null });
    });

    it("gives the height of the curve where the airplane is", () => {
      const climb = flight(turn.slice(0, 3), [2, 2]);
      const curve = replayCurve(climb, (i) => (i + 1) * 100);

      expect(replayPoint(curve, 0, 0)!.heightFt).toBe(100);
      expect(replayPoint(curve, 1, 1)!.heightFt).toBe(200);
      const middle = replayPoint(curve, 1, 0.5)!.heightFt;
      expect(middle).toBeGreaterThan(100);
      expect(middle).toBeLessThan(200);
    });

    it("stands the curve on another ground and keeps its times", () => {
      // Uneven times, which the curve smooths
      const segments = flight(turn, [2, 1, 3, 1, 2, 4]);
      const altitude = (): number => 3000;
      const line = (): number => 500;
      const relief = (i: number): number => 500 + 400 * (i % 2);
      const curve = replayCurve(segments, altitude, line);
      expect([...curve.times]).not.toEqual(segments.map((s) => s.time));
      // The replay goes on with the smoothed times (see replayManager.ts)
      const replayed = segments.map((segment, i) => ({
        ...segment,
        time: curve.times[i]!,
      }));

      const lifted = liftReplayCurve(curve, replayed, altitude, relief);

      // When the airplane is where stays as it was: the smoothed times are
      // not smoothed again
      expect(lifted.times).toBe(curve.times);
      expect(lifted.along).toBe(curve.along);
      expect(lifted.startSlope).toBe(curve.startSlope);
      expect(lifted.endSlope).toBe(curve.endSlope);
      expect(lifted.chains.map((c) => c.points)).toEqual(
        curve.chains.map((c) => c.points),
      );
      // The heights are the ones over the new ground
      const fresh = replayCurve(segments, altitude, relief);
      expect(lifted.chains.map((c) => c.heights)).toEqual(
        fresh.chains.map((c) => c.heights),
      );
      expect(lifted.chains[0]!.heights).not.toEqual(curve.chains[0]!.heights);
      // And the times of the fresh curve, from the logged ones, agree
      expect([...fresh.times]).toEqual([...curve.times]);
    });

    it("carries the ground of the levels around along the curve, to where the airplane is", () => {
      const segments = flight(turn, [2, 1, 3, 1, 2, 4]);
      const offsets = [Float64Array.from(segments, (_, i) => i * 10)];

      const curve = replayCurve(
        segments,
        () => 3000,
        () => 500,
        offsets,
      );
      const lifted = liftReplayCurve(
        curve,
        segments,
        () => 3000,
        () => 500,
        offsets,
      );

      // A segment's offset is the one under its end, as its ground is
      expect(replayPoint(curve, 1, 1)!.offsetsFt).toEqual([10]);
      const middle = replayPoint(curve, 2, 0.5)!.offsetsFt![0]!;
      expect(middle).toBeGreaterThan(10);
      expect(middle).toBeLessThan(20);
      expect(replayPoint(lifted, 2, 0.5)!.offsetsFt).toEqual([middle]);
      // Without them the airplane has none
      expect(
        replayPoint(
          replayCurve(segments, () => 3000),
          2,
          0.5,
        )!.offsetsFt,
      ).toBeUndefined();
    });
  });

  describe("calculateBearing", () => {
    it("calculates bearing for due north", () => {
      expect(calculateBearing(0, 0, 1, 0)).toBeCloseTo(0, 1);
    });

    it("calculates bearing for due east", () => {
      expect(calculateBearing(0, 0, 0, 1)).toBeCloseTo(90, 1);
    });

    it("calculates bearing for due south", () => {
      expect(calculateBearing(0, 0, -1, 0)).toBeCloseTo(180, 1);
    });

    it("calculates bearing for due west", () => {
      expect(calculateBearing(0, 0, 0, -1)).toBeCloseTo(270, 1);
    });

    it("returns value between 0 and 360", () => {
      const bearing = calculateBearing(50, 8, 51, 9);
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    });
  });
});
