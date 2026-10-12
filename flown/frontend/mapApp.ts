/**
 * Main Map Application
 * This is the main entry point that initializes all managers and handles the application lifecycle
 *
 * MapApp owns the map and its life: it creates the map and the handles of
 * its layers, starts the managers, runs the first load, dispatches clicks
 * on the map, fetches the lazy bundles as their controls are first used,
 * puts the view back on Reset view and takes everything down again in
 * `destroy()`. What it sets up once and then leaves to the store lives
 * next to it: the base style and its fallback (baseStyle.ts), the saved
 * state put back at start (ui/stateRestore.ts), the controls that follow
 * the store (ui/appChrome.ts) and what the app says when a lazy bundle
 * cannot be fetched (ui/lazyBundles.ts). The last three take the app as an
 * argument and use its public state only; what stays here is what needs
 * the app's private state.
 */

import {
  AttributionControl,
  Map as MapLibreMap,
  type LngLat,
  type LngLatBoundsLike,
  type MapMouseEvent,
  type MapTouchEvent,
  type PaddingOptions,
  type StyleSpecification,
} from "maplibre-gl";
import { DataManager } from "./ui/dataManager";
import type { StateManager } from "./ui/stateManager";
import { LayerManager } from "./ui/layerManager";
import { FilterManager } from "./ui/filterManager";
import {
  CONTROL_COLUMNS,
  mapChromePadding,
  PathSelection,
} from "./ui/pathSelection";
import { AirportManager } from "./ui/airportManager";
import { MapOrientation } from "./ui/mapOrientation";

import { UIToggles } from "./ui/uiToggles";
import {
  followLayerVisibility,
  followSatelliteSwitch,
} from "./ui/layerVisibility";
import { followSelectionHighlight } from "./ui/selectionHighlight";
import { followHeatLegend } from "./ui/heatLegend";
import { followStatsPanel } from "./ui/statsPanel";
import { MobileBar } from "./ui/mobileBar";
import {
  STILL_LOADING_MESSAGE,
  bindActions,
  failStart,
  startFailure,
} from "./ui/actions";
import { loadInitialData } from "./appInitializer";
import { logError } from "./utils/logger";
import { dismissToast, showToast } from "./utils/toast";
import { setUnavailableFor } from "./utils/buttonState";
import { domCache } from "./utils/domCache";
import { applyGradientTokens } from "./utils/colors";
import { renderControlIcons } from "./utils/icons";
import {
  cssVar,
  DOUBLE_TAP_MS,
  followContextLoss,
  isOnMarker,
  isReplayCameraMove,
  keepMarkerTapsFromZoom,
  stateZoomToMap,
  toBounds,
  toLngLat,
  whenStyleReady,
} from "./utils/mapHelpers";
import { prefersReducedMotion } from "./utils/motion";
import { isPhoneLayout, TouchClock } from "./utils/device";
import { resetSafeArea } from "./utils/safeArea";
import {
  DAY_MAX_FLIGHTS,
  DEFAULT_ZOOM,
  HEATMAP_LAYER_IDS,
  INPUT_EVENTS,
  KEYS_NOT_INPUT,
  MAP_LAYERS,
  MAP_MAX_PITCH,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
} from "./utils/constants";
import {
  addDataLayers,
  setBaseStyle,
  AirportLayerHandle,
  MapLayerHandle,
} from "./mapLayers";
import {
  AppStore,
  createDefaultState,
  DEFAULT_AIRSPEED_RANGE,
  DEFAULT_ALTITUDE_RANGE,
  defineStoreAccessors,
  isMapHeld,
  type Range,
} from "./state/store";
import { ReplayState } from "./ui/replayState";
import { siteData, type SiteData } from "./state/siteData";
import { ReliefState } from "./ui/reliefState";
import { watchScrollEnd, type ScrollEndWatcher } from "./utils/scrollFade";
import {
  loadFeatures,
  loadLocal,
  loadSearch,
  loadWrapped,
} from "./services/featureLoader";
import type { DataLoaderOptions } from "./services/dataLoader";
import type { LocalInfo } from "./services/localStore";
import { LOCAL_FLIGHTS_KEY, wantsReopen } from "./state/localFlags";
import { storedFlag } from "./utils/storedFlag";
import { watchFileDrops } from "./ui/fileDropWatch";
import {
  BASE_STYLE_RETRY_MS,
  BASE_STYLE_UNAVAILABLE_MESSAGE,
  cartoStyleUrl,
  cartoTransformRequest,
  FALLBACK_STYLE,
} from "./baseStyle";
import {
  CROSS_SECTION_UNAVAILABLE_MESSAGE,
  followSearchKey,
  loadLazyBundle,
  LOCAL_UNAVAILABLE_MESSAGE,
  prepareWrappedOnIntent,
  REPLAY_UNAVAILABLE_MESSAGE,
  SEARCH_UNAVAILABLE_MESSAGE,
  STATS_UNAVAILABLE_MESSAGE,
  TOUR_UNAVAILABLE_MESSAGE,
  WRAPPED_BUNDLE_MESSAGES,
  WRAPPED_UNAVAILABLE_MESSAGE,
  type FeatureToggle,
} from "./ui/lazyBundles";
import { applyPendingFilterChanges, restoreState } from "./ui/stateRestore";
import { setLocalStateMode } from "./ui/stateManager";
import {
  followAttributionHeight,
  followKeyboard,
  followReplayAvailability,
  setupButtonSync,
  setupStatsRail,
} from "./ui/appChrome";
import { segmentsForPathIds } from "./calculations/statistics";
import {
  REPLAY_HIDDEN_MESSAGE,
  REPLAY_PRECONDITION_MESSAGE,
  REPLAY_TOO_MANY_MESSAGE,
} from "./ui/replayButton";
import {
  datasetIndex,
  shownSelection,
  type PathIdsByAirport,
} from "./calculations/datasetIndex";
import type { StoreAccessors } from "./state/store";
import { TOGGLE_KEYS } from "./state/toggles";
import { resolveShareToken, SHARE_TOKEN_PARAM } from "./state/shareToken";
import { SHARE_INTRO_PARAM, takeShareIntro } from "./state/urlState";
import type { ReplayManager } from "./ui/replayManager";
import type { StatsManager } from "./ui/statsManager";
import type { WrappedManager } from "./ui/wrappedManager";
import type {
  AircraftModels,
  AirportMarker,
  LayerHandle,
  PathInfo,
  PathSegment,
  AppState,
} from "./types";

/**
 * Map configuration passed to constructor
 */
export interface MapConfig {
  center: [number, number];
  bounds: [[number, number], [number, number]];
  cartoApiKey?: string | undefined;
  dataDir: string;
  /** The day the site was built, "YYYY-MM-DD" in UTC */
  builtOn?: string | undefined;
  /** Short hash of the commit the site was built from, "" when unknown */
  commit?: string | undefined;
  /** The commit's page, "" when the repository it is in is unknown */
  commitUrl?: string | undefined;
  /**
   * Where the data files come from when not from the site: the flights a
   * visitor dropped, kept in the browser (ui/localFlights.ts)
   */
  dataSource?: Pick<DataLoaderOptions, "fetchJson" | "fetchBytes"> | undefined;
  /** What is known about those flights while the page shows them */
  localFlights?: LocalInfo | undefined;
}

/**
 * Room around the flights, beyond the panels over the map, when the view is
 * fitted to all of them (startViewPadding). The heat's glow reaches about
 * 18 pixels (HEATMAP_RADIUS_PX) past the outermost fix, and at 30 the edge
 * of the map cut it off at the farthest airport.
 */
const START_VIEW_PADDING = 48;

/**
 * The padding of a fit to the start view: clear of the control columns, as
 * a selection's fit is. A flat 48 pixels left the tracks at the left edge
 * under the left column on a narrow window. The columns alone: the legend
 * and the chip come and go with the data and the selection, and counted,
 * Reset view landed on another camera than the first visit had. On a
 * phone clear as well of the bar, by its height in the stylesheet: the
 * first view is fitted before the bar is on the page.
 */
export function startViewPadding(
  container: HTMLElement,
): Required<PaddingOptions> {
  const padding = mapChromePadding(
    { getContainer: () => container },
    START_VIEW_PADDING,
    CONTROL_COLUMNS,
  );
  // --mobile-bar-h stays a plain px value: a calc() would read as 0 here
  if (isPhoneLayout())
    padding.bottom += parseFloat(cssVar("--mobile-bar-h")) || 0;
  return padding;
}

/** Delay before a Wrapped panel restored from state opens again */
const WRAPPED_RESTORE_DELAY_MS = 500;

/**
 * The touches the touch clock is told of: the start, and the end, from
 * which a tap's click is measured (see TouchClock.note)
 */
const TOUCH_CLOCK_EVENTS = ["touchstart", "touchend", "touchcancel"] as const;

/**
 * How long the map may take to draw once the data is in. The map draws
 * through its worker; a worker that failed to start only says so in the
 * console, and the page would otherwise show an empty map and nothing else.
 */
export const MAP_STALL_MS = 20_000;

/** Said when the map has not finished drawing after MAP_STALL_MS */
export const MAP_STALL_MESSAGE =
  "The map is taking long to draw. If it stays empty, reload the page.";

/** A failure whose message is for the user, shown in place of the map */
export class UnsupportedBrowserError extends Error {}

// The store-backed properties of STORE_ACCESSOR_KEYS. The accessors are
// defined once on the prototype by `defineStoreAccessors` below; this only
// gives them their types.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, @typescript-eslint/no-empty-object-type
export interface MapApp extends StoreAccessors {}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class MapApp {
  // Observable state store
  readonly store: AppStore;

  // Plain values nothing has to follow: they are read where they are used,
  // so the store would only announce changes nobody listens to
  /** Model names from metadata.json; empty until it has loaded */
  aircraftModels: AircraftModels = {};
  /** Colour range of the altitude layer, replaced by every layer build */
  altitudeRange: Range = { ...DEFAULT_ALTITUDE_RANGE };
  /** Colour range of the speed layer, stretched over the dataset's speeds */
  airspeedRange: Range = { ...DEFAULT_AIRSPEED_RANGE };
  /** The speeds of every flight, from metadata.json: the range to fall back to */
  metadataAirspeedRange: Range = { ...DEFAULT_AIRSPEED_RANGE };

  // Every manager is handed the whole app, so whatever stays writable below
  // is writable from all of them. The fields that nothing reassigns after
  // the constructor say so, which leaves the compiler enforcing a mutable
  // surface of the map, the two fields the managers do write, and the
  // managers themselves.

  // Configuration
  readonly config: MapConfig;

  // Non-store state
  isInitializing: boolean;
  /** Set by destroy(), so work that was already in flight can stand down */
  private destroyed = false;
  /**
   * Aborted by destroy(). DOM listeners the app and its managers add for
   * as long as the app lives pass its signal, so one call removes them all.
   */
  private readonly lifetime = new AbortController();
  /** Set while a click on Replay waits for the feature bundle */
  private pendingReplayToggle: Promise<void> | null = null;
  /** The toggles of a lazy bundle a click waits for the bundle for */
  private readonly pendingToggles = new Set<
    FeatureToggle | "toggleSearch" | "toggleLocalFlights"
  >();
  /** Files dropped on the page before the bundle of Your flights arrived */
  private readonly pendingDrops: File[] = [];
  /**
   * Where the last fit to the start view takes the camera: the one of a
   * first visit, measured as the map opens, then that of every Reset view.
   * Undefined for a map that has no room to fit anything into.
   */
  private startCamera: ReturnType<MapLibreMap["cameraForBounds"]>;
  /** The map events setupEventHandlers() listens to, kept to remove them */
  private mapHandlers: {
    moveend?: (e: object) => void;
    zoomend?: (e: object) => void;
    click?: (e: MapMouseEvent) => void;
    touch?: (e: MapTouchEvent) => void;
  } = {};
  /** Tells the map's taps from its clicks (see handleMapClick) */
  readonly touchClock = new TouchClock();

  // Map and layers
  map: MapLibreMap | null;
  /**
   * Resolves with the map once its style has loaded and every source and
   * layer of MAP_SOURCES and MAP_LAYERS exists, empty. That style is
   * FALLBACK_STYLE, which needs no network, so the base style of CARTO
   * neither delays it nor can fail it. It rejects when the layers
   * themselves cannot be added, which fails `initialize()` and is reported
   * like any other failure of the start-up, and when the app is destroyed
   * first, so nothing waits on it for good.
   * `initialize()` waits for it before the first data is loaded, so code
   * that runs from there on may use the sources directly; anything that can
   * run earlier (a constructor, a click during the load) goes through this.
   */
  readonly mapReady: Promise<MapLibreMap>;
  /** What `destroy()` rejects `mapReady` with, to be told from a failure */
  private readonly destroyedReason = new Error(
    "the app was destroyed before the map was ready",
  );
  private resolveMapReady!: (map: MapLibreMap) => void;
  private rejectMapReady!: (reason: unknown) => void;
  /** Where the request for the base style stands; "idle" before and between */
  private baseStyle: "idle" | "loading" | "loaded" = "idle";
  /** Whether the one timed retry of the base style has been spent */
  private baseStyleRetried = false;
  /** Whether its failure has been said, which happens once a page */
  private baseStyleToast = false;
  /** Takes back `keepMarkerTapsFromZoom`, set with the map */
  private releaseMarkerTaps: (() => void) | null = null;
  /**
   * When an airport's marker or its code was last clicked. The popup the click
   * opens pans the map until it shows in full, which can carry the airport
   * out from under the second tap of a double tap, and the map gets that
   * one: it must not close the popup. By the time of the event, as in
   * createActivationFilter, since a busy page hands the second tap over late.
   */
  private airportClickAt = -Infinity;

  // Handles of the layers the map is created with. The layers are never
  // added or removed; the handles switch their visibility.
  readonly heatmapLayer: LayerHandle;
  readonly aviationLayer: LayerHandle;
  readonly altitudeLayer: LayerHandle;
  readonly airspeedLayer: LayerHandle;
  readonly airportLayer: LayerHandle;
  readonly selectionHighlightLayer: LayerHandle;
  /** The same six, for attaching them to the map in one go */
  private readonly layerHandles: MapLayerHandle[];

  // Airport markers (non-store)
  readonly airportMarkers: Record<string, AirportMarker>;

  /**
   * Replay state. It lives here rather than in the replay manager because
   * the app reads it on every map click and layer redraw, which must not
   * depend on whether the feature bundle has been fetched.
   */
  readonly replayState: ReplayState;

  /** What the layer manager and the relief's code share (ui/reliefState.ts) */
  readonly relief: ReliefState;

  // Saved state
  savedState: AppState | null;
  restoredYearFromState: boolean;
  /** The year a first visit opens on: the newest one, see resolveYearSelection */
  defaultYear = "all";

  // Managers, created by initialize() and there from then on
  stateManager!: StateManager;
  dataManager!: DataManager;
  layerManager!: LayerManager;
  filterManager!: FilterManager;
  pathSelection!: PathSelection;
  airportManager!: AirportManager;
  mapOrientation!: MapOrientation;
  /**
   * Replay, Wrapped and the statistics panel live in lazily loaded
   * bundles, so these are undefined until the user first opens one. Reach
   * them through `loadReplay()` / `loadWrapped()` / `loadStats()`; read
   * them directly only where the feature must already be open for the code
   * to run at all.
   */
  statsManager?: StatsManager | undefined;
  replayManager?: ReplayManager | undefined;
  wrappedManager?: WrappedManager | undefined;
  uiToggles!: UIToggles;
  mobileBar!: MobileBar | null;

  /** Pending reopening of a Wrapped panel that was open when state was saved */
  private wrappedRestoreTimer: ReturnType<typeof setTimeout> | null = null;

  /** Scroll-end watchers of the two control columns */
  private columnScrollWatchers: ScrollEndWatcher[] = [];

  /** Aborts once the app is destroyed; for listeners that live as long */
  get signal(): AbortSignal {
    return this.lifetime.signal;
  }

  /**
   * airports.json and metadata.json, once loaded (state/siteData.ts). The
   * app reads them there; this is for the e2e tests, off window.mapApp.
   */
  get siteData(): Readonly<SiteData> {
    return siteData;
  }

  /**
   * Whether a replay (of one flight or of all), the hotspot tour or Wrapped
   * holds the map: the search and the cross-section do not open then, as
   * they would move the map or draw on it under them
   */
  get mapHeld(): boolean {
    return isMapHeld(this.store);
  }

  /** Path info of the loaded dataset (single source of truth: currentData) */
  get fullPathInfo(): PathInfo[] | null {
    return this.currentData?.path_info ?? null;
  }

  /** Segments of the loaded dataset (single source of truth: currentData) */
  get fullPathSegments(): PathSegment[] | null {
    return this.currentData?.path_segments ?? null;
  }

  /**
   * Paths per airport among the flights the year/aircraft filter keeps. A
   * click on an airport selects these, so it never picks a flight the map
   * does not show.
   */
  get airportToPaths(): PathIdsByAirport {
    const data = this.currentData;
    // No prototype, like the index's own: an airport name is data
    if (!data) return Object.create(null) as PathIdsByAirport;
    return datasetIndex(data)
      .filter(this.selectedYear, this.selectedAircraft)
      .pathIdsByAirport();
  }

  constructor(config: MapConfig) {
    this.store = new AppStore();
    this.config = config;
    // A probe a torn-down app left measures again for this one
    resetSafeArea();

    // Non-store state
    this.isInitializing = true;

    // Map and layers
    this.map = null;
    this.mapReady = new Promise((resolve, reject) => {
      this.resolveMapReady = resolve;
      this.rejectMapReady = reject;
    });
    // Whoever waits for the map handles its failure. Destroyed before anyone
    // does, the rejection would otherwise count as unhandled.
    this.mapReady.catch(() => {});
    const heatmap = new MapLayerHandle(HEATMAP_LAYER_IDS);
    const aviation = new MapLayerHandle([MAP_LAYERS.aviation]);
    // The lines first: the e2e driver reads a mode's layer off the front
    const altitude = new MapLayerHandle([
      MAP_LAYERS.pathsAltitude,
      MAP_LAYERS.pathsAltitudeSelected,
      MAP_LAYERS.pathsAltitudeRibbons,
      MAP_LAYERS.pathsAltitudeSelectedRibbons,
    ]);
    const airspeed = new MapLayerHandle([
      MAP_LAYERS.pathsAirspeed,
      MAP_LAYERS.pathsAirspeedSelected,
      MAP_LAYERS.pathsAirspeedRibbons,
      MAP_LAYERS.pathsAirspeedSelectedRibbons,
    ]);
    const airports = new AirportLayerHandle();
    const highlight = new MapLayerHandle([
      MAP_LAYERS.selectionHighlight,
      MAP_LAYERS.selectionHighlightRibbons,
    ]);
    this.heatmapLayer = heatmap;
    this.aviationLayer = aviation;
    this.altitudeLayer = altitude;
    this.airspeedLayer = airspeed;
    this.airportLayer = airports;
    this.selectionHighlightLayer = highlight;
    this.layerHandles = [
      heatmap,
      aviation,
      altitude,
      airspeed,
      airports,
      highlight,
    ];

    // Airport markers (non-store)
    this.airportMarkers = {};

    this.replayState = new ReplayState();
    this.relief = new ReliefState(this.store);

    // Saved state
    this.savedState = null;
    this.restoredYearFromState = false;
  }

  async initialize(): Promise<void> {
    // A shared link becomes the ordinary one before anything reads it
    resolveShareToken();
    // Before the first save of the state writes the link anew without it
    const intro = takeShareIntro();
    // Input from the page open on, while the data and the feature bundle
    // are on their way, makes the view the visitor's, and the intro does
    // not play over it. The first input ends the listening, as do the
    // intro starting, it being decided against and the app going
    const input = new AbortController();
    if (intro) {
      for (const type of INPUT_EVENTS) {
        window.addEventListener(
          type,
          (event) =>
            KEYS_NOT_INPUT.has((event as KeyboardEvent).key) || input.abort(),
          { capture: true, passive: true, signal: input.signal },
        );
      }
      this.signal.addEventListener("abort", () => input.abort(), {
        signal: input.signal,
      });
    }
    restoreState(this);
    if (intro) {
      // The sender's flights, not the visitor's: their next visit without a
      // link opens on their own (StateManager.visiting). Nor does the link
      // open the statistics the sender had open, which on a phone are a
      // sheet over the map the intro plays on.
      this.stateManager.visiting = true;
      delete this.savedState?.statsPanelVisible;
    }
    this.setupMap();
    this.initializeManagers();
    setupButtonSync(this);
    setupStatsRail(this);

    // The data goes into sources that only exist once the style has loaded.
    // The files are preloaded by the template, so waiting here does not hold
    // their download back.
    try {
      await this.mapReady;
    } catch (error) {
      // Destroyed while waiting: `destroy()` settled the wait, and nothing
      // failed. Asked of the state, so a layer failure that races a destroy
      // does not tear down a second time; but such a failure is one all
      // the same, and with nobody left to show it to it is at least logged.
      if (this.destroyed) {
        if (error !== this.destroyedReason) logError(error);
        return;
      }
      // The controls are bound by now and the managers listen to the store.
      // None of them may go on acting on a map that has no layers, and the
      // failure notice takes the map's place, so the map goes as well.
      this.destroy();
      this.map?.remove();
      this.map = null;
      throw error;
    }
    if (this.destroyed) return;

    // Load airports and metadata
    await loadInitialData(this);
    if (this.map) this.watchMapStall(this.map);

    // Setup map event handlers
    this.setupEventHandlers();

    // Mark initialization as complete. Reset view waited for it.
    this.isInitializing = false;
    this.syncResetButton();

    // The line of a cross-section the link or the last visit had, which
    // the tool opens on (ui/crossSection.ts). Neither it nor Wrapped opens
    // over a load that failed, where they would show nothing but zeros, and
    // the line goes with it as Wrapped's flag does below: the saves and
    // Copy link would hand on a cross-section nobody sees.
    const loaded = this.currentData !== null;
    if (this.crossSectionLine) {
      if (loaded) this.toggleCrossSection();
      else this.crossSectionLine = "";
    }

    // A link to shared flights draws them in (ui/shareIntro.ts), with the
    // feature bundle their profile fetches as well; not over a load that
    // failed, which has no flights to draw, and the bundle is not fetched,
    // nor once the visitor has moved the view (see above)
    if (intro && loaded)
      void loadFeatures().then((f) => {
        if (input.signal.aborted) return;
        input.abort();
        f?.playShareIntro(this);
      });
    else input.abort();

    // Restore wrapped panel state if it was open
    const state = this.savedState;
    if (state?.wrappedVisible && !loaded) delete state.wrappedVisible;
    if (state?.wrappedVisible) {
      this.wrappedRestoreTimer = setTimeout(() => {
        this.wrappedRestoreTimer = null;
        void this.loadWrapped()
          .then((manager) => {
            // The bundle may arrive after the app was torn down
            if (!this.destroyed) manager?.showWrapped();
          })
          .catch(logError)
          // Opened or not, even failed, the restore is done: saves stop
          // writing the flag it had (see StateManager.panelVisible)
          .finally(() => delete state.wrappedVisible);
      }, WRAPPED_RESTORE_DELAY_MS);
    }

    // Apply filter changes made through the selects while loading
    await applyPendingFilterChanges(this);
  }

  /** Say so when the map has not drawn MAP_STALL_MS after the data came */
  private watchMapStall(map: MapLibreMap): void {
    const timer = setTimeout(() => {
      // A hidden tab draws nothing, and is no sign of a failure. Nor is a
      // map that has all it needs without having drawn since: no data came
      if (!this.destroyed && !document.hidden && !map.loaded()) {
        showToast(MAP_STALL_MESSAGE, "error");
      }
    }, MAP_STALL_MS);
    map.once("idle", () => {
      clearTimeout(timer);
      // An error stays until dismissed; this one is over once the map drew
      dismissToast(MAP_STALL_MESSAGE);
    });
  }

  /**
   * Cancel pending work and take down everything the app set up: the DOM
   * listeners (through the lifetime signal), the map events, every store
   * subscription and the chrome built at runtime. The map itself and the
   * layers on it stay as they are.
   */
  destroy(): void {
    this.destroyed = true;
    // `initialize()` may still be waiting for it. Nothing happens when the
    // map was ready already.
    this.rejectMapReady(this.destroyedReason);
    if (this.wrappedRestoreTimer !== null) {
      clearTimeout(this.wrappedRestoreTimer);
      this.wrappedRestoreTimer = null;
    }
    this.lifetime.abort();
    resetSafeArea(true);
    if (this.map) {
      const { moveend, zoomend, click, touch } = this.mapHandlers;
      if (moveend) this.map.off("moveend", moveend);
      if (zoomend) this.map.off("zoomend", zoomend);
      if (click) this.map.off("click", click);
      if (touch) {
        for (const type of TOUCH_CLOCK_EVENTS) this.map.off(type, touch);
      }
      this.map.off("moveend", this.syncResetButton);
      this.map.off("error", this.handleMapError);
    }
    this.releaseMarkerTaps?.();
    this.releaseMarkerTaps = null;
    this.mapHandlers = {};
    this.layerManager?.destroy();
    this.airportManager?.destroy();
    this.mapOrientation?.destroy();
    this.dataManager?.destroy();
    this.stateManager?.cancelSave();
    this.replayManager?.destroy();
    this.wrappedManager?.destroy();
    this.statsManager?.destroy();
    this.mobileBar?.destroy();
    for (const watcher of this.columnScrollWatchers) watcher.stop();
    this.columnScrollWatchers = [];
    this.store.unsubscribeAll();
  }

  private setupMap(): void {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    if (!gl) {
      throw new UnsupportedBrowserError(
        "WebGL 2 is not available. Turn on hardware acceleration or try another browser.",
      );
    }
    // Free the test context immediately
    gl.getExtension("WEBGL_lose_context")?.loseContext();

    // MapLibre runs every camera move through easeTo or flyTo and shortens
    // those to nothing under reduced motion, the app's own included; the
    // glide after a drag goes with them. It asks the media query itself on
    // every move as long as it is not given `reduceMotion`, so a change of
    // the setting takes effect without a reload. The tile and label fades
    // are the one animation it would still run, and are set here once.
    const animate = !prefersReducedMotion();

    // A saved zoom of 0 is a view like any other, not a missing one. A
    // link may carry a centre alone (written by hand, or cut short); it is
    // still where the reader was sent, so it gets the default zoom.
    const center = this.savedState?.center;
    const bearing = this.savedState?.bearing ?? 0;
    const savedZoom = this.savedState?.zoom;
    const view = center
      ? {
          center: toLngLat([center.lat, center.lng]),
          // Saved state counts zoom the way Leaflet did, one level above
          // the map's. A level below the map's range is a view from before
          // the switch that the map can no longer show.
          zoom:
            savedZoom === undefined
              ? DEFAULT_ZOOM
              : Math.max(MAP_MIN_ZOOM, stateZoomToMap(savedZoom)),
        }
      : {
          bounds: toBounds(this.config.bounds),
          // A fit turns the map north up unless it is told the bearing
          fitBoundsOptions: {
            padding: startViewPadding(domCache.get("map")!),
            bearing,
          },
        };

    // A style given as an object is taken in on the next animation frame,
    // so a tab opened in the background starts up once it is first shown
    const map = new MapLibreMap({
      container: "map",
      style: FALLBACK_STYLE,
      transformRequest: cartoTransformRequest(this.config.cartoApiKey),
      ...view,
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      // Pinch, scroll and double tap already zoom; a navigation control
      // only costs a corner of the map. The attribution is added below,
      // expanded: the default one collapses on a narrow map.
      attributionControl: false,
      // The map turns and tilts by MapLibre's own gestures (right or ctrl
      // drag, two fingers, shift with the arrow keys); the compass of
      // MapOrientation brings it back. A view opens north up and flat
      // unless the link or the saved state says otherwise.
      bearing,
      pitch: this.savedState?.pitch ?? 0,
      maxPitch: MAP_MAX_PITCH,
      fadeDuration: animate ? 300 : 0,
    });
    map.addControl(new AttributionControl({ compact: false }), "bottom-right");
    followAttributionHeight(map, this.signal);
    this.map = map;
    // A first visit has just been fitted to it, and a saved view or a link
    // may show the very same (see isReset)
    this.measureStartView(map);
    this.releaseMarkerTaps = keepMarkerTapsFromZoom(map);

    // Registered before anything can fail. Without a listener MapLibre
    // writes every error to the console itself.
    map.on("error", this.handleMapError);
    // Before any other listener of the map, which may ask whether it has
    // its WebGL context (hasLostContext)
    followContextLoss(map);

    // For as long as the app lives, like its other DOM listeners
    const mapCanvas = map.getCanvas();
    const lifetime = { signal: this.signal };
    const interrupted = "Map rendering interrupted, restoring…";
    mapCanvas.addEventListener(
      "webglcontextlost",
      (e) => {
        e.preventDefault();
        logError("WebGL context lost");
        showToast(interrupted, "error");
      },
      lifetime,
    );
    mapCanvas.addEventListener(
      "webglcontextrestored",
      () => {
        // An error stays until dismissed, and this one has put itself right
        dismissToast(interrupted);
        showToast("Map rendering restored", "info");
      },
      lifetime,
    );
    // The skip link's own jump landed on the map's container, where the
    // arrow keys and + do nothing, and put #map into the history, where
    // Back then stopped without changing anything. It hands the focus to
    // the canvas, which takes them.
    document.querySelector(".skip-nav")?.addEventListener(
      "click",
      (event) => {
        event.preventDefault();
        mapCanvas.focus();
      },
      lifetime,
    );

    whenStyleReady(map)
      .then(() => {
        // Destroyed within the frame the style takes: `mapReady` is settled
        // and there is nobody to add the layers for
        if (this.destroyed) return;
        addDataLayers(map);
        for (const handle of this.layerHandles) handle.attach(map);
        this.resolveMapReady(map);
        // Only now: the swap carries over the layers that were just added
        void this.loadBaseStyle();
        window.addEventListener("online", this.retryBaseStyle, {
          signal: this.signal,
        });
      })
      // A layer the style refuses throws in here. `initialize` waits for
      // `mapReady`, so without this it would wait forever and the page would
      // show an empty map with no word of why.
      .catch((error: unknown) => this.rejectMapReady(error));
  }

  /**
   * Ask for the base style again, as the browser comes back online or the
   * Retry of its failure is pressed: a new network is worth a full round,
   * timed retry and toast included, so a Retry that fails again says so
   * rather than leaving the map dark without a word
   */
  private readonly retryBaseStyle = (): void => {
    this.baseStyleRetried = false;
    this.baseStyleToast = false;
    void this.loadBaseStyle();
  };

  /**
   * Fetch CARTO's style and put it under the flights, however late it
   * answers: nothing waits for it, so there is no time limit to give up at.
   * The app fetches it rather than the map, so that `destroy()` can abort
   * the request and a failure is known to be this one. It is asked for a
   * second time after BASE_STYLE_RETRY_MS and whenever the browser comes
   * back online; until then the map stays on FALLBACK_STYLE.
   *
   * `setStyle` compares the new style with the one on the map and applies
   * the difference. `withDataLayers` puts the app's sources and layers into
   * the new style as they are, their data left out, so for them there is
   * none: the sources keep their data and their tiles, the layers their
   * filters, visibility and paint, and a `setData` that is on its way lands
   * as if nothing happened (see setBaseStyle).
   */
  private async loadBaseStyle(): Promise<void> {
    const map = this.map;
    if (this.baseStyle !== "idle" || this.destroyed || !map) return;
    this.baseStyle = "loading";
    try {
      const response = await fetch(cartoStyleUrl(this.config.cartoApiKey), {
        signal: this.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const style = (await response.json()) as StyleSpecification;
      // `destroy()` leaves the map as it is, also for an answer that was
      // already being read when the request was aborted
      if (this.destroyed) return;
      this.baseStyle = "loaded";
      setBaseStyle(map, style);
      dismissToast(BASE_STYLE_UNAVAILABLE_MESSAGE);
    } catch (error) {
      if (this.destroyed) return;
      this.baseStyle = "idle";
      const message = error instanceof Error ? error.message : String(error);
      logError(`Base map style failed to load: ${message}`);
      if (!this.baseStyleToast) {
        this.baseStyleToast = true;
        showToast(BASE_STYLE_UNAVAILABLE_MESSAGE, "info", {
          label: "Retry",
          run: this.retryBaseStyle,
        });
      }
      if (this.baseStyleRetried) return;
      this.baseStyleRetried = true;
      setTimeout(() => void this.loadBaseStyle(), BASE_STYLE_RETRY_MS);
    }
  }

  /**
   * Report what the map could not load. A tile or a glyph that fails leaves
   * a hole and nothing more, and the base style is not the map's to load.
   */
  private readonly handleMapError = (e: { error?: unknown }): void => {
    const error = e.error;
    const message = error instanceof Error ? error.message : String(error);
    logError(`Map error: ${message}`);
  };

  private initializeManagers(): void {
    this.dataManager = new DataManager(this);
    this.layerManager = new LayerManager(this);
    this.filterManager = new FilterManager(this);
    this.pathSelection = new PathSelection(this);
    this.airportManager = new AirportManager(this);
    this.mapOrientation = new MapOrientation(this);
    this.uiToggles = new UIToggles(this);
    this.mobileBar = MobileBar.mountFor(this);
    followLayerVisibility(this);
    followHeatLegend(this);
    followSatelliteSwitch(this);
    followSelectionHighlight(this);
    followStatsPanel(this);
    prepareWrappedOnIntent(this);
    followSearchKey(this);
    followKeyboard(this.signal);
    followReplayAvailability(this);
    this.followFlightProfile();
    this.store.subscribeKeys(
      [
        ...TOGGLE_KEYS,
        "selectedYear",
        "selectedAircraft",
        "selectedPathIds",
        "currentData",
        "replayActive",
      ],
      this.syncResetButton,
    );
    this.map?.on("moveend", this.syncResetButton);
    this.syncResetButton();
    this.followColumnScrollEnd();
  }

  /**
   * Go back to what a first visit shows: the newest year, every aircraft,
   * the heatmap and the airports, nothing selected or shared, flat and
   * north up over all the flights. It goes through the year filter, so the
   * dropdowns, the loaded data and the store change together in one batch;
   * the saved state and the link follow the store and the camera as ever.
   * Out of reach during a replay, like the filters: the button is disabled
   * (REPLAY_DISABLED_CONTROL_IDS) and the phone's bar steps aside.
   */
  async resetView(): Promise<void> {
    // Like Share mode with nothing selected: unavailable, and a press says why
    // (see syncResetButton)
    if (!this.canResetView()) {
      showToast(this.resetViewReason() ?? RESET_VIEW_DONE_MESSAGE);
      return;
    }
    const defaults = createDefaultState();
    const applied = await this.filterManager.filterByYear(
      this.defaultYear,
      () => {
        // A filter change keeps the flights it still shows; this one is
        // the start view, with nothing selected
        for (const key of [...TOGGLE_KEYS, "selectedAircraft"] as const) {
          this.store.set(key, defaults[key]);
        }
        // The one way to clear it; never held here, as a replay and the
        // hotspot tour hold Reset view as well (ui/heldControls.ts)
        this.pathSelection.clearSelection();
      },
    );
    // A reset happens whole or not at all. Replaced by a newer filter
    // change, the view is that change's now, camera included. Failed to
    // load, the loader has said so and the store is untouched; resetting
    // the rest over the old year would leave neither the view the visitor
    // had nor the one asked for, while leaving it all as it was keeps the
    // button available to try again.
    if (!applied) return;
    // Measured first, as the fit itself does, and compared once it is over:
    // the moves of its animation end in the camera it aims at.
    const map = this.map;
    map?.fitBounds(this.measureStartView(map), {
      padding: startViewPadding(map.getContainer()),
      pitch: 0,
    });
  }

  /** The bounds of the start view, and where a fit to them will end */
  private measureStartView(map: MapLibreMap): LngLatBoundsLike {
    const bounds = toBounds(this.config.bounds);
    this.startCamera = map.cameraForBounds(bounds, {
      padding: startViewPadding(map.getContainer()),
    });
    return bounds;
  }

  /**
   * Whether Reset view can be pressed: once the first load is over, and
   * while it would change something
   */
  canResetView(): boolean {
    return this.resetViewReason() === null;
  }

  /** Why Reset view cannot be pressed now; null when it can */
  resetViewReason(): string | null {
    const failure = startFailure();
    if (failure) return failure;
    if (this.isInitializing) return STILL_LOADING_MESSAGE;
    return this.isReset() ? RESET_VIEW_DONE_MESSAGE : null;
  }

  /**
   * Whether Reset view would change nothing: every key it sets has the
   * value it sets, and the camera is where the last fit to the start view
   * took it, north up and flat. The camera is compared within what a link
   * rounds it to (state/urlState.ts), so a link to the start view, or a
   * reload of it, still opens on it; a pan, a zoom, a turn or a tilt
   * leaves it, and a resize or Wrapped's round trip does not. A page whose
   * year failed to load is not what a first visit shows, so Reset view is
   * the way to try again there.
   */
  isReset(): boolean {
    const map = this.map;
    const start = this.startCamera;
    if (!map || !start || !this.currentData) return false;
    const defaults = createDefaultState();
    const center = map.getCenter();
    const target = start.center as LngLat;
    return (
      this.selectedYear === this.defaultYear &&
      this.selectedAircraft === "all" &&
      this.selectedPathIds.size === 0 &&
      TOGGLE_KEYS.every((key) => this[key] === defaults[key]) &&
      Math.abs(center.lng - target.lng) + Math.abs(center.lat - target.lat) <
        2e-6 &&
      Math.abs(map.getZoom() - start.zoom!) < 0.01 &&
      Math.abs(map.getBearing()) + Math.abs(map.getPitch()) < 0.2
    );
  }

  /**
   * Whether the current selection can be replayed: a flight with a segment
   * timed after its start among the selected flights the filter shows
   * (shownSelection). Replay runs from 0 to the latest segment time, so a
   * flight whose times are all 0 (a single timed segment, or points logged
   * at the same second) finished the moment it started and drew nothing.
   * More than one, up to DAY_MAX_FLIGHTS, play one after another, those
   * without times left out (ui/replayManager.ts). Share mode keeps the flights
   * a filter hides, which the map does not draw: they are neither played
   * nor counted.
   */
  canReplay(): boolean {
    return (
      shownSelection(this).size <= DAY_MAX_FLIGHTS && this.timedSelection()
    );
  }

  /** Whether a flight of the selection has times to replay (canReplay) */
  private timedSelection(): boolean {
    const segments = this.fullPathSegments;
    const shown = shownSelection(this);
    return (
      shown.size > 0 &&
      this.hasTimingData &&
      !!segments &&
      segmentsForPathIds(segments, shown).some(
        (segment) => (segment.time ?? 0) > 0,
      )
    );
  }

  /**
   * Why the selection cannot be replayed (see canReplay), null if it can:
   * no times at all before too many flights, which fewer would not mend.
   * Shared flights the filter hides all, which share mode keeps, are said
   * to be hidden, as the chip says, rather than to need picking.
   */
  replayHint(): string | null {
    if (this.timedSelection()) {
      return this.canReplay() ? null : REPLAY_TOO_MANY_MESSAGE;
    }
    return this.selectedPathIds.size > 0 && shownSelection(this).size === 0
      ? REPLAY_HIDDEN_MESSAGE
      : REPLAY_PRECONDITION_MESSAGE;
  }

  /**
   * Open or close replay, fetching the feature bundle on first use. Clicks
   * that land while the bundle is still on its way are dropped: each one
   * queued a toggle of its own, and two quick ones opened replay and closed
   * it again the moment the bundle arrived. What opened meanwhile, Replay
   * all or Wrapped waiting on the same bundle, is not closed by the late
   * click, nor covered by a replay. One flight or several, the replay
   * manager plays them; the replay of every flight holds the control.
   */
  toggleReplay(): void {
    if (this.replayActive && this.replayState.all) return;
    if (this.replayManager) {
      this.replayManager.toggleReplay();
      return;
    }
    this.pendingReplayToggle ??= this.loadReplay()
      .then((manager) => {
        this.pendingReplayToggle = null;
        if (this.destroyed || this.replayActive || this.wrappedVisible) return;
        // Decided again: the replay of every flight may have opened, and
        // the selection changed, meanwhile
        if (manager) this.toggleReplay();
      })
      .catch((error) => {
        this.pendingReplayToggle = null;
        logError(error);
      });
  }

  /**
   * Open or close the replay of all flights (ui/replayAll.ts), which comes
   * with the feature bundle. As for Replay, a click while the bundle is on
   * its way is dropped, and one that loads nothing says so.
   */
  toggleReplayAll(): void {
    this.toggleFeature("toggleReplayAll", REPLAY_UNAVAILABLE_MESSAGE);
  }

  /** Start or stop the hotspot tour (ui/hotspotTour.ts), as Replay all */
  toggleHotspotTour(): void {
    this.toggleFeature("toggleHotspotTour", TOUR_UNAVAILABLE_MESSAGE);
  }

  private toggleFeature(name: FeatureToggle, unavailable: string): void {
    this.toggleLazily(
      name,
      () => loadLazyBundle(loadFeatures, unavailable),
      (features) => features[name](this),
    );
  }

  /**
   * Fetch a lazy bundle for the control `name` and run `toggle` with it,
   * dropping a click on the same control while the bundle is on its way
   */
  private toggleLazily<T>(
    name: FeatureToggle | "toggleSearch" | "toggleLocalFlights",
    load: () => Promise<T | null>,
    toggle: (module: T) => void,
  ): void {
    const pending = this.pendingToggles;
    if (pending.has(name)) return;
    pending.add(name);
    load()
      .then((module) => {
        pending.delete(name);
        if (module && !this.destroyed) toggle(module);
      })
      .catch((error: unknown) => {
        pending.delete(name);
        logError(error);
      });
  }

  /**
   * Open or close the cross-section (ui/crossSection.ts), which comes with
   * the feature bundle, dropping clicks while it is on its way as above
   */
  toggleCrossSection(): void {
    this.toggleFeature("toggleCrossSection", CROSS_SECTION_UNAVAILABLE_MESSAGE);
  }

  /**
   * Open or close the search of airports and places (ui/locationSearch.ts),
   * which comes with a bundle of its own. As for Replay all, a press while
   * the bundle is on its way is dropped, and one that loads nothing says
   * so. Not while a replay, the hotspot tour or Wrapped holds the map, which
   * a search would move under them: their holds say so on the button, and
   * `/` does nothing meanwhile. With `open`, as for `/`, a search that is
   * open already takes the focus back to its field rather than closing.
   */
  toggleSearch(open = false): void {
    if (this.mapHeld) return;
    this.toggleLazily(
      "toggleSearch",
      () => loadLazyBundle(loadSearch, SEARCH_UNAVAILABLE_MESSAGE),
      (search) => search.toggleSearch(this, open),
    );
  }

  /**
   * Open or close Your flights, the panel that takes the KML files a
   * visitor drops on the page and shows them in place of the site's, from
   * its own bundle (ui/localFlights.ts). With `dropped`, the files dragged
   * onto the page, the panel opens and takes them.
   */
  toggleLocalFlights(dropped?: FileList | File[]): void {
    if (this.mapHeld && !dropped) return;
    // Files dropped while the bundle is on its way wait for it: a second
    // call while the first is pending is not made again (toggleLazily)
    if (dropped) this.pendingDrops.push(...Array.from(dropped));
    this.toggleLazily(
      "toggleLocalFlights",
      async () => {
        const local = await loadLazyBundle(
          loadLocal,
          LOCAL_UNAVAILABLE_MESSAGE,
        );
        // Not kept for a later press: the visitor was told, and drops again
        if (!local) this.pendingDrops.length = 0;
        return local;
      },
      (local) => {
        const files = this.pendingDrops.splice(0);
        local.toggleLocalFlights(this, files.length ? files : undefined);
      },
    );
  }

  /**
   * Fetch the feature bundle as up to DAY_MAX_FLIGHTS flights are first
   * selected, of those the filter shows (shownSelection): it draws their
   * profile from then on (ui/flightProfile.ts). A failed fetch is tried
   * again with the next selection, or as a replay of it opens, which
   * fetched the bundle itself.
   */
  private followFlightProfile(): void {
    let pending = false;
    const check = (): void => {
      const size = shownSelection(this).size;
      if (pending || !size || size > DAY_MAX_FLIGHTS) return;
      pending = true;
      void loadFeatures().then((features) => {
        pending = false;
        if (!features || !stop) return;
        stop();
        stop = null;
        if (!this.destroyed) features.followFlightProfile(this);
      });
    };
    let stop: (() => void) | null = this.store.subscribeKeys(
      [
        "selectedPathIds",
        "replayActive",
        "currentData",
        "selectedYear",
        "selectedAircraft",
      ],
      check,
    );
    check();
  }

  /**
   * Show Reset view unavailable while the page is what it would make of it,
   * or still loading, the way Share mode and Replay are: aria-disabled, which
   * the stylesheet dims, but still in the tab order. It runs for the keys
   * Reset view sets, the data (a first visit's year is only known with it),
   * the end of the first load and the end of every camera move, the fit's
   * own included (see initializeManagers). A replay holds the button (see
   * holdControls), and closing it runs this again. The phone's open sheet
   * reads its Reset view row again at the same moments.
   */
  private readonly syncResetButton = (): void => {
    if (this.replayActive) return;
    const button = domCache.get("reset-view-btn");
    if (button) {
      // Dimmed, its tooltip says why, as Share mode's does
      setUnavailableFor(button, this.resetViewReason());
    }
    this.mobileBar?.refreshSheet();
  };

  /**
   * Fade the bottom of a control column that has more below the fold.
   *
   * The columns are fixed, so in a window shorter than they are they scroll
   * themselves rather than with the page. The same treatment the statistics
   * panel gets: without it the column simply stops at the bottom of the
   * screen, as often as not through the middle of a row, and nothing says
   * the last control is still down there.
   */
  private followColumnScrollEnd(): void {
    for (const id of ["left-buttons", "right-buttons"]) {
      const column = domCache.get(id);
      if (column) this.columnScrollWatchers.push(watchScrollEnd(column));
    }
  }

  /**
   * The replay manager, fetching the feature bundle on first use. Resolves
   * with undefined when the bundle cannot be loaded.
   */
  async loadReplay(): Promise<ReplayManager | undefined> {
    if (!this.replayManager) {
      const features = await loadLazyBundle(
        loadFeatures,
        REPLAY_UNAVAILABLE_MESSAGE,
      );
      // Torn down while it loaded: nothing is left to replay on
      if (this.destroyed) return undefined;
      // Another caller may have finished the same load in the meantime
      this.replayManager ??= features
        ? new features.ReplayManager(this)
        : undefined;
    }
    return this.replayManager;
  }

  /**
   * The Wrapped manager, fetching the Wrapped bundle (not the feature
   * bundle) on first use
   */
  async loadWrapped(): Promise<WrappedManager | undefined> {
    if (!this.wrappedManager) {
      const wrapped = await loadLazyBundle(
        loadWrapped,
        WRAPPED_UNAVAILABLE_MESSAGE,
        WRAPPED_BUNDLE_MESSAGES,
      );
      // Torn down while it loaded: nothing is left to show it over
      if (this.destroyed) return undefined;
      this.wrappedManager ??= wrapped
        ? new wrapped.WrappedManager(this)
        : undefined;
    }
    return this.wrappedManager;
  }

  /**
   * The statistics panel's manager, fetching the Wrapped bundle, which
   * carries it, on first use (see ui/statsPanel.ts)
   */
  async loadStats(): Promise<StatsManager | undefined> {
    if (!this.statsManager) {
      const wrapped = await loadLazyBundle(
        loadWrapped,
        STATS_UNAVAILABLE_MESSAGE,
        WRAPPED_BUNDLE_MESSAGES,
      );
      // Torn down while it loaded: nothing is left to follow
      if (this.destroyed) return undefined;
      this.statsManager ??= wrapped
        ? new wrapped.StatsManager(this)
        : undefined;
    }
    return this.statsManager;
  }

  private setupEventHandlers(): void {
    if (!this.map) return;

    // Not for every frame of the replay's camera, which rests of its own
    // (see isReplayCameraMove)
    this.mapHandlers = {
      moveend: (e) => {
        if (!isReplayCameraMove(e)) this.stateManager.scheduleSave();
      },
      zoomend: (e) => {
        if (isReplayCameraMove(e)) return;
        this.stateManager.scheduleSave();
        this.airportManager.updateAirportMarkerSizes();
      },
      click: (e) => this.handleMapClick(e),
      touch: (e) => this.touchClock.note(e.originalEvent),
    };
    this.map.on("moveend", this.mapHandlers.moveend!);
    this.map.on("zoomend", this.mapHandlers.zoomend!);
    this.map.on("click", this.mapHandlers.click!);
    for (const type of TOUCH_CLOCK_EVENTS) {
      this.map.on(type, this.mapHandlers.touch!);
    }
  }

  /**
   * The one click handler of the map. Paths are pixels of a layer, not
   * objects with listeners of their own, so what a click means is decided
   * here: a flight under the pointer, or the map beside every flight.
   * Markers are DOM on top of the map, and MapLibre reports a click on one
   * as a click on the map: told by its target, it is none, and no marker
   * has to keep its clicks to itself. For the same reason no popup of the
   * app closes on a click by itself (`closeOnClick`), which would include
   * the click on the marker that has just opened it; they are closed from
   * here.
   */
  private handleMapClick(e: MapMouseEvent): void {
    const at = e.originalEvent.timeStamp;
    if (isOnMarker(e)) {
      this.airportClickAt = at;
      return;
    }
    if (at - this.airportClickAt < DOUBLE_TAP_MS) return;
    // The overview of the Wrapped dialog is this map, and it takes gestures
    // so it can be moved. A click there is none on the main map: it must
    // not change the selection behind the dialog, nor open the values of a
    // flight, whose popup would be a tab stop outside the dialog.
    if (this.wrappedVisible) return;

    const replay = this.replayState;
    if (this.replayActive) {
      // The colour layers are hidden during a replay; the only thing a
      // click on the map does is put the popups away
      this.airportManager.closePopup();
      if (replay.airplaneMarker?.isPopupOpen()) {
        replay.airplaneMarker.closePopup();
      }
      return;
    }

    const hit = this.layerManager.hitTest(e.point);
    // The tiles still show the data of before, so this may well be a click
    // on a flight. Acting on a guess would put away what the user has open;
    // doing nothing costs a second click at worst.
    if (hit === "stale") return;
    // From here on the click is acted on, and only then does it close what
    // a click on the map closes: an ignored click changes nothing at all
    this.airportManager.closePopup();
    if (hit) {
      this.layerManager.onPathClick(
        hit,
        e.lngLat,
        this.touchClock.isTouchClick(e.originalEvent),
      );
      return;
    }
    // A click on the empty map puts the values a tap left away, and leaves
    // the selection alone, in share mode or not: a click that missed a
    // flight by a few pixels, or one that read the heat cloud, threw away
    // the flights someone had put together. The chip's Clear clears.
    this.layerManager.closeSegmentPopup();
  }
}

defineStoreAccessors(MapApp.prototype);

/** Why Reset view is unavailable once the first load is over */
export const RESET_VIEW_DONE_MESSAGE =
  "Nothing to reset: the map shows the start view";

/** Said in place of the map when initialization fails */
export const INIT_ERROR_MESSAGE =
  "The map could not start. Reload the page to try again.";

/** Markup shown in place of the map when initialization fails */
export const INIT_ERROR_HTML =
  '<div class="kh-init-error" role="alert">' + INIT_ERROR_MESSAGE + "</div>";

/**
 * Create the app, bind the controls and run the initial load. Exported so
 * the failure path can be exercised without a page load.
 */
export async function initMapApp(config: MapConfig): Promise<MapApp> {
  // The saved state of the flights the page shows, before anything reads it
  setLocalStateMode(!!config.localFlights);
  const app = new MapApp(config);
  window.mapApp = app;
  // The legend bar and the row chips paint --gradient-*, so publish the
  // ramps before anything that carries one is shown
  applyGradientTokens(document.documentElement);
  renderControlIcons();
  // Bind before the (long) initial load so early interactions are not lost
  bindActions(app);
  // Files dragged over the page go to Your flights, whose bundle draws the
  // sheet that says so (ui/fileDropWatch.ts)
  watchFileDrops(app, () =>
    loadLazyBundle(loadLocal, LOCAL_UNAVAILABLE_MESSAGE),
  );
  await app.initialize();
  return app;
}

/**
 * Whether the page opens a link someone copied (a share token, or the
 * long link of share mode with its intro): it names flights of the site,
 * and would pick those ids out of the visitor's own. The state the page
 * keeps in its own URL as the map moves is no such link.
 */
function opensSharedLink(): boolean {
  const params = new URLSearchParams(location.search);
  return params.has(SHARE_TOKEN_PARAM) || params.has(SHARE_INTRO_PARAM);
}

/**
 * Start the app on the site's flights, or on the ones a visitor dropped
 * and asked to see (ui/localFlights.ts): their bundle then reads the
 * configuration of that dataset from the browser before the app starts,
 * and reopens its panel after the reload that switched the flights. A
 * shared link is to the site's flights, whoever follows it.
 */
export async function startApp(config: MapConfig): Promise<MapApp> {
  const local = !opensSharedLink() && storedFlag(LOCAL_FLIGHTS_KEY);
  // The bundle is asked for the dataset, or only to reopen its panel after
  // the reload that went back to the site's flights
  const bundle =
    local || wantsReopen()
      ? await loadLazyBundle(loadLocal, LOCAL_UNAVAILABLE_MESSAGE)
      : null;
  const start = (local && (await bundle?.localStartConfig(config))) || config;
  const app = await initMapApp(start);
  bundle?.reopenAfterSwitch(app);
  return app;
}

/**
 * Log the failure and tell the user, in place of a map that never came.
 * The controls say it too: bound before the start, they said the flights
 * were still loading, which they never would.
 */
export function reportInitFailure(error: unknown): void {
  logError(error);
  // Only a message of the app's own replaces the generic one
  const message =
    error instanceof UnsupportedBrowserError
      ? error.message
      : INIT_ERROR_MESSAGE;
  failStart(message);
  const mapEl = document.getElementById("map");
  if (mapEl) {
    mapEl.innerHTML = INIT_ERROR_HTML;
    // Set as text
    mapEl.firstElementChild!.textContent = message;
  }
}

// Start the app when the page has set its configuration (map_config.js runs
// before this module); the unit tests import the module without one
if (typeof window !== "undefined" && window.MAP_CONFIG) {
  startApp(window.MAP_CONFIG).catch(reportInitFailure);
}
