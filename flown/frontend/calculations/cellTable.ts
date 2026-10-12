/**
 * Cells of a grid found by their column and row, with `floats` sums each,
 * for the heat cloud's busiest cells (calculations/heatCloud.ts) and the
 * directions of its marks (calculations/cloudCells.ts). In a Map keyed by
 * a number made of the column and the row, the cells were a third of the
 * work of cloudPoints: this is a table of typed arrays kept at most half
 * full, where the cell found last is tried first, since the next place is
 * in it more often than not.
 */
export interface CellTable {
  /** Where the sums of the cell at `column` and `row` start, made if need be */
  at(column: number, row: number): number;
  /**
   * The sums, `floats` a cell in the order they were made; a new array
   * once the table has grown, so asked again after `at`
   */
  sums(): Float64Array;
  /** How many cells there are */
  count(): number;
}

/** The slot of a cell's column and row in a table of `mask` + 1 slots */
function slotOf(column: number, row: number, mask: number): number {
  const hash = Math.imul(Math.imul(column, 0x9e3779b1) ^ row, 0x85ebca6b);
  return (hash ^ (hash >>> 15)) & mask;
}

export function cellTable(floats: number): CellTable {
  // Which cell a slot holds, from 1 (0 for none), and the column and the
  // row of each cell, and its sums
  let slots = new Int32Array(1 << 12);
  let places = new Int32Array(slots.length);
  let sums = new Float64Array((floats * slots.length) / 2);
  let made = 0;
  let lastColumn = 0;
  let lastRow = 0;
  let last = -1;
  return {
    at(column, row) {
      if (last >= 0 && column === lastColumn && row === lastRow) return last;
      let mask = slots.length - 1;
      let slot = slotOf(column, row, mask);
      let held = slots[slot]!;
      while (
        held !== 0 &&
        (places[2 * held - 2] !== column || places[2 * held - 1] !== row)
      ) {
        slot = (slot + 1) & mask;
        held = slots[slot]!;
      }
      if (held === 0) {
        held = ++made;
        if (2 * held > slots.length) {
          // The table twice as large, with every cell in it again
          const more = new Int32Array(places.length * 2);
          more.set(places);
          places = more;
          const larger = new Float64Array(sums.length * 2);
          larger.set(sums);
          sums = larger;
          slots = new Int32Array(slots.length * 2);
          mask = slots.length - 1;
          places[2 * held - 2] = column;
          places[2 * held - 1] = row;
          for (let other = 1; other <= held; other++) {
            let free = slotOf(
              places[2 * other - 2]!,
              places[2 * other - 1]!,
              mask,
            );
            while (slots[free] !== 0) free = (free + 1) & mask;
            slots[free] = other;
          }
        } else {
          places[2 * held - 2] = column;
          places[2 * held - 1] = row;
          slots[slot] = held;
        }
      }
      last = (held - 1) * floats;
      lastColumn = column;
      lastRow = row;
      return last;
    },
    sums: () => sums,
    count: () => made,
  };
}
