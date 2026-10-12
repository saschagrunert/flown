/**
 * The hotspots of the heat: the few places where the heat of a view is
 * strongest, which the hotspot tour flies to (ui/hotspotTour.ts).
 *
 * The heat is weighed as the heatmap, its lines and the heat cloud weigh
 * it (heatWeight): each segment's seconds, half at either end, added up
 * in cells of a coarse grid about a kilometre wide. The cell with the most
 * heat around it seeds a hotspot, which takes in every cell near it
 * (HOTSPOT_RADIUS_M), so a field, its circuit and its holding points are
 * one place rather than three; the next seed is the next such cell that is
 * far enough from every hotspot kept (HOTSPOT_APART_M), and so is the
 * middle of its place. A place is named after the nearest airport of the
 * site, or by its distance and direction from it.
 *
 * Only totals leave this module: the time spent at a place and its share
 * of the view's, never when.
 */
import type { Airport, PathSegment } from "../types";
import {
  calculateBearing,
  calculateDistance,
  METRES_PER_DEGREE,
  planarMetres,
  turnOf,
  type Coordinate,
} from "../utils/geometry";
import { formatDuration } from "../utils/duration";
import {
  cellKey,
  columnWidth,
  heatWeight,
  type SegmentWeight,
} from "./heatLines";

/** Edge of a cell of the grid the heat is added up in, in metres */
const HOTSPOT_CELL_M = 1000;

/** Cells whose middle is this close to a seed's belong to its hotspot */
const HOTSPOT_RADIUS_M = 3000;

/** How far apart the middles of two hotspots are at least, in metres */
export const HOTSPOT_APART_M = 8000;

/** The most hotspots a view has */
export const MAX_HOTSPOTS = 5;

/**
 * The least share of the view's heat a hotspot has: a place the flights
 * only passed is no stop of the tour, however few places there are. The
 * home field holds a tenth to a quarter of the time of a year or of all of
 * them and the next few places half a percent to one each, since a segment
 * adds at most two minutes (heatWeight), however long the aircraft stood
 * there.
 */
const MIN_HOTSPOT_SHARE = 0.002;

/** A place near an airport, within this many kilometres, is the airport */
const AT_AIRPORT_KM = 2.5;

/** Past this many kilometres from any airport a place is named by its position */
const NEAR_AIRPORT_KM = 80;

/** One of the busiest places of a view */
export interface Hotspot {
  /** `[lat, lng]`, the middle of its heat */
  center: Coordinate;
  /** Its heat, as weighed: the seconds spent there */
  seconds: number;
  /** Its share of the heat of the whole view, 0 to 1 */
  share: number;
  /** How far its heat lies from its middle on average, in metres */
  radiusM: number;
}

/** A cell of the grid: its seconds, and their middle as weighted sums */
interface Cell {
  row: number;
  column: number;
  seconds: number;
  lat: number;
  lng: number;
  /** The seconds of the cells around it, see SEED_CELLS */
  around: number;
  taken: boolean;
}

/**
 * Cells on either side of one whose seconds count for it as a seed: the
 * busiest place is where the most heat lies around a cell, not in it. A
 * field whose traffic spreads over its circuit came after one visited
 * twice whose apron is a single cell.
 */
const SEED_CELLS = 2;

/** Degrees of latitude a row of cells spans */
const ROW_DEGREES = HOTSPOT_CELL_M / METRES_PER_DEGREE;

/** The row and the column of the cell a `[lat, lng]` point lies in */
function cellOf([lat, lng]: Readonly<Coordinate>): [number, number] {
  const row = Math.floor(lat / ROW_DEGREES);
  return [row, Math.floor(lng / columnWidth(row, ROW_DEGREES))];
}

/**
 * The busiest places of the flights `keep` accepts, their heat weighed by
 * `weigh` (heatWeight), busiest first: at most MAX_HOTSPOTS, each at least
 * HOTSPOT_APART_M from the others and with at least MIN_HOTSPOT_SHARE of
 * the heat. None where there is no heat.
 */
export function findHotspots(
  segments: readonly PathSegment[],
  keep: (pathId: number) => boolean,
  weigh: SegmentWeight = heatWeight,
): Hotspot[] {
  const cells = new Map<number, Cell>();
  let total = 0;
  const add = (point: Readonly<Coordinate>, seconds: number): void => {
    const [row, column] = cellOf(point);
    const key = cellKey(row, column);
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        row,
        column,
        seconds: 0,
        lat: 0,
        lng: 0,
        around: 0,
        taken: false,
      };
      cells.set(key, cell);
    }
    cell.seconds += seconds;
    cell.lat += point[0] * seconds;
    cell.lng += point[1] * seconds;
  };
  segments.forEach((segment, index) => {
    if (!keep(segment.path_id)) return;
    const seconds = weigh(segment, segments[index + 1]);
    if (seconds <= 0) return;
    add(segment.coords[0], seconds / 2);
    add(segment.coords[1], seconds / 2);
    total += seconds;
  });
  if (total <= 0) return [];

  // The columns of the rows around a cell are a little narrower or wider
  // than its own, which a seed's score does not need to know
  for (const cell of cells.values()) {
    for (let dr = -SEED_CELLS; dr <= SEED_CELLS; dr++) {
      for (let dc = -SEED_CELLS; dc <= SEED_CELLS; dc++) {
        const near = cells.get(cellKey(cell.row + dr, cell.column + dc));
        if (near) cell.around += near.seconds;
      }
    }
  }
  const busiest = [...cells.values()].sort((a, b) => b.around - a.around);
  const middleOf = (cell: Cell): Coordinate => [
    cell.lat / cell.seconds,
    cell.lng / cell.seconds,
  ];
  const hotspots: Hotspot[] = [];
  const tooClose = (point: Coordinate): boolean =>
    hotspots.some(
      (hotspot) => planarMetres(hotspot.center, point) < HOTSPOT_APART_M,
    );
  for (const seed of busiest) {
    if (hotspots.length >= MAX_HOTSPOTS) break;
    if (seed.taken) continue;
    const middle = middleOf(seed);
    if (tooClose(middle)) continue;
    // Every cell around the seed not already part of a hotspot. Their
    // longitudes are added as the way from the seed's, the short way
    // round: a place across the antimeridian has its middle there, not
    // half the world away.
    let seconds = 0;
    let lat = 0;
    let east = 0;
    const members: Cell[] = [];
    for (const cell of busiest) {
      if (cell.taken) continue;
      const at = middleOf(cell);
      if (planarMetres(middle, at) > HOTSPOT_RADIUS_M) continue;
      cell.taken = true;
      members.push(cell);
      seconds += cell.seconds;
      lat += cell.lat;
      east += turnOf(middle[1], at[1]) * cell.seconds;
    }
    const center: Coordinate = [
      lat / seconds,
      turnOf(0, middle[1] + east / seconds),
    ];
    // Cells between the seed and a hotspot kept can draw the middle of
    // the place closer to it than HOTSPOT_APART_M: no stop of its own then
    if (tooClose(center)) continue;
    let spread = 0;
    for (const cell of members) {
      spread += planarMetres(center, middleOf(cell)) * cell.seconds;
    }
    hotspots.push({
      center,
      seconds,
      share: seconds / total,
      radiusM: spread / seconds,
    });
  }
  return hotspots
    .filter((hotspot) => hotspot.share >= MIN_HOTSPOT_SHARE)
    .sort((a, b) => b.seconds - a.seconds);
}

/** The eight points of the compass, from north clockwise */
const COMPASS_POINTS = [
  "north",
  "north-east",
  "east",
  "south-east",
  "south",
  "south-west",
  "west",
  "north-west",
] as const;

/** The point of the compass a bearing in degrees is nearest to */
export function compassPoint(bearing: number): string {
  const step = Math.round((((bearing % 360) + 360) % 360) / 45) % 8;
  return COMPASS_POINTS[step]!;
}

/** A position as "51.55° N, 12.05° E" */
function positionName([lat, lng]: Readonly<Coordinate>): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(2)}° ${ns}, ${Math.abs(lng).toFixed(2)}° ${ew}`;
}

/**
 * The name of the place at `center`: the airport there ("Home field EDAQ
 * Halle-Oppin" for the one `home` names), where it is from the nearest
 * airport ("12 km south of EDAQ Halle-Oppin"), or its position when no
 * airport of the site is near
 */
export function hotspotName(
  center: Readonly<Coordinate>,
  airports: readonly Airport[],
  home: string | null,
): string {
  let nearest: Airport | null = null;
  let nearestKm = Infinity;
  for (const airport of airports) {
    const km = calculateDistance([airport.lat, airport.lon], [...center]);
    if (km < nearestKm) {
      nearest = airport;
      nearestKm = km;
    }
  }
  if (!nearest || nearestKm > NEAR_AIRPORT_KM) return positionName(center);
  if (nearestKm <= AT_AIRPORT_KM) {
    return nearest.name === home ? `Home field ${nearest.name}` : nearest.name;
  }
  const direction = compassPoint(
    calculateBearing(nearest.lat, nearest.lon, center[0], center[1]),
  );
  return `${Math.round(nearestKm)} km ${direction} of ${nearest.name}`;
}

/**
 * What the caption of a hotspot says below its name: "32 h, 22% of the
 * time", or "40 min, under 1% of the time" (a total in the page's words,
 * formatDuration, never a time of day)
 */
export function hotspotDetail(hotspot: Hotspot): string {
  const percent = Math.round(hotspot.share * 100);
  const share = percent >= 1 ? `${percent}%` : "under 1%";
  return `${formatDuration(hotspot.seconds)}, ${share} of the time`;
}
