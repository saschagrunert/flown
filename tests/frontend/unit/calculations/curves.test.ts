import { describe, it, expect } from "vitest";
import {
  appendCurve,
  flatCurves,
  flightCurves,
} from "../../../../flown/frontend/calculations/curves";
import type { PathSegment } from "../../../../flown/frontend/types";
import { createSegment } from "../../testHelpers";

/** A flight of `count` segments of path `pathId`, turning as it goes */
function flight(pathId: number, count: number, lat = 48): PathSegment[] {
  const points = Array.from({ length: count + 1 }, (_, i): [number, number] => [
    lat + (i % 2) * 0.01,
    16 + i * 0.01,
  ]);
  return points
    .slice(1)
    .map((end, i) =>
      createSegment({ path_id: pathId, coords: [points[i]!, end] }),
    );
}

describe("flatCurves", () => {
  it("works a segment array out once, and another one anew", () => {
    const segments = [createSegment({ path_id: 1 })];

    expect(flatCurves(segments)).toBe(flatCurves(segments));
    expect(flatCurves([...segments])).not.toBe(flatCurves(segments));
  });

  it("smooths a flight once for every array that holds it", () => {
    const first = flight(1, 4);
    const second = flight(2, 3, 50);
    const all = [...first, ...second];

    const year = flatCurves(first);
    const both = flatCurves(all);

    // The year's and all years' arrays share the segments of a flight
    expect(both.chains[0]).toBe(year.chains[0]);
    expect(flatCurves([...second]).chains[0]).toBe(both.chains[1]);
  });

  it("smooths anew a chain that starts alike and is cut shorter", () => {
    const segments = flight(1, 4);
    const whole = flatCurves(segments).chains[0]!;

    const part = flatCurves(segments.slice(0, 2)).chains[0]!;

    expect(part).not.toBe(whole);
    expect(part.vertex).toHaveLength(3);
  });
});

describe("flightCurves", () => {
  it("smooths only the flight asked for, and says where it starts", () => {
    const segments = [...flight(1, 3), ...flight(2, 4, 50)];

    const { curves, from } = flightCurves(segments, 2);

    expect(from).toBe(3);
    expect(curves.chains).toHaveLength(1);
    expect(curves.chainOf).toHaveLength(4);
    // The same curve as all of them have for that flight
    expect(curves.chains[0]!.points).toEqual(
      flatCurves([...segments]).chains[1]!.points,
    );
    expect(flightCurves(segments, 2)).toBe(flightCurves(segments, 2));
  });

  it("takes all of an array that is not in order of its paths", () => {
    const [a, b] = [flight(1, 2), flight(2, 2, 50)];
    const segments = [a[0]!, b[0]!, a[1]!, b[1]!];

    expect(flightCurves(segments, 2)).toMatchObject({ from: 0 });
    expect(flightCurves(segments, 2).curves.chainOf).toHaveLength(4);
    // Smoothed once for every flight of it, not once per flight
    expect(flightCurves(segments, 1).curves).toBe(
      flightCurves(segments, 2).curves,
    );
  });
});

describe("appendCurve", () => {
  it("carries a line on along a segment's curve, past the antimeridian", () => {
    const segments = [
      createSegment({
        path_id: 1,
        coords: [
          [60, 179.99],
          [60.01, 179.99],
        ],
      }),
      createSegment({
        path_id: 1,
        coords: [
          [60.01, 179.99],
          [60.01, -179.98],
        ],
      }),
    ];
    const curves = flatCurves(segments);
    const line: [number, number][] = [[179.99, 60]];

    appendCurve(line, curves, 0);
    appendCurve(line, curves, 1);

    // A point per 4 degrees of the right angle, never back round the world
    expect(line.length).toBeGreaterThan(3);
    for (const [lng] of line) {
      expect(lng).toBeGreaterThanOrEqual(179.99 - 0.01);
      expect(lng).toBeLessThanOrEqual(180.02 + 1e-9);
    }
    expect(line[line.length - 1]![0]).toBeCloseTo(180.02, 9);
  });
});
