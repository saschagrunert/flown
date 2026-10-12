/**
 * Declarative event binding: every `[data-action]` element in the document
 * is wired to the app method of the same name. Buttons get "click", selects
 * get "change", inputs get "input". The mobile bar and its sheets run the
 * same actions through `runAction`, so both ways in obey the same rules.
 */
import type { MapApp } from "../mapApp";
import type { ToggleAction } from "../state/toggles";
import { setUnavailable } from "../utils/buttonState";
import { logError } from "../utils/logger";
import { showToast } from "../utils/toast";
import { focusStatsRail } from "./appChrome";

/** Said for a control that waits for the first load (runAction) */
export const STILL_LOADING_MESSAGE = "Still loading the flights";

/** Why Share mode cannot act yet, on the button and in the phone's sheet */
export const NO_SELECTION_MESSAGE = "Select flights to share";

/** Said for a control that needs flights while none loaded (runAction) */
export const NO_DATA_MESSAGE = "The flights did not load, use Retry";

/**
 * Actions that open something made of the flights: with none loaded, after
 * a load that failed, Wrapped said "0 flights" and the tour that no flight
 * had logged time (see followLoadFailure in appInitializer.ts, which shows
 * their controls unavailable meanwhile)
 */
export const NEED_DATA: ReadonlySet<ActionName> = new Set<ActionName>([
  "toggleStats",
  "showWrapped",
  "toggleReplayAll",
  "toggleHotspotTour",
  "toggleCrossSection",
  "exportMap",
]);

/**
 * Whether a load left the page without flights, so that what is made of
 * them is unavailable: set by followLoadFailure in appInitializer.ts, read
 * by runAction and the phone's bar
 */
export function flightsFailed(): boolean {
  return document.body.classList.contains("flights-failed");
}

/** Why the map could not start, once failStart said so */
export function startFailure(): string | undefined {
  return document.body.dataset["startFailure"];
}

/** Whether a press on a control is answered with the start failure */
let pressesAnswered = false;

/**
 * The map could not start (reportInitFailure in mapApp.ts): every control
 * is unavailable, and says why in the words of the notice on the map. A
 * press says it too. The app's own listeners went with a map that never
 * loaded (`destroy()` aborts them), so the page answers it, ahead of any
 * that are left.
 */
export function failStart(message: string): void {
  document.body.dataset["startFailure"] = message;
  for (const control of document.querySelectorAll<HTMLElement>(
    "[data-action]",
  )) {
    setUnavailable(control, true, message);
  }
  if (pressesAnswered) return;
  pressesAnswered = true;
  const answer = (event: Event): void => {
    const failure = startFailure();
    if (!failure) return;
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest("[data-action]")) return;
    event.stopPropagation();
    showToast(failure);
  };
  document.addEventListener("click", answer, true);
  document.addEventListener("change", answer, true);
}

/**
 * Why the speed layer cannot be switched on: the flights have no times
 * (#airspeed-reason in the template says the same)
 */
export const NO_TIMING_MESSAGE = "No timing data in the flights";

/**
 * Actions that need loaded data. They are ignored while the app is still
 * initializing; pending filter changes are applied afterwards.
 */
export const DEFERRED_WHILE_INITIALIZING: ReadonlySet<ActionName> =
  new Set<ActionName>([
    "filterByYear",
    "filterByAircraft",
    "toggleReplay",
    "toggleReplayAll",
    "toggleCrossSection",
    "toggleHotspotTour",
    "playReplay",
    "pauseReplay",
    "stopReplay",
    "seekReplay",
    "changeReplaySpeed",
    "toggleAutoZoom",
    "showWrapped",
    "exportMap",
    "toggleIsolateSelection",
    "resetView",
  ]);

type ActionHandler = (e?: Event) => void;

/**
 * Every action by name. The toggles name theirs in state/toggles.ts, and
 * the compiler holds this to handling each of them.
 */
function actionHandlers(app: MapApp) {
  return {
    toggleHeatmap: () => app.uiToggles.toggleHeatmap(),
    // A store write: the rail follows the key, and the panel's own code,
    // which is lazily loaded, arrives on the first opening (ui/statsPanel.ts).
    // Opened from the keyboard (a click without a pointer, detail 0), the
    // focus goes into the rail, as it goes into the sheets and Wrapped: on
    // the button it left the panel 21 presses of Tab away, past every
    // airport marker.
    toggleStats: (e) => {
      app.statsPanelVisible = !app.statsPanelVisible;
      if (app.statsPanelVisible && (e as MouseEvent | undefined)?.detail === 0)
        focusStatsRail();
    },
    toggleAltitude: () => app.uiToggles.toggleAltitude(),
    toggleAirspeed: () => app.uiToggles.toggleAirspeed(),
    toggleAirports: () => app.uiToggles.toggleAirports(),
    toggleAviation: () => app.uiToggles.toggleAviation(),
    toggleGlobe: () => app.mapOrientation.toggleGlobe(),
    toggleThreeD: () => app.mapOrientation.toggleThreeD(),
    toggleSatellite: () => app.uiToggles.toggleSatellite(),
    resetNorth: () => app.mapOrientation.resetNorth(),
    resetView: () => {
      app.resetView().catch(logError);
    },
    // Replay, the hotspot tour, Wrapped, the cross-section and the search
    // live in lazily loaded bundles. Only these six can be the first thing
    // a visitor touches; the rest are on chrome that exists only once the
    // feature is open, so they find the manager already there.
    toggleReplay: () => app.toggleReplay(),
    toggleReplayAll: () => app.toggleReplayAll(),
    toggleCrossSection: () => app.toggleCrossSection(),
    toggleHotspotTour: () => app.toggleHotspotTour(),
    // Not deferred while the first year loads: the airports and the places
    // it finds are no part of the flights
    toggleSearch: () => app.toggleSearch(),
    // The `/` key, which opens the search or goes back to its field
    openSearch: () => app.toggleSearch(true),
    // Once the dropdown stops changing, see FilterManager.pickYear
    filterByYear: () => app.filterManager.pickYear(),
    filterByAircraft: () => app.filterManager.filterByAircraft(),
    exportMap: () => app.uiToggles.exportMap(),
    shareLink: () => {
      void app.uiToggles.shareLink();
    },
    showWrapped: () => {
      void app
        .loadWrapped()
        .then((manager) => manager?.showWrapped(true))
        .catch(logError);
    },
    closeWrapped: () => app.wrappedManager?.closeWrapped(),
    toggleIsolateSelection: () => app.pathSelection.toggleIsolateSelection(),
    playReplay: () => app.replayManager?.playReplay(),
    pauseReplay: () => app.replayManager?.pauseReplay(),
    stopReplay: () => app.replayManager?.stopReplay(),
    seekReplay: (e) =>
      app.replayManager?.seekReplay((e?.target as HTMLInputElement).value),
    changeReplaySpeed: () => app.replayManager?.changeReplaySpeed(),
    toggleAutoZoom: () => app.replayManager?.toggleAutoZoom(),
  } satisfies Record<ToggleAction, ActionHandler> &
    Record<string, ActionHandler>;
}

/** The name of an action, as a control's `data-action` gives it */
export type ActionName = keyof ReturnType<typeof actionHandlers>;

/**
 * Run an action by name, the way a click on its control does. Data-dependent
 * actions are ignored while `app.isInitializing` is true, with a word that
 * the flights are still loading: the phone's bar called the app directly
 * and skipped this, and a Reset view during the first load switched the
 * year under the load that was still running. Returns whether the action
 * ran.
 */
export function runAction(app: MapApp, action: ActionName, e?: Event): boolean {
  // Built for the one call: a click is rare enough, and nothing has to
  // keep the handlers of an app that is gone. A name from the page may be
  // none the app knows.
  const handlers: Partial<Record<string, ActionHandler>> = actionHandlers(app);
  const fn = handlers[action];
  if (!fn) return false;
  // A key or the phone's bar may still call this after a failed start
  const failure = startFailure();
  if (failure) {
    showToast(failure);
    return false;
  }
  if (app.isInitializing && DEFERRED_WHILE_INITIALIZING.has(action)) {
    // The controls look ready and a click would do nothing without a word.
    // Not for a filter, whose change is applied once the load is over.
    if (!action.startsWith("filter")) showToast(STILL_LOADING_MESSAGE);
    return false;
  }
  // An open statistics rail can still be closed
  if (
    flightsFailed() &&
    NEED_DATA.has(action) &&
    !(action === "toggleStats" && app.statsPanelVisible)
  ) {
    showToast(NO_DATA_MESSAGE);
    return false;
  }
  fn(e);
  return true;
}

/**
 * Bind data-action attributes to app methods via addEventListener.
 * Handlers are bound before initialization completes; see runAction for
 * the ones that wait for it.
 */
export function bindActions(app: MapApp): void {
  document.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
    const action = el.dataset["action"];
    if (!action) return;
    // The template names the action; runAction ignores one it has not
    // got, and a unit test checks the template against the handlers
    const handler = (e: Event): void => {
      runAction(app, action as ActionName, e);
    };
    const type =
      el.tagName === "SELECT"
        ? "change"
        : el.tagName === "INPUT"
          ? "input"
          : "click";
    el.addEventListener(type, handler, { signal: app.signal });
  });
}
