/**
 * MapApp: store-driven controls, the statistics rail, map events and setup.
 */
import { DAY_MAX_FLIGHTS } from "../../../../flown/frontend/utils/constants";
import {
  REPLAY_HIDDEN_MESSAGE,
  REPLAY_PRECONDITION_MESSAGE,
  REPLAY_TOO_MANY_MESSAGE,
} from "../../../../flown/frontend/ui/replayButton";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { MapApp } from "../../../../flown/frontend/mapApp";
import {
  cartoTransformRequest,
  BASE_STYLE_RETRY_MS,
  BASE_STYLE_UNAVAILABLE_MESSAGE,
  FALLBACK_STYLE,
} from "../../../../flown/frontend/baseStyle";
import {
  CROSS_SECTION_UNAVAILABLE_MESSAGE,
  REPLAY_UNAVAILABLE_MESSAGE,
  LOCAL_UNAVAILABLE_MESSAGE,
  SEARCH_UNAVAILABLE_MESSAGE,
  STATS_UNAVAILABLE_MESSAGE,
  TOUR_UNAVAILABLE_MESSAGE,
  WRAPPED_UNAVAILABLE_MESSAGE,
} from "../../../../flown/frontend/ui/lazyBundles";
import { logError } from "../../../../flown/frontend/utils/logger";
import {
  AttributionControl,
  lastMap,
  mockControl,
  resetMapLibreMock,
  type Map as MockMap,
} from "../../../mocks/maplibre-gl";
import {
  dismissToast,
  showToast,
} from "../../../../flown/frontend/utils/toast";
import {
  loadFeatures,
  loadLocal,
  loadSearch,
  loadWrapped,
  noticeSiteUpdate,
  wasSiteUpdated,
} from "../../../../flown/frontend/services/featureLoader";
import {
  DOUBLE_TAP_MS,
  REPLAY_CAMERA_MOVE,
} from "../../../../flown/frontend/utils/mapHelpers";
import * as motion from "../../../../flown/frontend/utils/motion";
import { segmentOf } from "../../testHelpers";
import type { KMLDataset } from "../../../../flown/frontend/types";

// The instances the mocked manager constructors hand out live in the setup
// module, which is loaded before the mocks are registered
const m = await vi.hoisted(() => import("./mapAppTestSetup"));

vi.mock("../../../../flown/frontend/utils/logger", () => m.modules.logger());
vi.mock("../../../../flown/frontend/utils/domCache", () =>
  m.modules.domCache(),
);
vi.mock("../../../../flown/frontend/utils/toast", () => m.modules.toast());
vi.mock("../../../../flown/frontend/ui/mobileBar", () => m.modules.mobileBar());
vi.mock("../../../../flown/frontend/ui/dataManager", () =>
  m.modules.dataManager(),
);
vi.mock("../../../../flown/frontend/ui/filterManager", () =>
  m.modules.filterManager(),
);
vi.mock("../../../../flown/frontend/ui/airportManager", () =>
  m.modules.airportManager(),
);
vi.mock("../../../../flown/frontend/ui/replayManager", () =>
  m.modules.replayManager(),
);
vi.mock("../../../../flown/frontend/ui/layerManager", () =>
  m.modules.layerManager(),
);
vi.mock("../../../../flown/frontend/ui/stateManager", () =>
  m.modules.stateManager(),
);
vi.mock("../../../../flown/frontend/ui/wrappedManager", () =>
  m.modules.wrappedManager(),
);
vi.mock("../../../../flown/frontend/services/featureLoader", () =>
  m.modules.featureLoader(),
);
vi.mock("../../../../flown/frontend/ui/uiToggles", () => m.modules.uiToggles());
vi.mock("../../../../flown/frontend/ui/pathSelection", () =>
  m.modules.pathSelection(),
);

const {
  createApp,
  fetchBaseStyle,
  initializeApp,
  mockAirportManagerInstance,
  mockLayerManagerInstance,
  mockMap,
  mockPathSelectionInstance,
  mockStateManagerInstance,
  mockStatsManagerInstance,
  resetManagerMocks,
  setupDOM,
  styleResponse,
} = m;

/** What CARTO answers with, cut down: one layer below the labels, one above */
const BASE_STYLE = {
  version: 8,
  sources: { carto: { type: "vector", url: "https://example.test/carto" } },
  layers: [
    { id: "background", type: "background" },
    { id: "water", type: "fill", source: "carto", "source-layer": "water" },
    { id: "place-labels", type: "symbol", source: "carto" },
  ],
};

/**
 * Holds the next call of a lazy bundle's loader until the test delivers it:
 * the bundle the loader answers with, and the function that hands it over
 */
async function holdNextLoad<T>(
  load: () => Promise<T>,
): Promise<{ bundle: T; deliver: () => void }> {
  const bundle = await load();
  let deliver: () => void = () => {};
  vi.mocked(load).mockImplementationOnce(
    () =>
      new Promise<T>((resolve) => {
        deliver = () => resolve(bundle);
      }),
  );
  return { bundle, deliver: () => deliver() };
}

/**
 * The default data with a second flight, of another aircraft: the flights
 * of a selection count where the filter shows them (shownSelection)
 */
/** The numbers from `from` up to `to`, without it */
function range(from: number, to: number): number[] {
  return Array.from({ length: to - from }, (_, i) => from + i);
}

/**
 * The timed flight of the default dataset and the flights `ids` beside it,
 * without times: what the replay counts are the flights the filter shows
 * (shownSelection), of the dataset
 */
function withFlights(ids: number[]): KMLDataset {
  const [first, second] = m.defaultData.path_segments;
  return {
    ...m.defaultData,
    path_segments: [
      ...m.defaultData.path_segments,
      ...ids.flatMap((id) => [
        { ...first!, path_id: id, time: undefined },
        { ...second!, path_id: id, time: undefined },
      ]),
    ],
    path_info: [
      ...m.defaultData.path_info,
      ...ids.map((id) => ({ id, year: 2025, aircraft_registration: "D-ABCD" })),
    ],
  };
}

function twoFlights(): KMLDataset {
  const [first, second] = m.defaultData.path_segments;
  return {
    ...m.defaultData,
    path_segments: [
      first!,
      second!,
      { ...first!, path_id: 2 },
      { ...second!, path_id: 2 },
    ],
    path_info: [
      m.defaultData.path_info[0]!,
      { id: 2, year: 2025, aircraft_registration: "D-EFGH" },
    ],
  };
}

describe("MapApp controls and map", () => {
  let app: MapApp;

  beforeEach(() => {
    resetManagerMocks();
    m.mobileBar.mountFor.mockReturnValue(null);
    setupDOM();
    app = createApp(MapApp);
  });

  afterEach(() => {
    app.destroy();
    document.body.innerHTML = "";
    resetMapLibreMock();
  });

  describe("store-driven buttons", () => {
    // Replay lives in the lazily loaded feature bundle, so the app itself
    // keeps its control showing whether replay is available; it has to say
    // so from the first paint, before anyone has opened replay
    it("dims the replay control until one timed flight is selected", async () => {
      await initializeApp(app);
      const btn = document.getElementById("replay-btn") as HTMLButtonElement;

      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.title).toBe(
        "Pick flights with timing data to replay, under Flights in the statistics",
      );

      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);

      expect(btn.getAttribute("aria-disabled")).toBe("false");
      expect(btn.title).toBe("Replay selected flights");
      // The stylesheet dims it from the attribute
      expect(btn.style.opacity).toBe("");
    });

    it("offers Replay beside the selection while it can replay it", async () => {
      await initializeApp(app);
      const chip = document.getElementById("selection-replay-btn")!;
      expect(chip.hidden).toBe(true);

      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      expect(chip.hidden).toBe(false);

      // It presses the Replay control, which a mode may hold
      const pressed = vi.fn();
      document.getElementById("replay-btn")!.addEventListener("click", pressed);
      chip.click();
      expect(pressed).toHaveBeenCalledTimes(1);

      // Not over a running replay, nor for a flight without times
      app.replayActive = true;
      expect(chip.hidden).toBe(true);
      app.replayActive = false;
      app.hasTimingData = false;
      expect(chip.hidden).toBe(true);
    });

    it("follows the timing data of the loaded metadata", async () => {
      await initializeApp(app);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      const btn = document.getElementById("replay-btn") as HTMLButtonElement;
      expect(btn.getAttribute("aria-disabled")).toBe("false");

      app.hasTimingData = false;

      expect(btn.getAttribute("aria-disabled")).toBe("true");
    });

    it("reflects a selection restored before the first paint", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedPathIds: [1],
      });

      await initializeApp(app);

      const btn = document.getElementById("replay-btn") as HTMLButtonElement;
      expect(btn.getAttribute("aria-disabled")).toBe("false");
    });

    it("reflects the restored visibility state in the toggle buttons", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        heatmapVisible: false,
        altitudeVisible: true,
        airportsVisible: false,
        aviationVisible: true,
      });

      await initializeApp(app);

      const state = (id: string): [string | null, boolean, string] => {
        const el = document.getElementById(id)!;
        return [
          el.getAttribute("aria-pressed"),
          el.classList.contains("active"),
          el.style.opacity,
        ];
      };
      // Off or on, nothing is written into the style: an off toggle is not
      // dimmed, only an unavailable control is, by the stylesheet
      expect(state("heatmap-btn")).toEqual(["false", false, ""]);
      expect(state("altitude-btn")).toEqual(["true", true, ""]);
      expect(state("airports-btn")).toEqual(["false", false, ""]);
      expect(state("aviation-btn")).toEqual(["true", true, ""]);
    });

    it("updates buttons when the store changes after initialization", async () => {
      await initializeApp(app);

      app.heatmapVisible = false;
      app.altitudeVisible = true;

      expect(
        document.getElementById("heatmap-btn")!.getAttribute("aria-pressed"),
      ).toBe("false");
      expect(
        document.getElementById("altitude-btn")!.getAttribute("aria-pressed"),
      ).toBe("true");
    });

    it("leaves the isolate button to the path selection", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        selectedPathIds: [1],
        isolateSelection: true,
      });

      await initializeApp(app);

      // PathSelection subscribes to both keys itself; MapApp writes nothing
      const isolate = document.getElementById("isolate-btn")!;
      expect(isolate.getAttribute("aria-pressed")).toBeNull();
      expect(isolate.style.opacity).toBe("");
    });
  });

  describe("statistics rail", () => {
    it("stays closed while the statistics are hidden", async () => {
      await initializeApp(app);

      expect(document.getElementById("stats-rail")!.hidden).toBe(true);
      expect(document.body.classList.contains("stats-open")).toBe(false);
    });

    it("opens the rail and slides the map aside", async () => {
      await initializeApp(app);

      const column = document.getElementById("left-buttons")!;
      // The column's own layout and its labels, not the per-button state
      // that the Statistics trigger legitimately gains when the rail opens
      const shape = () => ({
        className: column.className,
        labels: [...column.querySelectorAll(".control-label")].map(
          (el) => el.textContent,
        ),
        iconWidths: [...column.querySelectorAll("svg.icon")].map((el) =>
          el.getAttribute("width"),
        ),
      });
      const before = shape();

      app.store.set("statsPanelVisible", true);

      expect(document.getElementById("stats-rail")!.hidden).toBe(false);
      expect(document.body.classList.contains("stats-open")).toBe(true);
      // Resized once, at the end of the slide (see slideMapBesideRail)
      expect(document.body.classList.contains("rail-sliding")).toBe(true);
      // The column is left alone; the stylesheet slides it past the rail
      expect(shape()).toEqual(before);

      app.store.set("statsPanelVisible", false);

      expect(document.getElementById("stats-rail")!.hidden).toBe(true);
      expect(document.body.classList.contains("stats-open")).toBe(false);
      expect(shape()).toEqual(before);
    });

    it("marks both triggers expanded and accents the statistics row", async () => {
      await initializeApp(app);
      const statsBtn = document.getElementById("stats-btn")!;
      const collapseBtn = document.getElementById("stats-collapse-btn")!;

      expect(statsBtn.getAttribute("aria-expanded")).toBe("false");
      expect(statsBtn.classList.contains("active")).toBe(false);

      app.store.set("statsPanelVisible", true);

      expect(statsBtn.getAttribute("aria-expanded")).toBe("true");
      expect(collapseBtn.getAttribute("aria-expanded")).toBe("true");
      expect(statsBtn.classList.contains("active")).toBe(true);

      app.store.set("statsPanelVisible", false);

      expect(statsBtn.getAttribute("aria-expanded")).toBe("false");
      expect(collapseBtn.getAttribute("aria-expanded")).toBe("false");
      expect(statsBtn.classList.contains("active")).toBe(false);
    });

    it("hands focus back to the trigger when the collapse button hides", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      document.getElementById("stats-collapse-btn")!.focus();

      app.store.set("statsPanelVisible", false);

      expect(document.activeElement).toBe(document.getElementById("stats-btn"));
    });

    it("hands focus back from the panel too", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      document.getElementById("stats-panel")!.focus();

      app.store.set("statsPanelVisible", false);

      expect(document.activeElement).toBe(document.getElementById("stats-btn"));
    });

    it("leaves focus alone when it is outside the rail", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      const heatmapBtn = document.getElementById("heatmap-btn")!;
      heatmapBtn.focus();

      app.store.set("statsPanelVisible", false);

      expect(document.activeElement).toBe(heatmapBtn);
    });

    it("closes on Escape where it is a sheet of the phone", async () => {
      await initializeApp(app);
      const escape = (): boolean =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      app.store.set("statsPanelVisible", true);
      // On the desktop the rail has its collapse control, and stays
      expect(escape()).toBe(true);
      expect(app.statsPanelVisible).toBe(true);

      const bar = app.mobileBar;
      app.mobileBar = {
        isVisible: () => true,
        sheetOpen: () => false,
        destroy: () => {},
      } as unknown as MapApp["mobileBar"];
      // Not under Wrapped, whose dialog takes it
      app.store.set("wrappedVisible", true);
      expect(escape()).toBe(true);
      expect(app.statsPanelVisible).toBe(true);
      app.store.set("wrappedVisible", false);

      expect(escape()).toBe(false);
      expect(app.statsPanelVisible).toBe(false);
      app.mobileBar = bar;
    });

    it("leaves Escape to a sheet of the bar open over it", async () => {
      // One press closed the sheet and the statistics under it
      await initializeApp(app);
      const bar = app.mobileBar;
      app.mobileBar = {
        isVisible: () => true,
        sheetOpen: () => true,
        destroy: () => {},
      } as unknown as MapApp["mobileBar"];
      app.store.set("statsPanelVisible", true);

      const escape = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      document.dispatchEvent(escape);

      expect(app.statsPanelVisible).toBe(true);
      expect(escape.defaultPrevented).toBe(false);
      app.mobileBar = bar;
    });

    it("leaves an Escape for a popup, the searches, Your flights or one taken before to them", async () => {
      await initializeApp(app);
      const bar = app.mobileBar;
      app.mobileBar = {
        isVisible: () => true,
        sheetOpen: () => false,
        destroy: () => {},
      } as unknown as MapApp["mobileBar"];
      app.store.set("statsPanelVisible", true);
      const escapeIn = (html: string): void => {
        const holder = document.createElement("div");
        holder.innerHTML = html;
        document.body.append(holder);
        holder.querySelector("[data-target]")!.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
        holder.remove();
      };

      escapeIn(
        '<div class="maplibregl-popup"><button data-target></button></div>',
      );
      escapeIn('<input type="search" data-target>');
      // Your flights and the search over the sheet close first
      escapeIn('<div id="local-flights"><button data-target></button></div>');
      escapeIn('<div id="location-search"><button data-target></button></div>');
      // The readout of the cloud takes its Escape first
      const taken = (event: Event): void => event.preventDefault();
      document.addEventListener("keydown", taken, true);
      escapeIn("<button data-target></button>");
      document.removeEventListener("keydown", taken, true);
      expect(app.statsPanelVisible).toBe(true);

      escapeIn("<button data-target></button>");
      expect(app.statsPanelVisible).toBe(false);

      // On a marker whose popup is closed it is the page's too: a marker
      // that closes its popup prevents it (appInitializer.ts)
      app.store.set("statsPanelVisible", true);
      escapeIn('<div class="maplibregl-marker" data-target></div>');
      expect(app.statsPanelVisible).toBe(false);
      app.mobileBar = bar;
    });

    it("restores an open rail from the saved state", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        statsPanelVisible: true,
      });

      await initializeApp(app);

      expect(document.getElementById("stats-rail")!.hidden).toBe(false);
      expect(document.body.classList.contains("stats-open")).toBe(true);
    });
  });

  describe("the lazily loaded statistics panel", () => {
    const panel = (): HTMLElement => document.getElementById("stats-panel")!;

    /** A Wrapped bundle that arrives when the test says so */
    async function heldBundle(): Promise<() => void> {
      const { deliver } = await holdNextLoad(loadWrapped);
      vi.mocked(loadWrapped).mockClear();
      return deliver;
    }

    it("fetches nothing until the panel opens", async () => {
      await initializeApp(app);

      expect(loadWrapped).not.toHaveBeenCalled();
      expect(app.statsManager).toBeUndefined();
    });

    it("says it is loading until the bundle is in, then starts the manager", async () => {
      await initializeApp(app);
      const deliver = await heldBundle();

      app.store.set("statsPanelVisible", true);

      // The rail opens at once, over a panel that says why it is empty
      expect(document.getElementById("stats-rail")!.hidden).toBe(false);
      expect(panel().querySelector(".stats-loading")!.textContent).toBe(
        "Loading statistics…",
      );
      expect(panel().getAttribute("aria-busy")).toBe("true");
      expect(app.statsManager).toBeUndefined();

      deliver();
      await vi.waitFor(() =>
        expect(app.statsManager).toBe(mockStatsManagerInstance),
      );
      // The manager ends the wait as it renders: it may still be working
      // out the statistics of a large filter (see StatsManager)
      expect(panel().getAttribute("aria-busy")).toBe("true");
      expect(loadWrapped).toHaveBeenCalledTimes(1);
    });

    it("loads it once however often the panel opens", async () => {
      await initializeApp(app);
      const deliver = await heldBundle();

      app.store.set("statsPanelVisible", true);
      app.store.set("statsPanelVisible", false);
      app.store.set("statsPanelVisible", true);
      deliver();
      await vi.waitFor(() => expect(app.statsManager).toBeDefined());
      app.store.set("statsPanelVisible", false);
      app.store.set("statsPanelVisible", true);

      expect(loadWrapped).toHaveBeenCalledTimes(1);
    });

    it("titles the loading panel for the selection it will show", async () => {
      await initializeApp(app);
      await heldBundle();
      const title = document.createElement("h2");
      title.id = "stats-rail-title";
      title.innerHTML = '<span class="stats-title-text">Statistics</span>';
      document.body.appendChild(title);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);

      app.store.set("statsPanelVisible", true);

      expect(title.textContent).toBe("Statistics of the selection");
    });

    it("says so and closes the rail when the bundle cannot be fetched", async () => {
      await initializeApp(app);
      vi.mocked(loadWrapped).mockResolvedValueOnce(null);

      app.store.set("statsPanelVisible", true);

      await vi.waitFor(() =>
        expect(app.store.get("statsPanelVisible")).toBe(false),
      );
      expect(showToast).toHaveBeenCalledWith(
        STATS_UNAVAILABLE_MESSAGE,
        "error",
      );
      expect(document.getElementById("stats-rail")!.hidden).toBe(true);
      expect(panel().childElementCount).toBe(0);
      expect(panel().hasAttribute("aria-busy")).toBe(false);

      // The next opening tries again
      app.store.set("statsPanelVisible", true);
      await vi.waitFor(() =>
        expect(app.statsManager).toBe(mockStatsManagerInstance),
      );
      expect(app.store.get("statsPanelVisible")).toBe(true);
    });

    it("leaves a bundle of a newer deploy to the toast that offers the reload", async () => {
      await initializeApp(app);
      vi.mocked(loadWrapped).mockResolvedValueOnce(null);
      vi.mocked(wasSiteUpdated).mockReturnValueOnce(true);

      expect(await app.loadWrapped()).toBeUndefined();

      // featureLoader said the site was updated; its code did load, and
      // the reload it offered is offered again rather than nothing
      expect(showToast).not.toHaveBeenCalledWith(
        WRAPPED_UNAVAILABLE_MESSAGE,
        "error",
      );
      expect(noticeSiteUpdate).toHaveBeenCalledTimes(1);
    });

    it("takes Wrapped's failure away once the statistics bring the file (regression)", async () => {
      await initializeApp(app);
      vi.mocked(loadWrapped).mockResolvedValueOnce(null);
      expect(await app.loadWrapped()).toBeUndefined();
      vi.mocked(dismissToast).mockClear();

      // The same file, which carries Wrapped as well
      app.store.set("statsPanelVisible", true);
      await vi.waitFor(() =>
        expect(app.statsManager).toBe(mockStatsManagerInstance),
      );

      expect(dismissToast).toHaveBeenCalledWith(WRAPPED_UNAVAILABLE_MESSAGE);
      expect(dismissToast).toHaveBeenCalledWith(STATS_UNAVAILABLE_MESSAGE);
    });

    it("says once that the file failed, for Wrapped and the statistics alike", async () => {
      await initializeApp(app);
      vi.mocked(loadWrapped)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      await app.loadWrapped();
      vi.mocked(dismissToast).mockClear();
      app.store.set("statsPanelVisible", true);
      await vi.waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          STATS_UNAVAILABLE_MESSAGE,
          "error",
        ),
      );

      // The toast of the first failure goes as the second one comes
      expect(dismissToast).toHaveBeenCalledWith(WRAPPED_UNAVAILABLE_MESSAGE);
      expect(dismissToast).not.toHaveBeenCalledWith(STATS_UNAVAILABLE_MESSAGE);
    });

    it("fetches the bundle ahead for a page that opens with the panel", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        statsPanelVisible: true,
      });
      const deliver = await heldBundle();

      // Before the first year has loaded: the rail opens after it
      const started = initializeApp(app);
      expect(loadWrapped).toHaveBeenCalled();
      deliver();
      await started;

      await vi.waitFor(() =>
        expect(app.statsManager).toBe(mockStatsManagerInstance),
      );
    });
  });

  describe("the lazily loaded features", () => {
    it("says so when the bundle cannot be fetched", async () => {
      await initializeApp(app);
      vi.mocked(loadFeatures).mockResolvedValueOnce(null);

      const manager = await app.loadReplay();

      // Not a dead control: a click that loads nothing has to explain itself
      expect(manager).toBeUndefined();
      expect(showToast).toHaveBeenCalledWith(
        REPLAY_UNAVAILABLE_MESSAGE,
        "error",
      );
    });

    it("takes the failure of an earlier try away once the bundle comes", async () => {
      await initializeApp(app);
      vi.mocked(loadFeatures).mockResolvedValueOnce(null);
      await app.loadReplay();
      vi.mocked(dismissToast).mockClear();

      // The error stays until dismissed, and said replay was unavailable
      // over the panel it had just opened
      expect(await app.loadReplay()).toBeDefined();
      expect(dismissToast).toHaveBeenCalledWith(REPLAY_UNAVAILABLE_MESSAGE);
    });

    it("hands both callers the same manager and builds it once", async () => {
      await initializeApp(app);

      const [first, second] = await Promise.all([
        app.loadReplay(),
        app.loadReplay(),
      ]);

      expect(first).toBe(second);
      expect(first).toBeDefined();
    });

    it("opens replay once for quick clicks while the bundle loads", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadFeatures);
      m.mockReplayManagerInstance.toggleReplay.mockClear();

      // Each click used to queue a toggle; two of them opened replay and
      // closed it again as soon as the bundle arrived
      app.toggleReplay();
      app.toggleReplay();
      deliver();
      await vi.waitFor(() => expect(app.replayManager).toBeDefined());
      await Promise.resolve();

      expect(m.mockReplayManagerInstance.toggleReplay).toHaveBeenCalledTimes(1);

      // Once it is there, every click toggles
      app.toggleReplay();
      expect(m.mockReplayManagerInstance.toggleReplay).toHaveBeenCalledTimes(2);
    });

    it.each([["replayActive"], ["wrappedVisible"]] as const)(
      "leaves what opened during the load alone (%s)",
      async (key) => {
        await initializeApp(app);
        const { deliver } = await holdNextLoad(loadFeatures);
        m.mockReplayManagerInstance.toggleReplay.mockClear();

        // Replay all, or Wrapped, opened while the click waited for the
        // bundle: the late toggle closed Replay all, or opened under Wrapped
        app.toggleReplay();
        app[key] = true;
        deliver();
        await vi.waitFor(() => expect(app.replayManager).toBeDefined());
        await Promise.resolve();

        expect(m.mockReplayManagerInstance.toggleReplay).not.toHaveBeenCalled();
      },
    );

    it("says so when the Wrapped bundle cannot be fetched", async () => {
      await initializeApp(app);
      vi.mocked(loadWrapped).mockResolvedValueOnce(null);

      const manager = await app.loadWrapped();

      expect(manager).toBeUndefined();
      expect(showToast).toHaveBeenCalledWith(
        WRAPPED_UNAVAILABLE_MESSAGE,
        "error",
      );
    });

    it("opens Wrapped from its own bundle, not the feature bundle", async () => {
      await initializeApp(app);
      vi.mocked(loadFeatures).mockClear();

      expect(await app.loadWrapped()).toBeDefined();

      expect(loadWrapped).toHaveBeenCalled();
      expect(loadFeatures).not.toHaveBeenCalled();
    });

    it("keeps the manager once it has been built", async () => {
      await initializeApp(app);
      const first = await app.loadWrapped();

      vi.mocked(loadWrapped).mockClear();
      const second = await app.loadWrapped();

      expect(second).toBe(first);
      expect(loadWrapped).not.toHaveBeenCalled();
    });
  });

  describe("replay availability", () => {
    function replayButton(): HTMLButtonElement {
      return document.getElementById("replay-btn") as HTMLButtonElement;
    }

    it("is not offered for a flight whose times are all 0", async () => {
      await initializeApp(app, m.defaultAirports, m.defaultMetadata, {
        ...m.defaultData,
        path_segments: [segmentOf({ path_id: 1, altitude_ft: 5000, time: 0 })],
      });

      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);

      // It would finish the moment it started, with nothing drawn
      expect(app.canReplay()).toBe(false);
      expect(replayButton().getAttribute("aria-disabled")).toBe("true");
    });

    it("is not offered for a flight with one time for every point", async () => {
      await initializeApp(app, m.defaultAirports, m.defaultMetadata, {
        ...m.defaultData,
        path_segments: [
          segmentOf({ path_id: 1, altitude_ft: 5000, time: 600 }),
          segmentOf({ path_id: 1, altitude_ft: 5100, time: 600 }),
        ],
      });

      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);

      expect(app.canReplay()).toBe(false);
    });

    it("plays up to a day of flights, and says why not more", async () => {
      // One timed flight and nine without times, of the dataset: the
      // flights the filter shows are the ones counted (shownSelection)
      await initializeApp(
        app,
        m.defaultAirports,
        m.defaultMetadata,
        withFlights([...range(100, 108), 200]),
      );
      const chip = document.getElementById("selection-replay-btn")!;
      // One timed flight among eight
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      for (let id = 100; app.selectedPathIds.size < DAY_MAX_FLIGHTS; id++) {
        app.selectedPathIds = new Set([...app.selectedPathIds, id]);
      }
      expect(app.canReplay()).toBe(true);
      expect(app.replayHint()).toBeNull();

      // All of a home airport's, say: Replay all is the one for those
      app.selectedPathIds = new Set([...app.selectedPathIds, 200]);
      expect(app.canReplay()).toBe(false);
      expect(app.replayHint()).toBe(REPLAY_TOO_MANY_MESSAGE);
      expect(replayButton().getAttribute("aria-disabled")).toBe("true");
      expect(replayButton().title).toBe(
        "Select up to 8 flights to replay them one after another; Replay all plays more",
      );
      expect(chip.hidden).toBe(true);
    });

    it("says first that no flight has times, which fewer would not mend", async () => {
      await initializeApp(
        app,
        m.defaultAirports,
        m.defaultMetadata,
        withFlights(range(100, 109)),
      );
      for (let id = 100; app.selectedPathIds.size <= DAY_MAX_FLIGHTS; id++) {
        app.selectedPathIds = new Set([...app.selectedPathIds, id]);
      }

      expect(app.replayHint()).toBe(REPLAY_PRECONDITION_MESSAGE);
      expect(replayButton().title).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("counts and plays the selected flights the filter shows", async () => {
      await initializeApp(
        app,
        m.defaultAirports,
        m.defaultMetadata,
        twoFlights(),
      );
      // Share mode keeps the flights a filter hides
      app.store.batch(() => {
        app.selectedPathIds = new Set([...app.selectedPathIds, 1, 2]);
        app.isolateSelection = true;
      });
      expect(app.canReplay()).toBe(true);

      // One shown: the replay of that flight
      app.selectedAircraft = "D-ABCD";
      expect(app.canReplay()).toBe(true);
      expect(replayButton().getAttribute("aria-disabled")).toBe("false");

      // None shown: no flight the map does not draw is replayed
      app.store.batch(() => {
        app.selectedPathIds = new Set(
          [...app.selectedPathIds].filter((id) => id !== 1),
        );
      });
      expect(app.canReplay()).toBe(false);
      expect(replayButton().getAttribute("aria-disabled")).toBe("true");
      // Said as the chip says it, not as if none were picked
      expect(app.replayHint()).toBe(REPLAY_HIDDEN_MESSAGE);
      expect(replayButton().title).toBe(REPLAY_HIDDEN_MESSAGE);
    });

    it("leaves the button to a running replay", async () => {
      await initializeApp(app);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      replayButton().title = "Replay running";
      app.replayActive = true;

      app.selectedPathIds = new Set();

      expect(replayButton().getAttribute("aria-disabled")).toBe("false");
      expect(replayButton().title).toBe("Replay running");
    });

    it("takes the button back in step as the replay closes", async () => {
      await initializeApp(app);
      app.replayActive = true;
      app.selectedPathIds = new Set();
      replayButton().setAttribute("aria-disabled", "false");

      app.replayActive = false;

      expect(replayButton().getAttribute("aria-disabled")).toBe("true");
    });
  });

  describe("the flight profile", () => {
    /** Select `ids` alone, and let the bundle arrive */
    async function select(...ids: number[]): Promise<void> {
      app.selectedPathIds = new Set(ids);
      await Promise.resolve();
      await Promise.resolve();
    }

    /** The bundle the next load hands over */
    async function nextBundle(): Promise<
      NonNullable<Awaited<ReturnType<typeof loadFeatures>>>
    > {
      const bundle = (await loadFeatures())!;
      vi.mocked(loadFeatures).mockClear();
      vi.mocked(loadFeatures).mockResolvedValueOnce(bundle);
      return bundle;
    }

    it("fetches the feature bundle as up to eight flights are first selected", async () => {
      await initializeApp(
        app,
        m.defaultAirports,
        m.defaultMetadata,
        withFlights(range(2, 10)),
      );
      const bundle = await nextBundle();

      // More than the profile draws
      await select(1, 2, 3, 4, 5, 6, 7, 8, 9);
      expect(loadFeatures).not.toHaveBeenCalled();

      await select(1, 2);
      await vi.waitFor(() =>
        expect(bundle.followFlightProfile).toHaveBeenCalledWith(app),
      );

      // Once is enough: the profile follows the selection from then on
      vi.mocked(loadFeatures).mockClear();
      await select(2);
      expect(loadFeatures).not.toHaveBeenCalled();
    });

    it("tries again with the next single selection after a failure", async () => {
      await initializeApp(
        app,
        m.defaultAirports,
        m.defaultMetadata,
        twoFlights(),
      );
      const bundle = (await loadFeatures())!;
      vi.mocked(loadFeatures).mockClear();
      vi.mocked(loadFeatures)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(bundle);

      await select(1);
      await vi.waitFor(() => expect(loadFeatures).toHaveBeenCalledOnce());
      await select(2);

      await vi.waitFor(() =>
        expect(bundle.followFlightProfile).toHaveBeenCalledWith(app),
      );
    });

    it("tries again as a replay opens after a failure", async () => {
      await initializeApp(app);
      const bundle = (await loadFeatures())!;
      vi.mocked(loadFeatures).mockClear();
      vi.mocked(loadFeatures)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(bundle);

      await select(1);
      await vi.waitFor(() => expect(loadFeatures).toHaveBeenCalledOnce());
      // Replay fetched the bundle for itself
      app.replayActive = true;

      await vi.waitFor(() =>
        expect(bundle.followFlightProfile).toHaveBeenCalledWith(app),
      );
    });

    it("asks once while the bundle is on its way", async () => {
      await initializeApp(app);
      const { bundle, deliver } = await holdNextLoad(loadFeatures);
      vi.mocked(loadFeatures).mockClear();

      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      app.destroy();
      deliver();
      await Promise.resolve();
      await Promise.resolve();

      expect(loadFeatures).toHaveBeenCalledOnce();
      // Torn down meanwhile: nothing is left to draw it for
      expect(bundle!.followFlightProfile).not.toHaveBeenCalled();
    });
  });

  describe("destroy", () => {
    it("takes down the listeners it set up", async () => {
      await initializeApp(app);
      const map = mockMap(app);
      const statsListener = vi.fn();
      app.store.subscribe("statsPanelVisible", statsListener);
      const signal = app.signal;
      // `moveend` is listened to three times: the save, the label declutter
      // of MapOrientation, which also follows every turn and tilt, and
      // Reset view, which is unavailable at the start view. `zoomend` twice:
      // the airport markers' sizes and the band of the aviation chart,
      // which the heat dims for
      const types = ["moveend", "zoomend", "click", "error", "rotate", "pitch"];
      const listened: Record<string, number> = { moveend: 3, zoomend: 2 };
      for (const type of types) {
        expect(map.listenerCount(type)).toBe(listened[type] ?? 1);
      }

      app.destroy();

      expect(signal.aborted).toBe(true);
      for (const type of types) {
        expect(map.listenerCount(type)).toBe(0);
      }
      expect(mockStateManagerInstance.cancelSave).toHaveBeenCalled();
      expect(m.mockDataManagerInstance.destroy).toHaveBeenCalled();
      app.store.set("statsPanelVisible", true);
      expect(statsListener).not.toHaveBeenCalled();
      // The map itself stays as it is
      expect(map.remove).not.toHaveBeenCalled();
    });

    it("loads nothing once destroyed while the style was on its way", async () => {
      mockControl.autoLoadStyle = false;
      const pending = initializeApp(app);
      await Promise.resolve();

      app.destroy();
      mockMap(app).finishStyleLoad();
      await pending;

      expect(m.mockDataManagerInstance.loadAirports).not.toHaveBeenCalled();
    });

    it("stops the statistics panel's manager", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      await vi.waitFor(() =>
        expect(app.statsManager).toBe(mockStatsManagerInstance),
      );
      mockStatsManagerInstance.destroy.mockClear();

      app.destroy();

      expect(mockStatsManagerInstance.destroy).toHaveBeenCalledTimes(1);
    });

    it("builds no Wrapped manager once destroyed while its bundle loaded", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadWrapped);

      const loading = app.loadWrapped();
      app.destroy();
      deliver();

      expect(await loading).toBeUndefined();
      expect(app.wrappedManager).toBeUndefined();
    });

    it("builds no replay manager once destroyed while its bundle loaded", async () => {
      await initializeApp(app);
      let deliver: () => void = () => {};
      const bundle = await loadFeatures();
      vi.mocked(loadFeatures).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            deliver = () => resolve(bundle);
          }),
      );

      const loading = app.loadReplay();
      app.destroy();
      deliver();

      expect(await loading).toBeUndefined();
      expect(app.replayManager).toBeUndefined();
    });

    it("drops a Replay click still waiting for the bundle", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadFeatures);
      m.mockReplayManagerInstance.toggleReplay.mockClear();

      app.toggleReplay();
      app.destroy();
      deliver();
      // The click is let go of once its load has settled
      const pending = app as unknown as { pendingReplayToggle: unknown };
      await vi.waitFor(() => expect(pending.pendingReplayToggle).toBeNull());

      expect(m.mockReplayManagerInstance.toggleReplay).not.toHaveBeenCalled();
      expect(app.replayManager).toBeUndefined();
    });

    it("plays several selected flights in the replay manager", async () => {
      await initializeApp(
        app,
        m.defaultAirports,
        m.defaultMetadata,
        withFlights([100]),
      );
      m.mockReplayManagerInstance.toggleReplay.mockClear();
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      app.selectedPathIds = new Set([...app.selectedPathIds, 100]);

      app.toggleReplay();

      await vi.waitFor(() =>
        expect(m.mockReplayManagerInstance.toggleReplay).toHaveBeenCalledOnce(),
      );

      // Not while the replay of every flight holds the control
      m.mockReplayManagerInstance.toggleReplay.mockClear();
      app.replayState.all = true;
      app.replayActive = true;
      app.toggleReplay();
      expect(m.mockReplayManagerInstance.toggleReplay).not.toHaveBeenCalled();
    });

    it("plays a flight selected while the bundle loads with the one before", async () => {
      await initializeApp(
        app,
        m.defaultAirports,
        m.defaultMetadata,
        withFlights([100]),
      );
      const { deliver } = await holdNextLoad(loadFeatures);
      m.mockReplayManagerInstance.toggleReplay.mockClear();
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);

      app.toggleReplay();
      // A second one picked before the bundle came: the manager decides
      // once it is there, and plays both
      app.selectedPathIds = new Set([...app.selectedPathIds, 100]);
      deliver();

      await vi.waitFor(() =>
        expect(m.mockReplayManagerInstance.toggleReplay).toHaveBeenCalledOnce(),
      );
    });

    it("opens Replay all once for quick clicks while the bundle loads", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadFeatures);
      m.toggleReplayAll.mockClear();

      app.toggleReplayAll();
      app.toggleReplayAll();
      deliver();

      await vi.waitFor(() =>
        expect(m.toggleReplayAll).toHaveBeenCalledWith(app),
      );
      await Promise.resolve();
      expect(m.toggleReplayAll).toHaveBeenCalledTimes(1);
    });

    it("opens the cross-section once for quick clicks while the bundle loads", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadFeatures);
      m.toggleCrossSection.mockClear();

      app.toggleCrossSection();
      app.toggleCrossSection();
      deliver();

      await vi.waitFor(() =>
        expect(m.toggleCrossSection).toHaveBeenCalledWith(app),
      );
      await Promise.resolve();
      expect(m.toggleCrossSection).toHaveBeenCalledTimes(1);
    });

    it("opens the cross-section on the line of a link once the flights are in", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        crossSectionLine: "51.5,12.1,51.6,12.3",
      });
      m.toggleCrossSection.mockClear();

      await initializeApp(app);

      expect(app.crossSectionLine).toBe("51.5,12.1,51.6,12.3");
      await vi.waitFor(() =>
        expect(m.toggleCrossSection).toHaveBeenCalledWith(app),
      );
    });

    it("leaves the cross-section of a link closed once a reset let go of its line", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        crossSectionLine: "51.5,12.1,51.6,12.3",
      });
      m.toggleCrossSection.mockClear();
      const { deliver } = await holdNextLoad(loadFeatures);

      await initializeApp(app);
      // What Reset view does to a line whose tool has not opened
      app.crossSectionLine = "";
      deliver();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(m.toggleCrossSection).not.toHaveBeenCalled();
    });

    it("leaves the cross-section of a link closed over a load that failed", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        crossSectionLine: "51.5,12.1,51.6,12.3",
      });
      m.toggleCrossSection.mockClear();

      await initializeApp(app, m.defaultAirports, m.defaultMetadata, null);
      await Promise.resolve();

      expect(m.toggleCrossSection).not.toHaveBeenCalled();
      // Nor do the saves and Copy link hand the line on
      expect(app.crossSectionLine).toBe("");
    });

    it("leaves the cross-section closed without a line", async () => {
      m.toggleCrossSection.mockClear();

      await initializeApp(app);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(m.toggleCrossSection).not.toHaveBeenCalled();
    });

    it("drops a Cross-section click the app went before", async () => {
      await initializeApp(app);
      m.toggleCrossSection.mockClear();

      app.toggleCrossSection();
      app.destroy();
      await vi.waitFor(() => expect(loadFeatures).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(m.toggleCrossSection).not.toHaveBeenCalled();
    });

    it("says so when the cross-section cannot fetch the bundle", async () => {
      await initializeApp(app);
      vi.mocked(loadFeatures).mockResolvedValueOnce(null);

      app.toggleCrossSection();

      await vi.waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          CROSS_SECTION_UNAVAILABLE_MESSAGE,
          "error",
        ),
      );
    });

    it("drops a Replay all click still waiting for the bundle", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadFeatures);
      m.toggleReplayAll.mockClear();

      app.toggleReplayAll();
      app.destroy();
      deliver();
      await vi.waitFor(() => expect(loadFeatures).toHaveBeenCalled());
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(m.toggleReplayAll).not.toHaveBeenCalled();
    });

    it("says so when Replay all cannot fetch the bundle", async () => {
      await initializeApp(app);
      vi.mocked(loadFeatures).mockResolvedValueOnce(null);

      app.toggleReplayAll();

      await vi.waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          REPLAY_UNAVAILABLE_MESSAGE,
          "error",
        ),
      );
    });

    it("starts the hotspot tour once for quick clicks, apart from Replay all", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadFeatures);
      m.toggleHotspotTour.mockClear();
      m.toggleReplayAll.mockClear();

      app.toggleHotspotTour();
      app.toggleHotspotTour();
      deliver();

      await vi.waitFor(() =>
        expect(m.toggleHotspotTour).toHaveBeenCalledWith(app),
      );
      await Promise.resolve();
      expect(m.toggleHotspotTour).toHaveBeenCalledTimes(1);
      expect(m.toggleReplayAll).not.toHaveBeenCalled();

      // Waits for nothing once the bundle is in
      app.toggleHotspotTour();
      await vi.waitFor(() =>
        expect(m.toggleHotspotTour).toHaveBeenCalledTimes(2),
      );
    });

    it("says so when the hotspot tour cannot fetch the bundle", async () => {
      await initializeApp(app);
      vi.mocked(loadFeatures).mockResolvedValueOnce(null);

      app.toggleHotspotTour();

      await vi.waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          TOUR_UNAVAILABLE_MESSAGE,
          "error",
        ),
      );
    });

    it("logs a hotspot tour that fails to start, and takes the next click", async () => {
      await initializeApp(app);
      m.toggleHotspotTour.mockClear();
      m.toggleHotspotTour.mockImplementationOnce(() => {
        throw new Error("no map");
      });

      app.toggleHotspotTour();
      await vi.waitFor(() => expect(logError).toHaveBeenCalled());

      app.toggleHotspotTour();
      await vi.waitFor(() =>
        expect(m.toggleHotspotTour).toHaveBeenCalledTimes(2),
      );
    });
  });

  describe("Your flights", () => {
    it("opens from its own bundle, once for quick presses", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadLocal);
      vi.mocked(loadFeatures).mockClear();

      app.toggleLocalFlights();
      app.toggleLocalFlights();
      deliver();

      await vi.waitFor(() =>
        expect(m.toggleLocalFlights).toHaveBeenCalledWith(app, undefined),
      );
      await Promise.resolve();
      expect(m.toggleLocalFlights).toHaveBeenCalledTimes(1);
      expect(loadFeatures).not.toHaveBeenCalled();

      app.toggleLocalFlights();
      await vi.waitFor(() =>
        expect(m.toggleLocalFlights).toHaveBeenCalledTimes(2),
      );
    });

    it("does not open while the map is held, unless files were dropped", async () => {
      await initializeApp(app);
      app.replayActive = true;

      app.toggleLocalFlights();
      await Promise.resolve();
      expect(loadLocal).not.toHaveBeenCalled();

      const dropped = [new File(["x"], "a.kml")];
      app.toggleLocalFlights(dropped);
      await vi.waitFor(() =>
        expect(m.toggleLocalFlights).toHaveBeenCalledWith(app, dropped),
      );
      // The queue is a copy, so the caller's list is left alone
      expect(dropped).toHaveLength(1);
    });

    it("hands the files of every drop while its bundle is on its way over together", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadLocal);
      const first = new File(["x"], "a.kml");
      const second = new File(["y"], "b.kml");

      app.toggleLocalFlights([first]);
      app.toggleLocalFlights([second]);
      deliver();

      await vi.waitFor(() =>
        expect(m.toggleLocalFlights).toHaveBeenCalledWith(app, [first, second]),
      );
      await Promise.resolve();
      expect(m.toggleLocalFlights).toHaveBeenCalledTimes(1);

      // Delivered, the queue is empty: a press opens the panel plain
      app.toggleLocalFlights();
      await vi.waitFor(() =>
        expect(m.toggleLocalFlights).toHaveBeenLastCalledWith(app, undefined),
      );
    });

    it("delivers a drop queued behind a press", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadLocal);
      const dropped = new File(["x"], "a.kml");

      app.toggleLocalFlights();
      app.toggleLocalFlights([dropped]);
      deliver();

      await vi.waitFor(() =>
        expect(m.toggleLocalFlights).toHaveBeenCalledWith(app, [dropped]),
      );
      await Promise.resolve();
      expect(m.toggleLocalFlights).toHaveBeenCalledTimes(1);
    });

    it("says so when its bundle cannot be fetched", async () => {
      await initializeApp(app);
      vi.mocked(loadLocal).mockResolvedValueOnce(null);

      app.toggleLocalFlights();

      await vi.waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          LOCAL_UNAVAILABLE_MESSAGE,
          "error",
        ),
      );
    });

    it("forgets the files of a drop whose bundle did not come", async () => {
      await initializeApp(app);
      vi.mocked(loadLocal).mockResolvedValueOnce(null);

      app.toggleLocalFlights([new File(["x"], "a.kml")]);
      await vi.waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          LOCAL_UNAVAILABLE_MESSAGE,
          "error",
        ),
      );

      // A later press opens the panel plain: the visitor drops again
      app.toggleLocalFlights();
      await vi.waitFor(() =>
        expect(m.toggleLocalFlights).toHaveBeenCalledWith(app, undefined),
      );
      expect(m.toggleLocalFlights).toHaveBeenCalledTimes(1);
    });
  });

  describe("the search", () => {
    it("opens from its own bundle, once for quick presses", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadSearch);
      vi.mocked(loadFeatures).mockClear();

      app.toggleSearch();
      app.toggleSearch();
      deliver();

      await vi.waitFor(() =>
        expect(m.toggleSearch).toHaveBeenCalledWith(app, false, ""),
      );
      await Promise.resolve();
      expect(m.toggleSearch).toHaveBeenCalledTimes(1);
      expect(loadFeatures).not.toHaveBeenCalled();

      app.toggleSearch();
      await vi.waitFor(() => expect(m.toggleSearch).toHaveBeenCalledTimes(2));
    });

    it("hands it what was typed while its bundle came, and the keys after to the page", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadSearch);
      const type = (key: string, init: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...init,
        });
        document.body.dispatchEvent(event);
        return event;
      };

      // The map zooms by "+" and "-" on its canvas
      const reached = vi.fn();
      document.body.addEventListener("keydown", reached);

      app.toggleSearch(true);
      expect(type("W").defaultPrevented).toBe(true);
      expect(type("-").defaultPrevented).toBe(true);
      expect(reached).not.toHaveBeenCalled();
      // A press dropped while the bundle comes keeps no keys of its own
      app.toggleSearch(true);
      type("a");
      // A second "/" is the shortcut's, which drops it, not text
      type("/");
      // Not text: the browser's, or the page's
      expect(type("Shift").defaultPrevented).toBe(false);
      expect(type("c", { ctrlKey: true }).defaultPrevented).toBe(false);
      deliver();

      await vi.waitFor(() =>
        expect(m.toggleSearch).toHaveBeenCalledWith(app, true, "W-a"),
      );
      expect(m.toggleSearch).toHaveBeenCalledTimes(1);
      expect(type("n").defaultPrevented).toBe(false);
      // "/", Shift, Ctrl+C and the key after
      expect(reached).toHaveBeenCalledTimes(4);
      document.body.removeEventListener("keydown", reached);
    });

    it("leaves the keys of a field gone to while its bundle comes to that field", async () => {
      await initializeApp(app);
      const { deliver } = await holdNextLoad(loadSearch);
      const fields = [
        Object.assign(document.createElement("input"), { type: "search" }),
        document.createElement("textarea"),
        document.createElement("select"),
        document.createElement("div"),
      ];
      fields[3]?.setAttribute("contenteditable", "");
      // A box to tick takes no text: its keys still go to the search
      const box = Object.assign(document.createElement("input"), {
        type: "checkbox",
      });
      document.body.append(...fields, box);
      const type = (target: Element, key: string) => {
        const event = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
        });
        target.dispatchEvent(event);
        return event;
      };
      const reached = vi.fn();
      document.body.addEventListener("keydown", reached);

      app.toggleSearch(true);
      for (const field of fields) {
        expect(type(field, "x").defaultPrevented).toBe(false);
      }
      expect(reached).toHaveBeenCalledTimes(fields.length);
      expect(type(box, "W").defaultPrevented).toBe(true);
      deliver();

      await vi.waitFor(() =>
        expect(m.toggleSearch).toHaveBeenCalledWith(app, true, "W"),
      );
      document.body.removeEventListener("keydown", reached);
      for (const element of [...fields, box]) element.remove();
    });

    it.each([["replayActive"], ["wrappedVisible"]] as const)(
      "does not open while the map is held (%s)",
      async (key) => {
        await initializeApp(app);
        app[key] = true;

        app.toggleSearch();
        await Promise.resolve();

        expect(loadSearch).not.toHaveBeenCalled();
      },
    );

    it("does not open while the hotspot tour holds the map", async () => {
      await initializeApp(app);
      app.tourView = {
        center: { lat: 50, lng: 8 },
        zoom: 9,
        bearing: 0,
        pitch: 0,
        heatmapVisible: true,
      } as NonNullable<MapApp["tourView"]>;

      app.toggleSearch();

      expect(loadSearch).not.toHaveBeenCalled();
    });

    it("says so when its bundle cannot be fetched", async () => {
      await initializeApp(app);
      vi.mocked(loadSearch).mockResolvedValueOnce(null);

      app.toggleSearch();

      await vi.waitFor(() =>
        expect(showToast).toHaveBeenCalledWith(
          SEARCH_UNAVAILABLE_MESSAGE,
          "error",
        ),
      );
    });

    it("logs a search that fails to open, and takes the next press", async () => {
      await initializeApp(app);
      m.toggleSearch.mockImplementationOnce(() => {
        throw new Error("no panel");
      });

      app.toggleSearch();
      await vi.waitFor(() => expect(logError).toHaveBeenCalled());

      app.toggleSearch();
      await vi.waitFor(() => expect(m.toggleSearch).toHaveBeenCalledTimes(2));
    });

    describe("the / key", () => {
      function press(
        target: EventTarget = document.body,
        init: KeyboardEventInit = {},
      ): KeyboardEvent {
        const event = new KeyboardEvent("keydown", {
          key: "/",
          bubbles: true,
          cancelable: true,
          ...init,
        });
        target.dispatchEvent(event);
        return event;
      }

      it("opens the search, and keeps the key from the browser", async () => {
        await initializeApp(app);

        const event = press();

        expect(event.defaultPrevented).toBe(true);
        await vi.waitFor(() =>
          // To open it, or go back to its field: not to close it
          expect(m.toggleSearch).toHaveBeenCalledWith(app, true, ""),
        );
      });

      it("is left to a field that takes text, and to the browser with a modifier", async () => {
        await initializeApp(app);
        const field = document.createElement("input");
        document.body.append(field);

        expect(press(field).defaultPrevented).toBe(false);
        expect(press(document.body, { ctrlKey: true }).defaultPrevented).toBe(
          false,
        );
        expect(press(document.body, { key: "?" }).defaultPrevented).toBe(false);
        await Promise.resolve();

        expect(loadSearch).not.toHaveBeenCalled();
        field.remove();
      });

      it.each(["checkbox", "range"])(
        "opens the search from a %s, which takes no text",
        async (type) => {
          // A slider kept the key for itself here while the page's Escape
          // worked on it (FIELDS): the two agree now
          await initializeApp(app);
          const box = document.createElement("input");
          box.type = type;
          document.body.append(box);

          expect(press(box).defaultPrevented).toBe(true);
          await vi.waitFor(() =>
            expect(m.toggleSearch).toHaveBeenCalledWith(app, true, ""),
          );
          box.remove();
        },
      );

      it("is left to a text area, a select and an editable element", async () => {
        await initializeApp(app);
        const editable = document.createElement("div");
        editable.setAttribute("contenteditable", "true");
        const fields = [
          document.createElement("textarea"),
          document.createElement("select"),
          editable,
        ];
        document.body.append(...fields);

        for (const field of fields) {
          expect(press(field).defaultPrevented).toBe(false);
        }
        await Promise.resolve();
        expect(loadSearch).not.toHaveBeenCalled();
        for (const field of fields) field.remove();
      });

      it("is left to the browser while the map is held", async () => {
        await initializeApp(app);
        app.replayActive = true;

        expect(press().defaultPrevented).toBe(false);
        await Promise.resolve();
        expect(loadSearch).not.toHaveBeenCalled();
      });

      it("is left alone while a modal sheet or dialog is open", async () => {
        await initializeApp(app);
        const sheet = document.createElement("div");
        sheet.setAttribute("aria-modal", "true");
        document.body.append(sheet);

        expect(press().defaultPrevented).toBe(false);
        await Promise.resolve();
        expect(loadSearch).not.toHaveBeenCalled();

        // Closed, it holds the key no longer
        sheet.hidden = true;
        expect(press().defaultPrevented).toBe(true);
        sheet.remove();
      });

      it("is not taken twice", async () => {
        await initializeApp(app);
        document.body.addEventListener(
          "keydown",
          (event) => event.preventDefault(),
          { once: true, capture: true },
        );

        press();

        expect(loadSearch).not.toHaveBeenCalled();
      });
    });
  });

  describe("map event handlers", () => {
    const click = {
      point: { x: 10, y: 20 },
      lngLat: { lng: 8.5, lat: 50.5 },
      originalEvent: { detail: 1, timeStamp: 0 },
    };

    it("schedules a state save on move and zoom", async () => {
      await initializeApp(app);

      mockMap(app).emit("moveend");
      mockMap(app).emit("zoomend");

      expect(mockStateManagerInstance.scheduleSave).toHaveBeenCalledTimes(2);
      expect(
        mockAirportManagerInstance.updateAirportMarkerSizes,
      ).toHaveBeenCalledTimes(2);
    });

    it("leaves the frames of the replay's camera to its own rest", async () => {
      await initializeApp(app);
      const sizes = mockAirportManagerInstance.updateAirportMarkerSizes;
      sizes.mockClear();

      mockMap(app).emit("moveend", REPLAY_CAMERA_MOVE);
      mockMap(app).emit("zoomend", REPLAY_CAMERA_MOVE);

      expect(mockStateManagerInstance.scheduleSave).not.toHaveBeenCalled();
      expect(sizes).not.toHaveBeenCalled();
    });

    it("says what happens to the WebGL context, for as long as the app lives", async () => {
      await initializeApp(app);
      const canvas = mockMap(app).getCanvas();

      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
      canvas.dispatchEvent(new Event("webglcontextrestored"));
      expect(showToast).toHaveBeenCalledTimes(2);

      app.destroy();
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
      canvas.dispatchEvent(new Event("webglcontextrestored"));
      expect(showToast).toHaveBeenCalledTimes(2);
    });

    it("has the skip link take the keyboard to the map's canvas", async () => {
      const skip = document.createElement("a");
      skip.className = "skip-nav";
      skip.href = "#map";
      document.body.prepend(skip);
      await initializeApp(app);
      const canvas = mockMap(app).getCanvas();
      canvas.tabIndex = 0;
      document.body.append(canvas);

      const event = new MouseEvent("click", { cancelable: true });
      skip.dispatchEvent(event);

      // Its own jump landed on the container, where the arrow keys do
      // nothing, and left #map in the history (regression)
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(canvas);
      skip.remove();
      canvas.remove();
    });

    it("keeps the selection on a click beside every flight, in a colour layer and in share mode", async () => {
      // A click that missed a flight by a few pixels, or one that read the
      // heat cloud, threw away the flights someone had put together, and
      // ended share mode with them
      await initializeApp(app);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      app.altitudeVisible = true;

      mockMap(app).emit("click", click);

      expect(mockLayerManagerInstance.hitTest).toHaveBeenCalledWith(
        click.point,
      );
      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
      expect(mockLayerManagerInstance.closeSegmentPopup).toHaveBeenCalledOnce();

      app.altitudeVisible = false;
      app.airspeedVisible = true;
      app.isolateSelection = true;
      mockMap(app).emit("click", click);
      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
      expect(app.isolateSelection).toBe(true);
      expect(mockAirportManagerInstance.closePopup).toHaveBeenCalledTimes(2);
    });

    it("keeps the selection on a click over the heat alone, where no flight can be clicked", async () => {
      await initializeApp(app);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);

      mockMap(app).emit("click", click);

      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
      // What a click on the map closes, it still closes
      expect(mockAirportManagerInstance.closePopup).toHaveBeenCalledOnce();
      expect(mockLayerManagerInstance.closeSegmentPopup).toHaveBeenCalledOnce();
    });

    it("leaves a click on an airport's code to its marker, as on the dot", async () => {
      await initializeApp(app);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      // The code is a part of the marker's button (ui/airportLabels.ts)
      const marker = document.createElement("button");
      marker.className = "maplibregl-marker";
      const code = document.createElement("span");
      code.className = "airport-code";
      marker.append(code);

      mockMap(app).emit("click", {
        ...click,
        originalEvent: { target: code, detail: 1, timeStamp: 1000 },
      });

      // The marker's own listener acts on it; the map does nothing
      expect(mockAirportManagerInstance.activateAirport).not.toHaveBeenCalled();
      expect(mockLayerManagerInstance.hitTest).not.toHaveBeenCalled();
      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
      expect(mockAirportManagerInstance.closePopup).not.toHaveBeenCalled();
    });

    it("closes the popups, none of which closes on a click by itself", async () => {
      await initializeApp(app);

      mockMap(app).emit("click", click);

      // The airport's, and the values a tap left on a flight
      expect(mockAirportManagerInstance.closePopup).toHaveBeenCalledTimes(1);
      expect(mockLayerManagerInstance.closeSegmentPopup).toHaveBeenCalledTimes(
        1,
      );
    });

    it("leaves the popup of an airport a double tap carried off its marker", async () => {
      await initializeApp(app);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      app.altitudeVisible = true;
      const marker = document.createElement("div");
      marker.className = "maplibregl-marker";
      mockMap(app).emit("click", {
        ...click,
        originalEvent: { target: marker, detail: 1, timeStamp: 1000 },
      });

      // The second tap, on the map the popup's pan moved under it
      mockMap(app).emit("click", {
        ...click,
        originalEvent: { detail: 1, timeStamp: 1000 + DOUBLE_TAP_MS - 1 },
      });
      expect(mockAirportManagerInstance.closePopup).not.toHaveBeenCalled();
      expect(mockLayerManagerInstance.closeSegmentPopup).not.toHaveBeenCalled();

      // A tap of its own
      mockMap(app).emit("click", {
        ...click,
        originalEvent: { detail: 1, timeStamp: 1000 + DOUBLE_TAP_MS },
      });
      expect(mockAirportManagerInstance.closePopup).toHaveBeenCalledOnce();
      expect(mockLayerManagerInstance.closeSegmentPopup).toHaveBeenCalledOnce();
    });

    it("does not clear an empty selection", async () => {
      await initializeApp(app);

      mockMap(app).emit("click", click);

      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
    });

    it("hands a click on a flight to the layer manager instead of clearing", async () => {
      await initializeApp(app);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      const hit = { pathId: 2, segment: { path_id: 2 } };
      mockLayerManagerInstance.hitTest.mockReturnValue(hit);

      mockMap(app).emit("click", {
        ...click,
        originalEvent: { ...click.originalEvent, pointerType: "mouse" },
      });

      expect(mockLayerManagerInstance.onPathClick).toHaveBeenCalledWith(
        hit,
        click.lngLat,
        false,
      );
      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
    });

    it("tells the layer manager a finger's click from a mouse's by the click", async () => {
      await initializeApp(app);
      const hit = { pathId: 2, segment: { path_id: 2 } };
      mockLayerManagerInstance.hitTest.mockReturnValue(hit);
      // A touch laptop: a device that can touch, and a mouse beside it
      (window as { ontouchstart?: unknown }).ontouchstart = null;
      const tap = (pointerType?: string) =>
        mockMap(app).emit("click", {
          ...click,
          originalEvent: { ...click.originalEvent, pointerType },
        });

      tap("touch");
      tap("mouse");
      // A click that does not say, with no touch before it, is a mouse's
      // or a trackpad's, whatever the device can do
      tap();
      delete (window as { ontouchstart?: unknown }).ontouchstart;

      expect(
        (mockLayerManagerInstance.onPathClick.mock.calls as unknown[][]).map(
          (call) => call[2],
        ),
      ).toEqual([true, false, false]);
    });

    it("takes a click just after a touch on the map for a tap, as WebKit's says mouse", async () => {
      await initializeApp(app);
      const hit = { pathId: 2, segment: { path_id: 2 } };
      mockLayerManagerInstance.hitTest.mockReturnValue(hit);
      const tap = (timeStamp: number) =>
        mockMap(app).emit("click", {
          ...click,
          originalEvent: { detail: 1, timeStamp, pointerType: "mouse" },
        });

      mockMap(app).emit("touchstart", { originalEvent: { timeStamp: 5000 } });
      tap(5100);
      // A mouse's click well after it
      tap(9000);

      expect(
        (mockLayerManagerInstance.onPathClick.mock.calls as unknown[][]).map(
          (call) => call[2],
        ),
      ).toEqual([true, false]);
    });

    it("leaves the selection alone while the tiles cannot tell what was clicked", async () => {
      await initializeApp(app);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      mockLayerManagerInstance.hitTest.mockReturnValue("stale");

      mockMap(app).emit("click", click);

      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
      expect(mockLayerManagerInstance.onPathClick).not.toHaveBeenCalled();
      // An ignored click changes nothing at all: the values of a tapped
      // flight stay, and so does the popup of an airport
      expect(mockLayerManagerInstance.closeSegmentPopup).not.toHaveBeenCalled();
      expect(mockAirportManagerInstance.closePopup).not.toHaveBeenCalled();
    });

    it("does nothing for a click on the overview of the Wrapped dialog", async () => {
      // The dialog shows this map and leaves its gestures on, so the
      // overview can be moved; a click there must not act behind the modal
      await initializeApp(app);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      mockLayerManagerInstance.hitTest.mockReturnValue({
        pathId: 2,
        segment: { path_id: 2 },
      });
      app.store.set("wrappedVisible", true);

      mockMap(app).emit("click", click);

      expect(mockLayerManagerInstance.hitTest).not.toHaveBeenCalled();
      expect(mockLayerManagerInstance.onPathClick).not.toHaveBeenCalled();
      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
      expect(mockAirportManagerInstance.closePopup).not.toHaveBeenCalled();

      app.store.set("wrappedVisible", false);
      mockMap(app).emit("click", click);
      expect(mockLayerManagerInstance.onPathClick).toHaveBeenCalledTimes(1);
    });

    it("takes a click on a marker for none on the map", async () => {
      // No marker stops its click, so every one of them arrives here, the
      // one that has just opened a popup included
      await initializeApp(app);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      const closePopup = vi.fn();
      app.replayState.airplaneMarker = {
        isPopupOpen: () => true,
        closePopup,
      } as unknown as MapApp["replayState"]["airplaneMarker"];
      const marker = document.createElement("button");
      marker.className = "maplibregl-marker";
      mockMap(app).getCanvasContainer().append(marker);
      const originalEvent = new MouseEvent("click", { bubbles: true });
      marker.dispatchEvent(originalEvent);

      mockMap(app).emit("click", { ...click, originalEvent });
      app.replayActive = true;
      mockMap(app).emit("click", { ...click, originalEvent });

      expect(mockLayerManagerInstance.hitTest).not.toHaveBeenCalled();
      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
      expect(mockAirportManagerInstance.closePopup).not.toHaveBeenCalled();
      expect(closePopup).not.toHaveBeenCalled();
    });

    it("closes the airplane popup during replay instead of clearing", async () => {
      await initializeApp(app);
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      const closePopup = vi.fn();
      app.replayActive = true;
      app.replayState.airplaneMarker = {
        isPopupOpen: () => true,
        closePopup,
      } as unknown as MapApp["replayState"]["airplaneMarker"];

      mockMap(app).emit("click", click);

      expect(closePopup).toHaveBeenCalledTimes(1);
      expect(mockAirportManagerInstance.closePopup).toHaveBeenCalledTimes(1);
      expect(mockPathSelectionInstance.clearSelection).not.toHaveBeenCalled();
      // The colour layers are hidden during a replay
      expect(mockLayerManagerInstance.hitTest).not.toHaveBeenCalled();
    });
  });

  describe("map setup", () => {
    it("creates the map in its own zoom units, north up and flat", async () => {
      await initializeApp(app);

      // One below the 1 to 20 that saved state and links are clamped to
      expect(mockMap(app).options).toMatchObject({
        container: "map",
        style: FALLBACK_STYLE,
        minZoom: 0,
        maxZoom: 19,
        attributionControl: false,
        bearing: 0,
        pitch: 0,
        maxPitch: 85,
      });
      expect(mockMap(app).options["transformRequest"]).toBeNull();
      expect(mockMap(app).getProjection()).toBeUndefined();
    });

    it("leaves the gestures that turn and tilt the map switched on", async () => {
      await initializeApp(app);

      const options = mockMap(app).options;
      for (const gesture of ["dragRotate", "pitchWithRotate", "touchPitch"]) {
        expect(options).not.toHaveProperty(gesture);
      }
      expect(
        mockMap(app).touchZoomRotate.disableRotation,
      ).not.toHaveBeenCalled();
      expect(mockMap(app).keyboard.disableRotation).not.toHaveBeenCalled();
    });

    it("opens turned, tilted and as a globe when the state says so", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({
        center: { lat: 50, lng: 10 },
        zoom: 6,
        bearing: -40,
        pitch: 35,
        globeVisible: true,
      });

      await initializeApp(app);

      expect(mockMap(app).options).toMatchObject({ bearing: -40, pitch: 35 });
      expect(mockMap(app).getProjection()).toEqual({ type: "globe" });
      expect(
        document.getElementById("globe-btn")!.getAttribute("aria-pressed"),
      ).toBe("true");
    });

    it("keeps a bearing that comes without a centre through the first fit", async () => {
      mockStateManagerInstance.loadState.mockReturnValue({ bearing: 90 });

      await initializeApp(app);

      expect(mockMap(app).options["fitBoundsOptions"]).toEqual({
        padding: { top: 48, right: 48, bottom: 48, left: 48 },
        bearing: 90,
      });
    });

    it("adds an attribution that stays expanded, bottom right", async () => {
      await initializeApp(app);

      const [{ control, position }] = mockMap(app).controls as [
        { control: AttributionControl; position: string },
      ];
      expect(control).toBeInstanceOf(AttributionControl);
      expect(control.options).toEqual({ compact: false });
      expect(position).toBe("bottom-right");
    });

    it("creates every layer once, in drawing order, without the base style", async () => {
      await initializeApp(app);

      expect(fetchBaseStyle).toHaveBeenCalledOnce();
      expect(mockMap(app).getLayersOrder()).toEqual([
        "background",
        "aviation",
        "heat",
        "heat-isolated",
        "heat-lines-glow",
        "heat-lines-core",
        "selection-highlight",
        "replay-route",
        "paths-altitude",
        "paths-airspeed",
        "paths-altitude-selected",
        "paths-airspeed-selected",
        "replay-trail",
        "paths-altitude-3d",
        "paths-airspeed-3d",
        "paths-altitude-selected-3d",
        "paths-airspeed-selected-3d",
        "selection-highlight-3d",
        "replay-trail-3d",
        "replay-trail-tip-3d",
        "airport-labels",
        "airport-dots",
      ]);
      // Empty until the managers fill them
      for (const id of [
        "heat",
        "heat-isolated",
        "heat-lines",
        "selection-highlight",
        "replay-route",
        "paths-altitude",
        "paths-airspeed",
        "paths-altitude-selected",
        "paths-airspeed-selected",
        "replay-trail",
        "airport-labels",
      ]) {
        expect(mockMap(app).source(id).data).toEqual({
          type: "FeatureCollection",
          features: [],
        });
      }
    });

    it("lets MapLibre simplify the paths the way the app used to", async () => {
      await initializeApp(app);

      for (const id of ["paths-altitude", "paths-altitude-selected"]) {
        expect(mockMap(app).source(id).spec).toMatchObject({
          tolerance: 0.25,
          maxzoom: 14,
        });
      }
      expect(mockMap(app).layer("paths-altitude").paint).toEqual({
        "line-color": ["get", "color"],
        "line-width": 4,
        "line-opacity": 0.85,
      });
      expect(mockMap(app).layer("paths-altitude-selected").paint).toMatchObject(
        { "line-width": 6, "line-opacity": 1 },
      );
    });

    it("limits the aviation overlay to the zooms it still reads at", async () => {
      await initializeApp(app);

      // The overlay needs no key, and `latest` follows the AIRAC cycle, so
      // the URL carries neither
      expect(mockMap(app).source("aviation").spec).toEqual({
        type: "raster",
        tiles: [
          "https://nwy-tiles-api.prod.newaydata.com/tiles/{z}/{x}/{y}.png?path=latest/aero/latest",
        ],
        tileSize: 256,
        // Tile levels: a 256 pixel tile of level 7 is shown at map zoom 6
        minzoom: 7,
        maxzoom: 12,
        attribution: expect.stringContaining("open flightmaps") as string,
      });
      // Map zooms: two levels past the native 11 is as far as the tiles
      // stretch before they are only a blur, and maxzoom is exclusive
      expect(mockMap(app).layer("aviation")).toMatchObject({
        minzoom: 6,
        maxzoom: 13.01,
      });
    });

    it("resolves mapReady with the map once the layers are on it", async () => {
      mockControl.autoLoadStyle = false;
      const pending = initializeApp(app);
      const ready = vi.fn((map: unknown) => {
        expect((map as MockMap).getLayer("replay-trail")).toBeDefined();
      });
      void app.mapReady.then(ready);
      await Promise.resolve();

      expect(ready).not.toHaveBeenCalled();
      expect(m.mockDataManagerInstance.loadAirports).not.toHaveBeenCalled();

      mockMap(app).finishStyleLoad();
      await pending;

      expect(ready).toHaveBeenCalledWith(app.map);
      expect(m.mockDataManagerInstance.loadAirports).toHaveBeenCalled();
    });

    it("fails the start-up when a layer cannot be added, and does not hang", async () => {
      mockControl.autoLoadStyle = false;
      const pending = initializeApp(app);
      await Promise.resolve();
      mockMap(app).addLayer.mockImplementationOnce(() => {
        throw new Error("layer refused");
      });

      mockMap(app).finishStyleLoad();

      await expect(pending).rejects.toThrow("layer refused");
      await expect(app.mapReady).rejects.toThrow("layer refused");
      expect(m.mockDataManagerInstance.loadAirports).not.toHaveBeenCalled();
    });

    it("takes the app down when the layers cannot be added", async () => {
      mockControl.autoLoadStyle = false;
      const pending = initializeApp(app);
      await Promise.resolve();
      const map = mockMap(app);
      map.addLayer.mockImplementationOnce(() => {
        throw new Error("layer refused");
      });
      const signal = app.signal;

      map.finishStyleLoad();
      await expect(pending).rejects.toThrow("layer refused");

      // The controls were bound before the start-up: none of them may go
      // on acting on a map without layers
      expect(signal.aborted).toBe(true);
      expect(m.mockLayerManagerInstance.destroy).toHaveBeenCalled();
      expect(m.mockAirportManagerInstance.destroy).toHaveBeenCalled();
      expect(map.remove).toHaveBeenCalledTimes(1);
      expect(app.map).toBeNull();
    });

    it("tears down once when a destroy races the failure of the layers", async () => {
      mockControl.autoLoadStyle = false;
      // Registered before `initialize()` waits, so it runs between the
      // failure and the moment `initialize()` gets to look at it
      app.mapReady.catch(() => app.destroy());
      const pending = initializeApp(app);
      await Promise.resolve();
      const map = mockMap(app);
      map.addLayer.mockImplementationOnce(() => {
        throw new Error("layer refused");
      });

      map.finishStyleLoad();

      // Told by the state and not by which rejection won
      await expect(pending).resolves.toBeUndefined();
      expect(map.remove).not.toHaveBeenCalled();
      expect(m.mockLayerManagerInstance.destroy).toHaveBeenCalledTimes(1);
      // There is nobody left to show the failure to, but it is one
      expect(logError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "layer refused" }),
      );
    });

    it("stops quietly when destroyed before the style has loaded", async () => {
      mockControl.autoLoadStyle = false;
      const pending = initializeApp(app);
      await Promise.resolve();

      app.destroy();

      // Settled without the style ever loading, and not as a failure
      await expect(pending).resolves.toBeUndefined();
      await expect(app.mapReady).rejects.toThrow("destroyed");
      expect(logError).not.toHaveBeenCalled();
      expect(m.mockDataManagerInstance.loadAirports).not.toHaveBeenCalled();
    });

    it("adds no layers for a style that arrives after destroy", async () => {
      mockControl.autoLoadStyle = false;
      const pending = initializeApp(app);
      await Promise.resolve();
      const map = mockMap(app);
      app.destroy();
      await pending;

      map.finishStyleLoad();
      await Promise.resolve();

      expect(map.addSource).not.toHaveBeenCalled();
      expect(map.addLayer).not.toHaveBeenCalled();
      expect(fetchBaseStyle).not.toHaveBeenCalled();
    });

    it("remembers a visibility asked for before the style has loaded", async () => {
      mockControl.autoLoadStyle = false;
      const pending = initializeApp(app);
      await Promise.resolve();

      app.heatmapLayer.setVisible(true);
      expect(app.heatmapLayer.isVisible()).toBe(true);

      mockMap(app).finishStyleLoad();
      await pending;

      expect(mockMap(app).layer("heat").layout["visibility"]).toBe("visible");
    });

    describe("the base style", () => {
      it("arrives late and goes under the flights, which stay as they are", async () => {
        let answer!: (response: Response) => void;
        fetchBaseStyle.mockReturnValue(
          new Promise((resolve) => (answer = resolve)),
        );
        await initializeApp(app);
        const map = mockMap(app);
        // What the managers did while the map was on the style it starts on
        const data = { type: "FeatureCollection", features: [{ id: 1 }] };
        const paths = map.source("paths-altitude");
        void paths.setData(data);
        app.heatmapLayer.setVisible(true);
        app.aviationLayer.setVisible(true);
        const highlight = map.source("selection-highlight");
        void highlight.setData(data);
        app.selectionHighlightLayer.setVisible(true);
        map.setPaintProperty("paths-altitude", "line-opacity", 0.1);
        map.setFilter("paths-airspeed", ["==", ["get", "pathId"], 7]);
        map.addSource.mockClear();
        map.addLayer.mockClear();

        answer(styleResponse(BASE_STYLE));
        await vi.waitFor(() => expect(map.setStyle).toHaveBeenCalledOnce());

        expect(map.getLayersOrder()).toEqual([
          "background",
          "water",
          "aviation",
          "heat",
          "heat-isolated",
          "heat-lines-glow",
          "heat-lines-core",
          "selection-highlight",
          "replay-route",
          "paths-altitude",
          "paths-airspeed",
          "paths-altitude-selected",
          "paths-airspeed-selected",
          "replay-trail",
          "paths-altitude-3d",
          "paths-airspeed-3d",
          "paths-altitude-selected-3d",
          "paths-airspeed-selected-3d",
          "selection-highlight-3d",
          "replay-trail-3d",
          "replay-trail-tip-3d",
          "place-labels",
          // Labels themselves, on top of the base style's, and the
          // stand-ins of the dots they keep clear of
          "airport-labels",
          "airport-dots",
        ]);
        // The same source, not one made again from a copy of its data: a
        // `setData` that is on its way still lands in it
        expect(map.source("paths-altitude")).toBe(paths);
        expect(paths.data).toBe(data);
        expect(map.source("heat").spec).toMatchObject({ cluster: true });
        expect(map.source("carto")).toBeDefined();
        expect(map.layer("heat").layout["visibility"]).toBe("visible");
        expect(map.layer("aviation").layout["visibility"]).toBe("visible");
        // The selection's lines, with their data and their visibility
        expect(map.source("selection-highlight")).toBe(highlight);
        expect(highlight.data).toBe(data);
        expect(map.layer("selection-highlight").layout["visibility"]).toBe(
          "visible",
        );
        expect(map.layer("selection-highlight-3d").layout["visibility"]).toBe(
          "visible",
        );
        expect(map.layer("paths-altitude").paint["line-opacity"]).toBe(0.1);
        expect(map.layer("paths-airspeed").filter).toEqual([
          "==",
          ["get", "pathId"],
          7,
        ]);
        // The handles still reach their layers
        app.heatmapLayer.setVisible(false);
        expect(map.layer("heat").layout["visibility"]).toBe("none");
        // Nothing was added by hand, and nothing was reported
        expect(map.addLayer).not.toHaveBeenCalled();
        expect(logError).not.toHaveBeenCalled();
      });

      it("does not hold the start-up back while it never answers", async () => {
        vi.useFakeTimers();
        try {
          await initializeApp(app);
          await vi.advanceTimersByTimeAsync(10 * 60_000);

          expect(m.mockDataManagerInstance.loadAirports).toHaveBeenCalled();
          expect(fetchBaseStyle).toHaveBeenCalledOnce();
          expect(mockMap(app).setStyle).not.toHaveBeenCalled();
          expect(logError).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });

      it("is asked for once more after a failure, and then left alone", async () => {
        vi.useFakeTimers();
        try {
          fetchBaseStyle.mockRejectedValue(new TypeError("Failed to fetch"));
          await initializeApp(app);
          await vi.advanceTimersByTimeAsync(0);

          expect(logError).toHaveBeenCalledWith(
            "Base map style failed to load: Failed to fetch",
          );
          expect(m.mockDataManagerInstance.loadAirports).toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(BASE_STYLE_RETRY_MS - 1);
          expect(fetchBaseStyle).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(1);
          expect(fetchBaseStyle).toHaveBeenCalledTimes(2);

          await vi.advanceTimersByTimeAsync(BASE_STYLE_RETRY_MS * 10);
          expect(fetchBaseStyle).toHaveBeenCalledTimes(2);
          expect(mockMap(app).setStyle).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      });

      it("says once that the base map is missing, with a Retry that asks at once", async () => {
        vi.useFakeTimers();
        try {
          fetchBaseStyle.mockRejectedValue(new TypeError("Failed to fetch"));
          await initializeApp(app);
          await vi.advanceTimersByTimeAsync(BASE_STYLE_RETRY_MS);
          expect(fetchBaseStyle).toHaveBeenCalledTimes(2);

          // One toast for both failures, and none that stacks up
          const said = vi
            .mocked(showToast)
            .mock.calls.filter(
              ([message]) => message === BASE_STYLE_UNAVAILABLE_MESSAGE,
            );
          expect(said).toHaveLength(1);
          const [, type, action] = said[0]!;
          expect(type).toBe("info");
          expect(action?.label).toBe("Retry");

          // Its Retry asks again at once, and a style that comes takes
          // the toast away
          fetchBaseStyle.mockResolvedValue(styleResponse(BASE_STYLE));
          action!.run();
          await vi.advanceTimersByTimeAsync(0);
          expect(fetchBaseStyle).toHaveBeenCalledTimes(3);
          expect(mockMap(app).setStyle).toHaveBeenCalledOnce();
          expect(dismissToast).toHaveBeenCalledWith(
            BASE_STYLE_UNAVAILABLE_MESSAGE,
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it("says so again when its Retry fails as well", async () => {
        vi.useFakeTimers();
        try {
          fetchBaseStyle.mockRejectedValue(new TypeError("Failed to fetch"));
          await initializeApp(app);
          await vi.advanceTimersByTimeAsync(BASE_STYLE_RETRY_MS);
          const said = () =>
            vi
              .mocked(showToast)
              .mock.calls.filter(
                ([message]) => message === BASE_STYLE_UNAVAILABLE_MESSAGE,
              );
          expect(said()).toHaveLength(1);

          said()[0]![2]!.run();
          await vi.advanceTimersByTimeAsync(0);
          expect(fetchBaseStyle).toHaveBeenCalledTimes(3);
          expect(said()).toHaveLength(2);

          // The timed retry of that round stays quiet, as the first one did
          await vi.advanceTimersByTimeAsync(BASE_STYLE_RETRY_MS);
          expect(fetchBaseStyle).toHaveBeenCalledTimes(4);
          expect(said()).toHaveLength(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it("takes an answer that is not a style for a failure", async () => {
        fetchBaseStyle.mockResolvedValue(styleResponse({}, 503));
        await initializeApp(app);

        await vi.waitFor(() =>
          expect(logError).toHaveBeenCalledWith(
            "Base map style failed to load: HTTP 503",
          ),
        );
        expect(mockMap(app).setStyle).not.toHaveBeenCalled();
      });

      it("is asked for again when the browser comes back online", async () => {
        vi.useFakeTimers();
        try {
          fetchBaseStyle.mockRejectedValue(new TypeError("Failed to fetch"));
          await initializeApp(app);
          await vi.advanceTimersByTimeAsync(BASE_STYLE_RETRY_MS);
          expect(fetchBaseStyle).toHaveBeenCalledTimes(2);

          fetchBaseStyle.mockResolvedValue(styleResponse(BASE_STYLE));
          window.dispatchEvent(new Event("online"));
          await vi.advanceTimersByTimeAsync(0);

          expect(fetchBaseStyle).toHaveBeenCalledTimes(3);
          expect(mockMap(app).setStyle).toHaveBeenCalledOnce();
          expect(mockMap(app).getLayersOrder().at(-3)).toBe("place-labels");

          // Once it is there, it is there
          window.dispatchEvent(new Event("online"));
          await vi.advanceTimersByTimeAsync(BASE_STYLE_RETRY_MS);
          expect(fetchBaseStyle).toHaveBeenCalledTimes(3);
        } finally {
          vi.useRealTimers();
        }
      });

      it("is not asked for twice while a request is out", async () => {
        await initializeApp(app);

        window.dispatchEvent(new Event("online"));

        expect(fetchBaseStyle).toHaveBeenCalledOnce();
      });

      it("is given up on by destroy, and changes nothing when it answers anyway", async () => {
        let answer!: (response: Response) => void;
        fetchBaseStyle.mockReturnValue(
          new Promise((resolve) => (answer = resolve)),
        );
        await initializeApp(app);
        const signal = fetchBaseStyle.mock.calls[0]![1]!.signal!;

        app.destroy();
        expect(signal.aborted).toBe(true);
        answer(styleResponse(BASE_STYLE));
        await new Promise((resolve) => setTimeout(resolve));
        window.dispatchEvent(new Event("online"));

        expect(mockMap(app).setStyle).not.toHaveBeenCalled();
        expect(fetchBaseStyle).toHaveBeenCalledOnce();
        expect(logError).not.toHaveBeenCalled();
      });

      it("says nothing about a request that destroy aborted", async () => {
        fetchBaseStyle.mockImplementation(
          (_url, init) =>
            new Promise((_resolve, reject) => {
              init!.signal!.addEventListener("abort", () =>
                reject(new DOMException("aborted", "AbortError")),
              );
            }),
        );
        vi.useFakeTimers();
        try {
          await initializeApp(app);

          app.destroy();
          await vi.advanceTimersByTimeAsync(BASE_STYLE_RETRY_MS);

          expect(logError).not.toHaveBeenCalled();
          expect(fetchBaseStyle).toHaveBeenCalledOnce();
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it("logs what fails later and keeps the style", async () => {
      await initializeApp(app);

      mockMap(app).emit("error", { error: new Error("tile 5/1/2 failed") });
      mockMap(app).emit("error", { error: "no message" });

      expect(logError).toHaveBeenCalledWith("Map error: tile 5/1/2 failed");
      expect(logError).toHaveBeenCalledWith("Map error: no message");
      expect(mockMap(app).setStyle).not.toHaveBeenCalled();
    });

    it.each([
      [false, 300],
      [true, 0],
    ])(
      "creates the map for reduced motion %s with a fade of %s ms",
      async (reduced, fadeDuration) => {
        // MapLibre cuts its camera moves and the glide after a drag short by
        // itself; the tile fade is the one thing it keeps
        const spy = vi
          .spyOn(motion, "prefersReducedMotion")
          .mockReturnValue(reduced);

        await initializeApp(app);

        expect(lastMap().options).toMatchObject({ fadeDuration });
        // Not pinned: left out, MapLibre asks the media query on every move,
        // so turning the setting on or off takes effect without a reload
        expect(lastMap().options).not.toHaveProperty("reduceMotion");
        spy.mockRestore();
      },
    );

    it("hands the map's canvas the focus the rail gives up as a last resort", async () => {
      await initializeApp(app);
      app.store.set("statsPanelVisible", true);
      document.getElementById("stats-btn")!.remove();
      document.getElementById("stats-collapse-btn")!.focus();

      app.store.set("statsPanelVisible", false);

      expect(document.activeElement).toBe(mockMap(app).getCanvas());
    });

    describe("with a CARTO API key", () => {
      it("puts the key on the style URL", async () => {
        const appWithCarto = new MapApp({
          ...m.APP_CONFIG,
          cartoApiKey: "carto key",
        });

        await initializeApp(appWithCarto);

        expect(fetchBaseStyle.mock.calls[0]![0]).toBe(
          "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=carto%20key",
        );
        expect(lastMap().options["transformRequest"]).toBeTypeOf("function");
        appWithCarto.destroy();
      });

      it("puts the key on every other request to CARTO", () => {
        const transform = cartoTransformRequest("carto-key")!;

        expect(
          transform("https://tiles-a.basemaps.cartocdn.com/vector/1/2/3.mvt"),
        ).toEqual({
          url: "https://tiles-a.basemaps.cartocdn.com/vector/1/2/3.mvt?key=carto-key",
        });
        expect(
          transform(
            "https://tiles.basemaps.cartocdn.com/fonts/a/0-255.pbf?v=1",
          ),
        ).toEqual({
          url: "https://tiles.basemaps.cartocdn.com/fonts/a/0-255.pbf?v=1&key=carto-key",
        });
        expect(
          transform("https://basemaps.cartocdn.com/gl/sprite.json"),
        ).toEqual({
          url: "https://basemaps.cartocdn.com/gl/sprite.json?key=carto-key",
        });
      });

      it("leaves everything else alone", () => {
        const transform = cartoTransformRequest("carto-key")!;

        // Already keyed, another host, a lookalike host, a relative URL
        expect(
          transform("https://basemaps.cartocdn.com/style.json?key=other"),
        ).toBeUndefined();
        expect(
          transform(
            "https://nwy-tiles-api.prod.newaydata.com/tiles/7/1/2.png?path=x",
          ),
        ).toBeUndefined();
        expect(
          transform("https://evilbasemaps.cartocdn.com/1/2/3.mvt"),
        ).toBeUndefined();
        expect(transform("data/2025.json")).toBeUndefined();
      });

      it("transforms nothing without a key", () => {
        expect(cartoTransformRequest()).toBeNull();
        expect(cartoTransformRequest("")).toBeNull();
      });
    });
  });
});
