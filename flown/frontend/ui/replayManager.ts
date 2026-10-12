/**
 * Replay Manager - Handles flight replay functionality
 */
import type { Feature } from "geojson";
import type { GeoJSONSource } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";
import { announceInRegion, announceStatus, showToast } from "../utils/toast";
import { formatTime } from "../utils/replayFormatters";
import { applyToggleButtonState } from "../utils/buttonState";
import {
  focusModeControl,
  focusWasIn,
  holdControls,
  REPLAY_HELD_CONTROL_IDS,
} from "./heldControls";
import { setControlIcon } from "../utils/icons";
import { STILL_LOADING_MESSAGE } from "./actions";
import { AUTO_ZOOM_FOLLOW, MAP_SOURCES, MAX_FRAME_S } from "../utils/constants";
import { airplaneLiftPx, heightAtZoomFt } from "../calculations/airplaneLift";
import { liftExaggeration, reliefLevel } from "../calculations/lift";
import type { SmoothedFlights } from "../calculations/smoothing";
import { groundProfilesFt } from "../calculations/groundProfile";
import { shownSelection } from "../calculations/datasetIndex";
import { appendCurve } from "../calculations/curves";
import {
  FIELDS,
  isPageEscape,
  toBounds,
  toLngLat,
  toLngLatAfter,
  unwrapLng,
  whenContextRestored,
  type LngLatTuple,
} from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import {
  legAt,
  type ReplayLeg,
  liftReplayCurve,
  prepareReplaySegments,
  replayCurve,
} from "../features/replay";
import { segmentBounds } from "../utils/geometry";
import { segmentsForPathIds } from "../calculations/statistics";
import { flightOrder } from "../calculations/flightProfile";

import { AirplaneMarker, ReplayRenderer } from "./replayRenderer";
import { appendTrailSegment, speedColouredTrail } from "./replayTrail";
import { restingPitch, type ReplayState } from "./replayState";
import type { SavedCamera } from "./chaseCamera";
import type { PathSegment } from "../types";
import {
  REPLAY_BUTTON_LABEL,
  REPLAY_PRECONDITION_MESSAGE,
} from "./replayButton";
import {
  calculateAirspeedRange,
  calculateAltitudeRange,
} from "../features/layers";

const REPLAY_EXIT_LABEL = "Close replay";

/**
 * The fastest replay the chase view starts at: faster, a turn is over
 * before the camera has come round, and a circuit takes half a minute at it
 */
const CHASE_MAX_SPEED = 10;

/** Why the chase view does not start with reduced motion on */
export const CHASE_REDUCED_MOTION_MESSAGE =
  "The chase view turns with the aircraft, so it stays off while reduced motion is on";

/**
 * Controls that stay disabled while replay runs. Wrapped is one of them: it
 * takes the map into its dialog, where the running replay kept panning it
 * with no way to pause, and the end of the replay zoomed the overview to
 * the single flight. Share mode and the selection chip's buttons would
 * change the selection the replay is playing (PathSelection ignores them
 * then as well), and so would Reset view (MapApp.resetView). The Heatmap
 * switch as well: the replay hides the heat, and the 3D view's faint cloud
 * behind it is not the replay's to count again.
 */
const REPLAY_DISABLED_CONTROL_IDS = [
  ...REPLAY_HELD_CONTROL_IDS,
  "replay-all-btn",
];

/** Custom property holding the replay panel's height, read by features.css */
export const REPLAY_PANEL_HEIGHT_VAR = "--replay-panel-h";

/**
 * Keep REPLAY_PANEL_HEIGHT_VAR, or `property`, at the height of a replay's
 * `panel` (or the hotspot tour's) while it shows: the toasts and the colour
 * legend stand on top of it, and it wraps anew as a phone turns or the
 * window resizes. Returns what stops that and takes the property off
 * again, which `signal` does as well: the app's, for a panel whose owner
 * has no destroy of its own.
 */
export function followPanelHeight(
  panel: HTMLElement,
  signal?: AbortSignal,
  property = REPLAY_PANEL_HEIGHT_VAR,
): () => void {
  const style = document.body.style;
  const measure = (): void =>
    style.setProperty(property, panel.offsetHeight + "px");
  measure();
  const watch =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
  watch?.observe(panel);
  const stop = (): void => {
    watch?.disconnect();
    style.removeProperty(property);
    signal?.removeEventListener("abort", stop);
  };
  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}

/**
 * Custom property holding the height of the colour legend on screen during
 * a replay, read by features.css: where the legend stands on top of the
 * panel, the toasts go above it
 */
export const REPLAY_LEGEND_HEIGHT_VAR = "--replay-legend-h";

/** The colour legends, one of which may show during a replay */
const LEGEND_IDS = ["altitude-legend", "airspeed-legend"];

/**
 * How far a key moves the timeline, as a share of the flight. The native
 * step is one second, which on a three hour flight took over ten thousand
 * presses end to end.
 */
const SLIDER_KEY_STEPS: Partial<Record<string, number>> = {
  ArrowRight: 0.01,
  ArrowUp: 0.01,
  ArrowLeft: -0.01,
  ArrowDown: -0.01,
  PageUp: 0.1,
  PageDown: -0.1,
};

/**
 * Where a key step lands: at least one second on, and never past either
 * end of the flight
 */
function sliderTarget(
  state: Pick<ReplayState, "currentTime" | "maxTime">,
  step: number,
): number {
  const seconds = Math.max(1, Math.round(Math.abs(step) * state.maxTime));
  const target = state.currentTime + Math.sign(step) * seconds;
  return Math.min(state.maxTime, Math.max(0, target));
}

/**
 * Time the view takes to reach the aircraft (ms), at AUTO_ZOOM_FOLLOW both
 * when a replay opens with auto-zoom already on and when it is switched on
 * part way through, so the two arrive at the same view
 */
const AUTO_ZOOM_PAN_MS = 800;

/**
 * Seconds of the replay's clock between the landing of one selected flight
 * and the start of the next, where several play one after another: a
 * second at 60 times their speed, six in the chase view. Never the time
 * the aircraft stood on the ground, which would say how the day went.
 */
export const REPLAY_LEG_PAUSE_S = 60;

/** Time the view takes back to the start when a finished replay restarts (ms) */
const RESTART_PAN_MS = 500;

/** Time the view takes to show the whole flight once the replay ends (ms) */
const FIT_BOUNDS_MS = 1000;

/** Pixels kept free around the flight in that view */
const FIT_BOUNDS_PADDING = 50;

/**
 * Longest wall-clock step a single frame may advance the replay by (ms).
 * A frame after a stall (a busy main thread, a laptop waking up) would
 * otherwise jump the replay ahead by the whole stall times the speed.
 */
export const MAX_FRAME_DELTA_MS = MAX_FRAME_S * 1000;

/** The least share of the timeline the pause between two flights takes (%) */
const LEG_GAP_PCT = 1;

/**
 * The track of the timeline of the flights `legs` over `maxTime` seconds,
 * as a background image: each flight's part drawn, the pause between two
 * left out, at least LEG_GAP_PCT wide so it shows. Empty for one flight,
 * whose track the stylesheet draws.
 */
export function legTrack(legs: readonly ReplayLeg[], maxTime: number): string {
  if (legs.length < 2 || !(maxTime > 0)) return "";
  const part = "var(--color-text-dim) ";
  const pct = (seconds: number): string =>
    ((seconds / maxTime) * 100).toFixed(2) + "%";
  const stops: string[] = [];
  let at = 0;
  for (let k = 1; k < legs.length; k++) {
    const middle = (legs[k - 1]!.finish + legs[k]!.start) / 2;
    const half = Math.max(
      legs[k]!.start - middle,
      (LEG_GAP_PCT / 200) * maxTime,
    );
    stops.push(
      part + pct(at) + " " + pct(middle - half),
      "transparent 0 " + pct(middle + half),
    );
    at = middle + half;
  }
  stops.push(part + pct(at) + " 100%");
  return `linear-gradient(to right,${stops.join()})`;
}

export class ReplayManager {
  private app: MapApp;
  private renderer: ReplayRenderer;
  /** Ends the subscriptions that keep the trail in step with the layers */
  private unsubscribeTrail: (() => void) | null = null;
  /**
   * The speed chosen before the chase view slowed the replay down, given
   * back when it ends unless another one was chosen meanwhile
   */
  private speedBeforeChase: string | null = null;
  /** Measures the legends while a replay runs (REPLAY_LEGEND_HEIGHT_VAR) */
  private legendWatch: ResizeObserver | null = null;
  /** Ends followPanelHeight of the open panel */
  private unfollowPanel: (() => void) | null = null;
  /** Gives the held controls back as they were (see holdControls) */
  private release: (() => void) | null = null;
  private readonly onVisibilityChange = (): void => {
    // No frames run in a hidden tab, so the first one after it comes back
    // would count all the hidden time; start timing afresh instead
    if (document.hidden) this.state.lastFrameTime = null;
  };
  /**
   * The replay state, owned by the app. The map click handler and the layer
   * redraws read it on paths that must not wait for this bundle to load, so
   * it lives in the main bundle and this manager works on the same object.
   */
  readonly state: ReplayState;

  constructor(app: MapApp) {
    this.app = app;
    this.renderer = new ReplayRenderer(app);
    this.state = app.replayState;

    document.addEventListener("visibilitychange", this.onVisibilityChange);

    // Escape leaves the replay, as it leaves Wrapped and the sheets. Not
    // from the speed picker, whose own list it closes, nor from a text
    // field such as the search of the flights, which it empties, nor from a
    // popup or a marker on the map, where it closes the popup.
    document.addEventListener(
      "keydown",
      (event) => {
        // The replay of every flight has an Escape of its own
        if (
          !app.replayActive ||
          app.replayState.all ||
          !isPageEscape(event, FIELDS)
        ) {
          return;
        }
        event.preventDefault();
        this.toggleReplay();
      },
      { signal: app.signal },
    );

    // Announce the final position once a slider drag ends (not per frame)
    const slider = domCache.get("replay-slider");
    if (slider) {
      slider.addEventListener(
        "change",
        () => this.announce("Moved to " + this.spokenTime()),
        // The slider outlives this manager; the app's signal ends with it
        { signal: app.signal },
      );
      slider.addEventListener(
        "keydown",
        (event) => {
          const step = SLIDER_KEY_STEPS[event.key];
          if (step) {
            event.preventDefault();
            this.seekReplay(String(sliderTarget(this.state, step)));
          }
        },
        { signal: app.signal },
      );
    }
    // Bound here rather than by its data-action: the handler list is part
    // of the first visit, and this control only exists with a replay
    domCache
      .get("replay-chase-btn")
      ?.addEventListener("click", () => this.toggleChase(), {
        signal: app.signal,
      });

    // Whether replay is available follows the selection and the timing
    // data, which MapApp watches: the control has to say so before this
    // bundle is ever fetched. This manager only nudges the button after an
    // activation changes it.

    // The trail written while the WebGL context was lost had no source to
    // go to, and a paused replay writes it again only once it moves on. It
    // is written whole, and the route with it. A replay closed meanwhile
    // emptied sources that were not there: the style comes back with the
    // route and trail of the loss, which go again. Not on a map the app
    // has let go of.
    if (app.map) {
      whenContextRestored(app.map, () => {
        if (app.signal.aborted) return;
        if (!this.state.layerActive) {
          this.emptyReplaySources();
          return;
        }
        this.writeRoute();
        this.state.trailDirty = true;
        this.renderer.scheduleTrailFlush(this.state);
      });
    }
  }

  /** Cancel every pending timer; the panel itself stays as it is */
  destroy(): void {
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.stopFollowingLayers();
    this.unfollowPanel?.();
    this.unfollowPanel = null;
    this.unwatchLegends();
    this.renderer.cancelTrailFlush();
    this.renderer.camera.stopWatchingMap();
    if (this.state.animationFrameId) {
      cancelAnimationFrame(this.state.animationFrameId);
      this.state.animationFrameId = null;
    }
  }

  /**
   * Open replay, or close it. `moveCamera` false opens it where the map
   * is: the flight profile opens it at a moment of the flight, and seeks
   * there right after (ui/flightProfile.ts). Several selected flights, up
   * to DAY_MAX_FLIGHTS, play one after another on one clock, in the order
   * of their files (see initializeReplay).
   */
  toggleReplay(moveCamera = true): void {
    const panel = domCache.get("replay-controls");
    if (!panel) return;

    const app = this.app;
    if (this.app.replayActive) {
      this.deactivateReplay(panel);
      return;
    }
    // The hotspot tour holds the map, and the control with it; this covers
    // a click whose bundle came late
    if (this.app.tourView) return;

    if (!this.app.canReplay()) {
      // Paths are picked on the map only in a colour layer: with nothing
      // selected, the list of the flights to pick one from opens with it
      if (app.selectedPathIds.size === 0) {
        // The list first, so the panel opens on it
        app.statsPanelVisible = app.flightListVisible = true;
      }
      showToast(app.replayHint()!, "info");
      return;
    }

    // Before initializeReplay(): it ends in updateReplayDisplay(), which
    // writes the readout, and cells that do not exist yet would leave the
    // strip showing placeholder dashes for the whole first activation
    const exit = this.ensureReplayChrome(panel);

    if (!this.initializeReplay(moveCamera)) return;

    // A popup left open on the map, such as the one a tap on a path opens on
    // a phone, would otherwise stay over the replay and its controls. The
    // airplane's own popup only opens on a click later.
    this.closeOtherPopups();

    panel.style.display = "block";
    // The colour legend stands on top of the panel during replay (see
    // features.css). The panel's height follows the pointer, the readout
    // and the width of the window, so it is measured rather than repeated
    // in the stylesheet.
    this.unfollowPanel?.();
    this.unfollowPanel = followPanelHeight(panel);
    this.watchLegends();
    // The heatmap and the colour layers hide for the replay, and the panel
    // takes the bottom edge: the mobile bar steps aside instead of stacking
    // under it (see ui/layerVisibility.ts, MobileBar)
    this.app.replayActive = true;
    this.renderer.camera.watchUser();
    // Starting from the More sheet leaves focus on a tab the line above has
    // just removed from the document, so move it into the panel
    exit.focus();

    // A toggle keeps its name, and aria-pressed says it is on; a label
    // that turned into "Stop replay" was read as "Stop replay, pressed".
    // The icon is the one that changes, to what a press does now.
    const replayBtn = domCache.get("replay-btn");
    if (replayBtn) {
      setControlIcon(replayBtn, "stop");
      applyToggleButtonState(replayBtn, true);
      replayBtn.title = REPLAY_BUTTON_LABEL;
    }

    this.updateAutoZoomButton();
    this.updateChaseButton();

    document.body.classList.add("replay-active");
    this.release?.();
    this.release = holdControls(
      REPLAY_DISABLED_CONTROL_IDS,
      "the replay",
      this.app.signal,
    );
    this.followLayers();
  }

  /**
   * Keep REPLAY_LEGEND_HEIGHT_VAR at the height of the legend on screen,
   * which the colour toggles show, swap or hide during the replay
   */
  private watchLegends(): void {
    this.unwatchLegends();
    const legends = LEGEND_IDS.map((id) => domCache.get(id)).filter(
      (legend): legend is HTMLElement => legend !== null,
    );
    const measure = (): void => {
      const height = Math.max(0, ...legends.map((l) => l.offsetHeight));
      document.body.style.setProperty(REPLAY_LEGEND_HEIGHT_VAR, height + "px");
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    this.legendWatch = new ResizeObserver(measure);
    for (const legend of legends) this.legendWatch.observe(legend);
  }

  private unwatchLegends(): void {
    this.legendWatch?.disconnect();
    this.legendWatch = null;
    document.body.style.removeProperty(REPLAY_LEGEND_HEIGHT_VAR);
  }

  /**
   * The colour toggles stay usable during replay and change what colours
   * the trail; the 3D view or its relief comes or goes, and the flown trail
   * is cut again, lifted or flat, on the ground of the view, with the
   * airplane going up or down with it
   */
  private followLayers(): void {
    this.stopFollowingLayers();
    const store = this.app.store;
    const recolour = (): void => {
      this.redrawReplayPath(this.trailMode());
      // Its values are coloured on the scale of the trail
      if (this.state.airplaneMarker?.isPopupOpen()) {
        this.updateReplayAirplanePopup();
      }
    };
    const unsubscribeColours = store.subscribeKeys(
      ["altitudeVisible", "airspeedVisible"],
      recolour,
    );
    const unsubscribeLift = store.subscribeKeys(
      ["threeDVisible", "terrainActive", "reliefLevel"],
      () => {
        this.setLifted(this.app.threeDVisible);
        this.redrawReplayPath(this.trailMode());
        this.updateReplayDisplay();
      },
    );
    this.unsubscribeTrail = () => {
      unsubscribeColours();
      unsubscribeLift();
    };
  }

  private trailMode(): "altitude" | "airspeed" {
    return speedColouredTrail(this.app) ? "airspeed" : "altitude";
  }

  /**
   * Lift the trail and the airplane, or put them on the ground: the trail's
   * ribbons are cut from the flight's curve at its height (see ribbons.ts),
   * over the ground the layers stand on (terrainActive). As that changes,
   * the curve's heights are worked out anew; where it runs, and when the
   * airplane is where on it, stay as they are.
   */
  private setLifted(lifted: boolean): void {
    const state = this.state;
    state.lifted = lifted;
    const curve = state.smoothed;
    const level = this.app.reliefLevel;
    if (
      curve &&
      (state.onTerrain !== this.app.terrainActive ||
        (state.onTerrain && state.groundLevel !== level))
    ) {
      state.onTerrain = this.app.terrainActive;
      state.groundLevel = level;
      const { ground, offsets } = groundProfilesFt(
        state.segments,
        state.onTerrain,
        level,
      );
      state.groundFt = ground;
      state.smoothed = liftReplayCurve(
        curve,
        state.segments,
        (i) => state.segments[i]!.altitude_ft,
        (i) => ground[i]!,
        offsets,
      );
    }
    state.trailPieces = new WeakMap();
    state.trailWidthZoom = null;
  }

  private stopFollowingLayers(): void {
    this.unsubscribeTrail?.();
    this.unsubscribeTrail = null;
  }

  private deactivateReplay(panel: HTMLElement): void {
    const hadFocus = focusWasIn(panel);
    // The closing announcement below replaces the "stopped" one, and the
    // map stays where it is: the airplane leaves it, and a chase gives the
    // view back from where it looks
    this.stopReplay(false, false);
    panel.style.display = "none";
    this.unfollowPanel?.();
    this.unfollowPanel = null;
    this.unwatchLegends();
    this.stopFollowingLayers();

    // Whether it is available again is settled by MapApp once the replay
    // is off (see followReplayAvailability)
    const replayBtn = domCache.get("replay-btn");
    if (replayBtn) {
      setControlIcon(replayBtn, "play");
      applyToggleButtonState(replayBtn, false);
    }

    document.body.classList.remove("replay-active");

    // The view from before the chase comes back with the map it chased on
    this.renderer.camera.endChase("all");

    // Remove airplane marker when closing replay completely
    this.state.airplaneMarker?.remove();
    this.state.airplaneMarker = null;

    this.clearReplayLayer();
    // No camera follows the airplane any more
    this.renderer.camera.stopWatchingMap();

    // The layers come back the way the user left them, and the mobile bar
    // returns (see ui/layerVisibility.ts, MobileBar)
    this.release?.();
    this.release = null;
    this.app.replayActive = false;
    // After the bar is back, which may be the control that takes focus
    if (hadFocus) this.restoreFocusAfterReplay();
    // The panel's own live region is hidden with it by now, and a hidden
    // region is not read out
    announceStatus("Replay closed");
  }

  /**
   * Build the parts of the replay panel the template does not carry: an
   * exit control in the top right, away from the transport controls at the
   * bottom, and the readout strip. Both are created once and reused.
   */
  private ensureReplayChrome(panel: HTMLElement): HTMLButtonElement {
    this.renderer.ensureReadout(panel);

    const existing = panel.querySelector<HTMLButtonElement>(".replay-exit");
    if (existing) return existing;

    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = "replay-exit";
    exit.id = "replay-exit-btn";
    exit.title = REPLAY_EXIT_LABEL;
    exit.setAttribute("aria-label", REPLAY_EXIT_LABEL);
    setControlIcon(exit, "close", 20);
    exit.addEventListener("click", () => this.toggleReplay());
    panel.prepend(exit);
    return exit;
  }

  /**
   * Hand focus back when the panel that had it closes. The exit control
   * usually holds it and is hidden with the panel, which would drop focus
   * to <body>. The bar owns the entry point while it is showing, otherwise
   * the replay button does.
   */
  private restoreFocusAfterReplay(): void {
    focusModeControl(this.app, "replay-btn");
  }

  // Their titles say what they do, as every other toggle's does, and
  // aria-pressed whether they are on
  private updateChaseButton(): void {
    const button = domCache.get("replay-chase-btn");
    if (button) applyToggleButtonState(button, this.state.chase);
  }

  private updateAutoZoomButton(): void {
    const autoZoomBtn = domCache.get("replay-autozoom-btn");
    if (autoZoomBtn) applyToggleButtonState(autoZoomBtn, this.state.autoZoom);
  }

  /**
   * The time as the live region says it: of several flights, which flies
   * and how far into it (see ReplayRenderer.legClock)
   */
  private spokenTime(): string {
    return (
      this.renderer.legClock(this.state) ?? formatTime(this.state.currentTime)
    );
  }

  /** Write to the polite live region (play/pause/seek end announcements) */
  private announce(message: string): void {
    const live = domCache.get("replay-live");
    if (live) announceInRegion(live, message);
  }

  /**
   * MapLibre keeps no list of its open popups, so each owner closes its
   * own: the airports theirs, the layer manager the one of a tapped flight
   */
  private closeOtherPopups(): void {
    for (const marker of Object.values(this.app.airportMarkers)) {
      if (marker.isPopupOpen()) marker.closePopup();
    }
    this.app.layerManager.closeSegmentPopup();
  }

  updateReplayAirplanePopup(): void {
    this.renderer.updateAirplanePopup(this.state);
  }

  initializeReplay(moveCamera = true): boolean {
    if (!this.app.fullPathSegments) {
      // Said as every other control says it while the flights load, with
      // what to do next
      showToast(`${STILL_LOADING_MESSAGE}. Try again in a moment.`);
      return false;
    }

    // Those the filter shows, as canReplay asks: share mode keeps the
    // flights a filter hides. Several play one after another in the order
    // of their files, as the profile draws them (flightOrder).
    const shown = shownSelection(this.app);
    const data = this.app.currentData;
    const order = data ? flightOrder(data.path_info, shown) : [...shown];
    if (order.length === 0) return false;
    const pathIds = this.filterAndSortSegments(order);
    if (pathIds.length === 0) {
      showToast(REPLAY_PRECONDITION_MESSAGE, "info");
      return false;
    }
    const left = order.length - pathIds.length;
    if (left > 0) {
      showToast(
        `Left out ${left} of the ${order.length} selected flights: not enough timing data`,
        "info",
      );
    }

    this.calculateColorRanges(pathIds);
    const state = this.state;
    state.onTerrain = this.app.terrainActive;
    state.groundLevel = this.app.reliefLevel;
    const { ground, offsets } = groundProfilesFt(
      state.segments,
      state.onTerrain,
      state.groundLevel,
    );
    state.groundFt = ground;
    // The flight's curve, timed, and at its height for the 3D view: once
    // per replay, flat or lifted, and on the ground of the view (see
    // setLifted). The replay goes by the times the curve has smoothed, on
    // copies of the segments: the dataset keeps its own. Several flights
    // are on one clock, REPLAY_LEG_PAUSE_S apart.
    const curve = (state.smoothed = replayCurve(
      state.segments,
      (i) => state.segments[i]!.altitude_ft,
      (i) => ground[i]!,
      offsets,
      REPLAY_LEG_PAUSE_S,
    ));
    state.segments = state.segments.map((segment, i) => ({
      ...segment,
      time: curve.times[i]!,
    }));
    this.setLifted(this.app.threeDVisible);
    this.setupReplayUI();
    // The speed select may hold a value restored by the browser, so the
    // state follows it rather than the other way round
    this.changeReplaySpeed();

    if (!this.createReplayMarker()) return false;

    this.state.resetDrawState();
    if (moveCamera) this.setInitialView();
    this.updateReplayDisplay();

    return true;
  }

  /**
   * The segments of the flights `pathIds` one after another, each sorted
   * by its times, into the state; returns the flights kept. A flight whose
   * times are all 0 would finish the moment it started without drawing
   * anything (see MapApp.canReplay), and is left out.
   */
  private filterAndSortSegments(pathIds: readonly number[]): number[] {
    const all = this.app.fullPathSegments!;
    const kept: number[] = [];
    this.state.segments = pathIds.flatMap((pathId) => {
      const segments = prepareReplaySegments(all, pathId);
      if (!((segments[segments.length - 1]?.time ?? 0) > 0)) return [];
      kept.push(pathId);
      return segments;
    });
    return kept;
  }

  private calculateColorRanges(pathIds: number[]): void {
    if (!this.app.currentData?.path_segments) return;

    const currentResSegments = segmentsForPathIds(
      this.app.currentData.path_segments,
      pathIds,
    );

    const sourceSegments =
      currentResSegments.length > 0 ? currentResSegments : this.state.segments;

    // The flight's own ranges, as the colour layers draw it selected (see
    // resolveColorRange in ui/pathLook.ts), its colours spread by its values
    this.state.colorAltRange = calculateAltitudeRange(
      sourceSegments,
      this.app.altitudeRange,
      this.app.currentData.path_info,
    );
    this.state.colorSpeedRange = calculateAirspeedRange(
      sourceSegments,
      this.app.airspeedRange,
    );
  }

  private setupReplayUI(): void {
    // The end of the last segment, which the curve times (see replayCurve)
    const lastSegment = this.state.segments[this.state.segments.length - 1];
    this.state.maxTime = this.state.smoothed?.end ?? lastSegment?.time ?? 0;

    const slider = domCache.get("replay-slider", HTMLInputElement);
    if (slider) {
      slider.max = this.state.maxTime.toString();
      // Several flights: where each is on the timeline, and the pauses
      const track = legTrack(
        this.state.smoothed?.legs ?? [],
        this.state.maxTime,
      );
      slider.style.backgroundImage = track;
      slider.style.backgroundColor = track && "transparent";
    }
    // Of several flights the time is as wide as that of the one with the
    // longest route, in characters of its monospaced font, so the panel,
    // as wide as its row, and the profile in it keep their width as the
    // next starts; a character more for the arrow, which a fallback font
    // may draw wider
    const legs = this.state.smoothed?.legs ?? [];
    const display = domCache.get("replay-time-display");
    if (display) {
      display.style.width =
        legs.length > 1
          ? Math.max(
              ...legs.map(
                (_, k) => this.renderer.legClock(this.state, k)!.length,
              ),
            ) +
            1 +
            "ch"
          : "";
    }

    // The two ends of the timeline. The current time is in the transport
    // row above; repeated at the start of the slider it read as a second
    // clock, so the start says where the timeline begins.
    const sliderEnd = domCache.get("replay-slider-end");
    if (sliderEnd) {
      sliderEnd.textContent = formatTime(this.state.maxTime);
    }
    const sliderStart = domCache.get("replay-slider-start");
    if (sliderStart) {
      sliderStart.textContent = formatTime(0, this.state.maxTime);
    }

    this.app.layerManager.updateAltitudeLegend(this.state.colorAltRange);
    this.app.layerManager.updateAirspeedLegend(this.state.colorSpeedRange);
  }

  /**
   * Lay the route down and start the trail afresh.
   *
   * Replay used to open on an empty map: the heat bloom and the paths are
   * hidden while it runs, so at 0:00 there was an aircraft over nothing,
   * with no way to see where it was about to go. The whole track is drawn
   * dimmed underneath, and the flown part paints over it in the colours of
   * the active scale. The route never changes during a replay, so its
   * source is written here and nowhere else.
   */
  private startReplayLayer(): void {
    this.writeRoute();
    this.setReplaySource(MAP_SOURCES.replayTrail, []);
    this.setReplaySource(MAP_SOURCES.replayTrailRibbons, []);
    this.state.trailWrittenTo = null;
    this.state.trailRuns = [];
    this.state.trailDirty = false;
    this.state.layerActive = true;
  }

  /** The route of the flight replayed, see startReplayLayer */
  private writeRoute(): void {
    const curve = this.state.smoothed!;
    // A line of its own for each flight, rather than one from the landing
    // of one to the start of the next
    this.setReplaySource(
      MAP_SOURCES.replayRoute,
      curve.legs.flatMap(({ first, end }): Feature[] => {
        const coordinates = routeCoordinates(
          this.state.segments,
          curve,
          first,
          end,
        );
        return coordinates.length < 2
          ? []
          : [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "LineString", coordinates },
              },
            ];
      }),
    );
  }

  /** Empty both replay sources; their layers stay on the map, showing nothing */
  private clearReplayLayer(): void {
    this.renderer.cancelTrailFlush();
    this.state.trailDirty = false;
    if (!this.state.layerActive) return;
    this.state.layerActive = false;
    this.emptyReplaySources();
    this.state.trailWrittenTo = null;
  }

  private emptyReplaySources(): void {
    this.setReplaySource(MAP_SOURCES.replayRoute, []);
    this.setReplaySource(MAP_SOURCES.replayTrail, []);
    this.setReplaySource(MAP_SOURCES.replayTrailRibbons, []);
  }

  private setReplaySource(
    id:
      | typeof MAP_SOURCES.replayRoute
      | typeof MAP_SOURCES.replayTrail
      | typeof MAP_SOURCES.replayTrailRibbons,
    features: Feature[],
  ): void {
    void this.app.map
      ?.getSource<GeoJSONSource>(id)
      ?.setData({ type: "FeatureCollection", features });
  }

  private createReplayMarker(): boolean {
    this.state.airplaneMarker?.remove();
    this.state.airplaneMarker = null;

    const firstSegment = this.state.segments[0];
    const startCoords = firstSegment?.coords[0];
    if (!startCoords || !this.app.map) return false;

    this.startReplayLayer();

    // The content is the position at the moment the popup opens (see
    // ReplayRenderer.updateAirplanePopup)
    this.state.airplaneMarker = new AirplaneMarker(
      this.app.map,
      [startCoords[0], startCoords[1]],
      () => this.updateReplayAirplanePopup(),
    );

    return true;
  }

  private setInitialView(): void {
    const firstSegment = this.state.segments[0];
    const startCoords = firstSegment?.coords[0];
    if (!startCoords || !this.app.map) return;

    this.app.map.easeTo({
      center: toLngLat(startCoords),
      ...(this.state.autoZoom ? { zoom: AUTO_ZOOM_FOLLOW } : {}),
      // A lay-back it cuts short goes on to where it was going
      pitch: restingPitch(this.app),
      duration: AUTO_ZOOM_PAN_MS,
      animate: !prefersReducedMotion(),
    });
  }

  playReplay(): void {
    if (!this.app.replayActive || !this.app.map) return;
    // Never start a second animation loop
    if (this.state.playing) return;

    if (this.state.currentTime >= this.state.maxTime) {
      // Back to the start: the first frame puts the airplane there
      this.state.resetDrawState();
      this.renderer.scheduleTrailFlush(this.state);

      const startCoords = this.state.segments[0]?.coords[0];
      if (startCoords && this.state.autoZoom) {
        this.app.map.easeTo({
          center: toLngLat(startCoords),
          zoom: AUTO_ZOOM_FOLLOW,
          duration: RESTART_PAN_MS,
          animate: !prefersReducedMotion(),
        });
      }
    }

    this.state.playing = true;
    setTransportState(true);
    this.announce("Replay playing");

    this.state.lastFrameTime = null;

    const animateReplay = (timestamp: number) => {
      if (!this.state.playing) return;

      if (this.state.lastFrameTime === null) {
        this.state.lastFrameTime = timestamp;
      }
      const deltaMs = Math.min(
        timestamp - this.state.lastFrameTime,
        MAX_FRAME_DELTA_MS,
      );
      this.state.lastFrameTime = timestamp;

      const deltaTime = (deltaMs / 1000) * this.state.speed;
      const legs = this.state.smoothed?.legs ?? [];
      const leg = legAt(legs, this.state.currentTime);
      // A frame stops at the start of the next of several flights: at
      // 1000x one of MAX_FRAME_S is 100 s, longer than the pause, and
      // passed a short flight by without saying it
      this.state.currentTime = Math.min(
        this.state.currentTime + deltaTime,
        legs[leg + 1]?.start ?? Infinity,
      );
      const next = legAt(legs, this.state.currentTime);

      if (this.state.currentTime >= this.state.maxTime) {
        this.state.currentTime = this.state.maxTime;
        this.pauseReplay(false);
        this.announce("Replay finished");
        this.fitReplayBounds();
      } else {
        this.state.animationFrameId = requestAnimationFrame(animateReplay);
      }

      // The next of several flights: the camera goes over to its start
      // rather than chase the airplane there (see movesToLeg), and the
      // follow is held for that move alone, which reduced motion makes a
      // jump. Held without one, it let the airplane fly off the map: 800
      // ms are 13 minutes of the flight at 1000x.
      // The airplane has gone on to it: said, and the camera taken there
      const moves = next !== leg && this.movesToLeg(next);
      if (moves && !prefersReducedMotion()) {
        this.renderer.camera.hold(AUTO_ZOOM_PAN_MS);
      }
      this.updateReplayDisplay();
      if (next !== leg && this.state.playing) {
        this.announce("Flight " + this.renderer.legName(this.state, next));
        if (moves) this.zoomToAircraft();
      }
    };

    this.state.animationFrameId = requestAnimationFrame(animateReplay);
  }

  private fitReplayBounds(): void {
    if (this.state.segments.length === 0 || !this.app.map) return;

    const bounds = segmentBounds(this.state.segments);
    // The flight is over, and with it the chase: the overview is seen the
    // way the map was before it
    const saved = this.renderer.camera.endChase();
    if (!bounds) return;
    this.app.map.fitBounds(toBounds(bounds), {
      // A fit turns the map north up unless it is told the bearing, and
      // the replay leaves the orientation to the user
      bearing: saved?.bearing ?? this.app.map.getBearing(),
      ...(saved && { pitch: saved.pitch }),
      padding: FIT_BOUNDS_PADDING,
      duration: FIT_BOUNDS_MS,
      animate: !prefersReducedMotion(),
    });
  }

  pauseReplay(announce: boolean = true): void {
    const wasPlaying = this.state.playing;
    this.state.playing = false;
    setTransportState(false);

    if (this.state.animationFrameId) {
      cancelAnimationFrame(this.state.animationFrameId);
      this.state.animationFrameId = null;
    }

    this.state.lastFrameTime = null;

    if (wasPlaying && announce) {
      this.announce("Replay paused at " + this.spokenTime());
    }
  }

  stopReplay(announce = true, onMap = true): void {
    this.pauseReplay(false);
    this.state.resetDrawState();
    if (!onMap) {
      // Back to the start without moving the airplane and the camera with
      // it: a paused chase took a step towards the start of the flight
      // before it eased back, about 2 km at its zoom
      this.renderer.updateTransport(this.state);
      return;
    }
    // Which puts the airplane back at the start
    this.updateReplayDisplay();
    if (this.app.replayActive && announce) this.announce("Replay stopped");
  }

  seekReplay(value: string): void {
    const newTime = parseFloat(value);
    if (!isFinite(newTime)) return;

    if (newTime < this.state.currentTime) {
      // Drop only the segments after the new position; starting the trail
      // over would colour the entire flight again on every drag event
      this.renderer.removeSegmentsAfter(this.state, newTime);
    }

    this.state.currentTime = newTime;
    this.updateReplayDisplay(true);
  }

  changeReplaySpeed(): void {
    const select = domCache.get("replay-speed", HTMLSelectElement);
    if (!select) return;

    const speed = parseFloat(select.value);
    if (!isFinite(speed) || speed <= 0) return;
    this.state.speed = speed;
  }

  /**
   * Switch the chase view on or off (see ReplayCamera.chaseAirplane). On,
   * a replay faster than CHASE_MAX_SPEED slows down to it; off, the speed
   * from before comes back and so does the view, over the airplane.
   */
  toggleChase(): void {
    const state = this.state;
    if (!state.chase && prefersReducedMotion()) {
      showToast(CHASE_REDUCED_MOTION_MESSAGE, "info");
      return;
    }
    state.chase = !state.chase;
    this.updateChaseButton();
    const select = domCache.get("replay-speed", HTMLSelectElement);
    const slow = String(CHASE_MAX_SPEED);
    let message = state.chase ? "Chase view on" : "Chase view off";
    if (state.chase) {
      if (select && state.speed > CHASE_MAX_SPEED) {
        this.speedBeforeChase = select.value;
        select.value = slow;
        this.changeReplaySpeed();
        message += ", " + slow + "x";
      }
      this.updateReplayDisplay();
    } else {
      if (this.speedBeforeChase !== null && select?.value === slow) {
        select.value = this.speedBeforeChase;
        this.changeReplaySpeed();
      }
      this.speedBeforeChase = null;
      this.renderer.camera.endChase("view");
    }
    this.announce(message);
  }

  /**
   * The user's view while the chase view has the map, null otherwise; the
   * state manager saves this one rather than a camera half way through a
   * flight
   */
  userMapView(): SavedCamera | null {
    return this.renderer.camera.chaseView();
  }

  toggleAutoZoom(): void {
    this.state.autoZoom = !this.state.autoZoom;
    this.updateAutoZoomButton();
    if (this.state.autoZoom) this.zoomToAircraft();
  }

  /**
   * Go to the aircraft at the follow zoom, the view a replay that opened with
   * auto-zoom already on starts at.
   *
   * Switching it on used to do nothing to the map. The renderer only ever
   * zooms out, to catch an aircraft the pan has lost, so the control stayed
   * silent until the flight left the viewport and then only widened the view:
   * the one thing "auto-zoom" does not suggest. Turning it on now arrives at
   * the same place as starting with it on, whatever the map was showing.
   */
  private zoomToAircraft(): void {
    const position = this.state.airplaneMarker?.getLatLng();
    const map = this.app.map;
    if (!position || !map) return;
    // Without auto-zoom, to the next of several flights (see movesToLeg)
    const zoom = this.state.autoZoom ? AUTO_ZOOM_FOLLOW : map.getZoom();
    // In the 3D view the airplane is drawn up at its height: the ground
    // under it goes as far below the middle as it is drawn above it at the
    // zoom this ends at, which brings the airplane itself to the middle,
    // exaggerated as the level of that zoom is once it has ended
    const lift = airplaneLiftPx(
      map,
      position[0],
      heightAtZoomFt(this.state.airplaneHeight(), zoom),
      liftExaggeration(reliefLevel(zoom)),
      zoom,
    );
    map.easeTo({
      center: toLngLat(position),
      zoom,
      offset: [0, lift],
      duration: AUTO_ZOOM_PAN_MS,
      animate: !prefersReducedMotion(),
    });
  }

  /**
   * Whether the camera goes over to the start of the flight `leg` of
   * several as the airplane goes on to it, rather than the follow jump
   * there, auto-zoom zooming out as it found the airplane off the map:
   * with auto-zoom on, at its zoom, and without at the map's, only where
   * that start is out of view (on the copy of the world the map shows,
   * which across the antimeridian is the other side of it). Not while the
   * chase flies over on its own, nor under the user's hand on the map,
   * nor where the last of them has landed in the same frame: the end has
   * said so and shows them all.
   */
  private movesToLeg(leg: number): boolean {
    const state = this.state;
    const map = this.app.map;
    const [lat, lng] =
      state.segments[state.smoothed!.legs[leg]!.first]!.coords[0];
    return (
      !!map &&
      state.playing &&
      !state.chase &&
      !this.renderer.camera.userMoving() &&
      (state.autoZoom ||
        !map.getBounds().contains([unwrapLng(lng, map.getCenter().lng), lat]))
    );
  }

  redrawReplayPath(mode: "altitude" | "airspeed"): void {
    if (!this.state.layerActive) return;
    const savedTime = this.state.currentTime;
    const savedIndex = this.state.lastDrawnIndex;
    // The runs are cut by colour, so another scale means other runs: the
    // flown part is coloured again from the start
    this.state.trailRuns = [];
    this.state.lastDrawnIndex = -1;
    this.state.trailDirty = true;

    for (let i = 0; i <= savedIndex && i < this.state.segments.length; i++) {
      const seg = this.state.segments[i];
      if (!seg || (seg.time ?? 0) > savedTime) continue;
      appendTrailSegment(this.state, i, mode === "airspeed");
    }
    this.renderer.scheduleTrailFlush(this.state);
  }

  /** Tell `listener` the replay's time on every display (see onTime) */
  followTime(listener: ((state: ReplayState) => void) | null): void {
    this.renderer.onTime = listener;
  }

  updateReplayDisplay(isManualSeek: boolean = false): void {
    this.renderer.updateDisplay(this.state, isManualSeek);
  }
}

/**
 * Show exactly one of the play and pause controls.
 *
 * The attribute is the only owner of which one shows. Writing an inline
 * `display` here used to blockify the button inside the flex transport row,
 * which pinned its icon to the left edge for the rest of the session, and it
 * left `.initially-hidden` claiming the same state from the stylesheet.
 *
 * The control that goes away may be the one holding focus: pressing Play
 * with the keyboard hides Play, and the end of the replay hides Pause.
 * Focus then moves to the control that took its place instead of dropping
 * to <body>, where the next Space did nothing.
 */
function setTransportState(playing: boolean): void {
  const playBtn = domCache.get("replay-play-btn");
  const pauseBtn = domCache.get("replay-pause-btn");
  const hiding = playing ? playBtn : pauseBtn;
  const showing = playing ? pauseBtn : playBtn;
  const hadFocus = hiding !== null && document.activeElement === hiding;
  // The class covers only the moment before this first runs
  playBtn?.classList.remove("initially-hidden");
  pauseBtn?.classList.remove("initially-hidden");
  if (playBtn) playBtn.hidden = playing;
  if (pauseBtn) pauseBtn.hidden = !playing;
  if (hadFocus) showing?.focus();
}

/**
 * The flight's whole track as one list of `[lng, lat]` points: along its
 * curve (see smoothing.ts), where the trail will run. Of the segments from
 * `first` to `end` (exclusive) only: one flight of several.
 */
export function routeCoordinates(
  segments: PathSegment[],
  curves: SmoothedFlights,
  first = 0,
  end = segments.length,
): LngLatTuple[] {
  const coords: LngLatTuple[] = [];
  for (let index = first; index < end; index++) {
    const start = segments[index]!.coords[0];
    // A segment that starts a curve (the first, or the first after a break
    // in the flight) adds its start: appendCurve continues from the point
    // before it
    if (curves.from[index] === 0) {
      const previous = coords[coords.length - 1];
      coords.push(previous ? toLngLatAfter(start, previous) : toLngLat(start));
    }
    appendCurve(coords, curves, index);
  }
  return coords;
}
