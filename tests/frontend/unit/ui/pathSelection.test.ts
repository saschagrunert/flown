import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CONTROL_COLUMNS,
  ISOLATE_HINT,
  mapChromePadding,
  NOT_SHARED_HINT,
  PathSelection,
  type PickList,
} from "../../../../flown/frontend/ui/pathSelection";
import { resetSafeArea } from "../../../../flown/frontend/utils/safeArea";
import {
  createMockApp,
  createDataset,
  createSegment,
  asMapApp,
  measureSafeArea,
  type MockApp,
} from "../../testHelpers";
import { DataManager } from "../../../../flown/frontend/ui/dataManager";
import { AUTO_ZOOM_FOLLOW } from "../../../../flown/frontend/utils/constants";
import { frameFlights } from "../../../../flown/frontend/ui/frameFlights";
import { loadFeatures } from "../../../../flown/frontend/services/featureLoader";
import { SHARE_FRAME_UNAVAILABLE_MESSAGE } from "../../../../flown/frontend/ui/lazyBundles";

// The data manager is real, so the paths follow the selection the way they
// do in the app; it loads nothing here, and its heat is never drawn
vi.mock("../../../../flown/frontend/services/dataLoader", () => ({
  DataLoader: vi.fn(function () {
    return { destroy: vi.fn(), getDecoder: () => new Promise(() => {}) };
  }),
}));

// The profile of a picked flight comes with the feature bundle, which
// the view waits for before it frames the flight, as the bundle frames it
// (ui/frameFlights.ts): where a fit of the flights starts from
// (cameraForBounds) is what these look at
vi.mock("../../../../flown/frontend/services/featureLoader", () => ({
  loadedFeatures: () => null,
  loadFeatures: vi.fn(() => Promise.resolve({ frameFlights })),
  loadWrapped: vi.fn(),
  noticeSiteUpdate: vi.fn(),
  wasSiteUpdated: () => false,
}));

const toastMock = vi.hoisted(() => ({ announceStatus: vi.fn() }));
vi.mock(
  import("../../../../flown/frontend/utils/toast"),
  async (importOriginal) => ({ ...(await importOriginal()), ...toastMock }),
);

describe("PathSelection", () => {
  let pathSelection: PathSelection;
  let mockApp: MockApp;
  let btn: HTMLButtonElement;
  let chip: HTMLElement;
  let chipCount: HTMLElement;
  let clearBtn: HTMLButtonElement;
  let shareBtn: HTMLButtonElement;
  let linkBtn: HTMLButtonElement;
  let exitBtn: HTMLButtonElement;

  beforeEach(() => {
    vi.clearAllMocks();
    btn = document.createElement("button");
    btn.id = "isolate-btn";
    btn.setAttribute(
      "aria-label",
      "Share mode: show only the selected flights",
    );
    document.body.appendChild(btn);

    chip = document.createElement("div");
    chip.id = "selection-chip";
    chip.hidden = true;
    chipCount = document.createElement("span");
    chipCount.id = "selection-chip-count";
    const chipButton = (id: string): HTMLButtonElement => {
      const button = document.createElement("button");
      button.id = id;
      button.innerHTML = '<span class="control-label"></span>';
      return button;
    };
    shareBtn = chipButton("selection-share-btn");
    linkBtn = chipButton("selection-link-btn");
    exitBtn = chipButton("selection-exit-btn");
    clearBtn = chipButton("selection-clear-btn");
    chip.append(chipCount, shareBtn, linkBtn, exitBtn, clearBtn);
    document.body.appendChild(chip);

    mockApp = createMockApp({
      airportToPaths: {
        EDDF: new Set([1, 2, 3]),
        EDDM: new Set([4, 5]),
      },
      currentData: createDataset([1, 2, 3, 4, 5].map((id) => ({ id }))),
    });
    new DataManager(asMapApp(mockApp)).updateLayers();
    vi.clearAllMocks();
    pathSelection = new PathSelection(asMapApp(mockApp));
  });

  /** How often the layers were rebuilt, and restyled for the selection */
  const rebuilds = (): number =>
    vi.mocked(mockApp.layerManager.syncModes).mock.calls.length;
  const restyles = (): number =>
    vi.mocked(mockApp.layerManager.updateSelectionStyles).mock.calls.length;
  /** Count from here: a test's own setup goes through the store as well */
  const settle = (): void => {
    vi.mocked(mockApp.layerManager.syncModes).mockClear();
    vi.mocked(mockApp.layerManager.updateSelectionStyles).mockClear();
  };

  afterEach(() => {
    btn.remove();
    chip.remove();
    vi.useRealTimers();
  });

  describe("togglePathSelection", () => {
    it("adds path when not selected, as a new selection", () => {
      const before = mockApp.selectedPathIds;
      const listener = vi.fn();
      mockApp.store.subscribe("selectedPathIds", listener);

      pathSelection.togglePathSelection(1);

      expect(mockApp.selectedPathIds.has(1)).toBe(true);
      // The selection of before is left as it was, for whoever holds it
      expect(before.size).toBe(0);
      expect(listener).toHaveBeenCalledWith(mockApp.selectedPathIds, before);
    });

    it("removes path when already selected", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      pathSelection.togglePathSelection(1);

      expect(mockApp.selectedPathIds.has(1)).toBe(false);
    });

    it("restyles the drawn paths in place and leaves the rest to the store", () => {
      mockApp.altitudeVisible = true;
      const listener = vi.fn();
      mockApp.store.subscribe("selectedPathIds", listener);

      pathSelection.togglePathSelection(1);

      expect(restyles()).toBe(1);
      expect(rebuilds()).toBe(0);
      // Statistics, airports and the replay button subscribe to this
      expect(listener).toHaveBeenCalledTimes(1);
      expect(
        mockApp.statsManager.updateStatsForSelection,
      ).not.toHaveBeenCalled();
      expect(mockApp.airportManager.showAirports).not.toHaveBeenCalled();
    });

    it("restyles the paths in share mode, which keep their runs", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.isolateSelection = true;
      settle();

      pathSelection.togglePathSelection(2);

      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
    });

    it("disables share mode when the last path is deselected", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.isolateSelection = true;
      settle();

      pathSelection.togglePathSelection(1);

      expect(mockApp.isolateSelection).toBe(false);
      // Isolate mode filtered the other paths out; they come back with
      // the filter, in one restyle for both keys
      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
    });

    it("lets listeners see the final state of both keys at once", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.isolateSelection = true;
      const seen: [number, boolean][] = [];
      mockApp.store.subscribe("selectedPathIds", () => {
        seen.push([mockApp.selectedPathIds.size, mockApp.isolateSelection]);
      });

      pathSelection.togglePathSelection(1);

      // Never an empty selection that is still isolating
      expect(seen).toEqual([[0, false]]);
    });
  });

  describe("selectPathsByAirport", () => {
    it("selects all paths for an airport", () => {
      pathSelection.selectPathsByAirport("EDDF");

      expect([...mockApp.selectedPathIds]).toEqual([1, 2, 3]);
      expect(restyles()).toBe(1);
    });

    it("adds to an existing selection", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 4]);

      pathSelection.selectPathsByAirport("EDDF");

      expect(mockApp.selectedPathIds.size).toBe(4);
    });

    it("handles airport with no paths gracefully", () => {
      const listener = vi.fn();
      mockApp.store.subscribe("selectedPathIds", listener);

      pathSelection.selectPathsByAirport("NONEXISTENT");

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(listener).not.toHaveBeenCalled();
      // Nothing changed, so nothing is drawn again
      expect(restyles()).toBe(0);
    });

    it("restyles the paths when share mode is active", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 4]);
      mockApp.isolateSelection = true;
      settle();

      pathSelection.selectPathsByAirport("EDDF");

      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
    });

    it("selects only the flights the aircraft filter keeps (regression)", () => {
      const app = createMockApp({
        currentData: createDataset([
          {
            id: 1,
            aircraft_registration: "D-ABCD",
            start_airport: "EDDF",
            end_airport: "EDDM",
          },
          {
            id: 2,
            aircraft_registration: "D-EFGH",
            start_airport: "EDDF",
            end_airport: "EDDK",
          },
        ]),
        selectedAircraft: "D-ABCD",
      });
      const selection = new PathSelection(asMapApp(app));

      selection.selectPathsByAirport("EDDF");

      // The panel read "2 selected paths" beside the one flight on the map
      expect([...app.selectedPathIds]).toEqual([1]);
    });
  });

  describe("clearSelection", () => {
    beforeEach(() => {
      mockApp.selectedPathIds = new Set([1, 2]);
      settle();
    });

    it("clears all selected paths and restyles", () => {
      pathSelection.clearSelection();

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(restyles()).toBe(1);
    });

    it("disables share mode when clearing selection", () => {
      mockApp.isolateSelection = true;
      settle();

      pathSelection.clearSelection();

      expect(mockApp.isolateSelection).toBe(false);
      // Leaving share mode lifts the filter that hid the other paths
      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
    });
  });

  describe("toggleIsolateSelection", () => {
    it("enables share mode when paths are selected and restyles", () => {
      mockApp.selectedPathIds = new Set([1]);
      settle();

      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(true);
      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
    });

    it("disables share mode when toggled again", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.isolateSelection = true;
      settle();

      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(1);
    });

    it("says so when the code that frames the shared flights cannot be loaded", async () => {
      vi.mocked(loadFeatures).mockResolvedValueOnce(null);
      mockApp.selectedPathIds = new Set([1]);

      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(true);
      await vi.waitFor(() =>
        expect(document.querySelector(".toast-notification")?.textContent).toBe(
          SHARE_FRAME_UNAVAILABLE_MESSAGE,
        ),
      );
    });

    it("says how to select when no paths are selected", () => {
      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect(rebuilds()).toBe(0);
      expect(document.querySelector(".toast-notification")?.textContent).toBe(
        ISOLATE_HINT,
      );
    });

    it("frames the isolated flights, and leaves the view alone on the way out", async () => {
      // An isolated flight could stay half off the screen (regression)
      mockApp.currentData = createDataset(
        [{ id: 1 }, { id: 2 }],
        [
          createSegment({
            path_id: 1,
            coords: [
              [50, 8],
              [51, 9],
            ],
          }),
          createSegment({
            path_id: 2,
            coords: [
              [40, 2],
              [41, 3],
            ],
          }),
        ],
      );
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      const map = mockApp.map!;
      map.getBearing.mockReturnValue(30);

      pathSelection.toggleIsolateSelection();

      await vi.waitFor(() => expect(map.easeTo).toHaveBeenCalledTimes(1));
      expect(map.cameraForBounds).toHaveBeenCalledTimes(1);
      const [bounds, options] = map.cameraForBounds.mock.calls[0]!;
      // The selected flight alone, as [lng, lat] corners
      expect(bounds).toEqual([
        [8, 50],
        [9, 51],
      ]);
      expect(options).toMatchObject({ bearing: 30 });
      expect(map.easeTo.mock.calls[0]![0]).toMatchObject({ bearing: 30 });

      pathSelection.toggleIsolateSelection();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(map.cameraForBounds).toHaveBeenCalledTimes(1);
    });

    it("frames the shared flights the filter shows, not the ones it hides", async () => {
      mockApp.currentData = createDataset(
        [
          { id: 1, aircraft_registration: "D-AAAA" },
          { id: 2, aircraft_registration: "D-BBBB" },
        ],
        [
          createSegment({
            path_id: 1,
            coords: [
              [50, 8],
              [51, 9],
            ],
          }),
          createSegment({
            path_id: 2,
            coords: [
              [40, 2],
              [41, 3],
            ],
          }),
        ],
      );
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      mockApp.selectedAircraft = "D-AAAA";
      const map = mockApp.map!;

      pathSelection.toggleIsolateSelection();

      // A flight not drawn widened the frame by a country
      await vi.waitFor(() => expect(map.cameraForBounds).toHaveBeenCalled());
      expect(map.cameraForBounds.mock.calls[0]![0]).toEqual([
        [8, 50],
        [9, 51],
      ]);
    });
  });

  describe("mapChromePadding", () => {
    const rect = (x: number, y: number, w: number, h: number): DOMRect =>
      ({
        x,
        y,
        left: x,
        top: y,
        width: w,
        height: h,
        right: x + w,
        bottom: y + h,
      }) as DOMRect;

    it("keeps a fit clear of the panels at each edge, and no more than a third", () => {
      const map = mockApp.map!;
      vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
        rect(0, 0, 1200, 800),
      );
      const panels: [string, DOMRect][] = [
        // A column at the right edge, 172px wide
        ["right-buttons", rect(1018, 10, 172, 600)],
        // The chip at the top, 38px tall
        ["selection-chip", rect(500, 8, 180, 38)],
        // A tall column at the left, wider than a third of the map
        ["left-buttons", rect(10, 10, 500, 700)],
      ];
      const made = panels.map(([id, box]) => {
        const element =
          document.getElementById(id) ?? document.createElement("div");
        element.id = id;
        element.hidden = false;
        vi.spyOn(element, "getBoundingClientRect").mockReturnValue(box);
        document.body.append(element);
        return element;
      });

      const padding = mapChromePadding(map);

      expect(padding.right).toBe(182 + 24);
      expect(padding.top).toBe(46 + 24);
      expect(padding.left).toBe(400 + 24);
      expect(padding.bottom).toBe(24);
      for (const element of made) if (element !== chip) element.remove();
    });

    it("counts a phone's profile above the bar at the bottom, not at a side", () => {
      // As wide as the map and 81 px up, over the bar and the credit
      const map = mockApp.map!;
      vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
        rect(0, 0, 390, 844),
      );
      const profile = document.createElement("div");
      profile.id = "flight-profile";
      vi.spyOn(profile, "getBoundingClientRect").mockReturnValue(
        rect(8, 635, 374, 128),
      );
      document.body.append(profile);

      const padding = mapChromePadding(map);

      expect(padding.bottom).toBe(209 + 24);
      expect(padding.left).toBe(24);
      expect(padding.right).toBe(24);
      profile.remove();
    });

    it("leaves out the columns on a phone, where the bar replaces them", () => {
      // Measured for the start view before the bar mounts and hides them
      const width = window.innerWidth;
      Object.defineProperty(window, "innerWidth", {
        value: 390,
        configurable: true,
      });
      const map = mockApp.map!;
      vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
        rect(0, 0, 390, 844),
      );
      const column = document.createElement("div");
      column.id = "left-buttons";
      vi.spyOn(column, "getBoundingClientRect").mockReturnValue(
        rect(8, 100, 170, 600),
      );
      document.body.append(column);

      expect(mapChromePadding(map, 48).left).toBe(48);

      Object.defineProperty(window, "innerWidth", {
        value: width,
        configurable: true,
      });
      column.remove();
    });

    it("keeps a fit clear of the safe area where the map fills the screen", () => {
      resetSafeArea();
      // An iPhone's home screen app, held upright: nothing over the map
      measureSafeArea({ top: 59, bottom: 34 });
      const map = mockApp.map!;
      vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
        rect(0, 0, window.innerWidth, window.innerHeight),
      );

      const padding = mapChromePadding(map, 48, CONTROL_COLUMNS);

      expect(padding.top).toBe(59 + 48);
      expect(padding.bottom).toBe(34 + 48);
      expect(padding.left).toBe(48);
      resetSafeArea();
    });

    it("counts the safe area once under a panel placed clear of it", () => {
      resetSafeArea();
      // Held sideways: the island at the left, and the column 8 px beside it
      measureSafeArea({ left: 59, bottom: 21, right: 59 });
      const map = mockApp.map!;
      vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
        rect(0, 0, 1280, 720),
      );
      const column = document.createElement("div");
      column.id = "left-buttons";
      vi.spyOn(column, "getBoundingClientRect").mockReturnValue(
        rect(67, 8, 170, 500),
      );
      document.body.append(column);

      // The column's reach, which takes the inset in, and not 59 + 237
      expect(mapChromePadding(map, 48, CONTROL_COLUMNS).left).toBe(237 + 48);
      column.remove();
      resetSafeArea();
    });

    it("counts only the panels it is given", () => {
      // The start view's columns: a legend that shows with the data would
      // move a Reset view off the first visit's camera
      const map = mockApp.map!;
      vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
        rect(0, 0, 1280, 720),
      );
      const legend = document.createElement("div");
      legend.className = "color-legend";
      vi.spyOn(legend, "getBoundingClientRect").mockReturnValue(
        rect(8, 660, 260, 52),
      );
      document.body.append(legend);

      expect(mapChromePadding(map, 48).bottom).toBe(60 + 48);
      expect(mapChromePadding(map, 48, CONTROL_COLUMNS).bottom).toBe(48);
      legend.remove();
    });

    it("leaves the margin it is given beyond the panels", () => {
      // The start view's, which keeps the heat's glow in view
      const map = mockApp.map!;
      vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
        rect(0, 0, 768, 1024),
      );
      const column = document.createElement("div");
      column.id = "left-buttons";
      vi.spyOn(column, "getBoundingClientRect").mockReturnValue(
        rect(8, 100, 140, 600),
      );
      document.body.append(column);

      const padding = mapChromePadding(map, 48);

      expect(padding.left).toBe(148 + 48);
      expect(padding.top).toBe(48);
      column.remove();
    });
  });

  describe("while replay runs", () => {
    beforeEach(() => {
      mockApp.selectedPathIds = new Set([1]);
      mockApp.replayActive = true;
      settle();
    });

    it("keeps the selection the replay is playing", () => {
      const onChange = vi.fn();
      mockApp.store.subscribe("selectedPathIds", onChange);

      clearBtn.click();
      pathSelection.clearSelection();

      expect([...mockApp.selectedPathIds]).toEqual([1]);
      expect(onChange).not.toHaveBeenCalled();
      expect(rebuilds()).toBe(0);
      expect(restyles()).toBe(0);
    });

    it("ignores Isolate", () => {
      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect(rebuilds()).toBe(0);
    });

    it("ignores a flight picked from a list, alone or added", () => {
      pathSelection.selectFlight(2);
      pathSelection.selectFlight(3, true);

      expect([...mockApp.selectedPathIds]).toEqual([1]);
    });
  });

  describe("while the hotspot tour runs", () => {
    beforeEach(() => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.tourView = {} as NonNullable<MockApp["tourView"]>;
    });

    it("keeps the selection and the mode the tour tours", () => {
      // The tour holds Clear and Share mode; a list and the values of a
      // flight left open on the map reached the selection all the same
      pathSelection.selectFlight(2);
      pathSelection.selectFlight(3, true);
      pathSelection.togglePathSelection(1);
      pathSelection.clearSelection();
      pathSelection.toggleIsolateSelection();
      const list: PickList = { order: [1, 2, 3], anchor: 1 };
      pathSelection.pickFromList(
        3,
        new MouseEvent("click", { shiftKey: true }),
        list,
      );

      expect([...mockApp.selectedPathIds]).toEqual([1]);
      expect(mockApp.isolateSelection).toBe(false);
      // An ignored click is no start of a range
      expect(list.anchor).toBe(1);
    });
  });

  describe("share mode", () => {
    beforeEach(async () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      pathSelection.toggleIsolateSelection();
      // The frame it starts with, which the bundle draws (none here: the
      // flights have no fixes)
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    it("only shows a shared flight picked from a list", async () => {
      mockApp.currentData = createDataset(
        [{ id: 1 }, { id: 2 }],
        [1, 2].map((id) =>
          createSegment({
            path_id: id,
            coords: [
              [50 + id, 8],
              [51 + id, 9],
            ],
          }),
        ),
      );
      const map = mockApp.map!;
      map.cameraForBounds.mockClear();

      // A pick added the flight or took it out of the shared ones, and
      // before that cleared them, which ended the mode
      pathSelection.selectFlight(1);

      expect([...mockApp.selectedPathIds]).toEqual([1, 2]);
      expect(mockApp.isolateSelection).toBe(true);
      // Brought into view alone, once the layout has settled
      await vi.waitFor(() =>
        expect(map.cameraForBounds).toHaveBeenCalledTimes(1),
      );
      expect(map.cameraForBounds.mock.calls[0]![0]).toEqual([
        [8, 51],
        [9, 52],
      ]);
    });

    it("leaves the map alone when it was moved, or the flight went, before the frame", async () => {
      mockApp.currentData = createDataset(
        [{ id: 1 }, { id: 2 }],
        [1, 2].map((id) =>
          createSegment({
            path_id: id,
            coords: [
              [50 + id, 8],
              [51 + id, 9],
            ],
          }),
        ),
      );
      const map = mockApp.map!;
      // The frames the view waits for the layout in (afterLayout), and many
      // more: a fit that was coming has come by the end of them
      vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout"] });
      const settled = (): Promise<unknown> => vi.advanceTimersByTimeAsync(200);
      // Left alone, the flight is framed by then
      pathSelection.selectFlight(1);
      await settled();
      expect(map.cameraForBounds).toHaveBeenCalledTimes(1);
      map.cameraForBounds.mockClear();

      // Moved by hand while the layout settled: the user's map is theirs
      pathSelection.selectFlight(1);
      map.emit("movestart", { originalEvent: new MouseEvent("mousedown") });
      await settled();
      // Taken out of the shared ones meanwhile, by its checkbox
      pathSelection.selectFlight(2);
      pathSelection.togglePathSelection(2);
      await settled();
      // Out of share mode meanwhile, by Exit
      pathSelection.selectFlight(1);
      pathSelection.toggleIsolateSelection();
      await settled();

      expect(map.cameraForBounds).not.toHaveBeenCalled();
    });

    it("says how to add a flight that is not shared, and leaves it out", async () => {
      mockApp.currentData = createDataset(
        [{ id: 1 }, { id: 2 }, { id: 3 }],
        [1, 2, 3].map((id) =>
          createSegment({
            path_id: id,
            coords: [
              [50 + id, 8],
              [51 + id, 9],
            ],
          }),
        ),
      );
      const map = mockApp.map!;
      map.cameraForBounds.mockClear();
      vi.useFakeTimers({ toFake: ["requestAnimationFrame", "setTimeout"] });

      pathSelection.selectFlight(3);

      expect([...mockApp.selectedPathIds]).toEqual([1, 2]);
      expect(
        [...document.querySelectorAll(".toast-notification")].map(
          (toast) => toast.textContent,
        ),
      ).toContain(NOT_SHARED_HINT);
      await vi.advanceTimersByTimeAsync(200);
      expect(map.cameraForBounds).not.toHaveBeenCalled();
      // A shared flight picked the same way is framed within that time
      pathSelection.selectFlight(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(map.cameraForBounds).toHaveBeenCalledTimes(1);
    });

    it("adds or takes out a flight of its checkbox, and ends with the last one", () => {
      pathSelection.selectFlight(3, true);
      expect([...mockApp.selectedPathIds]).toEqual([1, 2, 3]);

      pathSelection.selectFlight(3, true);
      pathSelection.selectFlight(1, true);
      expect([...mockApp.selectedPathIds]).toEqual([2]);
      expect(mockApp.isolateSelection).toBe(true);

      pathSelection.selectFlight(2, true);
      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(mockApp.isolateSelection).toBe(false);
    });

    it("is left with the flights still selected", () => {
      pathSelection.toggleIsolateSelection();

      expect(mockApp.isolateSelection).toBe(false);
      expect([...mockApp.selectedPathIds]).toEqual([1, 2]);
    });
  });

  describe("pickFromList", () => {
    const click = (init: MouseEventInit = {}): MouseEvent =>
      new MouseEvent("click", init);
    let list: PickList;
    beforeEach(() => {
      list = { order: [5, 4, 3, 2, 1], anchor: null };
    });

    it("picks the flight of a plain click alone", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      pathSelection.pickFromList(3, click(), list);

      expect([...mockApp.selectedPathIds]).toEqual([3]);
    });

    it("adds a flight with Ctrl or Cmd, or takes it out", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      pathSelection.pickFromList(3, click({ ctrlKey: true }), list);
      expect([...mockApp.selectedPathIds]).toEqual([1, 3]);

      pathSelection.pickFromList(1, click({ metaKey: true }), list);
      expect([...mockApp.selectedPathIds]).toEqual([3]);
    });

    it("adds or takes out the flight of a checkbox, and ticks it as the selection is", () => {
      // A finger has no Ctrl: the box is how it puts flights together
      const box = document.createElement("input");
      box.type = "checkbox";
      document.body.append(box);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      const tick = (): MouseEvent => {
        const event = click();
        box.addEventListener(
          "click",
          (e) => pathSelection.pickFromList(2, e, list),
          { once: true },
        );
        box.dispatchEvent(event);
        return event;
      };

      tick();
      expect([...mockApp.selectedPathIds]).toEqual([1, 2]);
      expect(box.checked).toBe(true);

      tick();
      expect([...mockApp.selectedPathIds]).toEqual([1]);
      expect(box.checked).toBe(false);

      // Held by a replay, the box goes back to what the selection is
      mockApp.replayActive = true;
      tick();
      expect(box.checked).toBe(false);
      box.remove();
    });

    it("leaves a click on a checkbox's label to the click it makes on the box", () => {
      // pickBox's label: a finger's wide target around the box
      document.body.innerHTML =
        '<div id="row"><label><input type="checkbox"></label></div>';
      const row = document.getElementById("row")!;
      row.addEventListener("click", (e) =>
        pathSelection.pickFromList(2, e, list),
      );
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      row.querySelector("label")!.click();

      // The label's click picked nothing; the box's added the flight
      expect([...mockApp.selectedPathIds]).toEqual([1, 2]);
      expect(row.querySelector("input")!.checked).toBe(true);
      document.body.innerHTML = "";
    });

    it("adds the flights from the one clicked last with Shift, in the list's order", () => {
      pathSelection.pickFromList(4, click(), list);
      pathSelection.pickFromList(2, click({ shiftKey: true }), list);

      expect([...mockApp.selectedPathIds].sort()).toEqual([2, 3, 4]);

      // Backwards as well, from the last click on
      pathSelection.pickFromList(5, click({ shiftKey: true }), list);
      expect([...mockApp.selectedPathIds].sort()).toEqual([2, 3, 4, 5]);
    });

    it("takes a range out with Shift where the row clicked was ticked", () => {
      mockApp.selectedPathIds = new Set([5, 4, 3, 2, 1]);
      list.anchor = 4;

      pathSelection.pickFromList(2, click({ shiftKey: true }), list);

      // What the box of the row goes to, for the whole range: it added
      // the range whatever the box said, and a ticked one stayed ticked
      expect([...mockApp.selectedPathIds].sort()).toEqual([1, 5]);
    });

    it("toggles the row of the range's start alone with Shift", () => {
      list.anchor = 3;

      pathSelection.pickFromList(3, click({ shiftKey: true }), list);
      expect([...mockApp.selectedPathIds]).toEqual([3]);

      // A second Shift on it added it again; it takes it out
      pathSelection.pickFromList(3, click({ shiftKey: true }), list);
      expect(mockApp.selectedPathIds.size).toBe(0);
    });

    it("ends share mode with a range that takes the last shared flights out", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 3]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 4]);
      mockApp.isolateSelection = true;
      list.anchor = 4;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = true;
      document.body.append(box);
      const seen: [number, boolean][] = [];
      mockApp.store.subscribe("selectedPathIds", () => {
        seen.push([mockApp.selectedPathIds.size, mockApp.isolateSelection]);
      });
      box.addEventListener(
        "click",
        (e) => pathSelection.pickFromList(3, e, list),
        { once: true },
      );

      box.dispatchEvent(click({ shiftKey: true }));

      expect(mockApp.selectedPathIds.size).toBe(0);
      // Never an empty selection still shared
      expect(seen).toEqual([[0, false]]);
      box.remove();
    });

    it("keeps a start of the range for each list", () => {
      const other: PickList = { order: [1, 2, 3], anchor: null };

      pathSelection.pickFromList(5, click({ ctrlKey: true }), list);
      pathSelection.pickFromList(1, click({ ctrlKey: true }), other);

      expect(list.anchor).toBe(5);
      expect(other.anchor).toBe(1);
      // From 5 in this list's order, not from 1 of the other one's
      pathSelection.pickFromList(3, click({ shiftKey: true }), list);
      expect([...mockApp.selectedPathIds].sort()).toEqual([1, 3, 4, 5]);
    });

    it("adds the flights of a range in one update", () => {
      pathSelection.pickFromList(5, click(), list);
      const updates = vi.fn();
      mockApp.store.subscribe("selectedPathIds", updates);

      pathSelection.pickFromList(1, click({ shiftKey: true }), list);

      expect(updates).toHaveBeenCalledOnce();
      expect(mockApp.selectedPathIds.size).toBe(5);
    });

    it("adds the one flight with Shift where no click came before in the list", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      pathSelection.pickFromList(3, click({ shiftKey: true }), {
        order: [3, 2],
        anchor: null,
      });

      expect([...mockApp.selectedPathIds]).toEqual([1, 3]);
    });

    it("changes the flights of share mode with the checkbox alone", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.isolateSelection = true;
      const box = document.createElement("input");
      box.type = "checkbox";
      document.body.append(box);
      const tick = (init: MouseEventInit = {}): void => {
        box.addEventListener(
          "click",
          (e) => pathSelection.pickFromList(3, e, list),
          { once: true },
        );
        box.dispatchEvent(click(init));
      };

      // A row, with or without a key held, only shows its flight, and is
      // no start of a range
      list.anchor = 5;
      pathSelection.pickFromList(4, click(), list);
      pathSelection.pickFromList(2, click({ ctrlKey: true }), list);
      pathSelection.pickFromList(2, click({ metaKey: true }), list);
      pathSelection.pickFromList(1, click({ shiftKey: true }), list);
      expect([...mockApp.selectedPathIds]).toEqual([1]);
      expect(list.anchor).toBe(5);

      // Its box adds a range with Shift, from the box ticked last
      tick({ shiftKey: true });
      expect([...mockApp.selectedPathIds].sort()).toEqual([1, 3, 4, 5]);
      expect(box.checked).toBe(true);
      expect(mockApp.isolateSelection).toBe(true);
      box.remove();
    });
  });

  describe("selectFlight", () => {
    it("selects just the flight", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);

      pathSelection.selectFlight(3);

      expect([...mockApp.selectedPathIds]).toEqual([3]);
    });

    it("keeps the flight alone when it is one of several", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);

      pathSelection.selectFlight(2);

      expect([...mockApp.selectedPathIds]).toEqual([2]);
    });

    it("selects nothing when the flight is the whole selection", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);

      pathSelection.selectFlight(2);

      expect(mockApp.selectedPathIds.size).toBe(0);
    });

    it("swaps the selection in one update, announced once", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 3]);
      toastMock.announceStatus.mockClear();
      const updates = vi.fn();
      mockApp.store.subscribe("selectedPathIds", updates);

      pathSelection.selectFlight(2);

      expect(updates).toHaveBeenCalledOnce();
      expect(toastMock.announceStatus).toHaveBeenCalledExactlyOnceWith(
        "1 flight selected",
      );
    });

    it("adds the flight to the selection, or takes it out", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      pathSelection.selectFlight(2, true);
      expect([...mockApp.selectedPathIds]).toEqual([1, 2]);

      pathSelection.selectFlight(1, true);
      expect([...mockApp.selectedPathIds]).toEqual([2]);
    });

    describe("bringing the flight into view", () => {
      const box = (x: number, y: number, w: number, h: number): DOMRect =>
        ({
          x,
          y,
          left: x,
          top: y,
          width: w,
          height: h,
          right: x + w,
          bottom: y + h,
        }) as DOMRect;
      /** Where the map draws the west end of the flights */
      let drawnAt: { x: number; y: number };
      /** How wide the map draws a degree of longitude, in pixels */
      let degreePx: number;
      let profile: HTMLElement;
      /** The bundle, and the two frames the layout takes after it */
      const settled = async (): Promise<void> => {
        for (let i = 0; i < 4; i++) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      };

      beforeEach(() => {
        mockApp.currentData = createDataset(
          [{ id: 1 }, { id: 2 }, { id: 3 }],
          [1, 2, 3].map((id) =>
            createSegment({
              path_id: id,
              coords: [
                [50 + id, 8],
                [51 + id, 9],
              ],
            }),
          ),
        );
        const map = mockApp.map!;
        vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
          box(0, 0, 1200, 800),
        );
        drawnAt = { x: 600, y: 300 };
        degreePx = 400;
        map.project.mockImplementation((lngLat) => ({
          x: drawnAt.x + ((lngLat as [number, number])[0] - 8) * degreePx,
          y: drawnAt.y,
        }));
        // The profile of the picked flight, at the bottom of the map
        profile = document.createElement("div");
        profile.id = "flight-profile";
        vi.spyOn(profile, "getBoundingClientRect").mockReturnValue(
          box(360, 660, 560, 113),
        );
        document.body.append(profile);
        vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(
          (callback) => setTimeout(() => callback(0), 0) as unknown as number,
        );
      });

      afterEach(() => {
        profile.remove();
        vi.mocked(globalThis.requestAnimationFrame).mockRestore();
      });

      it("frames a flight picked from a list that is off the map", async () => {
        drawnAt = { x: -400, y: 300 };

        pathSelection.selectFlight(2);
        await settled();

        const map = mockApp.map!;
        expect(map.cameraForBounds).toHaveBeenCalledTimes(1);
        const [bounds, options] = map.cameraForBounds.mock.calls[0]!;
        expect(bounds).toEqual([
          [8, 52],
          [9, 53],
        ]);
        // Clear of the profile under it
        expect(options).toMatchObject({ padding: { bottom: 140 + 24 } });
      });

      it("fits a flight picked from a list flat when the bundle cannot be loaded", async () => {
        drawnAt = { x: -400, y: 300 };
        vi.mocked(loadFeatures).mockResolvedValueOnce(null);

        pathSelection.selectFlight(2);
        await settled();

        const map = mockApp.map!;
        expect(map.cameraForBounds).not.toHaveBeenCalled();
        expect(map.fitBounds).toHaveBeenCalledWith(
          [
            [8, 52],
            [9, 53],
          ],
          { padding: expect.any(Object) as unknown },
        );
      });

      it("frames one under its own profile", async () => {
        drawnAt = { x: 600, y: 700 };

        pathSelection.selectFlight(2);
        await settled();

        expect(mockApp.map!.cameraForBounds).toHaveBeenCalledTimes(1);
      });

      it("leaves the map alone when all of the flight is in view", async () => {
        pathSelection.selectFlight(2);
        await settled();

        expect(mockApp.map!.cameraForBounds).not.toHaveBeenCalled();
      });

      it("leaves a flight across the antimeridian alone when all of it is in view", async () => {
        // From 179.9 E to 179.9 W, drawn on the copy of the world east of
        // 180 that the map shows
        mockApp.currentData = createDataset(
          [{ id: 2 }],
          [
            createSegment({
              path_id: 2,
              coords: [
                [52, 179.9],
                [53, -179.9],
              ],
            }),
          ],
        );
        const map = mockApp.map!;
        map.jumpTo({ center: [180, 52.5] });
        map.project.mockImplementation((lngLat) => ({
          x: 600 + ((lngLat as [number, number])[0] - 180) * 2000,
          y: 300,
        }));

        pathSelection.selectFlight(2);
        await settled();

        expect(map.cameraForBounds).not.toHaveBeenCalled();
      });

      it("frames one in view that is too small to be seen there", async () => {
        // A circuit round the field, a speck in the middle of the heat
        degreePx = 20;

        pathSelection.selectFlight(2);
        await settled();

        expect(mockApp.map!.cameraForBounds).toHaveBeenCalledTimes(1);
        // A flight of a few fixes on a field is not framed closer than a
        // replay follows one
        expect(mockApp.map!.cameraForBounds.mock.calls[0]![1]).toMatchObject({
          maxZoom: AUTO_ZOOM_FOLLOW,
        });
      });

      it("hands the map on a phone the flight picked from the statistics or an airport", () => {
        mockApp.statsPanelVisible = true;
        mockApp.mobileBar = {
          isVisible: () => true,
        } as unknown as typeof mockApp.mobileBar;

        pathSelection.selectFlight(2);

        expect(mockApp.statsPanelVisible).toBe(false);
        expect(mockApp.airportManager.closePopup).toHaveBeenCalledOnce();

        // Not for one added, nor on the desktop, where both stand beside it
        mockApp.statsPanelVisible = true;
        pathSelection.selectFlight(3, true);
        mockApp.mobileBar = null;
        pathSelection.selectFlight(1);
        expect(mockApp.statsPanelVisible).toBe(true);
        expect(mockApp.airportManager.closePopup).toHaveBeenCalledOnce();
      });

      it("leaves it alone for a flight added, taken out, or clicked on the map", async () => {
        drawnAt = { x: -400, y: 300 };

        pathSelection.selectFlight(2, true);
        pathSelection.selectFlight(2, true);
        // A click on a path: the user is looking at it
        pathSelection.togglePathSelection(3);
        // The whole selection, picked again: nothing is selected then
        mockApp.selectedPathIds = new Set();
        mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
        pathSelection.selectFlight(1);
        await settled();

        expect(mockApp.map!.cameraForBounds).not.toHaveBeenCalled();
      });

      it("leaves the map to a user who moved it while it waited", async () => {
        drawnAt = { x: -400, y: 300 };
        const map = mockApp.map!;

        pathSelection.selectFlight(2);
        map.emit("movestart", { originalEvent: new MouseEvent("mousedown") });
        await settled();

        expect(map.cameraForBounds).not.toHaveBeenCalled();

        // A move of the app's own is not the user's
        pathSelection.selectFlight(3);
        map.emit("movestart", {});
        await settled();

        expect(map.cameraForBounds).toHaveBeenCalledTimes(1);
      });

      it("leaves the map to the hotspot tour and Wrapped", async () => {
        drawnAt = { x: -400, y: 300 };

        mockApp.tourView = {} as never;
        pathSelection.selectFlight(2);
        await settled();
        mockApp.tourView = null;
        mockApp.wrappedVisible = true;
        pathSelection.selectFlight(3);
        await settled();

        expect(mockApp.map!.cameraForBounds).not.toHaveBeenCalled();
      });

      it("leaves it alone when the selection changed while it waited", async () => {
        drawnAt = { x: -400, y: 300 };

        pathSelection.selectFlight(2);
        pathSelection.togglePathSelection(3);
        await settled();

        expect(mockApp.map!.cameraForBounds).not.toHaveBeenCalled();
      });
    });
  });

  describe("markSelected", () => {
    it("ticks the checkboxes of the selected flights only", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      const boxes = [1, 2].map((id) => {
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset["pathId"] = String(id);
        return box;
      });

      pathSelection.markSelected(boxes);

      expect(boxes.map((b) => b.checked)).toEqual([true, false]);
      expect(boxes[0]!.hasAttribute("aria-pressed")).toBe(false);
    });

    it("presses the buttons of the selected flights only", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 2]);
      const buttons = [1, 2].map((id) => {
        const button = document.createElement("button");
        button.dataset["pathId"] = String(id);
        return button;
      });

      pathSelection.markSelected(buttons);

      expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
        "false",
        "true",
      ]);
    });
  });

  describe("selection chip", () => {
    it("stays out of the way while nothing is selected", () => {
      expect(chip.hidden).toBe(true);
      expect(chipCount.textContent).toBe("");
    });

    it("counts the selection", () => {
      // A selection is only drawn where the paths are, so at the zoom
      // levels that show the heat bloom alone this is all there is to see
      pathSelection.togglePathSelection(1);

      expect(chip.hidden).toBe(false);
      expect(chipCount.textContent).toBe("1 flight selected");

      pathSelection.togglePathSelection(2);

      expect(chipCount.textContent).toBe("2 flights selected");
    });

    it("goes away with the selection", () => {
      pathSelection.togglePathSelection(1);
      pathSelection.togglePathSelection(1);

      expect(chip.hidden).toBe(true);
    });

    it("says the selection is cleared, where its going said nothing", () => {
      pathSelection.togglePathSelection(1);
      expect(toastMock.announceStatus).toHaveBeenLastCalledWith(
        "1 flight selected",
      );

      clearBtn.click();

      expect(toastMock.announceStatus).toHaveBeenLastCalledWith(
        "Selection cleared",
      );
    });

    it("clears the selection from its own control", () => {
      pathSelection.togglePathSelection(1);

      clearBtn.click();

      expect(mockApp.selectedPathIds.size).toBe(0);
      expect(chip.hidden).toBe(true);
    });

    it("hands the focus of its Clear to the map before it hides", () => {
      // Hidden with its own chip, the focused Clear dropped focus to <body>
      const canvas = mockApp.map!.getCanvas();
      canvas.tabIndex = 0;
      document.body.append(canvas);
      pathSelection.togglePathSelection(1);
      clearBtn.focus();

      clearBtn.click();

      expect(document.activeElement).toBe(canvas);
      canvas.remove();
    });

    it("counts in groups of thousands", () => {
      mockApp.selectedPathIds = new Set(
        Array.from({ length: 1200 }, (_, i) => i + 1),
      );

      expect(chipCount.textContent).toBe("1,200 flights selected");
      // The narrowest phones leave out the word in .selection-chip-tail
      expect(chipCount.firstChild!.textContent).toBe("1,200 flights");
      expect(chipCount.lastElementChild!.className).toBe("selection-chip-tail");

      mockApp.selectedPathIds = new Set();
      expect(chipCount.textContent).toBe("");
    });

    it("says how many shared flights the filter hides, all of them too", () => {
      mockApp.currentData = createDataset([
        { id: 1, aircraft_registration: "D-AAAA" },
        { id: 2, aircraft_registration: "D-BBBB" },
        { id: 3, aircraft_registration: "D-BBBB" },
      ]);
      pathSelection.togglePathSelection(1);
      pathSelection.togglePathSelection(2);
      pathSelection.togglePathSelection(3);
      pathSelection.toggleIsolateSelection();
      expect(chipCount.textContent).toBe("Sharing 3 flights");

      mockApp.selectedAircraft = "D-AAAA";
      expect(chipCount.textContent).toBe(
        "Sharing 3 flights, 2 hidden by the filter",
      );
      // A phone leaves out the words in .selection-chip-word
      expect(
        [...chipCount.childNodes]
          .filter(
            (node) =>
              !(node instanceof Element) ||
              !node.classList.contains("selection-chip-word"),
          )
          .map((node) => node.textContent)
          .join(""),
      ).toBe("3 flights, 2 hidden");

      mockApp.selectedAircraft = "D-XXXX";
      expect(chipCount.textContent).toBe(
        "Sharing 3 flights, all hidden by the filter",
      );
      expect(mockApp.isolateSelection).toBe(true);

      // Outside share mode the filter has deselected them already
      mockApp.isolateSelection = false;
      expect(chipCount.textContent).toBe("3 flights selected");
    });

    it("says a shared flight a year's dataset lacks is not in that year, the one it may be gone from", () => {
      // The year's file cannot tell another year's flight from one a
      // re-export removed: "hidden by the filter" was not so
      mockApp.currentData = createDataset([
        { id: 1, year: 2025, aircraft_registration: "D-AAAA" },
        { id: 2, year: 2025, aircraft_registration: "D-BBBB" },
      ]);
      mockApp.selectedYear = "2025";
      pathSelection.togglePathSelection(1);
      pathSelection.togglePathSelection(99);
      pathSelection.toggleIsolateSelection();
      expect(chipCount.textContent).toBe("Sharing 2 flights, 1 not in 2025");

      // One the year lacks and one the aircraft hides
      mockApp.selectedAircraft = "D-BBBB";
      expect(chipCount.textContent).toBe("Sharing 2 flights, none shown");

      mockApp.selectedAircraft = "all";
      pathSelection.togglePathSelection(1);
      pathSelection.togglePathSelection(98);
      expect(chipCount.textContent).toBe("Sharing 2 flights, none in 2025");
    });

    it("deselects on Exit what the filter hides, as a filter change does outside share mode", () => {
      mockApp.currentData = createDataset([
        { id: 1, aircraft_registration: "D-AAAA" },
        { id: 2, aircraft_registration: "D-BBBB" },
      ]);
      pathSelection.togglePathSelection(1);
      pathSelection.togglePathSelection(2);
      pathSelection.toggleIsolateSelection();
      mockApp.selectedAircraft = "D-AAAA";
      const seen: [number, boolean][] = [];
      mockApp.store.subscribe("selectedPathIds", () =>
        seen.push([mockApp.selectedPathIds.size, mockApp.isolateSelection]),
      );

      // Exit: "2 flights selected" stayed with one drawn
      pathSelection.toggleIsolateSelection();

      expect([...mockApp.selectedPathIds]).toEqual([1]);
      expect(mockApp.isolateSelection).toBe(false);
      expect(seen).toEqual([[1, false]]);
      expect(chipCount.textContent).toBe("1 flight selected");
      expect(
        [...document.querySelectorAll(".toast-notification")].map(
          (toast) => toast.textContent,
        ),
      ).toContain(
        "1 selected flight is hidden by the filter and was deselected",
      );
    });

    it("offers Share and Clear outside share mode, the link and Exit in it", () => {
      const shown = (): string[] =>
        [shareBtn, linkBtn, exitBtn, clearBtn]
          .filter((button) => !button.hidden)
          .map((button) => button.id);
      pathSelection.togglePathSelection(1);
      pathSelection.togglePathSelection(2);
      expect(shown()).toEqual(["selection-share-btn", "selection-clear-btn"]);

      shareBtn.addEventListener("click", () =>
        pathSelection.toggleIsolateSelection(),
      );
      shareBtn.click();

      expect(mockApp.isolateSelection).toBe(true);
      expect(chipCount.textContent).toBe("Sharing 2 flights");
      // A phone shows the mark of the chip in place of the word
      expect(chip.classList.contains("is-sharing")).toBe(true);
      expect(chipCount.querySelector(".selection-chip-word")?.textContent).toBe(
        "Sharing ",
      );
      expect(toastMock.announceStatus).toHaveBeenLastCalledWith(
        "Sharing 2 flights",
      );
      expect(shown()).toEqual(["selection-link-btn", "selection-exit-btn"]);
      expect(linkBtn.textContent).toBe("Copy link");
      // Named by what it says, for speech input
      expect(linkBtn.getAttribute("aria-label")).toBe(
        "Copy link to these flights",
      );

      mockApp.isolateSelection = false;
      expect(chipCount.textContent).toBe("2 flights selected");
      expect(chip.classList.contains("is-sharing")).toBe(false);
      expect(shown()).toEqual(["selection-share-btn", "selection-clear-btn"]);
    });

    it("names the link anew as the layout crosses the phone's breakpoint", () => {
      const listeners: ((event: { matches: boolean }) => void)[] = [];
      let phone = false;
      const matchMedia = vi.fn(() => ({
        get matches() {
          return phone;
        },
        addEventListener: (
          _: string,
          listener: (event: { matches: boolean }) => void,
        ) => listeners.push(listener),
        removeEventListener: vi.fn(),
      }));
      vi.stubGlobal("matchMedia", matchMedia);
      Object.defineProperty(navigator, "share", {
        value: vi.fn(),
        configurable: true,
      });
      try {
        new PathSelection(asMapApp(mockApp));
        expect(linkBtn.textContent).toBe("Copy link");

        // Turned or narrowed into the phone layout, nothing selected anew
        phone = true;
        for (const listener of listeners) listener({ matches: true });

        expect(linkBtn.textContent).toBe("Share link");
        expect(linkBtn.getAttribute("aria-label")).toBe(
          "Share link to these flights",
        );
      } finally {
        vi.unstubAllGlobals();
        Reflect.deleteProperty(navigator, "share");
      }
    });

    it("keeps the link's title saying why it cannot on the visitor's flights", () => {
      // Set by Your flights as the page started (ui/localFlights.ts)
      mockApp.config.localFlights = {} as NonNullable<
        typeof mockApp.config.localFlights
      >;
      linkBtn.title =
        "Links cannot carry flights that are only in this browser";

      pathSelection.togglePathSelection(1);
      mockApp.isolateSelection = true;

      expect(linkBtn.title).toBe(
        "Links cannot carry flights that are only in this browser",
      );
      mockApp.config.localFlights = undefined;
    });

    it("hands the focus on to the button that takes the place of the one pressed", () => {
      pathSelection.togglePathSelection(1);
      shareBtn.focus();

      mockApp.isolateSelection = true;
      expect(document.activeElement).toBe(exitBtn);

      mockApp.isolateSelection = false;
      expect(document.activeElement).toBe(shareBtn);
    });
  });

  describe("share mode button", () => {
    it("is announced as unavailable without a selection, and stays focusable", () => {
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.disabled).toBe(false);
      expect(btn.title).toBe("Select flights to share");

      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      expect(btn.getAttribute("aria-disabled")).toBe("false");
      expect(btn.title).toBe("Share mode: show only the selected flights");

      mockApp.isolateSelection = true;
      expect(btn.getAttribute("aria-disabled")).toBe("false");
    });

    it("is unavailable and not pressed at construction without a selection", () => {
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.classList.contains("active")).toBe(false);
      // The look comes from the stylesheet, not from inline styles
      expect(btn.style.opacity).toBe("");
      expect(btn.style.borderColor).toBe("");
      expect(btn.style.backgroundColor).toBe("");
    });

    it("reflects a restored selection and mode at construction", () => {
      const app = createMockApp({
        selectedPathIds: new Set([1]),
        isolateSelection: true,
      });

      new PathSelection(asMapApp(app));

      expect(btn.getAttribute("aria-disabled")).toBe("false");
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.classList.contains("active")).toBe(true);
    });

    it("lights up when paths are selected and stays unpressed", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      expect(btn.getAttribute("aria-disabled")).toBe("false");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.classList.contains("active")).toBe(false);
    });

    it("follows share mode through the store", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);

      mockApp.isolateSelection = true;
      expect(btn.getAttribute("aria-pressed")).toBe("true");
      expect(btn.classList.contains("active")).toBe(true);
      expect(btn.getAttribute("aria-disabled")).toBe("false");

      mockApp.isolateSelection = false;
      expect(btn.getAttribute("aria-pressed")).toBe("false");
      expect(btn.getAttribute("aria-disabled")).toBe("false");
    });

    it("is unavailable again once the selection is cleared", () => {
      mockApp.selectedPathIds = new Set([...mockApp.selectedPathIds, 1]);
      expect(btn.getAttribute("aria-disabled")).toBe("false");

      pathSelection.clearSelection();

      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(btn.getAttribute("aria-pressed")).toBe("false");
    });

    it("does nothing when the button is missing", () => {
      btn.remove();
      expect(() => pathSelection.updateIsolateButton()).not.toThrow();
      expect(() => {
        mockApp.selectedPathIds = new Set([1]);
      }).not.toThrow();
    });
  });
});
