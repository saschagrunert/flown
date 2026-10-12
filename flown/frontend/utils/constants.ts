export const METERS_TO_FEET = 3.28084;
export const FEET_TO_METERS = 1.0 / METERS_TO_FEET;
export const NAUTICAL_MILES_TO_KM = 1.852;
export const KM_TO_NAUTICAL_MILES = 1.0 / NAUTICAL_MILES_TO_KM;
/** AGL threshold for cruise statistics */
export const CRUISE_ALTITUDE_THRESHOLD_FT = 1000;

/**
 * Widths below this get the phone layout: the mobile bar in place of the
 * control columns, and a phone-sized export (matches styles.css)
 */
export const MOBILE_BREAKPOINT_PX = 768;

/**
 * The most selected flights the profile draws and Replay plays one after
 * another: a day of them, each with room for its route at the profile's
 * width (ui/flightProfile.ts, ui/replayAll.ts). Replay all plays more.
 */
export const DAY_MAX_FLIGHTS = 8;

/**
 * The input of a visitor that the intro of a link to shared flights gives
 * way to (ui/shareIntro.ts): a key (KEYS_NOT_INPUT aside), click, touch,
 * drag or wheel. Before
 * it starts the app listens for them too, as the view is the visitor's
 * once they have moved it (MapApp.initialize)
 */
export const INPUT_EVENTS = [
  "pointerdown",
  "wheel",
  "keydown",
  "touchstart",
] as const;

/**
 * Keys that are no input of that kind: Tab moves on through the page, with
 * Shift and the other modifiers on their own, as a switch to another
 * window (Alt or Cmd and Tab) or a screen reader's keys press them. Escape
 * is one, and ends the intro.
 */
export const KEYS_NOT_INPUT = new Set([
  "Tab",
  "Shift",
  "Control",
  "Alt",
  "Meta",
]);

/**
 * Heights up to this get the phone layout too, whatever the width: a phone
 * held sideways, or a window as short, has no room for the control
 * columns (matches styles.css)
 */
export const PHONE_MAX_HEIGHT_PX = 480;

/**
 * Zoom comes in two units. MapLibre counts in 512 pixel tiles where Leaflet
 * counted in 256 pixel ones, so the same view is one level lower: state zoom
 * = map zoom + ZOOM_OFFSET. The code and the map speak the map's own unit.
 * Saved state and the `z` of a link stay in the old one, so a link shared
 * before the switch still shows the same area; `stateZoomToMap` and
 * `mapZoomToState` in mapHelpers are the only crossing points.
 */
export const ZOOM_OFFSET = 1;

/** Zoom limits of saved state and the URL `z`, in state (legacy) units */
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 20;

/** Zoom limits of the map itself, in map units: the two above, translated */
export const MAP_MIN_ZOOM = MIN_ZOOM - ZOOM_OFFSET;
export const MAP_MAX_ZOOM = MAX_ZOOM - ZOOM_OFFSET;

/**
 * How far the map tilts, in degrees: MapLibre's limit, all but level with
 * the ground, which the 3D view (calculations/lift.ts) is best seen from.
 * Past 60 a flat map shows its horizon, so the map has a sky above it (see
 * MAP_SKY), and MapLibre loads coarser tiles towards the vanishing point.
 */
export const MAP_MAX_PITCH = 85;

/**
 * The sky above the horizon of a steeply tilted map: the dark of the base
 * style, a shade lighter at the horizon, with the far ground fading into
 * it, so the map ends in a haze rather than an edge against nothing. A
 * style property, which the base style does not set; the app's styles
 * carry it (see FALLBACK_STYLE and withDataLayers).
 */
export const MAP_SKY = {
  "sky-color": "#0b0d12",
  "horizon-color": "#1b202b",
  "fog-color": "#0e0e0e",
  "sky-horizon-blend": 0.6,
  "horizon-fog-blend": 0.4,
  "fog-ground-blend": 0.75,
  "atmosphere-blend": 0,
} as const;

/**
 * Zoom of a view that names no zoom of its own: the map's first view, and
 * a link that carries a centre without `z`. Map units.
 */
export const DEFAULT_ZOOM = 9;

/**
 * Zoom auto-zoom follows the aircraft at: close enough to read the ground it
 * flies over. Map units.
 */
export const AUTO_ZOOM_FOLLOW = 15;

/** Auto-zoom does not zoom out beyond this level. Map units. */
export const AUTO_ZOOM_MIN = 8;

/**
 * The airport marker size for a zoom, largest first: the first entry whose
 * `minZoom` the map has reached names the size class, and below the last one
 * there is none. Map units.
 */
export const AIRPORT_SIZE_ZOOMS = [
  { minZoom: 13, sizeClass: "xlarge" },
  { minZoom: 11, sizeClass: "large" },
  { minZoom: 9, sizeClass: "medium" },
  { minZoom: 7, sizeClass: "medium-small" },
  { minZoom: 5, sizeClass: "small" },
] as const;

/** Below this zoom the airport markers have no labels. Map units. */
export const AIRPORT_HIDE_LABELS_BELOW_ZOOM = 4;

/**
 * Below this zoom the airport markers are hidden (size class "hidden"):
 * the map shows a continent in a few hundred pixels, the flights of a
 * pilot's years in one bloom of the heat, and their airports in a clump of
 * dots on top of it. Map units.
 */
export const AIRPORT_HIDE_MARKERS_BELOW_ZOOM = 2;

/**
 * Ids of the sources the map is created with. Every one exists, empty, from
 * the moment `mapReady` resolves; modules fill them with `setData` and never
 * add or remove one. All but the elevation tiles of the relief and the
 * satellite imagery, which come with their code the first time they are
 * drawn (ui/terrain.ts, ui/satellite.ts).
 */
export const MAP_SOURCES = {
  aviation: "aviation",
  heat: "heat",
  heatIsolated: "heat-isolated",
  heatLines: "heat-lines",
  selectionHighlight: "selection-highlight",
  replayRoute: "replay-route",
  pathsAltitude: "paths-altitude",
  pathsAirspeed: "paths-airspeed",
  pathsAltitudeSelected: "paths-altitude-selected",
  pathsAirspeedSelected: "paths-airspeed-selected",
  pathsAltitudeRibbons: "paths-altitude-3d",
  pathsAirspeedRibbons: "paths-airspeed-3d",
  pathsAltitudeSelectedRibbons: "paths-altitude-selected-3d",
  pathsAirspeedSelectedRibbons: "paths-airspeed-selected-3d",
  selectionHighlightRibbons: "selection-highlight-3d",
  replayTrail: "replay-trail",
  replayTrailRibbons: "replay-trail-3d",
  airportLabels: "airport-labels",
  terrain: "terrain",
  satellite: "satellite",
} as const;

/**
 * Ids of the layers the map is created with, one per source and named like
 * it, except for the heat lines, which are drawn twice: a wide blurred glow
 * and a thin core over it. The flights, the lines of a selection and the
 * replay trail have a source and a layer each for their lines and for their
 * ribbons at their altitude in the 3D view (see calculations/lift.ts). The
 * order here is the drawing order, bottom to top. All of them sit below the
 * first label layer of the base style, but the room of the airport codes
 * and of their dots: invisible labels on top of every layer, which the map
 * places first, so the place names give way (see ui/airportLabels.ts).
 */
export const MAP_LAYERS = {
  aviation: "aviation",
  heat: "heat",
  heatIsolated: "heat-isolated",
  heatLinesGlow: "heat-lines-glow",
  heatLinesCore: "heat-lines-core",
  selectionHighlight: "selection-highlight",
  replayRoute: "replay-route",
  pathsAltitude: "paths-altitude",
  pathsAirspeed: "paths-airspeed",
  pathsAltitudeSelected: "paths-altitude-selected",
  pathsAirspeedSelected: "paths-airspeed-selected",
  pathsAltitudeRibbons: "paths-altitude-3d",
  pathsAirspeedRibbons: "paths-airspeed-3d",
  pathsAltitudeSelectedRibbons: "paths-altitude-selected-3d",
  pathsAirspeedSelectedRibbons: "paths-airspeed-selected-3d",
  selectionHighlightRibbons: "selection-highlight-3d",
  replayTrail: "replay-trail",
  replayTrailRibbons: "replay-trail-3d",
  airportLabels: "airport-labels",
  airportDots: "airport-dots",
} as const;

/**
 * How the heat source merges the fixes when the map is zoomed out. The
 * worker does it (supercluster): up to `maxZoom` a tile holds clusters, each
 * at the centre of its fixes and carrying their number as `point_count`,
 * and adding up their weights as `w`, which the heat layer takes as its
 * weight. Closer in it holds the fixes.
 *
 * The intensity of a point halves with every level zoomed out (see
 * heatmapIntensity in ui/heatmapPaint.ts), and MapLibre adds the points up in a
 * half-float texture. Below about 0.004 a single point's share underflows there
 * and the whole heatmap vanishes, which with every fix drawn happens under zoom
 * 9. So the fixes are drawn as they are from zoom 9 on, and `maxZoom` is the
 * level below.
 *
 * A cluster gathers the fixes within `radius` pixels of its first one, so
 * along a track the clusters are about `radius` apart at a whole zoom and
 * just under twice that before the next level takes over, where the map
 * still draws the tiles of the level below, scaled up. At 6 that is 6 to
 * 12 px, well inside the 18 px a point reaches, and a lone track stays an
 * even line. At 12 it already shows as a string of beads, and at the reach
 * of a point the tracks fall apart into blobs.
 *
 * The share of a cluster cannot underflow. A pixel of the map at zoom z is
 * 40075 km * cos(latitude) / (512 * 2^z), which at 51 degrees north and
 * zoom 12 is 12 m. The fixes of a track are about 235 m apart, so 6 px of it
 * hold 6 * 12 * 2^(12 - z) / 235 = 0.31 * 2^(12 - z) fixes, while a point
 * weighs 0.0375 / 2^(12 - z). The zoom cancels: a cluster of a lone track
 * weighs about 0.0115 at every zoom, and where flights overlap it weighs
 * more. That holds for fixes as close as a flight logger writes them. A
 * fix without a neighbour in reach stays a point of its own, which is why
 * the weight of the heat layer has a floor (see heatmapWeight in
 * ui/heatmapPaint.ts).
 */
export const HEATMAP_CLUSTER = { radius: 6, maxZoom: 8 } as const;

/**
 * Where the heatmap hands over to the heat lines. The fixes of a track are
 * about 235 m apart, which is 10 px at zoom 11, 20 px at zoom 12 and 40 px
 * at zoom 13: however far a point reaches (see HEATMAP_RADIUS_PX), a track
 * falls apart into beads from about 12 on, and further in into scattered
 * dots. The heat lines draw the flights as lines instead, coloured by the
 * time spent around them (see calculations/heatLines.ts), so the busy
 * places still read as the hot ones while each circuit and taxi route
 * stays a line of its own.
 *
 * The lines fade in between `fromZoom` and `midZoom`, and only then does the
 * heatmap fade out, until `fullZoom`. Both at once looked muddy: a heatmap
 * at half opacity turns its white into grey and its blues into teal, and
 * that haze lay beside lines too faint yet to carry the colour. The heatmap
 * handed over a level earlier, from 10 to 11.5, and a map of a few towns
 * showed thin lines where a heatmap was still wanted; fading out from
 * 11.75, its widened glow lies round the lines as a halo on the way out.
 * Map units.
 */
export const HEAT_LINES = {
  fromZoom: 11,
  midZoom: 11.75,
  fullZoom: 12.75,
} as const;

/**
 * The layers the heatmap toggle shows and hides: the heatmap first (the
 * e2e driver reads it off the front), then the lines it hands over to, and
 * the heatmap of an isolated selection, which only the one of them that
 * is not isolated draws (see DataManager.applyHeatmapEmphasis)
 */
export const HEATMAP_LAYER_IDS = [
  MAP_LAYERS.heat,
  MAP_LAYERS.heatLinesGlow,
  MAP_LAYERS.heatLinesCore,
  MAP_LAYERS.heatIsolated,
] as const;

/**
 * Longest frame the replays, their camera and its springs are worked out
 * over (s): a frame after a stall (a busy main thread, a laptop waking up)
 * would jump them on by the whole stall
 */
export const MAX_FRAME_S = 0.1;
