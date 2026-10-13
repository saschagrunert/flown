/**
 * Mobile bottom bar.
 *
 * Below the mobile breakpoint the columns of floating controls, some twenty
 * buttons and two selects, would cover much of a phone's map. This replaces
 * them with five tabs pinned to the bottom edge: Layers, Filter, Stats, Wrapped
 * and More. Layers, Filter and More open a bottom sheet; Stats and Wrapped
 * drive their panels directly.
 *
 * The bar is built at runtime because the template is shared with the
 * desktop layout. Everything it needs already exists in the page, so it runs
 * the same actions as the desktop controls (ui/actions.ts) and mirrors the
 * existing dropdowns instead of holding state of its own.
 *
 * When replay activates, or the hotspot tour starts, the bar steps aside
 * entirely: their panel takes the bottom edge, so the two never stack.
 *
 * The bar comes with the extras bundle (extras.ts), its sheet with it,
 * which the app asks for once the phone layout applies
 * (MapApp.followMobileBar): no part of a first visit, and on a desktop
 * not fetched for it at all.
 */
import type { MapApp } from "../mapApp";
import { MobileSheet, type SheetRow, type SheetSwitchRow } from "./mobileSheet";
import { icon, type IconName } from "../utils/icons";
import {
  followPhoneLayout,
  isPhoneLayout,
  shareLinkLabel,
} from "../utils/device";
import {
  TOGGLES,
  type Toggle,
  type ToggleKey,
  type ToggleSheetRow,
} from "../state/toggles";
import {
  flightsFailed,
  NO_DATA_MESSAGE,
  NO_SELECTION_MESSAGE,
  NO_TIMING_MESSAGE,
  runAction,
} from "./actions";
import { focusStatsRail } from "./appChrome";

/** The id of the sheet, which the tabs that open it name before it exists */
const SHEET_ID = "mobile-sheet";

/** Control columns the bar replaces while it is mounted */
const LEGACY_CONTROL_IDS = ["left-buttons", "right-buttons"];

/**
 * Store keys that change what the sheets show. The dataset is one: the
 * aircraft list, Replay and Reset view all follow it, and a Filter sheet
 * opened during the first load showed an empty aircraft list until closed.
 */
const SHEET_KEYS = [
  ...TOGGLES.filter((toggle: Toggle) => "sheet" in toggle).map(
    (toggle) => toggle.key,
  ),
  "selectedPathIds",
  "selectedYear",
  "selectedAircraft",
  "currentData",
  "hasTimingData",
] as const;

/** A toggle's switch in a sheet: when it is unavailable, and what says why */
type SwitchState = Pick<SheetSwitchRow, "isDisabled" | "hint">;

/** What the switches of the toggles have beyond their entry in the table */
function switchStates(
  app: Pick<MapApp, "hasTimingData" | "selectedPathIds">,
): Partial<Record<ToggleKey, SwitchState>> {
  return {
    // Read from the store rather than off the desktop button, which is a
    // copy of the same flag
    airspeedVisible: {
      isDisabled: () => !app.hasTimingData,
      hint: () => (app.hasTimingData ? null : NO_TIMING_MESSAGE),
    },
    isolateSelection: {
      isDisabled: () => app.selectedPathIds.size === 0,
      hint: () =>
        app.selectedPathIds.size === 0 ? NO_SELECTION_MESSAGE : null,
    },
  };
}

type TabId = "layers" | "filter" | "stats" | "wrapped" | "more";

/** A More row of what is made of the flights, unavailable without them */
const needsFlights = {
  isDisabled: flightsFailed,
  hint: () => (flightsFailed() ? NO_DATA_MESSAGE : null),
};

/**
 * What a tab opens: a sheet, the statistics (a disclosure, as the desktop
 * Statistics button is) or the Wrapped dialog (a button that opens a dialog,
 * as the desktop Wrapped button is). None of them is a pressed toggle.
 */
type TabKind = "sheet" | "disclosure" | "dialog";

interface TabSpec {
  id: TabId;
  icon: IconName;
  label: string;
  kind: TabKind;
}

/** The control of the columns each tab stands in for, the first of its sheet */
const COLUMN_CONTROLS: Record<TabId, string> = {
  layers: "heatmap-btn",
  filter: "year-select",
  stats: "stats-btn",
  wrapped: "wrapped-btn",
  more: "search-btn",
};

const TABS: TabSpec[] = [
  { id: "layers", icon: "layers", label: "Layers", kind: "sheet" },
  { id: "filter", icon: "filter", label: "Filter", kind: "sheet" },
  { id: "stats", icon: "stats", label: "Stats", kind: "disclosure" },
  { id: "wrapped", icon: "wrapped", label: "Wrapped", kind: "dialog" },
  { id: "more", icon: "more", label: "More", kind: "sheet" },
];

export class MobileBar {
  readonly root: HTMLElement;
  /** In the page while the bar is (see mountSheet) */
  private readonly sheet = new MobileSheet(SHEET_ID);

  private readonly app: MapApp;
  private readonly tabs = new Map<TabId, HTMLButtonElement>();
  private readonly unsubscribes: (() => void)[] = [];
  /** Ends following the phone layout (followPhoneLayout) */
  private unfollowLayout: (() => void) | null = null;
  private mounted = false;
  /**
   * Ends following the replay and the hotspot tour, which the bar does
   * mounted or not
   */
  private unsubscribeEdge: (() => void) | null = null;
  private openTab: TabId | null = null;

  constructor(app: MapApp) {
    this.app = app;

    this.root = document.createElement("nav");
    this.root.className = "mobile-bar";
    this.root.id = "mobile-bar";
    this.root.setAttribute("aria-label", "Map controls");

    for (const spec of TABS) {
      const tab = this.createTab(spec);
      this.tabs.set(spec.id, tab);
      this.root.append(tab);
    }
  }

  /**
   * Create the bar for an app and keep it in step with the viewport width.
   * Returns null when there is no document to mount into.
   */
  static mountFor(app: MapApp): MobileBar | null {
    if (typeof document === "undefined" || !document.body) return null;
    const bar = new MobileBar(app);
    bar.start();
    return bar;
  }

  /** Mount now if the viewport is small and follow it from then on */
  start(): void {
    this.syncBreakpoint(isPhoneLayout());
    this.unfollowLayout ??= followPhoneLayout((phone) =>
      this.syncBreakpoint(phone),
    );
    this.unsubscribeEdge ??= this.app.store.subscribeKeys(
      ["replayActive", "tourView"],
      () => this.followEdge(),
    );
  }

  destroy(): void {
    this.unfollowLayout?.();
    this.unfollowLayout = null;
    this.unsubscribeEdge?.();
    this.unsubscribeEdge = null;
    this.unmount();
  }

  isMounted(): boolean {
    return this.mounted;
  }

  /**
   * Whether a replay or the hotspot tour has the bottom edge: the tour
   * keeps the user's view in the store while it runs (ui/hotspotTour.ts)
   */
  private edgeTaken(): boolean {
    return this.app.replayActive || !!this.app.tourView;
  }

  /**
   * A replay owns the bottom edge while it runs, and so does the hotspot
   * tour. The bar leaves the document rather than hiding in place: the
   * stylesheet lifts the attribution and the replay panel off the bar
   * with `body:has(.mobile-bar)`, so a bar that is merely invisible would
   * still reserve its height.
   */
  private followEdge(): void {
    if (!this.mounted) return;
    if (this.edgeTaken()) {
      this.closeSheet();
      this.root.remove();
    } else if (!document.contains(this.root)) {
      insertBeforeMap(this.root);
    }
  }

  /** Whether the bar is currently in the document */
  isVisible(): boolean {
    return this.mounted && document.contains(this.root);
  }

  /** Currently open sheet tab, or null */
  currentTab(): TabId | null {
    return this.openTab;
  }

  private syncBreakpoint(matches: boolean): void {
    if (matches === this.mounted) return;
    if (matches) this.mount();
    else this.unmount();
  }

  private mount(): void {
    if (this.mounted) return;
    this.mounted = true;

    if (!this.edgeTaken()) insertBeforeMap(this.root);
    this.mountSheet();

    // The floating button groups are what the bar replaces
    setLegacyControlsHidden(true);

    this.subscribe();
    this.syncTabs();
  }

  private unmount(): void {
    if (!this.mounted) return;
    this.mounted = false;

    this.closeSheet();
    this.sheet.destroy();
    // A sheet hands the focus back to its tab as it closes, and a tab that
    // leaves the page drops it to <body>: it goes to the control of the
    // columns the tab stands in for instead, once they are back
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement && this.root.contains(active)
        ? (active.dataset["tab"] as TabId | undefined)
        : undefined;
    this.root.remove();

    setLegacyControlsHidden(false);
    if (focused) document.getElementById(COLUMN_CONTROLS[focused])?.focus();

    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes.length = 0;
  }

  private subscribe(): void {
    const store = this.app.store;
    this.unsubscribes.push(
      store.subscribe("statsPanelVisible", () => this.syncTabs()),
      store.subscribe("selectedYear", () => this.syncTabs()),
      store.subscribe("wrappedVisible", (visible) => {
        this.syncTabs();
        // A bar mounted while Wrapped held the map went to the end of the
        // page, after the map's markers in the tab order; the map is back
        // by the time the dialog says it closed
        if (!visible && this.isVisible()) insertBeforeMap(this.root);
      }),
    );
    for (const key of SHEET_KEYS) {
      this.unsubscribes.push(store.subscribe(key, () => this.refreshSheet()));
    }
  }

  /**
   * Read the rows of an open sheet again. The store's keys do it on their
   * own; Reset view also turns on the end of the first load and of every
   * camera move, which the app passes on (see MapApp.syncResetButton).
   */
  refreshSheet(): void {
    if (this.sheet.isOpen()) this.sheet.refresh();
  }

  /** Whether a sheet is open */
  sheetOpen(): boolean {
    return this.sheet.isOpen();
  }

  /** Put the sheet into the page with the bar */
  private mountSheet(): void {
    this.sheet.mount(document.body);
  }

  private createTab(spec: TabSpec): HTMLButtonElement {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "mobile-tab";
    tab.id = "mobile-tab-" + spec.id;
    tab.dataset["tab"] = spec.id;

    // The stylesheet sizes the icon through `.mobile-tab .icon`, so the
    // svg is a direct child rather than being wrapped
    tab.innerHTML = icon(spec.icon, 24);

    const label = document.createElement("span");
    label.className = "mobile-tab-label";
    label.textContent = spec.label;

    tab.append(label);

    if (spec.kind === "sheet") {
      // No aria-expanded: the sheet is modal and covers the whole bar, so
      // the tab is not an operable disclosure once it is open. The sheet
      // is in the page while the bar is (mountSheet).
      tab.setAttribute("aria-haspopup", "dialog");
      tab.setAttribute("aria-controls", SHEET_ID);
    } else if (spec.kind === "dialog") {
      tab.setAttribute("aria-haspopup", "dialog");
    } else {
      tab.setAttribute("aria-controls", "stats-rail");
      tab.setAttribute("aria-expanded", "false");
    }

    tab.addEventListener("click", () => this.selectTab(spec.id));
    return tab;
  }

  /**
   * Run a tab. The sheet sits behind the bar, so the tabs stay reachable
   * while it is open. Tapping the active sheet tab toggles it closed;
   * tapping a different sheet tab swaps the content.
   */
  private selectTab(id: TabId): void {
    if (this.openTab === id) {
      this.closeSheet();
      return;
    }
    switch (id) {
      case "layers":
      case "filter":
      case "more":
        this.openSheet(id);
        break;
      // The statistics sheet sits below the scrim and Wrapped's dialog above
      // the bar, so an open sheet would stay on top of the one or open (and
      // marked active) behind the other. Closing it hands focus back to the
      // tab that opened it, so the tapped tab takes focus again before
      // Wrapped records where to return it on close.
      case "stats":
        this.closeSheet();
        this.tabs.get(id)?.focus();
        // Into the sheet as it opens, as the other sheets take it: the
        // sheet comes before the bar in the page, so Tab from the tab
        // went on to Wrapped, More and the map
        if (runAction(this.app, "toggleStats") && this.app.statsPanelVisible) {
          focusStatsRail();
        }
        break;
      case "wrapped":
        this.closeSheet();
        this.tabs.get(id)?.focus();
        runAction(this.app, "showWrapped");
        break;
    }
    this.syncTabs();
  }

  /** Open the sheet of tab `id` */
  private openSheet(id: "layers" | "filter" | "more"): void {
    this.openTab = id;
    const sheet = this.sheet;
    // Its rows as they are now, read anew at every opening
    const [title, rows] =
      id === "layers"
        ? ["Layers", this.toggleRows("layers")]
        : id === "filter"
          ? ["Filter", this.filterRows()]
          : ["More", this.moreRows()];
    sheet.clearCloseCallback();
    sheet.openWith(title, rows, () => {
      this.openTab = null;
      this.syncTabs();
    });
  }

  private closeSheet(): void {
    this.sheet.close();
    this.openTab = null;
    this.syncTabs();
  }

  /**
   * Reflect panel and sheet state on the tabs. The bar only reads app state
   * while it is mounted, so a wide viewport never touches the store.
   */
  syncTabs(): void {
    if (!this.mounted) return;
    for (const spec of TABS) {
      const tab = this.tabs.get(spec.id);
      if (!tab) continue;
      const active = this.isTabActive(spec.id);
      tab.classList.toggle("active", active);
      if (spec.kind === "disclosure") {
        tab.setAttribute("aria-expanded", String(active));
      }
      // The Filter tab says the year the map shows, which nothing else on
      // a phone did; named as the tab still
      if (spec.id === "filter") {
        const year = this.app.selectedYear;
        const all = year === "all";
        tab.lastChild!.textContent = all ? spec.label : year;
        tab.setAttribute("aria-label", all ? spec.label : "Filter, " + year);
      }
      // Statistics and Wrapped are made of the flights; an open rail can
      // still be closed (runAction)
      if (spec.kind !== "sheet") {
        const failed = flightsFailed() && !active;
        tab.setAttribute("aria-disabled", String(failed));
        if (failed) tab.title = NO_DATA_MESSAGE;
        else tab.removeAttribute("title");
      }
    }
  }

  private isTabActive(id: TabId): boolean {
    if (id === "stats") return this.app.statsPanelVisible;
    if (id === "wrapped") return this.app.wrappedVisible;
    return this.openTab === id;
  }

  /** The switches of the toggles a sheet group holds, in table order */
  private toggleRows(group: "layers" | "more"): SheetRow[] {
    const app = this.app;
    const states = switchStates(app);
    const rows: SheetRow[] = [];
    for (const toggle of TOGGLES) {
      if (!("sheet" in toggle) || toggle.sheet.group !== group) continue;
      const sheet: ToggleSheetRow = toggle.sheet;
      rows.push({
        kind: "switch",
        id: sheet.id,
        icon: toggle.icon,
        label: sheet.label ?? toggle.label,
        ...(sheet.chip ? { chip: sheet.chip } : {}),
        ...states[toggle.key],
        isOn: () => app[toggle.key],
        onToggle: () => runAction(app, toggle.action),
      });
    }
    return rows;
  }

  private filterRows(): SheetRow[] {
    return [
      {
        kind: "select",
        id: "year",
        icon: "calendar",
        label: "Year",
        sourceId: "year-select",
      },
      {
        kind: "select",
        id: "aircraft",
        icon: "aircraft",
        label: "Aircraft",
        sourceId: "aircraft-select",
      },
    ];
  }

  private moreRows(): SheetRow[] {
    const app = this.app;
    return [
      // The panel spans the top of the map once the sheet is closed
      {
        kind: "action",
        id: "search",
        icon: "search",
        label: "Search",
        onSelect: () => runAction(app, "toggleSearch"),
      },
      {
        kind: "action",
        id: "local-flights",
        icon: "upload",
        label: "Your flights",
        onSelect: () => runAction(app, "toggleLocalFlights"),
      },
      {
        kind: "action",
        id: "replay",
        icon: "play",
        // The name the control has in the columns
        label: "Replay",
        hint: () => app.replayHint(),
        isDisabled: () => !app.canReplay(),
        onSelect: () => {
          runAction(app, "toggleReplay");
        },
      },
      {
        kind: "action",
        id: "replay-all",
        icon: "play",
        label: "Replay all",
        ...needsFlights,
        onSelect: () => runAction(app, "toggleReplayAll"),
      },
      {
        kind: "action",
        id: "hotspot-tour",
        icon: "trophy",
        label: "Hotspot tour",
        ...needsFlights,
        onSelect: () => runAction(app, "toggleHotspotTour"),
      },
      {
        kind: "action",
        id: "cross-section",
        icon: "ruler",
        label: "Cross-section",
        ...needsFlights,
        onSelect: () => runAction(app, "toggleCrossSection"),
      },
      {
        kind: "action",
        id: "reset-view",
        icon: "reset",
        label: "Reset view",
        hint: () => app.resetViewReason(),
        isDisabled: () => !app.canResetView(),
        // With nothing to reset a tap does nothing, and the sheet stays
        closeOnSelect: false,
        onSelect: () => {
          if (!app.canResetView()) return;
          this.closeSheet();
          runAction(app, "resetView");
        },
      },
      {
        kind: "action",
        id: "export",
        icon: "export",
        label: "Export image",
        ...needsFlights,
        onSelect: () => runAction(app, "exportMap"),
      },
      // Share mode next to the link it is for, as in the Share group
      ...this.toggleRows("more"),
      {
        kind: "action",
        id: "share",
        icon: "share",
        // What the row does: the share sheet, where the phone has one
        label: shareLinkLabel(),
        onSelect: () => runAction(app, "shareLink"),
      },
      {
        kind: "action",
        id: "github",
        icon: "github",
        label: "Source code",
        trailing: "externalLink",
        onSelect: () => {
          window.open(
            "https://github.com/saschagrunert/flown",
            "_blank",
            "noopener",
          );
        },
      },
    ];
  }
}

/**
 * Take the replaced control columns out of reach while the bar stands in for
 * them, and hand them back untouched afterwards.
 *
 * `hidden` takes them out of the tab order so the same controls are not
 * offered twice, and the stylesheet turns the same attribute into
 * `display: none`, which holds even while replay has taken the bar out of
 * the document.
 *
 * No inline style is written here. The inline `display` belongs to
 * hideControls() and restoreControls(), which own it while Wrapped is open.
 * Snapshotting it here used to capture their `none` and restore it forever,
 * stranding every desktop control after a rotation across the breakpoint.
 */
function setLegacyControlsHidden(hidden: boolean): void {
  for (const id of LEGACY_CONTROL_IDS) {
    const element = document.getElementById(id);
    if (!element) continue;
    element.hidden = hidden;
  }
}

/**
 * Put the bar ahead of the map in the document, where the control columns
 * it stands in for are, so that it comes before the map's markers in the
 * tab order rather than after every one of them: ahead of the page's
 * <main>, which holds the map, as the columns are. Wrapped has the map in
 * its dialog; the bar goes to the end of the page then.
 */
function insertBeforeMap(bar: HTMLElement): void {
  const home = document.getElementById("map")?.closest("main");
  if (home) home.before(bar);
  else document.body.append(bar);
}
