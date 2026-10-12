/**
 * The directions of the flights of the heat cloud in cells, for the marks
 * of the way flown, which a stretch draws only where the flights around it
 * go its way.
 */
import { describe, it, expect } from "vitest";
import {
  agreement,
  markStretches,
} from "../../../../flown/frontend/calculations/cloudCells";
import { heatTone } from "../../../../flown/frontend/calculations/heatTone";

/** The floats of a point, and which are the heat and the marks */
const FLOATS = 7;
const HEAT = 4;
const MARKS = 6;
/** A cell, in the units of the points */
const CELL = 1;
/** A stretch, a third of a cell */
const STEP = CELL / 3;

/** A flight through the points `fixes`, `seconds` a stretch */
type Flight = { fixes: [number, number][]; seconds?: number };

/**
 * The points of `flights` as cloudPoints hands them to markStretches: one
 * after the other, no heat on the last point of a flight
 */
function valuesOf(flights: Flight[]): number[] {
  const values: number[] = [];
  for (const { fixes, seconds = 5 } of flights) {
    fixes.forEach(([x, y], i) => {
      const heat = i === fixes.length - 1 ? 0 : seconds;
      values.push(x, y, 0, 0, heat, 0, 0);
    });
  }
  return values;
}

/** The marks of each point of `flights`, from 0 to 1 */
function marksOf(flights: Flight[]): number[] {
  const values = valuesOf(flights);
  markStretches(values, FLOATS, HEAT, MARKS, CELL);
  return values.filter((_, k) => k % FLOATS === MARKS);
}

/** `count` fixes `step` apart from `(x, y)` in the direction `(dx, dy)` */
function track(
  count: number,
  [x, y]: readonly [number, number],
  [dx, dy]: readonly [number, number],
  step = STEP,
): [number, number][] {
  const length = Math.hypot(dx, dy);
  return Array.from({ length: count }, (_, i) => [
    x + (i * step * dx) / length,
    y + (i * step * dy) / length,
  ]);
}

/**
 * Where the first track starts: half a stretch into a cell, so every cell
 * a track crosses has three stretches of it in it
 */
const START = [10 + STEP / 2, 20 + STEP / 2] as const;

describe("agreement", () => {
  /** The sums of a cell of stretches of the unit directions and seconds */
  function cell(...stretches: [dx: number, dy: number, seconds: number][]) {
    const sums = [0, 0, 0, 0, 0];
    for (const [dx, dy, seconds] of stretches) {
      sums[0]! += seconds * dx;
      sums[1]! += seconds * dy;
      sums[2]! += seconds * dx * dx;
      sums[3]! += seconds * dx * dy;
      sums[4]! += seconds * dy * dy;
    }
    return sums;
  }

  it("is 1 for a cell of flights all going the stretch's way, and -1 for all going the other", () => {
    const east = cell([1, 0, 5], [1, 0, 3]);
    expect(agreement(east, 0, 1, 0)).toBeCloseTo(1, 12);
    expect(agreement(east, 0, -1, 0)).toBeCloseTo(-1, 12);
  });

  it("is 0 for as many seconds each way along the axis", () => {
    const both = cell([1, 0, 5], [-1, 0, 5]);
    expect(agreement(both, 0, 1, 0)).toBeCloseTo(0, 12);
    expect(agreement(both, 0, -1, 0)).toBeCloseTo(0, 12);
  });

  it("counts the flights across the stretch for neither way", () => {
    const crossing = cell([1, 0, 5], [0, 1, 50], [0, -1, 20]);
    expect(agreement(crossing, 0, 1, 0)).toBeCloseTo(1, 12);
  });

  it("is how far the seconds one way outweigh those the other", () => {
    const mostly = cell([1, 0, 30], [-1, 0, 10]);
    expect(agreement(mostly, 0, 1, 0)).toBeCloseTo(0.5, 12);
    expect(agreement(mostly, 0, -1, 0)).toBeCloseTo(-0.5, 12);
  });

  it("reads the cell where it starts", () => {
    const sums = [...cell([1, 0, 5]), ...cell([-1, 0, 5])];
    expect(agreement(sums, 0, 1, 0)).toBeCloseTo(1, 12);
    expect(agreement(sums, 5, 1, 0)).toBeCloseTo(-1, 12);
  });

  it("is 0 for a cell without a stretch along the axis, and stays within -1 and 1", () => {
    expect(agreement(cell(), 0, 1, 0)).toBe(0);
    expect(agreement(cell([0, 1, 5]), 0, 1, 0)).toBe(0);
    // A flight at an angle counts for more in the sum of the directions
    const slanted = cell([Math.SQRT1_2, Math.SQRT1_2, 5]);
    expect(agreement(slanted, 0, 1, 0)).toBe(1);
  });
});

describe("the marks of the stretches", () => {
  it("marks a route flown one way in full on every stretch, and its last point as the stretch before", () => {
    const marks = marksOf([{ fixes: track(12, START, [1, 0.3]) }]);
    expect(marks).toEqual(new Array(12).fill(1));
  });

  it("marks none where a route is flown out and back along the same track", () => {
    const out = track(12, START, [1, 0]);
    const back = [...out].reverse();
    const marks = marksOf([{ fixes: out }, { fixes: back }]);
    expect(marks).toEqual(new Array(24).fill(0));
  });

  it("keeps the marks of two routes that cross", () => {
    const east = track(12, START, [1, 0]);
    const north = track(
      12,
      [START[0] + 4 * STEP, START[1] + 5 * STEP],
      [0, -1],
    );
    const marks = marksOf([{ fixes: east }, { fixes: north }]);
    expect(marks).toEqual(new Array(24).fill(1));
  });

  it("marks the way most flights go, and not the few the other way", () => {
    const out = track(12, START, [1, 0]);
    const back = [...out].reverse();
    const marks = marksOf([
      ...[1, 2, 3, 4].map(() => ({ fixes: out })),
      { fixes: back },
    ]);
    // Four seconds out for one back in every cell: an agreement of 0.6
    // out, between none and in full, and of -0.6 back
    const most = marks.slice(0, 48);
    expect(Math.min(...most)).toBeGreaterThan(0.3);
    expect(Math.max(...most)).toBeLessThan(1);
    expect(marks.slice(48)).toEqual(new Array(12).fill(0));
  });

  it("takes the slower flights' seconds as more of the cell", () => {
    const out = track(12, START, [1, 0]);
    const back = [...out].reverse();
    const marks = marksOf([
      { fixes: out, seconds: 20 },
      { fixes: back, seconds: 2 },
    ]);
    expect(marks.slice(0, 12)).toEqual(new Array(12).fill(1));
    expect(marks.slice(12)).toEqual(new Array(12).fill(0));
  });

  it("gives a stretch of no length no marks", () => {
    const fixes = track(4, START, [1, 0]);
    fixes.splice(1, 0, fixes[1]!);
    const marks = marksOf([{ fixes }]);
    expect(marks).toEqual([1, 0, 1, 1, 1]);
  });

  it("counts a long stretch in every cell it passes, not only where it starts", () => {
    // One stretch across five cells out, and short ones back over it, about
    // as many seconds each way in every cell
    const out = {
      fixes: track(2, [START[0] - CELL / 4, START[1]], [1, 0], 4.5 * CELL),
      seconds: 60,
    };
    const back = { fixes: track(13, START, [1, 0]).reverse() };
    expect(marksOf([out, back])).toEqual(new Array(15).fill(0));
    // And the other way round
    expect(
      marksOf([
        { ...out, fixes: [...out.fixes].reverse() },
        { fixes: [...back.fixes].reverse() },
      ]),
    ).toEqual(new Array(15).fill(0));
    // Alone, the long stretch is marked in full
    expect(marksOf([out])).toEqual([1, 1]);
  });

  it("does not count the way from the end of one run of stretches to the next", () => {
    // Twice the same way: the jump from the end of the first back to the
    // start of the second is no stretch, and takes nothing away
    const out = track(12, START, [1, 0]);
    expect(marksOf([{ fixes: out }, { fixes: out }])).toEqual(
      new Array(24).fill(1),
    );
  });

  it("marks every stretch of a long flight, and none of it flown back over", () => {
    // A cell a stretch, many more cells than the table starts with
    const out = track(20000, START, [1, 0.5], 1.2 * CELL);
    expect(marksOf([{ fixes: out }]).every((mark) => mark === 1)).toBe(true);

    const marks = marksOf([{ fixes: out }, { fixes: [...out].reverse() }]);
    expect(marks.every((mark) => mark === 0)).toBe(true);
  });
});

describe("markStretches rolling off the heat", () => {
  /** A cell, in Mercator units */
  const cell = 1e-4;
  /**
   * `times` flights of two stretches of 5 s each in the same cell, at the
   * Mercator `y` (the equator at 0.5)
   */
  const over = (times: number, y = 0.5): number[] => {
    const row = Math.floor(y / cell) * cell + cell / 6;
    return valuesOf(
      Array.from({ length: times }, () => ({
        fixes: track(3, [0.5 + cell / 6, row], [1, 0], cell / 3),
      })),
    );
  };
  const heats = (values: number[]): number[] =>
    values.filter((_, k) => k % FLOATS === HEAT && values[k]! > 0);

  it("leaves the heat of a cell under the knee as it is", () => {
    // A second in a cell on the equator is drawn as a tenth of a flight's
    // worth: one flight's 10 s are one flight's worth
    const values = over(1);
    markStretches(values, FLOATS, HEAT, MARKS, cell, 0.1);
    expect(heats(values)).toEqual([5, 5]);
  });

  it("rolls the heat of a busy cell off, every stretch in it alike", () => {
    const values = over(100);
    markStretches(values, FLOATS, HEAT, MARKS, cell, 0.1);
    for (const heat of heats(values)) {
      expect(heat).toBeCloseTo((5 * heatTone(100)) / 100, 6);
    }
    // As many flights' worth in all as the heat rolls off to
    const total = heats(values).reduce((sum, heat) => sum + heat, 0);
    expect(total * 0.1).toBeCloseTo(heatTone(100), 6);
    // And not at all without a scale
    const plain = over(100);
    markStretches(plain, FLOATS, HEAT, MARKS, cell);
    expect(new Set(heats(plain))).toEqual(new Set([5]));
  });

  it("counts a cell away from the equator as the more heat per metre it holds", () => {
    // At 60 degrees a cell spans half the metres: 50 flights there are as
    // busy as 100 on the equator
    const y =
      0.5 - Math.log(Math.tan(Math.PI / 4 + Math.PI / 6)) / (2 * Math.PI);
    const values = over(50, y);
    markStretches(values, FLOATS, HEAT, MARKS, cell, 0.1);
    for (const heat of heats(values)) {
      expect(heat).toBeCloseTo((5 * heatTone(100)) / 100, 2);
    }
  });
});
