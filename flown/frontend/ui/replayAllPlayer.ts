/**
 * The player of the replay of all flights (see ui/replayAll.ts): it plays
 * every flight of a run at once, or one after another, and draws them
 * (ui/replayAllLayer.ts), and nothing else.
 */
import type { MapApp } from "../mapApp";
import type { KMLDataset, PathSegment } from "../types";
import { keptFlights } from "./keptFlights";
import { shownSelection } from "../calculations/datasetIndex";
import { flightClockOf } from "../calculations/flightClock";
import { segmentsForPathIds } from "../calculations/statistics";
import {
  calculateAirspeedRange,
  calculateAltitudeRange,
} from "../features/layers";
import { getColorForAirspeed, getColorForAltitude } from "../utils/colors";
import { releaseGroundedFlights } from "../calculations/groundProfile";
import { keptGrounded } from "../calculations/smoothGrounded";
import { isLiftedAt, liftExaggeration } from "../calculations/lift";
import {
  replayAllPoints,
  sequenceStarts,
  type ReplayAllPoints,
} from "../calculations/replayAll";
import { FEET_TO_METERS, MAP_LAYERS, MAX_FRAME_S } from "../utils/constants";
import { logError } from "../utils/logger";
import {
  hasLostContext,
  REPLAY_CAMERA_MOVE,
  whenContextRestored,
} from "../utils/mapHelpers";
import { prefersReducedMotion } from "../utils/motion";
import { followHeatCloud, heatCloudLevel } from "./heatCloud";
import { placeBelow } from "./glLayer";
import { ReplayAllLayer, type ReplayAllStyle } from "./replayAllLayer";

/** The speed a replay of all flights starts at */
export const REPLAY_ALL_SPEED = 200;

/**
 * Seconds on the wall a trail takes to fade, up to TRAIL_MOST_S of flight:
 * at a thousand times its speed a trail of 3 s was 50 minutes of flight,
 * most of a flight behind every head, where the heat built up behind them
 * shows the way flown already
 */
const TRAIL_FADE_S = 3;
const TRAIL_MOST_S = 1500;

/** Degrees a second the orbit turns the camera by: two minutes a round */
const ORBIT_DEG_PER_S = 3;

/** The deepest zoom level the curves are thinned for */
const MAX_DETAIL = 16;

/** Cuts of the curves kept, the last ones drawn, as for the heat cloud */
const CUTS_KEPT = 3;

/**
 * How many zoom levels short of a run's zoom (ReplayAllRun.zoom) a camera
 * on its way switches to the curves cut for it: the trails of a few
 * hundred times real speed are some tens of pixels long there, where a cut
 * for far out starts to show its corners
 */
const ZOOM_AHEAD_LEVELS = 2;

/**
 * The layer the replay is drawn below: the first of the ribbons, right
 * over the heat cloud (see CLOUD_BEFORE in ui/heatCloud.ts), so it does not
 * cut the run of flat layers the relief draws into a texture of it, and
 * the trails are drawn over the heat that builds up behind them
 */
const REPLAY_ALL_BEFORE = MAP_LAYERS.pathsAltitudeRibbons;

/** What to play, see ReplayAllPlayer.start */
export interface ReplayAllRun {
  /** The flights to play; by default those the filters and share mode keep */
  pathIds?: Iterable<number>;
  /** Seconds of flight a second; REPLAY_ALL_SPEED by default */
  speed?: number;
  /**
   * The zoom a camera that is on its way sets out for (Wrapped's intro,
   * from far out). The curves cut for where it sets off would be straight
   * spokes by the time it comes down, and those cut for where it comes to
   * rest too many to draw far out: both are cut as the run starts, and the
   * second drawn from ZOOM_AHEAD_LEVELS short of this zoom, until the map
   * first comes to the end of a zoom. By default the map's zoom only.
   */
  zoom?: number;
  /**
   * How many times their size the heads and trails are drawn: 1 by
   * default. Under Wrapped's intro, over a view of the whole year, they
   * were specks.
   */
  scale?: number;
  /**
   * Whether the flights `pathIds` play one after another in the order
   * given (see sequenceStarts) rather than all at once. Their trails fade
   * over the whole run, the first the faintest, so the run ends on all of
   * them.
   */
  sequence?: boolean;
  /**
   * Whether the trails stay as bright as they were drawn to the end of the
   * run rather than fade: the intro of a link to shared flights
   * (ui/shareIntro.ts), which hands them over to the lines of the flights
   */
  lasting?: boolean;
  /**
   * Whether the trails are drawn in the colours of the colour layer that
   * is on as the run starts (see colourOf), rather than in their own
   * amber: not under Wrapped's intro, whose year is no colour layer's
   */
  colour?: boolean;
}

/**
 * How many times the seconds of a run the trails of one played one after
 * another fade over: by the end, the first flight's are a quarter as
 * bright as the last one's
 */
const SEQUENCE_FADE_RUNS = 2;

/** The seconds of flight a lasting trail fades over: none it is drawn for */
const LASTING_FADE_S = 1e9;

/**
 * Plays every flight of a run at once, or one after another, on the map of
 * `app`. It needs no panel and changes no state of the app, so another
 * part of it (Wrapped's intro) can play it under its own camera;
 * ReplayAllControls is the one that makes it a replay of the map.
 */
export class ReplayAllPlayer {
  /** The seconds into every flight, or into a run of one after another */
  time = 0;
  /** Seconds of flight a second */
  speed: number = REPLAY_ALL_SPEED;
  /** The size the flights are drawn at (ReplayAllRun.scale) */
  private scale = 1;
  /** Whether the trails stay (ReplayAllRun.lasting) */
  private lasting = false;
  /** Whether the clock runs */
  playing = false;
  /** Whether the camera turns round the middle of the map while it plays */
  orbit = false;
  /** Told on every frame the clock moved, and as it starts, stops or pauses */
  onChange: (() => void) | null = null;
  /**
   * Told each time the last flight lands, in the first play of a run and
   * in every one after it from the start again, and as the clock is moved
   * there (seek)
   */
  onLanded: (() => void) | null = null;
  private readonly app: MapApp;
  private readonly layer: ReplayAllLayer;
  private points: ReplayAllPoints | null = null;
  private keep: ((pathId: number) => boolean) | null = null;
  /** The colour of each segment of the run (ReplayAllRun.colour) */
  private colours: ((segment: PathSegment) => number) | null = null;
  /**
   * Where each flight starts on the clock of a run played one after
   * another, in the order played (see sequenceStarts); null for one that
   * plays them all at once
   */
  legs: Map<number, number> | null = null;
  /**
   * The zoom the camera is on its way to (ReplayAllRun.zoom), until the
   * map comes to the end of a zoom, and whether it is near enough to draw
   * the curves cut for it
   */
  private zoomAhead: number | null = null;
  private aheadDrawn = false;
  /** The cuts of the curves by what they were cut for, the last at the end */
  private readonly cuts = new Map<string, ReplayAllPoints>();
  private frame: number | null = null;
  private lastFrame: number | null = null;
  /** Settles the promise of the run with whether it played to the end */
  private settle: ((ended: boolean) => void) | null = null;
  /** Ends what follows the map and the store while it plays */
  private following: AbortController | null = null;
  private broken = false;
  /** Whether the orbit has turned the camera since it last came to rest */
  private orbited = false;
  /**
   * Whether the flights are lifted: as the heat cloud and the ribbons,
   * which are handed to the flat lines from LIFT_MAX_ZOOM on once a zoom
   * has ended, not while it goes on
   */
  private lifted = true;
  /** Zoom levels further out than the map's the curves are cut for */
  private levelsOut = 0;

  /** `id` is the id of its layer on the map (see ReplayAllLayer) */
  constructor(app: MapApp, id?: string) {
    this.app = app;
    // The heat that builds up behind the flights is the heat cloud's, on
    // the flat map as well, and the flights are lifted as it is (see
    // level and ui/heatCloud.ts)
    followHeatCloud(app);
    this.layer = new ReplayAllLayer(
      this.style,
      (error) => {
        if (this.broken) return;
        this.broken = true;
        logError("The replay of all flights cannot be drawn:", error);
        // Out of the frame it failed in
        setTimeout(() => this.stop(), 0);
      },
      id,
    );
    // The style that comes back after a lost context has no custom layers,
    // and the shaders are tried again in the new context
    if (app.map) {
      whenContextRestored(app.map, () => {
        this.broken = false;
        this.place();
      });
    }
    // A destroyed app leaves the map as it is, but no frame runs on for it
    app.signal.addEventListener("abort", () => {
      this.pause();
      this.following?.abort();
    });
  }

  /** Whether its shaders did not work in the map's context */
  get unavailable(): boolean {
    return this.broken;
  }

  /** Whether a run is on the map */
  get active(): boolean {
    return this.keep !== null;
  }

  /**
   * Whether the clock stands at the end of the run (see end), where resume
   * would start it from the beginning again
   */
  get finished(): boolean {
    return this.active && this.time >= this.end();
  }

  /** When the last flight of the run has landed */
  get duration(): number {
    return this.points?.duration ?? 0;
  }

  /** How many flights the run plays */
  get flights(): number {
    return this.points?.flights ?? 0;
  }

  /**
   * The points of the run, as its layer draws them, with the bounds of the
   * flights, or null
   */
  get run(): ReplayAllPoints | null {
    return this.points;
  }

  /**
   * Play the flights of `run` from their first fixes. Resolves with true
   * once the last of them has landed, and with false when the run is
   * stopped before that or has no flight to play (`flights` is 0 then).
   */
  start(run: ReplayAllRun = {}): Promise<boolean> {
    this.stop();
    const app = this.app;
    const map = app.map;
    const data = app.currentData;
    if (!map || !data || this.broken) return Promise.resolve(false);
    const legs = (this.legs =
      run.sequence && run.pathIds
        ? sequenceStarts(
            run.pathIds,
            flightClockOf(data.path_segments).duration,
          )
        : null);
    this.keep = legs
      ? (pathId) => legs.has(pathId)
      : keepOf(app, data, run.pathIds);
    this.colours = run.colour ? colourOf(app, data) : null;
    this.speed = run.speed ?? REPLAY_ALL_SPEED;
    this.scale = run.scale ?? 1;
    this.lasting = !!run.lasting;
    this.levelsOut = 0;
    this.zoomAhead = run.zoom ?? null;
    this.aheadDrawn = this.nearAhead();
    this.lifted = isLiftedAt(map.getZoom());
    this.time = 0;
    this.cut();
    if (this.flights === 0) {
      this.stop();
      return Promise.resolve(false);
    }
    const { signal } = (this.following = new AbortController());
    if (this.zoomAhead !== null && !this.aheadDrawn) this.aim(this.zoomAhead);
    const store = app.store;
    store.subscribeKeys(
      ["threeDVisible", "terrainActive", "reliefLevel"],
      () => this.cut(),
      { signal },
    );
    // Another dataset is not what was asked to play
    store.subscribe("currentData", () => this.stop(), { signal });
    const zoomed = map.on("zoomend", () => {
      // The map's zoom is the one to follow from here on
      this.zoomAhead = null;
      this.aheadDrawn = false;
      this.lifted = isLiftedAt(map.getZoom());
      this.cut();
    });
    const styled = map.on("styledata", () => this.place());
    signal.addEventListener("abort", () => {
      zoomed.unsubscribe();
      styled.unsubscribe();
    });
    this.place();
    const ended = new Promise<boolean>((resolve) => {
      this.settle = resolve;
    });
    this.resume();
    return ended;
  }

  /**
   * Cut the curves for the zoom `zoom` a camera on its way sets out for
   * (see ReplayAllRun.zoom), from ZOOM_AHEAD_LEVELS short of it on, or
   * from `now` on, until the map first comes to the end of a zoom: once a
   * run has started, for a camera fitted to its flights. The intro of a
   * link to shared flights (ui/shareIntro.ts) draws them so from the
   * start: they are few, and the first of them flies as the camera comes
   * down, where those cut for the zoom it set out from were spokes.
   */
  aim(zoom: number, now = false): void {
    const map = this.app.map;
    const signal = this.following?.signal;
    if (!map || !signal) return;
    this.zoomAhead = zoom;
    this.aheadDrawn = now || this.nearAhead();
    if (this.aheadDrawn) {
      this.cut();
      return;
    }
    // Cut now, so that the camera's frames do not wait for it
    this.pointsFor(zoom);
    const zooming = map.on("zoom", () => {
      if (this.zoomAhead === null || this.aheadDrawn || !this.nearAhead()) {
        return;
      }
      this.aheadDrawn = true;
      this.cut();
    });
    signal.addEventListener("abort", () => zooming.unsubscribe());
  }

  /**
   * Cut the curves as for a map `levels` zoom levels further out than the
   * map, to the nearest whole level, from the end of the zoom under way or
   * now. A tilted map shows them smaller than a flat one at its zoom, and
   * fitted to them it comes about a level closer (see fitTilted): cut for
   * its zoom, they were twice the points, each taken up by the shaders
   * twice a frame, and in software WebGL a frame took a third longer.
   */
  thinOut(levels: number): void {
    this.levelsOut = Math.max(Math.round(levels), 0);
    if (!this.app.map?.isZooming()) this.cut();
  }

  /** Let the clock run, from the start again once every trail has faded */
  resume(): void {
    if (!this.active || this.playing) return;
    if (this.time >= this.end()) this.time = 0;
    this.playing = true;
    this.lastFrame = null;
    this.frame = requestAnimationFrame(this.tick);
    this.onChange?.();
  }

  /** Hold the clock where it is */
  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.rest();
    this.onChange?.();
  }

  /** Take the run off the map, and let go of its points */
  stop(): void {
    const wasActive = this.active;
    this.pause();
    this.following?.abort();
    this.following = null;
    this.keep = null;
    this.colours = null;
    this.legs = null;
    this.zoomAhead = null;
    this.aheadDrawn = false;
    this.points = null;
    this.cuts.clear();
    this.layer.setPoints(null);
    // On the flat map nothing else draws along the smoothed flights, which
    // for all years are tens of megabytes (see releaseGroundedFlights)
    if (wasActive && !this.app.threeDVisible) releaseGroundedFlights();
    const map = this.app.map;
    const id = this.layer.id;
    if (map && !hasLostContext(map) && map.getLayer(id)) map.removeLayer(id);
    this.settle?.(false);
    this.settle = null;
    if (wasActive) this.onChange?.();
  }

  /** The seconds of flight a trail fades over at the speed played */
  private fade(): number {
    if (this.lasting) return LASTING_FADE_S;
    return this.legs
      ? this.duration * SEQUENCE_FADE_RUNS
      : Math.min(TRAIL_FADE_S * this.speed, TRAIL_MOST_S);
  }

  /**
   * Where the run has played to the end: once every trail has faded, or
   * for one played one after another, whose trails stay, as the last
   * flight lands
   */
  private end(): number {
    return this.duration + (this.legs ? 0 : this.fade());
  }

  /**
   * Move the clock to `seconds` into every flight, between the start and
   * the landing of the last, playing on from there if it plays. The layer
   * draws from the clock alone, so the trails are the ones flown up to
   * there, backwards as well as forwards.
   */
  seek(seconds: number): void {
    if (!this.active) return;
    const before = this.time;
    this.time = Math.min(Math.max(seconds, 0), this.duration);
    // A run of flights one after another dragged to its end stays there,
    // paused, and never played the landing of its last flight: nothing
    // said every flight had landed
    this.landedFrom(before);
    this.app.map?.triggerRepaint();
    this.onChange?.();
  }

  /**
   * Tell that the last flight has landed, when the clock has just come to
   * its landing from `before`: once for each time it gets there
   */
  private landedFrom(before: number): void {
    if (this.time < this.duration) return;
    this.settle?.(true);
    this.settle = null;
    if (before < this.duration) this.onLanded?.();
  }

  /**
   * Tell the map's listeners the camera has come to rest once the orbit no
   * longer turns it. Its jumps are tagged (REPLAY_CAMERA_MOVE), so what the
   * app does at the end of a move, the saved view and the link among it,
   * waits for this `moveend`, as for the camera of the replay of one
   * flight. A move still going on ends with one of its own.
   */
  private rest(): void {
    if (!this.orbited) return;
    this.orbited = false;
    const map = this.app.map;
    if (!map || this.app.signal.aborted || hasLostContext(map)) return;
    if (!map.isMoving()) map.fire("moveend");
  }

  private readonly tick = (now: number): void => {
    this.frame = null;
    const map = this.app.map;
    if (!this.playing || !map) return;
    if (!this.orbit) this.rest();
    const step =
      this.lastFrame === null
        ? 0
        : Math.min(Math.max(now - this.lastFrame, 0) / 1000, MAX_FRAME_S);
    this.lastFrame = now;
    const before = this.time;
    this.time += step * this.speed;
    this.landedFrom(before);
    // Played to the end once the last trail has faded (see end)
    const end = this.end();
    if (this.time >= end) {
      this.time = end;
      this.playing = false;
    }
    // Not while the camera moves: a jump would end the fit's animation, or
    // turn the map under a finger; nor on a map without its WebGL context
    if (
      this.orbit &&
      step > 0 &&
      !prefersReducedMotion() &&
      !map.isMoving() &&
      !hasLostContext(map)
    ) {
      map.jumpTo(
        { bearing: map.getBearing() + ORBIT_DEG_PER_S * step },
        REPLAY_CAMERA_MOVE,
      );
      this.orbited = true;
    }
    map.triggerRepaint();
    if (this.playing) this.frame = requestAnimationFrame(this.tick);
    else this.rest();
    this.onChange?.();
  };

  /**
   * The relief level the flights are lifted as: the 3D view's, and outside
   * it the heat cloud's (heatCloudLevel), which is at its height there as
   * well while they play, so the heads fly in the heat
   */
  private level(): number {
    const app = this.app;
    return app.threeDVisible ? app.reliefLevel : (heatCloudLevel(app) ?? 0);
  }

  /**
   * What the layer draws with in the frame, as the heat cloud is drawn:
   * the flights at their height, on the relief where it is drawn. Outside
   * the 3D view as well, where under a camera that flies and tilts over
   * them (Wrapped's intro, the replay's own tilt) they were lines on the
   * ground.
   */
  private readonly style = (): ReplayAllStyle | null => {
    const app = this.app;
    const map = app.map;
    if (!map || !this.active) return null;
    const exaggeration =
      map.getTerrain()?.exaggeration ?? liftExaggeration(this.level());
    const metres = exaggeration * FEET_TO_METERS;
    return {
      groundM: app.terrainActive ? metres : 0,
      liftM: this.lifted ? metres : 0,
      time: this.time,
      fade: this.fade(),
      scale: this.scale,
    };
  };

  /** Whether the camera is near enough the zoom of the run to draw its cut */
  private nearAhead(): boolean {
    const map = this.app.map;
    return (
      this.zoomAhead !== null &&
      !!map &&
      map.getZoom() >= this.zoomAhead - ZOOM_AHEAD_LEVELS
    );
  }

  /** Draw the curves cut for the view (see pointsFor) */
  private cut(): void {
    const map = this.app.map;
    if (!map) return;
    const zoom =
      this.zoomAhead !== null && this.aheadDrawn
        ? this.zoomAhead
        : map.getZoom();
    const points = this.pointsFor(zoom);
    if (!points || points === this.points) return;
    this.points = points;
    this.layer.setPoints(points);
  }

  /**
   * The curves cut for the view: on the ground of the 3D view and the
   * relief level they are lifted as (see level), as the heat cloud's, and
   * thinned for the map zoom `zoom`, less the levels out (see thinOut).
   * Those cut last are kept, and handed out again as long as nothing they
   * were cut for changed.
   */
  private pointsFor(zoom: number): ReplayAllPoints | null {
    const app = this.app;
    const data = app.currentData;
    const keep = this.keep;
    if (!data || !keep) return null;
    const detail = Math.min(
      Math.max(Math.floor(zoom) - this.levelsOut, 0),
      MAX_DETAIL,
    );
    const level = this.level();
    const key = `${app.terrainActive}/${level}/${detail}`;
    let points = this.cuts.get(key);
    if (points) {
      this.cuts.delete(key);
    } else {
      // A few flights, shared, alone: not every flight of the dataset
      const { segments, flights } = keptGrounded(
        data.path_segments,
        keep,
        app.terrainActive,
        app.reliefLevel,
      );
      points = replayAllPoints(
        segments,
        flights,
        flightClockOf(segments),
        keep,
        detail,
        level,
        this.legs ?? undefined,
        this.colours ?? undefined,
      );
      const oldest = this.cuts.keys().next();
      if (!oldest.done && this.cuts.size >= CUTS_KEPT) {
        this.cuts.delete(oldest.value);
      }
    }
    this.cuts.set(key, points);
    return points;
  }

  /**
   * Put the layer on the map, below the flights in the air and the labels
   * and over the heat cloud (REPLAY_ALL_BEFORE), or back there
   */
  private place(): void {
    const map = this.app.map;
    if (!map || !this.active || this.app.signal.aborted) return;
    if (hasLostContext(map)) return;
    // The heat cloud puts itself right below it
    placeBelow(map, this.layer, !!map.getLayer(this.layer.id), [
      REPLAY_ALL_BEFORE,
    ]);
  }
}

/**
 * The colour of a segment of `data` as the colour layer that is on draws
 * it, as the three bytes the points of a run carry (see replayAllPoints),
 * or null while neither is on. Its range is the one the layer and its
 * legend use (resolveColorRange in ui/pathLook.ts): the shown selection's
 * if there is one, else all of it, the colours spread by its values. A
 * segment the Groundspeed layer draws no line along, with no speed
 * (filterSegment in ui/pathRuns.ts), has its colour negated: its trail
 * is not drawn either, and its head is drawn in it.
 */
function colourOf(
  app: MapApp,
  data: KMLDataset,
): ((segment: PathSegment) => number) | null {
  const altitude = app.altitudeVisible;
  if (!altitude && !app.airspeedVisible) return null;
  const selected = shownSelection(app);
  const segments =
    selected.size > 0 ? segmentsForPathIds(data.path_segments, selected) : [];
  const range = altitude
    ? calculateAltitudeRange(segments, app.altitudeRange, data.path_info)
    : calculateAirspeedRange(segments, app.airspeedRange);
  const bytes = new Map<string, number>();
  return (segment) => {
    const colour = altitude
      ? getColorForAltitude(
          segment.altitude_ft,
          range.min,
          range.max,
          range.ranks,
        )
      : getColorForAirspeed(
          segment.groundspeed_knots,
          range.min,
          range.max,
          range.ranks,
        );
    let packed = bytes.get(colour);
    if (packed === undefined) {
      const [r, g, b] = colour.match(/\d+/g)!.map(Number);
      packed = (r! << 16) | (g! << 8) | b!;
      bytes.set(colour, packed);
    }
    return altitude || segment.groundspeed_knots > 0 ? packed : -packed;
  };
}

/**
 * Whether a flight is one to play: one of `pathIds`, or where none are
 * given one the filters keep and, while the selection is isolated, one of
 * it, as the heatmap shows them
 */
function keepOf(
  app: MapApp,
  data: KMLDataset,
  pathIds: Iterable<number> | undefined,
): (pathId: number) => boolean {
  if (pathIds) {
    const chosen = new Set(pathIds);
    return (pathId) => chosen.has(pathId);
  }
  return keptFlights(
    app,
    data,
    app.isolateSelection ? app.selectedPathIds : null,
  );
}
