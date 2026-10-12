/**
 * Path Selection - Handles path selection logic, and share mode
 *
 * Share mode (the store's `isolateSelection`, the name links have carried
 * it under from the start) is for showing a few flights to someone else:
 * the map draws the selected flights alone, and the selection holds still.
 * A click on a flight, an airport or a row of a list then only shows what
 * it is; a flight joins or leaves the shared ones by an explicit Remove
 * (the values of a flight on the map) or a list's checkbox, and the mode
 * ends with the chip's Exit or once no flight is left. Outside it a click
 * with a mouse still toggles a flight, while a tap shows its values with
 * an explicit Select, as a finger has no hover to look with (see
 * LayerManager.onPathClick).
 */
import type { Map as MapLibreMap, PaddingOptions } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { loadFeatures } from "../services/featureLoader";
import {
  applyToggleButtonState,
  setUnavailableFor,
} from "../utils/buttonState";
import {
  followPhoneLayout,
  isPhoneLayout,
  shareLinkLabel,
} from "../utils/device";
import {
  datasetIndex,
  shownPathIds,
  shownSelection,
} from "../calculations/datasetIndex";
import { segmentsForPathIds } from "../calculations/statistics";
import { segmentBounds } from "../utils/geometry";
import { toBounds } from "../utils/mapHelpers";
import { fitSelection } from "./filterManager";
import { loadLazyBundle, SHARE_FRAME_UNAVAILABLE_MESSAGE } from "./lazyBundles";
import { NO_SELECTION_MESSAGE } from "./actions";
import { domCache } from "../utils/domCache";
import { pluralFlights } from "../utils/htmlGenerators";
import { safeAreaInsets } from "../utils/safeArea";
import { announceStatus, showToast } from "../utils/toast";

/**
 * Said for a flight picked from a list in share mode that is not one of the
 * shared flights, which the map does not draw (see PathSelection.inspect)
 */
export const NOT_SHARED_HINT =
  "Not one of the shared flights: tick its box to add it";

/** Said for a press on Share mode with nothing selected */
export const ISOLATE_HINT =
  NO_SELECTION_MESSAGE +
  ": pick one on the map, or tick one under Statistics, Flights";

/** The control columns, which the phone's bar replaces */
export const CONTROL_COLUMNS = "#left-buttons, #right-buttons";

/** What floats over the map along its edges and would cover a framed flight */
const MAP_CHROME_SELECTOR = [
  CONTROL_COLUMNS,
  "#selection-chip",
  "#flight-profile",
  "#cross-section",
  "#mobile-bar",
  ".color-legend",
].join(", ");

/**
 * How far from an edge something may sit and still count as standing at it.
 * On a phone the profile of a flight stands above the bar and the map's
 * credit, 81 px from the bottom and more with a home indicator: at 48 px
 * the profile, as wide as the map, counted at the left edge, and a
 * flight framed with it ended up beside it rather than above it.
 */
const EDGE_REACH_PX = 128;

/** Room kept between the framed flights and the edge or a panel (px) */
const FRAME_MARGIN_PX = 24;

type Edge = "top" | "right" | "bottom" | "left";

/**
 * Resolves after the next layout and the ResizeObservers that follow it,
 * which run after a frame's callbacks: two frames on
 */
function afterLayout(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * The padding a fit of the map needs to keep what it frames clear of the
 * panels over it: the control columns at the sides, the selection chip at
 * the top, the legend and the phone's bar at the bottom. Each panel counts
 * at the edge it stands at from which it reaches in least, and no edge
 * takes more than a third of the map. Where the map fills the screen the
 * safe area is the least at each edge: the status bar, the island and the
 * home indicator, which a panel placed clear of them already takes in.
 * `margin` is the room left beyond, and `chrome` the panels that count.
 */
export function mapChromePadding(
  map: Pick<MapLibreMap, "getContainer">,
  margin = FRAME_MARGIN_PX,
  chrome = MAP_CHROME_SELECTOR,
): Required<PaddingOptions> {
  const box = map.getContainer().getBoundingClientRect();
  const padding: Record<Edge, number> = {
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  };
  // On a phone the bar stands in for the columns, which the start view
  // is measured ahead of (the bar mounts after the map)
  const phone = isPhoneLayout();
  for (const element of document.querySelectorAll<HTMLElement>(chrome)) {
    if (element.hidden || (phone && element.matches(CONTROL_COLUMNS))) {
      continue;
    }
    const r = element.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // [how far it is from the edge, how far it reaches in from it]
    const edges: [Edge, number, number][] = [
      ["top", r.top - box.top, r.bottom - box.top],
      ["bottom", box.bottom - r.bottom, box.bottom - r.top],
      ["left", r.left - box.left, r.right - box.left],
      ["right", box.right - r.right, box.right - r.left],
    ];
    let edge: Edge | null = null;
    let depth = Infinity;
    for (const [side, distance, reach] of edges) {
      if (distance >= -1 && distance <= EDGE_REACH_PX && reach < depth) {
        edge = side;
        depth = reach;
      }
    }
    if (edge) padding[edge] = Math.max(padding[edge], depth);
  }
  // Measured from the window's edges, as the insets are; none, no floor
  const safe = safeAreaInsets();
  padding.top = Math.max(padding.top, safe.top - box.top);
  padding.left = Math.max(padding.left, safe.left - box.left);
  padding.bottom = Math.max(
    padding.bottom,
    safe.bottom && box.bottom - window.innerHeight + safe.bottom,
  );
  padding.right = Math.max(
    padding.right,
    safe.right && box.right - window.innerWidth + safe.right,
  );
  const limit = (edge: Edge, size: number): number =>
    Math.min(padding[edge], size / 3) + margin;
  return {
    top: limit("top", box.height),
    bottom: limit("bottom", box.height),
    left: limit("left", box.width),
    right: limit("right", box.width),
  };
}

/**
 * The rows of a list of flights as they are shown, and the flight of the
 * row last clicked, where a Shift click's range starts (see
 * PathSelection.pickFromList). Each list keeps its own, and starts afresh
 * as it is sorted, searched, filtered or closed: the airport popup's list
 * and the flight list are in different orders, and a range from a row of
 * the one ran through the other.
 */
export interface PickList {
  readonly order: readonly number[];
  anchor: number | null;
}

export class PathSelection {
  private app: MapApp;

  constructor(app: MapApp) {
    this.app = app;

    // The share mode button reads two keys, so it cannot use
    // syncToggleButton; this is its only writer
    const refresh = (): void => {
      this.updateIsolateButton();
      this.updateSelectionChip();
    };
    // The filters too: the chip says how many shared flights they hide
    app.store.subscribeKeys(
      [
        "selectedPathIds",
        "isolateSelection",
        "currentData",
        "selectedYear",
        "selectedAircraft",
      ],
      refresh,
    );
    refresh();
    // The link says "Share link" in the phone layout alone, which a turn of
    // the phone or a narrower window can change with nothing selected anew
    const unfollow = followPhoneLayout(() => this.updateLinkLabel());
    app.signal.addEventListener("abort", unfollow, { once: true });

    domCache.get("selection-clear-btn")?.addEventListener(
      "click",
      () => {
        // The chip hides with the selection, and would drop the focus on
        // its Clear to <body>; the map is what the selection was on
        if (!app.replayActive) app.map?.getCanvas().focus();
        this.clearSelection();
      },
      { signal: app.signal },
    );
  }

  /**
   * Whether the selection is to be left alone: a replay plays the one
   * selected flight, and the hotspot tour tours what the selection and
   * share mode keep. Both hold the chip's controls and Share mode as well
   * (ui/heldControls.ts), but a list, an airport or the values of a flight
   * left open on the map could still change it. The one check for all of
   * them (ui/airportManager.ts and ui/layerManager.ts ask it too).
   */
  held(): boolean {
    return this.app.replayActive || this.app.tourView !== null;
  }

  /**
   * Add a flight to the selection or take it out. Share mode ends with the
   * last flight it shared, which the store sees to (AppStore.settle), in
   * the same update as the selection.
   */
  togglePathSelection(pathId: number): void {
    if (this.held()) return;
    const selected = new Set(this.app.selectedPathIds);
    if (!selected.delete(pathId)) selected.add(pathId);
    this.select(selected);
  }

  /**
   * Make `selected` the selection: a new set for every change, never the
   * one of before changed, so that whoever holds that one holds what was
   * selected then. Share mode may end with it (AppStore.settle), in the
   * same update.
   */
  private select(selected: ReadonlySet<number>): void {
    this.app.store.batch(() => {
      this.app.selectedPathIds = selected;
    });
  }

  /**
   * A flight picked from a list (the airport popup's, the flight list):
   * select just this flight, or nothing when it already is the whole
   * selection. Opening an airport's popup with a click or Enter selected
   * every flight of the airport, so a plain toggle would leave the others
   * selected. With `add` (a list's checkbox, Ctrl or Cmd) it is added to
   * the selection, or taken out of it. Share mode holds its flights still:
   * a pick there only shows the flight (see inspect). Ignored while replay
   * or the hotspot tour runs.
   *
   * One flush for the clear and the pick: two had the chip announce
   * "Selection cleared" before every flight and drew the paths and the
   * statistics of the empty selection in between.
   */
  selectFlight(pathId: number, add = false): void {
    if (this.held()) return;
    if (add) {
      this.togglePathSelection(pathId);
      return;
    }
    if (this.app.isolateSelection) {
      this.inspect(pathId);
      return;
    }
    const selected = this.app.selectedPathIds;
    const alone = selected.size === 1 && selected.has(pathId);
    this.app.store.batch(() => {
      this.clearSelection();
      if (!alone) this.togglePathSelection(pathId);
    });
    if (alone) return;
    this.bringIntoView(pathId, () => this.app.selectedPathIds.size === 1);
  }

  /**
   * A flight picked from a list in share mode: shown, not selected. A pick
   * added it to the shared flights or took it out, and a tap on a row to
   * see a flight changed what the link hands on. A shared flight is
   * brought into view as a pick brings it, on a phone from under the sheet
   * or the popup it was picked from; one that is not shared is not drawn,
   * and a hint says how to add it.
   */
  private inspect(pathId: number): void {
    const app = this.app;
    if (!app.selectedPathIds.has(pathId)) {
      showToast(NOT_SHARED_HINT);
      return;
    }
    this.bringIntoView(pathId, () => app.isolateSelection);
  }

  /**
   * A flight picked on its own from a list can be anywhere: off the screen,
   * or under the profile of the flight that opens with it at the bottom of
   * the map. That profile is drawn by the feature bundle, which the
   * selection fetches (MapApp.followFlightProfile), so the view waits for
   * it and for the layout after it, where a legend that stands on the
   * profile has moved up (its height is measured then), and then frames
   * the flight clear of the panels unless all of it is in view already. A
   * flight clicked on the map is where the user is looking, and that path
   * does not come here; nor is the map taken back from a user who moved it
   * meanwhile, or from the hotspot tour or Wrapped, which fly it, nor for
   * a flight no longer selected or no longer `still` what was picked (one
   * picked alone, or one looked at in share mode, see inspect).
   *
   * On a phone the statistics sheet or an airport's popup it was picked
   * from covers the map it is to be seen on, the popup together with the
   * profile strip that opens under it: both close.
   */
  private bringIntoView(pathId: number, still: () => boolean): void {
    const app = this.app;
    if (app.mobileBar?.isVisible()) {
      app.statsPanelVisible = false;
      app.airportManager.closePopup();
    }
    const map = app.map;
    if (!map) return;
    let moved = false;
    const onMoveStart = (event: { originalEvent?: unknown }): void => {
      if (event.originalEvent) moved = true;
    };
    map.on("movestart", onMoveStart);
    void loadFeatures().then(async (features) => {
      await afterLayout();
      map.off("movestart", onMoveStart);
      // Unless the selection moved on while the bundle loaded
      const wanted = app.selectedPathIds.has(pathId) && still();
      if (!wanted || moved || app.mapHeld) return;
      if (features) {
        features.frameFlights(app, new Set([pathId]), true);
        return;
      }
      // Without the bundle, a fit of its bounds as the map is flat
      const data = app.currentData;
      const segments = data && segmentsForPathIds(data.path_segments, [pathId]);
      const bounds = segments && segmentBounds(segments);
      if (bounds) {
        map.fitBounds(toBounds(bounds), { padding: mapChromePadding(map) });
      }
    });
  }

  /**
   * A click on a row of a list of flights (see PickList). The row's
   * checkbox adds the flight or takes it out, as Ctrl and Cmd do, and is
   * how a finger, which has neither, puts several together. Shift sets
   * every flight from the row clicked last to this one, in the order of
   * the list, to what this row's checkbox goes to: in, or out where it was
   * ticked; on that row itself it is a plain toggle. A plain click picks
   * the flight (see selectFlight). In share mode the checkbox alone changes
   * the shared flights, with Shift for a range: the rest of a row only
   * shows its flight, whatever key is held, and leaves the start of the
   * range where it was, as a click ignored during a replay or the tour
   * does.
   */
  pickFromList(pathId: number, event: MouseEvent, list: PickList): void {
    const box = event.target instanceof HTMLInputElement ? event.target : null;
    const sharing = this.app.isolateSelection;
    const held = this.held();
    const order = list.order;
    const from = list.anchor === null ? -1 : order.indexOf(list.anchor);
    const to = order.indexOf(pathId);
    // Only a click that changes the selection starts a range: a look at a
    // flight in share mode made a later Shift tick take flights in that
    // were never chosen
    if (!held && (box || !sharing)) list.anchor = pathId;
    if (event.shiftKey && (box || !sharing) && from >= 0 && to >= 0 && !held) {
      const selected = this.app.selectedPathIds;
      // The box is ticked or unticked by the click already
      const on = box ? box.checked : !selected.has(pathId);
      this.setRange(
        order.slice(Math.min(from, to), Math.max(from, to) + 1),
        on,
      );
    } else {
      this.selectFlight(
        pathId,
        !!box ||
          (!sharing && (event.ctrlKey || event.metaKey || event.shiftKey)),
      );
    }
    // The click has ticked or unticked the box already, also where the
    // selection stayed as it was
    if (box) box.checked = this.app.selectedPathIds.has(pathId);
  }

  /** Put the flights of a Shift range in the selection, or all of them out */
  private setRange(pathIds: readonly number[], on: boolean): void {
    const selected = new Set(this.app.selectedPathIds);
    for (const id of pathIds) {
      if (on) selected.add(id);
      else selected.delete(id);
    }
    this.select(selected);
  }

  /**
   * Mark the listed flights that are part of the selection: a row's
   * button is pressed, and its checkbox ticked
   */
  markSelected(rows: Iterable<HTMLElement>): void {
    for (const row of rows) {
      const selected = this.app.selectedPathIds.has(
        Number(row.dataset["pathId"]),
      );
      if (row instanceof HTMLInputElement) row.checked = selected;
      else row.setAttribute("aria-pressed", String(selected));
    }
  }

  selectPathsByAirport(airportName: string): void {
    if (this.held()) return;
    const pathIds = this.app.airportToPaths[airportName];
    if (pathIds) {
      this.select(new Set([...this.app.selectedPathIds, ...pathIds]));
    }
  }

  /**
   * Clearing and Share mode leave the selection alone while replay runs: it
   * plays the selected flights, and a change dimmed the replay's own
   * Stop button and switched the statistics to another view mid-flight.
   * So does the hotspot tour (see held). Their controls are disabled then
   * as well.
   */
  clearSelection(): void {
    if (this.held()) return;
    // Share mode goes with what it shared (AppStore.settle), in one update
    this.select(new Set());
  }

  /** Share the selection, or leave share mode and keep the flights */
  toggleIsolateSelection(): void {
    if (this.held()) return;
    // Dimmed, and a press said nothing of how to get a selection
    if (this.app.selectedPathIds.size === 0) {
      showToast(ISOLATE_HINT);
      return;
    }

    const app = this.app;
    const sharing = !app.isolateSelection;
    app.store.batch(() => {
      app.isolateSelection = sharing;
      // Out of share mode, the flights the filter hides or the year lacks
      // are deselected, as a filter change outside it does: they stayed
      // under a chip that counted them, with nothing drawn
      if (!sharing && app.currentData) fitSelection(app, app.currentData);
    });
    // What is drawn of them, tilted as the map is (ui/frameFlights.ts):
    // one the filter hides would widen the frame
    if (sharing) {
      void loadLazyBundle(loadFeatures, SHARE_FRAME_UNAVAILABLE_MESSAGE).then(
        (features) =>
          app.isolateSelection &&
          features?.frameFlights(app, shownSelection(app)),
      );
    }
  }

  /**
   * Say what is selected, and offer the way out.
   *
   * The selection is drawn on the paths, and the paths are only drawn once
   * the map is zoomed in far enough for them, so at the zoom levels that
   * show the heat bloom alone a selection was invisible. It is also what
   * Share mode, Replay and a shared link all act on, and none of them said
   * how much that was. Share mode is entered (Share) and left (Exit) here
   * too, next to the link that hands the flights on: while it is on, Exit
   * and the link take the place of Share and Clear, so the flights being
   * shown to someone are not cleared away by a slip.
   */
  private updateSelectionChip(): void {
    const chip = domCache.get("selection-chip");
    const count = domCache.get("selection-chip-count");
    if (!chip || !count) return;

    const app = this.app;
    const selected = app.selectedPathIds.size;
    // The store ends share mode with the last flight (AppStore.settle)
    const sharing = app.isolateSelection;
    const flights = pluralFlights(selected);
    // Share mode keeps the flights the filter hides or the year's dataset
    // lacks, which the map cannot draw; the chip says how many, and why as
    // far as it can tell (see fitSelection): "hidden by the filter" for an
    // aircraft, "not in 2024" for a year's flights that may be another
    // year's or gone from the site
    const data = app.currentData;
    const shown = sharing && data ? shownPathIds(app, data) : null;
    const missing = shown
      ? [...app.selectedPathIds].filter((pathId) => !shown.has(pathId))
      : [];
    const hidden = missing.length;
    const known = data ? datasetIndex(data).pathInfoById : null;
    const lacking = missing.filter((pathId) => !known?.has(pathId)).length;
    const year = app.selectedYear;
    const every = hidden === selected;
    let hiddenText = "";
    let filterWords = "";
    if (hidden && !lacking) {
      hiddenText = ", " + (every ? "all" : hidden) + " hidden";
      filterWords = " by the filter";
    } else if (hidden && lacking === hidden && year !== "all") {
      hiddenText = every ? ", none in " + year : `, ${hidden} not in ${year}`;
    } else if (hidden) {
      hiddenText = every ? ", none shown" : `, ${hidden} not shown`;
    }
    const text =
      selected === 0
        ? ""
        : sharing
          ? "Sharing " + flights + hiddenText + filterWords
          : flights + " selected";
    const changed = count.textContent !== text;
    if (changed && sharing) {
      // The words in a .selection-chip-word go on a phone, where the
      // chip's mark says it is shared (styles.css): "3 flights, 1 hidden"
      const word = (words: string): HTMLElement => {
        const span = document.createElement("span");
        span.className = "selection-chip-word";
        span.textContent = words;
        return span;
      };
      count.replaceChildren(word("Sharing "), flights + hiddenText);
      if (filterWords) count.append(word(filterWords));
    } else if (changed) {
      count.textContent = text;
    }
    chip.hidden = selected === 0;
    chip.classList.toggle("is-sharing", sharing);

    // A button hidden under the focus would drop it to <body>: it goes to
    // the one that takes its place
    const share = domCache.get("selection-share-btn");
    const exit = domCache.get("selection-exit-btn");
    const link = domCache.get("selection-link-btn");
    let lost = false;
    for (const [button, shown] of [
      [share, !sharing],
      [domCache.get("selection-clear-btn"), !sharing],
      [link, sharing],
      [exit, sharing],
    ] as const) {
      if (!button) continue;
      lost ||= !shown && button === document.activeElement;
      button.hidden = !shown;
    }
    if (lost) (sharing ? exit : share)?.focus();
    this.updateLinkLabel();

    // The polite region rather than a live chip: the count changes on every
    // click on a path, and a live region that replaces its own text is read
    // once things settle rather than once per click. The chip going away
    // is said too; with the Clear that had the focus gone, nothing did.
    if (changed) announceStatus(selected > 0 ? text : "Selection cleared");
  }

  /**
   * Say what the chip's link does: the share sheet, where the phone has
   * one. Named by what it says, for speech input (WCAG 2.5.3).
   */
  private updateLinkLabel(): void {
    const link = domCache.get("selection-link-btn");
    const label = link?.querySelector(".control-label");
    if (!link || !label) return;
    label.textContent = shareLinkLabel();
    link.title = label.textContent + " to these flights";
    link.setAttribute("aria-label", link.title);
  }

  /**
   * Share mode is a toggle that also needs a selection: `active` carries
   * the mode, aria-disabled "nothing to share yet", which the stylesheet
   * dims.
   */
  updateIsolateButton(): void {
    const btn = domCache.get("isolate-btn");
    if (!btn) return;

    applyToggleButtonState(btn, this.app.isolateSelection);
    // Still focusable, like the replay button, but announced as unavailable,
    // and saying why where the phone's sheet already did
    const none = this.app.selectedPathIds.size === 0;
    setUnavailableFor(btn, none ? NO_SELECTION_MESSAGE : null);
  }
}
