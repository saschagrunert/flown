/**
 * The look of the heatmap and of the heat lines it hands over to: the
 * MapLibre paint expressions, pure functions of the constants below. How
 * far the heat is scaled for them is worked out by the year worker (see
 * calculations/heatExposure.ts, which also holds the reference of the
 * kernel both are tuned for). The data manager gives the layers this paint
 * and changes their opacity.
 */
import type {
  ExpressionSpecification,
  HeatmapLayerSpecification,
  LineLayerSpecification,
} from "maplibre-gl";
import {
  HEAT_LINES,
  HEATMAP_CLUSTER,
  MAP_LAYERS,
  MAP_MAX_ZOOM,
} from "../utils/constants";
import { HEAT_LINE_FLIGHT_SECONDS } from "../calculations/heatTone";
import {
  HEAT_FLIGHT_DENSITY,
  HEATMAP_REFERENCE_INTENSITY,
  HEATMAP_REFERENCE_RADIUS_PX,
  HEATMAP_REFERENCE_ZOOM,
} from "../calculations/heatExposure";

/*
 * The look of the heatmap, tuned side by side against what leaflet.heat drew
 * for the same flights (radius 10, blur 15 and minOpacity 0.25). The numbers
 * live here so that a later visual pass has one place to turn, all but the
 * reference of the kernel, which the exposure shares
 * (calculations/heatExposure.ts).
 */

/**
 * Reach of one point in pixels by map zoom, `[zoom, px]`, between two stops
 * linearly. leaflet.heat's radius plus its blur was 25, and 22 (the
 * reference reach) drew a route flown once over a country as a band as
 * wide and as even as a busy corridor; 18 keeps the routes a web and lets
 * the corridors stand out. Closer in the reach of before was a haze: from
 * zoom 8 to 10 the routes of a region, a few kilometres apart, merged into
 * one blue fog around the home field, and its circuits into one blot. So
 * it narrows over a region, to 13 px at 10. Not while the clusters are
 * drawn, up to the level after their last: scaled up towards it they lie
 * up to twice their radius apart, and under a narrower reach a lone track
 * fell apart into beads (see HEATMAP_CLUSTER).
 *
 * Further in the fixes of a track draw apart on the screen (see
 * HEAT_LINES), and the reach widens again as the heatmap is kept on for
 * the towns around a field: 13 px left a track beaded from 11.5 on, 16 px
 * at 11 and 24 at 12 keep it a line until the heat lines take over. On the
 * ground that is still narrower than at 10, under half of it at 12.
 */
export const HEATMAP_RADIUS_PX: readonly (readonly [number, number])[] = [
  [HEATMAP_CLUSTER.maxZoom + 1, 18],
  [10, 13],
  [11, 16],
  [12, 24],
];
/** Opacity of the layer when no colour layer is drawn over it */
export const HEATMAP_OPACITY = 1;
/**
 * Colour and opacity by density: `[density, "r, g, b", alpha]`.
 *
 * One hue that gets lighter, from deep blue over azure and cyan to white:
 * on the dark base map more flights read as more light. A rainbow from blue
 * over green to orange used to be here; it made most of the map green,
 * spoke in the blue, green and yellow of the speed ramp and ended in the
 * orange of the altitude ramp (see colors.ts). This one borrows from
 * neither, and the places flown over so often that the density is cut off
 * at 1 glow white instead of standing as a flat block of colour.
 *
 * leaflet.heat drew every point as a translucent disc, and discs painted
 * over one another saturate: fifty flights over the home airfield came out
 * a little warmer than one, not fifty times as hot. The map adds densities
 * up instead, so on an even scale one track is nearly invisible next to the
 * places flown over every week. The stops therefore sit closer together the
 * lower they are: most are four times the one before, so a single
 * track is blue, a busy route cyan, and only the airfields themselves come
 * near white, and what is more than the knee of the heat is rolled off
 * before it is drawn (see heatTone), so the stops beyond it stand for ever
 * more flights.
 *
 * Most of the map is a route flown once to a few times, so the low end has
 * the most steps of lightness, with a stop of its own at two flights: over
 * the dark base map a quarter of a flight, one, two and four come out each
 * about half as light again as the one before, four flights' worth well
 * over twice as light as one where it was not quite twice, so a leg flown
 * five times stands out from one flown once. The two faintest stops are
 * the most transparent, so a route flown once is a soft line rather than a
 * band of even blue with crisp edges, and still off the base map; the heat
 * lines take the colours of the stops and not their opacity. The colours
 * in between are MapLibre's own blend of the stops either side.
 */
export const HEATMAP_GRADIENT: readonly (readonly [number, string, number])[] =
  [
    [0, "10, 40, 140", 0],
    [0.004, "30, 80, 210", 0.22],
    [HEAT_FLIGHT_DENSITY, "30, 105, 230", 0.5],
    [0.03, "40, 150, 250", 0.72],
    [0.06, "60, 195, 255", 0.85],
    [0.25, "120, 225, 255", 0.9],
    [0.6, "200, 245, 255", 0.96],
    [1, "255, 255, 255", 1],
  ];

/**
 * The heat lines the heatmap hands over to (see HEAT_LINES) speak its
 * colours: each stop of the gradient above, from the faintest on, stands
 * for the seconds spent around a stretch that as many flights' worth leave
 * as the density of the stop stands for in the heatmap. So a place flown
 * over n times is drawn in the same colour on either side of the hand-over:
 * a route flown once azure, a busy route cyan, and the circuits, taxiways,
 * holding points and apron flown and taxied every week white.
 */
const HEAT_LINE_SECONDS = HEATMAP_GRADIENT.slice(1).map(
  ([density]) => (HEAT_LINE_FLIGHT_SECONDS * density) / HEAT_FLIGHT_DENSITY,
);

/**
 * The lines are drawn as a wide blurred glow and a thin core over it, both
 * in the colour of their heat; the core is fainter where less time was
 * spent. Widths in pixels by map zoom, opacities at full strength. The
 * glow is at its widest and strongest where the lines take over: it keeps
 * some of the weight of the heatmap's halo fading out over them, where
 * the thin cores alone dropped the map from a glow to hairlines, and it
 * settles to `closeIn` by zoom 16. Before 12 it grows with the map, as
 * wide on the ground at 11 as at 12: there it fades in over the heatmap
 * still drawn whole, and 10 px of it from 11 on cost frames for a glow
 * the heatmap covers.
 */
const HEAT_LINE_GLOW = {
  opacity: 0.3,
  closeIn: [16, 0.18],
  width: [11, 5, 12, 10, 16, 12],
  blur: [11, 4, 12, 8, 16, 9],
} as const;
const HEAT_LINE_CORE = {
  /** Opacity by heat: `[seconds, opacity]` */
  opacity: [
    [HEAT_LINE_SECONDS[0]!, 0.45],
    [HEAT_LINE_SECONDS[3]!, 0.8],
    [HEAT_LINE_SECONDS[5]!, 1],
  ],
  /**
   * Width by zoom and heat, `[zoom, px of the coolest, px of the hottest]`:
   * a busy route reads by its weight as well as its colour, and the many
   * flights that passed a place once stay hairlines behind it
   */
  width: [
    [12, 0.75, 2],
    [16, 1.5, 4],
  ],
} as const;

/**
 * Intensity of a point by zoom. The fixes of a track are a fixed distance
 * apart on the ground, so every level zoomed out puts twice as many of them
 * under one pixel of the track and the density there doubles. Halving the
 * intensity per level (an exponential interpolation of base 2 between two
 * stops that are themselves a power of two apart is exactly 2^zoom) cancels
 * that, and a single track keeps about the same colour at every zoom.
 *
 * Above the reference zoom the fixes no longer overlap: they are dots, and
 * the density of a dot does not depend on the zoom. The intensity stays
 * where it is from there on, or every dot would end up red.
 *
 * Clusters (see HEATMAP_CLUSTER) leave the curve as it is. The density at
 * a pixel is the sum of weight times kernel over the points around it, and
 * a cluster carries the weight of its fixes, only moved to their centre. No
 * fix moves further than twice the cluster radius, about half the kernel's,
 * and most far less, so the sum along a track is the one the fixes
 * themselves would give.
 *
 * The reach of a point narrows closer in (HEATMAP_RADIUS_PX), and the
 * intensity grows as much, so the ridge of a track keeps its height: a
 * stop per half level (HEATMAP_STOPS), between which the base 2 follows
 * the halving exactly and the reach to within a few per cent.
 */
function heatmapIntensity(): ExpressionSpecification {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    ...HEATMAP_STOPS.flatMap((zoom) => [zoom, intensityAt(zoom)]),
    Math.max(MAP_MAX_ZOOM, HEATMAP_REFERENCE_ZOOM + 1),
    intensityAt(HEATMAP_REFERENCE_ZOOM),
  ] as ExpressionSpecification;
}

/**
 * The zooms the intensity and the weight of the heatmap have a stop at:
 * every half level up to the reference zoom, since the reach of a point
 * narrows within one (see HEATMAP_RADIUS_PX)
 */
const HEATMAP_STOPS = Array.from(
  { length: 2 * HEATMAP_REFERENCE_ZOOM + 1 },
  (_, i) => i / 2,
);

/** The reach of a point at `zoom`, see HEATMAP_RADIUS_PX */
export function heatmapRadiusPx(zoom: number): number {
  const next = HEATMAP_RADIUS_PX.findIndex(([stop]) => stop > zoom);
  if (next === 0) return HEATMAP_RADIUS_PX[0]![1];
  if (next < 0) return HEATMAP_RADIUS_PX[HEATMAP_RADIUS_PX.length - 1]![1];
  const [z0, r0] = HEATMAP_RADIUS_PX[next - 1]!;
  const [z1, r1] = HEATMAP_RADIUS_PX[next]!;
  return r0 + ((r1 - r0) * (zoom - z0)) / (z1 - z0);
}

/**
 * What heatmapIntensity comes to at `zoom`: halved per level out from the
 * reference zoom, and as much more as the reach of a point is narrower
 * than the reference reach
 */
export function intensityAt(zoom: number): number {
  return (
    (HEATMAP_REFERENCE_INTENSITY * HEATMAP_REFERENCE_RADIUS_PX) /
    heatmapRadiusPx(Math.min(zoom, HEATMAP_REFERENCE_ZOOM)) /
    2 ** Math.max(HEATMAP_REFERENCE_ZOOM - zoom, 0)
  );
}

/**
 * The first zoom at which the fixes are drawn as they are, and what one of
 * them contributes there, weight times intensity. That is the least a drawn
 * point may contribute: see heatmapWeight.
 */
const HEATMAP_FIXES_FROM_ZOOM = HEATMAP_CLUSTER.maxZoom + 1;
export const HEATMAP_LEAST_CONTRIBUTION = intensityAt(HEATMAP_FIXES_FROM_ZOOM);
/**
 * The least a point contributes where the fixes are drawn as they are:
 * well under what a fix of weight 1 does, so only the lightest points are
 * lifted, and still with a kernel half as wide as that fix's (see
 * heatmapWeight)
 */
export const HEATMAP_LEAST_POINT_CONTRIBUTION = 0.001;
/**
 * The heat MapLibre's cut of a kernel takes out of a point, weight times
 * intensity, whatever its weight: 1.3 times the least that is drawn at all
 * (1 / 255 / 16 over the Gaussian's peak, 0.000614), which drew the fixes
 * of the apron merged (see heatmapWeight) closest to how they were drawn
 * one by one
 */
const HEATMAP_CUT_CONTRIBUTION = 0.0008;

/**
 * Weight of a drawn point by zoom: its heat, `w` (see drawHeat in
 * services/heatSource.ts), and a cluster (see HEATMAP_CLUSTER) the heat of
 * the fixes it stands for. A fix of a track weighs about 1, the time spent
 * around it in units of the few seconds a logger writes a fix in.
 *
 * But not every fix finds a cluster. The exporter keeps the vertices a KML
 * has, and those of a planned route or a slow logger are kilometres apart,
 * further than the cluster radius reaches. Such a fix stays a point of its
 * own at every zoom, of the capped heat of its segment (see heatWeight),
 * while the intensity keeps halving. MapLibre sizes the kernel of a point
 * from weight times intensity: under about 0.004 the
 * kernel shrinks, and under 0.0006 its size is not a number at all. So the
 * weight never lets a point contribute less than a fix does at the first
 * zoom without clusters, where it is a faint dot: at zoom z that takes a
 * weight of intensity(first) / intensity(z), one more power of two per
 * level out. Tried and dropped: a floor four times as high shows a sparse
 * track as a line at every zoom, but it also lifts the clusters of a lone
 * normal track, which then changes colour at the first zoom without them.
 *
 * A cluster of a normal track holds more heat than that at every zoom (see
 * HEATMAP_CLUSTER), so the floor leaves it alone. `zoom` may only be the
 * input of a top-level interpolation, hence a stop per half level with the
 * floor inside (HEATMAP_STOPS). Between two the floor falls as the
 * intensity grows, which the base 1/2 follows exactly where the reach
 * stays and to within a few per cent where it narrows; a heat above both
 * floors is the same at both stops and stays.
 *
 * Where the fixes are drawn as they are, a fix weighs its heat, which is
 * less than 1 for one a second or less on (a logger that writes every
 * second), and less again under an exposure below 1. Under the 0.0006 such
 * a point would drop out, and a track of them with it, so it keeps
 * HEATMAP_LEAST_POINT_CONTRIBUTION down to the zoom from which the
 * intensity stays.
 *
 * A point of the source may be several fixes of one pixel, `n` of them
 * (see mergedPoints in services/heatSource.ts), and is drawn as they were.
 * Each of them would have been lifted to the floor on its own, so the
 * floor of such a point is `n` times as high. And MapLibre cuts every
 * kernel off where it falls under 1 / 255 / 16, which takes about as much
 * out of a light point as out of a heavy one, HEATMAP_CUT_CONTRIBUTION:
 * one point where there were `n` loses that once instead of `n` times, so
 * it weighs as much less for every fix beyond the first. Without the two
 * the apron, hundreds of light fixes on top of one another, lost its white
 * or burned out into a blot.
 */
function heatmapWeight(): ExpressionSpecification {
  const fixes: ExpressionSpecification = ["coalesce", ["get", "n"], 1];
  return [
    "interpolate",
    ["exponential", 0.5],
    ["zoom"],
    ...HEATMAP_STOPS.flatMap((zoom) => [
      zoom,
      zoom < HEATMAP_FIXES_FROM_ZOOM
        ? ["max", ["get", "w"], HEATMAP_LEAST_CONTRIBUTION / intensityAt(zoom)]
        : [
            "-",
            [
              "max",
              ["get", "w"],
              [
                "*",
                fixes,
                HEATMAP_LEAST_POINT_CONTRIBUTION / intensityAt(zoom),
              ],
            ],
            [
              "*",
              ["-", fixes, 1],
              HEATMAP_CUT_CONTRIBUTION / intensityAt(zoom),
            ],
          ],
    ]),
  ] as ExpressionSpecification;
}

/** Colour and opacity by density, see HEATMAP_GRADIENT */
function heatmapColor(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["heatmap-density"],
    ...HEATMAP_GRADIENT.flatMap(([density, rgb, alpha]) => [
      density,
      `rgba(${rgb}, ${alpha})`,
    ]),
  ] as ExpressionSpecification;
}

/**
 * The opacity `curve` gives by zoom, `[zoom, opacity]` stops of numbers
 * joined linearly, times `by` at the zooms of `band`: one interpolation by
 * zoom, as the paint of a layer takes the zoom once, at the top. The step
 * at each end of the band is a ramp a thousandth of a zoom long. It follows
 * the zoom in every frame of a pinch, where an opacity set when the map
 * came to rest lagged behind.
 */
export function dimmedWithin(
  curve: ExpressionSpecification,
  by: number,
  [from, to]: readonly [number, number],
): ExpressionSpecification {
  const stops = curve.slice(3) as number[];
  /** The opacity of `curve` at `zoom` */
  const at = (zoom: number): number => {
    // The first stop at `zoom` or after it
    const i = stops.findIndex((value, j) => j % 2 < 1 && value >= zoom);
    // Before the first stop its opacity, after the last that one's
    if (i < 1) return stops.at(i || 1)!;
    const t = (zoom - stops[i - 2]!) / (stops[i]! - stops[i - 2]!);
    return stops[i - 1]! + t * (stops[i + 1]! - stops[i - 1]!);
  };
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    ...[
      ...new Set([
        ...stops.filter((_, j) => j % 2 < 1),
        from - 1e-3,
        from,
        to - 1e-3,
        to,
      ]),
    ]
      .sort((a, b) => a - b)
      .flatMap((zoom) => [
        zoom,
        at(zoom) * (zoom >= from && zoom < to ? by : 1),
      ]),
  ] as ExpressionSpecification;
}

/**
 * Opacity by zoom across the hand-over to the heat lines: `opacity` on the
 * heatmap's side of it, nothing on the other
 */
export function fadeOutToLines(opacity: number): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    HEAT_LINES.midZoom,
    opacity,
    HEAT_LINES.fullZoom,
    0,
  ];
}

/**
 * Opacity by zoom of the heat lines: nothing, then `opacity`, and then the
 * opacity of `closeIn`, `[zoom, opacity]`, at its zoom
 */
function fadeInLines(
  opacity: number | ExpressionSpecification,
  closeIn: readonly number[] = [],
): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    HEAT_LINES.fromZoom,
    0,
    HEAT_LINES.midZoom,
    opacity,
    ...closeIn,
  ] as ExpressionSpecification;
}

/** A width or blur that grows with the zoom, `[zoom, px, zoom, px]` */
function byZoom(stops: readonly number[]): ExpressionSpecification {
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    ...stops,
  ] as ExpressionSpecification;
}

/** The paint of the heat layer, which the map creates without any */
export function heatmapPaint(): NonNullable<
  HeatmapLayerSpecification["paint"]
> {
  return {
    "heatmap-radius": [
      "interpolate",
      ["linear"],
      ["zoom"],
      ...HEATMAP_RADIUS_PX.flat(),
    ] as ExpressionSpecification,
    "heatmap-weight": heatmapWeight(),
    "heatmap-intensity": heatmapIntensity(),
    "heatmap-color": heatmapColor(),
    "heatmap-opacity": fadeOutToLines(HEATMAP_OPACITY),
  };
}

/** Colour of a heat line by its heat, see HEAT_LINE_SECONDS */
function heatLineColor(): ExpressionSpecification {
  return [
    "interpolate",
    ["linear"],
    ["get", "heat"],
    ...HEATMAP_GRADIENT.slice(1).flatMap(([, rgb], index) => [
      HEAT_LINE_SECONDS[index]!,
      `rgb(${rgb})`,
    ]),
  ] as ExpressionSpecification;
}

/**
 * Opacity of the heat lines at full strength, `strength` of 1 or less while
 * a colour layer is drawn over them (see
 * DataManager.applyHeatmapEmphasis)
 */
export function heatLineOpacities(strength: number): {
  glow: ExpressionSpecification;
  core: ExpressionSpecification;
} {
  return {
    glow: fadeInLines(HEAT_LINE_GLOW.opacity * strength, [
      HEAT_LINE_GLOW.closeIn[0],
      HEAT_LINE_GLOW.closeIn[1] * strength,
    ]),
    core: fadeInLines([
      "interpolate",
      ["linear"],
      ["get", "heat"],
      ...HEAT_LINE_CORE.opacity.flatMap(([seconds, opacity]) => [
        seconds,
        opacity * strength,
      ]),
    ] as ExpressionSpecification),
  };
}

/** Width of the heat line cores by zoom and heat, see HEAT_LINE_CORE */
function heatLineCoreWidth(): ExpressionSpecification {
  const coolest = HEAT_LINE_SECONDS[0]!;
  const hottest = HEAT_LINE_SECONDS[HEAT_LINE_SECONDS.length - 1]!;
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    ...HEAT_LINE_CORE.width.flatMap(([zoom, cool, hot]) => [
      zoom,
      [
        "interpolate",
        ["linear"],
        ["log2", ["get", "heat"]],
        Math.log2(coolest),
        cool,
        Math.log2(hottest),
        hot,
      ],
    ]),
  ] as ExpressionSpecification;
}

/** The paint of the two heat line layers, created without any either */
export function heatLinesPaint(): Record<
  typeof MAP_LAYERS.heatLinesGlow | typeof MAP_LAYERS.heatLinesCore,
  NonNullable<LineLayerSpecification["paint"]>
> {
  const opacity = heatLineOpacities(HEATMAP_OPACITY);
  return {
    [MAP_LAYERS.heatLinesGlow]: {
      "line-color": heatLineColor(),
      "line-width": byZoom(HEAT_LINE_GLOW.width),
      "line-blur": byZoom(HEAT_LINE_GLOW.blur),
      "line-opacity": opacity.glow,
    },
    [MAP_LAYERS.heatLinesCore]: {
      "line-color": heatLineColor(),
      "line-width": heatLineCoreWidth(),
      "line-opacity": opacity.core,
    },
  };
}
