/**
 * The cross-section (calculations/crossSection.ts): the line's own plane,
 * the corridor it cuts the flights with, and the time binned by distance
 * along it and height.
 */
import { describe, it, expect } from "vitest";
import {
  clipToCorridor,
  corridorCorners,
  corridorForScale,
  corridorOutline,
  crossSection,
  fromFrame,
  lineFrame,
  smoothCells,
  toFrame,
  windowSeconds,
  type SectionRequest,
} from "../../../../flown/frontend/calculations/crossSection";
import { heatWeight } from "../../../../flown/frontend/calculations/heatLines";
import type { PathSegment } from "../../../../flown/frontend/types";
import type { Coordinate } from "../../../../flown/frontend/utils/geometry";

/** Degrees of longitude of 5 km east at 50 degrees north */
const FIVE_KM_EAST = 5000 / (111320 * Math.cos((50 * Math.PI) / 180));

/** A line 5 km due east from 50 N, 8 E */
const START: Coordinate = [50, 8];
const END: Coordinate = [50, 8 + FIVE_KM_EAST];

/** Latitude step of the crossing flights: about 222 m */
const STEP = 0.002;

interface Crossing {
  pathId?: number;
  /** Longitude it crosses at; the middle of the line by default */
  lon?: number;
  altitudeFt?: number | ((i: number) => number);
  /** Null for a flight without the terrain under it */
  groundFt?: number | null;
  /** Seconds a segment takes */
  stepS?: number;
  knots?: number;
}

/**
 * A flight due north across the line, from 20 segments south of it to 20
 * north, at a steady altitude over steady ground
 */
function crossing({
  pathId = 1,
  lon = 8 + FIVE_KM_EAST / 2,
  altitudeFt = 1300,
  groundFt = 300,
  stepS = 10,
  knots = 90,
}: Crossing = {}): PathSegment[] {
  return Array.from({ length: 40 }, (_, i) => ({
    path_id: pathId,
    coords: [
      [50 - 20 * STEP + i * STEP, lon],
      [50 - 20 * STEP + (i + 1) * STEP, lon],
    ],
    altitude_ft: typeof altitudeFt === "number" ? altitudeFt : altitudeFt(i),
    groundspeed_knots: knots,
    time: i * stepS,
    ...(groundFt === null ? {} : { ground_ft: groundFt }),
  }));
}

function request(
  segments: PathSegment[],
  overrides: Partial<SectionRequest> = {},
): SectionRequest {
  return {
    segments,
    keep: () => true,
    start: START,
    end: END,
    halfWidthM: 500,
    reference: "agl",
    columns: 100,
    rows: 50,
    ...overrides,
  };
}

/** The column and row of the cell with the most time */
function fullest(section: ReturnType<typeof crossSection>): [number, number] {
  let best = 0;
  section.seconds.forEach((value, i) => {
    if (value > section.seconds[best]!) best = i;
  });
  return [best % section.columns, Math.floor(best / section.columns)];
}

describe("the line's plane", () => {
  it("measures along the line and across it, the left positive", () => {
    const frame = lineFrame(START, END);
    expect(frame.lengthM).toBeCloseTo(5000, 0);

    const [along, across] = toFrame(frame, [50.001, 8 + FIVE_KM_EAST / 2]);
    expect(along).toBeCloseTo(2500, 0);
    // North is to the left of a line due east
    expect(across).toBeCloseTo(111.32, 1);
  });

  it("goes back from the plane to the map", () => {
    const frame = lineFrame([51.5, 12], [51.6, 11.9]);
    const point: Coordinate = [51.55, 11.97];
    const [along, across] = toFrame(frame, point);
    const back = fromFrame(frame, along, across);
    expect(back[0]).toBeCloseTo(point[0], 9);
    expect(back[1]).toBeCloseTo(point[1], 9);
  });

  it("takes the short way round across the antimeridian", () => {
    const frame = lineFrame([0, 179.99], [0, -179.99]);
    expect(frame.lengthM).toBeCloseTo(0.02 * 111320, 0);
    expect(toFrame(frame, [0, 180])[0]).toBeCloseTo(0.01 * 111320, 0);
  });

  it("has a direction even without a length", () => {
    const frame = lineFrame(START, START);
    expect(frame.lengthM).toBe(0);
    expect([frame.ux, frame.uy]).toEqual([1, 0]);
  });

  it("puts the corridor's corners either side of the ends", () => {
    const frame = lineFrame(START, END);
    const corners = corridorCorners(frame, 500).map((corner) =>
      toFrame(frame, corner).map((metres) => Math.round(metres)),
    );
    expect(corners).toEqual([
      [0, 500],
      [5000, 500],
      [5000, -500],
      [0, -500],
    ]);
  });
});

describe("corridorOutline", () => {
  it("cuts the sides so the map draws the corridor that is counted", () => {
    // Long and slanted: straight in latitude and longitude, which a
    // Mercator map would bend between the corners
    const frame = lineFrame([50, 8], [52, 10]);
    const { ring, line } = corridorOutline(frame, 500, 4);
    expect(ring).toHaveLength(11);
    expect(ring[10]).toEqual(ring[0]);
    expect(line).toHaveLength(5);
    const measured = ring.map((point) =>
      toFrame(frame, point).map((metres) => Math.round(metres) + 0),
    );
    const quarter = Math.round(frame.lengthM / 4);
    expect(measured[1]).toEqual([quarter, 500]);
    expect(measured[4]).toEqual([Math.round(frame.lengthM), 500]);
    expect(measured[5]).toEqual([Math.round(frame.lengthM), -500]);
    expect(measured[9]).toEqual([0, -500]);
    expect(toFrame(frame, line[2]!)[1]).toBeCloseTo(0, 6);
  });
});

describe("smoothCells", () => {
  it("spreads a cell a cell either way, and no further", () => {
    const values = new Float64Array(5 * 5);
    values[2 * 5 + 2] = 16;
    const smoothed = smoothCells(values, 5, 5);
    expect(smoothed[2 * 5 + 2]).toBe(4);
    expect(smoothed[2 * 5 + 1]).toBe(2);
    expect(smoothed[1 * 5 + 1]).toBe(1);
    expect(smoothed[2 * 5 + 0]).toBe(0);
    expect(smoothed[0 * 5 + 2]).toBe(0);
  });

  it("keeps a full edge as full", () => {
    const smoothed = smoothCells(new Float64Array(6).fill(3), 3, 2);
    expect([...smoothed]).toEqual([3, 3, 3, 3, 3, 3]);
  });

  it("writes into the grids it is handed, whatever they held", () => {
    const values = new Float64Array(5 * 5);
    values[2 * 5 + 2] = 16;
    const out = new Float64Array(25).fill(9);
    const across = new Float64Array(25).fill(9);

    expect(smoothCells(values, 5, 5, out, across)).toBe(out);
    expect([...out]).toEqual([...smoothCells(values, 5, 5)]);
  });
});

describe("clipToCorridor", () => {
  it("keeps a segment inside whole", () => {
    expect(clipToCorridor([100, 0], [200, 50], 1000, 100)).toEqual([0, 1]);
  });

  it("cuts a segment across the corridor to its part inside", () => {
    const span = clipToCorridor([500, -300], [500, 300], 1000, 100)!;
    expect(span[0]).toBeCloseTo(1 / 3);
    expect(span[1]).toBeCloseTo(2 / 3);
  });

  it("cuts at the ends of the line", () => {
    const span = clipToCorridor([-500, 0], [500, 0], 250, 100)!;
    expect(span[0]).toBeCloseTo(0.5);
    expect(span[1]).toBeCloseTo(0.75);
  });

  it("leaves out a segment beside the corridor", () => {
    // Parallel to it, and outside
    expect(clipToCorridor([0, 200], [1000, 200], 1000, 100)).toBeNull();
    // Across it, beyond its end
    expect(clipToCorridor([1500, -300], [1500, 300], 1000, 100)).toBeNull();
    // Heading away from it
    expect(clipToCorridor([500, 150], [600, 400], 1000, 100)).toBeNull();
    expect(clipToCorridor([500, 400], [600, 150], 1000, 100)).toBeNull();
    // Touching its edge only
    expect(clipToCorridor([500, 100], [500, 300], 1000, 100)).toBeNull();
  });
});

describe("crossSection", () => {
  it("bins the time of a crossing by distance and height above the ground", () => {
    const section = crossSection(request(crossing()));

    // About 1,000 m of it, 222 m every 10 s
    expect(section.totalSeconds).toBeGreaterThan(40);
    expect(section.totalSeconds).toBeLessThan(50);
    expect(section.flights).toBe(1);
    expect(section.lengthM).toBeCloseTo(5000, 0);
    expect(section.fromTerrain).toBe(true);
    // Every second is in the grid, above none
    const binned = section.seconds.reduce((sum, value) => sum + value, 0);
    expect(binned).toBeCloseTo(section.totalSeconds, 6);
    expect(section.aboveSeconds).toBe(0);

    const [column, row] = fullest(section);
    expect(column).toBeGreaterThanOrEqual(49);
    expect(column).toBeLessThanOrEqual(50);
    const rowFt = (section.topFt - section.bottomFt) / section.rows;
    expect(section.bottomFt + row * rowFt).toBeLessThanOrEqual(1000);
    expect(section.bottomFt + (row + 1) * rowFt).toBeGreaterThan(1000);
    // From the ground to over 1,000 ft, in whole steps of its grid
    expect(section.bottomFt).toBe(0);
    expect(section.topFt).toBeGreaterThan(1000);
    expect(section.topFt % section.gridStepFt).toBe(0);
    expect(section.busiest![0]).toBeLessThanOrEqual(1000);
    expect(section.busiest![1]).toBeGreaterThan(1000);
  });

  it("counts the time a segment takes, at most two minutes of it", () => {
    const slow = crossSection(request(crossing({ stepS: 600 })));
    // Every segment adds its capped two minutes, five of them inside
    expect(slow.totalSeconds).toBeGreaterThan(4 * 120);
    expect(slow.totalSeconds).toBeLessThan(5 * 120);
  });

  it("counts the flights the filter keeps only", () => {
    const segments = [...crossing(), ...crossing({ pathId: 2 })];
    expect(crossSection(request(segments)).flights).toBe(2);

    const one = crossSection(request(segments, { keep: (id) => id === 2 }));
    expect(one.flights).toBe(1);

    const none = crossSection(request(segments, { keep: () => false }));
    expect(none.totalSeconds).toBe(0);
    expect(none.flights).toBe(0);
    expect(none.groundFt).toBeNull();
    expect(none.busiest).toBeNull();
    // An empty chart still spans the least height
    expect(none.topFt).toBe(1000);
  });

  it("leaves out flights beside the corridor", () => {
    const beside = crossing({ lon: 8 + FIVE_KM_EAST * 2 });
    const passing: PathSegment[] = beside.map((segment) => ({
      ...segment,
      coords: [
        [51, segment.coords[0][1]],
        [51.001, segment.coords[1][1]],
      ],
    }));
    const section = crossSection(request([...beside, ...passing]));
    expect(section.totalSeconds).toBe(0);
  });

  it("measures every segment that reaches into a corridor, whichever way it runs", () => {
    // Wandering flights over a few dozen kilometres, a long jump among them
    let seed = 7;
    const random = (): number =>
      (seed = (seed * 16807) % 2147483647) / 2147483647;
    const segments: PathSegment[] = [];
    let at: Coordinate = [49.9, 7.9];
    for (let i = 0; i < 3000; i++) {
      const to: Coordinate =
        i === 1500
          ? [50.3, 8.4]
          : [at[0] + (random() - 0.5) * 0.01, at[1] + (random() - 0.5) * 0.01];
      segments.push({
        path_id: Math.floor(i / 300),
        coords: [at, to],
        altitude_ft: 1000 + i,
        groundspeed_knots: 90,
        time: i * 5,
        ground_ft: 300,
      });
      at = to;
    }
    for (let k = 0; k < 20; k++) {
      const start: Coordinate = [49.85 + random() * 0.4, 7.85 + random() * 0.6];
      const end: Coordinate = [49.85 + random() * 0.4, 7.85 + random() * 0.6];
      const halfWidthM = [250, 1000, 5000][k % 3]!;
      // Every segment measured, without the index
      const frame = lineFrame(start, end);
      let seconds = 0;
      const flights = new Set<number>();
      segments.forEach((segment, i) => {
        const span = clipToCorridor(
          toFrame(frame, segment.coords[0]),
          toFrame(frame, segment.coords[1]),
          frame.lengthM,
          halfWidthM,
        );
        const spent = heatWeight(segment, segments[i + 1]);
        if (!span || !(spent > 0)) return;
        seconds += spent * (span[1] - span[0]);
        flights.add(segment.path_id);
      });

      const section = crossSection(
        request(segments, { start, end, halfWidthM }),
      );
      expect(section.totalSeconds).toBeCloseTo(seconds, 6);
      expect(section.flights).toBe(flights.size);
    }
  });

  it("keeps a corridor across the antimeridian measuring every segment", () => {
    const across: PathSegment[] = crossing({ lon: 180 }).map((segment) => ({
      ...segment,
      coords: [
        [segment.coords[0][0], 180],
        [segment.coords[1][0], -180],
      ],
    }));
    const section = crossSection(
      request(across, { start: [50, 179.97], end: [50, -179.97] }),
    );
    expect(section.totalSeconds).toBeGreaterThan(0);
  });

  it("draws above sea level over the ground under the flights", () => {
    const section = crossSection(request(crossing(), { reference: "msl" }));

    const [, row] = fullest(section);
    const rowFt = (section.topFt - section.bottomFt) / section.rows;
    expect(section.bottomFt + row * rowFt).toBeLessThanOrEqual(1300);
    expect(section.bottomFt + (row + 1) * rowFt).toBeGreaterThan(1300);
    // From below the ground, in steps of the grid
    expect(section.bottomFt).toBeLessThanOrEqual(300);
    expect(section.bottomFt % section.gridStepFt).toBe(0);
    // The ground of the one column with fixes, carried to both ends
    expect([...section.groundFt!].every((feet) => feet === 300)).toBe(true);
    expect(section.busiest![0]).toBeLessThanOrEqual(1300);
  });

  it("carries the ground in a line between the columns with fixes", () => {
    const west = crossing({ lon: 8 + FIVE_KM_EAST * 0.1, groundFt: 200 });
    const east = crossing({
      pathId: 2,
      lon: 8 + FIVE_KM_EAST * 0.9,
      groundFt: 600,
    });
    const section = crossSection(
      request([...west, ...east], { reference: "msl" }),
    );
    const ground = section.groundFt!;
    expect(ground[0]).toBe(200);
    expect(ground[99]).toBe(600);
    expect(ground[50]).toBeGreaterThan(300);
    expect(ground[50]).toBeLessThan(500);
  });

  it("stands a flight without terrain on its field", () => {
    // Taxiing at 300 ft before it crosses, so its field is there
    const taxi: PathSegment[] = Array.from({ length: 10 }, (_, i) => ({
      path_id: 1,
      coords: [
        [49, 8 + i * 0.001],
        [49, 8 + (i + 1) * 0.001],
      ],
      altitude_ft: 300,
      groundspeed_knots: 10,
    }));
    const section = crossSection(
      request([...taxi, ...crossing({ groundFt: null })]),
    );
    expect(section.fromTerrain).toBe(false);
    expect(section.busiest![0]).toBeLessThanOrEqual(1000);
    expect(section.busiest![1]).toBeGreaterThan(1000);
    // Measured once per dataset
    const again = crossSection(
      request([...taxi, ...crossing({ groundFt: null })]),
    );
    expect(again.busiest).toEqual(section.busiest);
  });

  it("climbs from the altitude of the segment before", () => {
    const climbing = crossing({ altitudeFt: (i) => 500 + i * 50 });
    const section = crossSection(request(climbing));
    const rows = new Set<number>();
    section.seconds.forEach((value, i) => {
      if (value > 0) rows.add(Math.floor(i / section.columns));
    });
    // About five segments inside, 50 ft apart: the rows between their
    // ends are filled in too
    expect(rows.size).toBeGreaterThan(5);
  });

  it("leaves a flight far above the rest off the top", () => {
    const low = crossing({ stepS: 600 });
    const high = crossing({ pathId: 2, altitudeFt: 20000, stepS: 0.02 });
    const section = crossSection(request([...low, ...high]));
    expect(section.topFt).toBeLessThan(5000);
    expect(section.aboveSeconds).toBeGreaterThan(0);
    expect(section.flights).toBe(2);
  });

  it("names the height flown most, not the time on the ground", () => {
    const apron = crossing({ altitudeFt: 300, stepS: 600, knots: 5 });
    const circuit = crossing({ pathId: 2, altitudeFt: 1300 });
    const section = crossSection(request([...apron, ...circuit]));
    const [, row] = fullest(section);
    // The most time is on the ground
    expect(row).toBe(0);
    expect(section.busiest![0]).toBeLessThanOrEqual(1000);
    expect(section.busiest![1]).toBeGreaterThan(1000);

    const msl = crossSection(
      request([...apron, ...circuit], { reference: "msl" }),
    );
    expect(msl.busiest![0]).toBeLessThanOrEqual(1300);
    expect(msl.busiest![1]).toBeGreaterThan(1300);
  });
});

describe("windowSeconds", () => {
  it("adds up the cells around one, as far as the grid reaches", () => {
    const section = crossSection(request(crossing()));
    const [column, row] = fullest(section);
    const cell = section.seconds[row * section.columns + column]!;
    expect(windowSeconds(section, column, row, 0)).toBe(cell);
    expect(windowSeconds(section, column, row, 50)).toBeCloseTo(
      section.totalSeconds,
      6,
    );
    expect(windowSeconds(section, 0, 0, 1)).toBe(0);
  });
});

describe("corridorForScale", () => {
  it("picks the half width nearest to the pixels asked for", () => {
    // About 12 m a pixel: a circuit at zoom 12
    expect(corridorForScale(12)).toBe(500);
    expect(corridorForScale(1)).toBe(250);
    expect(corridorForScale(50)).toBe(2000);
    expect(corridorForScale(1000)).toBe(5000);
    expect(corridorForScale(12, 100)).toBe(1000);
  });
});
