import { describe, expect, it } from "vitest";
import { cellTable } from "../../../../flown/frontend/calculations/cellTable";

describe("cellTable", () => {
  it("finds a cell again by its column and row, in the order made", () => {
    const cells = cellTable(2);
    const a = cells.at(3, -4);
    const b = cells.at(-3, 4);
    expect([a, b]).toEqual([0, 2]);
    expect(cells.at(3, -4)).toBe(a);
    expect(cells.at(-3, 4)).toBe(b);
    expect(cells.count()).toBe(2);
  });

  it("keeps every cell and its sums as it grows", () => {
    const cells = cellTable(1);
    const side = 200;
    for (let column = 0; column < side; column++) {
      for (let row = 0; row < side; row++) {
        const at = cells.at(column, row);
        const sums = cells.sums();
        sums[at] = sums[at]! + column * side + row + 1;
      }
    }
    expect(cells.count()).toBe(side * side);
    for (let column = 0; column < side; column += 7) {
      for (let row = 0; row < side; row += 11) {
        expect(cells.sums()[cells.at(column, row)]).toBe(
          column * side + row + 1,
        );
      }
    }
    expect(cells.count()).toBe(side * side);
  });
});
