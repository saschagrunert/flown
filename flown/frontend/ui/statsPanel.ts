/**
 * The part of the statistics panel that is there from the first paint.
 *
 * The panel's content and the figures in it are a lazily loaded part of the
 * Wrapped bundle (ui/statsManager.ts, calculations/panelStats.ts): most
 * visits never open the panel, and it is too large to ship with the map.
 * The rail, its triggers and the `statsPanelVisible` key stay in the app
 * (see setupStatsRail in ui/appChrome.ts), so it opens at once; this
 * fetches the bundle the first time it does and starts the stats manager,
 * which follows the store from then on. Until the bundle is in, the panel
 * says it is loading.
 * When it cannot be fetched the app says so (see MapApp.loadStats) and the
 * rail closes again, so opening it once more tries again.
 */
import type { MapApp } from "../mapApp";
import { loadWrapped } from "../services/featureLoader";
import { domCache } from "../utils/domCache";
import { logError } from "../utils/logger";
import { isPageEscape } from "../utils/mapHelpers";

/** Panel element the statistics are rendered into */
export const STATS_PANEL_ID = "stats-panel";

/**
 * What the panel shows while its code is on the way, and while the stats
 * manager works out the statistics of a large filter
 */
export const LOADING_HTML =
  '<p class="kh-stats-loading" role="status">Loading statistics…</p>';

/**
 * Title the rail for the statistics of a selection, or of the filter. The
 * stats manager and the loading state share it.
 */
export function setStatsTitle(isSelection: boolean): void {
  const textEl = document.querySelector(
    "#stats-rail-title .kh-stats-title-text",
  );
  if (textEl) {
    textEl.textContent = isSelection
      ? "Statistics of the selection"
      : "Statistics";
  }
}

/**
 * Load the statistics panel the first time it opens, and fetch it ahead
 * when the page is to open with it (a link or the saved state), so that it
 * is there by the time the first year has loaded and the rail opens.
 */
export function followStatsPanel(app: MapApp): void {
  // Closed and opened again during the load, the panel waits for the same
  let loading = false;
  const open = (visible: boolean): void => {
    if (!visible || app.statsManager || loading) return;
    loading = true;
    const panel = domCache.get(STATS_PANEL_ID);
    // A title of the filter over a selection's figures would be wrong for
    // as long as the bundle takes
    setStatsTitle(app.selectedPathIds.size > 0);
    if (panel) {
      panel.innerHTML = LOADING_HTML;
      panel.setAttribute("aria-busy", "true");
    }
    void app
      .loadStats()
      .then((manager) => {
        // The manager renders itself once it is there, which ends the wait
        if (manager) return;
        panel?.removeAttribute("aria-busy");
        panel?.replaceChildren();
        app.statsPanelVisible = false;
      })
      .catch(logError)
      .finally(() => {
        loading = false;
      });
  };

  if (app.savedState?.statsPanelVisible) void loadWrapped();
  open(app.statsPanelVisible);
  app.store.subscribe("statsPanelVisible", open);
  // On a phone the panel is a sheet over the map without the collapse
  // control of the rail, which the bar's Stats tab stands in for: Escape
  // closes it, as it closes the other sheets, and the focus goes to that
  // tab (see setupStatsRail). The bar steps aside for a replay and the
  // hotspot tour, which hide the sheet and take Escape. Not an Escape for
  // a popup, a marker or the readout of the cloud, which close first, nor
  // one that empties the search of the flights. Nor while a sheet of the
  // bar is open over it, which Escape closes alone: one press closed both.
  document.addEventListener(
    "keydown",
    (event) => {
      if (
        isPageEscape(event, ",input[type=search]") &&
        app.statsPanelVisible &&
        !app.wrappedVisible &&
        app.mobileBar?.isVisible() &&
        !app.mobileBar.sheetOpen()
      ) {
        event.preventDefault();
        app.statsPanelVisible = false;
      }
    },
    { signal: app.signal },
  );
}
