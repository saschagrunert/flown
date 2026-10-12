/**
 * Which flights the 3D view's layers and panels count (ui/keptFlights.ts).
 */
import { describe, it, expect } from "vitest";
import { idsKey, keptFlights } from "../../../../flown/frontend/ui/keptFlights";
import { createDataset, createSegment } from "../../testHelpers";

const data = createDataset(
  [
    { id: 1, year: 2025, aircraft_registration: "D-EAAA" },
    { id: 2, year: 2026, aircraft_registration: "D-EAAA" },
    { id: 3, year: 2026, aircraft_registration: "D-EBBB" },
  ],
  [1, 2, 3].map((path_id) => createSegment({ path_id })),
);

describe("keptFlights", () => {
  it("counts the flights the year and aircraft filters keep", () => {
    const keep = keptFlights(
      { selectedYear: "2026", selectedAircraft: "all" },
      data,
    );
    expect([1, 2, 3].filter(keep)).toEqual([2, 3]);
    const one = keptFlights(
      { selectedYear: "all", selectedAircraft: "D-EAAA" },
      data,
    );
    expect([1, 2, 3].filter(one)).toEqual([1, 2]);
  });

  it("counts only those among the ones given, and the filters still apply", () => {
    const keep = keptFlights(
      { selectedYear: "2026", selectedAircraft: "all" },
      data,
      new Set([1, 3]),
    );
    expect([1, 2, 3].filter(keep)).toEqual([3]);
  });
});

describe("idsKey", () => {
  it("is the same for the same ids in any order", () => {
    expect(idsKey(new Set([10, 2, 3]))).toBe(idsKey([3, 10, 2]));
    expect(idsKey([10, 2])).toBe("2,10");
    expect(idsKey([])).toBe("");
  });
});
