/**
 * MobileBar: mounting rules, the five tabs and the sheets they open.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { MapApp } from "../../../../flown/frontend/mapApp";
import type { KMLDataset } from "../../../../flown/frontend/types";
import {
  AppStore,
  defineStoreAccessors,
  type StoreAccessors,
} from "../../../../flown/frontend/state/store";
import { MobileBar } from "../../../../flown/frontend/ui/mobileBar";
import { REPLAY_PRECONDITION_MESSAGE } from "../../../../flown/frontend/ui/replayButton";
import { NO_DATA_MESSAGE } from "../../../../flown/frontend/ui/actions";
import { MOBILE_BREAKPOINT_PX } from "../../../../flown/frontend/utils/constants";
import { PHONE_LAYOUT_QUERY } from "../../../../flown/frontend/utils/device";

const PHONE_WIDTH = 390;
const DESKTOP_WIDTH = 1200;

/** Button groups the bar replaces */
const LEGACY_IDS = ["left-buttons", "right-buttons"];

let mqlListeners: Set<(e: MediaQueryListEvent) => void>;
let mqlMatches: boolean;

function setupMatchMedia(): void {
  mqlListeners = new Set();
  mqlMatches = false;
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn((_query: string) => ({
      get matches() {
        return mqlMatches;
      },
      addEventListener(_type: string, cb: (e: MediaQueryListEvent) => void) {
        mqlListeners.add(cb);
      },
      removeEventListener(_type: string, cb: (e: MediaQueryListEvent) => void) {
        mqlListeners.delete(cb);
      },
    })),
    configurable: true,
    writable: true,
  });
}

function setWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
    writable: true,
  });
  const matches = width < MOBILE_BREAKPOINT_PX;
  if (matches !== mqlMatches) {
    mqlMatches = matches;
    for (const cb of mqlListeners) {
      cb({ matches } as MediaQueryListEvent);
    }
  }
}

function createMockApp() {
  const store = new AppStore({ hasTimingData: true });
  const wrappedManager = { showWrapped: vi.fn() };
  const replayManager = { toggleReplay: vi.fn() };
  const app = {
    store,
    uiToggles: {
      toggleHeatmap: vi.fn(),
      toggleAirports: vi.fn(),
      toggleAltitude: vi.fn(),
      toggleAirspeed: vi.fn(),
      toggleAviation: vi.fn(),
      toggleSatellite: vi.fn(),
      exportMap: vi.fn(),
      shareLink: vi.fn(() => Promise.resolve()),
    },
    mapOrientation: { toggleGlobe: vi.fn(), toggleThreeD: vi.fn() },
    wrappedManager,
    pathSelection: { toggleIsolateSelection: vi.fn() },
    replayManager,
    // Replay and Wrapped come from lazily loaded bundles; the
    // bar asks the app for them and for whether replay is possible at all
    canReplay: vi.fn(() => true),
    replayHint: vi.fn((): string | null => null),
    loadReplay: vi.fn(() => Promise.resolve(replayManager)),
    toggleReplay: vi.fn(() => {
      replayManager.toggleReplay();
    }),
    loadWrapped: vi.fn(() => Promise.resolve(wrappedManager)),
    // The hotspot tour, which the app fetches with the feature bundle
    toggleHotspotTour: vi.fn(),
    resetView: vi.fn(() => Promise.resolve()),
    // Something to reset unless a test says otherwise
    isReset: vi.fn(() => false),
    // The first load is over unless a test says otherwise; the bar runs the
    // actions that need data through the same check as the desktop controls
    isInitializing: false,
    canResetView(): boolean {
      return this.resetViewReason() === null;
    },
    resetViewReason(): string | null {
      if (this.isInitializing) return "Still loading the flights";
      return this.isReset() ? "Nothing to reset" : null;
    },
  };
  // The same accessors as the app's, so the bar reads the store through them
  defineStoreAccessors(app);
  return app as typeof app & StoreAccessors;
}

type BarMockApp = ReturnType<typeof createMockApp>;

function mountPageChrome(): void {
  for (const id of LEGACY_IDS) {
    const group = document.createElement("div");
    group.id = id;
    document.body.append(group);
  }

  const airspeed = document.createElement("button");
  airspeed.id = "airspeed-btn";
  document.body.append(airspeed);

  // Shaped like the template plus what the app appends at load: the
  // unfiltered option names the filter, and no label carries an emoji
  for (const [id, all, rest] of [
    ["year-select", "All years", ["2024", "2025"]],
    ["aircraft-select", "All aircraft", ["D-EABC (C172)"]],
  ] as [string, string, string[]][]) {
    const select = document.createElement("select");
    select.id = id;
    for (const [value, label] of [["all", all], ...rest.map((r) => [r, r])]) {
      const option = document.createElement("option");
      option.value = value!;
      option.textContent = label!;
      select.append(option);
    }
    document.body.append(select);
  }
}

function tab(id: string): HTMLButtonElement {
  const element = document.getElementById("mobile-tab-" + id);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Missing tab ${id}`);
  }
  return element;
}

function sheetRows(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>(".mobile-sheet .sheet-row"),
  ).map((row) => row.dataset["row"] ?? "");
}

function sheetTitle(): string {
  return document.querySelector(".sheet-title")?.textContent ?? "";
}

/** Dismiss the open sheet the way the user does */
function dismissSheet(): void {
  document.querySelector<HTMLButtonElement>(".sheet-close")!.click();
}

describe("MobileBar", () => {
  let app: BarMockApp;
  let bar: MobileBar | null;

  const create = (): MobileBar => {
    const created = MobileBar.mountFor(app as unknown as MapApp);
    if (!created) throw new Error("MobileBar was not created");
    bar = created;
    return created;
  };

  beforeEach(() => {
    setupMatchMedia();
    mqlMatches = true;
    Object.defineProperty(window, "innerWidth", {
      value: PHONE_WIDTH,
      configurable: true,
      writable: true,
    });
    mountPageChrome();
    app = createMockApp();
    bar = null;
  });

  afterEach(() => {
    bar?.destroy();
    document.body.replaceChildren();
    document.body.className = "";
    setWidth(1024);
  });

  describe("mounting", () => {
    it("mounts below the breakpoint", () => {
      create();

      expect(document.querySelector(".mobile-bar")).not.toBeNull();
    });

    it("asks for the one breakpoint the whole app uses", () => {
      create();

      // Just under it, like the stylesheet's max-width queries
      expect(window.matchMedia).toHaveBeenCalledWith(PHONE_LAYOUT_QUERY);
      expect(PHONE_LAYOUT_QUERY).toBe(
        "(max-width: 767.98px), (max-height: 480px)",
      );
    });

    it("stays out of the document above the breakpoint", () => {
      mqlMatches = false;
      Object.defineProperty(window, "innerWidth", {
        value: MOBILE_BREAKPOINT_PX,
        configurable: true,
        writable: true,
      });

      const created = create();

      expect(created.isMounted()).toBe(false);
      expect(document.querySelector(".mobile-bar")).toBeNull();
    });

    it("takes the floating button groups out of reach", () => {
      const created = create();
      for (const id of LEGACY_IDS) {
        // The stylesheet turns the attribute into `display: none`; nothing
        // inline is written, so hideControls() keeps sole ownership of that
        expect(document.getElementById(id)!.hidden).toBe(true);
      }

      created.destroy();

      for (const id of LEGACY_IDS) {
        expect(document.getElementById(id)!.hidden).toBe(false);
      }
    });

    it("keeps the groups out of reach while replay owns the bottom edge", () => {
      const created = create();

      app.store.set("replayActive", true);

      // The bar leaves the document, so a `body:has(.mobile-bar)` rule would
      // stop matching here; the attribute the stylesheet keys off must stay
      expect(document.contains(created.root)).toBe(false);
      for (const id of LEGACY_IDS) {
        expect(document.getElementById(id)!.hidden).toBe(true);
      }
    });

    it("never writes the inline display of the groups", () => {
      // hideControls()/restoreControls() own it while Wrapped is open or an
      // export is in flight; the stylesheet hides the groups on its own
      const groups = LEGACY_IDS.map((id) => document.getElementById(id)!);
      for (const group of groups) group.style.display = "block";

      const created = create();
      for (const group of groups) expect(group.style.display).toBe("block");

      created.destroy();
      for (const group of groups) expect(group.style.display).toBe("block");
    });

    it("survives a rotation taken while Wrapped hid the controls", () => {
      const groups = LEGACY_IDS.map((id) => document.getElementById(id)!);
      setWidth(DESKTOP_WIDTH);
      const created = create();

      // Wrapped opens: hideControls() saves the current display and blanks it
      const saved = groups.map((group) => group.style.display);
      for (const group of groups) group.style.display = "none";
      // The phone is rotated into portrait while Wrapped is still open
      setWidth(PHONE_WIDTH);
      // Escape dismisses Wrapped: restoreControls() puts back what it saved
      groups.forEach((group, index) => {
        group.style.display = saved[index] ?? "";
      });
      // ...and the phone goes back to landscape
      setWidth(DESKTOP_WIDTH);

      // A snapshot taken at mount would have captured Wrapped's "none" and
      // restored it here, stranding every desktop control until a reload
      expect(created.isMounted()).toBe(false);
      for (const group of groups) {
        expect(group.hidden).toBe(false);
        expect(group.style.display).toBe("");
      }
    });

    it("follows the viewport across the breakpoint", () => {
      setWidth(DESKTOP_WIDTH);
      const created = create();

      setWidth(PHONE_WIDTH);
      expect(created.isMounted()).toBe(true);

      setWidth(DESKTOP_WIDTH);
      expect(created.isMounted()).toBe(false);
      expect(document.querySelector(".mobile-sheet")).toBeNull();
    });

    it("hands the focus of a tab to the column's control as it goes", () => {
      // Turned across the breakpoint with a sheet open: closing it handed
      // the focus to its tab, which left the page with it (regression)
      const heatmap = document.createElement("button");
      heatmap.id = "heatmap-btn";
      document.body.append(heatmap);
      create();
      tab("layers").click();
      tab("layers").focus();

      setWidth(DESKTOP_WIDTH);

      expect(document.activeElement).toBe(heatmap);
      heatmap.remove();
    });

    it("stops listening after destroy", () => {
      const created = create();
      created.destroy();

      setWidth(PHONE_WIDTH);

      expect(created.isMounted()).toBe(false);
    });
  });

  describe("tabs", () => {
    beforeEach(() => {
      create();
    });

    it("shows five labelled tabs with 24px icons", () => {
      const tabs = document.querySelectorAll<HTMLElement>(".mobile-tab");

      expect(
        Array.from(tabs).map(
          (element) =>
            element.querySelector(".mobile-tab-label")?.textContent ?? "",
        ),
      ).toEqual(["Layers", "Filter", "Stats", "Wrapped", "More"]);
      expect(
        tabs[0]!.querySelector(":scope > svg.icon")!.getAttribute("width"),
      ).toBe("24");
    });

    it("says the year the map shows on the Filter tab", () => {
      const label = (): string =>
        tab("filter").querySelector(".mobile-tab-label")!.textContent;
      expect(label()).toBe("Filter");
      expect(tab("filter").getAttribute("aria-label")).toBe("Filter");

      app.selectedYear = "2025";

      expect(label()).toBe("2025");
      expect(tab("filter").getAttribute("aria-label")).toBe("Filter, 2025");

      app.selectedYear = "all";

      expect(label()).toBe("Filter");
    });

    it("marks sheet tabs as dialog openers", () => {
      expect(tab("layers").getAttribute("aria-haspopup")).toBe("dialog");
      expect(tab("layers").getAttribute("aria-controls")).toBe("mobile-sheet");
      // The open sheet covers the bar, so the tab is not an operable
      // disclosure and must not claim to be one
      expect(tab("layers").getAttribute("aria-expanded")).toBeNull();
    });

    it("makes Stats a disclosure and Wrapped a dialog opener, as on the desktop", () => {
      expect(tab("stats").getAttribute("aria-pressed")).toBeNull();
      expect(tab("stats").getAttribute("aria-expanded")).toBe("false");
      expect(tab("stats").getAttribute("aria-controls")).toBe("stats-rail");
      expect(tab("wrapped").getAttribute("aria-pressed")).toBeNull();
      expect(tab("wrapped").getAttribute("aria-haspopup")).toBe("dialog");
    });

    it("opens the layers sheet and marks the tab active", () => {
      tab("layers").click();

      expect(sheetTitle()).toBe("Layers");
      expect(sheetRows()).toEqual([
        "heatmap",
        "airports",
        "altitude",
        "speed",
        "aviation",
        "globe",
        "three-d",
        "satellite",
      ]);
      expect(tab("layers").classList.contains("active")).toBe(true);
      expect(tab("layers").getAttribute("aria-expanded")).toBeNull();
    });

    it("toggles the stats panel instead of opening a sheet", () => {
      tab("stats").click();

      expect(app.store.get("statsPanelVisible")).toBe(true);
      expect(document.querySelector<HTMLElement>(".mobile-sheet")!.hidden).toBe(
        true,
      );
    });

    it("takes the focus into the statistics as they open, as the sheets do", () => {
      const panel = document.createElement("div");
      panel.id = "stats-panel";
      panel.tabIndex = 0;
      document.body.append(panel);

      tab("stats").click();
      expect(document.activeElement).toBe(panel);

      // Closed, the tab keeps it
      tab("stats").click();
      expect(document.activeElement).toBe(tab("stats"));
      panel.remove();
    });

    it("follows the stats panel state", () => {
      app.store.set("statsPanelVisible", true);

      expect(tab("stats").classList.contains("active")).toBe(true);
      expect(tab("stats").getAttribute("aria-expanded")).toBe("true");
    });

    it("opens the wrapped card and follows its state", async () => {
      tab("wrapped").click();
      await vi.waitFor(() =>
        expect(app.wrappedManager.showWrapped).toHaveBeenCalledTimes(1),
      );

      app.store.set("wrappedVisible", true);
      expect(tab("wrapped").classList.contains("active")).toBe(true);
    });

    it("closes an open sheet before opening the statistics", () => {
      tab("filter").click();
      expect(bar!.sheetOpen()).toBe(true);

      tab("stats").click();

      // The statistics sheet sits below the scrim and would open underneath
      expect(bar!.sheetOpen()).toBe(false);
      expect(tab("filter").classList.contains("active")).toBe(false);
      expect(app.store.get("statsPanelVisible")).toBe(true);
    });

    it("closes an open sheet before opening Wrapped", async () => {
      tab("layers").click();
      expect(bar!.sheetOpen()).toBe(true);

      tab("wrapped").click();

      expect(bar!.sheetOpen()).toBe(false);
      expect(tab("layers").classList.contains("active")).toBe(false);
      await vi.waitFor(() =>
        expect(app.wrappedManager.showWrapped).toHaveBeenCalledTimes(1),
      );
    });

    it.each([
      ["wrapped", "layers"],
      ["stats", "filter"],
    ] as const)(
      "hands focus to the %s tab before opening it over the %s sheet",
      async (target, sheet) => {
        let focusedOnOpen: Element | null = null;
        const record = (): void => {
          focusedOnOpen = document.activeElement;
        };
        app.wrappedManager.showWrapped.mockImplementation(record);
        app.store.subscribe("statsPanelVisible", record);
        tab(sheet).focus();
        tab(sheet).click();

        tab(target).focus();
        tab(target).click();

        // Closing the sheet returned focus to its own tab, and Wrapped took
        // that as its opener: Escape then landed on the wrong tab. Wrapped
        // opens after its bundle has loaded, so wait for the call.
        await vi.waitFor(() => expect(focusedOnOpen).toBe(tab(target)));
      },
    );

    it("collects the remaining controls under More", () => {
      tab("more").click();

      expect(sheetTitle()).toBe("More");
      expect(sheetRows()).toEqual([
        "search",
        "local-flights",
        "replay",
        "replay-all",
        "hotspot-tour",
        "cross-section",
        "reset-view",
        "export",
        // Share mode next to the link it is for
        "isolate",
        "share",
        "github",
      ]);
    });
  });

  describe("filter rows", () => {
    it("offers a row for each dropdown", () => {
      create();
      tab("filter").click();

      expect(sheetTitle()).toBe("Filter");
      expect(sheetRows()).toEqual(["year", "aircraft"]);
    });

    it("mirrors the page dropdowns and writes a choice back", () => {
      create();
      tab("filter").click();
      const year = document.querySelector<HTMLSelectElement>(
        '[data-row="year"] select',
      )!;
      expect(Array.from(year.options).map((o) => o.value)).toEqual([
        "all",
        "2024",
        "2025",
      ]);
      // The unfiltered option is relabelled: the row already says "Year"
      expect(year.options[0]!.textContent).toBe("All");

      year.value = "2025";
      year.dispatchEvent(new Event("change", { bubbles: true }));

      expect(
        document.querySelector<HTMLSelectElement>("#year-select")!.value,
      ).toBe("2025");
    });

    it("follows the dataset, which fills the aircraft list", () => {
      // Opened during the first load, it kept an empty aircraft list: the
      // list is filled with the dataset, and nothing refreshed the sheet
      create();
      tab("filter").click();
      const option = document.createElement("option");
      option.value = "D-EXYZ";
      option.textContent = "D-EXYZ";
      document.getElementById("aircraft-select")!.append(option);

      app.store.set("currentData", {
        path_info: [],
        path_segments: [],
      } as unknown as KMLDataset);

      const mirrored = document.querySelector<HTMLSelectElement>(
        '[data-row="aircraft"] select',
      )!;
      expect(Array.from(mirrored.options).map((o) => o.value)).toContain(
        "D-EXYZ",
      );
    });

    it("names each dropdown by its row label", () => {
      create();
      tab("filter").click();

      for (const rowId of ["year", "aircraft"]) {
        const select = document.querySelector<HTMLSelectElement>(
          `[data-row="${rowId}"] select`,
        )!;
        const id = select.getAttribute("aria-labelledby");
        expect(id, `${rowId} select is unnamed`).toBeTruthy();
        expect(document.getElementById(id!)?.textContent).toBeTruthy();
      }
    });
  });

  describe("layer rows", () => {
    it("drives the layer toggles", () => {
      create();
      tab("layers").click();

      document.querySelector<HTMLElement>('[data-row="heatmap"]')!.click();

      expect(app.uiToggles.toggleHeatmap).toHaveBeenCalledTimes(1);
    });

    it("wires every row to its own toggle and no other", () => {
      // Each row's own switch: a row wired to the wrong toggle used to pass
      // here and was caught only by the mobile end-to-end project
      const wiring: [string, keyof typeof app.uiToggles][] = [
        ["heatmap", "toggleHeatmap"],
        ["airports", "toggleAirports"],
        ["altitude", "toggleAltitude"],
        ["speed", "toggleAirspeed"],
        ["aviation", "toggleAviation"],
      ];
      create();
      tab("layers").click();

      for (const [rowId, method] of wiring) {
        const row = document.querySelector<HTMLElement>(
          `[data-row="${rowId}"]`,
        );
        expect(row, `missing row ${rowId}`).not.toBeNull();
        row!.click();

        for (const [, other] of wiring) {
          const calls = vi.mocked(app.uiToggles[other]).mock.calls.length;
          expect(calls, `${rowId} called ${String(other)}`).toBe(
            other === method ? 1 : 0,
          );
        }
        vi.mocked(app.uiToggles[method]).mockClear();
      }
    });

    it("switches the globe from its row and follows the store", () => {
      create();
      tab("layers").click();
      const row = document.querySelector<HTMLElement>('[data-row="globe"]')!;
      expect(row.getAttribute("aria-checked")).toBe("false");

      row.click();
      expect(app.mapOrientation.toggleGlobe).toHaveBeenCalledOnce();

      app.store.set("globeVisible", true);
      expect(row.getAttribute("aria-checked")).toBe("true");
    });

    it("reflects a layer change made elsewhere", () => {
      create();
      tab("layers").click();
      const row = document.querySelector<HTMLElement>('[data-row="altitude"]')!;
      expect(row.getAttribute("aria-checked")).toBe("false");

      app.store.set("altitudeVisible", true);

      expect(row.getAttribute("aria-checked")).toBe("true");
    });

    it("marks the speed row unavailable without timing data in the store", () => {
      // The desktop button is not what it reads: that is a copy of the flag
      document
        .getElementById("airspeed-btn")!
        .setAttribute("aria-disabled", "false");
      app.store.set("hasTimingData", false);
      create();
      tab("layers").click();
      const row =
        document.querySelector<HTMLButtonElement>('[data-row="speed"]')!;

      // Unavailable like Share mode: announced, reachable, and says why
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.disabled).toBe(false);
      expect(row.querySelector(".sheet-row-hint")!.textContent).toBe(
        "No timing data in the flights",
      );
      row.click();
      expect(app.uiToggles.toggleAirspeed).not.toHaveBeenCalled();

      app.store.set("hasTimingData", true);
      expect(row.getAttribute("aria-disabled")).toBe("false");
    });
  });

  describe("after a load that failed", () => {
    afterEach(() => {
      document.body.classList.remove("flights-failed");
    });

    it("marks the tabs and rows made of the flights unavailable, and why", () => {
      document.body.classList.add("flights-failed");
      create();

      for (const id of ["stats", "wrapped"]) {
        expect(tab(id).getAttribute("aria-disabled"), id).toBe("true");
        expect(tab(id).title).toBe(NO_DATA_MESSAGE);
      }
      expect(tab("layers").hasAttribute("aria-disabled")).toBe(false);
      tab("more").click();
      for (const id of [
        "replay-all",
        "hotspot-tour",
        "cross-section",
        "export",
      ]) {
        const row = document.querySelector(`[data-row="${id}"]`)!;
        expect(row.getAttribute("aria-disabled"), id).toBe("true");
        expect(row.querySelector(".sheet-row-hint")!.textContent).toBe(
          NO_DATA_MESSAGE,
        );
      }
      expect(
        document
          .querySelector('[data-row="share"]')!
          .getAttribute("aria-disabled"),
      ).toBe("false");

      // With the flights in, the app says so again
      document.body.classList.remove("flights-failed");
      bar!.syncTabs();
      bar!.refreshSheet();
      expect(tab("stats").getAttribute("aria-disabled")).toBe("false");
      expect(tab("stats").hasAttribute("title")).toBe(false);
      expect(
        document
          .querySelector('[data-row="export"]')!
          .getAttribute("aria-disabled"),
      ).toBe("false");
    });
  });

  describe("more rows", () => {
    beforeEach(() => {
      create();
      tab("more").click();
    });

    it("explains why replay is unavailable", () => {
      app.canReplay.mockReturnValue(false);
      app.replayHint.mockReturnValue(REPLAY_PRECONDITION_MESSAGE);
      dismissSheet();
      tab("more").click();

      const hint = document.querySelector<HTMLElement>(
        '[data-row="replay"] .sheet-row-hint',
      )!;
      expect(hint.hidden).toBe(false);
      // The words of the button in the columns, which name timing data
      expect(hint.textContent).toBe(REPLAY_PRECONDITION_MESSAGE);
    });

    it("does not repeat the tile credit, which the map itself carries", () => {
      // The sheet used to hold the only copy of the attribution below the
      // breakpoint, two taps from the map it credits
      expect(document.querySelector('[data-row="attribution"]')).toBeNull();
    });

    it("dims the replay row while no single flight is selected", () => {
      const replayRow = (): HTMLButtonElement =>
        document.querySelector<HTMLButtonElement>('[data-row="replay"]')!;
      expect(replayRow().getAttribute("aria-disabled")).toBe("false");

      // It used to keep a full strength label and a chevron next to its own
      // hint saying it could not run. It stays reachable and tappable, which
      // is what explains the precondition; only the look changes.
      app.canReplay.mockReturnValue(false);
      dismissSheet();
      tab("more").click();

      expect(replayRow().getAttribute("aria-disabled")).toBe("true");
      expect(replayRow().disabled).toBe(false);
    });

    it("marks only the row that navigates away with a trailing glyph", () => {
      const trailing = (row: string): boolean =>
        !!document.querySelector(`[data-row="${row}"] .sheet-row-chevron`);

      expect(trailing("github")).toBe(true);
      expect(trailing("export")).toBe(false);
      expect(trailing("share")).toBe(false);
    });

    it("starts replay from the sheet", async () => {
      document.querySelector<HTMLElement>('[data-row="replay"]')!.click();

      await vi.waitFor(() =>
        expect(app.replayManager.toggleReplay).toHaveBeenCalledTimes(1),
      );
    });

    it("starts the hotspot tour from the sheet, next to Replay all", () => {
      document.querySelector<HTMLElement>('[data-row="hotspot-tour"]')!.click();

      expect(app.toggleHotspotTour).toHaveBeenCalledTimes(1);
    });

    it("keeps share mode unavailable without a selection, as on the desktop", () => {
      const row = document.querySelector<HTMLButtonElement>(
        '[data-row="isolate"]',
      )!;
      // aria-disabled and in the tab order, like the desktop button,
      // rather than `disabled` in the sheet alone
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.disabled).toBe(false);
      row.click();
      expect(app.pathSelection.toggleIsolateSelection).not.toHaveBeenCalled();
    });

    it("resets the view from the sheet and closes it", () => {
      const row = document.querySelector<HTMLButtonElement>(
        '[data-row="reset-view"]',
      )!;
      expect(row.textContent).toContain("Reset view");
      expect(row.querySelector("svg")).not.toBeNull();

      expect(row.getAttribute("aria-disabled")).toBe("false");
      row.click();

      expect(app.resetView).toHaveBeenCalledTimes(1);
      expect(document.querySelector<HTMLElement>(".mobile-sheet")!.hidden).toBe(
        true,
      );
    });

    it("dims the reset row with nothing to reset, where a tap does nothing", () => {
      app.isReset.mockReturnValue(true);
      dismissSheet();
      tab("more").click();
      const row = document.querySelector<HTMLButtonElement>(
        '[data-row="reset-view"]',
      )!;

      // Dimmed like the replay row, and still reachable
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.disabled).toBe(false);
      row.click();

      expect(app.resetView).not.toHaveBeenCalled();
      expect(document.querySelector<HTMLElement>(".mobile-sheet")!.hidden).toBe(
        false,
      );

      // It follows the page: once there is something to reset again
      app.isReset.mockReturnValue(false);
      app.store.set("heatmapVisible", false);
      expect(row.getAttribute("aria-disabled")).toBe("false");
    });

    it("reads the reset row again when the app says the first load is over", () => {
      app.isInitializing = true;
      dismissSheet();
      tab("more").click();
      const row = document.querySelector<HTMLElement>(
        '[data-row="reset-view"]',
      )!;
      expect(row.getAttribute("aria-disabled")).toBe("true");

      // No store key the sheet follows changes with it
      app.isInitializing = false;
      bar!.refreshSheet();

      expect(row.getAttribute("aria-disabled")).toBe("false");
    });

    it("leaves the actions that need data alone during the first load", () => {
      // Reset view here used to switch the year under the load that was
      // still running, and the map ended on another year than the dropdown
      app.isInitializing = true;
      app.selectedPathIds = new Set([...app.selectedPathIds, 1]);
      dismissSheet();
      tab("more").click();

      const reset = document.querySelector<HTMLElement>(
        '[data-row="reset-view"]',
      )!;
      expect(reset.getAttribute("aria-disabled")).toBe("true");
      reset.click();
      document.querySelector<HTMLElement>('[data-row="isolate"]')!.click();
      document.querySelector<HTMLElement>('[data-row="replay"]')!.click();
      tab("more").click();
      document.querySelector<HTMLElement>('[data-row="export"]')!.click();
      tab("wrapped").click();

      expect(app.resetView).not.toHaveBeenCalled();
      expect(app.pathSelection.toggleIsolateSelection).not.toHaveBeenCalled();
      expect(app.toggleReplay).not.toHaveBeenCalled();
      expect(app.uiToggles.exportMap).not.toHaveBeenCalled();
      expect(app.loadWrapped).not.toHaveBeenCalled();
    });

    it("exports and shares", () => {
      document.querySelector<HTMLElement>('[data-row="export"]')!.click();
      tab("more").click();
      document.querySelector<HTMLElement>('[data-row="share"]')!.click();

      expect(app.uiToggles.exportMap).toHaveBeenCalledTimes(1);
      expect(app.uiToggles.shareLink).toHaveBeenCalledTimes(1);
    });
  });

  describe("share row", () => {
    it("says Share link where the phone's share sheet takes the link", () => {
      Object.defineProperty(navigator, "share", {
        value: vi.fn(),
        configurable: true,
        writable: true,
      });
      try {
        create();
        tab("more").click();
        expect(
          document.querySelector('[data-row="share"] .sheet-row-label')
            ?.textContent,
        ).toBe("Share link");
      } finally {
        delete (navigator as { share?: unknown }).share;
      }
    });

    it("says Copy link where there is no share sheet", () => {
      create();
      tab("more").click();
      expect(
        document.querySelector('[data-row="share"] .sheet-row-label')
          ?.textContent,
      ).toBe("Copy link");
    });
  });

  describe("Wrapped handover", () => {
    it("goes back ahead of the map once Wrapped gives the map back", () => {
      // Mounted across the breakpoint while Wrapped held the map, the bar
      // went to the end of the page, after the map's markers (regression)
      const map = document.createElement("div");
      map.id = "map";
      const dialog = document.createElement("div");
      dialog.append(map);
      document.body.append(dialog);
      setWidth(DESKTOP_WIDTH);
      const created = create();
      app.store.set("wrappedVisible", true);
      setWidth(PHONE_WIDTH);
      expect(
        dialog.compareDocumentPosition(created.root) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      // Back in the page's <main>, which the bar stands ahead of, as the
      // control columns do
      const home = document.createElement("main");
      home.append(map);
      document.body.append(home);
      app.store.set("wrappedVisible", false);

      expect(created.root.nextElementSibling).toBe(home);
    });
  });

  describe("replay handover", () => {
    it("takes the bar out of the document and closes the sheet", () => {
      const created = create();
      tab("layers").click();

      app.store.set("replayActive", true);

      // Merely hiding it would still reserve its height for the stylesheet
      expect(document.contains(created.root)).toBe(false);
      expect(created.isVisible()).toBe(false);
      expect(document.querySelector<HTMLElement>(".mobile-sheet")!.hidden).toBe(
        true,
      );
      expect(created.currentTab()).toBeNull();
    });

    it("brings the bar back when replay closes", () => {
      const created = create();

      app.store.set("replayActive", true);
      app.store.set("replayActive", false);

      expect(document.contains(created.root)).toBe(true);
      expect(created.isVisible()).toBe(true);
    });

    it("steps aside for the hotspot tour as for a replay, and comes back", () => {
      const created = create();
      tab("layers").click();

      // The tour keeps the user's view in the store while it runs
      app.store.set("tourView", {} as never);
      expect(document.contains(created.root)).toBe(false);
      expect(created.currentTab()).toBeNull();
      // Nor does a replay's end bring it back while the tour runs
      app.store.set("replayActive", true);
      app.store.set("replayActive", false);
      expect(document.contains(created.root)).toBe(false);
      setWidth(DESKTOP_WIDTH);
      setWidth(PHONE_WIDTH);
      expect(document.contains(created.root)).toBe(false);

      app.store.set("tourView", null);
      expect(created.isVisible()).toBe(true);
    });

    it("stays out of the document when the bar mounts during replay", () => {
      setWidth(DESKTOP_WIDTH);
      const created = create();
      app.store.set("replayActive", true);

      setWidth(PHONE_WIDTH);

      expect(created.isMounted()).toBe(true);
      expect(document.contains(created.root)).toBe(false);
    });
  });
});
