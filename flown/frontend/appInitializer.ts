/**
 * App Initializer - Handles initial data loading and airport marker creation
 * Extracted from MapApp to reduce file size and improve modularity
 */

import { Marker } from "maplibre-gl";
import {
  airportControl,
  codeOwnerAt,
  onChipKey,
  createAirportElement,
  setAirportElementHome,
} from "./features/airports";
import { setUnavailable, setUnavailableFor } from "./utils/buttonState";
import { domCache } from "./utils/domCache";
import { applyMetricColors } from "./utils/htmlGenerators";
import { createActivationFilter, toLngLat } from "./utils/mapHelpers";
import { announceStatus, dismissToast, showToast } from "./utils/toast";
import { NO_CODE_LABEL } from "./ui/airportLabels";
import { NO_DATA_MESSAGE, NO_TIMING_MESSAGE } from "./ui/actions";
import type { MapApp } from "./mapApp";
import type { Airport, AirportMarker, Metadata } from "./types";

/** Said when the first load goes without the list of years */
const NO_YEARS_MESSAGE = "The list of years is unavailable, showing all years";

/** Said, with a Retry, when airports.json could not be loaded */
export const AIRPORTS_FAILED_MESSAGE = "Could not load the airports";

/**
 * Populate the year dropdown and make sure the selected year exists.
 * A restored/URL year that is not available falls back to the latest year
 * (with a toast) so the select never ends up blank. The page ships with
 * the latest year as an option, and a restored one may have one of its own
 * (see restoreState in ui/stateRestore.ts), which the list replaces: the
 * dropdown named the year it opens on from the start. A year picked from
 * those before the list came is the one taken: the bound handler leaves
 * the pick to the first load (see runAction), and the list replaced it.
 * @param app - The MapApp instance to operate on
 * @param availableYears - Years listed in the metadata
 */
export function resolveYearSelection(
  app: MapApp,
  availableYears: number[],
): void {
  const select = domCache.get("year-select", HTMLSelectElement);
  const available = (year: string): boolean =>
    year === "all" || availableYears.some((known) => String(known) === year);

  let picked: string | null = null;
  if (select) {
    // What the dropdown showed from the start: the restored year, or the
    // one the template marks as selected
    const shown = app.restoredYearFromState
      ? app.selectedYear
      : (select.querySelector("option[selected]")?.getAttribute("value") ??
        "all");
    if (select.value !== shown) picked = select.value;
    fillYears(select, availableYears);
  }

  const latestValue = latestYear(availableYears);
  app.defaultYear = latestValue;

  let year = app.selectedYear;
  if (picked !== null && available(picked)) {
    year = picked;
  } else if (year === "all") {
    // Default to the latest year only if no saved state exists
    if (!app.restoredYearFromState) year = latestValue;
  } else if (!available(year)) {
    showToast(
      "Year " +
        year +
        " is not available, showing " +
        (availableYears.length > 0 ? latestValue : "all years"),
      "info",
    );
    year = latestValue;
  }

  // The dropdown before the store: the Filter sheet mirrors the dropdown
  // and reads it as soon as the store announces the year
  if (select) select.value = year;
  app.selectedYear = year;
}

/** The newest of `years`, "all" for none: the year a first visit opens on */
function latestYear(years: number[]): string {
  return years.length > 0 ? Math.max(...years).toString() : "all";
}

/** Put the years of the metadata after "All years" in the dropdown */
function fillYears(select: HTMLSelectElement, years: number[]): void {
  select.length = 1;
  // With the value written out: an option's value falls back to its text,
  // but only as a property, and what reads the attribute found none
  for (const year of years) {
    select.add(new Option(String(year), String(year)));
  }
}

/** Apps whose restored speed layer waits for late metadata (see applyMetadata) */
const speedLayerHeld = new WeakSet<MapApp>();

/**
 * Take in metadata.json: the years of the dropdown, the model names and
 * whether there are speeds, which the speed layer and the replay need.
 * Null is a first load without it, which loads all years. `late` is the
 * metadata a load of all years brought after that (see loadInitialData):
 * the dropdown gets its years and keeps the one it shows, which is the one
 * loading, and the toast that said they were missing goes.
 */
function applyMetadata(
  app: MapApp,
  metadata: Metadata | null,
  late = false,
): void {
  const select = domCache.get("year-select", HTMLSelectElement);
  if (!metadata) {
    // Without the index there is no year to offer, so the map loads all of
    // them, which the dropdown says: it named the year the page ships with
    if (app.selectedYear !== "all") showToast(NO_YEARS_MESSAGE, "error");
    if (select) select.value = "all";
    app.selectedYear = "all";
  } else if (late) {
    // Reset view goes to the year a first visit opens on, which it is now
    // able to tell: it stayed at all years for the rest of the session
    app.defaultYear = latestYear(metadata.available_years);
    if (select) {
      const shown = select.value;
      fillYears(select, metadata.available_years);
      select.value = shown;
      if (select.selectedIndex < 0) select.value = app.selectedYear;
    }
    dismissToast(NO_YEARS_MESSAGE);
  } else {
    resolveYearSelection(app, metadata.available_years);
  }

  // The statistics are computed from the loaded paths; the metadata only
  // adds the model names that aircraft.json knows
  if (metadata) {
    app.aircraftModels = metadata.aircraft_models ?? {};
  }

  // Load groundspeed range from metadata; exports without timestamps have
  // no groundspeeds at all, and then no speed layer and no replay. Settled
  // before the dataset is published, which draws the layers.
  const hasTimingData = metadata !== null && metadata.max_groundspeed_knots > 0;
  app.hasTimingData = hasTimingData;

  // A restored speed layer has no speeds to draw. Its button is unavailable
  // below, and an unavailable button cannot be released, so the store is
  // put right here rather than restoring an empty layer that shows as
  // pressed over a legend with placeholder labels.
  // Without the metadata it is only not known yet: the speed layer comes
  // back with late metadata that has speeds, unless altitude took its place.
  if (!hasTimingData && app.airspeedVisible) {
    app.airspeedVisible = false;
    if (!metadata) speedLayerHeld.add(app);
  }

  if (hasTimingData) {
    app.airspeedRange = app.metadataAirspeedRange = {
      min: metadata.min_groundspeed_knots,
      max: metadata.max_groundspeed_knots,
    };
    if (speedLayerHeld.delete(app) && !app.altitudeVisible) {
      app.airspeedVisible = true;
    }
  }

  // The speed layer is unavailable without timing data (e.g., Charterware
  // files without per-point timestamps won't have speed data); altitude
  // still works, from the coordinates. aria-disabled rather than disabled,
  // so the button stays reachable and says why (#airspeed-reason), and a
  // click on it as well (UIToggles.toggleAirspeed). The pressed state
  // follows the store (see setupButtonSync); only this is owned here.
  const airspeedBtn = domCache.get("airspeed-btn");
  if (airspeedBtn) {
    // Dimmed, its tooltip says why rather than what it would colour
    setUnavailableFor(airspeedBtn, hasTimingData ? null : NO_TIMING_MESSAGE);
    if (hasTimingData) airspeedBtn.removeAttribute("aria-describedby");
    else airspeedBtn.setAttribute("aria-describedby", "airspeed-reason");
  }
}

/**
 * Load initial data including airports, metadata, and path data
 * @param app - The MapApp instance to operate on
 */
export async function loadInitialData(app: MapApp): Promise<void> {
  colorSegmentPopups(app.signal);
  // Said over flights whenever they come, should airports.json fail
  const airportsAgain = followMissingAirports(app);
  // From the start, so the legends wait for the first dataset
  const failure = followLoadFailure(app, airportsAgain);

  // Both are preloaded by the template; asked for together so that neither
  // waits for the other when they are not
  const [airports, metadata] = await Promise.all([
    app.dataManager.loadAirports(),
    app.dataManager.loadMetadata(),
  ]);

  // Populate year filter dropdown and validate the selected year
  applyMetadata(app, metadata);
  // A load of all years asks for the metadata again (DataLoader), and what
  // it brings is taken in: the page went without years, speeds and model
  // names for the rest of the session
  if (!metadata) {
    app.dataManager.onMetadata = (late) => applyMetadata(app, late, true);
  }

  // Add airport markers. None shows until the dataset says which airports
  // its flights used: a first load that failed left the dots of every year
  // on the map, unlabelled.
  if (airports) showAirportMarkers(app, airports);
  else airportsAgain.failed();

  // Load the selected year's data; currentData is the single source of
  // path_info and path_segments for all managers. The layers, the
  // statistics panel and the airport markers follow it through their store
  // subscriptions; one flush, so nobody sees the dataset with a selection
  // it does not have or an aircraft filter it has no flights for. A
  // failure is said by the panel on the map, with its Retry, and not by a
  // toast as well (see followLoadFailure).
  await app.filterManager.loadShownYear();
  failure.settle();

  // Set initial airport marker sizes
  app.airportManager.updateAirportMarkerSizes();

  // Restore stats panel visibility, over flights only: without them the
  // rail opened on zeros (see followLoadFailure). Given up on, the flag
  // goes, as Wrapped's does in MapApp: the saves and Copy link kept
  // writing the statistics open while the rail was closed (see
  // StateManager.panelVisible), and a Retry that loads does not open it.
  if (app.savedState?.statsPanelVisible && app.currentData) {
    app.statsPanelVisible = true;
  } else if (app.savedState) {
    delete app.savedState.statsPanelVisible;
  }
}

/** Put the markers of `airports` on the map, hidden until a dataset says */
function showAirportMarkers(app: MapApp, airports: Airport[]): void {
  createAirportMarkers(app, airports);
  app.airportManager.showAirports();
}

/**
 * Follow airports.json after it failed: say so over flights, the first
 * load's or those of a year picked later, which went without airports and
 * without a word or a Retry for the session; once per failure, not at
 * every load. `again` loads it once more while it is missing (null
 * otherwise) and puts the airports on the map: their markers at the size
 * of the zoom, the home base and the labels. The rest (the search, the
 * tour, the profile, Wrapped) reads them from state/siteData.ts as it
 * needs them. It resolves to whether they came, one load at a time: a
 * double click on the toast's Retry, which stays clickable while it fades,
 * ran two and left a second set of markers on the map.
 */
function followMissingAirports(app: MapApp): {
  failed: () => void;
  again: () => Promise<boolean> | null;
} {
  let missing = false;
  let said = false;
  let loading: Promise<boolean> | null = null;
  const again = (): Promise<boolean> =>
    (loading ??= app.dataManager
      .loadAirports()
      .then((airports) => {
        if (!airports || app.signal.aborted) {
          // A new failure, which flights on the map say again
          said = false;
          return false;
        }
        missing = false;
        dismissToast(AIRPORTS_FAILED_MESSAGE);
        showAirportMarkers(app, airports);
        app.airportManager.updateAirportPopups();
        app.airportManager.updateAirportMarkerSizes();
        return true;
      })
      .finally(() => (loading = null)));
  const say = (): void => {
    if (!missing || said || loading || !app.currentData || app.signal.aborted) {
      return;
    }
    said = true;
    showToast(AIRPORTS_FAILED_MESSAGE, "error", {
      label: "Retry",
      run: () => void again().then(say),
    });
  };
  app.store.subscribe("currentData", say, { signal: app.signal });
  return {
    failed: () => {
      missing = true;
      say();
    },
    again: () => (missing ? again() : null),
  };
}

/**
 * The controls of what is made of the flights (NEED_DATA in ui/actions.ts),
 * shown unavailable while a load left the map without any
 */
const NEED_DATA_CONTROL_IDS = [
  "stats-btn",
  "wrapped-btn",
  "replay-all-btn",
  "hotspot-tour-btn",
  "cross-section-btn",
  "export-btn",
];

/**
 * Say on the map itself that the first load left it without flights, and
 * offer to load them again. Otherwise the page was an empty map whose
 * dropdown named the year, with a toast that went after four seconds. What
 * failed is said there, and only there, while the map has no flights (see
 * DataManager.failureNote): a toast beside it said it a second time.
 * @param app - The MapApp instance to operate on
 * @returns `settle` says the first load is over, before which nothing is
 *   shown
 */
function followLoadFailure(
  app: MapApp,
  airports: { again: () => Promise<boolean> | null },
): { settle: () => void } {
  const panel = domCache.get("map-empty");
  const retryButton = domCache.get("map-empty-retry");
  const text = panel?.querySelector("p");
  // Heard as the toast's was, which the panel's text is not: when it is
  // written on the panel on screen, or when the panel comes up with it. A
  // load of all years that brings some years hides it unseen, and the
  // data manager puts what failed into a toast, which is heard itself.
  const say = (): void => {
    if (text?.textContent) announceStatus(text.textContent);
  };
  app.dataManager.failureNote = (message) => {
    if (text) text.textContent = message;
    if (panel && !panel.hidden) say();
  };
  let settled = false;
  let retrying = false;
  /** Set while the controls of NEED_DATA_CONTROL_IDS say there is no data */
  let blocked = false;
  /** Their titles from before, given back with the data */
  const titles = new Map<HTMLElement, string>();
  const sync = (): void => {
    // The colour legends stand for nothing while there is none (styles.css)
    document.body.classList.toggle("no-data", !app.currentData);
    // A click on one says so (runAction); a Retry under way still has none
    if (blocked !== (settled && !app.currentData)) {
      blocked = !blocked;
      document.body.classList.toggle("flights-failed", blocked);
      for (const id of NEED_DATA_CONTROL_IDS) {
        const control = domCache.get(id);
        if (!control) continue;
        if (blocked) titles.set(control, control.title);
        setUnavailable(
          control,
          blocked,
          blocked ? NO_DATA_MESSAGE : (titles.get(control) ?? control.title),
        );
      }
      app.mobileBar?.syncTabs();
      app.mobileBar?.refreshSheet();
    }
    if (!panel) return;
    // A year picked from the dropdown meanwhile has the loading indicator
    // to say it is loading, as a Retry has
    const hide =
      !settled ||
      retrying ||
      app.filterManager.loading ||
      app.currentData !== null;
    // Its own Retry is what hides it, and would take the focus with it
    if (hide && panel.contains(document.activeElement)) {
      app.map?.getCanvas().focus();
    }
    const appears = panel.hidden && !hide;
    panel.hidden = hide;
    if (appears) say();
    // The one thing to do on the page then, so the keyboard is taken to
    // it, unless the focus was put somewhere else meanwhile: the map's
    // canvas is where the Retry left it
    const focused = document.activeElement;
    if (
      appears &&
      (focused === null ||
        focused === document.body ||
        focused === app.map?.getCanvas())
    ) {
      retryButton?.focus();
    }
  };
  const retry = async (): Promise<void> => {
    if (retrying) return;
    // What they said is being acted on; a new failure says so again. Only
    // the failures of loads: another error on screen is still true.
    app.dataManager.dismissFailures();
    retrying = true;
    sync();
    try {
      // The airports as well, when they failed with the flights: the
      // markers are there before the dataset that says which of them show.
      // Failed again under flights that came, they say so as on the first
      // load.
      const loading = airports.again();
      if (loading) await loading;
      await app.filterManager.loadShownYear();
    } finally {
      retrying = false;
      sync();
    }
  };
  retryButton?.addEventListener("click", () => void retry(), {
    signal: app.signal,
  });
  app.filterManager.onLoadChange = sync;
  app.store.subscribe("currentData", sync);
  sync();
  return {
    settle: () => {
      settled = true;
      sync();
    },
  };
}

/**
 * Colour the segment popups and tooltips as they are written into the
 * map. They carry their colours as data, since the CSP allows no style
 * attribute (see applyMetricColors); the observer runs before the next
 * paint, so they never show uncoloured. It stops with `signal`.
 */
export function colorSegmentPopups(signal: AbortSignal): void {
  const container = domCache.get("map");
  if (!container) return;
  const observer = new MutationObserver((records) => {
    for (const { target } of records) applyMetricColors(target as Element);
  });
  observer.observe(container, { childList: true, subtree: true });
  signal.addEventListener("abort", () => observer.disconnect());
}

/**
 * Create the airport markers and put them on the map.
 * The popup content and the home-base class are filled in by AirportManager
 * once the path data is loaded, so no marker ever shows a flight count that
 * the current filter contradicts.
 * @param app - The MapApp instance to operate on
 * @param airports - Array of airports to create markers for
 */
export function createAirportMarkers(app: MapApp, airports: Airport[]): void {
  const map = app.map;
  if (!map) return;

  for (const airport of airports) {
    const name = airport.name;
    const element = createAirportElement(name, airport.code ?? NO_CODE_LABEL);
    // The relief or the far side of the globe hides it, and its code with
    // it: the stylesheet fades it out (`opacityWhenCovered` is its opacity)
    const marker = new Marker({
      element,
      anchor: "center",
      opacityWhenCovered: 0,
    })
      .setLngLat(toLngLat([airport.lat, airport.lon]))
      .addTo(map);

    // The popup is the one AirportManager shares between all airports
    const airportMarker: AirportMarker = {
      marker,
      getLatLng: () => {
        const { lat, lng } = marker.getLngLat();
        return { lat, lng };
      },
      getElement: () => element,
      getControl: () => airportControl(element),
      openPopup: () => app.airportManager.openPopup(name),
      closePopup: () => app.airportManager.closePopup(name),
      isPopupOpen: () => app.airportManager.isPopupOpen(name),
      // `hidden` rather than taking the marker off the map: a hidden
      // element leaves the tab order
      setVisible: (visible) => {
        element.hidden = !visible;
      },
      setHome: (home) => setAirportElementHome(element, home),
    };

    // A button reports Enter and Space as a click, and so does the chip of
    // the code while it is the target (onChipKey), so this one listener is
    // the mouse, the finger and the keyboard, on the dot and on the code
    // alike. A second activation closes the popup again, as the airplane's
    // does. The second click of a double click or a double tap is not one:
    // it would close what the first opened (see createActivationFilter).
    const isActivation = createActivationFilter();
    element.addEventListener("click", (event) => {
      if (isActivation(event)) {
        app.airportManager.activateAirport(
          codeOwnerAt(event, element) ?? name,
          app.touchClock.isTouchClick(event),
        );
      }
    });
    // Escape reaches the popup itself only while focus is inside it
    element.addEventListener("keydown", (event) => {
      if (event.key === "Escape") airportMarker.closePopup();
      else onChipKey(event);
    });

    // In place of one made before, which goes: a second set over the
    // first stayed on the map for good, with no entry left to take it off
    app.airportMarkers[name]?.marker.remove();
    app.airportMarkers[name] = airportMarker;
  }
}
