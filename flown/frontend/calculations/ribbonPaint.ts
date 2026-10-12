/**
 * The paint that lifts the ribbons of the 3D view: the expressions of the
 * bottom and the top of a ribbon from what its feature carries (see
 * ribbonProperties), and the same worked out here for the ribbon under the
 * pointer.
 */
import type { ExpressionSpecification } from "maplibre-gl";
import { FEET_TO_METERS } from "../utils/constants";
import {
  EXAGGERATION_BY_LEVEL,
  GROUND_LEVELS,
  groundKey,
  heightOnReliefFt,
  LIFT_MAX_ZOOM,
  LIFT_STEP_FT,
  RELIEF_MAX_LEVEL,
  reliefLevel,
  STANDING_LEVELS,
} from "./lift";
import type { RibbonProperties } from "./ribbons";

/**
 * By map zoom: the band of height a ribbon has, in metres, about three
 * pixels at every zoom. The flights are lifted at every zoom, the whole of
 * a long flight in view included, so the stops reach down to a map of half
 * of Europe.
 */
const BAND_STOPS: readonly (readonly [zoom: number, bandM: number])[] = [
  [4, 12000],
  [6, 3000],
  [7, 1900],
  [9, 480],
  [10, 200],
  [11, 110],
  [13, 28],
  [16, 6],
];

/**
 * The feet a ribbon's feature is drawn above the relief under a tile of
 * the map zoom `zoom`, from its properties (see ribbonProperties), as the
 * paint has it
 */
export function ribbonHeightFt(
  properties: Partial<RibbonProperties>,
  zoom: number,
): number {
  const { h = 0, l = reliefLevel(zoom) } = properties;
  return heightOnReliefFt(
    h,
    GROUND_LEVELS.map((step) => properties[groundKey(step)] ?? 0),
    l,
    zoom,
  );
}

/**
 * The feature state that gives the ribbons cut for another relief level
 * the exaggeration of the one the map is drawn for, see ribbonHeights
 */
export const EXAGGERATION_STATE = "e";

/** By map zoom: the band of height of a ribbon, in metres (BAND_STOPS) */
function bandM(zoom: number): number {
  const i = BAND_STOPS.findIndex(([stop]) => stop > zoom);
  if (i === 0) return BAND_STOPS[0]![1];
  if (i < 0) return BAND_STOPS[BAND_STOPS.length - 1]![1];
  const [z0, m0] = BAND_STOPS[i - 1]!;
  const [z1, m1] = BAND_STOPS[i]!;
  return m0 + ((m1 - m0) * (zoom - z0)) / (z1 - z0);
}

/** The exaggeration of the relief level `level` (liftExaggeration) */
function exaggerationOf(
  level: ExpressionSpecification,
): ExpressionSpecification {
  const stops = EXAGGERATION_BY_LEVEL.flatMap((factor, i) =>
    i > 0 && factor !== EXAGGERATION_BY_LEVEL[i - 1] ? [i, factor] : [],
  );
  return [
    "step",
    level,
    EXAGGERATION_BY_LEVEL[0]!,
    ...stops,
  ] as ExpressionSpecification;
}

/**
 * The feet to add to a ribbon's height to have it above the ground of the
 * relief level `level`, from the ground its feature carries: the one of
 * the nearest level it has (see standingLevel), and a ground it leaves out
 * the one it was cut on
 */
function groundOffsetAt(level: number): ExpressionSpecification {
  const step: ExpressionSpecification = ["-", level, ["get", "l"]];
  const offset = (standing: number): ExpressionSpecification | number =>
    standing === 0 ? 0 : ["coalesce", ["get", groundKey(standing)], 0];
  return [
    "case",
    ...STANDING_LEVELS.slice(0, -1).flatMap((standing) => [
      ["<=", step, standing],
      offset(standing),
    ]),
    offset(STANDING_LEVELS[STANDING_LEVELS.length - 1]!),
  ] as ExpressionSpecification;
}

/**
 * The paint of a ribbon's bottom and top, from the height `h` of its
 * feature, in feet above the ground of the relief level `l` it was cut
 * for, and the ground it carries of the levels around (see
 * ribbonProperties).
 *
 * MapLibre works out a paint that goes by zoom for each tile at the tile's
 * own zoom, and lifts the ribbons of a tile by the relief of that tile's
 * level. A step by zoom takes the ground of the tile's level, so a ribbon
 * stands on the relief under it whichever level's tiles the map draws: the
 * next level's while a zoom goes on, before the flights are cut for it as
 * it ends, and coarser ones in the distance of a tilted view. The band goes
 * by the tile's zoom, as the one of the middle of its level, as the width
 * does (see RIBBON_WIDTH_PX): an interpolation by zoom would mix the ground
 * of the tile's level with the next one's by the map's zoom. On the tiles
 * of a level further out than the one cut for, the distance of a tilted
 * view, it is the band of the next level in, as thin as an interpolation
 * made it there: MapLibre takes the value of the level after a tile's for
 * every map zoom past it.
 *
 * The exaggeration does not go by the tile: it is the relief's, one number
 * for the whole map, which switches as a zoom ends. A ribbon has the one of
 * the level it was cut for, and one of another level, still drawn while the
 * flights are cut for the new one, the new one from a feature state for its
 * id (EXAGGERATION_STATE, see ui/terrain.ts and ribbonId): the map applies
 * it to all of its tiles in the frame it switches the relief, where a new
 * paint would have them cut again one by one.
 */
export function ribbonHeights(): {
  base: ExpressionSpecification;
  height: ExpressionSpecification;
} {
  const exaggeration: ExpressionSpecification = [
    "coalesce",
    ["feature-state", EXAGGERATION_STATE],
    exaggerationOf(["get", "l"]),
  ];
  // A piece spans its step, half of it below its middle and half above, so
  // the pieces of a slope meet; the band goes on top of that
  const halfStep: ExpressionSpecification = [
    "*",
    exaggeration,
    (LIFT_STEP_FT / 2) * FEET_TO_METERS,
  ];
  const base: unknown[] = [];
  const height: unknown[] = [];
  for (let zoom = 0; zoom < LIFT_MAX_ZOOM; zoom++) {
    const level = reliefLevel(zoom);
    const metres: ExpressionSpecification = [
      "*",
      ["max", ["+", ["get", "h"], groundOffsetAt(level)], 0],
      ["*", exaggeration, FEET_TO_METERS],
    ];
    const band: ExpressionSpecification | number =
      level < RELIEF_MAX_LEVEL
        ? [
            "case",
            [">", ["get", "l"], level],
            bandM(zoom + 1),
            bandM(zoom + 0.5),
          ]
        : bandM(zoom + 0.5);
    // The first output is the one below the first stop
    if (zoom > 0) {
      base.push(zoom);
      height.push(zoom);
    }
    base.push(["max", ["-", metres, halfStep], 0]);
    height.push(["+", metres, halfStep, band]);
  }
  return {
    base: ["step", ["zoom"], ...base] as ExpressionSpecification,
    height: ["step", ["zoom"], ...height] as ExpressionSpecification,
  };
}
