import { describe, it, expect } from "vitest";
import {
  calculateDistance,
  calculateBearing,
  ddToDms,
  EARTH_CIRCUMFERENCE_M,
  METRES_PER_DEGREE,
  metresPerPixel,
  planarMetres,
  segmentBounds,
  TILE_SIZE_PX,
  toMapBearing,
  toMapCenter,
  toMapPitch,
  turnOf,
  type Coordinate,
} from "../../../../flown/frontend/utils/geometry";
import { createSegment } from "../../testHelpers";

describe("geometry utilities", () => {
  describe("metresPerPixel", () => {
    it("spans the equator in the pixels of the world at a zoom", () => {
      expect(metresPerPixel(0) * TILE_SIZE_PX).toBe(EARTH_CIRCUMFERENCE_M);
      expect(metresPerPixel(10)).toBeCloseTo(40075016.686 / 512 / 1024, 9);
    });
  });

  describe("turnOf", () => {
    it("turns the short way round", () => {
      expect(turnOf(350, 10)).toBe(20);
      expect(turnOf(10, 350)).toBe(-20);
      expect(turnOf(0, 180)).toBe(-180);
      expect(turnOf(-170, 170)).toBe(-20);
    });

    it("gives -180 for half a turn either way, however many turns round", () => {
      for (const to of [180, -180, 540, -540, 900, -900]) {
        expect(turnOf(0, to)).toBe(-180);
      }
    });

    it("leaves a difference without a way round exact", () => {
      expect(turnOf(0, 0.1)).toBe(0.1);
      expect(turnOf(8.3, 8.1)).toBe(8.1 - 8.3);
      expect(turnOf(10, 370.5)).toBe(0.5);
    });
  });

  describe("planarMetres", () => {
    it("measures a degree of latitude, and one of longitude by its latitude", () => {
      expect(planarMetres([50, 8], [51, 8])).toBeCloseTo(METRES_PER_DEGREE, 6);
      expect(planarMetres([60, 8], [60, 9])).toBeCloseTo(
        METRES_PER_DEGREE / 2,
        6,
      );
    });

    it("measures the short way across the antimeridian", () => {
      expect(planarMetres([0, 179.99], [0, -179.99])).toBeCloseTo(
        planarMetres([0, 0], [0, 0.02]),
        3,
      );
    });
  });

  describe("calculateDistance", () => {
    it("calculates distance between Berlin and Paris", () => {
      const berlin: Coordinate = [52.52, 13.405];
      const paris: Coordinate = [48.8566, 2.3522];
      const distance = calculateDistance(berlin, paris);

      // Actual distance is ~877 km
      expect(distance).toBeCloseTo(877, 0);
    });

    it("calculates distance between New York and London", () => {
      const newYork: Coordinate = [40.7128, -74.006];
      const london: Coordinate = [51.5074, -0.1278];
      const distance = calculateDistance(newYork, london);

      // Actual distance is ~5570 km
      expect(distance).toBeCloseTo(5570, -1);
    });

    it("returns 0 for same coordinates", () => {
      const coord: Coordinate = [45.0, 10.0];
      const distance = calculateDistance(coord, coord);
      expect(distance).toBe(0);
    });

    it("handles coordinates across the international date line", () => {
      const coord1: Coordinate = [0, 179];
      const coord2: Coordinate = [0, -179];
      const distance = calculateDistance(coord1, coord2);

      // Should be ~222 km (2 degrees at equator)
      expect(distance).toBeCloseTo(222, 0);
    });

    it("handles north-south poles", () => {
      const northPole: Coordinate = [90, 0];
      const southPole: Coordinate = [-90, 0];
      const distance = calculateDistance(northPole, southPole);

      // Half circumference of Earth ~20,015 km
      expect(distance).toBeCloseTo(20015, 0);
    });

    it("is symmetric (A to B equals B to A)", () => {
      const coord1: Coordinate = [52.52, 13.405];
      const coord2: Coordinate = [48.8566, 2.3522];
      const dist1 = calculateDistance(coord1, coord2);
      const dist2 = calculateDistance(coord2, coord1);

      expect(dist1).toBeCloseTo(dist2, 6);
    });
  });

  describe("toMapBearing", () => {
    it("keeps a bearing the map reports itself as it is", () => {
      for (const bearing of [0, 40.5, -135, 180, -180]) {
        expect(toMapBearing(bearing)).toBe(bearing);
      }
    });

    it("wraps a bearing from further round into -180 to 180", () => {
      expect(toMapBearing(270)).toBe(-90);
      expect(toMapBearing(-190)).toBe(170);
      expect(toMapBearing(725)).toBe(5);
    });

    it("is null for anything that is no finite number", () => {
      for (const bearing of [NaN, Infinity, "90", null, undefined]) {
        expect(toMapBearing(bearing)).toBeNull();
      }
    });
  });

  describe("toMapPitch", () => {
    it("holds a pitch between flat and what the map tilts to", () => {
      expect(toMapPitch(35)).toBe(35);
      expect(toMapPitch(85)).toBe(85);
      expect(toMapPitch(89)).toBe(85);
      expect(toMapPitch(-5)).toBe(0);
    });

    it("is null for anything that is no finite number", () => {
      for (const pitch of [NaN, -Infinity, "35", null, undefined]) {
        expect(toMapPitch(pitch)).toBeNull();
      }
    });
  });

  describe("toMapCenter", () => {
    it("takes every place on the globe, the edges included", () => {
      expect(toMapCenter({ lat: 50, lng: 8 })).toEqual({ lat: 50, lng: 8 });
      expect(toMapCenter({ lat: 90, lng: -180 })).toEqual({
        lat: 90,
        lng: -180,
      });
      expect(toMapCenter({ lat: -90, lng: 180 })).toEqual({
        lat: -90,
        lng: 180,
      });
    });

    it("wraps a longitude of another copy of the world", () => {
      expect(toMapCenter({ lat: 50, lng: 190 })).toEqual({
        lat: 50,
        lng: -170,
      });
      expect(toMapCenter({ lat: 50, lng: -200 })).toEqual({
        lat: 50,
        lng: 160,
      });
      expect(toMapCenter({ lat: 50, lng: 728 })!.lng).toBeCloseTo(8, 9);
    });

    it("refuses what is off the globe or not a number", () => {
      expect(toMapCenter({ lat: 90.01, lng: 8 })).toBeNull();
      expect(toMapCenter({ lat: NaN, lng: 8 })).toBeNull();
      expect(toMapCenter({ lat: 50, lng: Infinity })).toBeNull();
      expect(toMapCenter({ lat: "50", lng: 8 })).toBeNull();
      expect(toMapCenter({ lat: 50, lng: undefined })).toBeNull();
    });
  });

  describe("calculateBearing", () => {
    it("calculates bearing for due north", () => {
      const bearing = calculateBearing(0, 0, 1, 0);
      expect(bearing).toBeCloseTo(0, 1);
    });

    it("calculates bearing for due east", () => {
      const bearing = calculateBearing(0, 0, 0, 1);
      expect(bearing).toBeCloseTo(90, 1);
    });

    it("calculates bearing for due south", () => {
      const bearing = calculateBearing(0, 0, -1, 0);
      expect(bearing).toBeCloseTo(180, 1);
    });

    it("calculates bearing for due west", () => {
      const bearing = calculateBearing(0, 0, 0, -1);
      expect(bearing).toBeCloseTo(270, 1);
    });

    it("calculates bearing from Berlin to Paris", () => {
      const bearing = calculateBearing(52.52, 13.405, 48.8566, 2.3522);
      // Southwest direction (~240-250 degrees)
      expect(bearing).toBeGreaterThan(230);
      expect(bearing).toBeLessThan(260);
    });

    it("returns value between 0 and 360", () => {
      const bearing = calculateBearing(45, -120, -30, 150);
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    });

    it("handles same coordinates", () => {
      const bearing = calculateBearing(45, 10, 45, 10);
      // Bearing is undefined for same point, but function should return a number
      expect(typeof bearing).toBe("number");
      expect(bearing).toBeGreaterThanOrEqual(0);
      expect(bearing).toBeLessThan(360);
    });
  });

  describe("ddToDms", () => {
    it("converts positive latitude to DMS", () => {
      const result = ddToDms(52.52, true);
      expect(result).toBe("52°31'12.0\"N");
    });

    it("converts negative latitude to DMS", () => {
      const result = ddToDms(-33.8688, true);
      expect(result).toBe("33°52'7.7\"S");
    });

    it("converts positive longitude to DMS", () => {
      const result = ddToDms(13.405, false);
      expect(result).toBe("13°24'18.0\"E");
    });

    it("converts negative longitude to DMS", () => {
      const result = ddToDms(-122.4194, false);
      expect(result).toBe("122°25'9.8\"W");
    });

    it("handles zero latitude", () => {
      const result = ddToDms(0, true);
      expect(result).toBe("0°0'0.0\"N");
    });

    it("handles zero longitude", () => {
      const result = ddToDms(0, false);
      expect(result).toBe("0°0'0.0\"E");
    });

    it("handles exact degrees (no minutes/seconds)", () => {
      const result = ddToDms(45.0, true);
      expect(result).toBe("45°0'0.0\"N");
    });

    it("handles maximum latitude", () => {
      const result = ddToDms(90, true);
      expect(result).toBe("90°0'0.0\"N");
    });

    it("handles maximum longitude", () => {
      const result = ddToDms(180, false);
      expect(result).toBe("180°0'0.0\"E");
    });

    it("formats seconds with one decimal place", () => {
      const result = ddToDms(51.50735, true);
      expect(result).toMatch(/\d+°\d+'\d+\.\d"/);
    });

    it("carries seconds that round up to 60 into the minute", () => {
      // 51°32'59.9964": rounding only the seconds printed 32'60.0"
      expect(ddToDms(51.549999, true)).toBe("51°33'0.0\"N");
      // ... and a full minute into the degree
      expect(ddToDms(-8.999999, false)).toBe("9°0'0.0\"W");
    });
  });

  describe("segmentBounds", () => {
    it("spans every point of the segments", () => {
      expect(
        segmentBounds([
          createSegment({
            path_id: 1,
            coords: [
              [50, 8],
              [51, 7],
            ],
          }),
          createSegment({
            path_id: 3,
            coords: [
              [49, 9],
              [50.5, 8.5],
            ],
          }),
        ]),
      ).toEqual([
        [49, 7],
        [51, 9],
      ]);
    });

    it("spans a flight across the antimeridian the short way", () => {
      expect(
        segmentBounds([
          createSegment({
            coords: [
              [-17.8, 177.4],
              [-17.5, 179.9],
            ],
          }),
          createSegment({
            coords: [
              [-17.5, 179.9],
              [-16.7, -179.9],
            ],
          }),
        ]),
      ).toEqual([
        [-17.8, 177.4],
        [-16.7, 180.1],
      ]);
    });

    it("keeps a flight either side of the prime meridian as it is", () => {
      expect(
        segmentBounds([
          createSegment({
            coords: [
              [51.4, -0.5],
              [51.5, 0.3],
            ],
          }),
        ]),
      ).toEqual([
        [51.4, -0.5],
        [51.5, 0.3],
      ]);
    });

    it("returns null without segments", () => {
      expect(segmentBounds([])).toBeNull();
    });
  });
});
