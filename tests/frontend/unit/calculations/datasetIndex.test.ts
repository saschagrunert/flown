import { describe, it, expect } from "vitest";
import {
  DatasetIndex,
  FilterView,
  datasetIndex,
  shownSelection,
} from "../../../../flown/frontend/calculations/datasetIndex";
import type {
  KMLDataset,
  PathInfo,
  PathSegment,
} from "../../../../flown/frontend/types";
import { createDataset, createSegment } from "../../testHelpers";

const pathInfo: PathInfo[] = [
  {
    id: 1,
    year: 2025,
    aircraft_registration: "D-EAGJ",
    aircraft_type: "DA40",
    start_airport: "EDAV",
    end_airport: "EDDF",
  },
  {
    id: 2,
    year: 2025,
    aircraft_registration: "D-EAGJ",
    aircraft_type: "DA40",
    start_airport: "EDDF",
    end_airport: "EDAV",
  },
  {
    id: 3,
    year: 2024,
    aircraft_registration: "D-EXYZ",
    aircraft_type: "C172",
    start_airport: "EDDM",
    end_airport: "EDDK",
  },
  {
    id: 4,
    year: 2025,
    aircraft_registration: "D-EXYZ",
    aircraft_type: "C172",
    start_airport: "EDDK",
    end_airport: "EDDM",
  },
];

const segments: PathSegment[] = [
  createSegment({ path_id: 1, altitude_ft: 3000, groundspeed_knots: 120 }),
  createSegment({ path_id: 1, altitude_ft: 3500, groundspeed_knots: 130 }),
  createSegment({ path_id: 2, altitude_ft: 3200, groundspeed_knots: 125 }),
  createSegment({ path_id: 3, altitude_ft: 4000, groundspeed_knots: 140 }),
  createSegment({ path_id: 4, altitude_ft: 3800, groundspeed_knots: 135 }),
];

function makeDataset(): KMLDataset {
  return createDataset(pathInfo, segments);
}

describe("datasetIndex", () => {
  it("returns the same index for the same dataset object", () => {
    const data = makeDataset();
    const a = datasetIndex(data);
    const b = datasetIndex(data);
    expect(a).toBe(b);
  });

  it("returns different indexes for different dataset objects", () => {
    const a = datasetIndex(makeDataset());
    const b = datasetIndex(makeDataset());
    expect(a).not.toBe(b);
  });
});

describe("DatasetIndex", () => {
  describe("pathInfoById", () => {
    it("maps every path by its id", () => {
      const index = new DatasetIndex(makeDataset());
      const map = index.pathInfoById;

      expect(map.size).toBe(4);
      expect(map.get(1)?.aircraft_registration).toBe("D-EAGJ");
      expect(map.get(3)?.aircraft_registration).toBe("D-EXYZ");
    });

    it("returns the same map on repeated access", () => {
      const index = new DatasetIndex(makeDataset());
      expect(index.pathInfoById).toBe(index.pathInfoById);
    });

    it("returns an empty map for an empty dataset", () => {
      const index = new DatasetIndex(createDataset());
      expect(index.pathInfoById.size).toBe(0);
    });
  });

  describe("filter", () => {
    it("returns a FilterView for a year/aircraft combination", () => {
      const index = new DatasetIndex(makeDataset());
      const view = index.filter("all", "all");
      expect(view).toBeInstanceOf(FilterView);
    });

    it("caches the view for the same filter", () => {
      const index = new DatasetIndex(makeDataset());
      const a = index.filter("2025", "all");
      const b = index.filter("2025", "all");
      expect(a).toBe(b);
    });

    it("returns different views for different filters", () => {
      const index = new DatasetIndex(makeDataset());
      const a = index.filter("2025", "all");
      const b = index.filter("2024", "all");
      const c = index.filter("2025", "D-EAGJ");
      expect(a).not.toBe(b);
      expect(a).not.toBe(c);
    });
  });
});

describe("FilterView", () => {
  describe("paths and pathIds", () => {
    it("keeps all paths with 'all' filters", () => {
      const view = new DatasetIndex(makeDataset()).filter("all", "all");
      expect(view.paths).toHaveLength(4);
      expect(view.pathIds.size).toBe(4);
      expect(view.keepsAll).toBe(true);
    });

    it("filters by year", () => {
      const view = new DatasetIndex(makeDataset()).filter("2025", "all");
      expect(view.paths).toHaveLength(3);
      expect(view.pathIds).toEqual(new Set([1, 2, 4]));
      expect(view.keepsAll).toBe(false);
    });

    it("filters by aircraft", () => {
      const view = new DatasetIndex(makeDataset()).filter("all", "D-EAGJ");
      expect(view.paths).toHaveLength(2);
      expect(view.pathIds).toEqual(new Set([1, 2]));
      expect(view.keepsAll).toBe(false);
    });

    it("filters by both year and aircraft", () => {
      const view = new DatasetIndex(makeDataset()).filter("2025", "D-EXYZ");
      expect(view.paths).toHaveLength(1);
      expect(view.pathIds).toEqual(new Set([4]));
    });

    it("returns empty for no matches", () => {
      const view = new DatasetIndex(makeDataset()).filter("2023", "all");
      expect(view.paths).toHaveLength(0);
      expect(view.pathIds.size).toBe(0);
      expect(view.keepsAll).toBe(false);
    });
  });

  describe("airportCounts", () => {
    it("counts flights per airport", () => {
      const view = new DatasetIndex(makeDataset()).filter("all", "all");
      const counts = view.airportCounts();
      expect(counts["EDAV"]).toBe(2);
      expect(counts["EDDF"]).toBe(2);
      expect(counts["EDDM"]).toBe(2);
      expect(counts["EDDK"]).toBe(2);
    });

    it("caches the result", () => {
      const view = new DatasetIndex(makeDataset()).filter("all", "all");
      expect(view.airportCounts()).toBe(view.airportCounts());
    });

    it("respects the filter", () => {
      const view = new DatasetIndex(makeDataset()).filter("2025", "D-EAGJ");
      const counts = view.airportCounts();
      expect(counts["EDAV"]).toBe(2);
      expect(counts["EDDF"]).toBe(2);
      expect(counts["EDDM"]).toBeUndefined();
    });
  });

  describe("pathIdsByAirport", () => {
    it("maps each airport to the ids of paths that use it", () => {
      const view = new DatasetIndex(makeDataset()).filter("all", "all");
      const byAirport = view.pathIdsByAirport();

      expect(byAirport["EDAV"]).toEqual(new Set([1, 2]));
      expect(byAirport["EDDF"]).toEqual(new Set([1, 2]));
      expect(byAirport["EDDM"]).toEqual(new Set([3, 4]));
      expect(byAirport["EDDK"]).toEqual(new Set([3, 4]));
    });

    it("caches the result", () => {
      const view = new DatasetIndex(makeDataset()).filter("all", "all");
      expect(view.pathIdsByAirport()).toBe(view.pathIdsByAirport());
    });

    it("respects the filter", () => {
      const view = new DatasetIndex(makeDataset()).filter("2024", "all");
      const byAirport = view.pathIdsByAirport();

      expect(Object.keys(byAirport).sort()).toEqual(["EDDK", "EDDM"]);
      expect(byAirport["EDDM"]).toEqual(new Set([3]));
    });

    it("handles paths with no airports", () => {
      const data = createDataset([{ id: 1, year: 2025 }], []);
      const view = new DatasetIndex(data).filter("all", "all");
      expect(view.pathIdsByAirport()).toEqual({});
    });

    it("takes an airport that names an object property as data (regression)", () => {
      const data = createDataset(
        [
          { id: 1, start_airport: "constructor", end_airport: "__proto__" },
          { id: 2, start_airport: "__proto__" },
        ],
        [],
      );
      const byAirport = new DatasetIndex(data)
        .filter("all", "all")
        .pathIdsByAirport();

      expect(byAirport["constructor"]).toEqual(new Set([1]));
      expect(byAirport["__proto__"]).toEqual(new Set([1, 2]));
      expect(Object.keys(byAirport).sort()).toEqual([
        "__proto__",
        "constructor",
      ]);
    });

    it("has no entry for an airport no path uses, whatever its name", () => {
      const view = new DatasetIndex(makeDataset()).filter("all", "all");
      expect(view.pathIdsByAirport()["constructor"]).toBeUndefined();
    });

    it("handles paths with only a start or end airport", () => {
      const data = createDataset(
        [
          { id: 1, start_airport: "EDAV" },
          { id: 2, end_airport: "EDDF" },
        ],
        [],
      );
      const view = new DatasetIndex(data).filter("all", "all");
      const byAirport = view.pathIdsByAirport();

      expect(byAirport["EDAV"]).toEqual(new Set([1]));
      expect(byAirport["EDDF"]).toEqual(new Set([2]));
    });
  });

  describe("segments", () => {
    it("returns all segments when the filter keeps everything", () => {
      const data = makeDataset();
      const view = new DatasetIndex(data).filter("all", "all");
      expect(view.segments()).toBe(data.path_segments);
    });

    it("returns only segments of the kept paths", () => {
      const view = new DatasetIndex(makeDataset()).filter("2024", "all");
      const segs = view.segments();
      expect(segs.every((s) => s.path_id === 3)).toBe(true);
      expect(segs).toHaveLength(1);
    });

    it("caches the result", () => {
      const view = new DatasetIndex(makeDataset()).filter("2025", "all");
      expect(view.segments()).toBe(view.segments());
    });
  });
});

describe("shownSelection", () => {
  const data = createDataset([
    { id: 1, year: 2025, aircraft_registration: "D-AAAA" },
    { id: 2, year: 2025, aircraft_registration: "D-BBBB" },
  ]);
  const state = (
    selected: number[],
    aircraft = "all",
    currentData: KMLDataset | null = data,
  ) => ({
    currentData,
    selectedYear: "all",
    selectedAircraft: aircraft,
    selectedPathIds: new Set(selected),
  });

  it("is the selection itself where the filter shows all of it", () => {
    const app = state([1, 2]);
    expect(shownSelection(app)).toBe(app.selectedPathIds);
    const none = state([1, 2], "all", null);
    expect(shownSelection(none)).toBe(none.selectedPathIds);
  });

  it("leaves out the selected flights the filter hides, or the dataset lacks", () => {
    // Share mode keeps them; nothing draws, counts or frames them
    expect([...shownSelection(state([1, 2, 99], "D-AAAA"))]).toEqual([1]);
    expect([...shownSelection(state([2], "D-AAAA"))]).toEqual([]);
  });
});
