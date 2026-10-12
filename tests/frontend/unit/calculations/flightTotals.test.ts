/**
 * The flight time and distance of every flight, which the flight list shows.
 */
import { describe, expect, it } from "vitest";
import {
  computeFlightTotals,
  flightTotals,
} from "../../../../flown/frontend/calculations/flightTotals";
import { calculateDistance } from "../../../../flown/frontend/utils/geometry";
import { createDataset, createSegment } from "../../testHelpers";

const A: [number, number] = [50.0, 8.0];
const B: [number, number] = [50.1, 8.1];
const C: [number, number] = [50.2, 8.3];

describe("computeFlightTotals", () => {
  it("adds up each flight's distance and time span", () => {
    const totals = computeFlightTotals([
      createSegment({ path_id: 1, coords: [A, B], time: 100 }),
      createSegment({ path_id: 2, coords: [A, C], time: 50 }),
      createSegment({ path_id: 1, coords: [B, C], time: 700 }),
      // Out of order in time: the span is from the first to the last
      createSegment({ path_id: 1, coords: [C, C], time: 40 }),
      createSegment({ path_id: 2, coords: [C, A], time: 950 }),
    ]);

    expect(totals.get(1)!.seconds).toBe(660);
    expect(totals.get(1)!.km).toBeCloseTo(
      calculateDistance(A, B) + calculateDistance(B, C),
    );
    expect(totals.get(2)!.seconds).toBe(900);
    expect(totals.get(2)!.km).toBeCloseTo(2 * calculateDistance(A, C));
  });

  it("gives no time to a flight without one, or with a single one", () => {
    const totals = computeFlightTotals([
      createSegment({ path_id: 1, coords: [A, B] }),
      createSegment({ path_id: 2, coords: [A, B], time: 30 }),
      createSegment({ path_id: 2, coords: [B, C] }),
    ]);

    expect(totals.get(1)).toEqual({ km: calculateDistance(A, B) });
    expect(totals.get(2)!.seconds).toBeUndefined();
    expect(totals.has(3)).toBe(false);
  });
});

describe("flightTotals", () => {
  it("works a dataset out once and a new dataset out again", () => {
    const segments = [createSegment({ path_id: 1, coords: [A, B], time: 0 })];
    const data = createDataset([{ id: 1 }], segments);

    const first = flightTotals(data);

    expect(flightTotals(data)).toBe(first);
    expect(flightTotals(createDataset([{ id: 1 }], segments))).not.toBe(first);
  });
});
