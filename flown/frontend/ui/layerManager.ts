/**
 * Layer Manager - Handles altitude/airspeed path rendering and legend updates
 *
 * Rendering strategy:
 * - Each mode draws from two GeoJSON sources that exist from the start (see
 *   mapLayers.ts): the main one with every flight, and a small one for the
 *   selection, whose layer lies on top. This module only ever calls
 *   `setData` on them and sets paint properties and a filter.
 * - Consecutive, contiguous segments of the same path whose value falls in
 *   the same one of COLOR_BINS steps of the colour range are merged into ONE
 *   LineString feature, in the colour of the middle of its step. Merging by
 *   the rounded value instead made tens of thousands of lines out of a
 *   groundspeed that never sits still, for colours no eye tells apart. The
 *   colour is computed here and carried as a property, so the map and the
 *   legend cannot disagree.
 * - A run table per source remembers which segments of the dataset each
 *   feature stands for, which lets the tooltip show the exact data of the
 *   segment nearest to the cursor (`findNearestSegment`). MapLibre simplifies the geometry per tile; the
 *   heatmap, the replay and the statistics read the full data anyway.
 * - A selection rebuilds only the selection's source, whose runs follow the
 *   selection's colour range. The main source stays as it is: its layer is
 *   dimmed with one paint property and filtered to leave the selected
 *   flights (in share mode: everything) out.
 * - In the 3D view (calculations/lift.ts) each run is written as a ribbon
 *   at its height instead of its line, at every zoom, to a source of
 *   ribbons of its own. The ribbon climbs and descends with the flight, in
 *   pieces of one height each, and every piece is a feature of the same
 *   run, so the run table, the selection and the tooltip serve all of them
 *   as they do the line. Its width is part of its geometry, so the ribbons
 *   are written again as the map zooms to another whole level, cut for the
 *   pixels of that level (see screenCut), and from CULL_FROM_ZOOM on only
 *   those around the view, again as the view leaves that. A mode that
 *   is hidden (the replay hides them without clearing them) is left as it
 *   is until it is drawn again.
 * - Paths are pixels of a layer and have no events of their own: what is
 *   under the pointer, for a click and for the tooltip, is found in
 *   ui/pathHover.ts, among the layers and runs this module has drawn.
 *
 * This module keeps the state of the modes and decides what is written
 * when: as the data, the filters, the selection or the visibility change,
 * as the 3D view and its relief come and go, and as a zoom or a pan ends.
 * What it does that with lives next to it: the modes, their state and the
 * cut into runs (ui/pathRuns.ts), the look of a selection, the colour
 * ranges and the legends (ui/pathLook.ts), and the cut of the ribbons of
 * the 3D view (ui/pathRibbons.ts), which comes with the feature bundle.
 */
import type {
  GeoJSONSource,
  LngLat,
  Map as MapLibreMap,
  Point,
} from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { Range } from "../state/store";
import type {
  KMLDataset,
  LayerHandle,
  PathHit,
  PathHitResult,
  PathHitTester,
  PathRunProperties,
} from "../types";
import {
  isReplayCameraMove,
  hasLostContext,
  onMapReady,
  whenContextRestored,
} from "../utils/mapHelpers";
import { loadedFeatures, loadFeatures } from "../services/featureLoader";
import {
  isLiftedAt,
  reliefLevel,
  ribbonWidthZoom,
} from "../calculations/liftZoom";
import type { FeatureModule } from "../features";
import { PathHover, type DrawnRuns, type RunsOnLayer } from "./pathHover";
import {
  CONFIGS,
  cutRuns,
  emptyModeState,
  isolatedOut,
  MODES,
  readyMap,
  RUN_SETS,
  runLines,
  runsOnLayer,
  type LayerConfig,
  type LayerMode,
  type ModeState,
  type Run,
  type RunSet,
} from "./pathRuns";
import {
  applyLook,
  formatSegmentTooltip,
  rangeOf,
  resolveColorRange,
  updateLegend,
} from "./pathLook";

/** What a source is given that has no runs to show */
const NO_FEATURES: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

export class LayerManager implements PathHitTester {
  private app: MapApp;
  private state: Record<LayerMode, ModeState> = {
    altitude: emptyModeState(),
    airspeed: emptyModeState(),
  };

  /** Modes that were drawn or cleared before the sources existed */
  private pendingModes = new Set<LayerMode>();
  private destroyed = false;

  /** The map the zoom handler is registered on */
  private listeningTo: MapLibreMap | null = null;
  /** The flight under the pointer, and its values (ui/pathHover.ts) */
  readonly pathHover: PathHover;
  /**
   * The feature bundle, once it has arrived for the 3D view: its relief
   * follows terrainActive, and it cuts the ribbons (ui/pathRibbons.ts).
   * The flights it holds smoothed (calculations/groundProfile.ts) are let
   * go of through loadedFeatures, whatever fetched it: Replay all on the
   * flat map smooths them too.
   */
  private features: FeatureModule | null = null;
  /** A cut of the flights waits for the relief's code (see syncTerrain) */
  private cutAwaited = false;
  /** Stops restyling the ribbons as the relief's code shows or hides them */
  private readonly unfollowRibbons: () => void;
  /** Modes drawn once the camera comes to rest (see drawAtRest) */
  private readonly atRest = new Set<LayerMode>();

  /**
   * A ribbon is as wide as the zoom level it was written for (see lift.ts).
   * A flat line is the same at every zoom: from LIFT_MAX_ZOOM on, where the
   * 3D view draws the lines, only the zoom that lifts them again counts.
   */
  private readonly handleZoomEnd = (event: object): void => {
    const map = this.listeningTo;
    // The replay's camera rests of its own (see isReplayCameraMove)
    if (!map || !this.app.threeDVisible || isReplayCameraMove(event)) return;
    // Onto or off the relief the flights are cut anew on their other
    // ground, once its code has arrived (see syncTerrain); onto another
    // level of it, as wide as the new level asks, below
    const changed = this.syncTerrain();
    if (changed === null) return;
    if (changed || this.cutAwaited) this.redrawVisibleModes();
    const zoom = map.getZoom();
    const level = ribbonWidthZoom(zoom);
    for (const mode of MODES) {
      const state = this.state[mode];
      const config = CONFIGS[mode];
      if (!this.drawsNow(mode) || this.atRest.has(mode)) continue;
      for (const set of RUN_SETS) {
        const table = state.tables[set];
        if (table.widthZoom === null || table.widthZoom === level) continue;
        // Out of sight in share mode: written as it shows again
        if (isolatedOut(state, set)) {
          table.behind = true;
          continue;
        }
        if (table.written === config.ribbons[set] || isLiftedAt(zoom)) {
          this.setRuns(config, set, table.runs, true);
        } else {
          table.widthZoom = level;
        }
      }
    }
  };

  /**
   * Ribbons written around the view (see ribbonBox) are written again, as
   * they are, around a view that has left that
   */
  private readonly handleMoveEnd = (event: object): void => {
    const map = this.listeningTo;
    if (
      !map ||
      !this.app.threeDVisible ||
      this.cutAwaited ||
      isReplayCameraMove(event)
    ) {
      return;
    }
    for (const mode of MODES) {
      if (!this.drawsNow(mode) || this.atRest.has(mode)) continue;
      const state = this.state[mode];
      for (const set of RUN_SETS) {
        const table = state.tables[set];
        const { box, runs } = table;
        // Written again once the view reaches past one of its edges, or as
        // they show again when share mode hides them. Only ribbons, cut
        // by the feature bundle, have a box.
        if (box && this.features?.viewLeaves(this.app, map, box)) {
          if (isolatedOut(state, set)) table.behind = true;
          else this.setRuns(CONFIGS[mode], set, runs, true);
        }
      }
    }
  };

  constructor(app: MapApp) {
    this.app = app;
    this.pathHover = new PathHover(app, {
      readyMap: () => readyMap(this.app),
      drawnRuns: (map) => this.drawnRuns(map),
      describe: (segment) => formatSegmentTooltip(app, this.state, segment),
    });
    // Lifted or flat, the flights are cut and written anew. The smoothed
    // flights and the ground of every level only the 3D view needs are let
    // go with it.
    app.store.subscribe("threeDVisible", (threeD) => {
      if (!threeD) loadedFeatures()?.releaseGroundProfiles();
      if (this.syncTerrain() !== null) this.redrawVisibleModes();
    });
    app.store.subscribe("globeVisible", () => {
      if (this.syncTerrain()) this.redrawVisibleModes();
    });
    // The Select or Remove under the values of a tap says what it does now
    // (see onPathClick)
    app.store.subscribeKeys(
      ["selectedPathIds", "isolateSelection", "replayActive", "tourView"],
      () => this.pathHover.refreshTapped(),
    );
    // Out of sight while they settle on another ground (ui/terrain.ts)
    // Without its WebGL context the map has no style to write to: the
    // restore styles the modes as they are then (see restoreModes)
    this.unfollowRibbons = app.relief.onRibbonsShown(() => {
      if (!app.map || !hasLostContext(app.map)) this.restyle();
    });
    if (app.map) {
      this.listen(app.map);
    } else {
      this.whenMapReady(() => {
        if (app.map) this.listen(app.map);
      });
    }
  }

  /**
   * Run `onReady` once the map has its sources, unless the manager is gone
   * by then (see onMapReady)
   */
  private whenMapReady(onReady: () => void): void {
    onMapReady(this.app, "Path layers", () => {
      if (!this.destroyed) onReady();
    });
  }

  private listen(map: MapLibreMap): void {
    this.listeningTo = map;
    this.pathHover.listen(map);
    map.on("zoomend", this.handleZoomEnd);
    map.on("moveend", this.handleMoveEnd);
    whenContextRestored(map, () => this.restoreModes(), this.app.signal);
    // A link or a saved view can open in 3D and close in: the store had
    // its 3D view before this manager subscribed, and a map built at a
    // zoom fires no zoomend
    if (this.syncTerrain()) this.redrawVisibleModes();
  }

  /** Stop following the pointer; the drawn layers stay on the map */
  destroy(): void {
    this.destroyed = true;
    this.unfollowRibbons();
    this.pathHover.destroy();
    this.listeningTo?.off("zoomend", this.handleZoomEnd);
    this.listeningTo?.off("moveend", this.handleMoveEnd);
    this.listeningTo = null;
  }

  /** The handle of a mode's layers */
  private handleOf(mode: LayerMode): LayerHandle {
    return mode === "altitude"
      ? this.app.altitudeLayer
      : this.app.airspeedLayer;
  }

  /**
   * Remember a mode that could not reach its sources, and bring it up to
   * date once the map is ready: drawn again from the data of that moment,
   * or cleared, whichever it was last.
   */
  private deferUntilReady(mode: LayerMode): void {
    // A mode already waiting means the wait is under way
    const waiting = this.pendingModes.size > 0;
    this.pendingModes.add(mode);
    if (waiting) return;
    this.whenMapReady(() => {
      const pending = [...this.pendingModes];
      this.pendingModes.clear();
      // Without the sources even now there is nothing to wait for
      if (!readyMap(this.app)) return;
      for (const pendingMode of pending) {
        if (this.state[pendingMode].segments) {
          this.redrawPaths(pendingMode);
        } else {
          this.clearLayer(pendingMode);
        }
      }
    });
  }

  /**
   * The flight drawn at a point of the map, or null beside every flight, or
   * "stale" while the tiles cannot tell (see PathHover.hitTest). Part of
   * the contract with MapApp's click dispatcher, and what the hover runs on.
   */
  hitTest(point: Point): PathHitResult {
    return this.pathHover.hitTest(point);
  }

  /**
   * The layers a look under the pointer searches, with the runs their
   * features stand for: the lines of every mode that shows, and in the 3D
   * view its ribbons, unless they are hidden as they settle on another
   * ground (ui/terrain.ts): a query finds a feature whatever its opacity.
   * What is found is stale while a `setData` has not landed, told by the
   * app's own calls and not by whether the source is loaded alone: that is
   * false during every pan and zoom as well, and a camera move must not
   * make a click on the empty map one to ignore. While the ribbons settle,
   * nothing found is no word of the empty map either.
   */
  private drawnRuns(map: MapLibreMap): DrawnRuns {
    const threeD = this.app.threeDVisible;
    const ribbons = threeD && this.app.relief.ribbonsShown > 0;
    const layers = new Map<string, RunsOnLayer>();
    let landing = false;
    for (const mode of MODES) {
      const config = CONFIGS[mode];
      const state = this.state[mode];
      if (!this.handleOf(mode).isVisible() || !state.segments) continue;
      const drawn = RUN_SETS.map((set) => runsOnLayer(state, set));
      RUN_SETS.forEach((set, i) => layers.set(config.layers[set], drawn[i]!));
      if (ribbons) {
        // How far up the screen a ribbon is drawn: the feature bundle
        // knows, which cut them (none are drawn before it has arrived)
        const features = this.features;
        const lift = features
          ? (on: MapLibreMap, properties: Partial<PathRunProperties>) =>
              features.ribbonLiftPx(this.app, on, properties)
          : () => 0;
        RUN_SETS.forEach((set, i) =>
          layers.set(config.ribbons[set], { ...drawn[i]!, lift }),
        );
      }
      for (const set of RUN_SETS) {
        landing = this.stillLanding(map, config, set) || landing;
      }
    }
    return { layers, stale: landing || (threeD && !ribbons) };
  }

  /**
   * Whether the last `setData` of a mode's set is still on its way to the
   * map's tiles: asked here rather than followed through the map's events,
   * since the answer is only needed when someone looks
   */
  private stillLanding(
    map: MapLibreMap,
    config: LayerConfig,
    set: RunSet,
  ): boolean {
    const table = this.state[config.mode].tables[set];
    if (
      table.landing === "tiles" &&
      map.isSourceLoaded(table.written ?? config.sources[set])
    ) {
      table.landing = null;
    }
    return table.landing !== null;
  }

  /**
   * What a click on a flight does. A mouse toggles its selection, as it
   * always has, and has the hover tooltip for its values. A finger has no
   * hover: a tap shows the segment's values in a popup instead, with a
   * button to select the flight or take it out, so that looking at a
   * flight does not change the selection. Share mode holds the selection
   * still for a mouse as well: a click there shows the values with a
   * Remove (see ui/pathSelection.ts), and so does the hotspot tour, with
   * no button. Part of the contract with MapApp's click dispatcher, which
   * tells a finger by the click (TouchClock).
   */
  onPathClick(hit: PathHit, lngLat: LngLat, touch = false): void {
    const app = this.app;
    const selection = app.pathSelection;
    if (!touch && !app.isolateSelection && !selection.held()) {
      // The values a tap left open said what the flight was before
      this.pathHover.closeTapped();
      // Selecting rebuilds the runs of the path, the hovered one included;
      // `updateSelectionStyles` hands the tooltip over to its replacement
      selection.togglePathSelection(hit.pathId);
      return;
    }
    // Asked again as the selection, share mode, a replay or the tour
    // change (see the constructor). The button acts on the state it says:
    // a toggle, of the selection the label was made from. No button while
    // a replay or the hotspot tour holds the selection, where it did
    // nothing.
    this.pathHover.showTapped(hit, lngLat, {
      label: () =>
        selection.held()
          ? null
          : app.selectedPathIds.has(hit.pathId)
            ? "Remove flight"
            : "Select flight",
      run: () => selection.togglePathSelection(hit.pathId),
    });
  }

  /**
   * Put away the values a hover or a tap left on the map. MapLibre keeps
   * no list of open popups to close them by, and the popup of a tap does
   * not close on a click by itself: MapApp's click dispatcher calls this
   * for a click on the empty map, and Replay and Wrapped as they open.
   */
  closeSegmentPopup(): void {
    this.pathHover.closeSegmentPopup();
  }

  /**
   * Show the colour layers the store asks for: a mode shows while its flag
   * is on and no replay runs (see ui/layerVisibility.ts). One that shows
   * again is drawn anew, since it may have missed changes while it was
   * hidden (see drawsNow); one switched off lets go of its runs, which for
   * a large year hold tens of MB. A mode the replay hides keeps them.
   * In a 3D view whose relief's code is still on its way, a mode that shows
   * is drawn as it arrives, on the relief (see syncTerrain): cut on the
   * flat ground first, the flights were cut and written twice in a row as
   * the 3D view came on, 60,000 ribbons and then 72,000.
   *
   * @param rebuild - The data or the filter changed: draw every mode that
   *   shows, whether it did before or not
   */
  syncModes(rebuild = false): void {
    const data = this.app.currentData;
    const awaiting =
      this.app.threeDVisible && !this.features && this.syncTerrain() === null;
    for (const mode of MODES) {
      const handle = this.handleOf(mode);
      const wanted = this.app[`${mode}Visible`];
      const shown = wanted && !this.app.replayActive;
      const showing = handle.isVisible();
      handle.setVisible(shown);
      if (!wanted) {
        if (rebuild || this.state[mode].segments) this.clearLayer(mode);
      } else if (shown && (rebuild || !showing)) {
        if (awaiting && data) {
          // What redrawVisibleModes draws once the code has arrived. The
          // runs of before index into the segments of before: the features
          // on the map are stale until then, not flights of this dataset.
          const state = this.state[mode];
          state.segments = data.path_segments;
          state.dirty = false;
          for (const set of RUN_SETS) {
            state.tables[set].runs = [];
            state.tables[set].g++;
          }
          // The legend is of this dataset and its selection already
          this.updateModeLegend(mode);
        } else if (rebuild || !this.drawAtRest(mode)) this.redrawPaths(mode);
      } else if (rebuild) {
        // Hidden by the replay: drawn as it shows again
        this.state[mode].dirty = true;
      }
    }
  }

  /**
   * Leave a mode that shows again in the 3D view while the camera moves to
   * the end of the move, and say whether it was: as a replay closes, the
   * camera eases back from the chase to the view of before it, and a mode
   * drawn as it showed was smoothed and cut at the level the chase had left
   * the camera at, and then again at the one the move ends on. Until then
   * it shows the cut it had as the replay hid it, whose runs and segments
   * still belong together.
   */
  private drawAtRest(mode: LayerMode): boolean {
    const map = this.listeningTo;
    if (
      !map ||
      !this.app.threeDVisible ||
      !this.state[mode].segments ||
      !map.isMoving()
    ) {
      return false;
    }
    if (this.atRest.size === 0) {
      map.once("moveend", () => {
        const waiting = [...this.atRest];
        this.atRest.clear();
        if (this.destroyed) return;
        for (const other of waiting) {
          if (this.handleOf(other).isVisible()) this.redrawPaths(other);
          else this.state[other].dirty = true;
        }
      });
    }
    this.atRest.add(mode);
    return true;
  }

  /**
   * Empty both sources of a mode (used for hidden layers so they do not
   * keep stale geometry around)
   */
  clearLayer(mode: LayerMode): void {
    const config = CONFIGS[mode];
    const state = this.state[mode];
    this.atRest.delete(mode);
    state.segments = null;
    state.dirty = false;
    this.setRuns(config, "main", []);
    this.setRuns(config, "selected", []);
    // Nothing drawn is left to smooth, unless the heat cloud draws along
    // the smoothed flights (see groundedFlights)
    if (
      MODES.every((other) => !this.state[other].segments) &&
      !(this.app.heatCloud && this.app.heatmapVisible)
    ) {
      loadedFeatures()?.releaseGroundedFlights();
    }
    this.pathHover.rehoverOnIdle();
  }

  /**
   * Replace the runs of one source, and its data where the map has it.
   * `recut` writes the same runs again, cut for another zoom: the features
   * the tiles still hold stand for the same runs, so they stay valid, and
   * the flights under the pointer are not "stale" meanwhile.
   */
  private setRuns(
    config: LayerConfig,
    set: RunSet,
    runs: Run[],
    recut = false,
  ): void {
    const state = this.state[config.mode];
    const table = state.tables[set];
    table.runs = runs;
    table.behind = false;
    // The lines of the runs before, which the year worker may still be
    // writing, are not written after these
    const write = ++table.writes;
    // Before the map is asked: without a WebGL context it has no sources,
    // and it comes back with the data of before, whose features must not
    // index into these runs (see restoreModes). A source that never had
    // any has no features to tell apart.
    const g =
      recut || (runs.length === 0 && table.written === null)
        ? table.g
        : ++table.g;

    const map = readyMap(this.app);
    if (!map) {
      this.deferUntilReady(config.mode);
      return;
    }
    // Most redraws happen without a selection; an empty source that stays
    // empty is not worth cutting its tiles again
    if (runs.length === 0 && table.written === null) return;

    // Zoomed in close the 3D view draws the lines (see LIFT_MAX_ZOOM), and
    // so it does without the feature bundle that cuts the ribbons, which
    // could not be loaded (see syncTerrain)
    const threeD = this.app.threeDVisible;
    const ribbons = threeD && isLiftedAt(map.getZoom()) ? this.features : null;
    const id = ribbons ? config.ribbons[set] : config.sources[set];
    // Lifted or flat, the runs are in one source, and leave the other
    const left = table.written && map.getSource<GeoJSONSource>(table.written);
    if (left && table.written !== id) {
      void this.app.dataManager.writeSource(left, NO_FEATURES);
    }

    const moved = table.written !== null && table.written !== id;
    const segments = state.segments ?? [];
    // In the 3D view the ribbons are as wide as the zoom asks
    const widthZoom = ribbonWidthZoom(map.getZoom());
    table.widthZoom = threeD ? widthZoom : null;
    // Zoomed in, the ribbons around the view only
    const box = ribbons ? ribbons.ribbonBox(this.app, map, widthZoom) : null;
    table.box = box;
    // In the 3D view each run is a ribbon at its height, at every zoom
    // (see ui/pathRibbons.ts); flat, a line along the curve through the
    // fixes (see calculations/curves.ts). The lines of every flight are
    // written by the year worker (see services/flightLines.ts), which
    // spares the main thread their curves and MapLibre's copy of them; the
    // selection's few here, in the frame of the click.
    const byWorker = !ribbons && set === "main" && runs.length > 0;
    const features: GeoJSON.Feature<
      GeoJSON.LineString | GeoJSON.MultiPolygon,
      PathRunProperties
    >[] = ribbons
      ? ribbons.ribbonFeatures(this.app, segments, runs, g, widthZoom, box)
      : byWorker
        ? []
        : runLines(segments, runs, g);
    table.written = runs.length === 0 ? null : id;
    if (!map.getSource(id)) return;
    // A recut into the source that has the runs changes nothing a click
    // or the pointer could find; into the other one, it has none of them
    // until its tiles are cut. Around the view only, what was not written
    // before is found once they are: nothing found is no word of the
    // empty map until then.
    const quiet = recut && !moved && !box;
    if (!quiet) table.landing = "worker";
    const land = (content: Blob | GeoJSON.FeatureCollection): void => {
      // A later call has taken over, and answers for itself; the source
      // is asked for again after the worker, for a style that came since
      const target = map.getSource<GeoJSONSource>(id);
      if (table.writes !== write || !target) return;
      const written = this.app.dataManager.writeSource(target, content);
      // A recut that took over from a write still on its way lands for
      // it: the answer for that one was dropped above
      if (quiet && table.landing !== "worker") return;
      // The promise never rejects: a failure arrives as the map's error
      // event. It settles once the worker has the data of the last call,
      // also for a call that was queued behind another; the tiles in view
      // are cut from it after that, unless no layer in use draws the
      // source.
      void written.then(() => {
        if (table.g !== g) return;
        table.landing = map.isSourceLoaded(id) ? null : "tiles";
      });
    };
    if (!byWorker) {
      land({ type: "FeatureCollection", features });
      return;
    }
    this.app.dataManager.askWorker(
      (decoder) => decoder.runsSource(segments, runs, g),
      land,
      // Without the worker the lines are written here, as they were before
      // it wrote them: the source never keeps the lines of runs gone by
      () => {
        if (table.writes !== write) return;
        land({
          type: "FeatureCollection",
          features: runLines(segments, runs, g),
        });
      },
      "the lines of the flights",
    );
  }

  /** Draw every flight of a mode, and the selection on top of them */
  private redrawPaths(mode: LayerMode): void {
    const data = this.app.currentData;
    if (!data) return;

    const config = CONFIGS[mode];
    const state = this.state[mode];
    this.atRest.delete(mode);
    state.segments = data.path_segments;
    state.dirty = false;
    // The flights of another dataset are smoothed anew when they are lifted
    const bundle = loadedFeatures();
    const held = bundle?.heldGroundedFlights();
    if (held && held !== data.path_segments) bundle?.releaseGroundedFlights();
    this.setRuns(
      config,
      "main",
      cutRuns(this.app, config, data, rangeOf(this.app, mode)),
    );
    this.showSelection(config, data);
    this.pathHover.rehoverOnIdle();
  }

  /**
   * Draw the selected paths on the selection's layer, cut at the colour
   * steps of the selection's range, which is shown on them; and give both
   * layers the look the selection asks for. The others stay cut on the
   * full range, dimmed until the selection is cleared.
   */
  private showSelection(config: LayerConfig, data: KMLDataset): void {
    const selected = this.app.selectedPathIds;
    const range = resolveColorRange(this.app, this.state, config);
    this.setRuns(
      config,
      "selected",
      selected.size > 0 ? cutRuns(this.app, config, data, range, selected) : [],
    );
    applyLook(this.app, this.state, config);
    updateLegend(range, config);
  }

  /**
   * Whether a mode is drawn and shown. A drawn mode that is hidden (the
   * replay hides the colour layers and keeps them) is marked to be drawn
   * again as a whole instead: a change of the view is not worth writing to
   * sources nobody sees, and the mode is redrawn as it shows again.
   */
  private drawsNow(mode: LayerMode): boolean {
    const state = this.state[mode];
    if (!state.segments) return false;
    if (this.handleOf(mode).isVisible()) return true;
    state.dirty = true;
    return false;
  }

  /** Cut and write the visible modes again, as the 3D view comes or goes */
  private redrawVisibleModes(): void {
    this.cutAwaited = false;
    for (const mode of MODES) {
      if (this.drawsNow(mode)) this.redrawPaths(mode);
    }
  }

  /**
   * After a lost WebGL context the sources are back with the data of before
   * the loss, and their features with the generations of then, which the
   * run tables may have gone past since: every mode is written again, or
   * emptied, a hidden one once it shows. The filters are set again with
   * them, whatever the map came back with.
   */
  private restoreModes(): void {
    if (this.destroyed) return;
    for (const mode of MODES) {
      this.state[mode].filterKey = "";
      if (!this.state[mode].segments) this.clearLayer(mode);
      else if (this.drawsNow(mode)) this.redrawPaths(mode);
    }
  }

  /**
   * Whether the 3D view draws the relief (terrainActive), and the level it
   * is drawn for (reliefLevel): its exaggeration and how coarse its ground
   * is, which the heights of the flights and the ground they are cut on
   * follow. The level is the one the ribbons are cut for, and changes only
   * as a zoom ends: the map switches the exaggeration of the relief and of
   * the ribbons in one frame (see ui/terrain.ts), and a ribbon stands on
   * the relief of every level around the one it was cut for (see
   * ribbonHeights), so the flights stay on it while the zoom goes on and
   * until they are cut for the new level, as wide as it asks. Returns
   * whether the relief came or went, which the caller answers by cutting
   * the flights anew on their other ground; a level that moved on the
   * relief has the flights set on its ground (see groundedFlights) for
   * the cut at the end of the zoom, and lets go of the ribbons that cannot
   * stay on the relief until then
   * (see followsLevel) or are out of sight. The globe leaves the relief out
   * (MapLibre 6.10 breaks the ribbons up on it) and only shades it
   * (reliefShaded), over the flat ground the ribbons stand on there. Its
   * code, and the code that cuts the ribbons, come with the feature
   * bundle, which is fetched the first time the 3D view is wanted, on the
   * map or on the globe: until it has arrived the relief is not drawn and
   * the cut is left to its arrival (cutAwaited), or to its failure, after
   * which the flights are drawn as lines on the flat map. Cut on the flat
   * ground first, they would be cut twice in a row, and the map's worker
   * hold both cuts at once.
   */
  private syncTerrain(): boolean | null {
    const map = this.listeningTo;
    const shaded = !!map && this.app.threeDVisible;
    const wanted = shaded && !this.app.globeVisible;
    const level = map ? reliefLevel(map.getZoom()) : this.app.reliefLevel;
    const relief = this.app.relief;
    relief.shade(shaded);
    if (shaded && !this.features) {
      void loadFeatures().then((features) => {
        if (this.destroyed || this.features) return;
        if (features) {
          features.followTerrain(this.app);
          features.followHeatCloud(this.app);
          features.followSelectionRibbons(this.app);
          this.features = features;
        }
        // A failure is tried again by the next zoom, not from here
        if ((features && this.syncTerrain()) || this.cutAwaited) {
          this.redrawVisibleModes();
        }
      });
      // Nothing follows the level before the code has arrived, and nothing
      // cuts the ribbons, on the globe either: the cut of the flights waits
      // for it, and one meanwhile, on the flat map, is lifted by it
      relief.moveTo(level);
      this.cutAwaited = true;
      return null;
    }
    const was = this.app.reliefLevel;
    const moved = shaded && level !== was;
    const switched = wanted !== this.app.terrainActive;
    if (!switched && !moved) return false;
    relief.moveTo(level, wanted);
    // Flights on the relief stand on the ground of its level, and are set
    // on the ground of another (see groundedFlights); on the globe, on the
    // line between their fields, the same at every level: there a zoom that
    // ends on another one would set every flight on it again for nothing
    // Moved without a switch, the 3D view is on and its code has arrived
    if (switched || !this.features?.followsLevel(was, level)) {
      // Out of sight until the new cut has landed (ui/terrain.ts)
      this.releaseRibbons(false);
    } else if (moved) {
      // A mode out of sight is cut again as it shows, and would show the
      // cut of before until then, on the ground of another level
      this.releaseRibbons(true);
    }
    return switched;
  }

  /**
   * Empty the ribbons about to be cut on their other ground, before they
   * are, or those of the modes out of sight only (`hiddenOnly`): the map's
   * worker lets go of the tiles of the old cut before it takes in the new
   * one, instead of holding both, and the page of its copy of the old
   * before the new is built. Nobody sees them go: the relief's code hides
   * the ribbons as the relief comes or goes, or the level changes to one
   * they do not follow (see followsLevel), until the new cut has been drawn
   * (ui/terrain.ts). A mode that is hidden is drawn anew as it shows
   * (drawsNow).
   */
  private releaseRibbons(hiddenOnly: boolean): void {
    const map = readyMap(this.app);
    for (const mode of MODES) {
      if (hiddenOnly && this.drawsNow(mode)) continue;
      const ribbons = Object.values(CONFIGS[mode].ribbons);
      for (const { written } of Object.values(this.state[mode].tables)) {
        if (written && ribbons.includes(written)) {
          void map
            ?.getSource<GeoJSONSource>(written)
            ?.setData({ type: "FeatureCollection", features: [] });
        }
      }
    }
  }

  /** Style the layers of both modes again, for ribbonsShown */
  private restyle(): void {
    for (const mode of MODES) applyLook(this.app, this.state, CONFIGS[mode]);
  }

  /**
   * Follow a change of the selection on the visible layers: only the
   * selection's source is rebuilt, the main one keeps its runs and is
   * dimmed and filtered instead. Share mode alone changes neither: the
   * layers are styled again, and the selection keeps the runs it has, and
   * with them the features the tiles hold. Rewritten under a new
   * generation, a click on the map would count as stale until they landed.
   * The main runs a zoom or a pan passed by in isolation are written for
   * the view as they show again.
   */
  updateSelectionStyles(): void {
    const data = this.app.currentData;
    for (const mode of MODES) {
      const visible =
        mode === "altitude"
          ? this.app.altitudeVisible
          : this.app.airspeedVisible;
      const state = this.state[mode];
      if (!visible || !data || !state.segments) continue;
      // While the relief's code is on its way the cut waits for it (see
      // syncTerrain), the selection's too: it was drawn as flat lines in
      // the 3D view meanwhile. Its legend says its range at once.
      if (this.cutAwaited) {
        this.updateModeLegend(mode);
        continue;
      }
      const config = CONFIGS[mode];
      // A mode left behind while it was hidden is drawn again as a whole
      if (state.dirty && this.handleOf(mode).isVisible()) {
        this.redrawPaths(mode);
        continue;
      }
      // A new selection is a new set (see PathSelection.select)
      if (state.shown.selected === this.app.selectedPathIds) {
        applyLook(this.app, this.state, config);
      } else this.showSelection(config, data);
      const main = state.tables.main;
      if (main.behind && !isolatedOut(state, "main")) {
        this.setRuns(config, "main", main.runs, true);
      }
    }
    this.pathHover.rehoverOnIdle();
  }

  /** The legend of `mode` for the range its selection, or all, is shown in */
  private updateModeLegend(mode: LayerMode): void {
    const config = CONFIGS[mode];
    updateLegend(resolveColorRange(this.app, this.state, config), config);
  }

  updateAltitudeLegend(range: Range): void {
    updateLegend(range, CONFIGS.altitude);
  }

  updateAirspeedLegend(range: Range): void {
    updateLegend(range, CONFIGS.airspeed);
  }
}
