/**
 * Wrapped Manager - Handles year-in-review/wrapped feature
 */
import type { FitBoundsOptions } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { Airport, MapCenter } from "../types";
import { domCache } from "../utils/domCache";
import { hideControls, restoreControls } from "./wrappedChrome";
import { toLngLat, whenMapComplete } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import {
  TOAST_ALERT_ID,
  TOAST_STACK_ID,
  TOAST_STATUS_ID,
} from "../utils/toast";
import { airportCode, findHomeBase } from "../features/airports";
import { countryFlagSrc, groupByCountry } from "../features/countries";
import { countryDisplayName } from "../utils/formatters";
import {
  calculateYearStats,
  findFurthestAirport,
  generateFunFacts,
} from "../features/wrapped";
import type { Coordinate } from "../utils/geometry";
import {
  calculateFilteredStatistics,
  filterStatisticsInSlices,
} from "../calculations/panelStats";
import type { FilteredStatistics } from "../types";
import { datasetIndex, type FilterView } from "../calculations/datasetIndex";
import { flightsKey } from "../state/localFlags";
import { knownNewAreaKm2, yearNewAreaKm2 } from "../calculations/newAreas";
import { whenIdle } from "../utils/whenIdle";
import { logError } from "../utils/logger";
import {
  generateStatsHtml,
  generateFunFactsHtml,
  generateAircraftFleetHtml,
  generateHomeBaseHtml,
  generateDestinationsHtml,
} from "../utils/wrappedHtml";
import { watchScrollEnd, type ScrollEndWatcher } from "../utils/scrollFade";
import { siteData } from "../state/siteData";
import {
  FIT_PADDING,
  followDestinationHover,
  overviewBounds,
  startWrappedIntro,
  type IntroOverview,
  type WrappedIntro,
} from "./wrappedIntro";
import { userView } from "./replayState";
import { trustedHtml } from "../utils/trustedHtml";

/**
 * Elements that stay out of the inert set while the dialog is open: the
 * toasts, whose live regions would otherwise fall silent for as long as
 * Wrapped is open.
 */
const NON_INERT_IDS = new Set([
  TOAST_STACK_ID,
  TOAST_STATUS_ID,
  TOAST_ALERT_ID,
]);

/** Delay before the map is remeasured after moving back out of the dialog */
const MAP_RESTORE_DELAY_MS = 100;

/**
 * Longest the map panel holds its placeholder waiting for tiles. The map
 * says when they have landed; this covers the case where it never does:
 * offline, or in a tab that is hidden and renders no frames.
 */
const MAP_REVEAL_TIMEOUT_MS = 1200;

/** Where a session notes the years whose intro has played (see introsSeen) */
export const INTRO_SEEN_KEY = "flown-wrapped-intro";

/**
 * The years whose intro has played in this session, under `key`: ten
 * seconds at every opening was a wait for anyone who went back to the
 * cards. Where the storage is out of reach, none, and it plays every time,
 * as it did. The key is the page's, and apart for the visitor's own
 * flights (flightsKey), whose 2025 is not the site's.
 */
function introsSeen(key: string): string[] {
  try {
    return (sessionStorage.getItem(key) ?? "").split(",");
  } catch {
    return [];
  }
}

/** Note that the intro of the year `year` has played (see introsSeen) */
function introSeen(key: string, year: string): void {
  try {
    sessionStorage.setItem(key, [...introsSeen(key), year].join(","));
  } catch {
    // Blocked storage
  }
}

/**
 * The user's map view: app-shaped center, zoom in the map's own unit, and
 * the globe and 3D switches, put back as the dialog closes: the intro
 * turns the globe on while it plays (see ui/wrappedIntro.ts). Without the
 * intro the overview keeps the projection the user chose.
 */
export interface UserMapView {
  center: MapCenter;
  zoom: number;
  bearing: number;
  pitch: number;
  globeVisible: boolean;
  threeDVisible: boolean;
}

const coordinatesByAirports = new WeakMap<Airport[], Map<string, Coordinate>>();

/**
 * Airport coordinates exported by the backend, keyed by airport name. Kept
 * with the airports array, which is loaded once.
 */
function airportCoordinates(): Map<string, Coordinate> {
  const airports = siteData.airports;
  if (!airports) return new Map();
  let coordinates = coordinatesByAirports.get(airports);
  if (!coordinates) {
    coordinates = new Map();
    for (const airport of airports) {
      if (typeof airport.lat === "number" && typeof airport.lon === "number") {
        coordinates.set(airport.name, [airport.lat, airport.lon]);
      }
    }
    coordinatesByAirports.set(airports, coordinates);
  }
  return coordinates;
}

export class WrappedManager {
  private app: MapApp;
  /**
   * Where the map goes back to on close: its parent, and the element it
   * stood before. An index into the parent's children went stale once the
   * mobile bar came or went ahead of the map across the breakpoint.
   */
  private originalMapParent: HTMLElement | null;
  private originalMapNext: Element | null;
  private savedControlDisplays: Map<HTMLElement, string> = new Map();
  private escapeHandler: ((e: KeyboardEvent) => void) | null = null;
  private previouslyFocused: HTMLElement | null = null;
  private inertElements: Element[] = [];
  private inertObserver: MutationObserver | null = null;
  private mapMoveTimer: ReturnType<typeof setTimeout> | null = null;
  private mapResizeTimer: ReturnType<typeof setTimeout> | null = null;
  private mapRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  /** Drops the map panel's placeholder; held so a close can run it early */
  private revealMap: (() => void) | null = null;
  private cardsScroll: ScrollEndWatcher | null = null;
  /**
   * The map view from before the dialog fitted it to the data. Kept until
   * the close has put it back, so a reopening in between does not take the
   * fitted view for the user's.
   */
  private savedView: UserMapView | null = null;
  /**
   * Stops the statistics the cards wait for (see fillCards), null when
   * they wait for none
   */
  private statsAbort: AbortController | null = null;
  private destroyed = false;
  private unsubscribeData: () => void;
  /** Counts the openings, so a late answer knows its own */
  private opened = 0;
  /** The intro while it plays (see ui/wrappedIntro.ts) */
  private intro: WrappedIntro | null = null;
  /**
   * Where the dialog fits the map to, while it is open. The intro reads
   * it as it comes to rest, so a change of the data moves it there too.
   */
  private overview: IntroOverview | null = null;
  /** The airports of the destinations card, in the order of its rows */
  private destinations: string[] = [];
  /** Takes the listeners of the dialog's own controls off */
  private readonly listening = new AbortController();
  /** Drops a flight to a destination still waiting for the pointer */
  private readonly cancelHover: () => void = () => {};

  /**
   * The user's own map view while the dialog holds the map fitted to all
   * the data, null otherwise. The state manager saves this one: with the
   * fitted view in the URL and in storage, a reload or a shared link landed
   * on the overview once the dialog was closed. The zoom is the map's own;
   * the state manager converts it like any other.
   */
  userMapView(): UserMapView | null {
    return this.savedView;
  }

  constructor(app: MapApp) {
    this.app = app;
    this.originalMapParent = null;
    this.originalMapNext = null;

    // A year that finishes loading while the dialog is open replaces the
    // cards, which were computed from the data that was there before, and
    // so does a filter that changes without new data (an aircraft held
    // while a year loaded, applied as that load failed). The map follows
    // them to the flights now there; an intro still playing those of before
    // makes way, and comes to rest on the new overview.
    this.unsubscribeData = app.store.subscribeKeys(
      ["currentData", "selectedYear", "selectedAircraft"],
      () => {
        if (!app.wrappedVisible) return;
        this.fillCards();
        const overview = this.overview;
        if (!overview) return;
        overview.bounds = overviewBounds(app);
        if (this.intro) this.intro.skip();
        else app.map?.fitBounds(overview.bounds, overview.options);
      },
    );

    const signal = this.listening.signal;
    domCache
      .get("wrapped-skip-btn")
      ?.addEventListener("click", () => this.intro?.skip(), { signal });
    // A card on: the next to the top of the column. The first is taller
    // than the column where its figures need it, so a page down could stop
    // short of the next.
    const more = domCache.get("wrapped-more-btn");
    more?.addEventListener(
      "click",
      () => {
        const column = domCache.get("wrapped-cards-column");
        const next = more.closest("section")?.nextElementSibling;
        if (!column || !next) return;
        column.scrollBy({
          top:
            next.getBoundingClientRect().top -
            column.getBoundingClientRect().top,
          behavior: prefersReducedMotion() ? "instant" : "smooth",
        });
      },
      { signal },
    );
    // Hovering a destination flies the map there, once the intro is over
    const grid = domCache.get("wrapped-airports-grid");
    if (grid) {
      this.cancelHover = followDestinationHover(
        app,
        grid,
        (row) => {
          const rows = [...grid.querySelectorAll(".destination")];
          const name = this.destinations[rows.indexOf(row)];
          return name ? airportCoordinates().get(name) : undefined;
        },
        () => (this.intro || !app.wrappedVisible ? null : this.overview),
        signal,
      );
    }
  }

  private setWrappedVisible(visible: boolean): void {
    this.app.store.set("wrappedVisible", visible);
  }

  /**
   * Put the cards column back to the top for this opening and keep the
   * bottom fade in step with its scroll position: the fade says "there is
   * more below", so it has to go once there is not. Only the desktop layout
   * scrolls the column; the stacked one scrolls the dialog and drops the
   * mask in CSS.
   */
  private prepareCardsScroll(column: HTMLElement): void {
    // The column keeps its scroll position between openings, so without this
    // reopening Wrapped lands mid-card instead of on the title
    column.scrollTop = 0;
    this.cardsScroll = watchScrollEnd(column);
  }

  /**
   * Hold the placeholder until the map has something to show.
   *
   * Moving the map in takes two frames; its tiles take as long as the
   * network does, and the panel showed a black rectangle for all of it.
   */
  private revealMapWhenPainted(
    container: HTMLElement,
    revealed?: () => void,
  ): void {
    const map = this.app.map;
    // Taken down early by a close, which aborts the wait with it
    const waiting = new AbortController();
    const reveal = (): void => {
      if (waiting.signal.aborted) return;
      waiting.abort();
      this.revealMap = null;
      container.classList.remove("is-awaiting-map");
      revealed?.();
    };
    this.revealMap = reveal;
    if (!map) {
      reveal();
      return;
    }
    // The fitted view at rest with its tiles drawn, the first moment the
    // panel has anything to show (whenMapComplete, at every frame; a map
    // already at rest is complete at once). The intro's far globe
    // (`revealed`) as soon as its tiles are drawn: it waited for its labels
    // to fade in as well, a third of a second more of the dialog with the
    // title alone (see ui/wrappedIntro.ts). Nor before the heat of the
    // flights is on it: the year worker draws it (see DataManager.drawHeat),
    // and the map is at rest meanwhile, with the heat of what it showed
    // before.
    void whenMapComplete(
      map,
      () =>
        !this.app.dataManager.heatRequests && (!!revealed || !map.isMoving()),
      [],
      MAP_REVEAL_TIMEOUT_MS,
      waiting.signal,
    ).then(reveal);
  }

  /**
   * The home base of the flights the dialog describes, where the intro
   * flies to, if it is known
   */
  private homeBase(): Coordinate | null {
    const home = findHomeBase(this.filterView()?.airportCounts() ?? {});
    return home ? (airportCoordinates().get(home) ?? null) : null;
  }

  /**
   * Fit options for the overview, without the animation for reduced motion.
   * No duration: the map's default carries the fit, as it always has. The
   * overview is north up and flat, whatever the user's view was: it is read
   * next to a list of places, and a fit is only exact for a flat map.
   */
  private fitOptions(): FitBoundsOptions {
    return {
      padding: FIT_PADDING,
      bearing: 0,
      pitch: 0,
      animate: !prefersReducedMotion(),
    };
  }

  /**
   * Open the dialog, with the intro when `intro` asks for it (its button
   * does, a restored state does not), motion is welcome and the year's
   * intro has not played in this session yet
   */
  showWrapped(intro = false): void {
    if (!this.app.map || this.app.wrappedVisible) return;
    // Replay owns the map while it runs, and so does the hotspot tour; the
    // control is disabled then, and this covers every other way in (the
    // mobile tab, a restored state, a click whose bundle came late)
    if (this.app.replayActive || this.app.tourView) return;

    // A close that is still settling must not remeasure a map that is about
    // to move back into the dialog
    this.cancelPendingMapTimers();
    const opened = ++this.opened;

    this.fillCards();

    // Move the map into the wrapped container
    const mapContainer = domCache.get("map");
    const wrappedMapContainer = domCache.get("wrapped-map-container");

    if (!mapContainer || !wrappedMapContainer) return;

    // Where the map is now, taken on every opening: the page around it
    // changes between two of them (the mobile bar goes in ahead of the map
    // or out again as the window crosses the breakpoint). A map still in
    // the dialog, from a close whose move has not run, is not where it
    // belongs.
    if (mapContainer.parentElement !== wrappedMapContainer) {
      this.originalMapParent = mapContainer.parentElement;
      this.originalMapNext = mapContainer.nextElementSibling;
    }

    // The dialog fits the map to all the data; closing it puts the user's
    // own view back. A view still waiting to be put back by a close that is
    // settling is the user's, the current one is the fitted one; and while
    // the camera flies back to the user's view from the tour or a chase,
    // that one is (userView)
    const view = this.savedView ? null : userView(this.app);
    if (view) {
      this.savedView = {
        ...view,
        globeVisible: this.app.globeVisible,
        threeDVisible: this.app.threeDVisible,
      };
    }
    const overview = (this.overview = {
      bounds: overviewBounds(this.app),
      options: this.fitOptions(),
    });
    const year = this.app.selectedYear;
    const introKey = flightsKey(INTRO_SEEN_KEY, !!this.app.config.localFlights);
    const home =
      intro && !prefersReducedMotion() && !introsSeen(introKey).includes(year)
        ? this.homeBase()
        : null;
    // The map shows at once in an opening with the intro (wrapped.css)
    domCache.get("wrapped-modal")?.classList.toggle("has-intro", !!home);
    if (home) {
      // Seen once it plays (begin, below): a year without a home base yet
      // has not, nor has one whose intro gave up waiting for its code
      this.intro = startWrappedIntro(this.app, home, overview, () => {
        this.intro = null;
      });
    } else {
      this.app.map.fitBounds(overview.bounds, overview.options);
    }

    // The controls go while the dialog has the map (see hideControls)
    this.savedControlDisplays = hideControls();

    // Show modal first to ensure wrapped-map-container has dimensions
    const modal = domCache.get("wrapped-modal");
    if (modal) {
      modal.hidden = false;
      this.trapFocus(modal);
    }
    this.setWrappedVisible(true);

    const cardsColumn = domCache.get("wrapped-cards-column");
    if (cardsColumn) this.prepareCardsScroll(cardsColumn);
    // The stacked layout scrolls the content row instead of the column, and
    // it keeps its position between openings just the same
    const content = domCache.get("wrapped-content");
    if (content) content.scrollTop = 0;

    // Add Escape key handler to close modal
    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        this.closeWrapped();
      }
    };
    document.addEventListener("keydown", this.escapeHandler);

    // The map is moved in two frames from now, and its tiles land after
    // that. Until then the panel would be an empty rectangle taking up most
    // of the dialog, so it holds a placeholder of its own surface and the
    // map fades in over it.
    wrappedMapContainer.classList.add("is-awaiting-map");

    // Wait for modal to render and have dimensions. The handles are cleared
    // on close so that a quick close cannot move the map into a hidden dialog.
    this.mapMoveTimer = setTimeout(() => {
      this.mapMoveTimer = null;
      if (!this.app.wrappedVisible) return;
      // Now move map into wrapped container (which now has dimensions)
      wrappedMapContainer.appendChild(mapContainer);

      // Make sure the map container fills the wrapped container
      mapContainer.style.width = "100%";
      mapContainer.style.height = "100%";
      mapContainer.style.borderRadius = "var(--radius-sheet)";
      mapContainer.style.overflow = "hidden";

      // Force a layout recalculation
      wrappedMapContainer.offsetHeight;

      // Now that container has dimensions, have the map measure it
      this.mapResizeTimer = setTimeout(() => {
        this.mapResizeTimer = null;
        if (!this.app.map || !this.app.wrappedVisible) return;
        this.app.map.resize();
        const intro = this.intro;
        if (!intro) {
          this.app.map.fitBounds(overview.bounds, overview.options);
          this.revealMapWhenPainted(wrappedMapContainer);
          return;
        }
        // The far view is drawn before the camera sets off from it; a
        // skip while the intro waited has fitted the map already
        void intro.begin().then((plays) => {
          // Closed or torn down meanwhile, and perhaps opened again since
          if (
            this.destroyed ||
            !this.app.wrappedVisible ||
            this.opened !== opened
          ) {
            return;
          }
          if (plays) introSeen(introKey, year);
          this.revealMapWhenPainted(
            wrappedMapContainer,
            plays ? () => intro.fly() : undefined,
          );
        });
      }, 100);
    }, 50);
  }

  /** The selected year and aircraft's view of the data, if there is any */
  private filterView(): FilterView | null {
    const data = this.app.currentData;
    return data
      ? datasetIndex(data).filter(
          this.app.selectedYear,
          this.app.selectedAircraft,
        )
      : null;
  }

  /**
   * Fill the cards for the selected year and aircraft from the loaded data,
   * on opening and again when other data finishes loading while the dialog
   * is open.
   *
   * The cards need the statistics of the filter, which walk every flight it
   * keeps: a third of a second on a phone for all the years, and the page
   * did nothing else meanwhile. They are worked out in slices (see
   * filterStatisticsInSlices), at once for a filter they are kept for or a
   * small one. Until a longer one is in, the dialog is open and says it is
   * preparing the cards: it used to open only then, and a click showed
   * nothing for seconds on a slow device. A close or newer data stops the
   * work.
   */
  private fillCards(): void {
    this.stopStats();
    const view = this.filterView();
    const controller = new AbortController();
    const stats = view
      ? filterStatisticsInSlices(view, controller.signal)
      : calculateFilteredStatistics({ pathInfo: [], segments: [] });
    if (!(stats instanceof Promise)) {
      this.renderContent(stats);
      return;
    }
    this.statsAbort = controller;
    this.renderLoading();
    stats.then(
      (filteredStats) => {
        if (controller.signal.aborted || this.destroyed) return;
        this.statsAbort = null;
        this.renderContent(filteredStats);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        this.statsAbort = null;
        logError(error);
      },
    );
  }

  /** Stop the statistics the cards wait for, if they wait for any */
  private stopStats(): void {
    this.statsAbort?.abort();
    this.statsAbort = null;
  }

  /**
   * Title the dialog for the selected year, or for all of them, and the
   * intro that opens on the same words (see ui/wrappedIntro.ts)
   */
  private renderTitle(): void {
    // The card is titled by its words alone: a sparkle emoji ignored the
    // heading's gradient, and a drawn star beside the type read as a stray
    const year = this.app.selectedYear;
    const all = year === "all";
    const title = all ? "Your Flight History" : "Your Year in Flight";
    // In the words of the year select
    const period = all ? "All years" : year;
    for (const [id, text] of [
      ["wrapped-title", title],
      ["wrapped-intro-heading", title],
      ["wrapped-year", period],
      ["wrapped-intro-year", period],
    ] as const) {
      const el = domCache.get(id);
      if (el) el.textContent = text;
    }
  }

  /**
   * Say the cards are being prepared, in the words and the style of the
   * statistics panel's loading line, in place of the figures. The column is
   * busy until renderContent fills it: the cards of the last opening, or of
   * the data before, must not show for the new filter. The cards below the
   * figures are hidden until renderContent says which have anything: they
   * were emptied, and showed as blank tiles meanwhile.
   */
  private renderLoading(): void {
    this.renderTitle();
    const statsEl = domCache.get("wrapped-stats");
    if (statsEl) {
      const what = this.app.selectedYear === "all" ? "flight history" : "year";
      statsEl.innerHTML = trustedHtml(
        `<p class="stats-loading" role="status">Preparing your ${what}…</p>`,
      );
    }
    for (const card of ["facts", "fleet", "airports"]) {
      domCache.get("wrapped-card-" + card)?.toggleAttribute("hidden", true);
    }
    domCache.get("wrapped-cards-column")?.setAttribute("aria-busy", "true");
    this.cardsScroll?.update();
  }

  /** Fill the cards with the statistics of the selected filter */
  private renderContent(filteredStats: FilteredStatistics): void {
    domCache.get("wrapped-cards-column")?.removeAttribute("aria-busy");
    // Use the currently selected year (including 'all')
    const year = this.app.selectedYear;

    // The filter view of the dataset is shared with the statistics panel,
    // so a filter it already computed is not walked again here
    const view = this.filterView();
    const segments = view?.segments() ?? [];

    const yearStats = calculateYearStats(
      this.app.aircraftModels,
      filteredStats,
    );

    this.renderTitle();

    // Check if we have timing data (flight time and groundspeed)
    const hasTimingData =
      filteredStats.max_groundspeed_knots !== undefined &&
      filteredStats.max_groundspeed_knots > 0;

    // Build stats grid (conditionally include flight time and max groundspeed)
    const statsHtml = generateStatsHtml(
      yearStats,
      filteredStats,
      hasTimingData,
    );

    const statsEl = domCache.get("wrapped-stats");
    if (statsEl) statsEl.innerHTML = trustedHtml(statsHtml);

    // Build fun facts section with dynamic, varied facts
    const renderFacts = (newAreaKm2: number | null): void => {
      const funFactsEl = domCache.get("wrapped-fun-facts");
      if (!funFactsEl) return;
      funFactsEl.innerHTML = trustedHtml(
        generateFunFactsHtml(
          generateFunFacts(yearStats, filteredStats, year, newAreaKm2),
        ),
      );
    };
    // The airspace new in the year is counted from the earlier years the
    // page holds already (see yearNewAreaKm2), and left out unless it holds
    // them all. Counted the first time, it took 48 ms with a desktop's
    // speed, longer than the statistics the cards are sliced for, so then
    // it is counted once the dialog is open, and its fact added.
    const known = knownNewAreaKm2(segments);
    renderFacts(known ?? null);
    if (known === undefined) {
      const opened = this.opened;
      whenIdle(() => {
        // Still the cards it was counted for
        if (
          opened !== this.opened ||
          !this.app.wrappedVisible ||
          this.statsAbort ||
          this.filterView()?.segments() !== segments
        ) {
          return;
        }
        const area = yearNewAreaKm2(
          year,
          segments,
          siteData.metadata?.available_years ?? [],
          (before) => this.app.dataManager.cachedData(before),
        );
        if (area) renderFacts(area);
      });
    }

    // The sections below are conditional, so clear them first: a year
    // without aircraft or airports must not show the previous year's content
    const fleetEl = domCache.get("wrapped-aircraft-fleet");
    const topAirportsEl = domCache.get("wrapped-top-airports");
    const gridEl = domCache.get("wrapped-airports-grid");
    if (fleetEl) fleetEl.replaceChildren();
    if (topAirportsEl) topAirportsEl.replaceChildren();
    if (gridEl) gridEl.replaceChildren();
    this.destinations = [];

    // Build aircraft fleet section using year-filtered data
    if (yearStats.aircraft_list && yearStats.aircraft_list.length > 0) {
      const fleetHtml = generateAircraftFleetHtml(yearStats);
      if (fleetEl) fleetEl.innerHTML = trustedHtml(fleetHtml);
    }

    // Build home base section using year-filtered airport data
    if (yearStats.airport_names && yearStats.airport_names.length > 0) {
      const airportCounts = view?.airportCounts() ?? {};
      const homeBase = findHomeBase(airportCounts);
      const homeBaseCount = homeBase ? (airportCounts[homeBase] ?? 0) : 0;

      if (homeBase) {
        const homeBaseHtml = generateHomeBaseHtml(
          { name: homeBase, flight_count: homeBaseCount },
          airportCode(homeBase),
        );
        if (topAirportsEl) topAirportsEl.innerHTML = trustedHtml(homeBaseHtml);

        // Every airport is listed, the home base included, so the country
        // groups are complete; home base and furthest airport are accented
        const grouped = groupByCountry(yearStats.airport_names);
        const furthest = findFurthestAirport(
          homeBase,
          yearStats.airport_names,
          airportCoordinates(),
        );

        // The rows of the card, in order, for the hover over them
        this.destinations = [...grouped.values()].flat();
        const destinationsHtml = generateDestinationsHtml(grouped, {
          countryName: countryDisplayName,
          flagSrc: countryFlagSrc,
          airportCode,
          homeBase,
          furthest,
        });
        if (gridEl) {
          gridEl.innerHTML = trustedHtml(destinationsHtml);
          // The groups fade in one after another. Set here rather than in
          // the markup: the CSP allows no style attributes.
          gridEl
            .querySelectorAll<HTMLElement>(".country-group")
            .forEach((group, index) => {
              group.style.animationDelay = index / 10 + "s";
            });
        }
      }
    }

    // A card left empty is hidden: it would be a blank tile, named by a
    // heading that is not there. The facts always have theirs.
    domCache.get("wrapped-card-facts")?.toggleAttribute("hidden", false);
    const fleetCard = domCache.get("wrapped-card-fleet");
    if (fleetCard) fleetCard.hidden = !fleetEl?.innerHTML;
    const airportsCard = domCache.get("wrapped-card-airports");
    if (airportsCard) {
      airportsCard.hidden = !topAirportsEl?.innerHTML && !gridEl?.innerHTML;
    }

    // The cards were just rewritten, which is neither a scroll nor a
    // resize: without this the fade at the bottom of the column keeps
    // whatever verdict the previous set of cards left behind
    this.cardsScroll?.update();
  }

  /**
   * Keep keyboard and screen reader focus inside the dialog: remember the
   * opener, make everything outside the dialog inert and focus the close
   * button. The map's <main> goes inert with the rest of the page, which
   * leaves the map alone: it is moved out of it into the dialog.
   *
   * A snapshot of the children is not enough. Crossing the breakpoint while
   * the dialog is open mounts the mobile bar onto the body, and without the
   * observer its five tabs joined the dialog's tab cycle and stayed operable,
   * so a keyboard user could open a sheet behind the modal.
   *
   * The map comes along, and with it the airport markers, which are
   * tabbable: dozens of stops that open popups over the overview. They are
   * taken out of the tab cycle until the dialog closes, one by one. The
   * container they sit in is the element MapLibre listens on for every
   * drag, pinch and wheel, so making that one inert would freeze the
   * overview map, which is there to be panned and zoomed. A snapshot is
   * enough here: the airports are created once at start-up, before Wrapped
   * can open, and the only other marker is replay's airplane, which cannot
   * exist while Wrapped is open (neither starts while the other runs).
   * Popups are closed, the values a hover or a tap left on a flight
   * included, and whatever should be left of them is made inert as well.
   *
   * A container that still takes gestures also still reports clicks and
   * pointer moves. Those select flights and show their values on the main
   * map, which the overview is not: MapApp's click dispatcher and
   * LayerManager's hover stand down while `wrappedVisible` is set.
   */
  private trapFocus(modal: HTMLElement): void {
    const active = document.activeElement;
    // Opened from a link or a restored state, focus is on the body
    this.previouslyFocused =
      active instanceof HTMLElement && active !== document.body ? active : null;

    const makeInert = (el: Element): void => {
      if (
        el === modal ||
        NON_INERT_IDS.has(el.id) ||
        el.hasAttribute("inert")
      ) {
        return;
      }
      el.setAttribute("inert", "");
      this.inertElements.push(el);
    };

    this.inertElements = [];
    Array.from(document.body.children).forEach(makeInert);
    for (const marker of Object.values(this.app.airportMarkers)) {
      if (marker.isPopupOpen()) marker.closePopup();
    }
    this.app.layerManager.closeSegmentPopup();
    document
      .querySelectorAll("#map .maplibregl-marker, #map .maplibregl-popup")
      .forEach(makeInert);

    this.inertObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof Element) makeInert(node);
        }
      }
    });
    this.inertObserver.observe(document.body, { childList: true });

    // Skip while the intro plays: the cards are inert under the map for
    // its ten seconds, and Skip comes before Close, so from Close a forward
    // Tab never reached it. Once it hides it hands the focus to Close
    // (showIntroChrome in ui/wrappedIntro.ts).
    const skip = modal.querySelector<HTMLElement>("#wrapped-skip-btn");
    const first =
      skip && !skip.hidden ? skip : modal.querySelector(".close-btn");
    if (first instanceof HTMLElement) first.focus();
  }

  private releaseFocus(): void {
    this.inertObserver?.disconnect();
    this.inertObserver = null;
    this.inertElements.forEach((el) => el.removeAttribute("inert"));
    this.inertElements = [];

    const opener = this.previouslyFocused;
    this.previouslyFocused = null;
    if (opener && document.contains(opener)) {
      // A hidden opener (for example while the controls are collapsed) stays
      // in the document but cannot take focus
      opener.focus();
      if (document.activeElement === opener) return;
    }

    // No opener to return to: the control that opens the dialog is where
    // it would have been opened from, on either layout
    for (const id of ["wrapped-btn", "mobile-tab-wrapped"]) {
      const control = document.getElementById(id);
      control?.focus();
      if (control && document.activeElement === control) return;
    }
  }

  /** Cancel the deferred map move, resize and restore timers */
  private cancelPendingMapTimers(): void {
    if (this.mapMoveTimer !== null) {
      clearTimeout(this.mapMoveTimer);
      this.mapMoveTimer = null;
    }
    if (this.mapResizeTimer !== null) {
      clearTimeout(this.mapResizeTimer);
      this.mapResizeTimer = null;
    }
    if (this.mapRestoreTimer !== null) {
      clearTimeout(this.mapRestoreTimer);
      this.mapRestoreTimer = null;
    }
    // Takes the placeholder down and ends its wait for the map
    // (whenMapComplete) with it
    this.revealMap?.();
  }

  /** Drop every pending timer and listener; the dialog stays as it is */
  destroy(): void {
    this.destroyed = true;
    this.intro?.stop();
    this.listening.abort();
    this.cancelHover();
    this.stopStats();
    this.unsubscribeData();
    this.cancelPendingMapTimers();
    this.cardsScroll?.stop();
    this.cardsScroll = null;
    if (this.escapeHandler) {
      document.removeEventListener("keydown", this.escapeHandler);
      this.escapeHandler = null;
    }
    this.inertObserver?.disconnect();
    this.inertObserver = null;
  }

  closeWrapped(): void {
    // Before the timers: the reveal they cancel would start its flight
    this.intro?.stop();
    this.cancelHover();
    this.overview = null;
    // The globe and the 3D view go back with the view, before the map is
    // measured again, and the intro's cloud, should the dialog close while
    // it plays
    const view = this.savedView;
    this.app.store.batch(() => {
      if (view) {
        this.app.globeVisible = view.globeVisible;
        this.app.threeDVisible = view.threeDVisible;
      }
      this.app.forcedHeatCloud = false;
    });
    // Cards nobody will see are not worked out any further
    this.stopStats();
    this.cancelPendingMapTimers();
    this.cardsScroll?.stop();
    this.cardsScroll = null;
    // Move map back to original position
    const mapContainer = domCache.get("map");
    if (!mapContainer) return;

    if (this.originalMapParent) {
      // Before the element that followed it, or at the end should that one
      // have left the page since
      const next =
        this.originalMapNext?.parentElement === this.originalMapParent
          ? this.originalMapNext
          : null;
      this.originalMapParent.insertBefore(mapContainer, next);

      // Restore map styling
      mapContainer.style.width = "";
      mapContainer.style.height = "";
      mapContainer.style.borderRadius = "";
      mapContainer.style.overflow = "";

      // Restore controls to their pre-wrapped display states
      restoreControls(this.savedControlDisplays);
      this.savedControlDisplays.clear();

      // Force map to recalculate size once it is back in the page layout,
      // then put the user's view back. The move this fires is what saves
      // the view to the URL again.
      this.mapRestoreTimer = setTimeout(() => {
        this.mapRestoreTimer = null;
        const view = this.savedView;
        this.savedView = null;
        if (!this.app.map) return;
        this.app.map.resize();
        if (view) {
          this.app.map.jumpTo({
            center: toLngLat([view.center.lat, view.center.lng]),
            zoom: view.zoom,
            bearing: view.bearing,
            pitch: view.pitch,
          });
        }
      }, MAP_RESTORE_DELAY_MS);
    }

    // Focus leaves the dialog while it is still shown, as a hidden element
    // cannot be blurred, and goes back only once it is gone: the mobile bar
    // is hidden under the dialog (wrapped.css), and its Wrapped tab cannot
    // take focus until then
    const modal = domCache.get("wrapped-modal");
    const active = document.activeElement;
    if (active instanceof HTMLElement && modal?.contains(active)) active.blur();
    if (modal) modal.hidden = true;
    this.setWrappedVisible(false);
    this.releaseFocus();

    // Remove Escape key handler
    if (this.escapeHandler) {
      document.removeEventListener("keydown", this.escapeHandler);
      this.escapeHandler = null;
    }
  }
}
