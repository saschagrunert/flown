/**
 * The search of places: a field over the map that finds the site's own
 * airports as the visitor types, and any other place on earth through
 * Photon (services/photon.ts), and takes the map there.
 *
 * It opens from the Search button at the top of the left column, from the
 * Search row of the phone's More sheet and with `/` (see followSearchKey
 * in ui/lazyBundles.ts), and comes with a bundle of its own (search.ts):
 * the first visit carries the button and the key alone. On a wide screen
 * the panel stands beside the button; on a phone it spans the top of the
 * map.
 *
 * The field is a combobox (the ARIA pattern of the same name): the list of
 * what was found is its listbox, the arrow keys move through it while the
 * focus stays in the field (aria-activedescendant), Enter takes the option
 * the keys are on, or the first one, and Escape closes the panel. The
 * site's airports come first, matched on the page at every keystroke
 * (calculations/airportSearch.ts); the places of Photon after them, asked
 * for after a pause in the typing (PLACE_DEBOUNCE_MS) or at once on Enter
 * when nothing is listed yet, and only from PLACE_MIN_LENGTH characters
 * on. A request the next one replaces is aborted, and the client keeps
 * the answers to the last few dozen texts for the page's lifetime:
 * Photon's free service asks for that. Offline, or when Photon fails or
 * takes too long (PLACE_TIMEOUT_MS), the panel says so in a line of its
 * own and the airports are still found. The credit Photon and
 * OpenStreetMap ask for is the panel's last line.
 *
 * An airport that is picked is flown to, and its popup opens as a click on
 * its marker opens it, but without the selection of its flights such a
 * click makes: the search only moves the map. Focus goes to the marker, so
 * Escape closes the popup and leaves the keyboard there. Where the marker
 * is not shown (the Airports switch off, or the filter leaves it out) and
 * for a place, a pulse marks the spot instead, until the next pick or
 * Escape. The camera keeps its bearing and tilt, takes the panels over the
 * map into account (mapChromePadding) and jumps rather than flies under
 * reduced motion.
 *
 * A replay, the replay of all flights, the hotspot tour and Wrapped hold
 * the map, and a search would move it under them: their holds take the
 * button (ui/heldControls.ts), the app ignores the key meanwhile
 * (MapApp.toggleSearch), and a panel or a pulse that is open as one of them
 * starts goes away, with a popup that was still to open at the end of
 * the flight there.
 */
import { Marker, type Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { Airport } from "../types";
import {
  foldText,
  matchAirports,
  namesAirport,
} from "../calculations/airportSearch";
import {
  PhotonClient,
  PLACE_DEBOUNCE_MS,
  PLACE_MIN_LENGTH,
  placeKey,
  type Place,
} from "../services/photon";
import { siteData } from "../state/siteData";
import { MAP_MAX_ZOOM } from "../utils/constants";
import { escapeHtml } from "../utils/escape";
import { countryDisplayName } from "../utils/formatters";
import { icon } from "../utils/icons";
import { isPageEscape } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { announceStatus } from "../utils/toast";
import { mapChromePadding } from "./pathSelection";

/** The control that opens and closes the search in the left column */
export const SEARCH_BUTTON_ID = "search-btn";

/** The panel, its field and its list of what was found */
export const SEARCH_PANEL_ID = "location-search";
const INPUT_ID = "location-search-input";
const LIST_ID = "location-search-results";

/** How long Photon has to answer before the search says it failed (ms) */
export const PLACE_TIMEOUT_MS = 10_000;

/** The zoom an airport is shown at, close enough for its runways. Map units. */
export const AIRPORT_ZOOM = 12;

/** The closest a place with an extent is fitted at. Map units. */
const PLACE_MAX_ZOOM = 16;

/**
 * Half the side of the box a point is fitted into, in degrees: a box that
 * small fits at any zoom, so the fit ends at the zoom it is capped at, and
 * the point is centred between the panels over the map
 */
const POINT_BOX_DEG = 1e-4;

/**
 * The key of the eventData that tags the camera's moves to a pick: a fit
 * that interrupts another move gets that move's moveend first
 */
const MOVE_TAG = "locationSearchMove";

/** The padding of a fit that takes the whole map */
const NO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

/** Pixels between the Search button and the panel beside it */
const PANEL_GAP_PX = 8;

/** The class of the pulse that marks a place on the map (search.css) */
export const SEARCH_PIN_CLASS = "location-search-pin";

/** Said in the panel while Photon is asked */
export const SEARCHING_MESSAGE = "Searching places…";
/** Said when neither the airports nor Photon have anything */
export const NOTHING_FOUND_MESSAGE = "No airport or place found";
/** Said for a text too short to send, while no airport matches it */
export const SHORT_QUERY_MESSAGE = `Type ${PLACE_MIN_LENGTH} letters or more to search places too`;
/** Said instead of asking Photon while the browser is offline */
export const OFFLINE_MESSAGE =
  "Offline: only the airports of this map are searched";
/** Said when Photon could not be asked or did not answer */
export const PLACES_FAILED_MESSAGE =
  "Places could not be searched just now; the airports of this map still are";

/** One option of the list: an airport of the site or a place of Photon */
type Option =
  { kind: "airport"; airport: Airport } | { kind: "place"; place: Place };

/** "EDDS · Germany": the code, unless the name says it, and the country */
export function airportDetail(airport: Airport): string {
  const code = airport.code ?? "";
  return [
    code && !foldText(airport.name).includes(code.toLowerCase()) ? code : "",
    airport.country ? countryDisplayName(airport.country) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "2 airports, 5 places", or that nothing was found */
function resultsText(airports: number, places: number): string {
  const count = (n: number, noun: string): string =>
    n === 0 ? "" : `${n} ${noun}${n === 1 ? "" : "s"}`;
  return (
    [count(airports, "airport"), count(places, "place")]
      .filter(Boolean)
      .join(", ") || NOTHING_FOUND_MESSAGE
  );
}

/** A box around a point small enough to fit at any zoom */
function pointBox(
  lng: number,
  lat: number,
): [[number, number], [number, number]] {
  return [
    [lng - POINT_BOX_DEG, lat - POINT_BOX_DEG],
    [lng + POINT_BOX_DEG, lat + POINT_BOX_DEG],
  ];
}

/** The markup of the panel; the list is filled as the visitor types */
const PANEL_HTML =
  '<div class="location-search-field">' +
  icon("search", 16) +
  `<input id="${INPUT_ID}" type="text" role="combobox" ` +
  `aria-autocomplete="list" aria-expanded="false" aria-controls="${LIST_ID}" ` +
  'aria-label="Search airports and places" ' +
  'placeholder="Airport, ICAO code or place" autocomplete="off" ' +
  'autocapitalize="off" spellcheck="false" enterkeyhint="search">' +
  '<button type="button" class="location-search-close" ' +
  'title="Close search" aria-label="Close search">' +
  icon("close", 16) +
  "</button></div>" +
  `<div id="${LIST_ID}" class="location-search-results" role="listbox" ` +
  'aria-label="Airports and places" hidden></div>' +
  '<p class="location-search-status" hidden></p>' +
  '<p class="location-search-credit">Search by ' +
  '<a href="https://photon.komoot.io" target="_blank" rel="noopener noreferrer">Photon</a>' +
  ", data " +
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a>' +
  "</p>";

class LocationSearch {
  readonly panel: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly status: HTMLElement;
  /** What is listed, airports first, in the order of the list */
  private options: Option[] = [];
  /** The option the arrow keys are on, -1 for none */
  private active = -1;
  private airports: Airport[] = [];
  private places: Place[] = [];
  /** The text the places listed were found for (placeKey), "" for none */
  private placesFor = "";
  /** Why no places are listed: offline or a failed request, "" otherwise */
  private failure = "";
  /** The pause in the typing Photon waits for */
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The request to Photon on its way, aborted by the next */
  private request: AbortController | null = null;
  /** The pulse at the place last picked */
  private pin: Marker | null = null;
  /** What runs once the camera has arrived at what was picked */
  private arrival: ((event: object) => void) | null = null;
  /** Where focus was when the panel opened, to go back to on close */
  private opener: HTMLElement | null = null;
  /** The last count that was announced, so the same is not said twice */
  private announced = "";
  private readonly lifetime = new AbortController();
  /** What listens only while the panel is open */
  private whileOpen: AbortController | null = null;

  constructor(
    readonly app: MapApp,
    private readonly client = new PhotonClient(),
  ) {
    const panel = document.createElement("div");
    panel.id = SEARCH_PANEL_ID;
    panel.className = "location-search";
    panel.setAttribute("role", "search");
    panel.hidden = true;
    panel.innerHTML = PANEL_HTML;
    this.panel = panel;
    this.input = panel.querySelector("input")!;
    this.list = panel.querySelector('[role="listbox"]')!;
    this.status = panel.querySelector(".location-search-status")!;
    // Ahead of the map, as the controls are, so the panel comes before the
    // airport markers in the tab order (see insertBeforeMap in mobileBar.ts)
    const home = document.getElementById("map")?.closest("main");
    if (home) home.before(panel);
    else document.body.append(panel);
    document
      .getElementById(SEARCH_BUTTON_ID)
      ?.setAttribute("aria-controls", SEARCH_PANEL_ID);

    const signal = this.lifetime.signal;
    const listen = { signal };
    // Also while an input method composes: the keyboards of Android
    // compose every word as it is typed, and nothing would be found before
    // a space. The pause Photon waits for spans the steps of a word in
    // the making as it spans keystrokes.
    this.input.addEventListener("input", () => this.onInput(), listen);
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e), listen);
    // From the close button and the credit's links as well as the field
    panel.addEventListener("keydown", (e) => this.onEscape(e), listen);
    // The focus stays in the field while an option is pressed
    this.list.addEventListener(
      "pointerdown",
      (e) => e.preventDefault(),
      listen,
    );
    this.list.addEventListener(
      "click",
      (event) => {
        const option =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>('[role="option"]')
            : null;
        if (option) this.pick(Number(option.dataset["index"]));
      },
      listen,
    );
    panel
      .querySelector(".location-search-close")!
      .addEventListener("click", () => this.dismiss(), listen);
    // A press anywhere else puts the panel away and leaves the focus where
    // it went; the button toggles it itself
    document.addEventListener(
      "pointerdown",
      (event) => {
        const target = event.target;
        if (
          !this.panel.hidden &&
          target instanceof Node &&
          !this.panel.contains(target) &&
          !(target instanceof Element && target.closest(`#${SEARCH_BUTTON_ID}`))
        ) {
          this.close(false);
        }
      },
      { capture: true, signal },
    );
    // Escape takes the pulse away once the panel is closed, last of all
    // (see the order in doc/features.md): only an Escape that nothing else
    // took, which is known once every listener has had it, whichever was
    // added last (the cross-section adds its own as it opens). A replay,
    // the tour or Wrapped cannot be open (see the module comment).
    window.addEventListener(
      "keydown",
      (event) => {
        if (!this.pin || !this.panel.hidden || !isPageEscape(event)) return;
        setTimeout(() => {
          if (!event.defaultPrevented) this.removePin();
        });
      },
      listen,
    );
    // Put away as the focus leaves it for the page (Tab past its last
    // link), as a combobox's list is; not for the Search button, which
    // toggles it itself, nor as the window loses the focus (no next element)
    panel.addEventListener(
      "focusout",
      (event) => {
        const next = event.relatedTarget;
        if (
          next instanceof Element &&
          !panel.contains(next) &&
          !next.closest(`#${SEARCH_BUTTON_ID}`)
        ) {
          this.close(false);
        }
      },
      listen,
    );
    window.addEventListener("resize", () => this.place(), listen);
    // The left column moves beside the statistics rail as it opens; not the
    // transitions of its buttons, which bubble up to it
    document.getElementById("left-buttons")?.addEventListener(
      "transitionend",
      (event) => {
        if (event.target === event.currentTarget) this.place();
      },
      listen,
    );
    // As the rail opens or closes the column moves without a transition
    // under reduced motion; measured once the page has followed the change
    app.store.subscribe(
      "statsPanelVisible",
      () => requestAnimationFrame(() => this.place()),
      listen,
    );
    app.store.subscribeKeys(
      ["replayActive", "wrappedVisible", "tourView"],
      () => {
        if (!app.mapHeld) return;
        this.close(false);
        this.cancelArrival();
        this.removePin();
      },
      listen,
    );
    app.signal.addEventListener("abort", () => this.destroy(), listen);
  }

  isOpen(): boolean {
    return !this.panel.hidden;
  }

  /** Open or close it; with `open`, an open one only takes the focus */
  toggle(open = false): void {
    if (!this.isOpen()) this.open();
    else if (open) this.input.focus();
    else this.close();
  }

  open(): void {
    // A popup still to open at the end of the last pick's flight would
    // take the focus from the field
    this.cancelArrival();
    const focused = document.activeElement;
    this.opener =
      focused instanceof HTMLElement && focused !== document.body
        ? focused
        : null;
    this.panel.hidden = false;
    this.announced = "";
    this.setButtonExpanded(true);
    this.place();
    // The column scrolls under a button it may have taken out of view
    this.whileOpen = new AbortController();
    document
      .getElementById("left-buttons")
      ?.addEventListener("scroll", () => this.place(), {
        passive: true,
        signal: this.whileOpen.signal,
      });
    this.input.focus();
    this.input.select();
    // What is typed already, against airports that may have loaded since
    this.onInput();
  }

  /**
   * Put the panel away, and with `restoreFocus` the focus back where it
   * was when it opened (the Search button, the phone's More tab)
   */
  close(restoreFocus = true): void {
    if (this.panel.hidden) return;
    // Asked before the panel hides, which may take the focus with it
    const focused = this.panel.contains(document.activeElement);
    this.cancelPlaces();
    this.whileOpen?.abort();
    this.panel.hidden = true;
    this.setButtonExpanded(false);
    if (restoreFocus && focused) {
      // The first of them that is shown: `/` on a phone leaves no opener,
      // and its column, with the Search button, is not shown there
      [
        this.opener,
        document.getElementById(SEARCH_BUTTON_ID),
        this.app.map?.getCanvas(),
      ]
        .find((element) => element?.isConnected && shown(element))
        ?.focus();
    }
  }

  /** Escape and the close button: the panel goes, and the pulse with it */
  private dismiss(): void {
    this.removePin();
    this.close();
  }

  destroy(): void {
    this.lifetime.abort();
    this.whileOpen?.abort();
    this.cancelPlaces();
    this.cancelArrival();
    this.removePin();
    this.panel.remove();
    this.setButtonExpanded(false);
    if (current === this) current = null;
  }

  /**
   * Beside the Search button where it is shown, at the top otherwise.
   * Measured only while the panel is open: the page is laid out to ask.
   */
  private place(): void {
    if (!this.isOpen()) return;
    const button = document.getElementById(SEARCH_BUTTON_ID);
    const box = button?.getBoundingClientRect();
    const anchored = !!box && box.width > 0 && !button!.closest("[hidden]");
    this.panel.classList.toggle("is-anchored", anchored);
    if (anchored) {
      this.panel.style.setProperty(
        "--search-left",
        `${Math.round(box.right + PANEL_GAP_PX)}px`,
      );
      this.panel.style.setProperty("--search-top", `${Math.round(box.top)}px`);
    }
  }

  private setButtonExpanded(expanded: boolean): void {
    const button = document.getElementById(SEARCH_BUTTON_ID);
    button?.setAttribute("aria-expanded", String(expanded));
    button?.classList.toggle("active", expanded);
  }

  /** The text changed: the airports at once, the places after a pause */
  private onInput(): void {
    const query = this.input.value;
    const airports = siteData.airports ?? [];
    this.airports = matchAirports(airports, query);
    this.cancelPlaces();
    this.failure = "";
    const key = placeKey(query);
    const kept = this.client.cached(query);
    this.places = kept ?? [];
    this.placesFor = kept ? key : "";
    // Not for the code or name of an airport of the site, which says
    // nothing a third party needs to hear: the airport is listed already
    if (
      !kept &&
      key.length >= PLACE_MIN_LENGTH &&
      !namesAirport(airports, query)
    ) {
      this.timer = setTimeout(() => this.searchPlaces(), PLACE_DEBOUNCE_MS);
    }
    // A new text starts again with no option active
    this.active = -1;
    this.render();
  }

  /** Stop waiting for the pause, and for an answer still on its way */
  private cancelPlaces(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.request?.abort();
    this.request = null;
  }

  /** Ask Photon for the places of the text, unless it has answered it */
  private searchPlaces(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const query = this.input.value;
    const key = placeKey(query);
    if (key.length < PLACE_MIN_LENGTH || key === this.placesFor) return;
    if (!navigator.onLine) {
      this.failure = OFFLINE_MESSAGE;
      this.render();
      return;
    }
    this.request?.abort();
    const request = new AbortController();
    this.request = request;
    // The line of an earlier request that failed goes as this one starts
    this.failure = "";
    // A Photon that does not answer has failed, rather than searching on
    const timeout = setTimeout(() => request.abort(), PLACE_TIMEOUT_MS);
    this.render();
    this.client
      .search(query, request.signal)
      .finally(() => clearTimeout(timeout))
      .then(
        (places) => {
          if (this.request !== request) return;
          this.request = null;
          this.places = places;
          this.placesFor = key;
          this.render();
        },
        () => {
          // Aborted by the next request or the close, which have moved on
          if (this.request !== request) return;
          this.request = null;
          this.failure = navigator.onLine
            ? PLACES_FAILED_MESSAGE
            : OFFLINE_MESSAGE;
          this.render();
        },
      );
  }

  /** What the line under the list says, "" for nothing */
  private statusText(): string {
    const key = placeKey(this.input.value);
    if (!key) return "";
    if (this.request) return SEARCHING_MESSAGE;
    if (this.failure) return this.failure;
    if (this.options.length > 0) return "";
    if (key.length < PLACE_MIN_LENGTH) return SHORT_QUERY_MESSAGE;
    return key === this.placesFor ? NOTHING_FOUND_MESSAGE : "";
  }

  /**
   * Write the list and the line under it. The option the arrow keys were
   * on stays active while it is still listed: places that arrive under the
   * airports, or a failed request, do not take it away from under Enter.
   */
  private render(): void {
    const was = this.options[this.active];
    this.options = [
      ...this.airports.map((airport): Option => ({ kind: "airport", airport })),
      ...this.places.map((place): Option => ({ kind: "place", place })),
    ];
    let index = 0;
    const option = (name: string, detail: string): string =>
      `<div role="option" id="${LIST_ID}-${index}" data-index="${index++}" ` +
      'class="location-search-option" aria-selected="false">' +
      `<span class="location-search-name">${escapeHtml(name)}</span>` +
      (detail
        ? `<span class="location-search-detail">${escapeHtml(detail)}</span>`
        : "") +
      "</div>";
    const group = (label: string, options: string[]): string =>
      options.length === 0
        ? ""
        : `<div role="group" aria-label="${label}" class="location-search-group">` +
          `<div class="location-search-heading" aria-hidden="true">${label}</div>` +
          options.join("") +
          "</div>";
    this.list.innerHTML =
      group(
        "Airports",
        this.airports.map((airport) =>
          option(airport.name, airportDetail(airport)),
        ),
      ) +
      group(
        "Places",
        this.places.map((place) => option(place.name, place.detail)),
      );
    const listed = this.options.length > 0;
    this.list.hidden = !listed;
    this.input.setAttribute("aria-expanded", String(listed));
    this.highlight(
      was
        ? this.options.findIndex((option) =>
            option.kind === "airport"
              ? was.kind === "airport" && was.airport === option.airport
              : was.kind === "place" && was.place === option.place,
          )
        : -1,
    );

    const status = this.statusText();
    this.status.textContent = status;
    this.status.hidden = !status;
    this.announce(status);
  }

  /**
   * Say what the list holds, and why it holds no places where Photon could
   * not be asked, or what the line under it says once nothing is listed.
   * Nothing while nothing is typed or Photon is still to answer, and not
   * the same twice in a row.
   */
  private announce(status: string): void {
    const listed = this.options.length > 0;
    if (!placeKey(this.input.value) || status === SEARCHING_MESSAGE) return;
    const text = listed
      ? [resultsText(this.airports.length, this.places.length), this.failure]
          .filter(Boolean)
          .join(". ")
      : status;
    if (!text || text === this.announced) return;
    this.announced = text;
    announceStatus(text);
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (isComposing(event)) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        this.move(-1);
        break;
      case "Enter":
        event.preventDefault();
        this.enter();
        break;
    }
  }

  /**
   * Escape anywhere in the panel. Not one the readout of the heat cloud
   * took first, as it does on the document before anything else; ahead of
   * every other listener otherwise (see isPageEscape).
   */
  private onEscape(event: KeyboardEvent): void {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (isComposing(event)) return;
    event.preventDefault();
    this.dismiss();
  }

  /** Move the active option by one, round from either end */
  private move(step: 1 | -1): void {
    const count = this.options.length;
    if (count === 0) return;
    this.highlight(
      this.active < 0
        ? step > 0
          ? 0
          : count - 1
        : (this.active + step + count) % count,
    );
  }

  /** Make an option the active one, -1 for none */
  private highlight(index: number): void {
    this.active = index;
    this.input.removeAttribute("aria-activedescendant");
    for (const element of this.list.querySelectorAll<HTMLElement>(
      '[role="option"]',
    )) {
      const active = Number(element.dataset["index"]) === index;
      element.setAttribute("aria-selected", String(active));
      if (active) {
        this.input.setAttribute("aria-activedescendant", element.id);
        // Not in every test environment
        if (typeof element.scrollIntoView === "function") {
          element.scrollIntoView({ block: "nearest" });
        }
      }
    }
  }

  /**
   * Enter: the active option, else the first one, and with nothing listed
   * a search of places at once rather than after the pause
   */
  private enter(): void {
    if (this.options.length > 0) {
      this.pick(Math.max(this.active, 0));
    } else if (!this.request) {
      this.searchPlaces();
    }
  }

  /** Take the map to an option, and put the panel away */
  private pick(index: number): void {
    const option = this.options[index];
    const map = this.app.map;
    if (!option || !map || this.app.mapHeld) return;
    this.removePin();
    this.close(false);
    if (option.kind === "airport") this.showAirport(map, option.airport);
    else this.showPlace(map, option.place);
  }

  /**
   * Fly to an airport and open its popup, as a click on its marker does but
   * without selecting its flights; a pulse where no marker is shown
   */
  private showAirport(map: MapLibreMap, airport: Airport): void {
    announceStatus(`Showing ${airport.name}`);
    // The map has the focus on the way, which the panel took with it
    map.getCanvas().focus({ preventScroll: true });
    this.moveTo(map, pointBox(airport.lon, airport.lat), AIRPORT_ZOOM, () => {
      const marker = this.app.airportMarkers[airport.name];
      const element = marker?.getElement();
      if (this.app.airportsVisible && element && !element.hidden) {
        marker!.getControl().focus({ preventScroll: true });
        this.app.airportManager.openPopup(airport.name);
      } else {
        this.showPin(map, airport.lon, airport.lat);
      }
    });
  }

  /** Fly to a place, to its extent where Photon gives one, and mark it */
  private showPlace(map: MapLibreMap, place: Place): void {
    announceStatus(`Showing ${place.name}`);
    this.showPin(map, place.lng, place.lat);
    map.getCanvas().focus({ preventScroll: true });
    this.moveTo(
      map,
      place.bounds ?? pointBox(place.lng, place.lat),
      place.bounds ? PLACE_MAX_ZOOM : place.zoom,
      null,
    );
  }

  /**
   * Fit the camera to a box, clear of the panels over the map, no closer
   * than `maxZoom`, keeping its bearing and tilt; `then` once it is there,
   * unless a replay, the tour or Wrapped has taken the map meanwhile
   */
  private moveTo(
    map: MapLibreMap,
    box: [[number, number], [number, number]],
    maxZoom: number,
    then: (() => void) | null,
  ): void {
    this.cancelArrival();
    // This move's own: the end of the one it interrupts (an earlier pick
    // still flying, a drag's inertia, the ease of a wheel) comes first
    const tag = {};
    const ours = (event: object): boolean =>
      (event as Record<string, unknown>)[MOVE_TAG] === tag;
    let started = false;
    const onStart = (event: object): void => {
      if (ours(event)) started = true;
    };
    if (then) {
      const arrival = (event: object): void => {
        if (!ours(event)) return;
        this.cancelArrival();
        if (!this.app.mapHeld) then();
      };
      this.arrival = arrival;
      // A move the visitor makes on the way ends it too, where it stopped.
      // Not `once`, whose listener `off` cannot always find again.
      map.on("moveend", arrival);
    }
    const fit = {
      padding: mapChromePadding(map),
      maxZoom: Math.min(maxZoom, MAP_MAX_ZOOM),
      bearing: map.getBearing(),
    };
    // A map so small that the panels over it leave no room (a phone held
    // sideways with the keyboard up): the whole map, panels or not, rather
    // than a fit that does not move and a popup off screen
    if (!map.cameraForBounds(box, fit)) fit.padding = NO_PADDING;
    // MapLibre starts a move, and says so, within the call
    map.on("movestart", onStart);
    map.fitBounds(
      box,
      { ...fit, animate: !prefersReducedMotion() },
      { [MOVE_TAG]: tag },
    );
    map.off("movestart", onStart);
    // A fit that does not move the map, as one with no room for the box
    // between the panels, ends no move either: there it is
    const arrival = this.arrival;
    if (!started && arrival) arrival({ [MOVE_TAG]: tag });
  }

  /** Forget what was to happen once the last move arrived */
  private cancelArrival(): void {
    if (this.arrival) this.app.map?.off("moveend", this.arrival);
    this.arrival = null;
  }

  /** Mark a place with a pulse, which the pointer goes through */
  private showPin(map: MapLibreMap, lng: number, lat: number): void {
    const element = document.createElement("div");
    element.className = SEARCH_PIN_CLASS;
    element.setAttribute("aria-hidden", "true");
    this.pin = new Marker({ element }).setLngLat([lng, lat]).addTo(map);
  }

  private removePin(): void {
    this.pin?.remove();
    this.pin = null;
  }
}

/**
 * Whether a key is an input method's, which picks or drops the word it
 * composes; Safari tells them apart by their key code alone
 */
function isComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}

/**
 * Whether an element is rendered, and so can take focus. Taken for shown
 * where the browser cannot tell (checkVisibility is recent).
 */
function shown(element: HTMLElement): boolean {
  return (
    typeof element.checkVisibility !== "function" || element.checkVisibility()
  );
}

/** The search of the app that opened it last */
let current: LocationSearch | null = null;

/**
 * Open the search, or close it if it is open; with `open` (the `/` key),
 * an open search takes the focus back to its field instead. The panel is
 * made on the first call and kept for the app's lifetime. Nothing opens
 * while a replay, the tour or Wrapped holds the map.
 */
export function toggleSearch(app: MapApp, open = false): void {
  if (current?.app !== app) {
    current?.destroy();
    current = new LocationSearch(app);
  }
  if (!current.isOpen() && app.mapHeld) return;
  current.toggle(open);
}
