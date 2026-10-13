/**
 * Shared fixtures for the MapApp initialization test files.
 *
 * Every manager is replaced by a mock instance so the tests see exactly
 * what MapApp itself does with them; the store, the MapLibre mock and the
 * DOM are real. This module imports nothing but types from the
 * application, so a test file can load it through `vi.hoisted` before it
 * registers the module mocks whose factories (`modules`) hand out these
 * instances.
 */
import { vi } from "vitest";
import type { MapApp } from "../../../../flown/frontend/mapApp";
import type { AirportManager } from "../../../../flown/frontend/ui/airportManager";
import type { DataManager } from "../../../../flown/frontend/ui/dataManager";
import type { FilterManager } from "../../../../flown/frontend/ui/filterManager";
import type { LayerManager } from "../../../../flown/frontend/ui/layerManager";
import type { PathSelection } from "../../../../flown/frontend/ui/pathSelection";
import type { ReplayManager } from "../../../../flown/frontend/ui/replayManager";
import type { StateManager } from "../../../../flown/frontend/ui/stateManager";
import type { StatsManager } from "../../../../flown/frontend/ui/statsManager";
import type { UIToggles } from "../../../../flown/frontend/ui/uiToggles";
import type { WrappedManager } from "../../../../flown/frontend/ui/wrappedManager";
import type {
  Airport,
  KMLDataset,
  Metadata,
  SavedState,
} from "../../../../flown/frontend/types";
import type { Map as MockMap } from "../../../mocks/maplibre-gl";

/**
 * A stand-in for `T`, a class instance or a module: it may leave out what
 * the tests never reach, but names nothing `T` lacks, so a rename there
 * fails `npm run typecheck:tests` instead of leaving a member nobody calls
 */
type StandIn<T> = { [K in keyof T]?: unknown };

export const mockDataManagerInstance = {
  loadAirports: vi.fn(),
  loadMetadata: vi.fn(),
  loadData: vi.fn(),
  updateLayers: vi.fn(),
  showLoading: vi.fn(),
  hideLoading: vi.fn(),
  destroy: vi.fn(),
  applyHeatmapEmphasis: vi.fn(),
  showHeatmap: vi.fn(),
} satisfies StandIn<DataManager>;

export const mockFilterManagerInstance = {
  updateAircraftDropdown: vi.fn(),
  filterByYear: vi.fn(),
  filterByAircraft: vi.fn(),
  pickYear: vi.fn(),
  loadShownYear: vi.fn(),
  loading: false,
  onLoadChange: null as (() => void) | null,
} satisfies StandIn<FilterManager>;

export const mockStatsManagerInstance = {
  updateStatsPanel: vi.fn(),
  updateStatsForSelection: vi.fn(),
  destroy: vi.fn(),
} satisfies StandIn<StatsManager>;

export const mockAirportManagerInstance = {
  updateAirportPopups: vi.fn(),
  showAirports: vi.fn(),
  updateAirportMarkerSizes: vi.fn(),
  closePopup: vi.fn(),
  activateAirport: vi.fn(),
  destroy: vi.fn(),
} satisfies StandIn<AirportManager>;

export const mockReplayManagerInstance = {
  state: {
    airplaneMarker: null as null | {
      isPopupOpen: () => boolean;
      closePopup: ReturnType<typeof vi.fn>;
    },
  },
  toggleReplay: vi.fn(),
  playReplay: vi.fn(),
  pauseReplay: vi.fn(),
  stopReplay: vi.fn(),
  seekReplay: vi.fn(),
  changeReplaySpeed: vi.fn(),
  toggleAutoZoom: vi.fn(),
  destroy: vi.fn(),
} satisfies StandIn<ReplayManager>;

export const mockLayerManagerInstance = {
  updateAirspeedLegend: vi.fn(),
  clearLayer: vi.fn(),
  syncModes: vi.fn(),
  hitTest: vi.fn(),
  onPathClick: vi.fn(),
  closeSegmentPopup: vi.fn(),
  destroy: vi.fn(),
} satisfies StandIn<LayerManager>;

export const mockStateManagerInstance = {
  loadState: vi.fn((): SavedState | null => null),
  saveMapState: vi.fn(),
  scheduleSave: vi.fn(),
  flush: vi.fn(),
  cancelSave: vi.fn(),
  visiting: false,
} satisfies StandIn<StateManager>;

export const mockWrappedManagerInstance = {
  showWrapped: vi.fn(),
  closeWrapped: vi.fn(),
  destroy: vi.fn(),
} satisfies StandIn<WrappedManager>;

/** The feature bundle's toggle of the replay of all flights */
export const toggleReplayAll = vi.fn();

/** The feature bundle's toggle of the cross-section */
export const toggleCrossSection = vi.fn();
/** The feature bundle's toggle of the hotspot tour */
export const toggleHotspotTour = vi.fn();
/** The search bundle's toggle of the search */
export const toggleSearch = vi.fn();
/** The Your flights bundle: its panel, the start on the visitor's flights
 * and the sheet over the map while files are dragged across the page */
export const toggleLocalFlights = vi.fn();
export const localStartConfig = vi.fn(() => Promise.resolve(null));
export const reopenAfterSwitch = vi.fn();
export const showDropSheet = vi.fn();
/** The feature bundle's intro of a link to shared flights */
export const playShareIntro = vi.fn();
/** The phone's bottom bar, which none of these tests mounts by default */
export const mobileBar = { mountFor: vi.fn() };

export const mockUITogglesInstance = {
  toggleHeatmap: vi.fn(),
  toggleAltitude: vi.fn(),
  toggleAirspeed: vi.fn(),
  toggleAirports: vi.fn(),
  toggleAviation: vi.fn(),
  exportMap: vi.fn(),
  shareLink: vi.fn(),
} satisfies StandIn<UIToggles>;

export const mockPathSelectionInstance = {
  updateIsolateButton: vi.fn(),
  clearSelection: vi.fn(),
  selectPathsByAirport: vi.fn(),
  togglePathSelection: vi.fn(),
  toggleIsolateSelection: vi.fn(),
} satisfies StandIn<PathSelection>;

/**
 * The stand-ins of the modules MapApp builds on, for the `vi.mock` calls of
 * the test files: Vitest hoists those calls in the file that makes them, so
 * each file still makes its own, with the factory from here. A manager's
 * class hands out its instance above.
 */
export const modules = {
  logger: () =>
    ({
      logError: vi.fn(),
      logDebug: vi.fn(),
      initLogger: vi.fn(),
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/utils/logger")
    >,
  domCache: () =>
    ({
      domCache: {
        get: vi.fn((id: string, ctor?: new () => HTMLElement) => {
          const element = document.getElementById(id);
          if (!element || !ctor) return element;
          return element instanceof ctor ? element : null;
        }),
        clear: vi.fn(),
      },
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/utils/domCache")
    >,
  toast: () =>
    ({
      showToast: vi.fn(),
      announceStatus: vi.fn(),
      dismissToast: vi.fn(),
      TOAST_DURATION_MS: 4000,
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/utils/toast")
    >,
  // The real bar registers a window resize listener it never removes, so
  // every test would leak one along with the MapApp it pins
  mobileBar: () =>
    ({ MobileBar: mobileBar }) satisfies StandIn<
      typeof import("../../../../flown/frontend/ui/mobileBar")
    >,
  dataManager: () =>
    ({
      DataManager: vi.fn(function () {
        return mockDataManagerInstance;
      }),
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/ui/dataManager")
    >,
  filterManager: () =>
    ({
      FilterManager: vi.fn(function () {
        return mockFilterManagerInstance;
      }),
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/ui/filterManager")
    >,
  airportManager: () =>
    ({
      AirportManager: vi.fn(function () {
        return mockAirportManagerInstance;
      }),
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/ui/airportManager")
    >,
  replayManager: () =>
    ({
      ReplayManager: vi.fn(function () {
        return mockReplayManagerInstance;
      }),
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/ui/replayManager")
    >,
  layerManager: () =>
    ({
      LayerManager: vi.fn(function () {
        return mockLayerManagerInstance;
      }),
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/ui/layerManager")
    >,
  stateManager: () =>
    ({
      StateManager: vi.fn(function () {
        return mockStateManagerInstance;
      }),
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/ui/stateManager")
    >,
  wrappedManager: () =>
    ({
      WrappedManager: vi.fn(function () {
        return mockWrappedManagerInstance;
      }),
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/ui/wrappedManager")
    >,
  featureLoader: () =>
    ({
      loadedFeatures: () => null,
      // Replay and Wrapped come from lazily loaded bundles of their own;
      // here they are the doubles the stand-ins above return
      loadFeatures: vi.fn(() =>
        Promise.resolve({
          ReplayManager: vi.fn(function () {
            return mockReplayManagerInstance;
          }),
          // The satellite switch hands itself over to the bundle
          followSatellite: vi.fn(),
          toggleReplayAll,
          toggleCrossSection,
          toggleHotspotTour,
          // And the selected flights to their profile
          followFlightProfile: vi.fn(),
          // A link to shared flights plays their intro
          playShareIntro,
        } satisfies StandIn<
          typeof import("../../../../flown/frontend/features")
        >),
      ),
      loadWrapped: vi.fn(() =>
        Promise.resolve({
          WrappedManager: vi.fn(function () {
            return mockWrappedManagerInstance;
          }),
          // The statistics panel rides in the Wrapped bundle
          StatsManager: vi.fn(function () {
            return mockStatsManagerInstance;
          }),
        } satisfies StandIn<
          typeof import("../../../../flown/frontend/wrapped")
        >),
      ),
      loadSearch: vi.fn(() =>
        Promise.resolve({ toggleSearch } satisfies StandIn<
          typeof import("../../../../flown/frontend/search")
        >),
      ),
      loadLocal: vi.fn(() =>
        Promise.resolve({
          toggleLocalFlights,
          localStartConfig,
          reopenAfterSwitch,
          showDropSheet,
        } satisfies StandIn<typeof import("../../../../flown/frontend/local")>),
      ),
      // The phone's bar comes with the extras bundle
      loadExtras: vi.fn(() =>
        Promise.resolve({ MobileBar: mobileBar } satisfies StandIn<
          typeof import("../../../../flown/frontend/extras")
        >),
      ),
      wasSiteUpdated: vi.fn(() => false),
      noticeSiteUpdate: vi.fn(() => null),
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/services/featureLoader")
    >,
  uiToggles: () =>
    ({
      UIToggles: vi.fn(function () {
        return mockUITogglesInstance;
      }),
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/ui/uiToggles")
    >,
  pathSelection: () =>
    ({
      PathSelection: vi.fn(function () {
        return mockPathSelectionInstance;
      }),
      // The start view keeps 48 pixels off every edge where no panel is
      mapChromePadding: vi.fn(() => ({
        top: 48,
        right: 48,
        bottom: 48,
        left: 48,
      })),
      CONTROL_COLUMNS: "#left-buttons, #right-buttons",
    }) satisfies StandIn<
      typeof import("../../../../flown/frontend/ui/pathSelection")
    >,
};

/** The map configuration every MapApp in these tests is built with */
export const APP_CONFIG = {
  center: [51, 9] as [number, number],
  bounds: [
    [50, 8],
    [52, 10],
  ] as [[number, number], [number, number]],
  dataDir: "/data",
};

/**
 * A MapApp built with APP_CONFIG. The test file hands in the class, which it
 * imports once its module mocks are in place: this module must not import
 * the application (see the top).
 */
export function createApp(App: typeof MapApp): MapApp {
  return new App({ ...APP_CONFIG });
}

/** The mock behind `app.map`, for what the real type does not have */
export function mockMap(app: MapApp): MockMap {
  return app.map as unknown as MockMap;
}

const originalGetContext = HTMLCanvasElement.prototype.getContext;

export function setupDOM(): void {
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    ...args: unknown[]
  ) {
    if (type === "webgl2") {
      return {
        getExtension: () => ({ loseContext() {} }),
      } as unknown as RenderingContext;
    }
    return originalGetContext.call(this, type, ...args);
  } as typeof originalGetContext;
  document.body.innerHTML = `
    <div id="map"></div>
    <select id="year-select">
      <option value="all">All Years</option>
    </select>
    <select id="aircraft-select">
      <option value="all">All Aircraft</option>
    </select>
    <div id="left-buttons" class="control-column">
      <div class="control-row">
        <button id="stats-btn" data-icon="stats">
          <span class="control-label">Statistics</span>
        </button>
      </div>
      <div class="control-row">
        <button id="isolate-btn" data-icon="isolate">
          <span class="control-label">Share mode</span>
        </button>
      </div>
    </div>
    <button id="heatmap-btn"></button>
    <button id="replay-btn" aria-label="Replay selected flights"></button>
    <button id="selection-replay-btn" hidden></button>
    <button id="altitude-btn"></button>
    <button id="airspeed-btn"></button>
    <button id="airports-btn"></button>
    <div class="control-row">
      <button id="aviation-btn"></button>
      <button id="globe-btn"></button>
      <button id="compass-btn"></button>
      <button id="compass-float-btn" hidden></button>
      <button id="reset-view-btn"></button>
    </div>
    <div id="altitude-legend"></div>
    <div id="airspeed-legend"></div>
    <div id="stats-rail" hidden>
      <div id="stats-rail-header">
        <button
          id="stats-collapse-btn"
          data-icon="collapse"
          data-icon-size="20"
          aria-expanded="false"
        ></button>
      </div>
      <div id="stats-panel" tabindex="0"></div>
    </div>
    <div id="loading" style="display:none"></div>
  `;
}

export const defaultAirports: Airport[] = [
  { name: "Frankfurt EDDF", lat: 50.1, lon: 8.67 },
  { name: "Munich EDDM", lat: 48.35, lon: 11.78 },
];

export const defaultMetadata: Metadata = {
  available_years: [2024, 2025],
  year_file_bytes: { "2024": 10, "2025": 20 },
  min_groundspeed_knots: 0,
  max_groundspeed_knots: 150,
  aircraft_models: { "D-ABCD": "Diamond DA40" },
};

export const defaultData: KMLDataset = {
  // Timed, so the one flight can be replayed
  path_segments: [
    {
      path_id: 1,
      coords: [
        [50, 8],
        [50.1, 8.1],
      ],
      altitude_ft: 5000,
      groundspeed_knots: 100,
      time: 0,
    },
    {
      path_id: 1,
      coords: [
        [50.1, 8.1],
        [50.2, 8.2],
      ],
      altitude_ft: 5500,
      groundspeed_knots: 100,
      time: 60,
    },
  ],
  path_info: [
    {
      id: 1,
      year: 2025,
      aircraft_registration: "D-ABCD",
      start_airport: "EDDF",
      end_airport: "EDDM",
    },
  ],
  original_points: 1000,
};

export async function initializeApp(
  app: MapApp,
  airports = defaultAirports,
  metadata: Metadata | null = defaultMetadata,
  data: KMLDataset | null = defaultData,
): Promise<void> {
  mockDataManagerInstance.loadAirports.mockResolvedValue(airports);
  mockDataManagerInstance.loadMetadata.mockResolvedValue(metadata);
  mockDataManagerInstance.loadData.mockResolvedValue(data);
  // Keep an implementation that a test installed before initializing
  const filterByYear = mockFilterManagerInstance.filterByYear;
  if (!filterByYear.getMockImplementation()) {
    filterByYear.mockResolvedValue(true);
  }
  // The first load as FilterManager does it, reduced to what MapApp sees:
  // the year of the dropdown, published with its aircraft list in one
  // update (see FilterManager.loadShownYear)
  mockFilterManagerInstance.loadShownYear.mockImplementation(async () => {
    const select = document.getElementById("year-select");
    const year =
      select instanceof HTMLSelectElement ? select.value : app.selectedYear;
    const loaded = (await mockDataManagerInstance.loadData(
      year,
    )) as KMLDataset | null;
    if (!loaded) return false;
    app.store.batch(() => {
      app.selectedYear = year;
      app.currentData = loaded;
      mockFilterManagerInstance.updateAircraftDropdown();
    });
    return true;
  });

  await app.initialize();
}

/**
 * The request for the base style, the one thing MapApp fetches itself. It
 * never answers unless a test says otherwise, so the map stays on the style
 * it starts with and no test reaches for the network.
 */
export const fetchBaseStyle = vi.fn<typeof fetch>();

/** An answer of `fetchBaseStyle` that carries a style */
export function styleResponse(style: unknown, status = 200): Response {
  return new Response(JSON.stringify(style), { status });
}

/** Reset every mock to a clean, resolved state before a test */
export function resetManagerMocks(): void {
  vi.resetAllMocks();
  fetchBaseStyle.mockReturnValue(new Promise(() => {}));
  vi.stubGlobal("fetch", fetchBaseStyle);
  mockStateManagerInstance.loadState.mockReturnValue(null);
  mockReplayManagerInstance.state.airplaneMarker = null;
}

export function yearSelect(): HTMLSelectElement {
  return document.getElementById("year-select") as HTMLSelectElement;
}
