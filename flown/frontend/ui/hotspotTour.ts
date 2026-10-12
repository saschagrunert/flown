/**
 * The hotspot tour: a short flight over the busiest places of the heat,
 * a way into the 3D view that explains itself.
 *
 * It finds the places where the heat the map shows is strongest
 * (calculations/hotspots.ts: the filters and Share mode count, and the heat
 * is weighed as for the heatmap), turns the 3D view and the heatmap on,
 * and flies to each in turn, tilted, turning slowly over it while a
 * caption names the place and the time spent there. Pause, the
 * previous and the next place and Stop are in its panel; Escape stops it
 * too. The 3D view is turned on as the switch of the store, not by its
 * control, which turns the altitude colours on for a map without a layer
 * of the flights: the heatmap is on here, and the cloud is what is looked
 * at.
 *
 * How it ends decides where the user is left. Played to the end, stopped
 * or Escaped, it flies back to the view it started from with the switches
 * as they were: it was a look round, and the user's view, the link and
 * the saved state are what they had. A press, a wheel or a key on the map
 * ends it where it is instead, in the 3D view: the user has taken the map
 * over there, which is what the tour is the way into. Until then the state
 * manager saves the view the tour started from (tourView in the store), as
 * it saves the one Wrapped holds.
 *
 * Under reduced motion nothing flies or turns: the camera cuts to each
 * place, and the tour stays there until the user steps on, with nothing to
 * pause.
 *
 * It holds the filters, the weighing switches, the selection and the
 * features that would take the map (Replay, Replay all, Wrapped, the
 * cross-section, which it closes) while it runs, as the replay does, and
 * none of those starts it. On a phone the bar steps aside while it runs,
 * as it does for a replay, and the panel takes the bottom edge. The
 * readout of the cloud under the pointer hides meanwhile (features.css):
 * the camera moves under a pointer resting on the map.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { UserMapView } from "./wrappedManager";
import { datasetIndex } from "../calculations/datasetIndex";
import {
  findHotspots,
  hotspotDetail,
  hotspotName,
  type Hotspot,
} from "../calculations/hotspots";
import { findHomeBase } from "../features/airports";
import { siteData } from "../state/siteData";
import { applyToggleButtonState } from "../utils/buttonState";
import {
  focusModeControl,
  holdControls,
  SELECTION_CONTROL_IDS,
} from "./heldControls";
import { domCache } from "../utils/domCache";
import { DEGREES_TO_RADIANS, metresPerPixel } from "../utils/geometry";
import { setControlIcon, type IconName } from "../utils/icons";
import { FIELDS, isPageEscape, mapSize, toLngLat } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { announceInRegion, announceStatus, showToast } from "../utils/toast";
import {
  flyToStop,
  followTakeover,
  jumpToStop,
  restCamera,
  turnTo,
  type CameraStop,
} from "./cameraScript";
import { crossSectionOpen, toggleCrossSection } from "./crossSection";
import { nameButton } from "./crossSectionElements";
import { restingPitch } from "./replayState";
import { followPanelHeight } from "./replayManager";
import { featurePart } from "./lazyBundles";

/** How long the camera flies from one place to the next, in ms */
export const TOUR_FLY_MS = 4000;

/** How long it stays over a place, turning, in ms */
export const TOUR_DWELL_MS = 7000;

/** How far it turns over a place, in degrees: under 4 a second */
export const TOUR_TURN_DEG = 25;

/** How long the flight back to the user's view takes, in ms */
export const TOUR_RETURN_MS = 2500;

/** The shortest flight a resumed leg takes, however little of it was left */
const TOUR_MIN_LEG_MS = 600;

/** How far the camera is tilted over a place, as Wrapped's intro over home */
const TOUR_PITCH = 60;

/**
 * How much of the ground the smaller side of the map spans over a place:
 * this many times the place's radius (Hotspot.radiusM), and at least
 * TOUR_MIN_SPAN_M, within the zooms of TOUR_ZOOM
 */
const TOUR_SPAN_RADII = 8;
const TOUR_MIN_SPAN_M = 12000;
const TOUR_ZOOM = { min: 9, max: 13 };

/** The control that starts and stops the tour */
const TOUR_BUTTON_ID = "hotspot-tour-btn";

/** The class of the body while the tour runs (features.css) */
const TOUR_ACTIVE_CLASS = "hotspot-tour-active";

/** The panel's height, which the toasts stack above (features.css) */
const TOUR_PANEL_HEIGHT_VAR = "--tour-panel-h";

/** Said when the view has no time logged anywhere to tour */
export const TOUR_NOTHING_MESSAGE =
  "No flight in this view has logged time to tour";

/**
 * Controls held while the tour runs: the filters and the selection, which
 * would change what it tours; the switches it turns on; and what would
 * take the map from it
 */
const HELD_CONTROL_IDS = [
  "heatmap-btn",
  "three-d-btn",
  "compass-btn",
  "compass-float-btn",
  "year-select",
  "aircraft-select",
  ...SELECTION_CONTROL_IDS,
  "reset-view-btn",
  "replay-btn",
  "replay-all-btn",
  "wrapped-btn",
  "cross-section-btn",
  "search-btn",
];

/**
 * The view the tour started from, which it goes back to and the state
 * manager saves while it runs: Wrapped's and the heatmap switch
 */
export interface TourView extends UserMapView {
  heatmapVisible: boolean;
}

/** Where the camera of a view is */
type TourCamera = Pick<UserMapView, "center" | "zoom" | "bearing" | "pitch">;

/** A place of the tour, as it is shown */
interface TourStop {
  /** "Home field EDAQ Halle-Oppin" */
  name: string;
  /** "32 h, 22% of the time" */
  detail: string;
  camera: CameraStop;
}

/**
 * The map zoom over a place: its ground as TOUR_SPAN_RADII says across
 * the smaller side of a map of `width` by `height` pixels
 */
export function tourZoom(
  hotspot: Hotspot,
  width: number,
  height: number,
): number {
  const span = Math.max(hotspot.radiusM * TOUR_SPAN_RADII, TOUR_MIN_SPAN_M);
  const wanted = span / Math.max(Math.min(width, height), 1);
  const cos = Math.cos(hotspot.center[0] * DEGREES_TO_RADIANS);
  // The zoom at which a pixel of the place is `wanted` metres
  const zoom = Math.log2((metresPerPixel(0) * cos) / wanted);
  return Math.min(Math.max(zoom, TOUR_ZOOM.min), TOUR_ZOOM.max);
}

/**
 * The places of the tour of what the heatmap of `app` shows on `map`,
 * busiest first, the camera over the first facing as the map does and
 * turned on by TOUR_TURN_DEG over each one after it, where the turn over
 * the one before ended
 */
function tourStops(app: MapApp, map: MapLibreMap): TourStop[] {
  const data = app.currentData;
  if (!data) return [];
  const view = datasetIndex(data).filter(
    app.selectedYear,
    app.selectedAircraft,
  );
  const kept = view.pathIds;
  const selected = app.selectedPathIds;
  // Share mode ends with its last flight (AppStore.settle)
  const keep = app.isolateSelection
    ? (pathId: number) => kept.has(pathId) && selected.has(pathId)
    : (pathId: number) => kept.has(pathId);
  const home = findHomeBase(view.airportCounts());
  const airports = siteData.airports ?? [];
  const { width, height } = mapSize(map);
  const bearing = map.getBearing();
  return findHotspots(data.path_segments, keep).map((hotspot, index) => ({
    name: hotspotName(hotspot.center, airports, home),
    detail: hotspotDetail(hotspot),
    camera: {
      center: hotspot.center,
      zoom: tourZoom(hotspot, width, height),
      pitch: TOUR_PITCH,
      bearing: bearing + index * TOUR_TURN_DEG,
    },
  }));
}

/** An icon-only button of the panel */
function tourButton(id: string, icon: IconName, onClick: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.className = "btn-surface replay-btn";
  setControlIcon(button, icon, 20);
  button.addEventListener("click", onClick);
  return button;
}

/** How the tour ends, see the module's comment */
type TourEnd =
  /** Back to the view and the switches it started from */
  | "return"
  /** Left where it is: the user has taken the map over */
  | "takeover"
  /** The switches back, the camera left to what took the map */
  | "abandon";

/** The parts of the panel the tour writes to */
interface TourPanel {
  root: HTMLElement;
  count: HTMLElement;
  name: HTMLElement;
  detail: HTMLElement;
  previous: HTMLButtonElement;
  play: HTMLButtonElement;
  next: HTMLButtonElement;
  live: HTMLElement;
}

/** The tour of one app, and its panel */
export interface HotspotTour {
  /** Whether it runs */
  readonly isOpen: boolean;
  /** Whether it moves on by itself */
  readonly isPlaying: boolean;
  /** The place it is at or on its way to, from 0 */
  readonly current: number;
  /** How many places it has */
  readonly length: number;
  toggle(): void;
  /**
   * Start at the busiest place of what the heatmap shows. Not while a
   * replay runs or Wrapped is open, which have the map, nor for a view
   * without time logged anywhere, which says so.
   */
  start(): void;
  /** Stop, and fly back to the view it started from */
  stop(): void;
  /** Hold it where it is */
  pause(): void;
  /** Go on from where it was held */
  resume(): void;
  /** The next place, or the end after the last */
  next(): void;
  /** The place before; none before the first */
  previous(): void;
}

/**
 * The tour of `app`. A closure rather than a class, as the cross-section
 * and the profile are: a bundle keeps the names of a class's members.
 */
export function createHotspotTour(app: MapApp): HotspotTour {
  /** The map of the app, while the tour runs */
  let tourMap: MapLibreMap | null = null;
  let places: TourStop[] = [];
  let at = 0;
  /** Whether it moves on by itself; never under reduced motion */
  let playing = false;
  /** Whether it only steps on as asked: reduced motion, as it started */
  let stepping = false;
  /** What the camera is doing at the place of `at` */
  let phase: "fly" | "dwell" = "fly";
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the phase ends, by Date.now() */
  let due = 0;
  /** What was left of the phase as the tour paused, in ms */
  let remaining = 0;
  /**
   * Whether the camera flies to the place of a step taken while the tour
   * is paused, which goes on as asked: a pause stops only the flight that
   * was under way as it was pressed
   */
  let flying = false;
  /** The user's view, while it runs */
  let savedView: TourView | null = null;
  /**
   * Whether a move of the tour's own is under way: one the map has not
   * ended, as it ends a move for another that starts (see end)
   */
  let moving = false;
  /**
   * The view the camera flies back to after the tour, until it gets
   * there or is stopped: a tour started again on the way goes back to it,
   * not to wherever the flight back had come to
   */
  let returnView: TourCamera | null = null;
  /** Gives the held controls back as they were (see holdControls) */
  let release: (() => void) | null = null;
  /** Ends what follows the map and the store while it runs */
  let listeners: AbortController | null = null;
  let tourPanel: TourPanel | null = null;

  const tour: HotspotTour = {
    get isOpen() {
      return tourMap !== null;
    },

    get isPlaying() {
      return playing;
    },

    get current() {
      return at;
    },

    get length() {
      return places.length;
    },

    toggle() {
      if (tourMap) tour.stop();
      else tour.start();
    },

    start() {
      const map = app.map;
      if (tourMap || !map || app.replayActive || app.wrappedVisible) return;
      const stops = tourStops(app, map);
      if (stops.length === 0) {
        showToast(TOUR_NOTHING_MESSAGE, "info");
        return;
      }
      // Its line is drawn on the map the camera flies from, as for a replay
      if (crossSectionOpen(app)) toggleCrossSection(app);
      tourMap = map;
      places = stops;
      const center = map.getCenter();
      const saved: TourView = {
        center: { lat: center.lat, lng: center.lng },
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: restingPitch(app),
        // On the way back from a tour before, the view that one started from
        ...returnView,
        globeVisible: app.globeVisible,
        threeDVisible: app.threeDVisible,
        heatmapVisible: app.heatmapVisible,
      };
      returnView = null;
      savedView = saved;
      // Before the switches, whose change the state manager saves
      app.tourView = saved;
      app.store.batch(() => {
        app.threeDVisible = true;
        app.heatmapVisible = true;
      });
      release?.();
      release = holdControls(HELD_CONTROL_IDS, "the hotspot tour", app.signal);
      showRunning(true);

      const listening = new AbortController();
      listeners = listening;
      // The map ends a move as it comes to rest, is stopped, or another
      // starts, and the script's rest (restCamera) ends it too
      const moved = map.on("moveend", () => {
        moving = false;
      });
      followTakeover(map, () => end("takeover"), listening.signal);
      const store = app.store;
      const unsubscribe = [
        // Other flights are not what it was asked to tour
        store.subscribe("currentData", () => end("return")),
        // Nor is the map its own any more once either comes on
        store.subscribeKeys(["replayActive", "wrappedVisible"], () =>
          end("abandon"),
        ),
      ];
      listening.signal.addEventListener("abort", () => {
        for (const stop of unsubscribe) stop();
        moved.unsubscribe();
      });

      stepping = prefersReducedMotion();
      playing = !stepping;
      const panel = panelOf();
      panel.root.hidden = false;
      // A long name takes a second line on a phone, and a turn of the phone
      // or a resize of the window one more or one less: measured as it
      // changes, not only as a step is shown. Taken off as the tour ends.
      followPanelHeight(panel.root, listening.signal, TOUR_PANEL_HEIGHT_VAR);
      goTo(0);
      (stepping ? panel.next : panel.play).focus();
    },

    stop() {
      end("return");
    },

    pause() {
      if (!tourMap || !playing) return;
      playing = false;
      clearTimeout(timer);
      remaining = Math.max(due - Date.now(), 0);
      flying = false;
      moving = false;
      tourMap.stop();
      restCamera(tourMap);
      sync();
      announce("Tour paused");
    },

    resume() {
      const map = tourMap;
      if (!map || playing || stepping) return;
      playing = true;
      if (phase === "dwell") {
        turn(remaining);
      } else if (flying) {
        // Lands as it would have: no new flight from half way
        after(Math.max(due - Date.now(), 0), dwell);
      } else {
        const left = Math.max(remaining, TOUR_MIN_LEG_MS);
        flyToStop(map, places[at]!.camera, left);
        moving = true;
        after(left, dwell);
      }
      flying = false;
      sync();
      announce("Tour playing");
    },

    next() {
      if (!tourMap) return;
      if (at + 1 >= places.length) tour.stop();
      else goTo(at + 1);
    },

    previous() {
      if (tourMap && at > 0) goTo(at - 1);
    },
  };

  /**
   * Go to the place of `index`: fly there and turn over it while it plays,
   * fly there and wait while it is paused, cut to it under reduced motion
   */
  function goTo(index: number): void {
    const map = tourMap!;
    const stop = places[index]!;
    at = index;
    clearTimeout(timer);
    sync();
    announce(`${index + 1} of ${places.length}: ${stop.name}, ${stop.detail}`);
    if (stepping) {
      phase = "dwell";
      jumpToStop(map, stop.camera);
      restCamera(map);
      return;
    }
    phase = "fly";
    due = Date.now() + TOUR_FLY_MS;
    flying = !playing;
    flyToStop(map, stop.camera, TOUR_FLY_MS);
    // After the move, which ends the one before
    moving = true;
    after(TOUR_FLY_MS, () => (playing ? dwell() : arrive()));
  }

  /**
   * Arrived: the app follows the view it came to (the relief level and its
   * exaggeration above all, which stays the one of where the flight set
   * off until then). Paused, it waits there, the whole turn over the
   * place still to come.
   */
  function arrive(): void {
    phase = "dwell";
    flying = false;
    remaining = TOUR_DWELL_MS;
    restCamera(tourMap!);
  }

  /** Arrived, and the camera turns over the place, then moves on */
  function dwell(): void {
    arrive();
    turn(TOUR_DWELL_MS);
  }

  /** Turn to where the turn over this place ends, in `ms`, then move on */
  function turn(ms: number): void {
    const bearing = places[at]!.camera.bearing + TOUR_TURN_DEG;
    turnTo(tourMap!, bearing, ms);
    moving = true;
    after(ms, () => tour.next());
  }

  /** Take the next step in `ms`; a pause, a step or the end cancel it */
  function after(ms: number, step: () => void): void {
    clearTimeout(timer);
    due = Date.now() + ms;
    timer = setTimeout(step, ms);
  }

  function end(how: TourEnd): void {
    const map = tourMap;
    if (!map) return;
    const saved = savedView!;
    const panel = tourPanel!;
    const hadFocus = panel.root.contains(document.activeElement);
    tourMap = null;
    savedView = null;
    playing = false;
    clearTimeout(timer);
    listeners?.abort();
    listeners = null;
    app.tourView = null;
    release?.();
    release = null;
    showRunning(false);
    panel.root.hidden = true;
    if (app.signal.aborted) return;
    if (how === "takeover") {
      // A click or a key that moves nothing does not stop the camera, which
      // would fly and turn on to where the script put it, out of the app's
      // sight: it stops here. A press comes before MapLibre's mouse and
      // touch events, so the drag it starts goes on. The view and the
      // switches are the user's now, saved as they are.
      map.stop();
      restCamera(map);
    } else if (how === "abandon" && moving) {
      // A flight or a turn of the tour's own would go on under what took
      // the map, out of the app's sight. Only its own: a move of what took
      // the map has ended it already (see `moving`).
      map.stop();
    }
    moving = false;
    // The view and the switches the user took the map over with are theirs
    if (how === "takeover") {
      app.stateManager.scheduleSave();
    } else {
      app.store.batch(() => {
        app.threeDVisible = saved.threeDVisible;
        app.heatmapVisible = saved.heatmapVisible;
      });
    }
    if (how === "return") {
      const { center, zoom, bearing, pitch } = saved;
      const returning: TourCamera = { center, zoom, bearing, pitch };
      // Not a scripted move: the app follows it as it comes to rest
      const view = {
        ...returning,
        center: toLngLat([center.lat, center.lng]),
      };
      if (prefersReducedMotion()) map.jumpTo(view);
      else {
        map.flyTo({ ...view, duration: TOUR_RETURN_MS });
        // Until it gets there or is stopped: registered after the flight,
        // whose start ended the move before it
        returnView = returning;
        map.once("moveend", () => {
          if (returnView === returning) returnView = null;
        });
      }
    }
    if (hadFocus) focusModeControl(app, TOUR_BUTTON_ID);
    announceStatus(
      how === "takeover" ? "Hotspot tour ended here" : "Hotspot tour ended",
    );
  }

  /**
   * The page as the tour runs or not: its control and the body. The
   * phone's bar follows `tourView` in the store.
   */
  function showRunning(running: boolean): void {
    document.body.classList.toggle(TOUR_ACTIVE_CLASS, running);
    const button = domCache.get(TOUR_BUTTON_ID);
    if (button) {
      setControlIcon(button, running ? "stop" : "trophy");
      applyToggleButtonState(button, running);
    }
  }

  /** The panel as the tour stands */
  function sync(): void {
    const panel = tourPanel!;
    const stop = places[at]!;
    const last = at + 1 >= places.length;
    panel.count.textContent = `${at + 1} of ${places.length}`;
    panel.name.textContent = stop.name;
    panel.detail.textContent = stop.detail;
    panel.play.hidden = stepping;
    setControlIcon(panel.play, playing ? "pause" : "play", 20);
    nameButton(panel.play, playing ? "Pause the tour" : "Play the tour");
    // Not disabled, which would drop its focus: said, and a press ignored
    panel.previous.setAttribute("aria-disabled", String(at === 0));
    nameButton(panel.next, last ? "End the tour" : "Next hotspot");
  }

  /** Speak a message through the panel's own live region */
  function announce(message: string): void {
    announceInRegion(tourPanel!.live, message);
  }

  /** The panel, built the first time the tour starts */
  function panelOf(): TourPanel {
    if (tourPanel) return tourPanel;
    const root = document.createElement("div");
    root.id = "hotspot-tour";
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Hotspot tour");

    // Read out through the live region below, with the count, in one go
    const caption = document.createElement("div");
    caption.id = "hotspot-tour-caption";
    const line = (part: string): HTMLElement => {
      const element = document.createElement("span");
      element.id = "hotspot-tour-" + part;
      caption.append(element);
      return element;
    };
    const count = line("count");
    const name = line("name");
    const detail = line("detail");

    const previous = tourButton("hotspot-tour-previous-btn", "collapse", () =>
      tour.previous(),
    );
    nameButton(previous, "Previous hotspot");
    const play = tourButton("hotspot-tour-play-btn", "pause", () => {
      if (playing) tour.pause();
      else tour.resume();
    });
    const next = tourButton("hotspot-tour-next-btn", "chevronRight", () =>
      tour.next(),
    );
    const exit = tourButton("hotspot-tour-stop-btn", "close", () =>
      tour.stop(),
    );
    nameButton(exit, "Stop the tour and go back");
    const buttons = document.createElement("div");
    buttons.id = "hotspot-tour-buttons";
    buttons.append(previous, play, next, exit);

    const live = document.createElement("div");
    live.id = "hotspot-tour-live";
    live.className = "visually-hidden";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");

    root.append(caption, buttons, live);
    document.body.append(root);
    tourPanel = { root, count, name, detail, previous, play, next, live };
    return tourPanel;
  }

  // Escape stops it, as it closes the replay; not from a popup or a
  // marker, which it closes first, nor from a text field or a select
  document.addEventListener(
    "keydown",
    (event) => {
      if (!tourMap || !isPageEscape(event, FIELDS)) return;
      event.preventDefault();
      tour.stop();
    },
    { signal: app.signal },
  );
  // A hidden tab stops the camera's frames and not the tour's timer,
  // which then took the next step mid-flight and jumped on return: the
  // tour pauses as a click on Pause would, and plays on once the tab is
  // back, if it was playing
  let resumeOnShow = false;
  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) {
        resumeOnShow = playing;
        tour.pause();
      } else if (resumeOnShow) {
        resumeOnShow = false;
        tour.resume();
      }
    },
    { signal: app.signal },
  );
  // An app made anew on the page builds a panel of its own
  app.signal.addEventListener("abort", () => {
    end("abandon");
    tourPanel?.root.remove();
  });

  return tour;
}

/** Start or stop the hotspot tour of `app`, made the first time */
export function toggleHotspotTour(app: MapApp): void {
  featurePart(app, "hotspotTour", () => createHotspotTour(app)).toggle();
}
