import { describe, it, expect, afterEach } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  GROUND_LEVELS,
  LIFT_MAX_ZOOM,
  LIFT_STEP_FT,
  RELIEF_MAX_LEVEL,
  TERRAIN_TILE_MAX_ZOOM,
  followsLevel,
  groundOffsetFt,
  heightOnReliefFt,
  isLiftedAt,
  liftExaggeration,
  liftFt,
  liftOffsetPx,
  reliefLevel,
  reliefPixelM,
  ribbonId,
  switchesExaggeration,
} from "../../../../flown/frontend/calculations/lift";
import {
  airplaneLiftPx,
  heightAtZoomFt,
} from "../../../../flown/frontend/calculations/airplaneLift";
import {
  keptGrounded,
  smoothGrounded,
} from "../../../../flown/frontend/calculations/smoothGrounded";
import {
  smoothFlights,
  smoothLine,
} from "../../../../flown/frontend/calculations/smoothing";
import {
  groundProfileFt,
  groundProfilesFt,
  smoothAlong,
  groundedFlights,
  heldGroundedFlights,
  holdGroundProfiles,
  releaseGroundedFlights,
  releaseGroundProfiles,
} from "../../../../flown/frontend/calculations/groundProfile";
import {
  groundOffsetStepFt,
  ribbonOf,
  ribbonPieces,
  ribbonProperties,
  sameOffsets,
  screenCut,
} from "../../../../flown/frontend/calculations/ribbons";
import {
  ribbonHeightFt,
  ribbonHeights,
} from "../../../../flown/frontend/calculations/ribbonPaint";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";
import {
  FEET_TO_METERS,
  METERS_TO_FEET,
} from "../../../../flown/frontend/utils/constants";
import type { PathSegment } from "../../../../flown/frontend/types";
import { createMapLibreMock } from "../../testHelpers";

const METRES_PER_DEGREE = 111320;

/** The zoom the ribbons of these tests are cut for */
const Z = 12;

/**
 * How wide a ribbon cut for Z is on the ground at `lat`, in metres: three
 * pixels in the middle of the level, of 512 pixel tiles
 */
const widthM = (lat: number): number =>
  ((3 * 40075016.686) / (512 * 2 ** (Z + 0.5))) *
  Math.cos((lat * Math.PI) / 180);

describe("lift", () => {
  afterEach(() => resetMapLibreMock());

  describe("groundProfileFt", () => {
    /**
     * A segment of path 1 heading east from `lng`, 0.01 degrees long, timed
     * as a recording with timestamps is
     */
    const at = (
      lng: number,
      altitude_ft: number,
      groundspeed_knots: number,
      path_id = 1,
    ): PathSegment => ({
      path_id,
      altitude_ft,
      groundspeed_knots,
      time: Math.round((lng - 8) * 10000),
      coords: [
        [50, lng],
        [50, lng + 0.01],
      ],
    });
    /** A flight from a field at `from` ft to one at `to` ft, with a dip */
    const flight = (from: number, to: number): PathSegment[] => [
      at(8, from + 100, 5),
      at(8.01, from, 10),
      at(8.02, from, 8),
      at(8.03, 3000, 110),
      // A glitch of the recorder, far below both fields
      at(8.04, -600, 115),
      at(8.05, 3000, 110),
      at(8.06, to, 12),
      at(8.07, to, 6),
      at(8.08, to, 3),
    ];

    it("stands a flight on both of its fields, and slopes between them", () => {
      const ground = groundProfileFt(flight(400, 2000));

      // Taxiing on the map at both ends: the middle of the taxi altitudes
      expect(ground[0]).toBeCloseTo(400 + 1600 / 9, 6);
      expect(ground[8]).toBe(2000);
      expect(liftFt(2000, ground[8]!)).toBe(0);
      // In proportion to the distance flown, whatever the altitudes did
      for (let i = 1; i < 9; i++) {
        expect(ground[i]! - ground[i - 1]!).toBeCloseTo(1600 / 9, 6);
      }
    });

    it("keeps a glitch below the fields from taking the flight up", () => {
      const segments = flight(400, 400);
      const ground = groundProfileFt(segments);

      // The lowest part of its time would have been the glitch
      expect([...ground]).toEqual(segments.map(() => 400));
      expect(liftFt(segments[3]!.altitude_ft, ground[3]!)).toBe(2600);
    });

    it("stands a flight that starts in the air on the field it landed on", () => {
      const ground = groundProfileFt(flight(400, 1200).slice(3));

      expect([...ground]).toEqual([1200, 1200, 1200, 1200, 1200, 1200]);
    });

    it("falls back to the lowest part of its time without speeds to tell", () => {
      // A log without timing, whose speeds the build writes as 0 (no
      // speed). Were a 0 taxiing, the field would be the middle of the
      // altitudes, 3,000 ft (regression)
      const segments = [800, 800, 3000, 5000].map((altitude, i) =>
        at(8 + i / 100, altitude, 0),
      );

      expect([...groundProfileFt(segments)]).toEqual([800, 800, 800, 800]);
    });

    it("tells no field from a line without times, as the build does", () => {
      // A flight of circuits at 1,310 ft over a field at 330 ft, drawn as
      // a line with a TimeSpan: every segment has the average speed, below
      // that of taxiing, and no time. Counted as taxiing, the field was
      // the middle of the altitudes, the circuit height (regression)
      const segments = [330, 1310, 1310, 1310, 1310, 330].map((altitude, i) => {
        const { time: _, ...untimed } = at(8 + i / 100, altitude, 30);
        return untimed;
      });

      expect([...groundProfileFt(segments)]).toEqual(segments.map(() => 330));
    });

    it("ends the taxiing at a speed of 0, as the build does", () => {
      // Taxiing at the start, then no speed: the start field only
      const segments = [
        at(8, 400, 5),
        at(8.01, 400, 10),
        at(8.02, 400, 8),
        at(8.03, 3000, 0),
        at(8.04, 2000, 0),
        at(8.05, 2000, 0),
        at(8.06, 2000, 0),
      ];

      expect([...groundProfileFt(segments)]).toEqual(segments.map(() => 400));
    });

    it("measures the way flown across the antimeridian the short way", () => {
      // Taxiing at both fields, then two legs of the same length, the second
      // across the antimeridian: the ground slopes evenly along them
      const segment = (
        from: number,
        to: number,
        altitude_ft: number,
        groundspeed_knots: number,
      ): PathSegment => ({
        path_id: 1,
        altitude_ft,
        groundspeed_knots,
        time: 0,
        coords: [
          [50, from],
          [50, to],
        ],
      });
      const segments = [
        segment(179.96, 179.97, 400, 5),
        segment(179.97, 179.98, 400, 5),
        segment(179.98, 179.99, 400, 5),
        segment(179.99, -179.99, 3000, 110),
        segment(-179.99, -179.98, 800, 5),
        segment(-179.98, -179.97, 800, 5),
        segment(-179.97, -179.96, 800, 5),
      ];

      const ground = groundProfileFt(segments);

      // Six legs of 0.01 degrees and one of 0.02: not one round the world
      for (const i of [1, 2, 4, 5, 6]) {
        expect(ground[i]! - ground[i - 1]!).toBeCloseTo(400 / 8, 6);
      }
      expect(ground[3]! - ground[2]!).toBeCloseTo(800 / 8, 6);
    });

    it("works out every flight on its own", () => {
      const segments = [
        ...flight(400, 400),
        ...flight(1000, 1000).map((segment) => ({ ...segment, path_id: 2 })),
      ];
      const ground = groundProfileFt(segments);

      expect(ground[0]).toBe(400);
      expect(ground[9]).toBe(1000);
    });

    it("takes the ground the build sampled where a flight has it", () => {
      const sampled = [420, 430, 400, 900, 1500, 1100, 2000, 2010, 2000];
      const segments = [
        ...flight(400, 2000).map((segment, i) => ({
          ...segment,
          ground_ft: sampled[i],
        })),
        ...flight(400, 400).map((segment) => ({ ...segment, path_id: 2 })),
      ];

      const ground = groundProfileFt(segments);

      // The relief under the first flight, the line between its fields
      // under the second
      expect([...ground.slice(0, 9)]).toEqual(sampled);
      expect([...ground.slice(9)]).toEqual(segments.slice(9).map(() => 400));
    });

    it("smooths the sampled ground as coarsely as the relief of the level", () => {
      const sampled = [420, 430, 400, 900, 1500, 1100, 2000, 2010, 2000];
      const segments = flight(400, 2000).map((segment, i) => ({
        ...segment,
        ground_ft: sampled[i],
      }));
      // 0.01 degrees of longitude at 50 north, the length of a segment
      const metres = 0.01 * METRES_PER_DEGREE * Math.cos((50 * Math.PI) / 180);
      const along = sampled.map((_, i) => (i + 1) * metres);
      const spread = (level: number): number => {
        const ground = [...groundProfileFt(segments, true, level)];
        return Math.max(...ground) - Math.min(...ground);
      };

      expect([...groundProfileFt(segments, true, 7)]).toEqual(
        smoothAlong(sampled, along, reliefPixelM(7, 50)).map(
          (feet) => expect.closeTo(feet, 6) as unknown as number,
        ),
      );
      // Coarser further out, and as sampled beyond the deepest tiles
      expect(spread(6)).toBeLessThan(spread(9));
      expect(spread(9)).toBeLessThan(spread(TERRAIN_TILE_MAX_ZOOM));
      expect([
        ...groundProfileFt(segments, true, TERRAIN_TILE_MAX_ZOOM + 1),
      ]).toEqual(sampled);
    });

    it("leaves the sampled ground out where the relief is not drawn", () => {
      const segments = flight(400, 2000).map((segment) => ({
        ...segment,
        ground_ft: 5000,
      }));

      expect([...groundProfileFt(segments, false)]).toEqual([
        ...groundProfileFt(flight(400, 2000)),
      ]);
    });

    it("falls back to its fields where the sampled ground has a gap", () => {
      const segments = flight(400, 2000).map((segment, i) =>
        i === 4 ? segment : { ...segment, ground_ft: 5000 },
      );

      expect([...groundProfileFt(segments)]).toEqual([
        ...groundProfileFt(flight(400, 2000)),
      ]);
    });
  });

  describe("liftFt", () => {
    it("is the height above the flight's ground", () => {
      expect(liftFt(1500, 300)).toBe(1200);
    });

    it("keeps a fix below the ground on it", () => {
      // A barometric glitch or a field lower than the one of the ground
      expect(liftFt(200, 300)).toBe(0);
    });
  });

  describe("ribbonPieces", () => {
    /** The quads of a flat ribbon along `points`, in order */
    const flat = (
      points: [number, number][],
      before?: [number, number],
      after?: [number, number],
    ): GeoJSON.MultiPolygon => {
      const pieces = ribbonPieces(
        points,
        points.map(() => 1000),
        Z,
        before,
        after,
      );
      expect(pieces).toHaveLength(1);
      return pieces[0]!.geometry;
    };
    /** The corners of the quad of segment `i`: left, left, right, right */
    const quad = (geometry: GeoJSON.MultiPolygon, i: number): number[][] =>
      geometry.coordinates[i]![0]!;
    const metresPerLng = (lat: number): number =>
      METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);

    it("widens a straight segment to a closed quad a few pixels across", () => {
      const geometry = flat([
        [50, 8],
        [50, 8.01],
      ]);

      expect(geometry.type).toBe("MultiPolygon");
      const ring = quad(geometry, 0);
      expect(ring).toHaveLength(5);
      expect(ring[0]).toEqual(ring[4]);
      // Due east: widened north and south, to the left first
      const [left, , , right] = ring;
      expect(left![0]).toBeCloseTo(8, 9);
      expect((left![1]! - right![1]!) * METRES_PER_DEGREE).toBeCloseTo(
        widthM(50),
        6,
      );
    });

    it("widens a segment due north east and west, by the width in metres", () => {
      const [left, , , right] = quad(
        flat([
          [50, 8],
          [50.01, 8],
        ]),
        0,
      );

      expect(left![1]).toBeCloseTo(50, 9);
      expect((right![0]! - left![0]!) * metresPerLng(50)).toBeCloseTo(
        widthM(50),
        6,
      );
    });

    it("is as many pixels wide at every latitude, as Mercator draws it", () => {
      const across = (lat: number): number => {
        const [left, , , right] = quad(
          flat([
            [lat, 8],
            [lat, 8.01],
          ]),
          0,
        );
        return (left![1]! - right![1]!) * METRES_PER_DEGREE;
      };

      // Narrower on the ground by as much as Mercator enlarges it there
      expect(across(60) / across(0)).toBeCloseTo(Math.cos(Math.PI / 3), 3);
    });

    it("shares the corners of neighbouring quads, so a bend has no gap", () => {
      const geometry = flat([
        [50, 8],
        [50, 8.01],
        [50.01, 8.01],
      ]);

      expect(geometry.coordinates).toHaveLength(2);
      // The end of the first quad is the start of the second, on both sides
      expect(quad(geometry, 0)[1]).toEqual(quad(geometry, 1)[0]);
      expect(quad(geometry, 0)[2]).toEqual(quad(geometry, 1)[3]);
    });

    it("mitres a right angle: the corner lies √2 half widths out", () => {
      const geometry = flat([
        [50, 8],
        [50, 8.01],
        [50.01, 8.01],
      ]);
      const [, corner] = quad(geometry, 0);
      const dx = (corner![0]! - 8.01) * metresPerLng(50);
      const dy = (corner![1]! - 50) * METRES_PER_DEGREE;

      expect(Math.hypot(dx, dy)).toBeCloseTo((widthM(50) / 2) * Math.SQRT2, 3);
    });

    it("caps the corner of a hairpin", () => {
      const geometry = flat([
        [50, 8],
        [50, 8.01],
        [50.0001, 8],
      ]);
      const [, corner] = quad(geometry, 0);
      const dx = (corner![0]! - 8.01) * metresPerLng(50);
      const dy = (corner![1]! - 50) * METRES_PER_DEGREE;

      expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(1.5 * widthM(50) + 1e-6);
    });

    it("mitres its ends into the line it continues from and to", () => {
      const alone = flat([
        [50, 8.01],
        [50.01, 8.01],
      ]);
      const joined = flat(
        [
          [50, 8.01],
          [50.01, 8.01],
        ],
        [50, 8],
      );
      const onItsOwn = flat([
        [50, 8],
        [50, 8.01],
        [50.01, 8.01],
      ]);

      expect(quad(joined, 0)[0]).not.toEqual(quad(alone, 0)[0]);
      // The same corner the whole line gives the bend
      expect(quad(joined, 0)[0]).toEqual(quad(onItsOwn, 1)[0]);
    });

    it("keeps a level stretch in one piece at its height", () => {
      const pieces = ribbonPieces(
        [
          [50, 8],
          [50, 8.01],
          [50, 8.02],
        ],
        [1000, 1000, 1000],
        Z,
      );

      expect(pieces.map((piece) => piece.h)).toEqual([1000]);
      expect(pieces[0]!.geometry.coordinates).toHaveLength(2);
    });

    it("cuts a climb into pieces a step apart that slope with it", () => {
      const pieces = ribbonPieces(
        [
          [50, 8],
          [50, 8.01],
        ],
        [1000, 1100],
        Z,
      );

      // 100 ft in steps of 20: five pieces, each at the height of its middle
      expect(pieces.map((piece) => piece.h)).toEqual([
        1010, 1030, 1050, 1070, 1090,
      ]);
      // Laid end to end along the segment, without a gap
      const quads = pieces.flatMap((piece) => piece.geometry.coordinates);
      for (let i = 1; i < quads.length; i++) {
        expect(quads[i]![0]![0]).toEqual(quads[i - 1]![0]![1]);
      }
      expect(quads[0]![0]![0]![0]).toBeCloseTo(8, 9);
      expect(quads[quads.length - 1]![0]![1]![0]).toBeCloseTo(8.01, 9);
    });

    it("cuts a slope into no piece taller than a step", () => {
      const heights = ribbonPieces(
        [
          [50, 8],
          [50, 8.01],
        ],
        [0, 30],
        Z,
      ).map((piece) => piece.h);

      expect(heights).toEqual([7.5, 22.5]);
      expect(30 / heights.length).toBeLessThanOrEqual(LIFT_STEP_FT);
    });

    it("gives a segment without length a quad instead of dividing by zero", () => {
      const geometry = flat([
        [50, 8],
        [50, 8],
      ]);

      for (const point of quad(geometry, 0)) {
        expect(Number.isFinite(point[0])).toBe(true);
        expect(Number.isFinite(point[1])).toBe(true);
      }
    });
  });

  describe("smoothLine", () => {
    /** Three points with a right angle in the middle, level at 1000 ft */
    const corner: [number, number][] = [
      [50, 8],
      [50, 8.01],
      [50.01, 8.01],
    ];

    it("keeps the logged points, and a straight line as it is", () => {
      const line = smoothLine(
        [
          [50, 8],
          [50, 8.01],
          [50, 8.02],
        ],
        [0, 100, 200],
      );

      expect(line.points).toEqual([
        [50, 8],
        [50, 8.01],
        [50, 8.02],
      ]);
      expect(line.vertex).toEqual([0, 1, 2]);
      expect(line.heights).toEqual([0, 100, 200]);
    });

    it("spreads a height that jumps over a few metres into a slope", () => {
      // 600 ft between two fixes 7 m apart: the altitude settling while
      // the aircraft rolls, which would stand as a tower of pieces
      const line = smoothLine(
        [
          [50, 8],
          [50, 8.0001],
          [50, 8.01],
        ],
        [0, 600, 600],
      );

      // No steeper than 0.3 ft per ft, and at the top by the next fix
      const metres = 0.0001 * 111320 * Math.cos((50 * Math.PI) / 180);
      expect(line.heights[1]).toBeCloseTo(metres * METERS_TO_FEET * 0.3, 6);
      expect(line.heights[2]).toBe(600);
    });

    it("leaves a real climb as it is", () => {
      // 500 ft over 2.4 km, like a light aircraft after takeoff
      const heights = smoothLine(
        [
          [50, 8],
          [50, 8.0333],
        ],
        [0, 500],
      ).heights;

      expect(heights).toEqual([0, 500]);
    });

    it("rounds a turn with points along a curve through the logged ones", () => {
      const line = smoothLine(corner, [1000, 1000, 1000]);

      expect(line.points.length).toBeGreaterThan(3);
      // The logged points are where they were, in order
      expect(line.vertex.map((v) => line.points[v])).toEqual(corner);
      expect(line.vertex).toEqual([...line.vertex].sort((a, b) => a - b));
      // A curve through the corner itself swings out a little before and
      // after it, here less than 100 m on legs of 716 m and 1,113 m: it
      // does not loop
      const outside = (value: number, low: number, high: number): number =>
        Math.max(low - value, value - high, 0);
      for (const [lat, lng] of line.points) {
        expect(outside(lat, 50, 50.01) * 111320).toBeLessThan(100);
        expect(
          outside(lng, 8, 8.01) *
            METRES_PER_DEGREE *
            Math.cos((50 * Math.PI) / 180),
        ).toBeLessThan(100);
      }
    });

    it("cuts a turn a point per so many degrees of it", () => {
      // About 20 degrees of turn at each fix
      const points: [number, number][] = [
        [50, 8],
        [50.001, 8],
        [50.002, 8.0006],
        [50.0028, 8.0014],
      ];
      const coarse = smoothLine(points, [0, 0, 0, 0]);
      const fine = smoothLine(points, [0, 0, 0, 0], {
        turnStepDeg: 4,
      });

      // Twice as many points between the fixes at the flat lines' 4
      // degrees as at the ribbons' 8
      expect(fine.points.length - 4).toBeGreaterThanOrEqual(
        2 * (coarse.points.length - 4),
      );
      // Through the logged points all the same
      expect(fine.vertex.map((v) => fine.points[v])).toEqual(points);
    });

    it("holds altitudes to the slope before it takes the ground off", () => {
      // Level at 3,000 ft over a ridge that rises 2,000 ft between two
      // fixes 700 m apart, far steeper than any climb
      const points: [number, number][] = [
        [50, 8],
        [50, 8.01],
        [50, 8.02],
      ];
      const line = smoothLine(points, [3000, 3000, 3000], {
        ground: [500, 2500, 500],
      });

      // Over the ground the flight has its full height, on the ridge too
      expect(line.heights).toEqual([2500, 500, 2500]);
      // Measured from the ground instead, the slope would hold it up there
      expect(smoothLine(points, [2500, 500, 2500]).heights[1]).toBeGreaterThan(
        500,
      );
    });

    it("never takes a flight below its ground", () => {
      const line = smoothLine(
        [
          [50, 8],
          [50, 8.01],
        ],
        [400, 1000],
        { ground: [600, 600] },
      );

      expect(line.heights).toEqual([0, 400]);
    });

    it("eases a climb in and out without going beyond its heights", () => {
      const line = smoothLine(
        [
          [50, 8],
          [50, 8.01],
          [50.01, 8.01],
          [50.01, 8.02],
        ],
        [0, 0, 300, 300],
      );

      for (const h of line.heights) {
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThanOrEqual(300);
      }
      const between = line.heights.slice(line.vertex[1], line.vertex[2]! + 1);
      expect(between).toEqual([...between].sort((a, b) => a - b));
    });
  });

  describe("smoothFlights and ribbonOf", () => {
    const segment = (
      path_id: number,
      from: [number, number],
      to: [number, number],
    ): { path_id: number; coords: [[number, number], [number, number]] } => ({
      path_id,
      coords: [from, to],
    });

    it("smooths each flight as one chain and knows each segment's place on it", () => {
      const segments = [
        segment(1, [50, 8], [50, 8.01]),
        segment(1, [50, 8.01], [50.01, 8.01]),
        // Another flight, which is a chain of its own
        segment(2, [52, 10], [52, 10.01]),
      ];

      const flights = smoothFlights(segments, () => 500);

      expect(flights.chains).toHaveLength(2);
      expect([...flights.chainOf]).toEqual([0, 0, 1]);
      // The first segment ends where the second starts
      expect(flights.to[0]).toBe(flights.from[1]);
      expect(flights.from[0]).toBe(0);
    });

    it("carries a flight on across the antimeridian, without a curve round the world", () => {
      const segments = [
        segment(1, [60, 179.98], [60, 179.99]),
        segment(1, [60, 179.99], [60, -179.99]),
        segment(1, [60, -179.99], [60, -179.98]),
      ];

      const [chain] = smoothFlights(segments, () => 500).chains;

      // A straight line: no point is added along it, and the longitudes go
      // on past 180
      expect(chain!.points.map(([, lng]) => lng)).toEqual([
        179.98,
        179.99,
        expect.closeTo(180.01, 9),
        expect.closeTo(180.02, 9),
      ]);
    });

    it("cuts ribbons that meet their neighbours corner to corner", () => {
      const segments = [
        segment(1, [50, 8], [50, 8.01]),
        segment(1, [50, 8.01], [50.01, 8.01]),
        segment(1, [50.01, 8.01], [50.01, 8.02]),
      ];
      const flights = smoothFlights(segments, () => 500);

      const first = ribbonOf(flights, 0, 1, Z);
      const rest = ribbonOf(flights, 1, 3, Z);

      const lastQuad = first.at(-1)!.geometry.coordinates.at(-1)![0]!;
      const firstQuad = rest[0]!.geometry.coordinates[0]![0]!;
      // The end of the one is the start of the other, on both edges
      expect(firstQuad[0]).toEqual(lastQuad[1]);
      expect(firstQuad[3]).toEqual(lastQuad[2]);
    });
  });

  describe("screenCut and ribbonOf for the screen", () => {
    /** The metres of a pixel in the middle of the level `zoom` at `lat` */
    const pixelM = (zoom: number, lat: number): number =>
      (40075016.686 / (512 * 2 ** (zoom + 0.5))) *
      Math.cos((lat * Math.PI) / 180);
    /** A flight due east at 48 N, a point every `step` degrees */
    const east = (
      count: number,
      step: number,
      heightOf: (i: number) => number = () => 3000,
    ) => {
      const segments = Array.from({ length: count }, (_, i) => ({
        path_id: 1,
        coords: [
          [48, 16 + i * step],
          [48, 16 + (i + 1) * step],
        ] as [[number, number], [number, number]],
      }));
      return smoothFlights(segments, (i) => heightOf(i), {
        groundOf: () => 1000,
      });
    };
    const quads = (pieces: ReturnType<typeof ribbonOf>): number[][][] =>
      pieces.flatMap((piece) =>
        piece.geometry.coordinates.map((polygon) => polygon[0]!),
      );

    it("coarsens the step of the pieces zoomed out, to within a pixel", () => {
      for (let zoom = 3; zoom < 14; zoom++) {
        const { stepFt, spanFt, pixelM: pixel } = screenCut(zoom, 48);
        expect(pixel).toBeCloseTo(pixelM(zoom, 48), 6);
        const pixelFt =
          pixel / liftExaggeration(reliefLevel(zoom)) / FEET_TO_METERS;
        expect(stepFt % LIFT_STEP_FT).toBe(0);
        if (spanFt > 0) {
          expect(spanFt).toBe(stepFt);
          expect(stepFt).toBeLessThanOrEqual(pixelFt);
          expect(stepFt * 2).toBeGreaterThan(pixelFt);
        } else {
          // Closer in than a step fits in a pixel: as the data has it
          expect(stepFt).toBe(LIFT_STEP_FT);
          expect(LIFT_STEP_FT).toBeGreaterThan(pixelFt);
        }
      }
      expect(screenCut(5, 48).stepFt).toBeGreaterThan(100);
      expect(screenCut(13, 48).spanFt).toBe(0);
    });

    it("draws a straight level flight in quads of many points, as wide", () => {
      // 200 points 30 m apart: 6 km, about 80 pixels at zoom 9
      const flights = east(200, 0.0004);
      const exact = quads(ribbonOf(flights, 0, 200, 9));
      const cut = quads(ribbonOf(flights, 0, 200, 9, true));

      expect(exact).toHaveLength(200);
      expect(cut.length).toBeGreaterThanOrEqual(5);
      expect(cut.length).toBeLessThanOrEqual(7);
      // Where it starts and ends, and as wide
      expect(cut[0]![0]).toEqual(exact[0]![0]);
      expect(cut.at(-1)![2]).toEqual(exact.at(-1)![2]);
    });

    it("keeps a quad no longer than 16 to 24 pixels, and a turn in steps of a few degrees", () => {
      // 60 km due east at zoom 9, a point every 8 pixels: 820 pixels
      const straight = quads(ribbonOf(east(100, 0.008), 0, 100, 9, true));
      const lengthPx = (quad: number[][], zoom = 9): number =>
        (Math.hypot(
          (quad[1]![0]! - quad[0]![0]!) * Math.cos((48 * Math.PI) / 180),
          quad[1]![1]! - quad[0]![1]!,
        ) *
          111320) /
        pixelM(zoom, 48);
      for (const quad of straight) {
        expect(lengthPx(quad)).toBeLessThanOrEqual(16 + 11);
      }
      expect(straight.length).toBeLessThan(60);
      // Zoomed in, where the points are 260 px apart: no quad longer than
      // 24 px, so none reaches past the buffer of a tile
      for (const quad of quads(ribbonOf(east(4, 0.008), 0, 4, 14, true))) {
        expect(lengthPx(quad, 14)).toBeLessThanOrEqual(24);
      }

      // A circle of 2 km across, 72 points: a point every 20 to 30 px of
      // turn at zoom 12, and a blot of a few pixels at zoom 6
      const circle = Array.from({ length: 73 }, (_, i): [number, number] => [
        48 + 0.009 * Math.sin((i * Math.PI) / 36),
        16 + 0.0134 * Math.cos((i * Math.PI) / 36),
      ]);
      const segments = circle.slice(1).map((end, i) => ({
        path_id: 1,
        coords: [circle[i]!, end] as [[number, number], [number, number]],
      }));
      const flights = smoothFlights(segments, () => 3000, {
        groundOf: () => 1000,
      });
      const close = quads(ribbonOf(flights, 0, 72, 12, true)).length;
      const far = quads(ribbonOf(flights, 0, 72, 6, true)).length;
      expect(close).toBeGreaterThanOrEqual(36);
      expect(far).toBeLessThan(close / 4);
    });

    it("keeps the height within a step of the exact cut, and runs that meet corner to corner", () => {
      // Climbing 3,000 ft over 200 points, cut into two runs
      const flights = east(200, 0.0004, (i) => 1000 + i * 15);
      const { stepFt } = screenCut(7, 48);
      const first = ribbonOf(flights, 0, 90, 7, true);
      const rest = ribbonOf(flights, 90, 200, 7, true);
      const exact = ribbonOf(flights, 0, 200, 7);

      expect(first.length + rest.length).toBeLessThan(exact.length / 3);
      const heights = [...first, ...rest].map((piece) => piece.h);
      expect(heights).toEqual([...heights].sort((a, b) => a - b));
      expect(heights[0]!).toBeLessThanOrEqual(stepFt);
      expect(heights.at(-1)!).toBeGreaterThanOrEqual(3000 - 15 - stepFt);
      const lastQuad = quads(first).at(-1)!;
      const firstQuad = quads(rest)[0]!;
      expect(firstQuad[0]).toEqual(lastQuad[1]);
      expect(firstQuad[3]).toEqual(lastQuad[2]);
    });

    it("gives a segment without length a quad of numbers, cut for the screen too", () => {
      const pieces = ribbonPieces(
        [
          [48, 16],
          [48, 16],
          [48, 16.01],
        ],
        [1000, 1000, 1000],
        14,
        undefined,
        undefined,
        undefined,
        screenCut(14, 48),
      );

      const coordinates = pieces.flatMap((piece) =>
        piece.geometry.coordinates.flat(3),
      );
      expect(coordinates.length).toBeGreaterThan(0);
      expect(coordinates.every(Number.isFinite)).toBe(true);
    });

    it("merges level pieces whose heights span no more than a step", () => {
      const points: [number, number][] = [
        [48, 16],
        [48, 16.01],
        [48, 16.02],
        [48, 16.03],
      ];
      const cut = { stepFt: 80, spanFt: 80, pixelM: 1 };
      const pieces = ribbonPieces(
        points,
        [1000, 1030, 1000, 1200],
        9,
        undefined,
        undefined,
        undefined,
        cut,
      );

      // Up 30 ft and back in one piece, drawn at the middle of its heights,
      // then a climb of 200 ft in pieces a step apart
      expect(pieces[0]!.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
      expect(pieces[0]!.h).toBeGreaterThanOrEqual(1000);
      expect(pieces[0]!.h).toBeLessThanOrEqual(1080);
      expect(pieces.length).toBeLessThanOrEqual(4);
    });
  });

  describe("ribbonHeights", () => {
    /**
     * What an expression comes to for a feature with `properties` and the
     * feature state `state` in a tile of the zoom `zoom`, as MapLibre works
     * it out: a step by zoom at the tile's own
     */
    const evaluate = (
      expression: unknown,
      zoom: number,
      properties: Record<string, number>,
      state: Record<string, number> = {},
    ): unknown => {
      if (typeof expression === "number") return expression;
      const [op, ...args] = expression as [string, ...unknown[]];
      const at = (arg: unknown): unknown =>
        evaluate(arg, zoom, properties, state);
      const numbers = (): number[] => args.map((arg) => at(arg) as number);
      switch (op) {
        case "zoom":
          return zoom;
        case "get":
          return properties[args[0] as string] ?? null;
        case "feature-state":
          return state[args[0] as string] ?? null;
        case "coalesce":
          return args.map(at).find((value) => value !== null) ?? null;
        case "step": {
          const input = at(args[0]) as number;
          let output = args[1];
          for (let i = 2; i < args.length; i += 2) {
            if (input >= (args[i] as number)) output = args[i + 1];
          }
          return at(output);
        }
        case "case":
          for (let i = 0; i + 1 < args.length; i += 2) {
            if (at(args[i])) return at(args[i + 1]);
          }
          return at(args[args.length - 1]);
        case "<=":
          return (at(args[0]) as number) <= (at(args[1]) as number);
        case ">":
          return (at(args[0]) as number) > (at(args[1]) as number);
        case "*":
          return numbers().reduce((product, value) => product * value, 1);
        case "+":
          return numbers().reduce((sum, value) => sum + value, 0);
        case "-":
          return (at(args[0]) as number) - (at(args[1]) as number);
        case "max":
          return Math.max(...numbers());
      }
      throw new Error(`unknown expression "${op}"`);
    };
    /** A ribbon cut for level 7, over ground that differs at the others */
    const ribbon = { h: 1000, l: 7, "o-2": 300, "o-1": 100, o1: -200 };
    /** Metres of the bottom of `ribbon` at 1000 + `offset` ft, at `e` */
    const bottom = (offset: number, e = liftExaggeration(7)): number =>
      (1000 + offset - LIFT_STEP_FT / 2) * FEET_TO_METERS * e;

    it("stands a ribbon on the ground of the level of each tile", () => {
      const { base } = ribbonHeights();
      const at = (zoom: number): number =>
        evaluate(base, zoom, ribbon) as number;

      expect(at(7.6)).toBeCloseTo(bottom(0), 6);
      // A level in, as a zoom in goes on, and one and two further out
      expect(at(8)).toBeCloseTo(bottom(-200), 6);
      expect(at(6)).toBeCloseTo(bottom(100), 6);
      expect(at(5)).toBeCloseTo(bottom(300), 6);
      // Beyond them, the nearest carried
      expect(at(2)).toBeCloseTo(bottom(300), 6);
      expect(at(14)).toBeCloseTo(bottom(-200), 6);
      // A ground left out is the one the ribbon was cut on
      expect(evaluate(base, 8, { h: 1000, l: 7 })).toBeCloseTo(bottom(0), 6);
    });

    it("takes the exaggeration of its level, or the map's from a feature state", () => {
      const { base } = ribbonHeights();

      expect(evaluate(base, 7, ribbon)).toBeCloseTo(bottom(0), 6);
      // Cut four levels further in: on the ground of the coarsest carried
      expect(evaluate(base, 7, { ...ribbon, l: 11 }, {})).toBeCloseTo(
        (1000 + 300 - LIFT_STEP_FT / 2) * FEET_TO_METERS * liftExaggeration(11),
        6,
      );
      expect(evaluate(base, 7, ribbon, { e: 4 })).toBeCloseTo(bottom(0, 4), 6);
    });

    it("gives each piece its step and a band of the middle of its level, never below the ground", () => {
      const { base, height } = ribbonHeights();
      const band = (zoom: number): number =>
        (evaluate(height, zoom, ribbon) as number) -
        (evaluate(base, zoom, ribbon) as number);

      // A piece reaches half a step below its middle and half above, and
      // a band beyond: the pieces of a slope meet
      const step = LIFT_STEP_FT * FEET_TO_METERS * liftExaggeration(7);
      // Between the stops at 10 and 11 of 200 and 110 m
      expect(band(10.2)).toBeCloseTo(step + 155, 6);
      expect(band(10.9)).toBeCloseTo(band(10.2), 6);
      // A map of half of Europe has one too, and further in it is thinner
      expect(band(3)).toBeGreaterThan(step);
      for (let zoom = 4; zoom < LIFT_MAX_ZOOM - 1; zoom++) {
        expect(band(zoom + 1)).toBeLessThan(band(zoom));
      }
      // On the tiles of a level further out than the one cut for, in the
      // distance of a tilted map, the band of the next level in, as thin
      // as an interpolation by zoom made it there: 1,190 m at zoom 8,
      // between the stops at 7 and 9 of 1,900 and 480 m, and 480 m at 9.
      // Its own level's tiles and those further in have the band of their
      // middle.
      const cutAt9 = { h: 1000, l: 9 };
      const bandOf9 = (zoom: number): number =>
        (evaluate(height, zoom, cutAt9) as number) -
        (evaluate(base, zoom, cutAt9) as number) -
        LIFT_STEP_FT * FEET_TO_METERS * liftExaggeration(9);
      expect(bandOf9(7)).toBeCloseTo(1190, 6);
      expect(bandOf9(8)).toBeCloseTo(480, 6);
      expect(bandOf9(9)).toBeCloseTo(340, 6);
      expect(bandOf9(10)).toBeCloseTo(155, 6);
      // Never below the ground, whatever the other level's ground
      expect(evaluate(base, 8, { h: 0, l: 7, o1: -300 })).toBe(0);
      expect(evaluate(height, 8, { h: 0, l: 7, o1: -300 })).toBeGreaterThan(0);
    });
  });

  describe("the ground of the levels around", () => {
    it("carries each level's ground as an offset to the one cut for", () => {
      const sampled = [420, 430, 400, 900, 1500, 1100, 2000, 2010, 2000];
      const segments = sampled.map((ground_ft, i) => ({
        path_id: 1,
        altitude_ft: 5000,
        groundspeed_knots: 100,
        ground_ft,
        coords: [
          [50, 8 + i / 100],
          [50, 8.01 + i / 100],
        ] as [[number, number], [number, number]],
      }));

      const { ground, offsets } = groundProfilesFt(segments, true, 8);

      expect([...ground]).toEqual([...groundProfileFt(segments, true, 8)]);
      GROUND_LEVELS.forEach((step, k) => {
        const other = groundProfileFt(segments, true, 8 + step);
        expect([...offsets![k]!]).toEqual(
          [...ground].map(
            (feet, i) => expect.closeTo(feet - other[i]!, 9) as unknown,
          ),
        );
      });
      // None beyond the first and the last level
      expect(
        groundProfilesFt(segments, true, 0).offsets![0]!.every((o) => o === 0),
      ).toBe(true);
      expect(
        groundProfilesFt(segments, true, RELIEF_MAX_LEVEL).offsets![
          GROUND_LEVELS.indexOf(1)
        ]!.every((o) => o === 0),
      ).toBe(true);
      // The line between the fields is the same at every level
      expect(groundProfilesFt(segments, false, 8).offsets).toBeNull();
    });

    it("picks the ground of the level of a zoom, the nearest carried beyond them", () => {
      const offsets = [300, 100, -200];

      expect(groundOffsetFt(offsets, 7, 7.9)).toBe(0);
      expect(groundOffsetFt(offsets, 7, 8.1)).toBe(-200);
      expect(groundOffsetFt(offsets, 7, 6.5)).toBe(100);
      expect(groundOffsetFt(offsets, 7, 5)).toBe(300);
      expect(groundOffsetFt(offsets, 7, 1)).toBe(300);
      expect(groundOffsetFt(offsets, 7, 15)).toBe(-200);
      expect(groundOffsetFt(undefined, 7, 8.1)).toBe(0);
      // Beyond the deepest elevation tiles the ground is the same
      expect(groundOffsetFt(offsets, RELIEF_MAX_LEVEL, 16)).toBe(0);
    });

    it("lifts a point above the relief of a zoom, never below it", () => {
      expect(heightOnReliefFt(1000, [300, 100, -200], 7, 8.5)).toBe(800);
      expect(heightOnReliefFt(100, [300, 100, -200], 7, 8.5)).toBe(0);
      expect(
        heightAtZoomFt(
          { heightFt: 1000, offsetsFt: [300, 100, -200], level: 7 },
          6.2,
        ),
      ).toBe(1100);
      expect(heightAtZoomFt({ heightFt: 1000 }, 6.2)).toBe(1000);
      expect(heightAtZoomFt({ heightFt: null }, 6.2)).toBeNull();
    });

    it("interpolates the offsets along the curve as the ground", () => {
      const line = smoothLine(
        [
          [50, 8],
          [50, 8.01],
          [50.01, 8.01],
        ],
        [3000, 3000, 3000],
        { ground: [0, 0, 0], offsets: [[0, 90, 180]] },
      );

      const [level] = line.offsets!;
      expect(level).toHaveLength(line.points.length);
      // The given points keep theirs, the curve between them runs from one
      // to the next
      expect(line.vertex.map((i) => level![i])).toEqual([0, 90, 180]);
      expect(level).toEqual([...level!].sort((a, b) => a - b));
      expect(line.points.length).toBeGreaterThan(3);
    });

    it("hands each piece its offsets at its middle, rounded to under a pixel", () => {
      const pieces = ribbonPieces(
        [
          [50, 8],
          [50, 8.01],
        ],
        [1000, 1040],
        Z,
        undefined,
        undefined,
        [[0, 44]],
      );

      // Two pieces a step each, the offsets of a quarter and three
      // quarters of the way, in steps of 10 ft at zoom 12
      expect(groundOffsetStepFt(Z)).toBe(10);
      expect(pieces.map((piece) => piece.o)).toEqual([[10], [30]]);
      // A level stretch over ground that differs at another level is cut
      // where that rounds to another offset
      const level = ribbonPieces(
        [
          [50, 8],
          [50, 8.01],
          [50, 8.02],
        ],
        [1000, 1000, 1000],
        Z,
        undefined,
        undefined,
        [[0, 0, 40]],
      );
      expect(level.map((piece) => piece.o)).toEqual([[0], [20]]);
    });

    it("rounds the offsets coarser zoomed out, to at most a quarter of a pixel", () => {
      const steps = Array.from({ length: 14 }, (_, zoom) =>
        groundOffsetStepFt(zoom),
      );

      expect(steps).toEqual([...steps].sort((a, b) => b - a));
      expect(groundOffsetStepFt(5)).toBeGreaterThan(40);
      expect(groundOffsetStepFt(11)).toBe(10);
      for (let zoom = 3; zoom < 12; zoom++) {
        const pixelFt =
          40075016.686 /
          (512 * 2 ** (zoom + 0.5)) /
          liftExaggeration(reliefLevel(zoom)) /
          FEET_TO_METERS;
        expect(groundOffsetStepFt(zoom)).toBeLessThanOrEqual(
          Math.max(pixelFt / 4, 10),
        );
      }
    });

    it("writes the offsets that are not nothing, and the id where the map switches the exaggeration", () => {
      const geometry: GeoJSON.MultiPolygon = {
        type: "MultiPolygon",
        coordinates: [],
      };

      expect(
        ribbonProperties({ h: 1000, o: [0, 40, -80], geometry }, 7, 0),
      ).toEqual({ h: 1000, l: 7, k: 7, "o-1": 40, o1: -80 });
      expect(ribbonProperties({ h: 1000, geometry }, 5, 0)).toEqual({
        h: 1000,
        l: 5,
      });
      // Every visit of a level has ids of its own, which no other level's
      // cut has in any visit
      expect(ribbonProperties({ h: 1000, geometry }, 7, 3).k).toBe(
        ribbonId(7, 3),
      );
      const ids = [0, 1, 2, 3].flatMap((epoch) =>
        [7, 8, 9, 10].map((level) => ribbonId(level, epoch)),
      );
      expect(new Set(ids).size).toBe(ids.length);
      // The ribbons of a level next to one of another exaggeration
      expect(
        Array.from(
          { length: RELIEF_MAX_LEVEL + 1 },
          (_, level) => level,
        ).filter(switchesExaggeration),
      ).toEqual([7, 8, 9, 10]);
      expect(ribbonHeightFt({ h: 1000, l: 7, "o-1": 40, o1: -80 }, 8.4)).toBe(
        920,
      );
    });

    it("tells which cuts stay on the relief of another level until cut for it", () => {
      // The same exaggeration, or one they switch to by their id
      expect(followsLevel(3, 7)).toBe(true);
      expect(followsLevel(10, 11)).toBe(true);
      expect(followsLevel(8, 6)).toBe(true);
      expect(followsLevel(7, 10)).toBe(true);
      // Without an id, into another exaggeration
      expect(followsLevel(6, 8)).toBe(false);
      expect(followsLevel(11, 7)).toBe(false);
      expect(followsLevel(11, 9)).toBe(false);
    });
  });

  describe("reliefLevel and liftExaggeration", () => {
    it("follows the whole zoom level up to the one on the deepest elevation tiles", () => {
      expect(reliefLevel(4.9)).toBe(4);
      expect(reliefLevel(9)).toBe(9);
      expect(reliefLevel(TERRAIN_TILE_MAX_ZOOM + 1.5)).toBe(
        TERRAIN_TILE_MAX_ZOOM + 1,
      );
      expect(reliefLevel(LIFT_MAX_ZOOM + 2)).toBe(TERRAIN_TILE_MAX_ZOOM + 1);
    });

    it("exaggerates more zoomed out, at most ten times and twice closer in", () => {
      const levels = Array.from({ length: 20 }, (_, level) => level);
      const exaggerations = levels.map(liftExaggeration);

      expect(exaggerations).toEqual([...exaggerations].sort((a, b) => b - a));
      expect(Math.max(...exaggerations)).toBe(10);
      // Over a region still some times the height, at zoom 7 to 9
      expect([7, 8, 9].map(liftExaggeration)).toEqual([10, 7, 4]);
      expect(liftExaggeration(10)).toBe(2);
      expect(liftExaggeration(reliefLevel(20))).toBe(2);
    });
  });

  describe("smoothAlong and reliefPixelM", () => {
    const along = Array.from({ length: 101 }, (_, i) => i * 100);

    it("spreads a peak over two pixels either side, and keeps its volume", () => {
      const peak = along.map((_, i) => (i === 50 ? 1000 : 0));
      const smoothed = smoothAlong(peak, along, 500);

      // Twice an average over 1 km: a triangle 1 km either side
      expect(smoothed[50]).toBeLessThan(200);
      expect(smoothed[39]).toBe(0);
      expect(smoothed[45]).toBeGreaterThan(0);
      expect(smoothed[45]).toBeCloseTo(smoothed[55]!, 6);
      expect(smoothed.reduce((a, b) => a + b, 0)).toBeCloseTo(1000, 0);
    });

    it("keeps a slope and a flat stretch as they are", () => {
      const slope = along.map((metres) => metres / 10);
      const smoothed = smoothAlong(slope, along, 500);

      // Away from the ends, where the average is of the part flown
      for (let i = 10; i <= 90; i++) {
        expect(smoothed[i]).toBeCloseTo(slope[i]!, 6);
      }
      expect(smoothAlong([300, 300, 300], [0, 50, 5000], 5000)).toEqual([
        300, 300, 300,
      ]);
    });

    it("takes the tiles a level coarser than the ribbons, down to the deepest", () => {
      // 256 pixel tiles; a level coarser is twice as wide
      expect(reliefPixelM(5, 0)).toBeCloseTo(40075016.686 / (256 * 2 ** 4), 3);
      expect(reliefPixelM(5, 60)).toBeCloseTo(reliefPixelM(5, 0) / 2, 3);
      expect(reliefPixelM(9, 0)).toBeCloseTo(reliefPixelM(8, 0) / 2, 3);
      expect(reliefPixelM(TERRAIN_TILE_MAX_ZOOM + 3, 0)).toBeCloseTo(
        reliefPixelM(TERRAIN_TILE_MAX_ZOOM + 1, 0),
        3,
      );
    });
  });

  describe("isLiftedAt and airplaneLiftPx", () => {
    it("lifts the flights up to the zoom where the camera is lower than a circuit", () => {
      expect(isLiftedAt(3)).toBe(true);
      expect(isLiftedAt(LIFT_MAX_ZOOM - 0.01)).toBe(true);
      expect(isLiftedAt(LIFT_MAX_ZOOM)).toBe(false);
    });

    it("puts the airplane on the ground where the trail is its line again", () => {
      const map = createMapLibreMock() as unknown as MapLibreMap;
      map.jumpTo({ zoom: 12, pitch: 60 });

      expect(airplaneLiftPx(map, 50, 1000, 2)).toBeGreaterThan(0);
      expect(airplaneLiftPx(map, 50, 1000, 2, LIFT_MAX_ZOOM)).toBe(0);
      expect(airplaneLiftPx(map, 50, null, 2)).toBe(0);
    });
  });

  describe("liftOffsetPx", () => {
    const map = (): MapLibreMap =>
      createMapLibreMock() as unknown as MapLibreMap;

    it("takes no room on a flat map", () => {
      const flat = map();
      flat.jumpTo({ zoom: 12, pitch: 0 });

      expect(liftOffsetPx(flat, 51, 1000, 2)).toBe(0);
    });

    it("grows with the height, the tilt and the zoom", () => {
      const tilted = map();
      tilted.jumpTo({ zoom: 12, pitch: 60 });
      const at1000 = liftOffsetPx(tilted, 51, 1000, 2);
      expect(at1000).toBeGreaterThan(0);
      expect(liftOffsetPx(tilted, 51, 2000, 2)).toBeCloseTo(at1000 * 2, 6);

      tilted.jumpTo({ zoom: 12, pitch: 30 });
      expect(liftOffsetPx(tilted, 51, 1000, 2)).toBeLessThan(at1000);

      tilted.jumpTo({ zoom: 14, pitch: 60 });
      expect(liftOffsetPx(tilted, 51, 1000, 2)).toBeGreaterThan(at1000);
    });

    it("exaggerates the heights as it is told, not by the zoom's level", () => {
      const tilted = map();
      // The level the map is drawn for stays until a zoom ends: in the
      // middle of one across it, the zoom's own level is not the one drawn
      for (const [zoom, level] of [
        [2, 2],
        [7.9, 6],
        [8.4, 7],
        [9.6, 8],
        [13, 13],
      ] as const) {
        tilted.jumpTo({ zoom, pitch: 90 });
        const metresPerPixel =
          (40075016.686 * Math.cos((51 * Math.PI) / 180)) / (512 * 2 ** zoom);
        const exaggeration = liftExaggeration(level);

        expect(
          (liftOffsetPx(tilted, 51, 1000, exaggeration) * metresPerPixel) /
            (1000 * FEET_TO_METERS),
        ).toBeCloseTo(exaggeration, 6);
      }
    });

    it("draws 1,000 ft about as the ribbons do at zoom 13", () => {
      const tilted = map();
      tilted.jumpTo({ zoom: 13, pitch: 90 });
      // Twice exaggerated at zoom 13, about 609.6 m, over the metres of a pixel
      const metresPerPixel =
        (40075016.686 * Math.cos((51 * Math.PI) / 180)) / (512 * 2 ** 13);

      expect(liftOffsetPx(tilted, 51, 1000, 2)).toBeCloseTo(
        (2000 * FEET_TO_METERS) / metresPerPixel,
        3,
      );
    });
  });

  describe("the flights smoothed on their ground (groundedFlights)", () => {
    const sampled = [420, 430, 400, 900, 1500, 1100, 2000, 2010, 2000];
    const segments = sampled.map((ground_ft, i) => ({
      path_id: 1,
      altitude_ft: 5000,
      groundspeed_knots: 100,
      ground_ft,
      coords: [
        [50, 8 + i / 100],
        [50, 8.01 + i / 100],
      ] as [[number, number], [number, number]],
    }));

    afterEach(() => releaseGroundedFlights());

    it("smooths once for the ribbons and the heat cloud, on the ground of the level", () => {
      const flights = groundedFlights(segments, true, 8);
      expect(groundedFlights(segments, true, 8)).toBe(flights);
      const ground = groundProfileFt(segments, true, 8);
      // The ground under the end of every segment, on the curve
      segments.forEach((_, i) => {
        const chain = flights.chains[flights.chainOf[i]!]!;
        expect(chain.ground![flights.to[i]!]).toBeCloseTo(ground[i]!, 9);
      });
      expect(heldGroundedFlights()).toBe(segments);
    });

    it("smooths anew for another level on the relief, another ground or another dataset", () => {
      const flights = groundedFlights(segments, true, 8);
      expect(groundedFlights(segments, true, 9)).not.toBe(flights);
      const flat = groundedFlights(segments, false, 9);
      // The line between the fields is the same at every level
      expect(groundedFlights(segments, false, 4)).toBe(flat);
      const copy = segments.map((segment) => ({ ...segment }));
      expect(groundedFlights(copy, false, 4)).not.toBe(flat);
      expect(heldGroundedFlights()).toBe(copy);
    });

    it("lets go of them with the ground of the levels, as the 3D view goes", () => {
      groundedFlights(segments, true, 8);
      releaseGroundProfiles();
      expect(heldGroundedFlights()).toBeNull();
    });

    describe("smoothed once, and set on the ground of every level", () => {
      /**
       * A flight of `count` segments from `lng`, turning as it goes, so its
       * curve has points between its fixes, over the ground `groundOf` and
       * climbing out and back, and taxiing at either end
       */
      const turning = (
        path_id: number,
        lng: number,
        count: number,
        groundOf: (i: number) => number | undefined,
      ): PathSegment[] => {
        const at = (i: number): [number, number] => [
          47 + 0.02 * Math.sin(i / 2),
          lng + 0.01 * i + 0.01 * Math.cos(i / 3),
        ];
        return Array.from({ length: count }, (_, i) => {
          const taxiing = i < 3 || i >= count - 3;
          return {
            path_id,
            coords: [at(i), at(i + 1)],
            // A dip below the ground on the way, as a glitch of a recorder
            altitude_ft: taxiing ? 1500 : i === 9 ? 900 : 1500 + 400 * i,
            groundspeed_knots: taxiing ? 10 : 100,
            ground_ft: groundOf(i),
          };
        });
      };
      const dataset: PathSegment[] = [
        ...turning(1, 11, 24, (i) => 1400 + 700 * Math.sin(i)),
        // Without a sampled ground, on the line between its fields
        ...turning(2, 12, 16, () => undefined),
        // Two chains of one flight, a gap in its log between them
        ...turning(3, 13, 10, (i) => 1300 + 90 * i),
        ...turning(3, 13.5, 10, (i) => 2200 - 50 * i),
      ];

      /** The flights as smoothing on the ground of the level gives them */
      const onTheirGround = (sampled: boolean, level: number) => {
        const { ground, offsets } = groundProfilesFt(dataset, sampled, level);
        return smoothFlights(dataset, (i) => dataset[i]!.altitude_ft, {
          groundOf: (i) => ground[i]!,
          offsets,
        });
      };

      afterEach(() => releaseGroundProfiles());

      it("are what smoothing them on that ground gives, to the bit", () => {
        for (const sampled of [true, false]) {
          for (let level = 0; level <= RELIEF_MAX_LEVEL; level++) {
            const flights = groundedFlights(dataset, sampled, level);
            const expected = onTheirGround(sampled, level);
            expect(flights).toEqual(expected);
            expect(smoothGrounded(dataset, sampled, level)).toEqual(expected);
          }
        }
        // Points between the fixes, some flights below their ground, and
        // the ground of the other levels, which all of it runs along
        const flights = groundedFlights(dataset, true, 8);
        const [first] = flights.chains;
        expect(first!.points.length).toBeGreaterThan(first!.vertex.length);
        expect(first!.heights).toContain(0);
        expect(first!.offsets).toHaveLength(GROUND_LEVELS.length);
        expect(flights.chains).toHaveLength(4);
      });

      it("share the curve and where each segment is on it, which is smoothed once for the dataset", () => {
        const at8 = groundedFlights(dataset, true, 8);
        const at9 = groundedFlights(dataset, true, 9);
        const flat = groundedFlights(dataset, false, 9);
        for (const other of [at9, flat]) {
          expect(other).not.toBe(at8);
          expect(other.chainOf).toBe(at8.chainOf);
          other.chains.forEach((chain, c) => {
            expect(chain.points).toBe(at8.chains[c]!.points);
            expect(chain.vertex).toBe(at8.chains[c]!.vertex);
          });
        }
        // Until the flights are let go of
        releaseGroundedFlights();
        expect(groundedFlights(dataset, true, 8).chains[0]!.points).not.toBe(
          at8.chains[0]!.points,
        );
      });

      it("take the curves and the ground of flights another dataset of the 3D view had, as all years share a year's segments", () => {
        const year = dataset.filter((segment) => segment.path_id !== 2);
        const others = dataset.filter((segment) => segment.path_id === 2);
        const combined = [...others, ...year];
        holdGroundProfiles(true);
        const ofYear = groundedFlights(year, true, 8);
        releaseGroundedFlights();
        const all = groundedFlights(combined, true, 8);
        // The curves of the year's flights, after the other flight's
        all.chains.slice(1).forEach((chain, c) => {
          expect(chain.points).toBe(ofYear.chains[c]!.points);
        });
        // As all of it smoothed anew gives
        releaseGroundProfiles();
        expect(groundedFlights(combined, true, 8)).toEqual(all);
        // Outside the 3D view they go with the flights of the dataset
        const again = groundedFlights(year, true, 8);
        holdGroundProfiles(false);
        releaseGroundedFlights();
        expect(groundedFlights(year, true, 8).chains[0]!.points).not.toBe(
          again.chains[0]!.points,
        );
      });

      it("are smoothed anew for a few flights alone, and not held (smoothGrounded)", () => {
        const flights = groundedFlights(dataset, true, 8);
        const alone = smoothGrounded(dataset, true, 8);
        expect(alone).toEqual(flights);
        expect(alone.chains[0]!.points).not.toBe(flights.chains[0]!.points);
        expect(groundedFlights(dataset, true, 8)).toBe(flights);
      });

      it("keep the few flights of keptGrounded until the flights are let go of", () => {
        const first = dataset[0]!.path_id;
        const one = (id: number) => id === first;
        const kept = keptGrounded(dataset, one, true, 8);
        expect(kept.segments.every((s) => s.path_id === first)).toBe(true);
        expect(keptGrounded(dataset, one, true, 8)).toBe(kept);
        // Gone with the flights of the dataset, all years among them
        releaseGroundedFlights();
        expect(keptGrounded(dataset, one, true, 8)).not.toBe(kept);
      });
    });
  });
});

describe("sameOffsets", () => {
  it("tells the offsets of the ground apart, a prefix included", () => {
    expect(sameOffsets(undefined, undefined)).toBe(true);
    expect(sameOffsets([1, 2], [1, 2])).toBe(true);
    expect(sameOffsets([1, 2], [1, 3])).toBe(false);
    expect(sameOffsets([1, 2], undefined)).toBe(false);
    // The copy of the ribbons took a prefix for the whole
    expect(sameOffsets([1], [1, 2])).toBe(false);
    expect(sameOffsets([1, 2], [1])).toBe(false);
  });
});
