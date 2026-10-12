/**
 * Wrapped's intro - the camera flies in over the year before the cards
 *
 * Opened from its button, Wrapped starts on the globe, far out, with the
 * map filling the dialog under a light shade and the title of the first
 * card over it (wrapped.css), which is what shows while the tiles of the
 * globe come in. The shade and the title lift as the camera flies towards
 * the home base, tilting on the way down and turning slowly once there,
 * while every flight of the overview plays underneath at a few hundred
 * times its speed and at a larger size, so the year blooms out of home
 * (ReplayAllPlayer, ui/replayAllPlayer.ts). It comes down only a couple of zoom
 * levels closer than the overview (HOME), where the shape of the whole
 * year shows around home. Then it settles on the overview Wrapped has
 * always shown, the flights stop, and the cards come in one after another
 * as the map draws back into its panel beside them, or, stacked, fades
 * from over them (see settle). About ten seconds, paced so that each step
 * can be taken in: the title stays for two seconds of the flight before it
 * lifts (wrapped.css), and the cards come in slowly enough to read. It was
 * six, where the title was gone within a second of the globe showing.
 * Skip, or a touch of the map, ends it at once with Wrapped as it opens
 * without it: not under reduced motion, nor when the heat cloud's code
 * does not arrive in time (INTRO_WAIT_MS).
 *
 * The cloud is drawn without switching the 3D view on (forcedHeatCloud),
 * over the globe; both go as the intro ends, however it ends, and the map
 * beside the cards shows the flat heatmap, which MapLibre draws anew at
 * every zoom of a flight to a destination. Neither reaches the link or the
 * saved state, which keep the user's switches while Wrapped holds the
 * user's view (StateManager.saveMapState).
 *
 * The flight and the turn carry REPLAY_CAMERA_MOVE, so what the app does
 * as the map comes to rest waits for the settle, which does not: the
 * ribbons of the 3D view, the relief level of the cloud, the saved view.
 * They are the moves of ui/cameraScript.ts, which the hotspot tour makes
 * too, from the feature bundle the intro waits for anyway.
 */
import type {
  FitBoundsOptions,
  LngLatBoundsLike,
  Map as MapLibreMap,
} from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { FeatureModule } from "../features";
import type { CameraStop } from "./cameraScript";
import type { ReplayAllPlayer } from "./replayAllPlayer";
import { datasetIndex } from "../calculations/datasetIndex";
import { ribbonWidthZoom } from "../calculations/liftZoom";
import { loadFeatures } from "../services/featureLoader";
import { featurePart } from "./lazyBundles";
import { domCache } from "../utils/domCache";
import { logError } from "../utils/logger";
import { segmentBounds, type Coordinate } from "../utils/geometry";
import { REPLAY_CAMERA_MOVE, toBounds, toLngLat } from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { whenIdle } from "../utils/whenIdle";

/** Padding in pixels around the data when the dialog fits the map to it */
export const FIT_PADDING = 80;

/** A view of the map without padding (see overviewIn) */
const NO_PADDING = { top: 0, right: 0, bottom: 0, left: 0 };

/**
 * Where the intro opens: the globe whole in the dialog, turned so the home
 * base comes up from the south west as the camera flies in
 */
const FAR = { zoom: 1.2, west: 50, south: 15 };

/**
 * How the camera comes down over the home base: this many zoom levels
 * closer than the overview it settles on, and no closer than the last of
 * these, tilted and turned. It came down to zoom 9, tilted to 60 degrees,
 * where the home field filled the view: the glows of its circuits ran into
 * each other, the shadow of the cloud lay across it in grey bands, the
 * flights playing were too small to tell, and the cloud, which is cut for
 * the overview (see begin), drew the hours spent over the field as a
 * hard-edged white polygon: the few stretches the circuits and the
 * taxiing are merged into at the zoom level of the overview, each lit
 * evenly along its length, were drawn five levels closer, where each is a
 * hundred pixels long and glows far past white up to the joins with the
 * next. Two levels closer the routes out of home show whole, the cloud
 * keeps its look, and the settle has as far to go on every screen and for
 * every year.
 */
const HOME = { above: 2, most: 9, pitch: 45, bearing: -15 };

/** How far the camera turns once over the home base, in degrees */
const TURN_DEG = 18;

/**
 * The steps of the intro, in milliseconds. The settle outlasts the cards
 * coming in, all in by 2.5 s (wrapped.css).
 */
export const INTRO_FLY_MS = 4200;
export const INTRO_TURN_MS = 2400;
export const INTRO_SETTLE_MS = 3000;

/**
 * Longest the intro waits for the heat cloud's code once the map is in the
 * dialog. It is fetched as the Wrapped button is pointed at or focused
 * (prepareWrappedIntro), so this is for a click that came first on a slow
 * line: rather than hold the dialog, Wrapped opens without its intro.
 */
export const INTRO_WAIT_MS = 1000;

/**
 * How long the pointer rests on a destination before the map flies there,
 * or off the list before it flies back: a pointer on its way through the
 * list does not send the map along every row it crosses
 */
const DESTINATION_HOVER_MS = 250;

/** The map zoom a destination is shown at */
const DESTINATION_ZOOM = 10;

/** How much faster than real time replay-all plays under the intro */
const INTRO_REPLAY_SPEED = 300;

/**
 * How many times their size its flights are drawn (ReplayAllRun.scale): at
 * their own, over the view of a whole year, they were specks
 */
const INTRO_REPLAY_SCALE = 1.8;

/**
 * Step 3 of the storyboard: the flights of the overview start to play from
 * their first second, all at once, at INTRO_REPLAY_SPEED times real speed,
 * as the camera sets off for the home base at the map zoom `zoom`, so they
 * bloom out of it underneath; the intro stops them as the cards come in,
 * is skipped or is closed. The player changes nothing of the app: no
 * replay of the map (replayActive), no filter, no link. Returns what stops
 * it, or null when nothing plays: a replay of the map runs already
 * (Wrapped does not open then, and the two would share the map), motion is
 * unwelcome, or no flight of the overview has a clock to play by.
 */
function startIntroReplay(
  app: MapApp,
  features: FeatureModule,
  zoom: number,
): ReplayAllPlayer | null {
  const data = app.currentData;
  if (!data || app.replayActive || prefersReducedMotion()) return null;
  // Made the first time the intro plays and kept for the next: it listens
  // to the map for as long as the app lives
  const player = featurePart(
    app,
    "wrappedIntro",
    () => new features.ReplayAllPlayer(app),
  );
  const { pathIds } = datasetIndex(data).filter(
    app.selectedYear,
    app.selectedAircraft,
  );
  // Cut ahead for the view over home the camera flies to, as well as for
  // the far one it sets off from (see ReplayAllRun.zoom). Settles as the
  // last flight lands or the intro stops it: nothing waits.
  void player.start({
    pathIds,
    speed: INTRO_REPLAY_SPEED,
    zoom,
    scale: INTRO_REPLAY_SCALE,
  });
  return player.active ? player : null;
}

/**
 * What the dialog fits the map to: the flights it describes. The exported
 * bounds cover the whole dataset, so a single year or aircraft used to be
 * shown as a speck in the middle of every flight ever made.
 */
export function overviewBounds(app: MapApp): LngLatBoundsLike {
  const { selectedYear, selectedAircraft, currentData } = app;
  if ((selectedYear === "all" && selectedAircraft === "all") || !currentData) {
    return toBounds(app.config.bounds);
  }
  const view = datasetIndex(currentData).filter(selectedYear, selectedAircraft);
  return toBounds(segmentBounds(view.segments()) ?? app.config.bounds);
}

/**
 * Get the intro ready ahead of the click: the heat cloud's code, and its
 * points for the overview. They took 50 to 90 ms per level of relief for
 * two years of flights, which the first frames of the intro would stall
 * on, and they are cut once the page has a moment rather than in the
 * pointer's event, one level at a time: 99 to 152 ms there held up
 * whatever the pointer did next. A dialog open by then cuts them itself.
 * The overview fits the dialog's map panel, narrower than the page's map,
 * so its zoom level is the page's or one less.
 */
export function prepareWrappedIntro(app: MapApp): void {
  const map = app.map;
  if (
    !map ||
    !app.currentData ||
    app.wrappedVisible ||
    app.replayActive ||
    prefersReducedMotion()
  ) {
    return;
  }
  loadFeatures()
    .then((features) => {
      if (!features || app.signal.aborted) return;
      features.followHeatCloud(app);
      const camera = map.cameraForBounds(overviewBounds(app), {
        padding: FIT_PADDING,
      });
      if (!camera?.zoom) return;
      // The whole zoom level, which the cloud is cut for (see cloudDetail
      // in ui/heatCloud.ts)
      const zoom = ribbonWidthZoom(camera.zoom);
      whenIdle(() => {
        if (app.wrappedVisible || app.signal.aborted) return;
        features.prepareHeatCloud(app, [zoom]);
        // The other one in a task of its own, as the pointer may be on its
        // way
        whenIdle(() => {
          if (app.wrappedVisible || app.signal.aborted) return;
          features.prepareHeatCloud(app, [Math.max(zoom - 1, 0), zoom]);
        });
      });
    })
    .catch(logError);
}

/** Where the camera comes to rest after the intro, and how it gets there */
export interface IntroOverview {
  bounds: LngLatBoundsLike;
  options: FitBoundsOptions;
}

/**
 * One playing of the intro, made as the dialog opens. `begin` sets the
 * scene once the map is in the dialog and measured, and says whether the
 * intro plays; `fly` starts the camera once the far view is drawn. `skip`
 * ends it with Wrapped as it opens without it, `stop` where it is, for a
 * close, the settle included.
 */
export interface WrappedIntro {
  begin(): Promise<boolean>;
  fly(): void;
  skip(): void;
  stop(): void;
}

/**
 * Where the intro is: flying and turning over home, settling on the
 * overview as the cards come in, or over (null)
 */
type IntroPhase = "intro" | "settle" | null;

/**
 * The dialog in each phase of the intro (wrapped.css): while it plays the
 * map over the whole dialog, shaded and titled until the camera sets off,
 * the cards held back, and the Skip button; while it settles the cards
 * coming in and the map drawing back into its panel
 */
function showIntroChrome(phase: IntroPhase): void {
  const modal = domCache.get("wrapped-modal");
  const playing = phase === "intro";
  modal?.classList.toggle("is-intro", playing);
  modal?.classList.toggle("is-settling", phase === "settle");
  domCache.get("wrapped-map-container")?.classList.toggle("is-dark", playing);
  // Held back under the map, the cards are out of the tab order as well:
  // side by side they are only see-through, not gone
  domCache.get("wrapped-cards-column")?.toggleAttribute("inert", playing);
  const skip = domCache.get("wrapped-skip-btn");
  if (!skip) return;
  // A button that hides drops its focus to <body>
  if (!playing && document.activeElement === skip) {
    modal?.querySelector<HTMLElement>(".close-btn")?.focus();
  }
  skip.hidden = !playing;
}

/**
 * How much of the map's width, from its left edge, the cards take once
 * they are in: side by side, their column and the gap beside it, which
 * the map covers while the intro plays. Stacked, none: the column is not
 * laid out while the map has the dialog to itself, which is when this is
 * asked, and the map's panel is below the cards after.
 */
function cardsRoom(): number {
  const column = domCache.get("wrapped-cards-column");
  const content = domCache.get("wrapped-content");
  if (!column?.offsetWidth || !content) return 0;
  return (
    column.offsetWidth + (parseFloat(getComputedStyle(content).columnGap) || 0)
  );
}

/**
 * Start the intro for a dialog that has just opened: `home` is where the
 * camera flies, `overview` where it comes to rest, and `onEnd` is told
 * once, however it ends: once the map has settled in its panel, or at a
 * skip or a close.
 */
export function startWrappedIntro(
  app: MapApp,
  home: Coordinate,
  overview: IntroOverview,
  onEnd: () => void,
): WrappedIntro {
  let phase: IntroPhase = "intro";
  /** The feature bundle, once `begin` has it */
  let features: FeatureModule | null = null;
  /** Where the camera comes down over home, once `begin` knows */
  let over: CameraStop | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let replay: ReplayAllPlayer | null = null;
  /** Takes the listeners for a touch of the map off again */
  const listening = new AbortController();
  /** The globe switch as the intro found it, for a skip to put back */
  const globeBefore = app.globeVisible;
  const loading = loadFeatures()
    .then((module) => {
      module?.followHeatCloud(app);
      return module;
    })
    // Wrapped opens without its intro, as it does when the code is late
    .catch((error: unknown) => {
      logError(error);
      return null;
    });

  const fit = (options: FitBoundsOptions): void => {
    app.map?.fitBounds(overview.bounds, { ...overview.options, ...options });
  };
  /**
   * The camera of the overview as the map's panel will show it, north up
   * and flat, where side by side the cards take `room` pixels of the map
   * on its left (cardsRoom): fitted with the map's view padded by that
   * much, which moves the middle of its perspective to the middle of the
   * panel's part. Fitted with the room as a padding of the fit alone, the
   * globe was seen from off to the side there and fitted a little closer,
   * and the map jumped as it took its panel. The padding is put back at
   * once, before a frame is drawn, and tagged, as no view to come to rest
   * at.
   */
  const overviewIn = (map: MapLibreMap, room: number) => {
    map.setPadding({ ...NO_PADDING, left: room }, REPLAY_CAMERA_MOVE);
    const camera = map.cameraForBounds(overview.bounds, {
      padding: FIT_PADDING,
      bearing: 0,
    });
    map.setPadding(NO_PADDING, REPLAY_CAMERA_MOVE);
    return camera && { ...camera, pitch: 0 };
  };
  const after = (ms: number, step: () => void): void => {
    timer = setTimeout(step, ms);
  };
  /**
   * Over, however it ends: the camera stops where it is, and the map's
   * view loses the cards' padding (see settle), whether the map is fitted
   * in its panel next or goes back to the page
   */
  const end = (): void => {
    const map = app.map;
    map?.stop();
    if (phase === "settle") map?.setPadding(NO_PADDING);
    phase = null;
    clearTimeout(timer);
    listening.abort();
    replay?.stop();
    replay = null;
    showIntroChrome(null);
    onEnd();
  };
  /**
   * The map back on the projection of before, with the flat heatmap, which
   * MapLibre draws anew at every zoom of a flight to a destination: the
   * cloud fades out over it (see ui/heatCloud.ts). As the settle sets off,
   * whose camera then comes to rest on the overview Wrapped opens on
   * without the intro, or on a skip.
   */
  const flat = (): void =>
    app.store.batch(() => {
      app.globeVisible = globeBefore;
      app.forcedHeatCloud = false;
    });
  /**
   * Wrapped as it opens without the intro: the map in its panel beside or
   * below the cards, measured again and fitted to the overview at once
   */
  const rest = (): void => {
    if (!phase) return;
    flat();
    end();
    app.map?.resize();
    fit({ animate: false });
  };
  const skip = (): void => {
    if (phase === "intro") rest();
  };
  /**
   * To rest on the overview as the cards come in. Not tagged: the app
   * follows where the map comes to rest from here on. Side by side the map
   * keeps the size of the dialog while it draws back into its panel beside
   * the cards (wrapped.css), so the camera settles on the overview as the
   * panel shows it, its view padded by the cards' room on the way
   * (overviewIn), and the map is measured and fitted again once it is
   * there, where it shows the same: resized on every frame instead, it
   * would draw its canvas anew in each. Stacked, it fades from over the
   * cards coming in, and goes to its panel below them once it has.
   */
  const settle = (): void => {
    phase = "settle";
    replay?.stop();
    replay = null;
    flat();
    // Taken while the stacked column is still out of the layout
    const room = cardsRoom();
    showIntroChrome("settle");
    const map = app.map;
    const camera = map && overviewIn(map, room);
    if (camera) {
      map.easeTo({
        ...camera,
        padding: { ...NO_PADDING, left: room },
        duration: INTRO_SETTLE_MS,
      });
    } else {
      fit({ duration: INTRO_SETTLE_MS });
    }
    after(INTRO_SETTLE_MS, rest);
  };

  showIntroChrome("intro");
  return {
    async begin() {
      let waited: ReturnType<typeof setTimeout> | undefined;
      const found = await Promise.race([
        loading,
        new Promise<null>((resolve) => {
          waited = setTimeout(() => resolve(null), INTRO_WAIT_MS);
        }),
      ]);
      clearTimeout(waited);
      const map = app.map;
      if (phase !== "intro" || !map) return false;
      if (!found) {
        skip();
        return false;
      }
      features = found;
      // The overview first, untagged, as it will be beside the cards: the
      // cloud is cut for the zoom the map comes to rest at
      // (ui/heatCloud.ts), and the camera comes down a couple of levels
      // closer (HOME). In one update with the cloud and the globe, which
      // leaves the relief out: in the 3D view the end of that zoom cut the
      // cloud and the ribbons for the relief of the overview on the way,
      // and the cloud dropped what it had cut ahead of time for the intro
      // (prepareWrappedIntro).
      app.store.batch(() => {
        app.globeVisible = true;
        app.forcedHeatCloud = true;
        const camera = overviewIn(map, cardsRoom());
        if (camera) map.jumpTo(camera);
        else fit({ animate: false });
      });
      over = {
        center: home,
        zoom: Math.min(map.getZoom() + HOME.above, HOME.most),
        pitch: HOME.pitch,
        bearing: HOME.bearing,
      };
      const [lat, lng] = home;
      found.jumpToStop(map, {
        center: [Math.max(lat - FAR.south, -60), lng - FAR.west],
        zoom: FAR.zoom,
        bearing: 0,
        pitch: 0,
      });
      // The user takes over: a press, a wheel or a key on the map. The map
      // stops the camera for them, and the intro makes way, or the settle
      // ends where it was going: either rests.
      found.followTakeover(map, rest, listening.signal);
      return true;
    },

    fly() {
      const map = app.map;
      if (phase !== "intro" || !features || !over || !map) return;
      if (timer !== undefined) return;
      const stop = over;
      // The shade and the title fade away over the flight (wrapped.css)
      domCache.get("wrapped-map-container")?.classList.remove("is-dark");
      // The flights first: their curves are cut as they start, which the
      // camera would otherwise lose its first frames to
      replay = startIntroReplay(app, features, stop.zoom);
      const { flyToStop, turnTo } = features;
      flyToStop(map, stop, INTRO_FLY_MS);
      after(INTRO_FLY_MS, () => {
        turnTo(map, stop.bearing + TURN_DEG, INTRO_TURN_MS);
        after(INTRO_TURN_MS, settle);
      });
    },

    skip,

    stop() {
      if (phase) end();
    },
  };
}

/**
 * Fly the map to the destination the pointer comes to rest on, and back
 * to the overview once it has left the list: hovering "Furthest" shows
 * where that is. `airportAt` finds the airport of a row, `overview` says
 * where to fly back to, or null while the map is not free to move (the
 * intro plays, the dialog is closed). Not for a finger, whose tap passes
 * over a row and leaves it at once, nor under reduced motion. A view the
 * user moved to is theirs: the map only flies back from a destination, and
 * a press or a wheel on the map drops a flight still waiting. Returns what
 * drops such a flight.
 */
export function followDestinationHover(
  app: MapApp,
  grid: HTMLElement,
  airportAt: (row: Element) => Coordinate | undefined,
  overview: () => IntroOverview | null,
  signal: AbortSignal,
): () => void {
  let hovered: Element | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the map is at a destination it flew to, not the user's view */
  let away = false;
  const cancel = (): void => {
    clearTimeout(timer);
    hovered = null;
  };
  const later = (fly: (map: MapLibreMap, to: IntroOverview) => void): void => {
    clearTimeout(timer);
    if (!overview() || prefersReducedMotion()) return;
    timer = setTimeout(() => {
      const to = overview();
      if (app.map && to) fly(app.map, to);
    }, DESTINATION_HOVER_MS);
  };
  // The user takes the map over
  const container = app.map?.getContainer();
  for (const type of ["pointerdown", "wheel"]) {
    container?.addEventListener(
      type,
      () => {
        cancel();
        away = false;
      },
      { passive: true, signal },
    );
  }
  grid.addEventListener(
    "pointerover",
    (event) => {
      const row = (event.target as Element).closest(".destination");
      if (!row || row === hovered || event.pointerType === "touch") return;
      hovered = row;
      const at = airportAt(row);
      if (at) {
        later((map) => {
          away = true;
          map.flyTo({ center: toLngLat(at), zoom: DESTINATION_ZOOM });
        });
      }
    },
    { signal },
  );
  grid.addEventListener(
    "pointerleave",
    (event) => {
      hovered = null;
      if (event.pointerType === "touch") return;
      if (!away) {
        // Nothing flown yet: nothing to fly back from
        clearTimeout(timer);
        return;
      }
      later((map, to) => {
        away = false;
        map.fitBounds(to.bounds, to.options);
      });
    },
    { signal },
  );
  return () => {
    cancel();
    away = false;
  };
}
