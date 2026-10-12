/**
 * Relief state - what the layer manager and the relief's code share
 *
 * The layer manager decides whether the 3D view draws the relief and for
 * which level (LayerManager.syncTerrain), and cuts the ribbons for it;
 * ui/terrain.ts makes the map follow, and hides the ribbons while they
 * settle on their new ground. What passes between the two is kept here
 * rather than on either of them: the relief's switches in the store,
 * written in the order the map needs them, the visit of a level the
 * ribbons are cut in, whether they show, and the sources that hold them.
 * It comes with the app: the relief's code comes with the feature bundle,
 * and the layer manager writes the relief's switches before it has
 * arrived, and the ribbons once it has (their cut comes with it too).
 */
import type { AppStore } from "../state/store";
import { MAP_SOURCES } from "../utils/constants";

/**
 * The sources of the ribbons of the colour modes, every flight's and the
 * selection's, whose layers share their id (see mapLayers.ts)
 */
export const PATH_RIBBON_SOURCES: readonly string[] = [
  MAP_SOURCES.pathsAltitudeRibbons,
  MAP_SOURCES.pathsAirspeedRibbons,
  MAP_SOURCES.pathsAltitudeSelectedRibbons,
  MAP_SOURCES.pathsAirspeedSelectedRibbons,
];

/**
 * Every source of ribbons, those of the lines of a selection and of the
 * replay's trail too: all on the relief
 */
export const RIBBON_SOURCES: readonly string[] = [
  ...PATH_RIBBON_SOURCES,
  MAP_SOURCES.selectionHighlightRibbons,
  MAP_SOURCES.replayTrailRibbons,
];

export class ReliefState {
  private readonly store: AppStore;
  private shown = 1;
  private visit = 0;
  private readonly listeners = new Set<() => void>();

  constructor(store: AppStore) {
    this.store = store;
  }

  /**
   * 0 while the relief's code hides the ribbons, until the map has drawn
   * them on their new ground (ui/terrain.ts), 1 otherwise: their opacity is
   * multiplied by it
   */
  get ribbonsShown(): number {
    return this.shown;
  }

  /**
   * How often the relief level has changed: the visit of a level a cut of
   * the ribbons belongs to, which their id tells apart (see ribbonId)
   */
  get epoch(): number {
    return this.visit;
  }

  /**
   * Draw the relief for the level `level`, and draw it or not (`active`,
   * as it is by default). A level of its own is a new visit. The relief
   * goes before it would be built for the new level, and comes after it.
   */
  moveTo(level: number, active = this.store.get("terrainActive")): void {
    if (level !== this.store.get("reliefLevel")) this.visit++;
    if (!active) this.store.set("terrainActive", false);
    this.store.set("reliefLevel", level);
    this.store.set("terrainActive", active);
  }

  /** Shade the relief, or stop shading it (reliefShaded) */
  shade(shaded: boolean): void {
    this.store.set("reliefShaded", shaded);
  }

  /**
   * Hide the ribbons or show them again, and tell whoever styles them
   * (see onRibbonsShown), on every call
   */
  showRibbons(shown: boolean): void {
    this.shown = shown ? 1 : 0;
    for (const listener of this.listeners) listener();
  }

  /** Follow showRibbons; returns what stops following it */
  onRibbonsShown(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
