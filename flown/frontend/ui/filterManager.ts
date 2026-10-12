/**
 * Filter Manager - Handles year/aircraft filtering
 */
import type { MapApp } from "../mapApp";
import type { KMLDataset } from "../types";
import { aggregateAircraft, filterPaths } from "../calculations/statistics";
import { datasetIndex, shownPathIds } from "../calculations/datasetIndex";
import { calculateAirspeedRange } from "../features/layers";
import { domCache } from "../utils/domCache";
import { pluralFlights } from "../utils/htmlGenerators";
import { logError } from "../utils/logger";
import { announceStatus, showToast } from "../utils/toast";

/**
 * How long a pick in the year dropdown waits for the next one. The arrow
 * keys on a closed dropdown change it at every step, and each step loaded
 * its year: from 2026 down to 2020 six year files downloaded and decoded,
 * and stayed in memory, for the one that was wanted.
 */
export const YEAR_PICK_DELAY_MS = 250;

export class FilterManager {
  private app: MapApp;
  /** Monotonic id of the latest filter change; stale completions are dropped */
  private requestId = 0;
  /** Request id of the latest year change */
  private yearRequestId = 0;
  /**
   * The year switch that is loading, aborted by the next one: this one has
   * been replaced. Null once it is over.
   */
  private yearLoad: AbortController | null = null;
  /**
   * An aircraft picked while a year switch loads, applied with that switch
   * (see filterByAircraft). Null when there is none.
   */
  private pendingAircraft: string | null = null;
  /** The pick of the year dropdown that waits (see pickYear) */
  private yearPick: ReturnType<typeof setTimeout> | undefined;
  /**
   * Told when a year switch begins or ends; the note on an empty map
   * stays out of the way of one (see followLoadFailure)
   */
  onLoadChange: (() => void) | null = null;

  constructor(app: MapApp) {
    this.app = app;
    // A year switch still loading when a replay starts would land in the
    // middle of it: clear the selection the replay plays, reset the
    // statistics and leave the replay running over nothing. The replay is
    // the later request, so the switch gives way (see cancelPending). The
    // hotspot tour, which ends as other flights land, gives way to none
    // either: the switch ended it as soon as it started.
    app.store.subscribe("replayActive", (active) => {
      if (active) this.cancelPending();
    });
    app.store.subscribe("tourView", (view) => {
      if (view) this.cancelPending();
    });
  }

  /**
   * The mode that holds the filters, as the toast of a held Retry names it:
   * a replay (of one flight or of all) or the hotspot tour, which hold the
   * year select as well (ui/heldControls.ts). Null when none runs.
   */
  private holdingMode(): string | null {
    if (this.app.replayActive) return "the replay";
    if (this.app.tourView !== null) return "the tour";
    return null;
  }

  /**
   * Drop the filter change that is still loading, a Reset view's included,
   * and show the filter that is applied in the dropdowns again
   */
  cancelPending(): void {
    ++this.requestId;
    this.dropYearPick();
    this.yearLoad?.abort();
    this.yearLoad = null;
    this.pendingAircraft = null;
    const yearSelect = domCache.get("year-select", HTMLSelectElement);
    if (yearSelect) this.showLoadedYear(yearSelect);
    const aircraftSelect = domCache.get("aircraft-select", HTMLSelectElement);
    if (aircraftSelect) aircraftSelect.value = this.app.selectedAircraft;
    this.onLoadChange?.();
  }

  /** Whether a year switch is loading */
  get loading(): boolean {
    return this.yearLoad !== null;
  }

  /**
   * Switch to the year the dropdown shows once it has stopped changing
   * (see YEAR_PICK_DELAY_MS). Any other switch replaces a pick that waits.
   */
  pickYear(): void {
    this.dropYearPick();
    this.yearPick = setTimeout(() => {
      this.yearPick = undefined;
      if (!this.app.signal.aborted) this.filterByYear().catch(logError);
    }, YEAR_PICK_DELAY_MS);
  }

  private dropYearPick(): void {
    clearTimeout(this.yearPick);
    this.yearPick = undefined;
  }

  /**
   * Show the year whose data is loaded. With none loaded, the dropdown
   * keeps the year that failed, which the note on the empty map names and
   * offers to load again (see loadShownYear): it showed an empty "Year"
   * instead, so that picking the year it showed again was a change.
   */
  private showLoadedYear(select: HTMLSelectElement): void {
    if (this.app.currentData) select.value = this.app.selectedYear;
  }

  /**
   * Load the year of the dropdown while the map has no flights: the first
   * load of the page, and the Retry of the note on the map after it failed
   * (the year the page opened on, or one picked since that failed as well,
   * which the dropdown keeps showing). Unlike a switch it keeps the
   * selection, which is the one the page was opened with and has not been
   * checked against any dataset yet.
   */
  loadShownYear(): Promise<boolean> {
    return this.filterByYear(undefined, undefined, true);
  }

  updateAircraftDropdown(): void {
    const pathInfo = this.app.fullPathInfo;
    if (!pathInfo) return;

    const aircraftSelect = domCache.get("aircraft-select", HTMLSelectElement);
    if (!aircraftSelect) return;

    const currentSelection = this.app.selectedAircraft;

    // Clear existing options except "All"
    while (aircraftSelect.options.length > 1) {
      aircraftSelect.remove(1);
    }

    // Aircraft for the current year filter, sorted by flight count
    const aircraftList = aggregateAircraft(
      filterPaths(pathInfo, this.app.selectedYear, "all"),
    );

    // Populate dropdown
    let selectedAircraftExists = false;
    for (const aircraft of aircraftList) {
      const option = document.createElement("option");
      option.value = aircraft.registration;
      const typeStr = aircraft.type ? " (" + aircraft.type + ")" : "";
      option.textContent = aircraft.registration + typeStr;
      aircraftSelect.appendChild(option);

      if (aircraft.registration === currentSelection) {
        selectedAircraftExists = true;
      }
    }

    // If current selection doesn't exist in filtered list, reset to 'all'.
    // The dropdown first: the Filter sheet mirrors it and reads it as soon
    // as the store says the filter changed.
    if (!selectedAircraftExists && currentSelection !== "all") {
      // Said out loud, like a year that is not available: the recipient of
      // a shared link would otherwise see every aircraft without knowing
      // that the filter in the link was dropped
      const year = this.app.selectedYear;
      showToast(
        currentSelection +
          " has no flights in " +
          (year === "all" ? "the loaded years" : year) +
          ", showing all aircraft",
        "info",
      );
      aircraftSelect.value = "all";
      this.app.selectedAircraft = "all";
    } else {
      aircraftSelect.value = currentSelection;
    }
  }

  /**
   * Switch to the year the dropdown shows. The store only changes once the
   * year has loaded: a failed load puts the dropdown back to the year that
   * is still on the map instead of leaving the two disagreeing. `year`
   * picks the year in the dropdown first, and `also` changes more of the
   * store in the same batch, before the aircraft list is rebuilt (see
   * MapApp.resetView). Resolves to whether the year was applied: false
   * when it failed to load or a newer filter change replaced it, and then
   * `also` has not run either. `keepSelection` is for loadShownYear.
   */
  async filterByYear(
    year?: string,
    also?: () => void,
    keepSelection = false,
  ): Promise<boolean> {
    const yearSelect = domCache.get("year-select", HTMLSelectElement);
    // A replay and the hotspot tour hold the filters, and give way to no
    // switch (see the constructor). The Retry of a failed switch stays on
    // its toast into either: it swapped the dataset under a replay, and
    // ended the tour.
    if (!yearSelect || this.holdingMode()) return false;
    if (year) yearSelect.value = year;

    const requestedYear = yearSelect.value;
    const requestId = ++this.requestId;
    this.yearRequestId = requestId;
    this.dropYearPick();

    this.yearLoad?.abort();
    const yearLoad = new AbortController();
    this.yearLoad = yearLoad;
    this.onLoadChange?.();
    // Reset view puts the aircraft back to all; one picked before it is
    // overruled, one picked while it loads is applied after it
    if (also) this.pendingAircraft = null;

    // 1. Load the new year's data first so the aircraft list is based on it
    const data = await this.app.dataManager.loadData(
      requestedYear,
      yearLoad.signal,
      // Reset view is more than this switch, and its button stays there to
      // be pressed again. A retry of the first load has the panel on the
      // map to be tried again from, and a second Retry on the toast next to
      // it only made two ways of doing one thing. Not so a first load of
      // all years that brings some of them: the panel goes, and the toast
      // that says which did not come had nothing to try them again with.
      // That Retry is a switch to all years, which keeps the selection.
      also || (keepSelection && requestedYear !== "all")
        ? undefined
        : {
            label: "Retry",
            run: () => {
              // A replay or the tour holds the filters (see above); the
              // toast stays, so the failure is not lost to a press that did
              // nothing
              const mode = this.holdingMode();
              if (mode) {
                showToast(
                  "Stop " + mode + " to load " + requestedYear + " again",
                  "info",
                );
                return false;
              }
              void this.filterByYear(requestedYear);
              return true;
            },
          },
    );
    if (this.yearLoad === yearLoad) this.yearLoad = null;
    if (requestId !== this.requestId) {
      // Superseded. A newer year change owns the dropdown; an aircraft
      // change does not touch it, so it would keep showing a year that is
      // never applied, and picking that year again would fire no change
      if (
        this.yearRequestId === requestId &&
        yearSelect.value === requestedYear
      ) {
        this.showLoadedYear(yearSelect);
      }
      return false;
    }
    const aircraft = this.pendingAircraft;
    this.pendingAircraft = null;
    if (!data) {
      // The loader has already reported the failure. The Filter sheet
      // mirrors the dropdown, not the store, and the store did not change,
      // so it is told to read the dropdown again.
      this.showLoadedYear(yearSelect);
      this.app.mobileBar?.refreshSheet();
      // An aircraft picked meanwhile was one of the year still shown
      if (aircraft !== null) this.applyAircraft(aircraft);
      this.onLoadChange?.();
      return false;
    }

    // 2. Publish the year, the data and the aircraft list together, so the
    //    layers, the statistics and the airports see the final combination
    //    once. The dropdown may reset a registration that did not fly in
    //    the new year back to "all".
    //    An aircraft picked while the year loaded goes in with it, and the
    //    rebuilt list says so if the year has no flights of it.
    this.app.store.batch(() => {
      this.app.selectedYear = requestedYear;
      publishDataset(this.app, data);
      also?.();
      if (aircraft !== null) this.app.selectedAircraft = aircraft;
      this.updateAircraftDropdown();
      // The first load and its Retry fit the selection a link or a saved
      // state named, which nothing has checked yet
      if (keepSelection) fitSelection(this.app, data);
      else this.keepShownSelection();
    });
    announceDataset(requestedYear);
    return true;
  }

  filterByAircraft(): void {
    const aircraftSelect = domCache.get("aircraft-select", HTMLSelectElement);
    if (!aircraftSelect) return;

    // A year switch that is loading, or waiting to (pickYear), is not
    // thrown away: that silently lost the year someone had just picked.
    // The aircraft goes in with it.
    if (this.yearLoad || this.yearPick !== undefined) {
      this.pendingAircraft = aircraftSelect.value;
      return;
    }
    this.applyAircraft(aircraftSelect.value);
  }

  private applyAircraft(aircraft: string): void {
    this.app.store.batch(() => {
      this.app.selectedAircraft = aircraft;
      this.keepShownSelection();
    });
  }

  /**
   * Fit the selection to a filter change (see fitSelection). It dropped
   * every selected flight: the two flights of a day in share mode went with
   * a switch from all years to theirs, and so did share mode. The first
   * load fits a restored selection itself.
   */
  private keepShownSelection(): void {
    const data = this.app.currentData;
    if (data && !this.app.isInitializing) fitSelection(this.app, data);
  }
}

/**
 * Fit the selection to the dataset and the filter the page shows, and say
 * what it took out: after a filter change, a restored selection's first
 * load (or its Retry) and the Exit of share mode (PathSelection).
 *
 * Ids are derived from the flights, so a link or a saved state keeps
 * pointing at the same flight after a re-export. Only a dataset of every
 * year can tell one whose flight is gone: it is left out, shared or not. A
 * dataset of one year has none of the others, and cannot tell a flight of
 * another year from a deleted one; nothing short of loading every year
 * would (the metadata lists the years and their file sizes, no flights),
 * so it is said as it is: "not in 2024". The aircraft filter hides
 * flights the dataset has.
 *
 * Share mode keeps the flights the filter hides or the year lacks: what
 * it shares is fixed, its link hands them all on, and the chip says how
 * many are not shown (ui/pathSelection.ts). Outside it they are
 * deselected. A dataset missing a year that failed to load keeps the
 * flights it lacks: one may well be shown, and a Retry brings it back.
 * @param app - The MapApp instance to operate on
 * @param data - The dataset the page shows
 */
export function fitSelection(app: MapApp, data: KMLDataset): void {
  if (app.selectedPathIds.size === 0) return;
  const year = app.selectedYear;
  const everyYear = year === "all";
  const known = datasetIndex(data).pathInfoById;
  const shown = shownPathIds(app, data);
  app.store.batch(() => {
    const gone = deselect(
      app,
      (pathId) => everyYear && !data.incomplete && !known.has(pathId),
    );
    if (gone > 0) showToast(`Left out ${pluralFlights(gone)} not on this site`);
    if (app.isolateSelection) return;
    sayDeselected(
      deselect(app, (pathId) => !everyYear && !known.has(pathId)),
      "not in " + year,
    );
    sayDeselected(
      deselect(app, (pathId) => known.has(pathId) && !shown.has(pathId)),
      "hidden by the filter",
    );
  });
}

/** Say how many selected flights were deselected, and why */
function sayDeselected(count: number, why: string): void {
  if (count === 1) {
    showToast(`1 selected flight is ${why} and was deselected`);
  } else if (count > 1) {
    showToast(`${count} selected flights are ${why} and were deselected`);
  }
}

/**
 * Take the selected flights `drop` names out of the selection, in one
 * update; share mode ends with the last (AppStore.settle). Returns how
 * many went.
 */
function deselect(app: MapApp, drop: (pathId: number) => boolean): number {
  const selected = [...app.selectedPathIds];
  const kept = selected.filter((pathId) => !drop(pathId));
  if (kept.length < selected.length) app.selectedPathIds = new Set(kept);
  return selected.length - kept.length;
}

/**
 * Make a dataset the one the page shows. The speed scale is stretched over
 * the speeds of its flights (see calculateAirspeedRange), the way the
 * altitude scale follows the altitudes of the dataset it draws. Runs in the
 * batch that publishes the rest.
 * @param app - The MapApp instance to operate on
 * @param data - The dataset to show
 */
export function publishDataset(app: MapApp, data: KMLDataset): void {
  if (app.hasTimingData) {
    const range = calculateAirspeedRange(
      data.path_segments,
      app.metadataAirspeedRange,
    );
    // A dataset whose flights all went one speed has no scale to stretch,
    // and takes the one of the metadata: the range of the year before
    // belongs to other flights
    app.airspeedRange =
      range.max > range.min ? range : app.metadataAirspeedRange;
  }
  app.currentData = data;
}

/**
 * Say which year the map shows once its flights are there. The loading
 * indicator's region said what was loading and then went quiet, so the end
 * of a load, a retry's included, was never heard. After the batch that
 * published it: this replaces what its listeners said about the dataset,
 * such as a selection it cleared.
 * @param year - The year that was published, or "all"
 */
function announceDataset(year: string): void {
  announceStatus("Showing " + (year === "all" ? "all years" : year));
}
