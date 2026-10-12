/**
 * Path look - how the colour layers show a selection, and their legends
 *
 * A selection does not rebuild the runs of every flight (see
 * ui/layerManager.ts): the selected flights are cut again on a source of
 * their own, on the colour range of the selection (`resolveColorRange`,
 * kept for as long as the selection, the dataset and the full range stay
 * the same), and the look of both layers of a mode is set with a few paint
 * properties and a filter (`applyLook`): the others dimmed, or in isolate
 * mode left out, the lines and the ribbons of the 3D view alike. The
 * legend of a mode names the ends and the middle of the range its runs are
 * coloured on (`updateLegend`), and the values under the pointer are
 * coloured on the same range (`formatSegmentTooltip`). The layer manager
 * owns the state of each mode and hands it in; nothing here keeps any.
 */
import type { ExpressionSpecification } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { Range } from "../state/store";
import type { PathSegment } from "../types";
import { domCache } from "../utils/domCache";
import { generateSegmentPopupHtml } from "../utils/htmlGenerators";
import { segmentsForPathIds } from "../calculations/statistics";
import { shownSelection } from "../calculations/datasetIndex";
import { calculateSegmentProperties, rangeMiddle } from "../features/layers";
import {
  CONFIGS,
  readyMap,
  type LayerConfig,
  type LayerMode,
  type ModeState,
  type ShownSelection,
} from "./pathRuns";

/**
 * Width and opacity of the runs of a selected or an unselected path. The
 * numbers are those of `calculateSegmentProperties`, asked for a path that
 * stands in for every path of its kind, since a layer has one look.
 */
function runLook(
  isSelected: boolean,
  shown: ShownSelection,
): { weight: number; opacity: number } {
  const hasSelection = shown.selected.size > 0;
  const { weight, opacity } = calculateSegmentProperties({
    pathId: 0,
    selectedPathIds: new Set(isSelected ? [0] : hasSelection ? [1] : []),
    isolateSelection: shown.isolate,
  });
  return { weight, opacity };
}

/** The colour range of a mode over every flight */
export function rangeOf(app: MapApp, mode: LayerMode): Range {
  return mode === "altitude" ? app.altitudeRange : app.airspeedRange;
}

/**
 * Colour range used for the layer: the selected paths' range when a
 * selection exists, the layer's full range otherwise. The selection's is
 * kept until the selection, the dataset or the full range changes: the
 * tooltip asks for both modes' on every segment it shows, and working
 * them out took milliseconds with a hundred flights selected.
 */
export function resolveColorRange(
  app: MapApp,
  states: Readonly<Record<LayerMode, ModeState>>,
  config: LayerConfig,
): Range {
  // Of what is drawn: share mode keeps the flights the filter hides
  const selected = shownSelection(app);
  const data = app.currentData;
  const full = rangeOf(app, config.mode);
  if (selected.size === 0 || !data) return full;
  const state = states[config.mode];
  const held = state.selectionRange;
  if (
    held?.data === data &&
    held.full === full &&
    held.selected.size === selected.size &&
    [...selected].every((id) => held.selected.has(id))
  ) {
    return held.range;
  }
  // Only the selected paths' segments, sliced out through the path index:
  // a selection click should not walk the whole dataset
  const range = config.computeRange(
    segmentsForPathIds(data.path_segments, selected),
    full,
    data.path_info,
  );
  state.selectionRange = { data, full, selected, range };
  return range;
}

/**
 * Style the two layers of a mode for the current selection. The handle
 * owns their visibility, so what the main layer must not show (the
 * selected flights, drawn on top, or in share mode everything) is left
 * out by a filter.
 */
export function applyLook(
  app: MapApp,
  states: Readonly<Record<LayerMode, ModeState>>,
  config: LayerConfig,
): void {
  const state = states[config.mode];
  // A selection is never changed in place (see PathSelection.select)
  const shown: ShownSelection = {
    selected: app.selectedPathIds,
    isolate: app.isolateSelection,
  };
  state.shown = shown;
  const map = readyMap(app);
  if (!map) return;

  const selectedLook = runLook(true, shown);
  const mainOpacity = runLook(false, shown).opacity;
  map.setPaintProperty(config.layers.main, "line-opacity", mainOpacity);
  map.setPaintProperty(
    config.layers.selected,
    "line-width",
    selectedLook.weight,
  );
  map.setPaintProperty(
    config.layers.selected,
    "line-opacity",
    selectedLook.opacity,
  );
  // The ribbons of the 3D view, dimmed for a selection like the lines,
  // and out of sight while they settle on another ground
  const ribbonsShown = app.relief.ribbonsShown;
  map.setPaintProperty(
    config.ribbons.main,
    "fill-extrusion-opacity",
    mainOpacity * ribbonsShown,
  );
  map.setPaintProperty(
    config.ribbons.selected,
    "fill-extrusion-opacity",
    selectedLook.opacity * ribbonsShown,
  );

  let filter: ExpressionSpecification | null = null;
  if (shown.selected.size > 0) {
    filter = shown.isolate
      ? ["literal", false]
      : ["!", ["in", ["get", "pathId"], ["literal", [...shown.selected]]]];
  }
  // A filter cuts the tiles of the layer again, even one equal to the last
  const filterKey = JSON.stringify(filter);
  if (filterKey !== state.filterKey) {
    state.filterKey = filterKey;
    map.setFilter(config.layers.main, filter);
    map.setFilter(config.ribbons.main, filter);
  }
}

/** Coloured on the same range as the runs, the selection's if any */
export function formatSegmentTooltip(
  app: MapApp,
  states: Readonly<Record<LayerMode, ModeState>>,
  segment: PathSegment,
): string {
  const altitude = resolveColorRange(app, states, CONFIGS.altitude);
  const speed = resolveColorRange(app, states, CONFIGS.airspeed);
  return generateSegmentPopupHtml({
    segment,
    altRange: altitude,
    speedRange: speed,
  });
}

/**
 * Label a legend with the ends of `range` and the value in the middle of
 * its ramp: spread by rank, the colours of the middle are the median's,
 * not those of the value halfway between the ends (see rangeMiddle)
 */
export function updateLegend(
  range: Range,
  config: Pick<
    LayerConfig,
    "legendMinId" | "legendMidId" | "legendMaxId" | "formatLegend"
  >,
): void {
  const minEl = domCache.get(config.legendMinId);
  const midEl = domCache.get(config.legendMidId);
  const maxEl = domCache.get(config.legendMaxId);
  if (minEl) minEl.textContent = config.formatLegend(range.min);
  if (midEl) midEl.textContent = config.formatLegend(rangeMiddle(range));
  if (maxEl) maxEl.textContent = config.formatLegend(range.max);
}
