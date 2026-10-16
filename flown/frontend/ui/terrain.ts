/**
 * Terrain - the relief under the 3D view
 *
 * The 3D view draws the relief and stands the flights on it, at every
 * zoom, exaggerated as much as they are (calculations/lift.ts). The layer
 * manager decides when, and for which level (terrainActive, reliefLevel),
 * in the task it cuts the ribbons on their ground; this module makes the
 * map follow. The globe only shades the relief (reliefShaded) and leaves
 * the relief itself out, whose mesh MapLibre 6.10 breaks the ribbons up
 * on. It comes with the feature bundle: most visits never turn the 3D
 * view on.
 *
 * The elevation tiles are AWS's Terrarium tiles, the ones the build samples
 * the ground from (flown/terrain.py), so the relief and the ground
 * the flights are measured against are the same model, smoothed as the
 * map draws it at each level. The browser fetches them only while the
 * relief is drawn or shaded, and the map shows their credit only then.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import {
  followsLevel,
  liftExaggeration,
  ribbonId,
  switchesExaggeration,
  TERRAIN_TILE_MAX_ZOOM,
  TERRAIN_TILE_SIZE_PX,
} from "../calculations/lift";
import { EXAGGERATION_STATE, ribbonHeights } from "../calculations/ribbonPaint";
import { MAP_LAYERS, MAP_SOURCES } from "../utils/constants";
import {
  cssVar,
  hasLostContext,
  isReplayCameraMove,
  onMapReady,
  whenContextRestored,
} from "../utils/mapHelpers";
import { aboveGround } from "./satellite";
import { PATH_RIBBON_SOURCES, RIBBON_SOURCES } from "./reliefState";

const TERRAIN_TILE_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";

/**
 * The shading of the relief, from the same elevation tiles. It is not a
 * layer the map is created with: it only exists once the relief has been
 * drawn, and belongs with the base map rather than with the app's layers.
 */
export const HILLSHADE_LAYER = "terrain-hillshade";

/**
 * Give every layer of ribbons the paint that lifts them (see
 * ribbonHeights): the map creates them without it, so its expressions come
 * with this bundle rather than with the first visit. Every ribbon is
 * written by this bundle, in the turn the 3D view follows the relief or
 * later, and the map pauses a source whose paint changed until its worker
 * has the new layer, so none is drawn without it. A base style the map
 * applies as a difference keeps it (see withDataLayers in mapLayers.ts);
 * one built anew, a frame later, from the style of before, and the style
 * restored after a lost WebGL context, from the one of the loss, may come
 * without it, and get it again as they load. A layer that has it is left
 * alone.
 */
function paintRibbons(map: MapLibreMap): void {
  let paint: ReturnType<typeof ribbonHeights> | undefined;
  for (const id of RIBBON_SOURCES) {
    // Every style event comes here: a layer that has its paint keeps it,
    // and is left alone rather than set again and drawn again
    if (
      !map.getLayer(id) ||
      map.getPaintProperty(id, "fill-extrusion-height") !== undefined
    ) {
      continue;
    }
    paint ??= ribbonHeights();
    const { base, height } = paint;
    map.setPaintProperty(id, "fill-extrusion-base", base, { validate: false });
    map.setPaintProperty(id, "fill-extrusion-height", height, {
      validate: false,
    });
  }
}

/**
 * Switch the relief on and off with terrainActive, its exaggeration with
 * reliefLevel, and its shading with reliefShaded, from now on. Each switch
 * builds the relief anew and throws away what the map drew onto it (a few
 * milliseconds), which is why it follows the level, once a zoom has
 * ended, and never the zoom itself. The ribbons switch their exaggeration
 * with it, in the same frame (see exaggerateRibbons).
 */
export function followTerrain(app: MapApp): void {
  const map = app.map;
  if (!map) return;
  const apply = (): void => {
    const active = app.terrainActive;
    const shaded = app.reliefShaded;
    if (active || shaded) addSource(map);
    shade(map, shaded);
    const exaggeration = liftExaggeration(app.reliefLevel);
    const terrain = map.getTerrain();
    if (!active) {
      if (terrain) map.setTerrain(null);
      return;
    }
    if (terrain?.exaggeration === exaggeration) return;
    map.setTerrain({ source: MAP_SOURCES.terrain, exaggeration });
  };
  // The relief is part of the style, so it waits for one
  onMapReady(app, "The relief", () => {
    const signal = app.signal;
    paintRibbons(map);
    const settle = settleRibbons(app, map, signal);
    const labels = thinFarLabels(app, map);
    const ribbons = exaggerateRibbons(app, map, signal);
    // Onto or off the relief the ribbons stand on other ground; another
    // level of it they stand on already (see ribbonHeights), and take its
    // exaggeration along with the relief, all but those the map does not
    // know by an id (see followsLevel), which wait out of sight for their
    // new cut then
    app.store.subscribe("terrainActive", () => {
      settle.start();
      apply();
    });
    app.store.subscribe("reliefLevel", (level) => {
      if (!ribbons(level)) settle.start();
      apply();
    });
    app.store.subscribe("reliefShaded", apply);
    app.store.subscribe("terrainActive", labels.thin);
    // MapLibre restores the relief with the style after a lost WebGL
    // context, but some of what it draws onto it stays black until the
    // relief is built anew
    whenContextRestored(
      map,
      () => {
        map.setTerrain(null);
        ribbons(null);
        settle.restyle();
        apply();
      },
      signal,
    );
    // A move ends on ground whose elevation tiles land after it: the map
    // raises its centre onto them then, and everything drawn shifts on the
    // screen, without a move event. The markers and popups follow the
    // map's moves and would stay where the ground was until the next one,
    // an airport a few dozen pixels off its field. A "terrain" event has
    // them follow every frame until the map has loaded, as when the relief
    // is switched on (MapLibre 6.10's markers). Not for every frame of
    // the replay's camera, which rests of its own: it updates the whole
    // style. The far labels follow that camera, which a chase flies for
    // minutes without a rest, but are walked only once it has reached
    // another zoom level or tilt.
    const moved = map.on("moveend", (event) => {
      if (isReplayCameraMove(event)) {
        labels.follow();
        return;
      }
      if (map.getTerrain()) map.fire("terrain");
      labels.thin();
    });
    // A new base style drops the shading, which is none of the app's layers
    // for `withDataLayers` to carry; it goes back where it belongs in it.
    // Its labels come with the zoom ranges of the style, which the far
    // labels of a tilted 3D view are left out of anew.
    const styled = map.on("styledata", () => {
      paintRibbons(map);
      if (app.reliefShaded && !map.getLayer(HILLSHADE_LAYER)) apply();
      labels.thin();
    });
    // For as long as the app lives, like its other map events
    signal.addEventListener("abort", () => {
      moved.unsubscribe();
      styled.unsubscribe();
    });
    // The layer manager may have switched it on already, as it loaded this
    if (app.terrainActive) settle.start();
    apply();
  });
}

/** The elevation tiles, once: `withDataLayers` carries them from then on */
function addSource(map: MapLibreMap): void {
  if (map.getSource(MAP_SOURCES.terrain)) return;
  map.addSource(MAP_SOURCES.terrain, {
    type: "raster-dem",
    tiles: [TERRAIN_TILE_URL],
    encoding: "terrarium",
    tileSize: TERRAIN_TILE_SIZE_PX,
    maxzoom: TERRAIN_TILE_MAX_ZOOM,
    attribution:
      'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">Terrain Tiles</a> (Mapzen and others)',
  });
}

/**
 * Show the shading while the relief is drawn or, on the globe, would be,
 * hide it otherwise: created the first time, directly above the ground of
 * the base map (land cover, parks, water) and the satellite imagery on it
 * (see aboveGround), and so below its roads, runways, buildings and labels
 * and every layer of the app. Its colours are the stylesheet's
 * (--terrain-*), subtle on the dark map, so the heat and the flights stay
 * what reads.
 *
 * It shares its elevation tiles with the relief. MapLibre draws the relief
 * from tiles it takes for twice as large as the source says (512 px), so
 * in the 3D view the shading is a level coarser than on the globe, and the
 * map warns of the shared source in the console once per session. A second
 * source of the same tiles would shade finer, but asks for other tiles: a
 * session into the 3D view and two levels in and out loaded 89 elevation
 * tiles in 130 requests instead of 41 in 67, each decoded in the worker,
 * for a shading that is meant to stay in the background.
 */
function shade(map: MapLibreMap, shown: boolean): void {
  if (map.getLayer(HILLSHADE_LAYER)) {
    map.setLayoutProperty(
      HILLSHADE_LAYER,
      "visibility",
      shown ? "visible" : "none",
    );
    return;
  }
  if (!shown) return;
  const shadow = cssVar("--terrain-shadow") || "rgba(0, 0, 0, 0.7)";
  map.addLayer(
    {
      id: HILLSHADE_LAYER,
      type: "hillshade",
      source: MAP_SOURCES.terrain,
      paint: {
        "hillshade-shadow-color": shadow,
        "hillshade-highlight-color":
          cssVar("--terrain-highlight") || "rgba(255, 255, 255, 0.12)",
        "hillshade-accent-color": shadow,
        "hillshade-exaggeration":
          Number.parseFloat(cssVar("--terrain-exaggeration")) || 0.5,
      },
    },
    aboveGround(map),
  );
}

/** Whether a source of `ids` the map has has not drawn its data yet */
function loading(map: MapLibreMap, ids: readonly string[]): boolean {
  return ids.some((id) => map.getSource(id) && !map.isSourceLoaded(id));
}

/**
 * The sources of ribbons whose tiles are waited for: all of them, but the
 * replay's trail while the replay plays. That writes the trail anew in
 * every frame, so its tiles are never all loaded: the ribbons stayed out
 * of sight for the whole SETTLE_MAX_MS at every change of the ground, and
 * the cuts of the levels before were never let go of (see
 * exaggerateRibbons). The trail is cut for the new level in the frames
 * that follow the change anyway.
 */
function awaitedRibbons(app: MapApp): readonly string[] {
  return app.replayState.playing ? PATH_RIBBON_SOURCES : RIBBON_SOURCES;
}

/**
 * What gives the ribbons cut for another relief level the exaggeration of
 * the level the map is drawn for, as the store moves to the level `level`,
 * and tells whether all the ribbons the map may still draw stay on the
 * relief until they are cut for it (see followsLevel); null gives the
 * states again to a map that has lost them with its style.
 *
 * The map may still draw the cut of every level since all the ribbons last
 * landed; the layer manager empties those of a mode out of sight. The cuts
 * of a level the map knows by an id get the exaggeration of the new level
 * through a feature state for that id, which the map applies to all of
 * their tiles in the frame the relief switches. The cut for the new level
 * has an id no state was given (see ribbonId), and gets none: MapLibre
 * works out the paint of every feature of an id it has a state for anew in
 * each tile it loads. Once all the ribbons have landed, the old cuts and
 * their ids are gone for good.
 */
function exaggerateRibbons(
  app: MapApp,
  map: MapLibreMap,
  signal: AbortSignal,
): (level: number | null) => boolean {
  const cutOf = (level: number): { level: number; id: number | null } => ({
    level,
    id: switchesExaggeration(level) ? ribbonId(level, app.relief.epoch) : null,
  });
  /** The cuts the map may draw: their level, and their id or null */
  let cuts = [cutOf(app.reliefLevel)];
  // The exaggeration each id's ribbons were given
  const given = new Map<number, number>();
  const give = (): void => {
    const exaggeration = liftExaggeration(app.reliefLevel);
    for (const { level, id } of cuts) {
      if (id === null) continue;
      const own = liftExaggeration(level) === exaggeration;
      if (own ? !given.has(id) : given.get(id) === exaggeration) continue;
      for (const source of RIBBON_SOURCES) {
        if (!map.getSource(source)) continue;
        if (own) {
          map.removeFeatureState({ source, id }, EXAGGERATION_STATE);
        } else {
          map.setFeatureState(
            { source, id },
            { [EXAGGERATION_STATE]: exaggeration },
          );
        }
      }
      if (own) given.delete(id);
      else given.set(id, exaggeration);
    }
  };
  const landed = (): void => {
    if (loading(map, awaitedRibbons(app))) return;
    map.off("render", landed);
    cuts = [cutOf(app.reliefLevel)];
    given.clear();
  };
  // A map the app has let go of is waited on no longer
  signal.addEventListener("abort", () => map.off("render", landed));
  return (level) => {
    if (level === null) {
      given.clear();
      give();
      return true;
    }
    const follow = cuts.every((drawn) => followsLevel(drawn.level, level));
    cuts.push(cutOf(level));
    give();
    map.off("render", landed);
    map.on("render", landed);
    return follow;
  };
}

/**
 * The longest the ribbons stay hidden as the ground changes. Settling takes
 * a few frames, well under a second on a GPU; in software WebGL a frame of
 * the relief takes seconds, and waiting for every tile would leave the
 * flights off the map for a minute. Past this they show on whatever ground
 * has landed.
 */
const SETTLE_MAX_MS = 3000;

/**
 * What hides the ribbons, the replay's trail too, until the map has drawn
 * them cut on their new ground and the relief under them, or for
 * SETTLE_MAX_MS at most (`start`): the tiles of a `setData` land one by
 * one, and the elevation tiles after the relief is switched, so for a
 * while some ribbons would stand on the ground of the other view. Asked
 * after every frame, since the relief asks for its tiles as it is drawn;
 * not on `idle`, which waits for the base map and its labels as well.
 * The layer manager hides the ribbons of the colour layers; this hides
 * the trail and the lines of a selection, whose opacity nobody else sets.
 * `restyle` gives them the opacity they have now again, to a style the
 * map has built anew after a lost WebGL context: MapLibre builds it from
 * the style at the loss, whose ribbons may have been hidden then.
 */
function settleRibbons(
  app: MapApp,
  map: MapLibreMap,
  signal: AbortSignal,
): { start: () => void; restyle: () => void } {
  // Each layer with the opacity the map was made with
  const own = [
    MAP_LAYERS.replayTrailRibbons,
    MAP_LAYERS.replayTrailTipRibbons,
    MAP_LAYERS.selectionHighlightRibbons,
  ].map((id) => ({
    id,
    opacity: map.getPaintProperty(id, "fill-extrusion-opacity") as number,
  }));
  const restyle = (): void => {
    // Without its context the map has no style to write to; the restore
    // calls this again
    if (hasLostContext(map)) return;
    for (const { id, opacity } of own) {
      map.setPaintProperty(
        id,
        "fill-extrusion-opacity",
        app.relief.ribbonsShown ? opacity : 0,
      );
    }
  };
  const show = (shown: boolean): void => {
    app.relief.showRibbons(shown);
    restyle();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = (): void => {
    clearTimeout(timer);
    map.off("render", settled);
    show(true);
  };
  // A map the app has let go of is waited on no longer
  signal.addEventListener("abort", () => {
    clearTimeout(timer);
    map.off("render", settled);
  });
  const settled = (): void => {
    if (!loading(map, [...awaitedRibbons(app), MAP_SOURCES.terrain])) done();
  };
  const start = (): void => {
    if (app.relief.ribbonsShown) map.on("render", settled);
    // Another change of the ground starts the wait anew
    clearTimeout(timer);
    timer = setTimeout(done, SETTLE_MAX_MS);
    show(false);
  };
  return { start, restyle };
}

/**
 * The tilt of the 3D view from which the far labels of the base map are
 * left out (see thinFarLabels): the view's own is 50 degrees
 */
const THIN_LABELS_PITCH = 45;

/**
 * How many zoom levels coarser than the map's zoom the tiles are whose
 * labels a tilted 3D view still draws (see thinFarLabels)
 */
const LABEL_TILE_LEVELS = 1;

/** The app's own layers, which keep their zoom ranges */
const APP_LAYERS: ReadonlySet<string> = new Set(Object.values(MAP_LAYERS));

/**
 * What leaves the labels of the base map out of its far tiles while the
 * relief is drawn under a tilted map; call it as the map comes to rest or
 * its style changes. Towards the horizon the map draws ever coarser tiles,
 * and their labels stood upright at full size over the fog: at zoom 6.5 and
 * a tilt of 70 degrees over the Alps, the names of Sudan, Chad and Lagos
 * floated along the top of the view. MapLibre has no expression for the
 * distance from the middle of the view, and a filter by the distance to a
 * point would lay every tile out anew at every rest of the map. The zoom of
 * a tile says the same in a tilted view: every label layer of the base
 * style starts at most LABEL_TILE_LEVELS levels below the map's zoom, and
 * MapLibre leaves a layer out of every tile below its start. The ranges
 * change only as the map's whole zoom level does, which lays the base map's
 * tiles out once; the ranges of the style come back as the map lies flat
 * or leaves the relief. `thin` walks every label layer; `follow`, for the
 * frames of the replay's camera, only when the start it asks for is not the
 * one the last walk gave them.
 */
function thinFarLabels(
  app: MapApp,
  map: MapLibreMap,
): { thin: () => void; follow: () => void } {
  /**
   * The start of every label layer as the style has it, and the one the
   * last walk gave it, by its id: a layer that starts elsewhere comes from a
   * new style. After a lost WebGL context MapLibre builds new layers from
   * the style it kept, which start where the last walk had them; taken for
   * the style's own, they kept the far labels out for good. Left as it
   * is: a new base style whose layer of the same id starts just where the
   * last walk had it is taken for the old one, and its labels show below
   * its own start once the map lies flat. The restore and the swap both
   * arrive through `setStyle`, and nothing cheaper than the whole style
   * tells them apart.
   */
  const own = new Map<string, [style: number, given: number]>();
  /** The start the last walk gave the layers, undefined before the first */
  let given: number | null | undefined;
  const wanted = (): number | null =>
    app.terrainActive && map.getPitch() >= THIN_LABELS_PITCH
      ? Math.floor(map.getZoom()) - LABEL_TILE_LEVELS
      : null;
  const thin = (): void => {
    const start = wanted();
    given = start;
    for (const id of map.getLayersOrder()) {
      if (APP_LAYERS.has(id)) continue;
      const layer = map.getLayer(id);
      if (layer?.type !== "symbol") continue;
      const now = layer.minzoom ?? 0;
      const known = own.get(id);
      const style = known?.[1] === now ? known[0] : now;
      const minzoom = Math.max(style, start ?? 0);
      own.set(id, [style, minzoom]);
      if (now === minzoom) continue;
      map.setLayerZoomRange(id, minzoom, layer.maxzoom ?? 24);
    }
  };
  return {
    thin,
    follow: () => {
      if (wanted() !== given) thin();
    },
  };
}
