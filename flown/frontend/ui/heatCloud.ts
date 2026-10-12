/**
 * The heat cloud - the heatmap of the 3D view, in the air
 *
 * While the 3D view is on, the heat is drawn as a cloud of the fixes at
 * their height instead of as the flat heatmap on the ground, so the busy
 * airspace glows where it is: the circuits over a field, the routes along a
 * valley, the climbs out and the descents in. It shows what the heatmap
 * would: the fixes of the flights the year and aircraft filters keep, of
 * the selection alone while it is isolated, nothing while the Heatmap
 * switch is off; and it steps back under the aviation chart or a
 * selection's lines as the heatmap does, but not under the ribbons of a
 * colour layer, which are drawn in front of it (dimsHeatCloud). While a
 * replay runs it stays, faintly and without its pulses, its marks showing
 * the way flown instead, so the chase camera flies through the flights of
 * before. The replay of all flights draws it at full strength instead, as
 * far as its clock has come into every flight (ReplayAllControls.time), so
 * the heat builds up behind the flights and ends as the whole of it; on the
 * flat map as well, at its height as the flights are there, where it stands in
 * for the heatmap, whose colours it glows in, until the replay closes.
 * Left on the ground, it lay beside the trails by their height and read
 * as other flights than theirs. The intro of a link to shared flights
 * (ui/shareIntro.ts) builds it up the same way behind the flights it draws
 * one after another, by the clock of its own player (growHeatCloud), and
 * on the flat map hands it over to the heatmap as Wrapped's cloud does
 * (see sync). The flat heatmap
 * steps aside for it (heatCloud in the store, see
 * ui/layerVisibility.ts) from the moment the cloud's layer is on the map
 * until the 3D view is turned off,
 * or, where the cloud's shaders do not work, until the map has a new WebGL
 * context, which leaves the heatmap as it was meanwhile.
 *
 * The heights are the ribbons', on the same ground and as exaggerated (see
 * calculations/heatCloud.ts), and the layer (ui/heatCloudLayer.ts) is
 * drawn against the relief. It only draws: the map cannot tell what is
 * under the pointer in a custom layer, and the ribbons of the colour
 * layers stay what is hovered and clicked. It comes with the feature
 * bundle, with the relief, the first time the 3D view is on.
 *
 * Wrapped's intro flies over the cloud with the 3D view off
 * (forcedHeatCloud in the store). There the cloud stands on flat ground, as
 * on the globe the intro turns on, and is cut for the level of the zoom the
 * map last came to rest at, which the layer manager only follows in the 3D
 * view, and closer in than the last relief level for that zoom's own
 * level. It is the year of the cards: the flights the year and aircraft
 * filters keep, whatever the Heatmap switch, an isolated selection or a
 * colour layer say, at full strength. It pulses as in the 3D view, woken by
 * the flight and resting when the map does: the replay of all flights that
 * plays under the intro is no replay of the app's (replayActive), which
 * would dim it.
 */
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import type { KMLDataset, PathSegment } from "../types";
import { cloudPoints, type CloudPoints } from "../calculations/heatCloud";
import { heldFlights } from "../calculations/groundProfile";
import {
  keptGrounded,
  smoothGrounded,
  type GroundedRun,
} from "../calculations/smoothGrounded";
import { idsKey, keptFlights } from "./keptFlights";
import { heatWeight } from "../calculations/heatLines";
import {
  isLiftedAt,
  LIFT_MAX_ZOOM,
  liftExaggeration,
  RELIEF_MAX_LEVEL,
  reliefLevel,
  ribbonWidthZoom,
} from "../calculations/lift";
import { FEET_TO_METERS, MAP_LAYERS } from "../utils/constants";
import { logError } from "../utils/logger";
import {
  CULL_FROM_ZOOM,
  leavesBox,
  ribbonsTopM,
  viewBox,
  type Box,
} from "../utils/viewBox";
import {
  hasLostContext,
  isReplayCameraMove,
  onMapReady,
  whenContextRestored,
} from "../utils/mapHelpers";
import { dimmedHeatmapOpacity } from "./dataManager";
import { dimsHeatCloud } from "./layerVisibility";
import {
  HEAT_CLOUD_LAYER,
  HeatCloudLayer,
  type HeatCloudStyle,
} from "./heatCloudLayer";
import { cloudExposure, cloudLook } from "./heatCloudShaders";
import { followCloudReadout } from "./cloudReadout";
import { featurePart } from "./lazyBundles";
import { REPLAY_ALL_LAYER, SHARE_INTRO_LAYER } from "./replayAllLayer";
import { placeBelow } from "./glLayer";

/**
 * The layer the cloud is drawn below: the first of the ribbons, above every
 * layer of the app that lies on the ground (the selection's lines, the
 * replay's route and trail) and below the flights in the air and the
 * labels; or the replay of all flights right under them, whose trails are
 * drawn over the heat. On the relief MapLibre draws the layers on the
 * ground into a texture of it, and the relief once more for every run of
 * them another layer breaks: between the heatmaps and the heat lines the
 * cloud cut them in two, and every frame of the 3D view drew the relief
 * twice, even with the Heatmap switch off.
 */
const CLOUD_BEFORE = MAP_LAYERS.pathsAltitudeRibbons;

/**
 * How long Wrapped's cloud takes to fade out over the flat heatmap it hands
 * the dialog's map to, in ms: about as long as the heatmap takes to cut its
 * tiles, early in the camera's settle on the overview
 */
const CLOUD_HANDOVER_MS = 1000;

/** How strongly the cloud is drawn while a replay runs */
const CLOUD_REPLAY_OPACITY = 0.25;

/** The keys the cloud follows */
const CLOUD_KEYS: readonly (keyof StoreState)[] = [
  "threeDVisible",
  "forcedHeatCloud",
  "wrappedVisible",
  "heatmapVisible",
  "replayActive",
  "currentData",
  "selectedYear",
  "selectedAircraft",
  "selectedPathIds",
  "isolateSelection",
  "reliefLevel",
  "terrainActive",
  "altitudeVisible",
  "airspeedVisible",
  "aviationVisible",
];

/**
 * Whether the selection is isolated in the cloud: as in the heatmap, but
 * not in Wrapped's (`forced`), whose cards describe every flight of the
 * filters
 */
function isolatesIn(app: MapApp, forced: boolean): boolean {
  // Share mode ends with its last flight (AppStore.settle)
  return !forced && app.isolateSelection;
}

/**
 * Whether the cloud stands on the relief: where the 3D view draws it, and
 * never in Wrapped's (`forced`), which is on the globe, where the relief is
 * left out (see LayerManager.syncTerrain)
 */
function onReliefIn(app: MapApp, forced: boolean): boolean {
  return !forced && app.terrainActive;
}

/**
 * What the points of the cloud were made of, as a key: the dataset, the
 * filter, the isolated selection and the ground they stand on, in the 3D
 * view's cloud or in Wrapped's (`forced`); the zoom level they are cut for
 * is kept apart (see CLOUD_LEVELS_KEPT). Another key forgets the exposures
 * as well.
 */
function pointsKey(app: MapApp, forced: boolean): unknown[] {
  const isolated = isolatesIn(app, forced) ? idsKey(app.selectedPathIds) : "";
  return [
    app.currentData,
    app.selectedYear,
    app.selectedAircraft,
    isolated,
    onReliefIn(app, forced),
  ];
}

/** Whether two keys of pointsKey are the same */
function sameKey(a: unknown[] | null, b: unknown[]): boolean {
  return !!a && a.every((value, i) => value === b[i]);
}

/**
 * The points of the cloud cut for a zoom level, and the part of the map
 * they were cut for (see viewBox), null for all of it. From CULL_FROM_ZOOM
 * on the cloud is cut around the view, as the ribbons are, and again as
 * the view leaves that: closer in than the last relief level it is cut
 * for the zoom's own level (see cloudDetail), where the flights of two
 * years all over the map were 150,000 points.
 */
interface Cut {
  points: CloudPoints;
  box: Box | null;
}

/** The points of a cloud kept by zoom level (see CLOUD_LEVELS_KEPT) */
interface KeptPoints {
  /** What they were made of (pointsKey) */
  made: unknown[] | null;
  /** By the zoom level cut for, the one asked for last at the end */
  byLevel: Map<number, Cut>;
  /**
   * The exposure of the points by relief level (CloudPoints.busiest),
   * which a cut around the view or for a closer zoom level keeps: it adds
   * up the heat of every flight at the relief level, and a cut that knows
   * it goes through the flights that reach the view alone
   */
  exposures: Map<number, number>;
}

/** No points kept yet */
function keptPoints(): KeptPoints {
  return { made: null, byLevel: new Map(), exposures: new Map() };
}

/**
 * How many zoom levels the points of the cloud are kept for, the last ones
 * it was drawn at. The points of a level are cut from every flight
 * smoothed on its ground (groundedFlights), which with the heatmap alone
 * was all of the 50 to 90 ms a zoom into another level took for two years
 * of flights; a zoom back, or in and out around one level, takes none. All
 * levels of those two years were about 7.0 MB of points, the four deepest
 * about 6.0, before the steps were merged into stretches and the points of
 * a level cut around the view (see Cut).
 */
const CLOUD_LEVELS_KEPT = 4;

/**
 * How far around the view the cloud is cut from CULL_FROM_ZOOM on, in
 * spans of the view (see viewBox): a pan of a whole view, or a zoom out of
 * one and a half levels, before the map comes to rest shows no edge of it.
 * The ribbons are cut a quarter of a view around it (VIEW_SPARE), and a
 * cloud cut as closely ended in a straight edge a quarter of a view into
 * a pan. It costs little: a cut goes through every flight that reaches
 * the view however far around it is, and the layer drops the stretches
 * out of the view before a pixel of them is drawn, so a frame takes the
 * same GPU time.
 */
const CLOUD_VIEW_SPARE = 1;

/**
 * The zoom level the cloud is cut for at the relief level `level` and the
 * map zoom `zoom`: the relief level, and closer in than the last one the
 * zoom's, up to LIFT_MAX_ZOOM, from where the flights are drawn flat. The
 * relief level stops at the last elevation tiles, and the cloud cut for
 * its pixels cut across the corners of a circuit and the taxiways in
 * chords of about 110 m, 270 px long at LIFT_MAX_ZOOM (the app's zoom 18),
 * where the heat lines of the flat map follow them. The ground and the
 * exaggeration stay the last relief level's.
 */
function cloudDetail(level: number, zoom: number): number {
  return level < RELIEF_MAX_LEVEL
    ? level
    : Math.min(Math.max(ribbonWidthZoom(zoom), level), LIFT_MAX_ZOOM);
}

/**
 * How long points the cloud does not draw are kept: all of them while it
 * draws none (the Heatmap switch is off in the 3D view, Wrapped's button
 * had them cut ahead of time, prepareHeatCloud, for an intro that did not
 * come, or the intro is over), and those of the other cloud while it draws
 * one (Wrapped's cut ahead in the 3D view, or the 3D view's while Wrapped's
 * draws). With the flights smoothed for them Wrapped's held 8.6 MB of the
 * heap after a pointer had merely crossed the button.
 */
export const CLOUD_IDLE_MS = 15_000;

/**
 * The clock of a player of flights played one after another, which the
 * cloud is built up to (see growHeatCloud): the time on it, and where each
 * flight starts on it (see sequenceStarts in calculations/replayAll.ts)
 */
interface HeatClock {
  readonly time: number;
  readonly legs: ReadonlyMap<number, number> | null;
}

/**
 * The apps whose cloud is followed, each with what cuts its points ahead
 * of time (see prepareHeatCloud), the relief level it is lifted as (see
 * heatCloudLevel) and what builds it up by a clock (see growHeatCloud)
 */
const followed = new WeakMap<
  MapApp,
  {
    prepare: (levels: readonly number[]) => void;
    level: () => number;
    grow: (clock: HeatClock | null, zoom: number) => void;
  }
>();

/**
 * The relief level the cloud of `app` is lifted as, or null while nothing
 * follows it: the 3D view's, and outside it the level of the zoom the map
 * last came to rest at, not one of the moves of a replay's camera or of
 * Wrapped's intro. The replay of all flights lifts its flights as much
 * (ui/replayAll.ts), so they fly in the heat.
 */
export function heatCloudLevel(app: MapApp): number | null {
  return followed.get(app)?.level() ?? null;
}

/**
 * Cut the points of Wrapped's cloud (forcedHeatCloud) for the map `zooms`
 * ahead of time, once followHeatCloud follows it: Wrapped does while its
 * button is pointed at, so that its intro does not stall on them. They are
 * cut for all of the map, for the zoom level the cloud is drawn at once the
 * map comes to rest at such a zoom (see cloudDetail), and kept like the
 * points of the levels drawn last, for CLOUD_IDLE_MS unless the intro draws
 * them.
 */
export function prepareHeatCloud(app: MapApp, zooms: readonly number[]): void {
  followed.get(app)?.prepare(zooms);
}

/**
 * Build the cloud of `app` up to the time of `clock`, as the replay of all
 * flights does, with each flight's heat timed on that clock, on the flat
 * map as well, where it stands in for the heatmap; or with null no longer.
 * Once followHeatCloud follows it: the intro of a link to shared flights
 * (ui/shareIntro.ts) does, which is no replay of the app's (replayActive).
 * It is cut for the zoom `zoom` the camera is on its way to, at least: for
 * the zoom it set out from, it was spokes as the camera came down.
 */
export function growHeatCloud(
  app: MapApp,
  clock: HeatClock | null,
  zoom = 0,
): void {
  followed.get(app)?.grow(clock, zoom);
}

/**
 * Draw the heat of the 3D view as a cloud while the 3D view is on, or the
 * store forces it (forcedHeatCloud), from now on, for as long as the app
 * lives. A second call for the same app does nothing.
 */
export function followHeatCloud(app: MapApp): void {
  const map = app.map;
  if (!map || followed.has(app)) return;
  // What the cloud under the pointer is made of (ui/cloudReadout.ts)
  followCloudReadout(app);
  /**
   * The shaders did not work in the map's context: the heatmap stays, until
   * a lost context is restored
   */
  let broken = false;
  /** How strongly the cloud is drawn, as the heatmap would be */
  let opacity = 1;
  /** The stylesheet's dimmed opacity, read the first time it is wanted */
  let dimmed: number | undefined;
  /**
   * Whether the flights are lifted: as the ribbons, which the layer manager
   * hands to the flat lines from LIFT_MAX_ZOOM on once a zoom has ended
   * (see LayerManager.handleZoomEnd), not while it goes on
   */
  let lifted = isLiftedAt(map.getZoom());
  /**
   * The points kept of the 3D view's cloud and of Wrapped's (`forced`),
   * each by what they were made of: a cut ahead of time for Wrapped does
   * not take the place of the points the 3D view draws
   */
  const kept = { own: keptPoints(), forced: keptPoints() };
  const keptOf = (forced: boolean): KeptPoints =>
    forced ? kept.forced : kept.own;
  /** The points handed to the layer */
  let drawn: CloudPoints | null = null;
  /**
   * The flights of Wrapped's cloud smoothed on their flat ground, the same
   * at every level, where groundedFlights holds none (see flightsFor)
   */
  let aside: GroundedRun | null = null;
  /** Let go of the points of every level of one cloud (`forced`) */
  const forget = (forced: boolean): void => {
    const cloud = keptOf(forced);
    cloud.made = null;
    cloud.byLevel.clear();
    cloud.exposures.clear();
    if (forced) aside = null;
  };
  /** Lets go of the points the cloud does not draw (CLOUD_IDLE_MS) */
  let idle: ReturnType<typeof setTimeout> | undefined;
  /**
   * The relief level of the zoom the map last came to rest at, which the
   * cloud is cut for outside the 3D view, where the layer manager follows
   * no level (see LayerManager.syncTerrain)
   */
  let atRest = reliefLevel(map.getZoom());
  /** That zoom, which the cloud is cut for beyond the last relief level */
  let restZoom = map.getZoom();
  /** The relief level the cloud is cut for and lifted as */
  const level = (): number => (app.threeDVisible ? app.reliefLevel : atRest);
  /** The clock the cloud is built up to by growHeatCloud, and its zoom */
  let clock: HeatClock | null = null;
  let aimed = 0;
  /**
   * Whether that ended on the flat map since the last sync, where the
   * cloud hands over to the heatmap (see sync), and when it ended in the
   * 3D view, where the cloud eases from full strength to the one it is
   * drawn at, dimmed for the lines that come back (0 while it does not):
   * both over CLOUD_HANDOVER_MS
   */
  let handing = false;
  let easing = 0;
  /**
   * The time the heat is drawn up to: the clock of growHeatCloud, or the
   * replay of all flights' while it is open; null while neither builds it
   * up
   */
  const until = (): number | null =>
    clock
      ? clock.time
      : app.replayActive
        ? (featurePart(app, "replayAll")?.time ?? null)
        : null;
  const growing = (): boolean => until() !== null;

  /** Whether the layer is on the map */
  const wanted = (): boolean =>
    (app.threeDVisible || app.forcedHeatCloud || growing()) && !broken;
  /** Whether it draws: Wrapped's whatever the Heatmap switch says */
  const shown = (): boolean =>
    wanted() && (app.forcedHeatCloud || app.heatmapVisible);

  /**
   * When Wrapped's cloud began to hand the dialog's map over to the flat
   * heatmap (see sync), 0 while it does not: it fades out over
   * CLOUD_HANDOVER_MS, drawn as it was, over the heatmap, which shows at
   * once and has the time to cut its tiles. Taken off at once, it left
   * the map without heat for the frames those took.
   */
  let leaving = 0;
  let left: ReturnType<typeof setTimeout> | undefined;
  /** Wrapped's cloud was on as the store last changed */
  let wasForced = false;

  const style = (): HeatCloudStyle | null => {
    if (!shown() && !leaving) return null;
    const eased = easing
      ? Math.max(1 - (performance.now() - easing) / CLOUD_HANDOVER_MS, 0)
      : 0;
    if (eased > 0) map.triggerRepaint();
    else easing = 0;
    const forced = app.forcedHeatCloud || !!leaving;
    // The relief's own exaggeration, which it switches as a zoom ends (see
    // ui/terrain.ts), or the level's where the map draws none
    const exaggeration =
      map.getTerrain()?.exaggeration ?? liftExaggeration(level());
    const metres = exaggeration * FEET_TO_METERS;
    return {
      groundM: onReliefIn(app, forced) ? metres : 0,
      // At their height on the flat map too while the replay of all
      // flights builds it up, where its trails fly in it
      liftM: lifted && (app.threeDVisible || forced || growing()) ? metres : 0,
      opacity: opacity + (1 - opacity) * eased,
      fade: leaving
        ? Math.max(1 - (performance.now() - leaving) / CLOUD_HANDOVER_MS, 0)
        : 1,
      flow: !app.replayActive && !clock,
      until: until() ?? undefined,
    };
  };

  const layer = new HeatCloudLayer(style, (error) => {
    if (broken) return;
    logError("The heat cloud of the 3D view cannot be drawn:", error);
    broken = true;
    // Out of the frame it failed in
    setTimeout(sync, 0);
  });

  /**
   * Tell the heat scale (ui/heatScale.ts) how brightly a flight's worth is
   * drawn where the map came to rest: with the gain of the look there and
   * the exposure the layer eases towards
   */
  const publishScale = (): void => {
    const gain = cloudLook(map.getZoom()).gain;
    app.heatCloudScale = drawn ? gain * cloudExposure(drawn.busiest * gain) : 0;
  };

  /** Hand the layer `points`, unless it has them already */
  const draw = (points: CloudPoints | null): void => {
    if (points === drawn) return;
    drawn = points;
    layer.setPoints(points);
    publishScale();
  };

  /**
   * Let go in CLOUD_IDLE_MS of the points the cloud does not draw then:
   * all of them, or those of the other cloud
   */
  const release = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (app.signal.aborted) return;
      if (shown()) {
        forget(!app.forcedHeatCloud);
        return;
      }
      draw(null);
      forget(false);
      forget(true);
    }, CLOUD_IDLE_MS);
  };

  /** How high a flight is drawn at most at the relief level `at` */
  const topM = (at: number): number => ribbonsTopM(app.altitudeRange.max, at);

  /**
   * The points of what the heatmap shows cut for the relief level `at` and
   * the zoom level `detail`, or of Wrapped's cloud (`forced`), and with
   * `around` only those around the view: those kept for it while nothing
   * they were made of changed and they reach as far as the view, the other
   * cloud's where they are of the same (both on flat ground, nothing
   * isolated) and reach as far, or cut now
   */
  const pointsAt = (
    at: number,
    forced: boolean,
    detail = at,
    around = false,
  ): CloudPoints | null => {
    const data = app.currentData;
    // With the flights timed on the clock it is built up to
    const key = [
      ...pointsKey(app, forced),
      forced ? null : (clock?.legs ?? null),
    ];
    const cloud = keptOf(forced);
    if (!sameKey(cloud.made, key)) {
      forget(forced);
      cloud.made = key;
    }
    const { byLevel } = cloud;
    if (!data) return null;
    const view = around ? viewBox(map, topM(at), 0) : null;
    const fits = (cut: Cut | undefined): cut is Cut =>
      !!cut && (!cut.box || (!!view && !leavesBox(view, cut.box)));
    const other = keptOf(!forced);
    const shared = sameKey(other.made, key);
    let cut = byLevel.get(detail);
    if (!fits(cut)) {
      const theirs = shared ? other.byLevel.get(detail) : undefined;
      if (fits(theirs)) {
        cut = theirs;
      } else {
        const box = around ? viewBox(map, topM(at), CLOUD_VIEW_SPARE) : null;
        const exposure =
          cloud.exposures.get(at) ??
          (shared ? other.exposures.get(at) : undefined);
        const points = makePoints(data, at, detail, box, forced, exposure);
        cloud.exposures.set(at, points.busiest);
        cut = { points, box };
      }
    }
    byLevel.delete(detail);
    const oldest = byLevel.keys().next();
    if (!oldest.done && byLevel.size >= CLOUD_LEVELS_KEPT) {
      byLevel.delete(oldest.value);
    }
    byLevel.set(detail, cut);
    return cut.points;
  };

  /**
   * The points of what the heatmap shows, when that changed or the view
   * left the part of the map they were cut for. While a replay runs they
   * are the relief level's, of all the map: its camera moves on its own,
   * and the map does not come to rest (see isReplayCameraMove). So does
   * the camera of Wrapped's intro, whose cloud is of all the map at every
   * zoom (see prepareHeatCloud): cut around a view it leaves at once, its
   * glow ended in a straight edge across the map.
   */
  const updatePoints = (): void => {
    const at = level();
    const forced = app.forcedHeatCloud;
    if (app.replayActive || clock) {
      draw(pointsAt(at, forced, clock ? Math.max(at, reliefLevel(aimed)) : at));
      return;
    }
    const zoom = app.threeDVisible ? map.getZoom() : restZoom;
    const detail = cloudDetail(at, zoom);
    draw(pointsAt(at, forced, detail, detail >= CULL_FROM_ZOOM && !forced));
  };
  followed.set(app, {
    prepare: (zooms) => {
      for (const zoom of zooms) {
        const at = reliefLevel(zoom);
        pointsAt(at, true, cloudDetail(at, zoom));
      }
      release();
    },
    level,
    grow: (to, zoom) => {
      if (!to && clock) {
        if (app.threeDVisible) easing = performance.now();
        else handing = true;
      }
      clock = to;
      aimed = zoom;
      sync();
    },
  });

  /**
   * The flights `keep` takes of `segments` smoothed on the ground of the
   * cloud at `level`, with the segments they are of. The 3D view's are the
   * ribbons' curves, smoothed once for both (see groundedFlights), and a
   * few shared ones are smoothed alone (keptGrounded). Wrapped's stand on
   * flat ground and are smoothed aside, unless groundedFlights holds them:
   * a cut ahead of time must not take the place of the curves the ribbons
   * stand on, and in 2D nothing lets go of what groundedFlights holds.
   */
  const flightsFor = (
    segments: readonly PathSegment[],
    keep: (pathId: number) => boolean,
    level: number,
    forced: boolean,
  ): GroundedRun => {
    const relief = onReliefIn(app, forced);
    if (!forced) return keptGrounded(segments, keep, relief, level);
    const held = heldFlights(segments, relief, level);
    if (held) return { segments, flights: held };
    if (aside?.segments !== segments) {
      aside = { segments, flights: smoothGrounded(segments, relief, level) };
    }
    return aside;
  };

  /**
   * The points of the flights the heatmap shows, or Wrapped's cloud shows
   * (`forced`), cut for the relief level `level` and the zoom level
   * `detail`, those in `box` or all of them, with the `exposure` where it is
   * known
   */
  const makePoints = (
    data: KMLDataset,
    level: number,
    detail: number,
    box: Box | null,
    forced: boolean,
    exposure: number | undefined,
  ): CloudPoints => {
    const keep = keptFlights(
      app,
      data,
      isolatesIn(app, forced) ? app.selectedPathIds : null,
    );
    const { segments, flights } = flightsFor(
      data.path_segments,
      keep,
      level,
      forced,
    );
    // Rolled off for the scale of the middle of the level cut for
    const gain = cloudLook(detail + 0.5).gain;
    return cloudPoints(
      segments,
      flights,
      keep,
      level,
      detail,
      box,
      exposure,
      heatWeight,
      (busiest) => gain * cloudExposure(busiest * gain),
      forced ? undefined : (clock?.legs ?? undefined),
    );
  };

  /** Put the layer where it belongs, or take it off */
  const place = (): void => {
    if (hasLostContext(map)) return;
    const on = !!map.getLayer(HEAT_CLOUD_LAYER);
    if (!wanted() && !leaving) {
      if (on) map.removeLayer(HEAT_CLOUD_LAYER);
      return;
    }
    placeBelow(map, layer, on, [
      REPLAY_ALL_LAYER,
      SHARE_INTRO_LAYER,
      CLOUD_BEFORE,
    ]);
  };

  /** The 3D switch as the last sync found it */
  let threeD = app.threeDVisible;

  const sync = (): void => {
    if (app.signal.aborted) return;
    // Wrapped's cloud hands its map over to the flat heatmap as its intro
    // ends (ui/wrappedIntro.ts), fading out over it, unless the 3D view
    // keeps a cloud there, and so does the cloud of the intro of a link
    // to shared flights on the flat map. A close takes it off at once:
    // the page's map shows the user's own heat.
    const forced = app.forcedHeatCloud;
    if (forced || wanted() || !(app.wrappedVisible || handing)) {
      clearTimeout(left);
      leaving = 0;
    } else if ((wasForced || handing) && drawn) {
      leaving = performance.now();
      left = setTimeout(() => {
        leaving = 0;
        sync();
      }, CLOUD_HANDOVER_MS);
    }
    wasForced = forced;
    handing = false;
    place();
    // The flat heatmap steps aside while the layer is there to draw
    app.heatCloud = wanted();
    const left3D = threeD && !app.threeDVisible;
    threeD = app.threeDVisible;
    if (!app.heatCloud) {
      // Nothing to hold on to until the 3D view is back. Those Wrapped drew
      // or had cut ahead of time (prepareHeatCloud) are kept for a while
      // (CLOUD_IDLE_MS), while what they were made of stays: its button
      // asks for them again as soon as the closing dialog hands it the
      // focus back.
      if (left3D) forget(false);
      if (!leaving) draw(null);
      release();
      map.triggerRepaint();
      return;
    }
    // Wrapped's at full strength: the dialog hides what the heatmap steps
    // back for
    opacity =
      app.forcedHeatCloud || growing()
        ? 1
        : app.replayActive
          ? CLOUD_REPLAY_OPACITY
          : dimsHeatCloud(app)
            ? (dimmed ??= dimmedHeatmapOpacity())
            : 1;
    if (!map.isZooming()) lifted = isLiftedAt(map.getZoom());
    if (shown()) updatePoints();
    release();
    map.triggerRepaint();
  };

  // At once, not once the map is ready: the replay of all flights, whose
  // player follows the cloud as it is made, cuts its flights for the level
  // this takes at the end of a zoom (see heatCloudLevel), so this is to
  // come first among the map's listeners
  const zoomed = map.on("zoomend", (event: object) => {
    // Outside the 3D view the cloud follows the level itself, where the
    // map comes to rest: not on every jump of the replay's camera, nor on
    // the moves of Wrapped's intro (see REPLAY_CAMERA_MOVE)
    if (!isReplayCameraMove(event)) publishScale();
    const at = reliefLevel(map.getZoom());
    if (!isReplayCameraMove(event)) restZoom = map.getZoom();
    if (!isReplayCameraMove(event) && at !== atRest) {
      atRest = at;
      if (!app.threeDVisible && shown()) {
        updatePoints();
        map.triggerRepaint();
      }
    }
    if (lifted === isLiftedAt(map.getZoom())) return;
    lifted = !lifted;
    map.triggerRepaint();
  });
  app.signal.addEventListener("abort", () => zoomed.unsubscribe());

  onMapReady(app, "The heat cloud", () => {
    const signal = app.signal;
    app.store.subscribeKeys(CLOUD_KEYS, sync, { signal });
    // Whether the aviation chart is drawn changes the cloud's strength only
    // while the chart is on (dimsHeatCloud): a zoom across the band it is
    // drawn in synced the cloud with the chart off too, and cut it anew
    // in the middle of the zoom
    app.store.subscribe(
      "aviationInView",
      () => {
        if (app.aviationVisible) sync();
      },
      { signal },
    );
    // Cut around the view, or closer in than the last relief level, the
    // points are cut again for the view the map comes to rest at, in a
    // task of their own after the frame the move ends in. Not while the
    // map moves on by then, unless a scripted camera moves it, whose rest
    // is none the cloud follows (REPLAY_CAMERA_MOVE): the hotspot tour
    // turns over each place from the moment it arrives there (restCamera),
    // and every place after the first stayed dark.
    let recut: ReturnType<typeof setTimeout> | undefined;
    let scripted = false;
    const started = map.on("movestart", (event: object) => {
      scripted = isReplayCameraMove(event);
    });
    const moved = map.on("moveend", (event: object) => {
      if (isReplayCameraMove(event) || !shown()) return;
      clearTimeout(recut);
      recut = setTimeout(() => {
        if (signal.aborted || !shown() || (map.isMoving() && !scripted)) {
          return;
        }
        updatePoints();
      }, 0);
    });
    // A new base style, or one made anew, may have left the layer out
    const styled = map.on("styledata", () => {
      if (wanted()) place();
    });
    // The style that comes back after a lost WebGL context has none of the
    // custom layers of before (MapLibre warns of it at the loss), and the
    // layer's buffers went with the context. The shaders are tried again in
    // the new context: what failed may have failed with the old one.
    whenContextRestored(
      map,
      () => {
        broken = false;
        sync();
      },
      signal,
    );
    signal.addEventListener("abort", () => {
      clearTimeout(idle);
      clearTimeout(left);
      styled.unsubscribe();
      started.unsubscribe();
      moved.unsubscribe();
      clearTimeout(recut);
    });
    sync();
  });
}
