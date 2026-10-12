import { describe, it, expect } from "vitest";
import {
  exposedHeat,
  heatColumns,
  heatExposure,
} from "../../../../flown/frontend/calculations/heatExposure";
import {
  HEAT_KNEE,
  heatTone,
} from "../../../../flown/frontend/calculations/heatTone";

/** Points and the heat of each, as heatmapPoints hands them over */
interface Points {
  points: [number, number][];
  weights: number[];
}

/** A track of `count` fixes 150 m apart to the east, of heat `w` each */
const track = (count: number, w: number): Points => ({
  points: Array.from({ length: count }, (_, i): [number, number] => [
    51,
    12 + i * 0.0022,
  ]),
  weights: Array.from({ length: count }, () => w),
});

/** Tracks that overlap `times` times, and around them one lone track */
const busy = (times: number): Points => {
  const lone = track(1000, 1);
  const over = track(100, times);
  return {
    points: [
      ...lone.points.map(([lat, lng]): [number, number] => [lat + 1, lng]),
      ...over.points,
    ],
    weights: [...lone.weights, ...over.weights],
  };
};

/** The exposure of `heat`, as the year worker works it out */
const exposureOf = ({ points, weights }: Points): number =>
  heatExposure(heatColumns(points, weights));

describe("heatColumns", () => {
  it("packs each point and its heat as `[lat, lng, heat]`, one after the other", () => {
    expect([
      ...heatColumns(
        [
          [50, 8],
          [51, 9],
        ],
        [2, 0.5],
      ),
    ]).toEqual([50, 8, 2, 51, 9, 0.5]);
    expect(heatColumns([], [])).toHaveLength(0);
  });
});

describe("heatExposure", () => {
  it("leaves heat that is not there as it is", () => {
    expect(exposureOf({ points: [], weights: [] })).toBe(1);
  });

  it("scales the busiest places of the heat to the same colour", () => {
    const a = exposureOf(busy(4));
    const b = exposureOf(busy(8));

    expect(b).toBeCloseTo(a / 2);
    expect(a).toBeGreaterThan(0.25);
    expect(a).toBeLessThan(3);
  });

  it("takes a lone flight's route, not the airfields it stood on, for its busiest places", () => {
    const route = track(100, 1);
    const stood = {
      points: [...route.points, route.points[0]!, route.points[99]!],
      weights: [...route.weights, 300, 300],
    };

    expect(exposureOf(stood)).toBe(exposureOf(route));
  });

  it("neither lights a lone short flight like a year, nor dims a logbook to nothing", () => {
    expect(exposureOf(track(10, 1))).toBe(3);
    expect(exposureOf(track(10, 1e6))).toBe(0.25);
  });
});

describe("exposedHeat", () => {
  it("rolls off the heat of the busiest cells and leaves the rest as it is", () => {
    const heat = busy(400);
    const { weights } = heat;
    const drawn = exposedHeat(heatColumns(heat.points, weights));

    expect(drawn.exposure).toBe(exposureOf(heat));
    expect(drawn.weights).toHaveLength(weights.length);
    // The lone track, under the knee, only scaled
    for (let i = 0; i < 1000; i++) {
      expect(drawn.weights[i]).toBe(weights[i]! * drawn.exposure);
    }
    // The track flown 400 times rolled off, all of its points alike in a
    // cell, so a place keeps its share of the cell's heat
    const factors = [...drawn.weights.slice(1000)].map(
      (weight, i) => weight / (weights[1000 + i]! * drawn.exposure),
    );
    expect(Math.max(...factors)).toBeLessThan(1);
    // By the roll-off of a cell's heat, as many flights' worth as drawn:
    // the ratio of two cells' heat past the knee is the ratio of the
    // logarithms, not of the heat
    const tone = (flights: number): number => heatTone(flights) / flights;
    expect(tone(HEAT_KNEE)).toBe(1);
    expect(tone(HEAT_KNEE * Math.E)).toBeCloseTo(2 / Math.E, 12);
  });

  it("draws no heat for no points", () => {
    expect(exposedHeat(new Float64Array(0))).toEqual({
      exposure: 1,
      weights: new Float64Array(0),
    });
  });
});
