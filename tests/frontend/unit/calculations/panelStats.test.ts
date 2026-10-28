/**
 * The figures of the statistics panel and of Wrapped (panelStats.ts). The
 * filters, distances and ranges they build on are in statistics.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import {
  collectAirports,
  calculateAltitudeStats,
  calculateSpeedStats,
  calculateLongestFlight,
  calculateFilteredStatistics,
  calculateTotalDistance,
  filterStatistics,
  filterStatisticsInSlices,
  landingTotals,
} from "../../../../flown/frontend/calculations/panelStats";
import { datasetIndex } from "../../../../flown/frontend/calculations/datasetIndex";
import {
  FEET_TO_METERS,
  METERS_TO_FEET,
} from "../../../../flown/frontend/utils/constants";
import type { PathInfo, PathSegment } from "../../../../flown/frontend/types";
import {
  MOCK_PATH_INFO,
  MOCK_SEGMENTS,
  createDataset,
  createSegment,
  segmentOf,
} from "../../testHelpers";

const FT = (meters: number): number => meters * METERS_TO_FEET;

describe("panel statistics", () => {
  /** The flights, with the heights of their segments */
  const mockPathInfo: PathInfo[] = MOCK_PATH_INFO.map((info, i) => ({
    ...info,
    ...[
      [1000, 1500, 500],
      [1200, 1200, 0],
      [2000, 2000, 0],
      [1800, 1800, 0],
    ].map(([low, high, gain]) => ({
      min_altitude_ft: FT(low!),
      max_altitude_ft: FT(high!),
      altitude_gain_ft: FT(gain!),
    }))[i],
  }));
  const mockSegments = MOCK_SEGMENTS;

  describe("collectAirports", () => {
    it("collects unique airports", () => {
      const airports = collectAirports(mockPathInfo);
      expect([...airports].sort()).toEqual(["EDAV", "EDDF", "EDDK", "EDDM"]);
    });

    it("handles paths without airports and partial airports", () => {
      expect(collectAirports([{ id: 1 }, { id: 2 }]).size).toBe(0);
      expect([...collectAirports([{ id: 1, start_airport: "EDAV" }])]).toEqual([
        "EDAV",
      ]);
      expect([...collectAirports([{ id: 1, end_airport: "EDDF" }])]).toEqual([
        "EDDF",
      ]);
    });

    it("deduplicates airports", () => {
      const airports = collectAirports([
        { id: 1, start_airport: "EDAV", end_airport: "EDDF" },
        { id: 2, start_airport: "EDAV", end_airport: "EDDF" },
      ]);
      expect(airports.size).toBe(2);
    });
  });

  describe("calculateAltitudeStats", () => {
    it("takes the range and the climb from the exact per-path values", () => {
      const stats = calculateAltitudeStats(mockSegments, mockPathInfo);

      expect(stats.min).toBeCloseTo(1000, 6);
      expect(stats.max).toBeCloseTo(2000, 6);
      expect(stats.gain).toBeCloseTo(500, 6);
    });

    it("returns zeros for empty segments", () => {
      expect(calculateAltitudeStats([], mockPathInfo)).toEqual({
        min: 0,
        max: 0,
        gain: 0,
      });
    });

    it("sums the exact gain of the paths that have a segment", () => {
      const stats = calculateAltitudeStats(
        [
          segmentOf({ path_id: 1, altitude_ft: 1000 }),
          segmentOf({ path_id: 1, altitude_ft: 3000 }),
          segmentOf({ path_id: 2, altitude_ft: 1000 }),
          segmentOf({ path_id: 2, altitude_ft: 2000 }),
        ],
        [
          {
            id: 1,
            min_altitude_ft: 990,
            max_altitude_ft: 3010,
            altitude_gain_ft: 2140.5,
          },
          {
            id: 2,
            min_altitude_ft: 980,
            max_altitude_ft: 2000,
            altitude_gain_ft: 1000,
          },
          // No segments here: not part of the sum
          {
            id: 3,
            min_altitude_ft: 0,
            max_altitude_ft: 50000,
            altitude_gain_ft: 50000,
          },
        ],
      );
      expect(stats.gain * METERS_TO_FEET).toBeCloseTo(3140.5, 6);
    });

    it("counts no climb of its own from the rounded segments (regression)", () => {
      // The exporter writes the gain of every path with an altitude, from
      // the unrounded altitudes (altitude_gain_m in Python). A second
      // estimate from the rounded steps here only ever disagreed with it.
      const segments: PathSegment[] = [1000, 3000, 2000, 3500].map(
        (altitude_ft) => segmentOf({ path_id: 1, altitude_ft }),
      );
      const exact = calculateAltitudeStats(segments, [
        {
          id: 1,
          min_altitude_ft: 1000,
          max_altitude_ft: 3500,
          altitude_gain_ft: 3400,
        },
      ]);
      expect(exact.gain * METERS_TO_FEET).toBeCloseTo(3400, 6);
      const withoutGain = calculateAltitudeStats(segments, [
        { id: 1, min_altitude_ft: 1000, max_altitude_ft: 3500 },
      ]);
      expect(withoutGain.gain).toBe(0);
    });

    it("sums the exact gain over the paths of the filter only", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: [
          {
            id: 1,
            year: 2024,
            min_altitude_ft: 1000,
            max_altitude_ft: 1000,
            altitude_gain_ft: 1500,
          },
          {
            id: 2,
            year: 2025,
            min_altitude_ft: 1000,
            max_altitude_ft: 1000,
            altitude_gain_ft: 4000,
          },
        ],
        segments: [
          createSegment({ path_id: 1, altitude_ft: 1000 }),
          createSegment({ path_id: 2, altitude_ft: 1000 }),
        ],
        year: "2025",
      });
      expect(stats.total_altitude_gain_ft).toBeCloseTo(4000, 6);
    });

    it("keeps negative altitudes", () => {
      const stats = calculateAltitudeStats(
        [
          segmentOf({ path_id: 1, altitude_ft: -400 }),
          segmentOf({ path_id: 1, altitude_ft: 100 }),
        ],
        [
          {
            id: 1,
            min_altitude_ft: FT(-420),
            max_altitude_ft: FT(100),
            altitude_gain_ft: FT(520),
          },
        ],
      );
      expect(stats.min).toBeCloseTo(-420, 6);
      expect(stats.gain).toBeCloseTo(520, 6);
    });

    it("replaces a rounded extreme with the exact one on either side (regression)", () => {
      // Rounding put the segments at 1,300 ft and -1,400 ft, past the exact
      // 1,291.1 ft and -1,379.4 ft; keeping the wider of the two drifted
      const stats = calculateAltitudeStats(
        [
          segmentOf({ path_id: 1, altitude_ft: -1400 }),
          segmentOf({ path_id: 1, altitude_ft: 1300 }),
        ],
        [{ id: 1, min_altitude_ft: -1379.4, max_altitude_ft: 1291.1 }],
      );
      expect(stats.max * METERS_TO_FEET).toBeCloseTo(1291.1, 6);
      expect(stats.min * METERS_TO_FEET).toBeCloseTo(-1379.4, 6);
    });

    it("uses the exact range only for paths that have segments", () => {
      const stats = calculateAltitudeStats(
        [
          segmentOf({ path_id: 1, altitude_ft: 3000 }),
          segmentOf({ path_id: 2, altitude_ft: 900 }),
        ],
        [
          { id: 1, min_altitude_ft: 2950, max_altitude_ft: 3040 },
          { id: 2, min_altitude_ft: 880, max_altitude_ft: 910 },
          { id: 3, min_altitude_ft: -500, max_altitude_ft: 41000 },
        ],
      );
      expect(stats.max * METERS_TO_FEET).toBeCloseTo(3040, 6);
      expect(stats.min * METERS_TO_FEET).toBeCloseTo(880, 6);
    });
  });

  describe("calculateSpeedStats", () => {
    it("calculates speed statistics", () => {
      const stats = calculateSpeedStats(mockSegments);

      expect(stats.max).toBe(140);
      expect(stats.avg).toBe(130); // (120+130+125+140+135)/5
    });

    it("returns zeros for empty segments", () => {
      expect(calculateSpeedStats([])).toEqual({ max: 0, avg: 0 });
    });

    it("filters out zero, negative and undefined speeds", () => {
      const segments: PathSegment[] = [
        segmentOf({ path_id: 1, groundspeed_knots: 0 }),
        segmentOf({ path_id: 1, groundspeed_knots: -10 }),
        segmentOf({ path_id: 1 }),
        segmentOf({ path_id: 1, groundspeed_knots: 100 }),
        segmentOf({ path_id: 1, groundspeed_knots: 200 }),
      ];
      expect(calculateSpeedStats(segments)).toEqual({ max: 200, avg: 150 });
    });
  });

  describe("calculateLongestFlight", () => {
    it("returns 0 for empty segments", () => {
      expect(calculateLongestFlight([])).toBe(0);
    });

    it("identifies the longest flight by summing its segments", () => {
      const segments: PathSegment[] = [
        segmentOf({
          path_id: 1,
          coords: [
            [50.0, 8.0],
            [50.1, 8.1],
          ],
        }),
        segmentOf({
          path_id: 2,
          coords: [
            [50.0, 8.0],
            [55.0, 13.0],
          ],
        }),
        segmentOf({
          path_id: 2,
          coords: [
            [55.0, 13.0],
            [55.5, 13.5],
          ],
        }),
      ];
      const path2 = calculateTotalDistance(segments.slice(1));
      expect(calculateLongestFlight(segments)).toBeCloseTo(path2, 6);
      expect(path2).toBeGreaterThan(100);
    });
  });

  describe("calculateFilteredStatistics", () => {
    it("calculates comprehensive statistics", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "all",
        aircraft: "all",
      });

      expect(stats.num_paths).toBe(4);
      expect(stats.num_airports).toBe(4);
      expect(stats.num_aircraft).toBe(2);
      expect(stats.total_distance_km).toBeGreaterThan(0);
      expect(stats.total_distance_nm).toBeCloseTo(
        stats.total_distance_km * 0.539957,
        2,
      );
      expect(stats.max_altitude_m).toBeCloseTo(2000, 6);
      expect(stats.max_altitude_ft).toBeCloseTo(FT(2000), 6);
      expect(stats.max_groundspeed_knots).toBe(140);
      expect(stats.avg_groundspeed_knots).toBe(130);
      expect(stats.total_flight_time_seconds).toBe(100);
      expect(stats.total_flight_time_str).toBe("0h 1m");
      // 5 segments plus the end point of each of the 4 paths they belong to
      expect(stats.total_points).toBe(9);
    });

    it("reports a sea-level flight at 0 ft and no altitude without data", () => {
      const atSeaLevel = calculateFilteredStatistics({
        pathInfo: [
          {
            id: 1,
            year: 2025,
            min_altitude_ft: 0,
            max_altitude_ft: 0,
            altitude_gain_ft: 0,
          },
        ],
        segments: [
          createSegment({ path_id: 1, altitude_ft: 0 }),
          createSegment({ path_id: 1, altitude_ft: 0 }),
        ],
      });
      expect(atSeaLevel.max_altitude_ft).toBe(0);
      expect(atSeaLevel.total_altitude_gain_ft).toBe(0);

      // A path without altitudes has none in its info, and 0 ft in its
      // segments, as at sea level
      const noAltitude = calculateFilteredStatistics({
        pathInfo: [{ id: 1, year: 2025 }],
        segments: [createSegment({ path_id: 1, altitude_ft: 0 })],
      });
      expect(noAltitude.max_altitude_ft).toBeUndefined();
      expect(noAltitude.total_altitude_gain_ft).toBeUndefined();
    });

    it("counts the track points behind the filtered segments", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: [
          { id: 1, year: 2025 },
          { id: 2, year: 2025 },
        ],
        segments: [
          segmentOf({ path_id: 1, altitude_ft: 1000, groundspeed_knots: 100 }),
          segmentOf({ path_id: 1, altitude_ft: 1000, groundspeed_knots: 100 }),
          segmentOf({ path_id: 2, altitude_ft: 1000, groundspeed_knots: 100 }),
        ],
      });
      // 3 segments plus one closing point for each of the 2 paths
      expect(stats.total_points).toBe(5);
    });

    it("applies year filter", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "2025",
        aircraft: "all",
      });

      expect(stats.num_paths).toBe(3);
      expect(stats.aircraft_list).toHaveLength(2);
    });

    it("adds each aircraft's flight time, a registration naming an object property too", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: [
          { id: 1, aircraft_registration: "constructor" },
          { id: 2, aircraft_registration: "constructor" },
          { id: 3, aircraft_registration: "D-EAGJ" },
        ],
        segments: [
          createSegment({ path_id: 1, time: 0 }),
          createSegment({ path_id: 1, time: 3600 }),
          createSegment({ path_id: 2, time: 100 }),
          createSegment({ path_id: 2, time: 1900 }),
          createSegment({ path_id: 3 }),
        ],
        year: "all",
        aircraft: "all",
      });

      const byRegistration = Object.fromEntries(
        stats.aircraft_list.map((a) => [
          a.registration,
          [a.flight_time_seconds, a.flight_time_str],
        ]),
      );
      expect(byRegistration).toEqual({
        constructor: [5400, "1h 30m"],
        "D-EAGJ": [0, undefined],
      });
    });

    it("applies aircraft filter", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "all",
        aircraft: "D-EAGJ",
      });

      expect(stats.num_paths).toBe(2);
      expect(stats.num_aircraft).toBe(1);
      expect(stats.aircraft_list[0]!.registration).toBe("D-EAGJ");
    });

    it("applies both filters", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "2025",
        aircraft: "D-EXYZ",
      });

      expect(stats.num_paths).toBe(1);
      expect(stats.num_aircraft).toBe(1);
    });

    it("uses pre-filtered paths and segments when provided", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "2023", // would match nothing
        preFiltered: {
          paths: [mockPathInfo[2]!],
          segments: [mockSegments[3]!],
        },
      });

      expect(stats.num_paths).toBe(1);
      expect(stats.max_groundspeed_knots).toBe(140);
    });

    it("returns empty stats when no paths match", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: mockSegments,
        year: "2023",
        aircraft: "all",
      });

      expect(stats).toEqual({
        total_points: 0,
        num_paths: 0,
        num_airports: 0,
        airport_names: [],
        num_aircraft: 0,
        aircraft_list: [],
        total_distance_nm: 0,
        total_distance_km: 0,
      });
    });

    it("handles missing pathInfo or segments", () => {
      const noPaths = calculateFilteredStatistics({
        pathInfo: null as unknown as PathInfo[],
        segments: mockSegments,
      });
      expect(noPaths.num_paths).toBe(0);

      const noSegments = calculateFilteredStatistics({
        pathInfo: mockPathInfo,
        segments: null as unknown as PathSegment[],
      });
      expect(noSegments.total_distance_km).toBe(0);
    });

    it("computes cruise speed and most common cruise altitude above 1000 ft AGL", () => {
      const segments: PathSegment[] = [
        // ground level 500 ft
        {
          path_id: 1,
          coords: [
            [50.0, 8.0],
            [50.01, 8.0],
          ],
          altitude_ft: 500,
          groundspeed_knots: 30,
          time: 0,
        },
        // 1400 ft AGL -> cruise
        {
          path_id: 1,
          coords: [
            [50.01, 8.0],
            [50.1, 8.0],
          ],
          altitude_ft: 1900,
          groundspeed_knots: 100,
          time: 100,
        },
        // 1450 ft AGL -> cruise, same 100 ft bucket
        {
          path_id: 1,
          coords: [
            [50.1, 8.0],
            [50.2, 8.0],
          ],
          altitude_ft: 1950,
          groundspeed_knots: 100,
          time: 200,
        },
      ];
      const stats = calculateFilteredStatistics({
        pathInfo: [{ id: 1 }],
        segments,
      });

      expect(stats.cruise_speed_knots).toBeCloseTo(100, 6);
      expect(stats.most_common_cruise_altitude_ft).toBe(1400);
      expect(stats.most_common_cruise_altitude_m).toBeCloseTo(
        1400 * FEET_TO_METERS,
        6,
      );
      // No terrain in the export: measured above the flight's own field
      expect(stats.cruise_height_above_terrain).toBe(false);
    });

    it("measures the cruise above the terrain the export carries (regression)", () => {
      // Along a valley at 1,500 ft MSL, then over a ridge at 4,000 ft: the
      // flight's lowest altitude put the ridge crossing 2,900 ft "AGL"
      const seg = (
        altitudeFt: number,
        groundFt: number,
        lat: number,
      ): PathSegment => ({
        path_id: 1,
        coords: [
          [lat, 8.0],
          [lat + 0.1, 8.0],
        ],
        altitude_ft: altitudeFt,
        groundspeed_knots: altitudeFt > 1500 ? 100 : 15,
        ground_ft: groundFt,
      });
      const stats = calculateFilteredStatistics({
        pathInfo: [{ id: 1 }],
        segments: [
          seg(1500, 1500, 50),
          seg(4400, 4000, 50.1),
          seg(4400, 4000, 50.2),
          seg(3000, 1500, 50.3),
        ],
      });

      // 400 ft above the ridge is no cruise; 1,500 ft above the valley is
      expect(stats.most_common_cruise_altitude_ft).toBe(1500);
      expect(stats.cruise_height_above_terrain).toBe(true);
    });

    it("says so when some flight had no terrain to measure from", () => {
      const seg = (pathId: number, lat: number, groundFt?: number) => ({
        path_id: pathId,
        coords: [
          [lat, 8.0],
          [lat + 0.1, 8.0],
        ] as PathSegment["coords"],
        altitude_ft: groundFt === undefined ? 3000 : 3000 + groundFt,
        groundspeed_knots: 100,
        ground_ft: groundFt,
      });
      const stats = calculateFilteredStatistics({
        pathInfo: [{ id: 1 }, { id: 2 }],
        segments: [
          seg(1, 50, 500),
          seg(1, 50.1, 500),
          createSegment({ path_id: 2, altitude_ft: 0, groundspeed_knots: 10 }),
          seg(2, 50.3),
        ],
      });

      expect(stats.most_common_cruise_altitude_ft).toBe(3000);
      expect(stats.cruise_height_above_terrain).toBe(false);
    });

    it("does not let a single altitude glitch turn the taxi into cruise (regression)", () => {
      const seg = (altitudeFt: number, index: number): PathSegment => ({
        path_id: 1,
        coords: [
          [50 + index * 0.001, 8.0],
          [50 + (index + 1) * 0.001, 8.0],
        ],
        altitude_ft: altitudeFt,
        groundspeed_knots: altitudeFt > 0 ? 110 : 15,
      });
      // Taxi at 0 ft, a one-sample glitch to -1,400 ft, cruise at 3,000 ft
      const segments = [
        ...Array.from({ length: 60 }, (_, i) => seg(0, i)),
        seg(-1400, 60),
        ...Array.from({ length: 60 }, (_, i) => seg(3000, 61 + i)),
      ];

      const stats = calculateFilteredStatistics({
        pathInfo: [{ id: 1 }],
        segments,
      });

      // Measured from the lowest sample the taxi at 15 kt was 1,400 ft AGL
      expect(stats.cruise_speed_knots).toBeCloseTo(110, 6);
      expect(stats.most_common_cruise_altitude_ft).toBe(3000);
    });

    it("resolves ties for the most common cruise altitude to the lowest bin", () => {
      const seg = (altitudeFt: number, lat: number): PathSegment => ({
        path_id: 1,
        coords: [
          [lat, 8.0],
          [lat + 0.1, 8.0],
        ],
        altitude_ft: altitudeFt,
        groundspeed_knots: 100,
      });
      const stats = calculateFilteredStatistics({
        pathInfo: [{ id: 1 }],
        segments: [seg(0, 50), seg(3000, 50.1), seg(2000, 50.2)],
      });

      expect(stats.most_common_cruise_altitude_ft).toBe(2000);
    });

    it("leaves cruise fields undefined without cruise segments", () => {
      const stats = calculateFilteredStatistics({
        pathInfo: [{ id: 1 }],
        segments: [
          {
            path_id: 1,
            coords: [
              [50.0, 8.0],
              [50.1, 8.0],
            ],
            altitude_ft: 500,
            groundspeed_knots: 100,
          },
        ],
      });

      expect(stats.cruise_speed_knots).toBeUndefined();
      expect(stats.most_common_cruise_altitude_ft).toBeUndefined();
      expect(stats.cruise_height_above_terrain).toBeUndefined();
      expect(stats.total_flight_time_str).toBeUndefined();
    });

    it("handles large datasets without stack overflow (10k segments)", () => {
      const largeSegments: PathSegment[] = [];
      const largePathInfo: PathInfo[] = [];

      for (let i = 0; i < 10000; i++) {
        largeSegments.push({
          path_id: Math.floor(i / 10),
          coords: [
            [50.0 + i * 0.001, 8.0 + i * 0.001],
            [50.1 + i * 0.001, 8.1 + i * 0.001],
          ],
          altitude_ft: 1000 + i,
          groundspeed_knots: 100 + (i % 50),
          time: 1000 + i * 10,
        });

        if (i % 10 === 0) {
          largePathInfo.push({
            id: Math.floor(i / 10),
            year: 2026,
            aircraft_registration: `D-TEST${i}`,
            start_airport: "EDDF",
            end_airport: "EDDM",
            min_altitude_ft: 1000 + i,
            max_altitude_ft: 1009 + i,
            altitude_gain_ft: 9,
          });
        }
      }

      const stats = calculateFilteredStatistics({
        pathInfo: largePathInfo,
        segments: largeSegments,
        year: "all",
        aircraft: "all",
      });
      expect(stats.num_paths).toBe(1000);
      expect(stats.total_distance_km).toBeGreaterThan(0);
      expect(stats.max_altitude_ft).toBeCloseTo(10999, 6);
      expect(stats.max_groundspeed_knots).toBe(149);
      expect(stats.total_flight_time_seconds).toBe(1000 * 90);
    });
  });

  describe("filterStatistics", () => {
    const data = createDataset(mockPathInfo, mockSegments);

    it("computes the statistics of the view's paths once", () => {
      const view = datasetIndex(data).filter("2025", "all");
      const stats = filterStatistics(view);
      expect(stats.num_paths).toBe(3);
      expect(filterStatistics(view)).toBe(stats);
    });

    it("matches the statistics of the same filter computed directly", () => {
      const view = datasetIndex(data).filter("all", "D-EAGJ");
      expect(filterStatistics(view)).toEqual(
        calculateFilteredStatistics({
          pathInfo: mockPathInfo,
          segments: mockSegments,
          aircraft: "D-EAGJ",
        }),
      );
    });
  });

  describe("filterStatisticsInSlices", () => {
    /** A clock that has run past a slice at every look */
    const slowClock = () => {
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => (now += 1000));
    };

    it("returns what one slice finishes as it is, and keeps it", () => {
      const view = datasetIndex(
        createDataset(mockPathInfo, mockSegments),
      ).filter("all", "all");

      const stats = filterStatisticsInSlices(view);

      expect(stats).not.toBeInstanceOf(Promise);
      expect(filterStatistics(view)).toBe(stats);
      expect(filterStatisticsInSlices(view)).toBe(stats);
    });

    it("works out a longer one over several tasks, to the same figures", async () => {
      const data = createDataset(mockPathInfo, mockSegments);
      const expected = filterStatistics(
        datasetIndex(createDataset(mockPathInfo, mockSegments)).filter(
          "all",
          "all",
        ),
      );
      const view = datasetIndex(data).filter("all", "all");
      slowClock();
      const timeout = vi.spyOn(globalThis, "setTimeout");

      const pending = filterStatisticsInSlices(view);

      expect(pending).toBeInstanceOf(Promise);
      // One run for the view, whoever asks
      expect(filterStatisticsInSlices(view)).toBe(pending);
      const stats = await pending;
      expect(stats).toEqual(expected);
      // A task between every two steps
      expect(timeout.mock.calls.length).toBeGreaterThan(5);
      expect(filterStatistics(view)).toBe(stats);
      expect(filterStatisticsInSlices(view)).toBe(stats);
    });

    it("stops a run its signal aborts, and keeps nothing of it", async () => {
      const view = datasetIndex(
        createDataset(mockPathInfo, mockSegments),
      ).filter("all", "all");
      slowClock();
      const controller = new AbortController();

      const pending = filterStatisticsInSlices(view, controller.signal);
      controller.abort();

      await expect(pending).rejects.toThrow();
      const timeout = vi.spyOn(globalThis, "setTimeout");
      await new Promise((resolve) => setImmediate(resolve));
      // No slice after the abort
      expect(timeout).not.toHaveBeenCalled();
      expect(filterStatisticsInSlices(view)).toBeInstanceOf(Promise);
    });

    it("starts a run of its own for a caller right after an abort", async () => {
      const view = datasetIndex(
        createDataset(mockPathInfo, mockSegments),
      ).filter("all", "all");
      slowClock();
      const controller = new AbortController();
      const aborted = filterStatisticsInSlices(view, controller.signal);
      controller.abort();

      const again = filterStatisticsInSlices(view);

      expect(again).not.toBe(aborted);
      await expect(aborted).rejects.toThrow();
      const stats = await again;
      expect(stats).toEqual(filterStatistics(view));
      expect(filterStatisticsInSlices(view)).toBe(stats);
    });

    it("goes on for a caller that joined a run another one leaves", async () => {
      const view = datasetIndex(
        createDataset(mockPathInfo, mockSegments),
      ).filter("all", "all");
      slowClock();
      const wrapped = new AbortController();
      const rail = new AbortController();
      const first = filterStatisticsInSlices(view, wrapped.signal);
      const second = filterStatisticsInSlices(view, rail.signal);

      // Wrapped closes while the statistics rail waits for the same view
      wrapped.abort();

      await expect(first).rejects.toThrow();
      const stats = await second;
      expect(stats).toEqual(filterStatistics(view));
      expect(filterStatisticsInSlices(view)).toBe(stats);
    });

    it("keeps the figures a synchronous caller worked out in between", async () => {
      const view = datasetIndex(
        createDataset(mockPathInfo, mockSegments),
      ).filter("all", "all");
      slowClock();

      const pending = filterStatisticsInSlices(view);
      const direct = filterStatistics(view);

      await expect(pending).resolves.toBe(direct);
    });
  });
});

describe("landingTotals", () => {
  const circuits: PathInfo = {
    id: 1,
    landings: 1,
    touch_and_goes: 3,
    go_arounds: 1,
    touchdowns: [
      ["EDAQ", "29"],
      ["EDAQ", "29"],
      ["EDAQ", "11"],
      ["EDAQ", null],
    ],
  };
  const trip: PathInfo = {
    id: 2,
    landings: 2,
    touch_and_goes: 0,
    go_arounds: 0,
    touchdowns: [
      ["EDDP", "26R"],
      ["EDAQ", "29"],
    ],
  };

  it("adds up the landings of the flights", () => {
    expect(landingTotals([circuits, trip, { id: 3 }])).toEqual({
      landings: 3,
      touchAndGoes: 3,
      goArounds: 1,
      mostTouchAndGoes: 3,
      // Three of the four touchdowns with a runway at EDAQ
      busiestRunway: { airport: "EDAQ", runway: "29", share: 0.75 },
    });
  });

  it("is undefined when no flight carries its landings", () => {
    expect(landingTotals([{ id: 3 }])).toBeUndefined();
    expect(landingTotals([])).toBeUndefined();
  });

  it("counts a flight without a touchdown, and names no runway", () => {
    const none: PathInfo = {
      id: 4,
      landings: 0,
      touch_and_goes: 0,
      go_arounds: 0,
      touchdowns: [],
    };

    expect(landingTotals([none])).toEqual({
      landings: 0,
      touchAndGoes: 0,
      goArounds: 0,
      mostTouchAndGoes: 0,
    });
  });

  it("is part of the statistics of a filter", () => {
    const stats = calculateFilteredStatistics({
      pathInfo: [
        { ...circuits, year: 2025 },
        { ...trip, year: 2024 },
      ],
      segments: [segmentOf({ path_id: 1 }), segmentOf({ path_id: 2 })],
      year: "2025",
    });

    expect(stats.landings?.landings).toBe(1);
    expect(stats.landings?.touchAndGoes).toBe(3);
  });
});
