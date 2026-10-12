/**
 * The intro of a link to shared flights: as someone opens a link that Copy
 * link handed on in share mode, the camera eases from the view the link
 * opens on to frame the shared flights, while their lines draw in one after
 * another, in the order of their files (flightOrder), as the replay of the
 * selected flights plays them (ui/replayManager.ts), but in SHARE_INTRO_MS
 * all told. It plays once: the link carries a mark
 * (SHARE_INTRO_PARAM), which the app takes off the address bar as it reads
 * it (takeShareIntro in state/urlState.ts), so neither a reload nor a link
 * copied from the address bar plays it again.
 *
 * It is not to be in the way: any input skips to its end (a Tab or a
 * modifier on its own is none, see KEYS_NOT_INPUT), and input
 * before it could start, the data and this bundle still on their way,
 * keeps it from playing at all (MapApp.initialize); under reduced
 * motion the flights are only framed, and it does not start while a replay,
 * the hotspot tour or Wrapped holds the map, nor without share mode or a
 * shared flight the filters show (shownSelection). What takes the map
 * later ends it, trails and all. It takes no focus, holds no control and
 * says nothing: the chip says what is shared, as ever.
 *
 * The trails are drawn by a player of the replay of all flights
 * (ui/replayAllPlayer.ts), whose clock the intro moves itself: no panel,
 * no replay of the map (replayActive), the trails lasting to the end, in
 * the colours of the colour layer that is on. The lines of the flights,
 * flat or as ribbons, step aside meanwhile and come back under the trails
 * at the end, which go once the map has drawn them. The heat builds up
 * behind the flights by the same clock, as in the replay of all flights
 * (growHeatCloud in ui/heatCloud.ts), and is the heatmap again at the end.
 *
 * The camera frames the flights as share mode frames them, tilted as the
 * map is (see ui/frameFlights.ts): in the 3D view a fit of their bounds
 * took no account of the tilt, and left them in the far part of the map.
 * The player cuts the curves for the zoom it is on its way to (aim): cut
 * for the zoom the link opens at, they were straight spokes until the
 * camera came to rest.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import { shownSelection } from "../calculations/datasetIndex";
import { flightClock } from "../calculations/flightClock";
import { flightOrder } from "../calculations/flightProfile";
import { segmentsForPathIds } from "../calculations/statistics";
import { INPUT_EVENTS, KEYS_NOT_INPUT } from "../utils/constants";
import { flightsCamera } from "./frameFlights";
import { growHeatCloud } from "./heatCloud";
import { whenMapComplete } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { SHARE_INTRO_LAYER } from "./replayAllLayer";
import { ReplayAllPlayer } from "./replayAllPlayer";

/** How long the intro draws the flights in, all of them together (ms) */
export const SHARE_INTRO_MS = 5000;

/**
 * The least of the intro a flight is drawn in (ms), so that a short hop
 * next to a long trip is still seen being drawn; split evenly where the
 * flights are too many for each to have it
 */
export const SHARE_INTRO_LEAST_MS = 600;

/** How long the camera takes to frame the flights (ms) */
const CAMERA_MS = 2000;

/**
 * The milliseconds of the intro, `total`, each flight is drawn in, by the
 * seconds each takes, `durations`: each SHARE_INTRO_LEAST_MS, or an even
 * share where that is more than there is, and the rest by its seconds
 */
export function introShares(
  durations: readonly number[],
  total = SHARE_INTRO_MS,
): number[] {
  const count = durations.length;
  const seconds = durations.reduce((sum, d) => sum + d, 0);
  const least = Math.min(SHARE_INTRO_LEAST_MS, total / count);
  const rest = total - least * count;
  return durations.map(
    (d) => least + (seconds > 0 ? (rest * d) / seconds : rest / count),
  );
}

/**
 * The time on the clock of a run played one after another, `legs` (each
 * flight with where it starts, see sequenceStarts), that is `ms` into the
 * intro, with no pause between the flights: each is drawn along its own
 * clock, whose seconds `durations` gives, in its share of the intro
 * (introShares), and the last has landed by `total`
 */
export function introTime(
  legs: ReadonlyMap<number, number>,
  durations: ReadonlyMap<number, number>,
  ms: number,
  total = SHARE_INTRO_MS,
): number {
  const seconds = [...legs.keys()].map((pathId) => durations.get(pathId) ?? 0);
  const shares = introShares(seconds, total);
  let time = 0;
  let i = 0;
  // `ms` counts down through the shares of the flights before
  for (const start of legs.values()) {
    if (ms > 0) time = start + seconds[i]! * Math.min(ms / shares[i]!, 1);
    ms -= shares[i++]!;
  }
  return time;
}

/**
 * Hide the lines of the flights, the selection's and the colour layers',
 * flat and as ribbons; or, with `shown`, give them back what the store had
 * them at, which their handles keep (see MapLayerHandle)
 */
function showLines(app: MapApp, map: MapLibreMap, shown: boolean): void {
  for (const handle of [
    app.selectionHighlightLayer,
    app.altitudeLayer,
    app.airspeedLayer,
  ]) {
    if (shown) {
      handle.setVisible(handle.isVisible());
      continue;
    }
    for (const id of handle.ids) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
    }
  }
}

/**
 * Play the intro of the shared flights of `app` (see above), unless it is
 * not to play: then the map stays as the link opened it
 */
export function playShareIntro(app: MapApp): void {
  const map = app.map;
  const data = app.currentData;
  const shown = shownSelection(app);
  if (
    !map ||
    !data ||
    !app.isolateSelection ||
    shown.size === 0 ||
    app.mapHeld ||
    app.signal.aborted
  ) {
    return;
  }
  // As the selection is framed, the tilt and the bearing kept
  const theirs = segmentsForPathIds(data.path_segments, shown);
  const camera = flightsCamera(map, theirs);
  if (!camera) return;
  if (prefersReducedMotion()) {
    map.jumpTo(camera);
    return;
  }
  const player = new ReplayAllPlayer(app, SHARE_INTRO_LAYER);
  void player.start({
    pathIds: flightOrder(data.path_info, shown),
    sequence: true,
    lasting: true,
    colour: true,
  });
  map.easeTo({ ...camera, duration: CAMERA_MS });
  // None of them has a clock to be drawn along
  const legs = player.legs;
  if (!legs) return;
  player.aim(camera.zoom, true);
  player.pause();
  growHeatCloud(app, player, camera.zoom);
  // Of the shared flights alone, not of every flight of the dataset
  const durations = flightClock(theirs).duration;
  let begun: number | null = null;
  let frame = 0;
  let over = false;
  const input = new AbortController();

  /**
   * To the end: every flight drawn and their lines back, and when it is
   * `skipped` the camera where it was going, before the gesture that
   * skipped it moves it
   */
  const finish = (skipped = false): void => {
    if (over) return;
    over = true;
    cancelAnimationFrame(frame);
    if (skipped && map.isMoving()) map.jumpTo(camera);
    player.seek(player.duration);
    showLines(app, map, true);
    growHeatCloud(app, null);
    // Their tiles are made anew as they show again, and until the map has
    // drawn them the trails stand in for them
    map.once("render", () => {
      void whenMapComplete(map, () => true).then(stop);
    });
  };
  /** The trails gone, and no frame or listener left (with the app too) */
  const stop = (): void => {
    over = true;
    cancelAnimationFrame(frame);
    input.abort();
    player.stop();
  };
  // Input skips to the end. The trails stay until the lines are drawn
  // again, also for the rest of the gesture that skipped it (a tap is a
  // pointerdown and a touchstart, a wheel turn many wheels): a replay, the
  // tour or Wrapped it opens takes them away below
  for (const type of INPUT_EVENTS) {
    window.addEventListener(
      type,
      (event) =>
        KEYS_NOT_INPUT.has((event as KeyboardEvent).key) || finish(true),
      { capture: true, passive: true, signal: input.signal },
    );
  }
  app.signal.addEventListener("abort", stop, { signal: input.signal });
  // A replay, the tour or Wrapped, which the app may open as the input
  // that skipped it goes on: to the end, and the trails gone at once, as
  // they would stand over what that draws until the lines are in
  app.store.subscribeKeys(
    ["replayActive", "wrappedVisible", "tourView"],
    () => {
      if (!app.mapHeld) return;
      finish();
      stop();
    },
    { signal: input.signal },
  );

  // From the first frame on: a link opened in a tab of the background
  // draws nothing until it is looked at
  const tick = (now: number): void => {
    begun ??= now;
    const ms = now - begun;
    // Or stopped by another dataset, or its shaders failed
    if (ms >= SHARE_INTRO_MS || !player.active) {
      finish();
      return;
    }
    // Again on every frame: the store shows them again as it sees fit
    showLines(app, map, false);
    player.seek(introTime(legs, durations, ms));
    frame = requestAnimationFrame(tick);
  };
  showLines(app, map, false);
  player.seek(0);
  frame = requestAnimationFrame(tick);
}
