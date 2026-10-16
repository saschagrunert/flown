/**
 * Map Orientation - the compass, the globe switch and the 3D switch
 *
 * The map turns and tilts by gesture (right drag or ctrl drag, two fingers
 * on touch, shift with the arrow keys), and these two controls are the way
 * back and the way to the other projection. They are the app's own buttons
 * rather than MapLibre's NavigationControl and GlobeControl: those sit in a
 * corner of the map, where the control columns and the legends already are,
 * they are 29 px squares in a light theme where every control here is 36 px
 * (44 px on touch) on the dark surface, and on a phone they would float over
 * the map while everything else lives in the bar and its sheets. What they
 * do is one call each, which is all this module has to carry.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { setUnavailable } from "../utils/buttonState";
import { HEAT_LINES } from "../utils/constants";
import { isTouchDevice } from "../utils/device";
import { domCache } from "../utils/domCache";
import { DEGREES_TO_RADIANS } from "../utils/geometry";
import { isReplayCameraMove, onMapReady } from "../utils/mapHelpers";
import { storedFlag, storeFlag } from "../utils/storedFlag";
import { dismissToast, showToast, TOAST_DURATION_MS } from "../utils/toast";

/**
 * The tilt the 3D view turns a flatter map to, and what counts as flat
 * enough to need it: straight from above, a height takes no room.
 */
const THREE_D_PITCH = 50;
const THREE_D_MIN_PITCH = 20;

/**
 * The tilt past which a flat map tilted by hand offers the 3D view, once a
 * visit: tilting does not turn it on, as a tilt is also just a look at the
 * map (see onPitchEnd). On a touch screen a tilt is two fingers dragged up
 * or down side by side, which the map only takes while they stay level
 * and which tilts it by little, so a smaller tilt counts there.
 */
const THREE_D_HINT_PITCH = 30;
const THREE_D_HINT_TOUCH_PITCH = 15;
export const THREE_D_HINT_MESSAGE = "Turn on 3D to lift the flights";

/**
 * How long the tip (see listenForTip) stays when nothing takes it away:
 * twice an info toast's time, as it has a button to reach as well as a
 * line to read. It goes by itself, unlike the offer of a tilt: it comes
 * unasked, right after a pick or a zoom, just above the bar where the next
 * tap is.
 */
export const THREE_D_TIP_MS = 2 * TOAST_DURATION_MS;

/**
 * Where the browser remembers that it offered the 3D view, or that the
 * user switched 3D on, so the tip of a touch screen (see listenForTip)
 * comes once on a device rather than on every visit. For the device, not
 * for one map, like the flight profile's: it is about finding the switch.
 * Where the storage is unavailable, the tip comes once a visit.
 */
export const THREE_D_TIP_STORAGE_KEY = "flown-3d-tip";

/** Listen to the map's `type` events until `signal` aborts */
function listenUntil(
  map: MapLibreMap,
  type: "movestart" | "moveend" | "zoomstart",
  listener: (event: { originalEvent?: unknown }) => void,
  signal: AbortSignal,
): void {
  const subscription = map.on(type, listener);
  signal.addEventListener("abort", () => subscription.unsubscribe(), {
    once: true,
  });
}

/**
 * The compass in the control column, and the one that floats over the map
 * on a phone, where the columns are hidden. The floating one only shows
 * while there is something to reset.
 */
const COMPASS_ID = "compass-btn";
const FLOATING_COMPASS_ID = "compass-float-btn";

/** The furthest the needle lays back, in degrees (see syncCompass) */
const COMPASS_MAX_TILT = 60;

export class MapOrientation {
  private readonly app: MapApp;
  /** Set once the style has loaded, before which no projection can be set */
  private styled: MapLibreMap | null = null;
  private globeToastShown = false;
  /**
   * The 3D view was offered (offerThreeD), switched on or off by the user,
   * or on as the visit opened, in this visit
   */
  private threeDHinted: boolean;
  /**
   * Take back what the last switch into the 3D view changed on its way
   * (toggleThreeD), whose code could not come (LayerManager.syncTerrain):
   * the altitude colours it turned on and the tilt it gave the map
   */
  undoThreeD = (): void => {};
  private readonly unsubscribe: () => void;
  /**
   * Ends the listening for the moments of the tip (listenForTip), as it is
   * offered, the user switches 3D on or off or the map goes
   */
  private readonly tipMoments = new AbortController();
  /**
   * Ends what takes the tip's toast away by itself (letTipGo), as it goes,
   * 3D comes on or the map goes
   */
  private tipToast = new AbortController();

  private readonly onTurn = (): void => this.syncCompass();

  /**
   * A flat map tilted past THREE_D_HINT_PITCH (THREE_D_HINT_TOUCH_PITCH on
   * a touch screen) by the user: a gesture, which MapLibre passes its
   * `originalEvent` along with, and none of the app's own camera moves
   * (the 3D button, Reset view, a replay, Wrapped).
   */
  private readonly onPitchEnd = (event: { originalEvent?: unknown }): void => {
    const limit = isTouchDevice()
      ? THREE_D_HINT_TOUCH_PITCH
      : THREE_D_HINT_PITCH;
    if (event.originalEvent && (this.app.map?.getPitch() ?? 0) >= limit) {
      this.offerThreeD();
    }
  };

  /**
   * A marker that went behind the globe while it had focus. Hidden like the
   * others it would drop the focus to <body>, and the arrow keys that were
   * turning the globe would stop doing anything half way; so the stylesheet
   * leaves it, faded, until the map has taken the focus. A frame later:
   * MapLibre marks the markers in the frame after a move.
   */
  private readonly onMoveEnd = (event: object): void => {
    const map = this.app.map;
    if (!map || !this.app.globeVisible || isReplayCameraMove(event)) return;
    requestAnimationFrame(() => {
      if (document.activeElement?.closest(".maplibregl-marker-covered")) {
        map.getCanvas().focus();
      }
    });
  };

  constructor(app: MapApp) {
    this.app = app;
    // A link or the saved state that opened in 3D has shown it in this
    // visit; that is no switch found, so the device keeps its tip
    this.threeDHinted = app.threeDVisible;
    // On, the 3D view needs no offer on the screen. Only the user's own
    // switch uses the offer up (toggleThreeD): the hotspot tour turns it on
    // for its flight, and puts it back after.
    this.unsubscribe = app.store.subscribe("threeDVisible", (on) => {
      if (!on) return;
      this.tipToast.abort();
      dismissToast(THREE_D_HINT_MESSAGE);
    });
    if (
      isTouchDevice() &&
      !this.threeDHinted &&
      !storedFlag(THREE_D_TIP_STORAGE_KEY)
    ) {
      this.listenForTip();
    }
    const map = app.map;
    if (!map) return;

    // `rotate` and `pitch` fire for every frame of a gesture and of an
    // animation, the app's own included
    map.on("rotate", this.onTurn);
    map.on("pitch", this.onTurn);
    map.on("moveend", this.onMoveEnd);
    map.on("pitchend", this.onPitchEnd);
    this.syncCompass();

    app.store.subscribe("globeVisible", () => this.applyProjection());
    // The projection is part of the style, so it waits for one. `mapReady`
    // resolves in the turn the data layers are added in, before the map
    // has drawn a frame with them: a link to a globe opens as one.
    onMapReady(app, "The projection", (styled) => {
      this.styled = styled;
      this.applyProjection();
    });
  }

  destroy(): void {
    this.unsubscribe();
    this.tipMoments.abort();
    this.tipToast.abort();
    const map = this.app.map;
    if (!map) return;
    map.off("rotate", this.onTurn);
    map.off("pitch", this.onTurn);
    map.off("moveend", this.onMoveEnd);
    map.off("pitchend", this.onPitchEnd);
  }

  /**
   * The tip: the offer of the 3D view on a touch screen without a tilt,
   * once on a device (THREE_D_TIP_STORAGE_KEY). A phone keeps the switch in
   * its Layers sheet, and the tilt that offers it is a gesture few make on
   * a touch screen, so the 3D view went unfound there. The tip comes at the
   * first moment of looking at the flights themselves, whichever comes
   * first, and never over the first view, which nobody has looked at yet:
   *
   * - A zoom in by hand that crosses to where the heat lines have come in
   *   (HEAT_LINES), where the flights are drawn as lines; not a zoom out,
   *   nor a pinch on a view among the lines already. Measured from where
   *   the map rested before the gesture to where it comes to rest after
   *   it, the glide of a pinch included, so the tip does not show while
   *   a pinch that turned into a pan still moves the map.
   * - One flight that comes into the selection, by whatever control: a
   *   flight tapped, picked from a list or ticked. Not the flights of an
   *   airport, whose popup the tip would cover: a click of a mouse on an
   *   airport selects them before it opens the popup (activateAirport; a
   *   tap only opens it), so the pick is weighed once that has run, and
   *   none counts with an airport's popup open, one flown to or ticked in
   *   it included, nor one ticked on the phone's statistics sheet. Nor the
   *   selection a link or the saved state brought, which is put back
   *   before this listens, nor what a load trims off it.
   *
   * Every device the map runs on can draw the 3D view, as the map itself
   * needs WebGL 2 (MapApp.setupMap). A mouse tilts with a right drag, and
   * keeps the offer of the tilt alone.
   */
  private listenForTip(): void {
    const app = this.app;
    const signal = this.tipMoments.signal;
    let before = app.selectedPathIds;
    app.store.subscribe(
      "selectedPathIds",
      (ids) => {
        let added = 0;
        for (const id of ids) if (!before.has(id)) added++;
        before = ids;
        if (added !== 1 || app.isInitializing) return;
        // Nor over the phone's statistics sheet, whose lists tick flights
        // too: the tip comes with a later pick on the map instead
        queueMicrotask(() => {
          if (
            !signal.aborted &&
            !app.airportManager.isPopupOpen() &&
            !(app.statsPanelVisible && app.mobileBar?.isVisible())
          ) {
            this.offerThreeD(true);
          }
        });
      },
      { signal },
    );
    const map = app.map;
    if (!map) return;
    let rest = map.getZoom();
    let byHand = false;
    listenUntil(
      map,
      "zoomstart",
      (event) => {
        if (event.originalEvent) byHand = true;
      },
      signal,
    );
    listenUntil(
      map,
      "moveend",
      () => {
        const from = rest;
        rest = map.getZoom();
        if (!byHand) return;
        byHand = false;
        const lines = HEAT_LINES.midZoom;
        if (!app.isInitializing && from < lines && rest >= lines) {
          this.offerThreeD(true);
        }
      },
      signal,
    );
  }

  /**
   * Take the tip's toast away after THREE_D_TIP_MS, or as soon as the map
   * is moved by hand: the user went on with the map. The status region
   * has read it out all the same (showToast). Never from under the focus:
   * while it is on the toast's buttons, a keyboard or a screen reader is
   * at them, and the time starts again once the focus has left.
   */
  private letTipGo(toast: HTMLElement): void {
    const phase = new AbortController();
    this.tipToast = phase;
    const signal = phase.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = (): void => {
      if (toast.contains(document.activeElement)) return;
      phase.abort();
      dismissToast(THREE_D_HINT_MESSAGE);
    };
    const wait = (): void => {
      clearTimeout(timer);
      timer = setTimeout(close, THREE_D_TIP_MS);
    };
    wait();
    signal.addEventListener("abort", () => clearTimeout(timer), {
      once: true,
    });
    toast.addEventListener("focusin", () => clearTimeout(timer), { signal });
    toast.addEventListener(
      "focusout",
      (event) => {
        const to = event.relatedTarget;
        if (!(to instanceof Node && toast.contains(to))) wait();
      },
      { signal },
    );
    const map = this.app.map;
    if (!map) return;
    listenUntil(
      map,
      "movestart",
      (event) => {
        if (event.originalEvent) close();
      },
      signal,
    );
  }

  /**
   * Offer the 3D view, unless it was offered or switched on in this visit,
   * or something else holds the map: a replay or Replay all, Wrapped, or
   * the hotspot tour, which turns the 3D view on by itself. The offer is a
   * toast whose 3D button does what the switch does; as the `tip` it goes
   * by itself (letTipGo). Offered, it is not the device's tip any more.
   */
  private offerThreeD(tip = false): void {
    const app = this.app;
    if (
      this.threeDHinted ||
      app.threeDVisible ||
      app.replayActive ||
      app.wrappedVisible ||
      app.tourView
    ) {
      return;
    }
    this.threeDHinted = true;
    this.usedTip();
    const toast = showToast(THREE_D_HINT_MESSAGE, "info", {
      label: "3D",
      run: () => {
        if (!app.threeDVisible) this.toggleThreeD();
      },
    });
    if (tip) this.letTipGo(toast);
  }

  /** The device has had the tip, or found the switch without it */
  private usedTip(): void {
    storeFlag(THREE_D_TIP_STORAGE_KEY, true);
    this.tipMoments.abort();
  }

  /** Turn the map north up and lay it flat, the way every view starts */
  resetNorth(): void {
    // Shortened to nothing under reduced motion by the map itself
    this.app.map?.easeTo({ bearing: 0, pitch: 0 });
  }

  toggleGlobe(): void {
    const entering = !this.app.globeVisible;
    this.app.globeVisible = entering;
    if (entering && !this.globeToastShown) {
      this.globeToastShown = true;
      showToast("Drag to spin the globe");
    }
  }

  /**
   * Lift the flights to their altitude, or put them back on the ground.
   * Lifted, they only show on a tilted map, so a flat one is tilted. The
   * layers are left as they are: the heatmap lifts as the cloud, the colour
   * layers as ribbons. Only with all three off, where nothing would be
   * lifted, the altitude colours come on.
   */
  toggleThreeD(): void {
    const entering = !this.app.threeDVisible;
    this.app.threeDVisible = entering;
    // The switch is found, also to turn off the 3D view a link or the
    // tour turned on, and needs no offer any more
    this.threeDHinted = true;
    this.usedTip();
    this.undoThreeD = () => {};
    if (!entering) return;
    const map = this.app.map;
    const lit =
      !this.app.heatmapVisible &&
      !this.app.altitudeVisible &&
      !this.app.airspeedVisible;
    if (lit) this.app.uiToggles.toggleAltitude();
    const pitch = map?.getPitch() ?? THREE_D_MIN_PITCH;
    if (pitch < THREE_D_MIN_PITCH) map!.easeTo({ pitch: THREE_D_PITCH });
    this.undoThreeD = () => {
      this.undoThreeD = () => {};
      if (lit && this.app.altitudeVisible) this.app.uiToggles.toggleAltitude();
      if (pitch < THREE_D_MIN_PITCH) map!.easeTo({ pitch });
    };
  }

  private applyProjection(): void {
    const map = this.styled;
    if (!map) return;
    const type = this.app.globeVisible ? "globe" : "mercator";
    // A style names no projection until one is set, and means Mercator
    if ((map.getProjection()?.type ?? "mercator") === type) return;
    map.setProjection({ type });
  }

  /**
   * Point the needle north and lay it back with the map. The angles go on
   * the button and the stylesheet turns the icon by them: the icon itself
   * is drawn again whenever the chrome changes size, and would lose a
   * transform of its own.
   *
   * Laid back by the full tilt, 60 degrees, a 16 px needle is half as
   * tall and a smudge. So it also grows by the square root of what the
   * tilt takes, as MapLibre's own compass does: the tilt still shows, and
   * the needle stays readable. The map tilts further (MAP_MAX_PITCH), where
   * the needle would lie flat and grow out of its button, so it stops at
   * COMPASS_MAX_TILT.
   */
  private syncCompass(): void {
    const map = this.app.map;
    if (!map) return;
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    const floating = domCache.get(FLOATING_COMPASS_ID);
    for (const button of [domCache.get(COMPASS_ID), floating]) {
      // At 0 the stylesheet draws the needle pointing up, so north is at
      // minus the bearing
      button?.style.setProperty("--compass-turn", `${-bearing}deg`);
      // Only a tilted map gets the 3D transform: even `rotateX(0deg)` has
      // the flat needle drawn a few pixels differently
      if (pitch > 0) {
        const tilt = Math.min(pitch, COMPASS_MAX_TILT);
        button?.style.setProperty("--compass-tilt", `rotateX(${tilt}deg)`);
        button?.style.setProperty(
          "--compass-grow",
          String(1 / Math.sqrt(Math.cos(tilt * DEGREES_TO_RADIANS))),
        );
      } else {
        button?.style.removeProperty("--compass-tilt");
        button?.style.removeProperty("--compass-grow");
      }
    }
    const upright = bearing === 0 && pitch === 0;
    // With nothing to reset the button in the column is shown unavailable,
    // like Share mode and Replay: still focusable, so a keyboard user who just
    // pressed it keeps their place
    const compass = domCache.get(COMPASS_ID);
    if (compass) setUnavailable(compass, upright);
    if (!floating) return;
    // The button hides once its own click has done its work. Focus would
    // fall back to <body> with it; the map is what it acted on.
    if (upright && document.activeElement === floating) map.getCanvas().focus();
    floating.hidden = upright;
  }
}
