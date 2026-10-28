import { describe, it, expect } from "vitest";
import {
  filterPaths,
  groundLevelsFt,
  aggregateAircraft,
  altitudeRangeFt,
  buildSegmentRanges,
  segmentRangesFor,
  segmentsForPathIds,
} from "../../../../flown/frontend/calculations/statistics";
// Tested here, on the same fixtures as the slices they are made of
import {
  calculateTotalDistance,
  filterSegmentsByPaths,
  perPathSeconds,
} from "../../../../flown/frontend/calculations/panelStats";
import type { PathInfo, PathSegment } from "../../../../flown/frontend/types";
import { MOCK_PATH_INFO, MOCK_SEGMENTS, segmentOf } from "../../testHelpers";

describe("statistics calculations", () => {
  const mockPathInfo = MOCK_PATH_INFO;
  const mockSegments = MOCK_SEGMENTS;

  describe("filterPaths", () => {
    it("returns all paths when no filters applied", () => {
      expect(filterPaths(mockPathInfo, "all", "all")).toHaveLength(4);
    });

    it("filters by year", () => {
      const result = filterPaths(mockPathInfo, "2025", "all");
      expect(result).toHaveLength(3);
      expect(result.every((p) => p.year === 2025)).toBe(true);
    });

    it("filters by aircraft", () => {
      const result = filterPaths(mockPathInfo, "all", "D-EAGJ");
      expect(result).toHaveLength(2);
      expect(result.every((p) => p.aircraft_registration === "D-EAGJ")).toBe(
        true,
      );
    });

    it("filters by both year and aircraft", () => {
      const result = filterPaths(mockPathInfo, "2025", "D-EXYZ");
      expect(result.map((p) => p.id)).toEqual([4]);
    });

    it("returns empty array when no matches", () => {
      expect(filterPaths(mockPathInfo, "2023", "all")).toHaveLength(0);
    });

    it("excludes paths with missing year or aircraft when filtering on them", () => {
      const paths: PathInfo[] = [
        { id: 1, aircraft_registration: "D-EAGJ" },
        { id: 2, year: 2025 },
        { id: 3, year: 2025, aircraft_registration: "D-EAGJ" },
      ];
      expect(filterPaths(paths, "2025", "all").map((p) => p.id)).toEqual([
        2, 3,
      ]);
      expect(filterPaths(paths, "all", "D-EAGJ").map((p) => p.id)).toEqual([
        1, 3,
      ]);
    });
  });

  describe("aggregateAircraft", () => {
    it("aggregates aircraft with flight counts", () => {
      const aircraft = aggregateAircraft(mockPathInfo);
      expect(aircraft).toHaveLength(2);

      const eagj = aircraft.find((a) => a.registration === "D-EAGJ")!;
      expect(eagj.flights).toBe(2);
      expect(eagj.type).toBe("DA40");

      const exyz = aircraft.find((a) => a.registration === "D-EXYZ")!;
      expect(exyz.flights).toBe(2);
      expect(exyz.type).toBe("C172");
    });

    it("sorts by flight count descending", () => {
      const aircraft = aggregateAircraft([
        { id: 1, aircraft_registration: "A", aircraft_type: "T1" },
        { id: 2, aircraft_registration: "B", aircraft_type: "T2" },
        { id: 3, aircraft_registration: "B", aircraft_type: "T2" },
        { id: 4, aircraft_registration: "B", aircraft_type: "T2" },
      ]);

      expect(aircraft.map((a) => [a.registration, a.flights])).toEqual([
        ["B", 3],
        ["A", 1],
      ]);
    });

    it("takes the type from a later path when the first has none", () => {
      const aircraft = aggregateAircraft([
        { id: 1, aircraft_registration: "D-EAGJ" },
        { id: 2, aircraft_registration: "D-EAGJ", aircraft_type: "DA40" },
        { id: 3, aircraft_registration: "D-EAGJ", aircraft_type: "DA42" },
      ]);

      expect(aircraft).toHaveLength(1);
      expect(aircraft[0]!.type).toBe("DA40");
      expect(aircraft[0]!.flights).toBe(3);
    });

    it("handles paths without aircraft and empty input", () => {
      expect(aggregateAircraft([{ id: 1 }, { id: 2 }])).toHaveLength(0);
      expect(aggregateAircraft([])).toHaveLength(0);
    });

    it("takes a registration that names an object property as data (regression)", () => {
      const aircraft = aggregateAircraft([
        {
          id: 1,
          aircraft_registration: "constructor",
          aircraft_type: "C172",
        },
        { id: 2, aircraft_registration: "__proto__", aircraft_type: "PA28" },
        { id: 3, aircraft_registration: "__proto__", aircraft_type: "PA28" },
      ]);

      expect(aircraft.map((a) => [a.registration, a.type, a.flights])).toEqual([
        ["__proto__", "PA28", 2],
        ["constructor", "C172", 1],
      ]);
      // Nothing was written into the prototype of every object
      expect(({} as Record<string, unknown>)["flights"]).toBeUndefined();
    });
  });

  describe("filterSegmentsByPaths", () => {
    it("filters segments by path IDs", () => {
      const pathInfo = mockPathInfo.filter((p) => p.year === 2025);
      const result = filterSegmentsByPaths(mockSegments, pathInfo);

      expect(result).toHaveLength(4); // paths 1, 2, 4
      expect(result.every((s) => [1, 2, 4].includes(s.path_id))).toBe(true);
    });

    it("returns empty array when no paths match", () => {
      expect(filterSegmentsByPaths(mockSegments, [])).toHaveLength(0);
    });

    it("returns all segments when all paths match", () => {
      expect(filterSegmentsByPaths(mockSegments, mockPathInfo)).toHaveLength(5);
    });
  });

  describe("calculateTotalDistance", () => {
    it("calculates total distance from segments", () => {
      const distance = calculateTotalDistance(mockSegments);
      // Berlin-Frankfurt (~427 km) x2 plus Munich-Cologne (~455 km) x2 plus ~13 km
      expect(distance).toBeGreaterThan(1700);
      expect(distance).toBeLessThan(1800);
    });

    it("returns 0 for empty segments", () => {
      expect(calculateTotalDistance([])).toBe(0);
    });

    it("ignores segments without or with malformed coords", () => {
      const good = segmentOf({
        path_id: 2,
        coords: [
          [50.0, 8.0],
          [51.0, 9.0],
        ],
      });
      const expected = calculateTotalDistance([good]);
      const segments: PathSegment[] = [
        segmentOf({ path_id: 1, altitude_ft: 1000 }),
        segmentOf({
          path_id: 1,
          coords: [[50.0, 8.0]] as unknown as PathSegment["coords"],
        }),
        good,
      ];
      expect(calculateTotalDistance(segments)).toBe(expected);
      expect(expected).toBeGreaterThan(0);
    });
  });

  describe("altitudeRangeFt", () => {
    it("takes the exact range of every path that has a segment", () => {
      const range = altitudeRangeFt(
        [
          segmentOf({ path_id: 1, altitude_ft: -1400 }),
          segmentOf({ path_id: 1, altitude_ft: 1300 }),
          segmentOf({ path_id: 2, altitude_ft: 3000 }),
        ],
        [
          { id: 1, min_altitude_ft: -1379.4, max_altitude_ft: 1291.1 },
          { id: 2, min_altitude_ft: 2950, max_altitude_ft: 3040 },
          // No segment here: not part of the range
          { id: 3, min_altitude_ft: -500, max_altitude_ft: 41000 },
        ],
      );
      expect(range).toEqual({ min: -1379.4, max: 3040 });
    });

    it("has no rounded fallback for a path without an exact range (regression)", () => {
      // The exporter writes the range of every path with an altitude, so
      // the segments of a path without one add nothing
      expect(
        altitudeRangeFt(
          [
            segmentOf({ path_id: 1, altitude_ft: 900 }),
            segmentOf({ path_id: 2, altitude_ft: 3000 }),
          ],
          [{ id: 1 }, { id: 2, min_altitude_ft: 2950, max_altitude_ft: 3040 }],
        ),
      ).toEqual({ min: 2950, max: 3040 });
      expect(
        altitudeRangeFt(
          [segmentOf({ path_id: 1, altitude_ft: 900 })],
          [{ id: 1 }],
        ),
      ).toBeNull();
    });

    it("is null without segments", () => {
      expect(
        altitudeRangeFt(
          [],
          [{ id: 1, min_altitude_ft: 1, max_altitude_ft: 2 }],
        ),
      ).toBeNull();
    });
  });

  describe("groundLevelsFt", () => {
    it("takes the first percentile of each path's altitudes", () => {
      // 200 samples: index floor(199 * 0.01) = 1, the second lowest
      const segments: PathSegment[] = [
        segmentOf({ path_id: 1, altitude_ft: -1400 }),
        ...Array.from({ length: 150 }, () =>
          segmentOf({ path_id: 1, altitude_ft: 3000 }),
        ),
        ...Array.from({ length: 49 }, () =>
          segmentOf({ path_id: 1, altitude_ft: 0 }),
        ),
        segmentOf({ path_id: 2, altitude_ft: 500 }),
        segmentOf({ path_id: 2, altitude_ft: 400 }),
      ];

      expect(groundLevelsFt(segments)).toEqual(
        new Map([
          [1, 0],
          // Fewer than a hundred samples: the lowest one
          [2, 400],
        ]),
      );
    });

    it("joins the samples of a path that comes back later", () => {
      const levels = groundLevelsFt([
        segmentOf({ path_id: 1, altitude_ft: 900 }),
        segmentOf({ path_id: 2, altitude_ft: 100 }),
        segmentOf({ path_id: 1, altitude_ft: 700 }),
      ]);
      expect(levels.get(1)).toBe(700);
    });
  });

  describe("segment index", () => {
    const grouped: PathSegment[] = [
      segmentOf({ path_id: 1, time: 0 }),
      segmentOf({ path_id: 1, time: 10 }),
      segmentOf({ path_id: 2, time: 0 }),
      segmentOf({ path_id: 3, time: 0 }),
      segmentOf({ path_id: 3, time: 5 }),
      segmentOf({ path_id: 3, time: 9 }),
    ];

    it("locates every path as a slice of a grouped array", () => {
      expect(buildSegmentRanges(grouped)).toEqual(
        new Map([
          [1, [0, 2]],
          [2, [2, 3]],
          [3, [3, 6]],
        ]),
      );
      expect(buildSegmentRanges([])).toEqual(new Map());
    });

    it("refuses an array where a path comes back after another one", () => {
      expect(
        buildSegmentRanges([
          segmentOf({ path_id: 1 }),
          segmentOf({ path_id: 2 }),
          segmentOf({ path_id: 1 }),
        ]),
      ).toBeNull();
    });

    it("builds the index once per array", () => {
      const first = segmentRangesFor(grouped);
      expect(segmentRangesFor(grouped)).toBe(first);
      expect(segmentRangesFor([...grouped])).not.toBe(first);
    });

    it("returns the segments of the given paths in array order", () => {
      const result = segmentsForPathIds(grouped, [3, 1]);

      expect(result).toEqual([
        grouped[0],
        grouped[1],
        grouped[3],
        grouped[4],
        grouped[5],
      ]);
      expect(segmentsForPathIds(grouped, new Set([2]))).toEqual([grouped[2]]);
      expect(segmentsForPathIds(grouped, [99])).toEqual([]);
      expect(segmentsForPathIds(grouped, [])).toEqual([]);
    });

    it("falls back to a filter for an array that is not grouped", () => {
      const interleaved: PathSegment[] = [
        segmentOf({ path_id: 1, time: 0 }),
        segmentOf({ path_id: 2, time: 0 }),
        segmentOf({ path_id: 1, time: 10 }),
      ];

      expect(segmentsForPathIds(interleaved, [1])).toEqual([
        interleaved[0],
        interleaved[2],
      ]);
      expect(filterSegmentsByPaths(interleaved, [{ id: 2 }])).toEqual([
        interleaved[1],
      ]);
    });
  });

  describe("perPathSeconds", () => {
    it("measures each path from its first to its last timestamp", () => {
      const seconds = perPathSeconds([
        segmentOf({ path_id: 1, time: 30 }),
        segmentOf({ path_id: 1, time: 0 }),
        segmentOf({ path_id: 1, time: 90 }),
        segmentOf({ path_id: 2, time: 5 }),
        segmentOf({ path_id: 3 }),
      ]);

      expect(seconds).toEqual(
        new Map([
          [1, 90],
          [2, 0],
        ]),
      );
    });

    it("restricts the paths when a set is given", () => {
      const seconds = perPathSeconds(
        [
          segmentOf({ path_id: 1, time: 0 }),
          segmentOf({ path_id: 1, time: 60 }),
          segmentOf({ path_id: 2, time: 0 }),
          segmentOf({ path_id: 2, time: 10 }),
        ],
        new Set([2]),
      );

      expect(seconds).toEqual(new Map([[2, 10]]));
    });
  });
});
