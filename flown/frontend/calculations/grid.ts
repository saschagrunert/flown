/**
 * The grids the flights are counted in: the heat lines' (heatLines.ts),
 * the hotspots' (hotspots.ts), the new areas of Wrapped (newAreas.ts), the
 * readout of the heat cloud (cloudReadout.ts) and the heatmap's merged
 * fixes (services/heatSource.ts). Each has cells of its own size, in rows
 * of latitude or of the Mercator plane, and numbers a cell by its row and
 * column in one key.
 */
import { DEGREES_TO_RADIANS, METRES_PER_DEGREE } from "../utils/geometry";

/** Rows are numbered into one key with their column */
export const ROW_STRIDE = 2 ** 22;
const COLUMN_OFFSET = 2 ** 21;

/** The latitude a row of cells `cellM` metres high takes, in degrees */
export function rowDegrees(cellM: number): number {
  return cellM / METRES_PER_DEGREE;
}

/**
 * The width in degrees of the columns of `row` in a grid whose rows are
 * `rowDegrees` of latitude: as wide as a row is high at its middle, so the
 * cells stay square from the equator to the north of Norway
 */
export function columnWidth(row: number, rowDegrees: number): number {
  return rowDegrees / Math.cos((row + 0.5) * rowDegrees * DEGREES_TO_RADIANS);
}

/** The key of the cell of a row and a column, for a grid of any size */
export function cellKey(row: number, column: number): number {
  return row * ROW_STRIDE + column + COLUMN_OFFSET;
}
