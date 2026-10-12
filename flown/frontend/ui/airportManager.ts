/**
 * Airport Manager - Handles airport markers and popups
 */
import { Popup, type PositionAnchor, type Subscription } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import {
  calculateVisibleAirports,
  findHomeBase,
  setAirportExpanded,
} from "../features/airports";
import type { AirportCounts } from "../features/airports";
import { datasetIndex, shownSelection } from "../calculations/datasetIndex";
import type { Airport, KMLDataset } from "../types";
import {
  AIRPORT_HIDE_MARKERS_BELOW_ZOOM,
  AIRPORT_SIZE_ZOOMS,
} from "../utils/constants";
import { ddToDms } from "../utils/geometry";
import {
  AIRPORT_POPUP_ID,
  generateAirportPopupHtml,
} from "../utils/htmlGenerators";
import {
  cameraDistanceRatio,
  closeWhenBehindGlobe,
  isReplayCameraMove,
  panPopupIntoView,
  onMapReady,
  whenContextRestored,
} from "../utils/mapHelpers";
import { siteData } from "../state/siteData";
import { AirportCodes, type CodeMarker } from "./airportLabels";
import type { CodePlace } from "../calculations/codePlacement";
import { prefersReducedMotion } from "../utils/motion";
import { listFlights } from "./airportFlights";

/** Whether two sets of airports (null for all) hold the same ones */
function sameAirports(
  a: ReadonlySet<string> | null,
  b: ReadonlySet<string> | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.size === b.size && [...a].every((name) => b.has(name));
}

/** The airports of the site, none until airports.json has loaded */
function siteAirports(): Airport[] {
  return siteData.airports ?? [];
}

/** Room kept between an airport popup and the edge of the map, in pixels */
const POPUP_PAN_PADDING_PX = 50;

/**
 * Distance from the middle of a marker, where MapLibre anchors it, to the
 * edge of its pointer target, where the popup's tip belongs. Half of
 * `--marker-target` in the stylesheet.
 */
const POPUP_OFFSET_PX = 12;

/** Room kept between the tip of a popup and a code it clears, in pixels */
const POPUP_CODE_GAP_PX = 4;

/**
 * Where the popup's tip goes for each side MapLibre hangs it on: at the
 * edge of the marker's target, or past the airport's code where that lies
 * on the popup's side, so the code stays in view
 */
export function popupOffsets(
  place: CodePlace | null,
): Record<PositionAnchor, [number, number]> {
  let below = POPUP_OFFSET_PX;
  let above = POPUP_OFFSET_PX;
  let right = POPUP_OFFSET_PX;
  let left = POPUP_OFFSET_PX;
  if (place) {
    const radians = (place.angle * Math.PI) / 180;
    const x = place.at * Math.cos(radians);
    const y = place.at * Math.sin(radians);
    const past = (edge: number): number => edge + POPUP_CODE_GAP_PX;
    if (y + place.hh > 0) below = Math.max(below, past(y + place.hh));
    if (y - place.hh < 0) above = Math.max(above, past(place.hh - y));
    if (x + place.hw > 0) right = Math.max(right, past(x + place.hw));
    if (x - place.hw < 0) left = Math.max(left, past(place.hw - x));
  }
  return {
    center: [0, 0],
    top: [0, below],
    "top-left": [0, below],
    "top-right": [0, below],
    bottom: [0, -above],
    "bottom-left": [0, -above],
    "bottom-right": [0, -above],
    left: [right, 0],
    right: [-left, 0],
  };
}

/** Store keys that change the popup counts and the home base */
const POPUP_KEYS = ["currentData", "selectedYear", "selectedAircraft"] as const;

/**
 * How many times farther from the camera than the middle of the map an
 * airport may be and still be shown. Towards the horizon of a steeply tilted
 * map the airports of a whole country crowd into a strip of dots and labels
 * over one another; up to about 55 degrees of tilt the whole map is nearer
 * than this (see cameraDistanceRatio).
 */
const AIRPORT_MAX_DISTANCE_RATIO = 2;

/**
 * Tilt in degrees up to which no airport in view is that far (see above),
 * with a margin under the 55 where the first one can be
 */
const AIRPORT_ALL_NEAR_PITCH = 50;

/** Store keys that change which markers are shown */
const VISIBILITY_KEYS = [
  ...POPUP_KEYS,
  "selectedPathIds",
  "isolateSelection",
] as const;

export class AirportManager {
  private app: MapApp;
  /**
   * The one popup every airport shares: only one is ever open, and its
   * content depends on the filter of the moment, so it is written when the
   * popup opens rather than kept per marker. It is opened from here and not
   * through `marker.setPopup`, whose own click and key handling would toggle
   * it a second time. MapLibre would focus the first control inside and
   * narrow it to 240px; the app decides about focus and the stylesheet about
   * the width. It would also close it on every click on the map, the click
   * on the marker that opens it included; MapApp's click dispatcher, which
   * can tell the two apart, closes it instead.
   */
  private readonly popup = new Popup({
    focusAfterOpen: false,
    maxWidth: "none",
    offset: popupOffsets(null),
    closeOnClick: false,
  });
  /** The airport the popup is open for */
  private openAirport: string | null = null;
  /** The airports shown under the filter and selection, null for all */
  private visibleAirports: ReadonlySet<string> | null = null;
  /** The counts the labels were last written with */
  private labelledCounts: AirportCounts | null = null;
  /** The airports too far towards the horizon to be shown */
  private farAirports: ReadonlySet<string> = new Set();
  /** Where the codes go, once there is a map */
  private readonly codes: AirportCodes | null = null;
  /** The codes in the order they are placed, and what that was worked out of */
  private ranking: {
    counts: AirportCounts;
    markers: number;
    ranked: CodeMarker[];
  } | null = null;
  /** Ends what follows the map: the codes' handlers */
  private readonly following = new AbortController();
  /** The map's handlers below, once it is ready */
  private subscriptions: Subscription[] = [];
  private destroyed = false;

  /**
   * Once the map comes to rest. Asked on every frame of a gesture it cost
   * a measurement of every airport, and a new label source mid-gesture;
   * the replay's camera ends a move on every frame, and rests of its own.
   */
  private readonly handleMoveEnd = (event: object): void => {
    if (!isReplayCameraMove(event)) this.updateFarAirports();
  };

  constructor(app: MapApp) {
    this.app = app;

    // The markers follow the data, the filters and the selection; nothing
    // has to remember to refresh them. A year switch changes four of these
    // keys at once, and both refreshes touch every marker, so each runs once
    // per update rather than once per key; only the second writes the
    // labels.
    app.store.subscribeKeys(POPUP_KEYS, () => this.updateAirportPopups());
    app.store.subscribeKeys(VISIBILITY_KEYS, () => this.showAirports(false));

    // A popup would be left pointing at nothing; the codes were left out
    app.store.subscribe("airportsVisible", (visible) => {
      if (!visible) this.closePopup();
      // Back on, the codes take their places, once the markers show again
      else this.codes?.schedule(true);
    });

    this.popup.on("close", () => this.onPopupClosed());
    if (app.map) {
      closeWhenBehindGlobe(app.map, this.popup);
      this.codes = new AirportCodes(
        {
          map: app.map,
          ranked: () => this.rankedCodes(),
          overview: () => app.wrappedVisible,
          moved: (name) => {
            if (name === this.openAirport) this.placePopupTip();
          },
        },
        this.following.signal,
      );
      app.signal.addEventListener("abort", () => this.following.abort());
    }

    // The labels are there once the map's layers are
    onMapReady(app, "Airport labels", (map) => {
      if (this.destroyed) return;
      this.subscriptions = [map.on("moveend", this.handleMoveEnd)];
      // The room of the codes is there to be written now; what was written
      // while the WebGL context was lost had no source to go to
      this.updateLabels();
      whenContextRestored(
        map,
        () => {
          if (this.destroyed) return;
          this.codes?.forgetRoom();
          this.updateLabels();
        },
        app.signal,
      );
    });
  }

  /** Stop following the map; the markers and labels stay as they are */
  destroy(): void {
    this.destroyed = true;
    this.following.abort();
    for (const subscription of this.subscriptions) subscription.unsubscribe();
    this.subscriptions = [];
  }

  /**
   * Flights per airport under the current filter, kept with the dataset for
   * as long as the filter stays
   */
  private airportFlightCounts(): AirportCounts {
    const data = this.app.currentData;
    if (!data) return {};
    return datasetIndex(data)
      .filter(this.app.selectedYear, this.app.selectedAircraft)
      .airportCounts();
  }

  /**
   * Update the home-base marker and the open popup with the counts of the
   * current year/aircraft filter; the labels, which mark the home base as
   * well, follow the visibility (see showAirports)
   */
  updateAirportPopups(): void {
    // Home base: airport with most flights in the current filter
    const homeBaseName = findHomeBase(this.airportFlightCounts());

    for (const airport of siteAirports()) {
      this.app.airportMarkers[airport.name]?.setHome(
        airport.name === homeBaseName,
      );
    }

    if (this.openAirport !== null) this.writePopupContent(this.openAirport);
  }

  /**
   * What a click on an airport's marker or on its label does: open its
   * popup, or close the popup it has open already. With nothing selected
   * it selects the airport's flights as well. Over a selection it only
   * opens: the home base's hundreds of flights were added to the two or
   * three somebody had picked, and share mode, which holds its flights
   * still, would have shown them all. The popup's list adds one by one
   * instead (ui/airportFlights.ts). Nothing is selected during a replay,
   * which shows the one flight, or the hotspot tour, which tours them.
   * Nor by a finger: a tap never changes the selection, and one that meant
   * to look at an airport put all its flights on the map; the popup's
   * checkboxes select.
   * @param byTouch - Whether a finger activated it (MapApp.touchClock)
   */
  activateAirport(name: string, byTouch = false): void {
    if (this.isPopupOpen(name)) {
      this.closePopup(name);
      return;
    }
    const app = this.app;
    // Share mode always has a selection, so it never selects here
    if (
      !byTouch &&
      !app.pathSelection.held() &&
      app.selectedPathIds.size === 0
    ) {
      app.pathSelection.selectPathsByAirport(name);
    }
    this.openPopup(name);
  }

  /**
   * Open the popup on an airport's marker.
   *
   * A popup opened from the keyboard takes focus, and closing it puts focus
   * back on the marker instead of dropping it on the page (see
   * onPopupClosed). A pointer leaves focus where it is.
   */
  openPopup(name: string): void {
    const map = this.app.map;
    const marker = this.app.airportMarkers[name];
    if (!map || !marker) return;

    // Moving the open popup is no close: the focus belongs to whatever
    // asked for the new one, not to the marker that is left behind
    const previous = this.openAirport;
    if (previous !== null) this.setExpanded(previous, false);
    this.openAirport = name;
    if (previous !== null && previous !== name) this.releaseKept(previous);
    this.setExpanded(name, true);
    this.placePopupTip();
    this.popup.setLngLat(marker.getLatLng());
    // The list goes into the popup's element, which an open popup has
    const wasOpen = this.popup.isOpen();
    this.writePopupContent(name);
    if (!wasOpen) {
      this.popup.addTo(map);
      this.listPopupFlights(name);
    }

    if (marker.getControl().matches(":focus-visible")) {
      this.popup
        .getElement()
        ?.querySelector<HTMLElement>(".popup-container")
        ?.focus();
    }
  }

  /**
   * Close the popup.
   * @param name - Close it only when it is open for this airport
   */
  closePopup(name?: string): void {
    if (name !== undefined && name !== this.openAirport) return;
    this.popup.remove();
  }

  /**
   * Whether the popup is open.
   * @param name - Ask for this airport only
   */
  isPopupOpen(name?: string): boolean {
    if (!this.popup.isOpen()) return false;
    return name === undefined || name === this.openAirport;
  }

  /**
   * Write the popup for an airport, with the counts of the current filter
   * and, once it is open, the flights it lists.
   */
  private writePopupContent(name: string): void {
    const airport = siteAirports().find((a) => a.name === name);
    if (!airport) return;

    const counts = this.airportFlightCounts();
    this.popup.setHTML(
      generateAirportPopupHtml({
        name: airport.name,
        lat: airport.lat,
        lon: airport.lon,
        latDms: ddToDms(airport.lat, true),
        lonDms: ddToDms(airport.lon, false),
        flightCount: counts[airport.name] || 0,
        isHomeBase: airport.name === findHomeBase(counts),
      }),
    );
    if (this.popup.isOpen()) this.listPopupFlights(name);
  }

  /**
   * Add the flights of the airport to its open popup.
   *
   * The list is what lets a keyboard pick a single flight, and with it
   * replay: otherwise only a click on a path does. It goes into the popup's
   * element, which exists only once the popup is on the map, and makes the
   * popup taller. MapLibre neither tells when content changes nor keeps a
   * popup inside the map the way Leaflet did, so both are done here: the
   * popup is laid out again and the map panned until it shows in full.
   */
  private listPopupFlights(name: string): void {
    const map = this.app.map;
    if (!map) return;
    listFlights(this.app, this.popup, name);
    // The side the popup hangs on was chosen for the height it had before
    // the list; setting the same position chooses again
    this.popup.setLngLat(this.popup.getLngLat());
    panPopupIntoView(
      map,
      this.popup,
      POPUP_PAN_PADDING_PX,
      !prefersReducedMotion(),
    );
  }

  /**
   * MapLibre has taken the popup out of the document by now. Focus that was
   * inside it, on the close button or a listed flight, fell to the page
   * with it, and goes to the marker instead. A click on the map closes the
   * popup as well, and keeps the focus it gave to the map.
   */
  private onPopupClosed(): void {
    const name = this.openAirport;
    this.openAirport = null;
    if (name === null) return;
    this.setExpanded(name, false);
    // The popup kept its airport on the map (keptAirport)
    this.releaseKept(name);

    const active = document.activeElement;
    if (active === null || active === document.body) {
      const marker = this.app.airportMarkers[name];
      // One that went with the popup leaves the focus with the map
      if (marker && !marker.getElement().hidden) marker.getControl().focus();
      else this.app.map?.getCanvas().focus();
    }
  }

  /**
   * Hide an airport the popup no longer keeps, if the filter and the
   * selection do not show it
   */
  private releaseKept(name: string): void {
    const visibleAirports = this.visibleAirports;
    if (visibleAirports !== null && !visibleAirports.has(name)) {
      this.applyVisibility();
    }
  }

  /** Tell assistive technology whether an airport's popup is open */
  private setExpanded(name: string, expanded: boolean): void {
    const element = this.app.airportMarkers[name]?.getElement();
    if (element) setAirportExpanded(element, expanded, AIRPORT_POPUP_ID);
  }

  /**
   * Show the airports of the data, the filter and the selection. A click
   * on a flight changes the selection alone, which outside share mode shows
   * no airport the filter does not: unless `always` (the default, for the
   * markers just made), the markers and the labels stay as they are while
   * neither the airports nor their counts change.
   */
  showAirports(always = true): void {
    const data = this.app.currentData;
    // No dataset, no flights to say which airports to show: before the
    // first one has loaded, or after it failed to, none is
    const visibleAirports = data
      ? this.visibleAirportsOf(data)
      : new Set<string>();
    const counts = this.airportFlightCounts();
    if (
      !always &&
      counts === this.labelledCounts &&
      sameAirports(visibleAirports, this.visibleAirports)
    ) {
      return;
    }

    this.visibleAirports = visibleAirports;
    this.labelledCounts = counts;
    this.applyVisibility();
  }

  /** The airports the filter and the selection show of `data` */
  private visibleAirportsOf(data: KMLDataset): Set<string> | null {
    const year = this.app.selectedYear;
    const aircraft = this.app.selectedAircraft;
    const index = datasetIndex(data);
    return calculateVisibleAirports(
      year === "all" && aircraft === "all"
        ? null
        : index.filter(year, aircraft).paths,
      shownSelection(this.app),
      this.app.isolateSelection,
      index.pathInfoById,
    );
  }

  /**
   * Hide the airports that have gone too far towards the horizon, and show
   * the ones that have come back; nothing is touched while that stays
   */
  private updateFarAirports(): void {
    const map = this.app.map;
    if (!map) return;
    const far = new Set<string>();
    if (
      map.getPitch() > AIRPORT_ALL_NEAR_PITCH &&
      map.getProjection()?.type !== "globe"
    ) {
      for (const airport of siteAirports()) {
        const place = { lng: airport.lon, lat: airport.lat };
        // The one the keyboard is on stays, or focus would fall to the page
        const focused =
          this.app.airportMarkers[airport.name]
            ?.getElement()
            .contains(document.activeElement) ?? false;
        if (
          !focused &&
          cameraDistanceRatio(map, place) > AIRPORT_MAX_DISTANCE_RATIO
        ) {
          far.add(airport.name);
        }
      }
    }
    if (sameAirports(far, this.farAirports)) return;
    this.farAirports = far;
    this.applyVisibility();
  }

  /**
   * The airport whose open popup keeps it on the map, if any. In share mode
   * only the airports of the shared flights show, and unticking the last
   * of them in the popup's list hid the airport, which took the popup and
   * the focus in it along: the next tick went nowhere. So the airport stays
   * for as long as its popup does, and goes as it closes (onPopupClosed).
   * Only while the filter still has flights there: one that hides them all
   * takes the popup away, as with every other airport it hides.
   */
  private keptAirport(): string | null {
    const name = this.openAirport;
    if (name === null || !this.popup.isOpen()) return null;
    return (this.airportFlightCounts()[name] ?? 0) > 0 ? name : null;
  }

  /** The airports the filter and the selection show, the kept one too */
  private shownBySelection(): ReadonlySet<string> | null {
    const visibleAirports = this.visibleAirports;
    const kept = this.keptAirport();
    if (visibleAirports === null || kept === null) return visibleAirports;
    return new Set(visibleAirports).add(kept);
  }

  /** Show the markers and labels of the airports the filter and view allow */
  private applyVisibility(): void {
    const visibleAirports = this.shownBySelection();
    const far = this.farAirports;
    for (const [airportName, marker] of Object.entries(
      this.app.airportMarkers,
    )) {
      if (!marker) continue;

      const visible =
        (visibleAirports === null || visibleAirports.has(airportName)) &&
        !far.has(airportName);
      marker.setVisible(visible);
      // A popup does not outlive the marker it points at
      if (!visible) this.closePopup(airportName);
    }
    this.updateLabels();
  }

  /**
   * Place the codes of the airports shown, each at its best place: the
   * home base and the busier airports, which place first, may have changed
   * with them (see ui/airportLabels.ts)
   */
  updateLabels(): void {
    this.codes?.update();
  }

  /**
   * The markers of the airports in the order their codes are placed: the
   * home base, then the busier, then by name. Kept while the counts and
   * the markers stay, as it is asked for on every frame of a move.
   */
  private rankedCodes(): readonly CodeMarker[] {
    const counts = this.airportFlightCounts();
    const markers = this.app.airportMarkers;
    const total = Object.keys(markers).length;
    const known = this.ranking;
    if (known?.counts === counts && known.markers === total) {
      return known.ranked;
    }
    const home = findHomeBase(counts);
    const rank = (name: string): number =>
      name === home ? Infinity : (counts[name] ?? 0);
    const ranked = Object.entries(markers)
      .map(([name, marker]) => {
        const { lat, lng } = marker.getLatLng();
        return { name, element: marker.getElement(), lat, lng };
      })
      .sort(
        (a, b) => rank(b.name) - rank(a.name) || a.name.localeCompare(b.name),
      );
    this.ranking = { counts, markers: total, ranked };
    return ranked;
  }

  /** Point the popup past its airport's code, wherever that is now */
  private placePopupTip(): void {
    const name = this.openAirport;
    if (name === null) return;
    this.popup.setOffset(popupOffsets(this.codes?.placeOf(name) ?? null));
  }

  updateAirportMarkerSizes(): void {
    if (!this.app.map) return;

    const zoom = this.app.map.getZoom();
    const mapContainer = document.getElementById("map");
    if (!mapContainer) return;

    const sizeClass =
      zoom < AIRPORT_HIDE_MARKERS_BELOW_ZOOM
        ? "hidden"
        : (AIRPORT_SIZE_ZOOMS.find((size) => zoom >= size.minZoom)?.sizeClass ??
          "");

    mapContainer.dataset["zoomSize"] = sizeClass;
  }
}
