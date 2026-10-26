/**
 * State Manager - Handles state persistence (localStorage, URL)
 */
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import {
  TOGGLE_KEYS,
  TOGGLES,
  type ToggleFlags,
  type ToggleKey,
} from "../state/toggles";
import type { MapCenter, SavedState } from "../types";
import { followedUnreadLink } from "../state/shareToken";
import {
  isPathId,
  isSupportedSchemaVersion,
  STATE_SCHEMA_VERSION,
  encodeStateToUrl,
  isSectionLine,
  parseUrlParams,
} from "../state/urlState";
import { toMapBearing, toMapCenter, toMapPitch } from "../utils/geometry";
import { mapZoomToState } from "../utils/mapHelpers";
import { flightsKey, STATE_KEY } from "../state/localFlags";

/**
 * Whether the page started on the visitor's flights (setLocalStateMode),
 * which decides the key for the page's lifetime: the flag in localStorage
 * is what the next start reads, and a shared link opens on the site's
 * flights whatever it says, another tab may flip it, and the switch
 * itself sets it before the page unloads and saves.
 */
let localMode = false;

/** Told once at start, from the configuration the app starts with */
export function setLocalStateMode(local: boolean): void {
  localMode = local;
}

/**
 * Storage key of the map at this location. Every page of an origin shares
 * one localStorage, so two maps published side by side (user.github.io/a/
 * and /b/) would otherwise restore each other's year, view and selection.
 * The key names the page's directory, which index.html and its folder share;
 * a map at the root of its origin uses the bare key. A page that shows the
 * flights a visitor dropped (ui/localFlights.ts) keeps a state of its own
 * under `:local`: the year, the aircraft and the selection of one set of
 * flights name none of the other's (flightsKey in state/localFlags.ts).
 */
export function storageKey(
  pathname: string = window.location.pathname,
  local: boolean = localMode,
): string {
  return flightsKey(STATE_KEY, local, pathname);
}

/**
 * What a session keeps of the store: the filters, every toggle and the
 * line of the cross-section
 */
const PERSISTED_KEYS: readonly (keyof StoreState)[] = [
  "selectedYear",
  "selectedAircraft",
  "selectedPathIds",
  ...TOGGLE_KEYS,
  "crossSectionLine",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Pick the known, correctly typed fields of a candidate state object.
 * Unknown keys and values of the wrong type are dropped.
 */
export function sanitizeSavedState(candidate: unknown): SavedState {
  const result: SavedState = {};
  if (!isRecord(candidate)) return result;

  if (typeof candidate["selectedYear"] === "string") {
    result.selectedYear = candidate["selectedYear"];
  }
  if (typeof candidate["selectedAircraft"] === "string") {
    result.selectedAircraft = candidate["selectedAircraft"];
  }
  const zoom = candidate["zoom"];
  if (typeof zoom === "number" && isFinite(zoom)) {
    result.zoom = zoom;
  }
  // The rule of the links (parseUrlParams): a centre the map cannot take is
  // dropped and the rest of the state kept, here and in `loadMapState`
  const center = candidate["center"];
  if (isRecord(center)) {
    const point = toMapCenter({ lat: center["lat"], lng: center["lng"] });
    if (point) result.center = point;
  }
  // Absent from every state saved before the map could turn, which leaves
  // those north up and flat
  const bearing = toMapBearing(candidate["bearing"]);
  if (bearing !== null) result.bearing = bearing;
  const pitch = toMapPitch(candidate["pitch"]);
  if (pitch !== null) result.pitch = pitch;
  for (const key of TOGGLE_KEYS) {
    const value = candidate[key];
    if (typeof value === "boolean") {
      result[key] = value;
    }
  }
  const line = candidate["crossSectionLine"];
  if (isSectionLine(line)) result.crossSectionLine = line;
  // Path ids are only meaningful when they were written with an id scheme
  // this build reads; older payloads refer to different flights. Schema 4
  // only changed how a link spells the ids, so a selection saved as 3 still
  // names the same flights and is kept (see urlState).
  const pathIds = candidate["selectedPathIds"];
  if (
    Array.isArray(pathIds) &&
    isSupportedSchemaVersion(candidate["schemaVersion"])
  ) {
    result.selectedPathIds = pathIds.filter(isPathId);
  }
  return result;
}

export class StateManager {
  private app: MapApp;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Store keys that changed since the state was restored */
  private changed = new Set<keyof StoreState>();
  /**
   * Whether the page was opened from a link to shared flights (see
   * takeShareIntro) and still shares them: the sender's flights in share
   * mode, which the visitor's next visit without a link opened on as if
   * they were theirs. Nothing is saved for that visit until share mode
   * ends; the link in the address bar follows the state as ever.
   */
  visiting = false;

  constructor(app: MapApp) {
    this.app = app;

    // A change made just before the page goes away would still be waiting
    // for the debounce, and nothing runs once the page is gone
    window.addEventListener(
      "pagehide",
      () => {
        if (this.saveTimer !== null) this.flush();
      },
      { signal: app.signal },
    );

    for (const key of PERSISTED_KEYS) {
      app.store.subscribe(key, () => {
        this.changed.add(key);
        this.scheduleSave();
      });
    }
  }

  /** Drop the pending save, if any */
  cancelSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
  }

  /**
   * A panel flag as it is to be saved. The statistics reopen once the data
   * has loaded and Wrapped half a second after that, while the restore
   * itself already schedules a save: until the store has a say, a save (or
   * a share, which flushes one) writes what was restored, not "closed".
   * MapApp drops a restored flag it gave up on.
   */
  private panelVisible(key: ToggleKey): boolean {
    return (
      (!this.changed.has(key) && this.app.savedState?.[key] === true) ||
      this.app[key]
    );
  }

  scheduleSave(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveMapState();
    }, 300);
  }

  /**
   * Save right now instead of after the debounce. Only the share action
   * needs this: it reads the URL the moment the user asks for it, or the
   * state saved, which it returns (none without a map).
   */
  flush(): SavedState | undefined {
    this.cancelSave();
    return this.saveMapState();
  }

  saveMapState(): SavedState | undefined {
    if (!this.app.map) return;

    // While Wrapped has the map fitted to all the data, the view worth
    // keeping is the one the user had before, and so it is while the
    // replay's chase view flies the map along a flight. The `?.` is for
    // both living in lazily loaded bundles: before one has ever been opened
    // there is no saved view either way. Wrapped keeps the user's globe and
    // 3D switches with it, which its intro changes for a while, and so does
    // the hotspot tour with the 3D view and the heatmap it turns on.
    const wrapped = this.app.wrappedManager?.userMapView() ?? this.app.tourView;
    const kept: Partial<ToggleFlags> = wrapped ?? {};
    const view = wrapped ??
      this.app.replayManager?.userMapView() ?? {
        center: this.app.map.getCenter(),
        zoom: this.app.map.getZoom(),
        bearing: this.app.map.getBearing(),
        // Not the tilt the replay of every flight gave the map for a while
        pitch: this.app.replayState.pitchBefore ?? this.app.map.getPitch(),
      };
    // Panning across the antimeridian takes the longitude past 180. The
    // wrapped one is the same place, and what a link is expected to carry;
    // wrapped by the rule a saved centre is read back with. The map's own
    // centre always passes it.
    const center: MapCenter = toMapCenter(view.center) ?? view.center;
    const state: SavedState = {
      schemaVersion: STATE_SCHEMA_VERSION,
      center,
      // Saved state and links keep the zoom unit they have always had, one
      // above the map's, so a link shared before the map library changed
      // still shows the same area. MapApp converts back on restore.
      zoom: mapZoomToState(view.zoom),
      bearing: view.bearing,
      pitch: view.pitch,
      selectedYear: this.app.selectedYear,
      selectedAircraft: this.app.selectedAircraft,
      selectedPathIds: Array.from(this.app.selectedPathIds),
      crossSectionLine: this.app.crossSectionLine,
      // Replay state is not persisted: too complex to restore reliably
    };
    for (const toggle of TOGGLES) {
      state[toggle.key] =
        "panel" in toggle
          ? this.panelVisible(toggle.key)
          : (kept[toggle.key] ?? this.app[toggle.key]);
    }
    try {
      if (!(this.visiting &&= this.app.isolateSelection)) {
        localStorage.setItem(storageKey(), JSON.stringify(state));
      }
    } catch (_e) {
      // Silently fail if localStorage is not available
    }

    // Update URL to reflect current state (for shareable links). Not on
    // the visitor's own flights, which no link carries: their registrations,
    // their flight ids and where they flew would stay in the history and
    // in a browser's sync, for nothing (Copy link refuses there). Their
    // address is the page's alone, whatever it started with.
    this.updateUrl(localMode ? {} : state);
    return state;
  }

  loadMapState(): SavedState | null {
    try {
      const saved = localStorage.getItem(storageKey());
      if (saved) {
        const parsed: unknown = JSON.parse(saved);
        const state = sanitizeSavedState(parsed);
        // A view that did not survive the check is no reason to lose the
        // year, the selection and the layers saved with it: without a centre
        // the map opens on the bounds of the data, as it does without any
        // saved state. Only an entry nothing is left of counts as corrupt.
        return Object.keys(state).length > 0 ? state : null;
      }
    } catch (_e) {
      // Silently fail if localStorage is not available or data is corrupt
    }
    return null;
  }

  /**
   * Update browser URL without reloading page
   * @param state - Current state object
   */
  updateUrl(state: SavedState): void {
    const urlParams = encodeStateToUrl(state);
    const newUrl = urlParams ? "?" + urlParams : window.location.pathname;

    // Use replaceState to avoid adding to browser history on every change
    try {
      history.replaceState(null, "", newUrl);
    } catch (_e) {
      // Silently fail if history API is not available
    }
  }

  /**
   * Load state with priority: URL params > localStorage > defaults
   * @returns State object to restore, or null
   */
  loadState(): SavedState | null {
    // Priority 1: URL parameters
    const urlState = parseUrlParams(
      new URLSearchParams(window.location.search),
    );
    if (urlState && Object.keys(urlState).length > 0) {
      const validated = sanitizeSavedState({
        ...urlState,
        // parseUrlParams only returns path ids that carried a current sv
        schemaVersion: STATE_SCHEMA_VERSION,
      });
      if (Object.keys(validated).length > 0) {
        return validated;
      }
    }

    // Priority 2: localStorage, but not after a shared link that could not
    // be read: the visitor's own view would pass for what was shared
    return followedUnreadLink() ? null : this.loadMapState();
  }
}
