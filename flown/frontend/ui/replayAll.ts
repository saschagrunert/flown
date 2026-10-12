/**
 * Replay of all flights: every flight the filters keep starts from its own
 * first fix at once and plays at a hundred to a thousand times its speed,
 * each a bright head with a trail fading behind it at its height, so the
 * year blooms out of the home field, in the colours of the colour layer
 * that is on as it opens, if one is. The only clock is the one each flight
 * carries (see calculations/flightClock.ts): the panel reads "0:42 into
 * every flight", and its slider moves along the same clock, never a date
 * or an hour.
 *
 * ReplayAllPlayer (ui/replayAllPlayer.ts) plays and draws
 * (ui/replayAllLayer.ts), and nothing else:
 * Wrapped's intro plays it under its own camera. ReplayAllControls is the
 * "Replay all" control and its panel: it runs the player as a replay of the
 * map (replayActive), which hides the heatmap and the colour layers and
 * holds the selection, the filters and Wrapped as the replay of one flight
 * does, fits the camera to the flights north up, tilted as the 3D view
 * tilts it, and turns it slowly round them on request. The heat builds up
 * behind the flights instead of the heatmap, as far as the clock has come
 * (see ReplayAllControls.time) and at the height of the flights, unless the
 * Heatmap switch is off.
 *
 * A selection of several flights plays one after another in the replay of
 * one flight (ui/replayManager.ts), not here.
 */
import type { MapApp } from "../mapApp";
import { pluralFlights } from "../utils/htmlGenerators";
import { MAP_MAX_ZOOM } from "../utils/constants";
import { applyToggleButtonState } from "../utils/buttonState";
import {
  focusModeControl,
  focusWasIn,
  holdControls,
  REPLAY_HELD_CONTROL_IDS,
} from "./heldControls";
import { domCache } from "../utils/domCache";
import { setControlIcon } from "../utils/icons";
import { FIELDS, isPageEscape } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { announceInRegion, announceStatus, showToast } from "../utils/toast";
import { nameButton } from "./crossSectionElements";
import { followPanelHeight } from "./replayManager";
import { featurePart } from "./lazyBundles";
import { restingPitch } from "./replayState";
import { mapChromePadding } from "./pathSelection";
import { fitCamera } from "./frameFlights";
import { REPLAY_ALL_SPEED, ReplayAllPlayer } from "./replayAllPlayer";

/** The speeds the panel offers, in seconds of flight per second */
const REPLAY_ALL_SPEEDS = [100, 200, 300, 500, 1000] as const;

/** Said when the filters keep no flight with a clock to play by */
export const REPLAY_ALL_NOTHING_MESSAGE =
  "No flight in this view has timing or speed data to replay";

/** Said when the layer's shaders did not work in the map's context */
export const REPLAY_ALL_UNAVAILABLE_MESSAGE =
  "The replay of all flights cannot be drawn in this browser";

/** Why the orbit does not start with reduced motion on */
export const REPLAY_ALL_ORBIT_REDUCED_MOTION_MESSAGE =
  "The orbit turns the map, so it stays off while reduced motion is on";

/**
 * Controls held while every flight replays, as for the replay of one
 * (REPLAY_DISABLED_CONTROL_IDS in ui/replayManager.ts): the filters, the
 * selection and Wrapped would change or take the map under it. The colour
 * layers too, whose colours the trails are drawn in as the replay opens,
 * and the Heatmap switch, which says as the replay opens whether the heat
 * builds up behind the flights.
 */
const HELD_CONTROL_IDS = [
  ...REPLAY_HELD_CONTROL_IDS,
  "altitude-btn",
  "airspeed-btn",
  "replay-btn",
];

/** The control that opens and closes the replay of all flights */
const REPLAY_ALL_BUTTON_ID = "replay-all-btn";

/**
 * The tilt a flatter map is turned to while the flights play at their
 * height, and what is flat enough to need it: those of the 3D view
 * (THREE_D_PITCH and THREE_D_MIN_PITCH in ui/mapOrientation.ts). Written
 * out rather than shared: two more exports of the shared chunk cost every
 * bundle that imports from it some bytes for nothing to share.
 */
const TILT_PITCH = 50;
const TILT_MIN_PITCH = 20;

/**
 * Degrees a gesture has to tilt the map by to be a tilt of the user's: a
 * right drag that turns the map tilts it by as much as the pointer strays
 * up or down, a degree for every two pixels
 */
const TILT_BY_HAND_DEG = 5;

/** Pixels kept free between the flights and the panel below them */
const FIT_MARGIN_PX = 24;

/**
 * The seconds of flight a step of the slider moves the clock by, with the
 * arrow keys: a minute, a third of a second at 200 times
 */
const SLIDER_STEP_S = 60;

/** "0:42 into every flight": hours and minutes into every flight */
export function replayAllClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return `${hours}:${String(minutes % 60).padStart(2, "0")} into every flight`;
}

/** An icon-only button of the panel, named by its title */
function panelButton(id: string, iconName: "play" | "reset" | "close") {
  const button = document.createElement("button");
  button.type = "button";
  button.id = id;
  button.className = "btn-surface replay-btn";
  setControlIcon(button, iconName, 20);
  return button;
}

/**
 * The "Replay all" control and its panel: play and pause, the clock and
 * its slider, the speed, the orbit and the way out
 */
export class ReplayAllControls {
  readonly player: ReplayAllPlayer;
  private readonly app: MapApp;
  private panel: HTMLElement | null = null;
  /** The parts of the panel every frame writes, found as it is built */
  private playButton: HTMLElement | null = null;
  private clock: HTMLElement | null = null;
  private slider: HTMLInputElement | null = null;
  private open = false;
  /** The clock as last written, so a frame writes it only when it changes */
  private shown = "";
  private stopWatchingUser: (() => void) | null = null;
  /** Gives the held controls back as they were (see holdControls) */
  private release: (() => void) | null = null;
  /** Ends followPanelHeight of the open panel */
  private unfollowPanel: (() => void) | null = null;

  constructor(app: MapApp) {
    this.app = app;
    this.player = new ReplayAllPlayer(app);
    this.player.onChange = () => this.sync();
    // Each play-through, also from the start again after the end
    this.player.onLanded = () => {
      if (this.open) this.announce("Every flight has landed");
    };
    // Escape leaves it, as it leaves the replay of one flight; not from the
    // speed picker, whose own list it closes, nor from a text field, nor
    // from a popup or a marker
    document.addEventListener(
      "keydown",
      (event) => {
        if (!this.open || !isPageEscape(event, FIELDS)) return;
        event.preventDefault();
        this.close();
      },
      { signal: app.signal },
    );
  }

  /** Whether it is open */
  get isOpen(): boolean {
    return this.open;
  }

  /**
   * The seconds into every flight while it is open, which the heat is
   * drawn up to (see ui/heatCloud.ts), and null otherwise: Wrapped's intro
   * plays its own player under the whole year
   */
  get time(): number | null {
    return this.open ? this.player.time : null;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  /** Start every flight the filters keep, and hold the rest of the page */
  show(): void {
    const app = this.app;
    const map = app.map;
    // Not while another has the map, the hotspot tour among them: its
    // control is held then, and this covers a click whose bundle came late
    if (this.open || !map || app.mapHeld) return;
    const panel = this.panelOf();
    const speed = Number(
      panel.querySelector<HTMLSelectElement>("select")?.value,
    );
    void this.player.start({ speed, colour: true });
    if (this.player.flights === 0) {
      if (this.player.unavailable) {
        showToast(REPLAY_ALL_UNAVAILABLE_MESSAGE, "error");
      } else showToast(REPLAY_ALL_NOTHING_MESSAGE, "info");
      return;
    }
    // A popup left open on the map, a tapped flight's or an airport's,
    // would stay over the replay, as for the replay of one flight
    // (ReplayManager): before replayActive, which a popup closing reads
    app.airportManager.closePopup();
    app.layerManager.closeSegmentPopup();
    this.open = true;
    const slider = this.slider!;
    slider.max = String(
      Math.ceil(this.player.duration / SLIDER_STEP_S) * SLIDER_STEP_S,
    );
    this.setOrbit(false);
    app.replayState.all = true;
    app.replayActive = true;
    this.release?.();
    this.release = holdControls(
      HELD_CONTROL_IDS,
      "the replay of all flights",
      this.app.signal,
    );
    document.body.classList.add("replay-all-active");
    panel.hidden = false;
    this.shown = "";
    this.sync();
    // The toasts stack above the panel (see features.css), measured with
    // its clock, which on a phone takes a row of its own
    this.unfollowPanel?.();
    this.unfollowPanel = followPanelHeight(panel, this.app.signal);
    const button = domCache.get(REPLAY_ALL_BUTTON_ID);
    if (button) {
      setControlIcon(button, "stop");
      applyToggleButtonState(button, true);
    }
    panel.querySelector<HTMLElement>("button")?.focus();

    // The flights fly at their height, which a map seen from straight
    // above does not show: a flatter one is tilted as the 3D view tilts
    // it, and laid back as the replay closes
    const pitch = restingPitch(app);
    const before = pitch < TILT_MIN_PITCH ? pitch : null;
    app.replayState.pitchBefore = before;
    const fit = this.fit(before === null ? pitch : TILT_PITCH, panel);
    if (fit) {
      const { flat, ...camera } = fit;
      map.easeTo({
        ...camera,
        animate: !prefersReducedMotion(),
      });
      this.player.thinOut(camera.zoom - flat);
    }
    // A camera the user moves is theirs: the orbit stops turning it, and
    // a tilt of theirs stays as they leave it, as does the 3D view's
    type UserEvent = { originalEvent?: unknown };
    const moved = map.on("movestart", (event: UserEvent) => {
      if (event.originalEvent && this.player.orbit) this.setOrbit(false);
    });
    let from = 0;
    const tilting = map.on("pitchstart", () => {
      from = map.getPitch();
    });
    const tilted = map.on("pitchend", (event: UserEvent) => {
      if (
        event.originalEvent &&
        Math.abs(map.getPitch() - from) > TILT_BY_HAND_DEG
      ) {
        app.replayState.pitchBefore = null;
      }
    });
    const threeD = app.store.subscribe("threeDVisible", (on) => {
      if (on) app.replayState.pitchBefore = null;
    });
    this.stopWatchingUser = () => {
      moved.unsubscribe();
      tilting.unsubscribe();
      tilted.unsubscribe();
      threeD();
    };
    announceStatus(
      `Replaying ${pluralFlights(this.player.flights)} at ${this.player.speed} times their speed`,
    );
  }

  /** Stop, and give the page back as it was */
  close(): void {
    if (!this.open) return;
    this.open = false;
    const hadFocus = focusWasIn(this.panel);
    this.stopWatchingUser?.();
    this.stopWatchingUser = null;
    this.player.stop();
    if (this.panel) this.panel.hidden = true;
    this.unfollowPanel?.();
    this.unfollowPanel = null;
    document.body.classList.remove("replay-all-active");
    const button = domCache.get(REPLAY_ALL_BUTTON_ID);
    if (button) {
      setControlIcon(button, "play");
      applyToggleButtonState(button, false);
    }
    this.release?.();
    this.release = null;
    this.app.replayState.all = false;
    // The layers come back as they were, and the phone's bar with them
    this.app.replayActive = false;
    // As flat as it was, unless the user or the 3D view took the tilt over
    const state = this.app.replayState;
    const pitch = state.pitchBefore;
    const map = this.app.map;
    state.pitchBefore = null;
    if (pitch !== null && map) {
      map.easeTo({ pitch });
      // Until the map gets there: a tilt the user gives it later is theirs
      // (see restingPitch). Registered after the ease, whose start ends the
      // move before it.
      state.layingBack = pitch;
      map.once("moveend", () => {
        state.layingBack = null;
      });
    }
    if (hadFocus) focusModeControl(this.app, REPLAY_ALL_BUTTON_ID);
    announceStatus("Replay of all flights closed");
  }

  /**
   * Where the camera shows the flights of the run as large as the map
   * allows, north up and tilted by `pitch`: clear of the panels along its
   * edges (mapChromePadding) and of the replay's own, `panel`, below them.
   * The fit of their bounds is where it starts from (see fitCamera), and
   * its zoom, `flat`, the one of a flat map.
   */
  private fit(pitch: number, panel: HTMLElement) {
    const map = this.app.map!;
    const run = this.player.run;
    const bounds = run?.bounds;
    if (!run || !bounds) return null;
    const box = map.getContainer().getBoundingClientRect();
    const padding = mapChromePadding(map);
    padding.bottom = Math.max(
      padding.bottom,
      box.bottom - panel.getBoundingClientRect().top + FIT_MARGIN_PX,
    );
    const camera = fitCamera(
      map,
      run,
      [
        [bounds[0], bounds[1]],
        [bounds[2], bounds[3]],
      ],
      padding,
      pitch,
      0,
      MAP_MAX_ZOOM,
    );
    return camera && { ...camera, pitch };
  }

  private setOrbit(on: boolean): void {
    this.player.orbit = on;
    const button = this.panel?.querySelector<HTMLElement>(
      "#replay-all-orbit-btn",
    );
    if (button) applyToggleButtonState(button, on);
  }

  /** The panel as the player stands: stopped from elsewhere, it closes */
  private sync(): void {
    const panel = this.panel;
    if (!panel || !this.open) return;
    const player = this.player;
    if (!player.active) {
      this.close();
      // Its shaders failed in the first frame of this run: said now, and
      // not only at the next click, which finds the player unavailable
      if (player.unavailable) {
        showToast(REPLAY_ALL_UNAVAILABLE_MESSAGE, "error");
      }
      return;
    }
    const play = this.playButton;
    if (play && play.dataset["icon"] !== (player.playing ? "pause" : "play")) {
      setControlIcon(play, player.playing ? "pause" : "play");
      nameButton(
        play,
        player.playing
          ? "Pause the replay of all flights"
          : "Play the replay of all flights",
      );
    }
    const time = Math.min(player.time, player.duration);
    const slider = this.slider!;
    slider.value = String(time);
    const text = replayAllClock(time);
    if (text !== this.shown) {
      this.shown = text;
      if (this.clock) this.clock.textContent = text;
      slider.setAttribute("aria-valuetext", text);
    }
  }

  private announce(message: string): void {
    const live = this.panel?.querySelector<HTMLElement>("#replay-all-live");
    if (live) announceInRegion(live, message);
  }

  /** The panel, built the first time it is opened */
  private panelOf(): HTMLElement {
    if (this.panel) return this.panel;
    const panel = document.createElement("div");
    panel.id = "replay-all-controls";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Replay of all flights");
    panel.hidden = true;

    const play = panelButton("replay-all-play-btn", "play");
    play.addEventListener("click", () => {
      if (this.player.playing) {
        this.player.pause();
        this.announce("Paused");
      } else {
        this.player.resume();
        this.announce("Playing");
      }
    });

    this.playButton = play;
    const clock = document.createElement("div");
    clock.id = "replay-all-clock";
    this.clock = clock;

    // The clock as a slider: a drag holds it where the thumb is, and lets
    // it play on as the pointer lets go if it played; a click jumps, and
    // the keys step a minute, Home and End to either end
    const slider = document.createElement("input");
    slider.type = "range";
    slider.id = "replay-all-time";
    slider.min = "0";
    slider.step = String(SLIDER_STEP_S);
    slider.setAttribute("aria-label", "Time into every flight");
    slider.addEventListener("input", () => {
      this.player.seek(Number(slider.value));
    });
    slider.addEventListener("pointerdown", () => {
      if (!this.player.playing) return;
      this.player.pause();
      // Not from the end, where it would start again from the first
      // flight: a drag or a click there stays with it, paused. Before it,
      // every flight plays on from there while the trails fade.
      const letGo = (): void => {
        removeEventListener("pointerup", letGo);
        removeEventListener("pointercancel", letGo);
        if (this.open && !this.player.finished) this.player.resume();
      };
      addEventListener("pointerup", letGo);
      addEventListener("pointercancel", letGo);
    });
    this.slider = slider;

    const speed = document.createElement("select");
    speed.id = "replay-all-speed";
    speed.className = "btn-surface replay-btn";
    speed.setAttribute("aria-label", "Replay speed multiplier");
    for (const value of REPLAY_ALL_SPEEDS) {
      speed.add(new Option(`${value}x`, String(value)));
    }
    speed.value = String(REPLAY_ALL_SPEED);
    speed.addEventListener("change", () => {
      this.player.speed = Number(speed.value);
    });

    // Not disabled under reduced motion, which is asked as it is pressed:
    // a press says why, as the chase view's does
    const orbit = panelButton("replay-all-orbit-btn", "reset");
    nameButton(orbit, "Orbit: turn the map slowly round the flights");
    orbit.setAttribute("aria-pressed", "false");
    orbit.addEventListener("click", () => {
      if (!this.player.orbit && prefersReducedMotion()) {
        showToast(REPLAY_ALL_ORBIT_REDUCED_MOTION_MESSAGE, "info");
        return;
      }
      this.setOrbit(!this.player.orbit);
    });

    const exit = panelButton("replay-all-close-btn", "close");
    nameButton(exit, "Close the replay of all flights");
    exit.addEventListener("click", () => this.close());

    const live = document.createElement("div");
    live.id = "replay-all-live";
    live.className = "visually-hidden";
    live.setAttribute("aria-live", "polite");
    live.setAttribute("aria-atomic", "true");

    panel.append(play, clock, slider, speed, orbit, exit, live);
    document.body.append(panel);
    this.panel = panel;
    return panel;
  }
}

/** Open or close the replay of all flights of `app`, made the first time */
export function toggleReplayAll(app: MapApp): void {
  featurePart(app, "replayAll", () => new ReplayAllControls(app)).toggle();
}
