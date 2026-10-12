/**
 * The zoom policy of the 3D view (see lift.ts): from which zoom the
 * flights are drawn flat, the whole level a zoom cuts the ribbons and
 * draws the relief for, and the height a flight is lifted by. It comes
 * with the app, which decides when the ribbons are cut, and goes by these
 * before the feature bundle that cuts them has arrived; the rest of the
 * lift comes with that bundle.
 */

/**
 * The map zoom from which the flights are drawn flat again, as lines, in
 * the 3D view. Zoomed in that far the camera is a few hundred metres up,
 * lower than a circuit even at true scale: the flights around it would
 * stand as walls in front of it, fill the screen from above, or be behind
 * it, and only the taxiing on the ground would be left to see.
 */
export const LIFT_MAX_ZOOM = 17;

/**
 * The deepest level of the elevation tiles, the one the build samples the
 * ground at (TERRAIN_ZOOM in terrain.py); the map stretches it beyond.
 */
export const TERRAIN_TILE_MAX_ZOOM = 10;

/**
 * The whole level the relief and the heights of the flights are drawn for
 * at the map zoom `zoom`: the level the ribbons are cut for (see
 * ribbonWidthZoom), up to the one whose ribbons stand on the deepest
 * elevation tiles (see reliefPixelM), from where neither the exaggeration
 * nor the ground changes any more.
 */
export function reliefLevel(zoom: number): number {
  return Math.min(Math.max(ribbonWidthZoom(zoom), 0), RELIEF_MAX_LEVEL);
}

/** The last relief level, see reliefLevel */
export const RELIEF_MAX_LEVEL = TERRAIN_TILE_MAX_ZOOM + 1;

/** Whether the 3D view lifts the flights at the map zoom `zoom` */
export function isLiftedAt(zoom: number): boolean {
  return zoom < LIFT_MAX_ZOOM;
}

/**
 * The zoom a ribbon's width is worked out for at the map zoom `zoom`: the
 * whole level it is in. A change of it is what cuts the flights again, and
 * what hands them to the lines at LIFT_MAX_ZOOM.
 */
export function ribbonWidthZoom(zoom: number): number {
  return Math.floor(zoom);
}

/** A segment's altitude as feet above its flight's ground, never below */
export function liftFt(altitudeFt: number, groundFt: number): number {
  return Math.max(altitudeFt - groundFt, 0);
}
