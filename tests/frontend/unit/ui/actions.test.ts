import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DEFERRED_WHILE_INITIALIZING,
  NEED_DATA,
  NO_DATA_MESSAGE,
  STILL_LOADING_MESSAGE,
  bindActions,
  runAction,
  type ActionName,
} from "../../../../flown/frontend/ui/actions";
import * as toast from "../../../../flown/frontend/utils/toast";
import { createMockApp, asMapApp, type MockApp } from "../../testHelpers";

const loggerMock = vi.hoisted(() => ({ logError: vi.fn(), logDebug: vi.fn() }));
vi.mock("../../../../flown/frontend/utils/logger", () => loggerMock);

const BUTTON_ACTIONS = [
  "toggleHeatmap",
  "toggleStats",
  "toggleAltitude",
  "toggleAirspeed",
  "toggleAirports",
  "toggleAviation",
  "toggleGlobe",
  "resetNorth",
  "resetView",
  "toggleReplay",
  "toggleReplayAll",
  "toggleCrossSection",
  "toggleHotspotTour",
  "exportMap",
  "shareLink",
  "showWrapped",
  "closeWrapped",
  "toggleIsolateSelection",
  "playReplay",
  "pauseReplay",
  "stopReplay",
  "toggleAutoZoom",
  "unknownAction",
];

describe("bindActions", () => {
  let app: MockApp;
  let elements: Record<string, HTMLElement>;

  beforeEach(() => {
    vi.clearAllMocks();
    elements = {};
    for (const action of BUTTON_ACTIONS) {
      const btn = document.createElement("button");
      btn.dataset["action"] = action;
      document.body.appendChild(btn);
      elements[action] = btn;
    }

    const yearSelect = document.createElement("select");
    yearSelect.dataset["action"] = "filterByYear";
    document.body.appendChild(yearSelect);
    elements["filterByYear"] = yearSelect;

    const aircraftSelect = document.createElement("select");
    aircraftSelect.dataset["action"] = "filterByAircraft";
    document.body.appendChild(aircraftSelect);
    elements["filterByAircraft"] = aircraftSelect;

    const slider = document.createElement("input");
    slider.type = "range";
    slider.dataset["action"] = "seekReplay";
    slider.value = "50";
    document.body.appendChild(slider);
    elements["seekReplay"] = slider;

    const speedSelect = document.createElement("select");
    speedSelect.dataset["action"] = "changeReplaySpeed";
    document.body.appendChild(speedSelect);
    elements["changeReplaySpeed"] = speedSelect;

    app = createMockApp();
    bindActions(asMapApp(app));
  });

  afterEach(() => {
    Object.values(elements).forEach((element) => element.remove());
  });

  it("binds the layer and export toggles", () => {
    elements["toggleHeatmap"]!.click();
    elements["toggleAltitude"]!.click();
    elements["toggleAirspeed"]!.click();
    elements["toggleAirports"]!.click();
    elements["toggleAviation"]!.click();
    elements["exportMap"]!.click();

    expect(app.uiToggles.toggleHeatmap).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.toggleAltitude).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.toggleAirspeed).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.toggleAirports).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.toggleAviation).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.exportMap).toHaveBeenCalledTimes(1);
  });

  it("binds the globe switch and the compass, which need no data", () => {
    app.isInitializing = true;

    elements["toggleGlobe"]!.click();
    elements["resetNorth"]!.click();

    expect(app.mapOrientation.toggleGlobe).toHaveBeenCalledTimes(1);
    expect(app.mapOrientation.resetNorth).toHaveBeenCalledTimes(1);
  });

  it("unbinds every control once the app is gone", () => {
    const lifetime = new AbortController();
    const ended = createMockApp({ signal: lifetime.signal });
    bindActions(asMapApp(ended));

    lifetime.abort();
    elements["toggleHeatmap"]!.click();
    elements["filterByYear"]!.dispatchEvent(new Event("change"));

    expect(ended.uiToggles.toggleHeatmap).not.toHaveBeenCalled();
    expect(ended.filterManager.pickYear).not.toHaveBeenCalled();
    // The app bound in beforeEach still lives
    expect(app.uiToggles.toggleHeatmap).toHaveBeenCalledTimes(1);
  });

  it("binds the share button like every other control", () => {
    elements["shareLink"]!.click();

    expect(app.uiToggles.shareLink).toHaveBeenCalledTimes(1);
  });

  it("binds the statistics toggle to the store key the rail follows", () => {
    // A store write, not a call on the stats manager: its code is lazily
    // loaded and arrives on the first opening (ui/statsPanel.ts)
    elements["toggleStats"]!.click();
    expect(app.store.get("statsPanelVisible")).toBe(true);

    elements["toggleStats"]!.click();
    expect(app.store.get("statsPanelVisible")).toBe(false);
  });

  describe("the focus of a statistics rail opened from the keyboard", () => {
    let rail: HTMLElement;

    beforeEach(() => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<div id="stats-rail">
          <div id="stats-rail-tabs" role="tablist" hidden>
            <button id="stats-tab" role="tab" aria-selected="false"></button>
            <button id="flights-tab" role="tab" aria-selected="true"></button>
          </div>
          <div id="stats-panel" tabindex="0"></div>
        </div>`,
      );
      rail = document.getElementById("stats-rail")!;
    });

    afterEach(() => {
      rail.remove();
    });

    // A click from the keyboard has detail 0, one of a pointer at least 1
    const pointerClick = (el: HTMLElement): void => {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    };

    it("goes to the panel while the tabs wait for their code", () => {
      elements["toggleStats"]!.focus();
      elements["toggleStats"]!.click();

      expect(document.activeElement).toBe(
        document.getElementById("stats-panel"),
      );
    });

    it("goes to the selected tab once the tabs show", () => {
      document.getElementById("stats-rail-tabs")!.hidden = false;
      elements["toggleStats"]!.click();

      expect(document.activeElement).toBe(
        document.getElementById("flights-tab"),
      );
    });

    it("stays on the control for a pointer, and on closing", () => {
      elements["toggleStats"]!.focus();
      pointerClick(elements["toggleStats"]!);
      expect(app.store.get("statsPanelVisible")).toBe(true);
      expect(document.activeElement).toBe(elements["toggleStats"]);

      elements["toggleStats"]!.click();
      expect(app.store.get("statsPanelVisible")).toBe(false);
      expect(document.activeElement).toBe(elements["toggleStats"]);
    });
  });

  it("binds the replay transport", async () => {
    elements["toggleReplay"]!.click();
    elements["playReplay"]!.click();
    elements["pauseReplay"]!.click();
    elements["stopReplay"]!.click();
    elements["seekReplay"]!.dispatchEvent(new Event("input"));
    elements["changeReplaySpeed"]!.dispatchEvent(new Event("change"));
    elements["toggleAutoZoom"]!.click();

    // Replay comes from the lazily loaded feature bundle, so the first
    // click reaches the manager a microtask later
    await vi.waitFor(() =>
      expect(app.replayManager.toggleReplay).toHaveBeenCalledTimes(1),
    );
    expect(app.replayManager.playReplay).toHaveBeenCalledTimes(1);
    expect(app.replayManager.pauseReplay).toHaveBeenCalledTimes(1);
    expect(app.replayManager.stopReplay).toHaveBeenCalledTimes(1);
    expect(app.replayManager.seekReplay).toHaveBeenCalledWith("50");
    expect(app.replayManager.changeReplaySpeed).toHaveBeenCalledTimes(1);
    expect(app.replayManager.toggleAutoZoom).toHaveBeenCalledTimes(1);
  });

  it("binds Replay all, which the app fetches with the feature bundle", () => {
    elements["toggleReplayAll"]!.click();

    expect(app.toggleReplayAll).toHaveBeenCalledTimes(1);
  });

  it("binds Cross-section, which the app fetches with the feature bundle", () => {
    elements["toggleCrossSection"]!.click();

    expect(app.toggleCrossSection).toHaveBeenCalledTimes(1);
  });

  it("binds the hotspot tour, which the app fetches with the feature bundle", () => {
    elements["toggleHotspotTour"]!.click();

    expect(app.toggleHotspotTour).toHaveBeenCalledTimes(1);
  });

  it("binds the filters to the change event", () => {
    elements["filterByYear"]!.dispatchEvent(new Event("change"));
    elements["filterByAircraft"]!.dispatchEvent(new Event("change"));

    // The year once the dropdown stops changing (FilterManager.pickYear)
    expect(app.filterManager.pickYear).toHaveBeenCalledTimes(1);
    expect(app.filterManager.filterByAircraft).toHaveBeenCalledTimes(1);
  });

  it("binds the Wrapped dialog", async () => {
    elements["showWrapped"]!.click();
    elements["closeWrapped"]!.click();

    await vi.waitFor(() =>
      expect(app.wrappedManager.showWrapped).toHaveBeenCalledTimes(1),
    );
    // The button plays the intro (see ui/wrappedIntro.ts)
    expect(app.wrappedManager.showWrapped).toHaveBeenCalledWith(true);
    expect(app.wrappedManager.closeWrapped).toHaveBeenCalledTimes(1);
  });

  it("binds the isolate toggle", () => {
    elements["toggleIsolateSelection"]!.click();

    expect(app.pathSelection.toggleIsolateSelection).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown actions", () => {
    expect(() => elements["unknownAction"]!.click()).not.toThrow();
  });

  it("binds Reset view, which waits for the data like the filters", () => {
    elements["resetView"]!.click();
    expect(app.resetView).toHaveBeenCalledTimes(1);

    app.isInitializing = true;
    elements["resetView"]!.click();
    expect(app.resetView).toHaveBeenCalledTimes(1);
  });

  it("logs a Reset view that failed instead of throwing", async () => {
    const error = new Error("reset failed");
    app.resetView.mockRejectedValueOnce(error);

    elements["resetView"]!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(loggerMock.logError).toHaveBeenCalledWith(error);
  });

  it("ignores data-dependent actions while initializing but keeps UI toggles", () => {
    app.isInitializing = true;

    for (const action of DEFERRED_WHILE_INITIALIZING) {
      const element = elements[action];
      if (!element) continue;
      const event =
        element.tagName === "SELECT"
          ? "change"
          : element.tagName === "INPUT"
            ? "input"
            : "click";
      element.dispatchEvent(new Event(event));
    }
    elements["toggleHeatmap"]!.click();
    elements["toggleAltitude"]!.click();
    elements["toggleStats"]!.click();

    expect(app.filterManager.filterByYear).not.toHaveBeenCalled();
    expect(app.filterManager.filterByAircraft).not.toHaveBeenCalled();
    expect(app.replayManager.toggleReplay).not.toHaveBeenCalled();
    expect(app.wrappedManager.showWrapped).not.toHaveBeenCalled();
    expect(app.uiToggles.exportMap).not.toHaveBeenCalled();
    expect(app.pathSelection.toggleIsolateSelection).not.toHaveBeenCalled();
    expect(app.uiToggles.toggleHeatmap).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.toggleAltitude).toHaveBeenCalledTimes(1);
    expect(app.store.get("statsPanelVisible")).toBe(true);
  });
});

describe("runAction", () => {
  let app: MockApp;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createMockApp();
  });

  it("runs an action the way its control does", () => {
    expect(runAction(asMapApp(app), "exportMap")).toBe(true);
    expect(runAction(asMapApp(app), "toggleSatellite")).toBe(true);

    expect(app.uiToggles.exportMap).toHaveBeenCalledTimes(1);
    expect(app.uiToggles.toggleSatellite).toHaveBeenCalledTimes(1);
  });

  it("holds the ones that need data back during the first load, as a click does", () => {
    // The phone's bar called the app directly and skipped this check
    app.isInitializing = true;

    for (const action of DEFERRED_WHILE_INITIALIZING) {
      if (action === "seekReplay") continue;
      expect(runAction(asMapApp(app), action), action).toBe(false);
    }
    expect(runAction(asMapApp(app), "toggleHeatmap")).toBe(true);

    expect(app.resetView).not.toHaveBeenCalled();
    expect(app.uiToggles.exportMap).not.toHaveBeenCalled();
    expect(app.pathSelection.toggleIsolateSelection).not.toHaveBeenCalled();
    expect(app.loadWrapped).not.toHaveBeenCalled();
    expect(app.uiToggles.toggleHeatmap).toHaveBeenCalledTimes(1);
  });

  it("says the flights are still loading for a control that waits for them, but a filter's", () => {
    const showToast = vi.spyOn(toast, "showToast");
    app.isInitializing = true;

    runAction(asMapApp(app), "toggleReplayAll");
    expect(showToast).toHaveBeenCalledExactlyOnceWith(STILL_LOADING_MESSAGE);

    // Applied once the load is over (applyPendingFilterChanges)
    runAction(asMapApp(app), "filterByYear");
    runAction(asMapApp(app), "filterByAircraft");
    expect(showToast).toHaveBeenCalledOnce();
    showToast.mockRestore();
  });

  it("says the flights did not load for what is made of them", () => {
    const showToast = vi.spyOn(toast, "showToast");
    document.body.classList.add("flights-failed");

    for (const action of NEED_DATA) {
      expect(runAction(asMapApp(app), action), action).toBe(false);
    }
    expect(showToast).toHaveBeenCalledTimes(NEED_DATA.size);
    expect(showToast).toHaveBeenLastCalledWith(NO_DATA_MESSAGE);
    expect(app.loadWrapped).not.toHaveBeenCalled();
    // The rest of the controls work, and an open rail can be closed
    expect(runAction(asMapApp(app), "toggleHeatmap")).toBe(true);
    app.statsPanelVisible = true;
    expect(runAction(asMapApp(app), "toggleStats")).toBe(true);

    document.body.classList.remove("flights-failed");
    expect(runAction(asMapApp(app), "showWrapped")).toBe(true);
    showToast.mockRestore();
  });

  it("says so for an action it does not know", () => {
    // A name the page gives, such as a stale template's
    expect(runAction(asMapApp(app), "unknownAction" as ActionName)).toBe(false);
  });
});
