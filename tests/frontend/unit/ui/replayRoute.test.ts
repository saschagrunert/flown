/**
 * The replay route: the flight's whole track along its curve.
 */
import { describe, it, expect } from "vitest";
import { routeCoordinates } from "../../../../flown/frontend/ui/replayManager";
import { flatCurves } from "../../../../flown/frontend/calculations/curves";
import { createSegment } from "../../testHelpers";

describe("routeCoordinates", () => {
  it("starts the curve after a break in the flight at its first fix (regression)", () => {
    const segments = [
      createSegment({
        coords: [
          [50, 8],
          [50, 8.01],
        ],
      }),
      // Starts elsewhere than the one before ended: a new curve
      createSegment({
        coords: [
          [50, 8.05],
          [50, 8.06],
        ],
      }),
    ];

    const route = routeCoordinates(segments, flatCurves(segments));

    expect(route).toContainEqual([8.05, 50]);
    expect(route[0]).toEqual([8, 50]);
    expect(route[route.length - 1]).toEqual([8.06, 50]);
  });
});
