/**
 * Web Mercator as MapLibre draws the flat map (utils/mercator.ts).
 */
import { describe, it, expect } from "vitest";
import { DEGREES_TO_RADIANS } from "../../../../flown/frontend/utils/geometry";
import {
  lngLatOfMercator,
  mercatorOf,
  mercatorY,
} from "../../../../flown/frontend/utils/mercator";

describe("mercatorOf", () => {
  it("puts null island in the middle of the world and the antimeridian at its edges", () => {
    expect(mercatorOf([0, 0])).toEqual([0.5, 0.5]);
    expect(mercatorOf([0, -180])[0]).toBe(0);
    expect(mercatorOf([0, 180])[0]).toBe(1);
  });

  it("puts the north above the south, further apart towards the poles", () => {
    const [, y45] = mercatorOf([45, 0]);
    const [, y60] = mercatorOf([60, 0]);
    expect(y45).toBeLessThan(0.5);
    expect(y60).toBeLessThan(y45);
    expect(0.5 - y45).toBeCloseTo(
      Math.log(Math.tan(Math.PI / 4 + (45 * DEGREES_TO_RADIANS) / 2)) /
        (2 * Math.PI),
      12,
    );
  });

  it("ends at the edge of the square world rather than past it", () => {
    expect(mercatorY(90)).toBe(mercatorY(85.0511287798));
    expect(mercatorY(-90)).toBe(mercatorY(-85.0511287798));
    expect(mercatorY(90)).toBeCloseTo(0, 9);
    expect(mercatorY(-90)).toBeCloseTo(1, 9);
    expect(Number.isFinite(mercatorY(90))).toBe(true);
  });

  it("is undone by lngLatOfMercator", () => {
    const [lng, lat] = lngLatOfMercator(...mercatorOf([47.5, 11.25]));
    expect(lng).toBeCloseTo(11.25, 9);
    expect(lat).toBeCloseTo(47.5, 9);
  });
});
