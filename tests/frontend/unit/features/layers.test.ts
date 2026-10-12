import { describe, it, expect } from "vitest";
import {
  calculateAltitudeRange,
  calculateAirspeedRange,
  calculateSegmentProperties,
  formatAltitudeLabel,
  formatAirspeedLabel,
  findNearestSegment,
  rangeMiddle,
  rankValues,
  RANK_STEPS,
  selectRanks,
  DEFAULT_ALTITUDE_RANGE,
  DEFAULT_AIRSPEED_RANGE,
} from "../../../../flown/frontend/features/layers";
import type { PathSegment } from "../../../../flown/frontend/types";
import { scalePosition } from "../../../../flown/frontend/utils/colors";
import { segmentOf } from "../../testHelpers";

describe("layers feature", () => {
  const mockSegments: PathSegment[] = [
    segmentOf({ path_id: 1, altitude_ft: 5000, groundspeed_knots: 120 }),
    segmentOf({ path_id: 1, altitude_ft: 7000, groundspeed_knots: 130 }),
    segmentOf({ path_id: 2, altitude_ft: 3000, groundspeed_knots: 100 }),
    segmentOf({ path_id: 2, altitude_ft: 9000, groundspeed_knots: 150 }),
  ];

  /** The exact ranges path_info carries for the paths of mockSegments */
  const mockPaths = [
    { id: 1, min_altitude_ft: 5000, max_altitude_ft: 7000 },
    { id: 2, min_altitude_ft: 3000, max_altitude_ft: 9000 },
  ];

  describe("calculateAltitudeRange", () => {
    it("calculates range from the paths of the given segments", () => {
      expect(
        calculateAltitudeRange(mockSegments, DEFAULT_ALTITUDE_RANGE, mockPaths),
      ).toMatchObject({ min: 3000, max: 9000 });
      expect(
        calculateAltitudeRange(
          mockSegments.slice(0, 2),
          DEFAULT_ALTITUDE_RANGE,
          mockPaths,
        ),
      ).toMatchObject({ min: 5000, max: 7000 });
    });

    it("returns default range for empty segments", () => {
      expect(
        calculateAltitudeRange([], DEFAULT_ALTITUDE_RANGE, mockPaths),
      ).toEqual(DEFAULT_ALTITUDE_RANGE);
    });

    it("returns the given fallback when no path has an altitude", () => {
      expect(
        calculateAltitudeRange(
          [segmentOf({ path_id: 1 })],
          { min: 1, max: 2 },
          [{ id: 1 }],
        ),
      ).toMatchObject({ min: 1, max: 2 });
    });

    it("clamps the lower bound of the colour scale at 0 for negative altitudes", () => {
      const segments = [
        segmentOf({ path_id: 1, altitude_ft: -400 }),
        segmentOf({ path_id: 1, altitude_ft: 3000 }),
      ];
      expect(
        calculateAltitudeRange(segments, DEFAULT_ALTITUDE_RANGE, [
          { id: 1, min_altitude_ft: -420, max_altitude_ft: 3000 },
        ]),
      ).toMatchObject({ min: 0, max: 3000 });
      expect(
        calculateAltitudeRange(segments, DEFAULT_ALTITUDE_RANGE, [
          { id: 1, min_altitude_ft: -420, max_altitude_ft: -100 },
        ]),
      ).toMatchObject({ min: 0, max: 0 });
    });
  });

  describe("calculateAltitudeRange ranks", () => {
    it("reads the same ranks as a sort of every altitude would", () => {
      // Only the values the ramp reads are put in their place (selectRanks)
      let seed = 7;
      const random = (): number => (seed = (seed * 16807) % 2147483647);
      const altitudes = Array.from({ length: 5000 }, () => random() % 12000);
      const segments = altitudes.map((altitude_ft) =>
        segmentOf({ path_id: 1, altitude_ft }),
      );
      const sorted = Float64Array.from(altitudes).sort();

      const range = calculateAltitudeRange(segments, DEFAULT_ALTITUDE_RANGE, [
        { id: 1, min_altitude_ft: sorted[0]!, max_altitude_ft: sorted.at(-1)! },
      ]);

      expect(range.ranks).toEqual(
        rankValues(sorted, sorted[0]!, sorted.at(-1)!),
      );
    });

    it("are worked out once read, and the range once per array and paths", () => {
      const segments = mockSegments.map((segment) => ({ ...segment }));
      let reads = 0;
      const altitudes = segments.map((segment) => segment.altitude_ft);
      segments.forEach((segment, i) =>
        Object.defineProperty(segment, "altitude_ft", {
          get: () => (reads++, altitudes[i]),
        }),
      );

      const range = calculateAltitudeRange(
        segments,
        DEFAULT_ALTITUDE_RANGE,
        mockPaths,
      );

      // The ends come from the paths; the altitudes wait for the ranks
      expect(range).toMatchObject({ min: 3000, max: 9000 });
      expect(reads).toBe(0);
      expect(range.ranks).toHaveLength(RANK_STEPS + 1);
      expect(range.ranks).toBe(range.ranks);
      expect(reads).toBe(segments.length);
      expect(
        calculateAltitudeRange(segments, DEFAULT_ALTITUDE_RANGE, mockPaths),
      ).toBe(range);
      // Other paths for the same segments are another range
      expect(
        calculateAltitudeRange(segments, DEFAULT_ALTITUDE_RANGE, [
          ...mockPaths,
        ]),
      ).not.toBe(range);
    });
  });

  describe("calculateAltitudeRange with exact path ranges", () => {
    it("widens the rounded segment range to the exact per-path values", () => {
      // Segments carry 20 ft steps; path_info carries what was measured
      const range = calculateAltitudeRange(
        [segmentOf({ path_id: 1, altitude_ft: 10400 })],
        { min: 0, max: 10000 },
        [{ id: 1, min_altitude_ft: 343.7, max_altitude_ft: 10419.2 }],
      );
      expect(range.max).toBe(10419.2);
      expect(range.min).toBe(343.7);
    });

    it("prefers the exact value when rounding went past it (regression)", () => {
      // 1,291.1 ft rounds up to a 1,300 ft segment; the legend used to keep
      // the larger of the two and read 1,300 ft
      const range = calculateAltitudeRange(
        [
          segmentOf({ path_id: 1, altitude_ft: 300 }),
          segmentOf({ path_id: 1, altitude_ft: 1300 }),
        ],
        DEFAULT_ALTITUDE_RANGE,
        [{ id: 1, min_altitude_ft: 312.4, max_altitude_ft: 1291.1 }],
      );
      expect(range).toMatchObject({ min: 312.4, max: 1291.1 });
    });

    it("never falls back to the rounded extremes of the segments", () => {
      // Every exported path with an altitude carries its exact range (the
      // export contract), so a path without one has no altitude to add
      const range = calculateAltitudeRange(
        [
          segmentOf({ path_id: 1, altitude_ft: 1300 }),
          segmentOf({ path_id: 2, altitude_ft: 2000 }),
          segmentOf({ path_id: 2, altitude_ft: 500 }),
        ],
        DEFAULT_ALTITUDE_RANGE,
        [{ id: 1, min_altitude_ft: 1250, max_altitude_ft: 1291.1 }, { id: 2 }],
      );
      expect(range).toMatchObject({ min: 1250, max: 1291.1 });
    });

    it("only lets paths that are in the range widen it", () => {
      // Path 2 has an exact altitude far above anything drawn, but none of
      // its segments are in the set, so it must not stretch the legend
      const range = calculateAltitudeRange(
        [segmentOf({ path_id: 1, altitude_ft: 3000 })],
        { min: 0, max: 10000 },
        [
          { id: 1, min_altitude_ft: 2950, max_altitude_ft: 3050 },
          { id: 2, min_altitude_ft: 2950, max_altitude_ft: 41000 },
        ],
      );
      expect(range.max).toBe(3050);
    });

    it("returns the fallback untouched when no segment matches", () => {
      // Widening the fallback with real altitudes would report a range that
      // is half invented: a real minimum against a made-up maximum
      const fallback = { min: 0, max: 10000 };
      const range = calculateAltitudeRange([], fallback, [
        { id: 1, min_altitude_ft: 500, max_altitude_ft: 900 },
      ]);
      expect(range).toMatchObject(fallback);
    });
  });

  describe("rankValues", () => {
    it("takes the values at evenly spaced ranks, from the lowest to the highest", () => {
      const sorted = Array.from({ length: 321 }, (_, i) => i * 10);
      const ranks = rankValues(sorted, 0, 3200);
      expect(ranks).toHaveLength(RANK_STEPS + 1);
      expect(ranks[0]).toBe(0);
      expect(ranks[16]).toBe(1600);
      expect(ranks[RANK_STEPS]).toBe(3200);
    });

    it("holds them within the ends of the range, which they start and end on", () => {
      // Below 0 ft the altitude scale clamps; a rounded sample past the
      // exact end of a path stays at it
      const ranks = rankValues([-1400, 100, 200, 5100], 0, 5000);
      expect(ranks[0]).toBe(0);
      expect(ranks[RANK_STEPS]).toBe(5000);
      expect(Math.min(...ranks)).toBe(0);
      expect(Math.max(...ranks)).toBe(5000);
      ranks.forEach((rank, i) => {
        if (i > 0) expect(rank).toBeGreaterThanOrEqual(ranks[i - 1]!);
      });
    });
  });

  describe("the altitude scale", () => {
    it("puts the median altitude in the middle of the ramp (regression)", () => {
      // Three quarters of the flying below 3,700 ft of a scale to 10,400:
      // evenly over the altitudes, all of it in the bottom third
      const altitudes = [
        ...Array.from({ length: 500 }, (_, i) => 400 + (i % 20) * 100),
        ...Array.from({ length: 250 }, (_, i) => 2400 + (i % 14) * 100),
        ...Array.from({ length: 250 }, (_, i) => 3800 + (i % 67) * 100),
      ];
      const range = calculateAltitudeRange(
        altitudes.map((altitude_ft) => segmentOf({ path_id: 1, altitude_ft })),
        DEFAULT_ALTITUDE_RANGE,
        [{ id: 1, min_altitude_ft: 380, max_altitude_ft: 10419 }],
      );
      const at = (feet: number): number =>
        scalePosition(feet, range.min, range.max, range.ranks);

      expect(range).toMatchObject({ min: 380, max: 10419 });
      expect(at(380)).toBe(0);
      expect(at(10419)).toBe(1);
      expect(at(rangeMiddle(range))).toBeCloseTo(0.5, 1);
      expect(at(3700)).toBeGreaterThan(0.7);
      expect(rangeMiddle(range)).toBeLessThan(2500);
    });

    it("runs evenly between the ends of a range without ranks", () => {
      expect(rangeMiddle({ min: 0, max: 10000 })).toBe(5000);
    });
  });

  describe("calculateAirspeedRange", () => {
    it("calculates range from the given segments", () => {
      expect(calculateAirspeedRange(mockSegments)).toMatchObject({
        min: 100,
        max: 150,
      });
      expect(calculateAirspeedRange(mockSegments.slice(0, 2))).toMatchObject({
        min: 120,
        max: 130,
      });
    });

    it("returns default range for empty segments", () => {
      expect(calculateAirspeedRange([])).toEqual(DEFAULT_AIRSPEED_RANGE);
      expect(calculateAirspeedRange([], { min: 1, max: 2 })).toMatchObject({
        min: 1,
        max: 2,
      });
    });

    it("filters out zero, negative and missing speeds", () => {
      const segments: PathSegment[] = [
        segmentOf({ path_id: 1, groundspeed_knots: 0 }),
        segmentOf({ path_id: 1, groundspeed_knots: -5 }),
        segmentOf({ path_id: 1 }),
        segmentOf({ path_id: 1, groundspeed_knots: 80 }),
      ];
      expect(calculateAirspeedRange(segments)).toMatchObject({
        min: 80,
        max: 80,
      });
    });

    it("spans the 5th to the 95th percentile of the speeds", () => {
      // A few taxi crawls and one fast descent stretched the scale so far
      // that most of the flying fell into a handful of its steps
      const speeds = [
        ...Array.from({ length: 5 }, () => 5),
        ...Array.from({ length: 91 }, (_, i) => 90 + i * 0.5),
        ...Array.from({ length: 5 }, () => 250),
      ];
      const segments: PathSegment[] = speeds.map((groundspeed_knots) =>
        segmentOf({ path_id: 1, groundspeed_knots }),
      );

      expect(calculateAirspeedRange(segments)).toMatchObject({
        min: 90,
        max: 135,
      });
    });

    it("spreads the colours of taxiing and cruise by rank (regression)", () => {
      // A fifth of the flying taxis at 5 to 15 kt, the rest cruises at 95
      // to 110: evenly over the speeds, all of the cruise took the top
      // sixth of the ramp and the taxiing its bottom tenth
      const speeds = [
        ...Array.from({ length: 200 }, (_, i) => 5 + (i % 11)),
        ...Array.from({ length: 800 }, (_, i) => 95 + (i % 16)),
      ];
      const range = calculateAirspeedRange(
        speeds.map((groundspeed_knots) =>
          segmentOf({ path_id: 1, groundspeed_knots }),
        ),
      );
      const at = (speed: number): number =>
        scalePosition(speed, range.min, range.max, range.ranks);

      expect(range.ranks).toHaveLength(RANK_STEPS + 1);
      // The cruise takes three quarters of the ramp, as of the flying
      expect(at(110) - at(95)).toBeGreaterThan(0.7);
      expect(at(95)).toBeGreaterThan(0.1);
      expect(at(95)).toBeLessThan(0.25);
      // The median is in the middle
      expect(at(rangeMiddle(range))).toBeCloseTo(0.5, 1);
    });

    it("keeps the full range when the middle has no spread", () => {
      const segments: PathSegment[] = [
        segmentOf({ path_id: 1, groundspeed_knots: 20 }),
        ...Array.from({ length: 98 }, () =>
          segmentOf({ path_id: 1, groundspeed_knots: 100 }),
        ),
        segmentOf({ path_id: 1, groundspeed_knots: 160 }),
      ];

      expect(calculateAirspeedRange(segments)).toMatchObject({
        min: 20,
        max: 160,
      });
    });
  });

  describe("selectRanks", () => {
    /** A deterministic stream of numbers from 0 to 1 */
    const random = (seed: number) => () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };

    it("puts the values a sort would at the ranks asked for, ties and all", () => {
      const next = random(7);
      for (const length of [1, 5, 63, 64, 65, 1000, 20000]) {
        // Many equal values, as the speeds of a cruise are
        const values = Float64Array.from({ length }, () =>
          next() < 0.5 ? Math.round(next() * 10) : next() * 200,
        );
        const sorted = Float64Array.from(values).sort();
        const ks = [
          ...new Set([
            0,
            length - 1,
            ...[0.05, 0.5, 0.95].map((share) =>
              Math.round(share * (length - 1)),
            ),
          ]),
        ].sort((a, b) => a - b);

        selectRanks(values, ks);

        for (const k of ks) expect(values[k]).toBe(sorted[k]);
      }
    });

    it("gives the groundspeed range a full sort of the speeds gives", () => {
      const next = random(11);
      const segments = Array.from({ length: 5000 }, () =>
        segmentOf({
          path_id: 1,
          groundspeed_knots:
            next() < 0.3 ? Math.round(next() * 15) : 80 + next() * 40,
        }),
      );
      const speeds = Float64Array.from(
        segments
          .map((segment) => segment.groundspeed_knots)
          .filter((v) => v > 0),
      ).sort();
      const last = speeds.length - 1;
      const min = speeds[Math.floor(0.05 * last)]!;
      const max = speeds[Math.ceil(0.95 * last)]!;

      expect(calculateAirspeedRange(segments)).toEqual({
        min,
        max,
        ranks: rankValues(speeds, min, max, 0.05, 0.95),
      });
    });
  });

  describe("calculateSegmentProperties", () => {
    const colorFunction = (value: number, min: number, max: number): string =>
      `rgb(${value},${min},${max})`;

    it("styles a selected segment", () => {
      expect(
        calculateSegmentProperties({
          pathId: 1,
          selectedPathIds: new Set([1]),
          colorFunction,
          colorMin: 0,
          colorMax: 10,
          value: 5,
        }),
      ).toEqual({
        weight: 6,
        opacity: 1.0,
        color: "rgb(5,0,10)",
        isSelected: true,
      });
    });

    it("dims an unselected segment while a selection exists", () => {
      const props = calculateSegmentProperties({
        pathId: 2,
        selectedPathIds: new Set([1]),
      });
      expect(props.weight).toBe(4);
      expect(props.opacity).toBe(0.1);
      expect(props.isSelected).toBe(false);
    });

    it("uses normal styling without a selection", () => {
      const props = calculateSegmentProperties({ pathId: 1 });
      expect(props).toEqual({
        weight: 4,
        opacity: 0.85,
        color: "#3388ff",
        isSelected: false,
      });
    });

    it("draws selected paths at normal weight in share mode", () => {
      const props = calculateSegmentProperties({
        pathId: 1,
        selectedPathIds: new Set([1]),
        isolateSelection: true,
      });
      expect(props.weight).toBe(4);
      expect(props.opacity).toBe(0.85);
      expect(props.isSelected).toBe(true);
    });
  });

  describe("legend labels", () => {
    it("formats altitude with meters", () => {
      // The second unit on a line of its own (see styles.css)
      expect(formatAltitudeLabel(1000)).toBe("1,000 ft\n(305 m)");
      expect(formatAltitudeLabel(1234.6)).toBe("1,235 ft\n(376 m)");
      expect(formatAltitudeLabel(0)).toBe("0 ft\n(0 m)");
    });

    it("formats airspeed with km/h", () => {
      expect(formatAirspeedLabel(100)).toBe("100 kt\n(185 km/h)");
      expect(formatAirspeedLabel(123.4)).toBe("123 kt\n(229 km/h)");
      expect(formatAirspeedLabel(0)).toBe("0 kt\n(0 km/h)");
    });
  });

  describe("findNearestSegment", () => {
    const segments: PathSegment[] = [
      segmentOf({
        path_id: 1,
        coords: [
          [50.0, 8.0],
          [50.1, 8.0],
        ],
      }),
      segmentOf({
        path_id: 1,
        coords: [
          [50.1, 8.0],
          [50.2, 8.0],
        ],
      }),
      segmentOf({
        path_id: 1,
        coords: [
          [50.2, 8.0],
          [50.2, 8.5],
        ],
      }),
    ];

    it("returns the segment closest to the point", () => {
      expect(findNearestSegment(segments, 50.05, 8.01)).toBe(segments[0]);
      expect(findNearestSegment(segments, 50.15, 8.01)).toBe(segments[1]);
      expect(findNearestSegment(segments, 50.21, 8.3)).toBe(segments[2]);
    });

    it("measures distance to the segment, not only its end points", () => {
      // Point exactly beside the middle of the last (east-west) segment
      expect(findNearestSegment(segments, 50.19, 8.25)).toBe(segments[2]);
    });

    it("returns undefined for an empty list", () => {
      expect(findNearestSegment([], 50, 8)).toBeUndefined();
    });

    it("measures a segment across the antimeridian the short way round", () => {
      // Measured as a line round the whole world, a point on it near 180
      // was nearer the end of the segment after it
      const along = (from: number, to: number): PathSegment =>
        segmentOf({
          path_id: 1,
          coords: [
            [-17, from],
            [-17, to],
          ],
        });
      const run = [
        along(179.5, 179.9),
        along(179.9, -179.9),
        along(-179.9, -179.5),
      ];

      for (const lng of [-179.95, 179.95, 180.05, -539.95]) {
        expect(findNearestSegment(run, -17, lng)).toBe(run[1]);
      }
      expect(findNearestSegment(run, -17, -179.7)).toBe(run[2]);
      expect(findNearestSegment(run, -17, 179.7)).toBe(run[0]);
    });

    it("handles zero-length segments", () => {
      const point: PathSegment = {
        path_id: 1,
        altitude_ft: 0,
        groundspeed_knots: 0,
        coords: [
          [50.0, 8.0],
          [50.0, 8.0],
        ],
      };
      expect(findNearestSegment([point], 50.0, 8.0)).toBe(point);
    });
  });
});
