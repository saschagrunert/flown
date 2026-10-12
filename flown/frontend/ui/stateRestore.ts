/**
 * State restore - the view a link or the last visit left, put back at start
 *
 * MapApp.initialize runs `restoreState` first of all, before the map and
 * the managers exist: the state manager reads the saved state (the link's,
 * or the one kept in the browser, see ui/stateManager.ts), and the year,
 * the aircraft, the selection, the layers and how the map is drawn go into
 * the store in one batch, so the first load already draws what the visitor
 * had. The camera is not the store's: MapApp.setupMap opens the map on the
 * saved view. The panels reopen once there is data for them (see
 * MapApp.initialize), which is why RESTORED_TOGGLES leaves them out.
 *
 * `applyPendingFilterChanges` is the other end of the first load: the year
 * and aircraft dropdowns can be changed while it runs, which the bound
 * handlers ignore until then, and it applies what they show once it is
 * over.
 */
import type { MapApp } from "../mapApp";
import { TOGGLES, type Toggle, type ToggleKey } from "../state/toggles";
import { domCache } from "../utils/domCache";
import { StateManager } from "./stateManager";

/**
 * The toggles `restoreState` sets from a saved state. The panels reopen
 * once there is data for them (see initialize), and share mode needs a
 * selection, which `restoreState` sees to on its own.
 */
const RESTORED_TOGGLES: readonly ToggleKey[] = TOGGLES.filter(
  (toggle: Toggle) => !("panel" in toggle) && toggle.key !== "isolateSelection",
).map((toggle) => toggle.key);

/**
 * Year/aircraft select changes during initialization are ignored by the
 * bound handlers; apply them once the initial data is loaded.
 */
export async function applyPendingFilterChanges(app: MapApp): Promise<void> {
  const yearSelect = domCache.get("year-select", HTMLSelectElement);
  const aircraftSelect = domCache.get("aircraft-select", HTMLSelectElement);
  // Capture both before filtering: switching the year rebuilds the aircraft
  // dropdown and would otherwise overwrite a pending aircraft selection.
  // A first load that failed leaves its year in the dropdown (see
  // loadInitialData), so it is no change either
  const pendingYear =
    yearSelect && yearSelect.value !== app.selectedYear
      ? yearSelect.value
      : null;
  const pendingAircraft =
    aircraftSelect && aircraftSelect.value !== app.selectedAircraft
      ? aircraftSelect.value
      : null;

  if (pendingYear !== null) {
    await app.filterManager.filterByYear();
  }

  if (pendingAircraft === null || !aircraftSelect) {
    return;
  }
  // The aircraft may not exist in the newly selected year
  const stillAvailable = Array.from(aircraftSelect.options).some(
    (option) => option.value === pendingAircraft,
  );
  if (!stillAvailable || pendingAircraft === app.selectedAircraft) {
    return;
  }
  aircraftSelect.value = pendingAircraft;
  app.filterManager.filterByAircraft();
}

export function restoreState(app: MapApp): void {
  app.stateManager = new StateManager(app);
  app.savedState = app.stateManager.loadState();

  if (!app.savedState) return;

  const state = app.savedState;
  app.store.batch(() => {
    const year = state.selectedYear;
    if (year !== undefined) {
      app.selectedYear = year;
      app.restoredYearFromState = true;
      // The dropdown names the year from the start, as it does the
      // latest for a first visit (resolveYearSelection): an option of
      // its own until the list of years replaces it
      const select = domCache.get("year-select", HTMLSelectElement);
      if (select) {
        select.value = year;
        if (select.value !== year) {
          select.add(new Option(year, year, true, true));
        }
      }
    }
    if (state.selectedAircraft) {
      app.selectedAircraft = state.selectedAircraft;
    }

    // Restore selected paths BEFORE updateLayers() so paths are drawn with correct selection
    if (state.selectedPathIds && state.selectedPathIds.length > 0) {
      app.selectedPathIds = new Set([
        ...app.selectedPathIds,
        ...state.selectedPathIds,
      ]);
    }

    // Restore the layers and how the map is drawn
    for (const key of RESTORED_TOGGLES) {
      const value = state[key];
      if (value !== undefined) app.store.set(key, value);
    }
    // The tool opens on it once the flights are in (see initialize)
    if (state.crossSectionLine) app.crossSectionLine = state.crossSectionLine;
    // Altitude and speed colour the same paths, and the toggles never
    // leave both on (setColorLayer); a link written by hand, or with every
    // flag of `v` set, can. Altitude is the one kept, as it needs no
    // timing data.
    if (app.altitudeVisible && app.airspeedVisible) {
      app.airspeedVisible = false;
    }
    // Sharing nothing is not a state the controls can leave: a link
    // written before path ids were versioned drops its selection but still
    // carries the share mode flag. The flights its filter hides stay
    // shared, and the chip says so (see fitSelection).
    if (state.isolateSelection !== undefined) {
      app.isolateSelection =
        state.isolateSelection && app.selectedPathIds.size > 0;
    }
  });
}
