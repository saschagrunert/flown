/**
 * The box a curve of the 3D view lies in (utils/curveBox.ts).
 */
import { describe, it, expect } from "vitest";
import { overlaps } from "../../../../flown/frontend/utils/viewBox";
import { boxOf } from "../../../../flown/frontend/utils/curveBox";
import type { Coordinate } from "../../../../flown/frontend/utils/geometry";

const points: Coordinate[] = [
  [47, 11],
  [47.5, 10.5],
  [46.8, 11.4],
  [48, 12],
];

describe("boxOf", () => {
  it("spans every point of the curve, west, south, east and north", () => {
    expect(boxOf(points)).toEqual([10.5, 46.8, 12, 48]);
  });

  it("spans the points from and to the ones given, both included", () => {
    expect(boxOf(points, 1, 2)).toEqual([10.5, 46.8, 11.4, 47.5]);
    expect(boxOf(points, 3, 3)).toEqual([12, 48, 12, 48]);
  });

  it("keeps a curve unwrapped past 180 on its side", () => {
    expect(
      boxOf([
        [-17, 179.9],
        [-17, 180.1],
      ]),
    ).toEqual([179.9, -17, 180.1, -17]);
  });

  it("overlaps nothing without points", () => {
    expect(overlaps([-180, -90, 180, 90], boxOf([]))).toBe(false);
  });
});
