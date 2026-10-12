/**
 * Shared fixtures for the ReplayManager test files.
 *
 * The app double is the shared `createMockApp`: a real store behind
 * the accessors, the MapLibre fake with its sources and layer handles, and
 * stubs for the other managers. The real domCache and the real pure helpers (formatTime,
 * colors, bearing) are used.
 */
import { vi } from "vitest";
import type { PathSegment } from "../../../../flown/frontend/types";
import { icon } from "../../../../flown/frontend/utils/icons";
import { LIVE_REGION_DELAY_MS } from "../../../../flown/frontend/utils/toast";
import { ReplayManager } from "../../../../flown/frontend/ui/replayManager";
import { MAP_SOURCES } from "../../../../flown/frontend/utils/constants";
import {
  asMapApp,
  createDataset,
  createMockApp,
  syncControlsWithStore,
  type MockApp,
} from "../../testHelpers";
import type { MockSource } from "../../../mocks/maplibre-gl";

export { el, type MockApp } from "../../testHelpers";

/** Three consecutive segments of path 1 at t = 0, 60 and 120 seconds */
export function createSegments(): PathSegment[] {
  return [
    {
      path_id: 1,
      coords: [
        [48.0, 16.0],
        [48.1, 16.1],
      ],
      altitude_ft: 3000,
      groundspeed_knots: 100,
      time: 0,
    },
    {
      path_id: 1,
      coords: [
        [48.1, 16.1],
        [48.2, 16.2],
      ],
      altitude_ft: 4000,
      groundspeed_knots: 120,
      time: 60,
    },
    {
      path_id: 1,
      coords: [
        [48.2, 16.2],
        [48.3, 16.3],
      ],
      altitude_ft: 5000,
      groundspeed_knots: 130,
      time: 120,
    },
  ];
}

/**
 * A mock app holding path 1 with timing data. The buttons, legends and
 * layers are wired to the store the way MapApp does it, so the tests can
 * read the altitude button and the layers the way the user sees them.
 */
/**
 * The lifetime of the app of the current test, ended by unmountReplayDom: a
 * manager listens on the document for as long as its app lives, and one of
 * an earlier test would otherwise still take the keys of the next
 */
let lifetime = new AbortController();

export function createReplayMockApp(): MockApp {
  const app = createMockApp({
    // With the exact range of its altitudes, as the export writes it
    currentData: createDataset(
      [{ id: 1, min_altitude_ft: 3000, max_altitude_ft: 5000 }],
      createSegments(),
    ),
    hasTimingData: true,
    signal: lifetime.signal,
  });
  // jsdom lays nothing out, so the map is given a size: the follow logic
  // measures the airplane against it
  const container = app.map!.getContainer();
  Object.defineProperty(container, "clientWidth", { value: 800 });
  Object.defineProperty(container, "clientHeight", { value: 600 });
  // The layer manager's and the data manager's part of showing a layer
  app.layerManager.syncModes.mockImplementation(() => {
    for (const mode of ["altitude", "airspeed"] as const) {
      app[`${mode}Layer`].setVisible(
        app[`${mode}Visible`] && !app.replayActive,
      );
    }
  });
  app.dataManager.showHeatmap.mockImplementation(() =>
    app.heatmapLayer.setVisible(true),
  );
  syncControlsWithStore(app);
  return app;
}

/** The route and the trail source of the app's map */
export function replaySources(app: MockApp): {
  route: MockSource;
  trail: MockSource;
} {
  return {
    route: app.map!.source(MAP_SOURCES.replayRoute),
    trail: app.map!.source(MAP_SOURCES.replayTrail),
  };
}

/** The features a replay source holds right now */
export function featuresOf(source: MockSource): {
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: [number, number][] };
}[] {
  return (source.data as { features: never[] }).features;
}

/** One element of the replay DOM fixture */
interface FixtureNode {
  id: string;
  tag: string;
  attributes?: Record<string, string>;
  children?: FixtureNode[];
}

/**
 * The replay panel, nested the way map_template.html nests it. The shape
 * matters: the readout strip must land beside `#replay-live`, never inside
 * it, and a flat fixture could not tell the two apart.
 */
const REPLAY_PANEL: FixtureNode = {
  id: "replay-controls",
  tag: "div",
  children: [
    {
      id: "replay-controls-inner",
      tag: "div",
      children: [
        {
          id: "replay-buttons",
          tag: "div",
          children: [
            { id: "replay-play-btn", tag: "button" },
            { id: "replay-pause-btn", tag: "button" },
            { id: "replay-time-display", tag: "div" },
            { id: "replay-speed", tag: "select" },
            { id: "replay-autozoom-btn", tag: "button" },
            { id: "replay-chase-btn", tag: "button" },
          ],
        },
        {
          id: "replay-slider-container",
          tag: "div",
          children: [
            { id: "replay-slider-start", tag: "span" },
            { id: "replay-slider", tag: "input" },
            { id: "replay-slider-end", tag: "span" },
          ],
        },
        {
          id: "replay-live",
          tag: "div",
          attributes: { "aria-live": "polite", "aria-atomic": "true" },
        },
      ],
    },
  ],
};

/** Page chrome outside the replay panel that the manager reads or disables */
const PAGE_CHROME: FixtureNode[] = [
  { id: "replay-btn", tag: "button" },
  { id: "altitude-btn", tag: "button" },
  { id: "altitude-legend", tag: "div" },
  { id: "airspeed-btn", tag: "button" },
  { id: "airspeed-legend", tag: "div" },
  { id: "heatmap-btn", tag: "button" },
  { id: "airports-btn", tag: "button" },
  { id: "aviation-btn", tag: "button" },
  { id: "wrapped-btn", tag: "button" },
  { id: "year-select", tag: "select" },
  { id: "aircraft-select", tag: "select" },
  { id: "isolate-btn", tag: "button" },
  { id: "selection-clear-btn", tag: "button" },
  { id: "reset-view-btn", tag: "button" },
];

function buildFixtureNode(node: FixtureNode): HTMLElement {
  const element = document.createElement(node.tag);
  element.id = node.id;
  for (const [name, value] of Object.entries(node.attributes ?? {})) {
    element.setAttribute(name, value);
  }
  if (element instanceof HTMLInputElement) element.type = "range";
  if (node.id === "replay-btn") {
    // Same shape as the template: an injected icon plus a label span
    element.dataset["icon"] = "play";
    element.innerHTML =
      icon("play", 16) + '<span class="control-label">Replay</span>';
  }
  if (node.id === "replay-speed") {
    for (const speed of ["1", "10", "50", "100"]) {
      const option = document.createElement("option");
      option.value = speed;
      option.textContent = speed + "x";
      if (speed === "50") option.selected = true;
      element.appendChild(option);
    }
  }
  for (const child of node.children ?? []) {
    element.appendChild(buildFixtureNode(child));
  }
  return element;
}

export function mountReplayDom(): void {
  for (const node of [REPLAY_PANEL, ...PAGE_CHROME]) {
    document.body.appendChild(buildFixtureNode(node));
  }
}

export function unmountReplayDom(): void {
  lifetime.abort();
  lifetime = new AbortController();
  for (const node of [REPLAY_PANEL, ...PAGE_CHROME]) {
    document.getElementById(node.id)?.remove();
  }
  document
    .querySelectorAll("#toast-stack, #toast-status, #toast-alert")
    .forEach((element) => element.remove());
  // Replay hands the bottom edge over to the mobile bar, which only mounts
  // on a narrow viewport; clean it up so a test that changes the width
  // stays isolated
  document
    .querySelectorAll(".mobile-bar, .mobile-sheet, .sheet-scrim")
    .forEach((element) => element.remove());
  document.body.classList.remove("replay-active");
}

export function createReplayManager(app: MockApp): ReplayManager {
  return new ReplayManager(asMapApp(app));
}

/** Drive requestAnimationFrame through fake timers (16 ms per frame) */
export function mockAnimationFrame(): void {
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((cb) => {
    return setTimeout(() => cb(performance.now()), 16) as unknown as number;
  });
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation((id) => {
    clearTimeout(id);
  });
}

/**
 * Last message written to the replay live region. The region is filled a
 * moment after it is cleared, so the fake clock is moved past that first.
 */
export function liveRegionText(): string {
  vi.advanceTimersByTime(LIVE_REGION_DELAY_MS);
  return document.getElementById("replay-live")?.textContent ?? "";
}
