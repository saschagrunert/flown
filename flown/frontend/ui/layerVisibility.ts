/**
 * Layer visibility - What each layer shows follows from the store alone
 */
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import {
  applyLegendVisibility,
  applyToggleButtonState,
} from "../utils/buttonState";
import { domCache } from "../utils/domCache";
import { loadFeatures } from "../services/featureLoader";
import { TRY_AGAIN } from "../services/lazyImport";
import {
  AVIATION_SHOWN_STATE,
  aviationDrawsAt,
  HEAT_SHOWN_STATE,
} from "../mapLayers";
import { dismissToast, showToast } from "../utils/toast";
import { onMapReady } from "../utils/mapHelpers";

/** Said when the imagery's code cannot be fetched and the switch goes off */
export const SATELLITE_UNAVAILABLE_MESSAGE =
  "Satellite imagery is unavailable: its code could not be loaded" + TRY_AGAIN;

/** The keys the layers follow */
const LAYER_KEYS: readonly (keyof StoreState)[] = [
  "heatmapVisible",
  "altitudeVisible",
  "airspeedVisible",
  "airportsVisible",
  "aviationVisible",
  "aviationInView",
  "replayActive",
  "selectedPathIds",
  "heatCloud",
];

/**
 * Whether the selected flights are drawn as lines over the heatmap (see
 * ui/selectionHighlight.ts): while there are any and nothing else draws
 * them. A colour layer draws them on its own, and a replay its route.
 * Share mode does not matter: it narrows the heatmap, the lines still say
 * which flights are the selected ones.
 */
export function highlightsSelection(app: MapApp): boolean {
  return (
    app.selectedPathIds.size > 0 &&
    !app.altitudeVisible &&
    !app.airspeedVisible &&
    !app.replayActive
  );
}

/**
 * Whether the aviation chart is on and drawn: it has tiles for a band of
 * zooms only (aviationDrawsAt), and outside it the heat dimmed for a chart
 * that was not there
 */
function showsAviation(app: MapApp): boolean {
  return app.aviationVisible && app.aviationInView;
}

/**
 * Whether the heatmap steps back for what is drawn over it: a colour layer,
 * the selection's lines, or the aviation chart, whose airspace outlines and
 * labels drowned under the bloom at full strength. Worked out here with the
 * lines themselves, so the two cannot disagree. The heat's legend follows
 * it; the paint of the heat and the base map's labels follows the chart's
 * band by zoom itself (see dimsHeatmapAtAnyZoom).
 */
export function dimsHeatmap(app: MapApp): boolean {
  return dimsHeatmapAtAnyZoom(app) || showsAviation(app);
}

/**
 * Whether the heatmap steps back at every zoom: for a colour layer or the
 * selection's lines, which draw at all of them. The aviation chart draws
 * at a band of zooms only, which the paint of the heat and of the base
 * map's labels follows in every frame of a pinch (DataManager's
 * applyHeatmapEmphasis, AVIATION_SHOWN_STATE).
 */
export function dimsHeatmapAtAnyZoom(app: MapApp): boolean {
  return app.altitudeVisible || app.airspeedVisible || highlightsSelection(app);
}

/**
 * Whether the heat cloud of the 3D view steps back (ui/heatCloud.ts): for
 * the aviation chart and a selection's lines, as the heatmap does, but not
 * for a colour layer. Its ribbons are drawn in front of the cloud, not
 * washed out by a bloom under them, and a cloud dimmed for them was a faint
 * halo round the flights it is meant to show.
 */
export function dimsHeatCloud(app: MapApp): boolean {
  return showsAviation(app) || highlightsSelection(app);
}

/**
 * Whether paths are coloured by altitude: the altitude layer, or a replay
 * trail, which takes altitude colours unless the speed layer is on. The
 * trails of the replay of every flight take the layer's that is on, if any.
 */
export function altitudeColours(app: MapApp): boolean {
  return (
    app.altitudeVisible ||
    (app.replayActive && !app.replayState.all && !app.airspeedVisible)
  );
}

/**
 * Show every layer the store asks for. The layer flags keep what the user
 * chose, and a running replay hides the heatmap and the colour layers on
 * top of them, so closing it brings back exactly that choice. The 3D view
 * draws the heat as a cloud (ui/heatCloud.ts) in place of the flat heatmap,
 * which steps aside while the cloud is on the map. The lines of a selection
 * show where nothing else draws it, and the legend of the heat while no
 * colour layer brings its own. Nothing else sets the
 * visibility of these layers, the heatmap's toggle or the altitude scale:
 * a toggle, a restored link and the start and end of a replay only write
 * store keys.
 */
export function followLayerVisibility(app: MapApp): void {
  const apply = (): void => {
    const replay = app.replayActive;
    const heatmap = app.heatmapVisible && !replay;
    const flat = heatmap && !app.heatCloud;
    if (flat !== app.heatmapLayer.isVisible()) {
      if (flat) app.dataManager.showHeatmap();
      else app.heatmapLayer.setVisible(false);
    }
    // Which of heatmap and colour layer reads first follows the flags too
    app.dataManager.applyHeatmapEmphasis();
    app.layerManager.syncModes();
    app.airportLayer.setVisible(app.airportsVisible);
    app.aviationLayer.setVisible(app.aviationVisible);
    app.selectionHighlightLayer.setVisible(highlightsSelection(app));

    // The heatmap is hidden for a replay, so its toggle must not report it as
    // on; the heat cloud stays through one, faintly in the 3D view and building
    // up behind the flights of the replay of all flights, and its toggle says
    // so. The replay trail is coloured by altitude unless the speed layer is
    // on, so it needs the altitude scale with neither layer on, and the
    // altitude toggle says so: it said off over a trail and a legend in
    // altitude colours.
    const button = domCache.get("heatmap-btn");
    if (button) {
      applyToggleButtonState(
        button,
        heatmap || (app.heatCloud && app.heatmapVisible),
      );
    }
    const altitude = altitudeColours(app);
    const altitudeButton = domCache.get("altitude-btn");
    if (altitudeButton) applyToggleButtonState(altitudeButton, altitude);
    const legend = domCache.get("altitude-legend");
    if (legend) applyLegendVisibility(legend, altitude);
    // The heat's legend (ui/heatLegend.ts) while the heat is the colour
    // the map shows, and as faint as the heat when it steps back (the
    // cloud steps back for the same, dimsHeatCloud, while no colour layer
    // hides the legend)
    const heatLegend = domCache.get("heat-legend");
    if (heatLegend) {
      applyLegendVisibility(
        heatLegend,
        heatmap && !app.altitudeVisible && !app.airspeedVisible,
      );
      heatLegend.classList.toggle("is-dimmed", dimsHeatmap(app));
    }
  };
  app.store.subscribeKeys(LAYER_KEYS, apply);
  apply();
  // The base map's labels step back while the heat is drawn at full
  // strength (see HEAT_SHOWN_STATE), which needs the style. A style built
  // anew (the base style where its difference failed, or after a lost
  // WebGL context) starts from its own state, so it is set again on each
  onMapReady(app, "The labels of the base map", (map) => {
    const labels = (): void => {
      try {
        map.setGlobalStateProperty(
          HEAT_SHOWN_STATE,
          app.heatmapVisible && !app.replayActive && !dimsHeatmapAtAnyZoom(app),
        );
        map.setGlobalStateProperty(AVIATION_SHOWN_STATE, app.aviationVisible);
      } catch {
        // A style still loading: it is set when it has loaded
      }
    };
    app.store.subscribeKeys(LAYER_KEYS, labels);
    map.on("style.load", labels);
    labels();
    // Where the map comes to rest, which the heat's legend and the heat
    // cloud follow (the paint of the heat follows the zoom itself): the
    // store only tells when the zoom crosses into or out of the chart's
    // band
    const zoomed = (): void => {
      app.aviationInView = aviationDrawsAt(map.getZoom());
    };
    const zooms = map.on("zoomend", zoomed);
    app.signal.addEventListener("abort", () => zooms.unsubscribe());
    zoomed();
  });
}

/**
 * Switch a colour layer on or off. Altitude and speed colour the same
 * paths, so one on switches the other off, in the same update: nobody sees
 * both on for a moment. Returns whether it did.
 */
export function setColorLayer(
  app: MapApp,
  mode: "altitude" | "airspeed",
  visible: boolean,
): boolean {
  const other = mode === "altitude" ? "airspeedVisible" : "altitudeVisible";
  const replaced = visible && app[other];
  app.store.batch(() => {
    app[`${mode}Visible`] = visible;
    if (visible) app[other] = false;
  });
  return replaced;
}

/**
 * Fetch the code of the satellite imagery (ui/satellite.ts) the first time
 * the switch is on, from a link or saved state too, and hand the switch to
 * it. It comes with the feature bundle: most visits never turn it on. A
 * bundle that cannot be fetched turns the switch back off if it is still on,
 * so it does not claim imagery the map does not draw, and the next press
 * asks again.
 */
export function followSatelliteSwitch(app: MapApp): void {
  let loading = false;
  const load = (): void => {
    if (!app.satelliteVisible || loading) return;
    loading = true;
    void loadFeatures().then((features) => {
      if (app.signal.aborted) return;
      loading = false;
      if (features) {
        // A failure of an earlier try stays until dismissed
        dismissToast(SATELLITE_UNAVAILABLE_MESSAGE);
        stop();
        features.followSatellite(app);
        return;
      }
      // A switch turned off again while the code was on its way claims
      // nothing, so there is nothing to take back or to report
      if (!app.satelliteVisible) return;
      app.satelliteVisible = false;
      showToast(SATELLITE_UNAVAILABLE_MESSAGE, "error");
    });
  };
  const stop = app.store.subscribe("satelliteVisible", load);
  load();
}
