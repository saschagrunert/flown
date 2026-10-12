/**
 * Test helper types and utilities
 */
import { vi, type Mock } from "vitest";
import type { MapApp } from "../../flown/frontend/mapApp";
import type {
  PathInfo,
  PathSegment,
  KMLDataset,
  Metadata,
} from "../../flown/frontend/types";
import { datasetIndex } from "../../flown/frontend/calculations/datasetIndex";
import { ReplayState } from "../../flown/frontend/ui/replayState";
import { ReliefState } from "../../flown/frontend/ui/reliefState";
import {
  AppStore,
  DEFAULT_AIRSPEED_RANGE,
  DEFAULT_ALTITUDE_RANGE,
  defineStoreAccessors,
  isMapHeld,
  STORE_ACCESSOR_KEYS,
  type StoreState,
} from "../../flown/frontend/state/store";
import { TOGGLES } from "../../flown/frontend/state/toggles";
import { TouchClock } from "../../flown/frontend/utils/device";
import { segmentsForPathIds } from "../../flown/frontend/calculations/statistics";
import { runLines } from "../../flown/frontend/ui/pathRuns";
import { DAY_MAX_FLIGHTS } from "../../flown/frontend/utils/constants";
import {
  REPLAY_PRECONDITION_MESSAGE,
  REPLAY_TOO_MANY_MESSAGE,
} from "../../flown/frontend/ui/replayButton";
import { followLayerVisibility } from "../../flown/frontend/ui/layerVisibility";
import {
  syncLegend,
  syncToggleButton,
} from "../../flown/frontend/utils/buttonState";
import { Map as MockMapLibreMap, mockControl } from "../mocks/maplibre-gl";
import {
  addDataLayers,
  AirportLayerHandle,
  MapLayerHandle,
} from "../../flown/frontend/mapLayers";
import {
  HEATMAP_LAYER_IDS,
  MAP_LAYERS,
} from "../../flown/frontend/utils/constants";
import type { Map as MapLibreMap } from "maplibre-gl";

/**
 * Build a dataset from path info and segments
 */
export function createDataset(
  pathInfo: PathInfo[] = [],
  segments: PathSegment[] = [],
  originalPoints = 0,
): KMLDataset {
  return {
    path_segments: segments,
    path_info: pathInfo,
    original_points: originalPoints,
  };
}

/**
 * Create a segment with sensible defaults
 */
export function createSegment(
  overrides: Partial<PathSegment> = {},
): PathSegment {
  return {
    path_id: 1,
    coords: [
      [50.0, 8.0],
      [50.1, 8.1],
    ],
    altitude_ft: 3000,
    groundspeed_knots: 100,
    ...overrides,
  };
}

/**
 * A segment of which a test gives the fields the code under test reads.
 * The others are those of a segment that stands still at 0,0: at sea
 * level, and without a speed (0, as a log without timing has).
 */
export function segmentOf(
  fields: Pick<PathSegment, "path_id"> & Partial<PathSegment>,
): PathSegment {
  return {
    coords: [
      [0, 0],
      [0, 0],
    ],
    altitude_ft: 0,
    groundspeed_knots: 0,
    ...fields,
  };
}

/** Mocked manager set attached to a mock app */
interface MockManagers {
  dataManager: {
    loadData: Mock;
    loadAirports: Mock;
    loadMetadata: Mock;
    updateLayers: Mock;
    showLoading: Mock;
    hideLoading: Mock;
    destroy: Mock;
    applyHeatmapEmphasis: Mock;
    showHeatmap: Mock;
    dismissFailures: Mock;
    cachedData: Mock;
    failureNote: ((message: string) => void) | null;
    onMetadata: ((metadata: Metadata) => void) | null;
    heatRequests: number;
    writeSource: Mock;
    askWorker: Mock;
  };
  layerManager: {
    clearLayer: Mock;
    updateSelectionStyles: Mock;
    syncModes: Mock;
    updateAltitudeLegend: Mock;
    updateAirspeedLegend: Mock;
    hitTest: Mock;
    onPathClick: Mock;
    closeSegmentPopup: Mock;
  };
  filterManager: {
    updateAircraftDropdown: Mock;
    filterByYear: Mock;
    filterByAircraft: Mock;
    pickYear: Mock;
    loadShownYear: Mock;
    cancelPending: Mock;
    loading: boolean;
    onLoadChange: (() => void) | null;
  };
  statsManager: {
    updateStatsPanel: Mock;
    updateStatsForSelection: Mock;
  };
  touchClock: TouchClock;
  pathSelection: {
    togglePathSelection: Mock;
    selectPathsByAirport: Mock;
    clearSelection: Mock;
    toggleIsolateSelection: Mock;
    updateIsolateButton: Mock;
    selectFlight: Mock;
    pickFromList: Mock;
    markSelected: Mock;
    held: Mock;
  };
  airportManager: {
    updateAirportPopups: Mock;
    showAirports: Mock;
    updateAirportMarkerSizes: Mock;
    activateAirport: Mock;
    openPopup: Mock;
    closePopup: Mock;
    isPopupOpen: Mock;
  };
  stateManager: {
    saveMapState: Mock;
    scheduleSave: Mock;
    flush: Mock;
    loadState: Mock;
    loadMapState: Mock;
    updateUrl: Mock;
    cancelSave: Mock;
  };
  /**
   * The replay state the app owns. `replayManager.state` is the very same
   * object, the way it is in the app, so a test may set either. A real
   * ReplayState, because the real ReplayManager works on it.
   */
  replayState: ReplayState;
  canReplay: Mock;
  replayHint: Mock;
  toggleReplay: Mock;
  toggleReplayAll: Mock;
  toggleCrossSection: Mock;
  toggleHotspotTour: Mock;
  toggleSearch: Mock;
  resetView: Mock;
  isReset: Mock;
  canResetView: Mock;
  loadReplay: Mock;
  loadWrapped: Mock;
  loadStats: Mock;
  replayManager: {
    state: ReplayState;
    toggleReplay: Mock;
    playReplay: Mock;
    pauseReplay: Mock;
    stopReplay: Mock;
    seekReplay: Mock;
    changeReplaySpeed: Mock;
    toggleAutoZoom: Mock;
    toggleChase: Mock;
    userMapView: Mock;
    redrawReplayPath: Mock;
    updateReplayAirplanePopup: Mock;
    destroy: Mock;
  };
  wrappedManager: {
    showWrapped: Mock;
    closeWrapped: Mock;
    userMapView: Mock;
    destroy: Mock;
  };
  mapOrientation: {
    toggleGlobe: Mock;
    toggleThreeD: Mock;
    resetNorth: Mock;
  };
  uiToggles: {
    toggleHeatmap: Mock;
    toggleAltitude: Mock;
    toggleAirspeed: Mock;
    toggleAirports: Mock;
    toggleAviation: Mock;
    toggleSatellite: Mock;
    exportMap: Mock;
    shareLink: Mock;
  };
}

/** A layer handle whose methods are spies over the real behaviour */
type SpiedHandle<T> = T & { isVisible: Mock; setVisible: Mock };

/**
 * Fully mocked MapApp: a real AppStore behind the store-backed accessors,
 * the mock map with its style loaded and every source and layer of MAP_SOURCES and
 * MAP_LAYERS on it, the real layer handles attached to that map (spied, so
 * a test may assert on the call or on `map.layer(id).layout`), a resolved
 * `mapReady` and vi.fn() stubs for every manager.
 */
export type MockApp = Omit<
  MapApp,
  | keyof MockManagers
  | "map"
  | "heatmapLayer"
  | "aviationLayer"
  | "altitudeLayer"
  | "airspeedLayer"
  | "airportLayer"
  | "selectionHighlightLayer"
> &
  MockManagers & {
    map: MockMapLibreMap | null;
    heatmapLayer: SpiedHandle<MapLayerHandle>;
    aviationLayer: SpiedHandle<MapLayerHandle>;
    altitudeLayer: SpiedHandle<MapLayerHandle>;
    airspeedLayer: SpiedHandle<MapLayerHandle>;
    airportLayer: SpiedHandle<AirportLayerHandle>;
    selectionHighlightLayer: SpiedHandle<MapLayerHandle>;
  };

export interface MockAppOverrides extends Partial<StoreState> {
  /** The app's lifetime signal; a test that aborts it passes its own */
  signal?: AbortSignal;
  aircraftModels?: MapApp["aircraftModels"];
  altitudeRange?: MapApp["altitudeRange"];
  airspeedRange?: MapApp["airspeedRange"];
  metadataAirspeedRange?: MapApp["metadataAirspeedRange"];
  config?: Partial<MapApp["config"]>;
  isInitializing?: boolean;
  airportMarkers?: MapApp["airportMarkers"];
  airportToPaths?: MapApp["airportToPaths"];
  savedState?: MapApp["savedState"];
  restoredYearFromState?: boolean;
  managers?: {
    [K in keyof MockManagers]?: Partial<MockManagers[K]>;
  };
  /** A map of the test's own, or null for an app without one */
  map?: MockMapLibreMap | null;
  /** In place of the one that has resolved with the map already */
  mapReady?: Promise<unknown>;
}

/**
 * The part of the year decoder the mock app's DataManager.askWorker hands
 * its questions: the content of a colour layer's source as the
 * FeatureCollection the worker's text stands for (see runsSource in
 * services/flightLines.ts, whose own tests hold the two to each other)
 */
const syncDecoder = {
  runsSource: (
    segments: readonly PathSegment[],
    runs: Parameters<typeof runLines>[1],
    g: number,
  ): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: runLines(segments, runs, g),
  }),
};

function createMockManagers(): MockManagers {
  // The app owns the replay state and the manager works on the same object
  const replayState = new ReplayState();
  const replayManager = {
    state: replayState,
    toggleReplay: vi.fn(),
    playReplay: vi.fn(),
    pauseReplay: vi.fn(),
    stopReplay: vi.fn(),
    seekReplay: vi.fn(),
    changeReplaySpeed: vi.fn(),
    toggleAutoZoom: vi.fn(),
    toggleChase: vi.fn(),
    userMapView: vi.fn(() => null),
    redrawReplayPath: vi.fn(),
    updateReplayAirplanePopup: vi.fn(),
    destroy: vi.fn(),
  };
  const wrappedManager = {
    showWrapped: vi.fn(),
    closeWrapped: vi.fn(),
    userMapView: vi.fn(() => null),
    destroy: vi.fn(),
  };
  return {
    dataManager: {
      loadData: vi.fn().mockResolvedValue(null),
      loadAirports: vi.fn().mockResolvedValue([]),
      loadMetadata: vi.fn().mockResolvedValue(null),
      updateLayers: vi.fn(),
      showLoading: vi.fn(),
      hideLoading: vi.fn(),
      destroy: vi.fn(),
      applyHeatmapEmphasis: vi.fn(),
      showHeatmap: vi.fn(),
      dismissFailures: vi.fn(),
      cachedData: vi.fn(() => undefined),
      failureNote: null,
      onMetadata: null,
      heatRequests: 0,
      writeSource: vi.fn((source: { setData(data: unknown): unknown }, data) =>
        source.setData(data),
      ),
      // The year worker's answer at once, and the lines of the runs of a
      // colour layer as the objects they stand for, which the tests read
      askWorker: vi.fn(
        (
          ask: (decoder: typeof syncDecoder) => unknown,
          take: (answer: unknown) => void,
        ) => take(ask(syncDecoder)),
      ),
    },
    layerManager: {
      clearLayer: vi.fn(),
      updateSelectionStyles: vi.fn(),
      syncModes: vi.fn(),
      updateAltitudeLegend: vi.fn(),
      updateAirspeedLegend: vi.fn(),
      hitTest: vi.fn(() => null),
      onPathClick: vi.fn(),
      closeSegmentPopup: vi.fn(),
    },
    filterManager: {
      updateAircraftDropdown: vi.fn(),
      filterByYear: vi.fn().mockResolvedValue(undefined),
      filterByAircraft: vi.fn().mockResolvedValue(undefined),
      pickYear: vi.fn(),
      loadShownYear: vi.fn().mockResolvedValue(true),
      cancelPending: vi.fn(),
      loading: false,
      onLoadChange: null,
    },
    statsManager: {
      updateStatsPanel: vi.fn(),
      updateStatsForSelection: vi.fn(),
    },
    touchClock: new TouchClock(),
    pathSelection: {
      togglePathSelection: vi.fn(),
      selectPathsByAirport: vi.fn(),
      clearSelection: vi.fn(),
      toggleIsolateSelection: vi.fn(),
      updateIsolateButton: vi.fn(),
      selectFlight: vi.fn(),
      pickFromList: vi.fn(),
      markSelected: vi.fn(), // replaced below once the app exists
      held: vi.fn(), // so is this
    },
    airportManager: {
      updateAirportPopups: vi.fn(),
      showAirports: vi.fn(),
      updateAirportMarkerSizes: vi.fn(),
      activateAirport: vi.fn(),
      openPopup: vi.fn(),
      closePopup: vi.fn(),
      isPopupOpen: vi.fn(() => false),
    },
    stateManager: {
      saveMapState: vi.fn(),
      scheduleSave: vi.fn(),
      flush: vi.fn(),
      loadState: vi.fn(() => null),
      loadMapState: vi.fn(() => null),
      updateUrl: vi.fn(),
      cancelSave: vi.fn(),
    },
    replayState,
    // The real predicate, the way MapApp.canReplay puts it
    canReplay: vi.fn(function (this: MockApp) {
      const segments = this.fullPathSegments;
      const size = this.selectedPathIds.size;
      return (
        size > 0 &&
        size <= DAY_MAX_FLIGHTS &&
        this.hasTimingData &&
        !!segments &&
        segmentsForPathIds(segments, this.selectedPathIds).some(
          (segment) => (segment.time ?? 0) > 0,
        )
      );
    }),
    // As MapApp.replayHint puts it: no times at all before too many
    replayHint: vi.fn(function (this: MockApp) {
      return this.canReplay()
        ? null
        : this.selectedPathIds.size > DAY_MAX_FLIGHTS &&
            this.selectedPathIds.size > 0 &&
            this.hasTimingData &&
            segmentsForPathIds(
              this.fullPathSegments ?? [],
              this.selectedPathIds,
            ).some((segment) => (segment.time ?? 0) > 0)
          ? REPLAY_TOO_MANY_MESSAGE
          : REPLAY_PRECONDITION_MESSAGE;
    }),
    // Like the app's once the manager is there: straight to it
    toggleReplay: vi.fn(() => {
      replayManager.toggleReplay();
    }),
    toggleReplayAll: vi.fn(),
    toggleCrossSection: vi.fn(),
    toggleHotspotTour: vi.fn(),
    toggleSearch: vi.fn(),
    resetView: vi.fn(() => Promise.resolve()),
    // Something to reset unless a test says otherwise
    isReset: vi.fn(() => false),
    canResetView: vi.fn(function (this: MockApp) {
      return !this.isInitializing && !this.isReset();
    }),
    // Replay and Wrapped are fetched on demand in the app; the stubs are
    // already there, so the loaders hand them straight back
    loadReplay: vi.fn(() => Promise.resolve(replayManager)),
    loadWrapped: vi.fn(() => Promise.resolve(wrappedManager)),
    loadStats: vi.fn(function (this: MockApp) {
      return Promise.resolve(this.statsManager);
    }),
    replayManager,
    wrappedManager,
    mapOrientation: {
      toggleGlobe: vi.fn(),
      toggleThreeD: vi.fn(),
      resetNorth: vi.fn(),
    },
    uiToggles: {
      toggleHeatmap: vi.fn(),
      toggleAltitude: vi.fn(),
      toggleAirspeed: vi.fn(),
      toggleAirports: vi.fn(),
      toggleAviation: vi.fn(),
      toggleSatellite: vi.fn(),
      exportMap: vi.fn(),
      shareLink: vi.fn().mockResolvedValue(undefined),
    },
  };
}

/** Every store key, each of which has an accessor */
const STORE_KEYS: readonly (keyof StoreState)[] = STORE_ACCESSOR_KEYS;

/**
 * A mock MapLibre map the way the app leaves it once `mapReady` resolves:
 * style loaded, every source and layer created and empty. Built at once, so
 * a test does not have to wait for the style first.
 */
export function createMapLibreMock(
  options: Record<string, unknown> = {},
): MockMapLibreMap {
  const autoLoadStyle = mockControl.autoLoadStyle;
  mockControl.autoLoadStyle = false;
  let map: MockMapLibreMap;
  try {
    map = new MockMapLibreMap({
      container:
        document.getElementById("map") ?? document.createElement("div"),
      style: "https://example.test/style.json",
      ...options,
    });
  } finally {
    mockControl.autoLoadStyle = autoLoadStyle;
  }
  map.finishStyleLoad();
  addDataLayers(map as unknown as MapLibreMap);
  return map;
}

/** The map and layer fields; everything else is built here */
type MapFields = Record<string, unknown> & { map: unknown };

function buildMockApp(
  overrides: Omit<MockAppOverrides, "map">,
  mapFields: MapFields,
): unknown {
  const { config, managers, ...rest } = overrides;
  const initial: Partial<StoreState> = {};
  const other: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if ((STORE_KEYS as string[]).includes(key)) {
      (initial as Record<string, unknown>)[key] = value;
    } else {
      other[key] = value;
    }
  }

  const store = new AppStore(initial);
  const mockManagers = createMockManagers();
  if (managers) {
    for (const [name, partial] of Object.entries(managers)) {
      Object.assign(
        mockManagers[name as keyof MockManagers] as object,
        partial,
      );
    }
  }

  const app = {
    store,
    // A real one on the app's store, as the app has it
    relief: new ReliefState(store),
    config: {
      center: [50, 8] as [number, number],
      bounds: [
        [49, 7],
        [51, 9],
      ] as [[number, number], [number, number]],
      dataDir: "data",
      ...config,
    },
    isInitializing: false,
    ...mapFields,
    // Like the app's after initialize(): the map, with its layers on it
    mapReady: Promise.resolve(mapFields.map),
    // Derived like MapApp's getter; an override replaces it with fixed data
    get airportToPaths(): MapApp["airportToPaths"] {
      const data = store.get("currentData");
      if (!data) return {};
      return datasetIndex(data)
        .filter(store.get("selectedYear"), store.get("selectedAircraft"))
        .pathIdsByAirport();
    },
    airportMarkers: {},
    aircraftModels: {},
    altitudeRange: { ...DEFAULT_ALTITUDE_RANGE },
    airspeedRange: { ...DEFAULT_AIRSPEED_RANGE },
    metadataAirspeedRange: { ...DEFAULT_AIRSPEED_RANGE },
    signal: new AbortController().signal,
    savedState: null,
    restoredYearFromState: false,
    defaultYear: "all",
    mobileBar: null,
    ...mockManagers,
    ...other,
    // The app's own predicate on the same store
    get mapHeld(): boolean {
      return isMapHeld(store);
    },
    get fullPathInfo() {
      return store.get("currentData")?.path_info ?? null;
    },
    get fullPathSegments() {
      return store.get("currentData")?.path_segments ?? null;
    },
    initialize: vi.fn(),
    destroy: vi.fn(),
  };
  defineStoreAccessors(app);

  const mockApp = app as unknown as MockApp;
  // Marks the buttons and checkboxes of the flight lists the way
  // PathSelection does, from the app's selection
  mockApp.pathSelection.markSelected.mockImplementation(
    (rows: Iterable<HTMLElement>) => {
      for (const row of rows) {
        const selected = mockApp.selectedPathIds.has(
          Number(row.dataset["pathId"]),
        );
        if (row instanceof HTMLInputElement) row.checked = selected;
        else row.setAttribute("aria-pressed", String(selected));
      }
    },
  );

  // A replay or the hotspot tour holds the selection, as PathSelection says
  mockApp.pathSelection.held.mockImplementation(
    () => mockApp.replayActive || mockApp.tourView !== null,
  );

  return mockApp;
}

/** Wrap the methods tests assert on in spies that keep the real behaviour */
function spied<T extends MapLayerHandle>(handle: T): SpiedHandle<T> {
  const base: MapLayerHandle = handle;
  vi.spyOn(base, "isVisible");
  vi.spyOn(base, "setVisible");
  return handle as SpiedHandle<T>;
}

/**
 * Create a mock MapApp, see `MockApp`. Store keys can be seeded through
 * `overrides`. The handles start out like the app's own (everything hidden
 * but the airports) and are attached to the map, so `setVisible` shows on the
 * mock's layers.
 *
 * The accessors come from the same `defineStoreAccessors` the real MapApp
 * uses, so the double cannot drift from it.
 */
export function createMockApp(overrides: MockAppOverrides = {}): MockApp {
  const { map: mapOverride, ...rest } = overrides;
  const map = mapOverride === undefined ? createMapLibreMock() : mapOverride;
  const handles = {
    heatmapLayer: spied(new MapLayerHandle(HEATMAP_LAYER_IDS)),
    aviationLayer: spied(new MapLayerHandle([MAP_LAYERS.aviation])),
    altitudeLayer: spied(
      new MapLayerHandle([
        MAP_LAYERS.pathsAltitude,
        MAP_LAYERS.pathsAltitudeSelected,
        MAP_LAYERS.pathsAltitudeRibbons,
        MAP_LAYERS.pathsAltitudeSelectedRibbons,
      ]),
    ),
    airspeedLayer: spied(
      new MapLayerHandle([
        MAP_LAYERS.pathsAirspeed,
        MAP_LAYERS.pathsAirspeedSelected,
        MAP_LAYERS.pathsAirspeedRibbons,
        MAP_LAYERS.pathsAirspeedSelectedRibbons,
      ]),
    ),
    airportLayer: spied(new AirportLayerHandle()),
    selectionHighlightLayer: spied(
      new MapLayerHandle([
        MAP_LAYERS.selectionHighlight,
        MAP_LAYERS.selectionHighlightRibbons,
      ]),
    ),
  };
  if (map) {
    for (const handle of Object.values(handles)) {
      handle.attach(map as unknown as MapLibreMap);
      // Attaching is setup, not something the code under test did
      handle.setVisible.mockClear();
    }
  }
  return buildMockApp(rest, { map, ...handles }) as MockApp;
}

/**
 * Cast a mock app to MapApp for constructor calls
 */
export function asMapApp(app: MockApp): MapApp {
  return app as unknown as MapApp;
}

/**
 * Whether a control cannot act the way a replay or the tour holds it
 * (ui/heldControls.ts): a select disabled, a button aria-disabled
 */
export function isHeld(control: Element | null): boolean {
  return !!control?.matches(':disabled, [aria-disabled="true"]');
}

/**
 * Wire the store-driven toggle buttons, legends and layers the way MapApp
 * does (setupButtonSync, followLayerVisibility), for tests that assert on
 * the state a manager causes through the store. The colour layers are the
 * layer manager's, a stub here unless the test gives it a real one.
 */
export function syncControlsWithStore(app: MockApp): void {
  const store = app.store;
  for (const toggle of TOGGLES) {
    if ("pressed" in toggle) syncToggleButton(store, toggle.key, toggle.button);
  }
  syncLegend(store, "airspeedVisible", "airspeed-legend");
  followLayerVisibility(asMapApp(app));
}

/**
 * Have the safe area's probe (utils/safeArea.ts) measure these insets, as
 * an iPhone's home screen app would; the sides left out are 0. Call
 * resetSafeArea first where an earlier measure may be kept.
 */
export function measureSafeArea(
  insets: Partial<Record<"top" | "right" | "bottom" | "left", number>>,
) {
  const real = window.getComputedStyle.bind(window);
  return vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    element.id === "safe-area-probe"
      ? ({
          paddingTop: `${insets.top ?? 0}px`,
          paddingRight: `${insets.right ?? 0}px`,
          paddingBottom: `${insets.bottom ?? 0}px`,
          paddingLeft: `${insets.left ?? 0}px`,
        } as CSSStyleDeclaration)
      : real(element),
  );
}

/**
 * Give the window a device pixel ratio. jsdom's own value (1) is a property
 * of the window, so a test sets it back with `setDevicePixelRatio(1)` rather
 * than deleting it: a deleted one reads as undefined, and every comparison
 * against it then quietly takes the other branch in whatever test runs next.
 */
export function setDevicePixelRatio(ratio: number): void {
  Object.defineProperty(window, "devicePixelRatio", {
    value: ratio,
    configurable: true,
  });
}

/**
 * Mount `id: tag` elements on the body. The returned function removes them
 * again.
 */
export function mountElements(spec: Record<string, string>): () => void {
  const created: HTMLElement[] = [];
  for (const [id, tag] of Object.entries(spec)) {
    const element = document.createElement(tag);
    element.id = id;
    document.body.appendChild(element);
    created.push(element);
  }
  return () => {
    for (const element of created) element.remove();
  };
}

/** Get an element that must exist */
export function el(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing test element #${id}`);
  return element;
}

/** The animation frames a test has stubbed, run by hand */
export interface StubbedAnimationFrames {
  /** Run the frames asked for so far; ones they ask for wait for the next run */
  run(): void;
  /** How many frames are waiting */
  pending(): number;
}

/**
 * Replace requestAnimationFrame and cancelAnimationFrame with a queue the
 * test runs itself. Undone before the next test (unstubGlobals in
 * vitest.config.js).
 */
export function stubAnimationFrames(): StubbedAnimationFrames {
  const frames = new Map<number, FrameRequestCallback>();
  let handle = 0;
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      frames.set(++handle, callback);
      return handle;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
  return {
    run() {
      const due = [...frames.values()];
      frames.clear();
      for (const frame of due) frame(0);
    },
    pending: () => frames.size,
  };
}
