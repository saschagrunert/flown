/**
 * The content of the heat sources, written as GeoJSON text by the year
 * worker (services/yearWorker.ts).
 *
 * The heatmap draws a point per fix, 135,000 of them for all years of the
 * sample flights (116,000 with those of one pixel merged, see mergedPoints).
 * Handed to MapLibre as objects, a feature each, they cost the main thread
 * about 120 ms on a desktop (in Chrome: 70 ms for MapLibre's own copy of
 * them and 45 ms for the structured clone to its worker) and three to
 * four times that with the CPU slowed down as for a phone, on every change of
 * the year, the aircraft or the weighing, on top of the objects themselves and
 * the exposure (see doc/development/heat.md). A source that is given a URL
 * instead is loaded, parsed and cut into tiles by MapLibre's worker alone (two
 * fixes of scripts/vendor.js see to that: without them MapLibre fetches a Blob
 * URL on the main thread, and sends back what it parsed). So the page packs the
 * heat into one column of numbers (heatColumns), the worker works out how it is
 * drawn and writes the text into a Blob, and the page gives the source a URL of
 * that Blob.
 *
 * The text is the one JSON.stringify writes for the same features, with the
 * coordinates of the heat points to 5 decimals (about 1.1 m, drawn up to
 * zoom 12.75), those of the heat lines to 7 (about 1 cm, drawn up to the
 * map's last zoom) and the heat of the points to 4 significant digits. The
 * heat lines the heatmap hands over to are written the same way, by the
 * worker along the flights it holds (see services/flightLines.ts), as are
 * the lines of the colour layers.
 *
 * Like everything else in yearWorker.bundle.js this is no part of what a
 * first visit downloads. The packing runs on the page, from the same bundle
 * (services/yearDecoder.ts), which also writes the text there when the
 * worker cannot be used.
 */
import { exposedHeat } from "../calculations/heatExposure";

/** How the heatmap draws a heat, see drawHeat */
export interface DrawnHeat {
  /** What the heat is scaled by, see heatExposure */
  exposure: number;
  /**
   * The GeoJSON of the heat source: a Point per point, its heat as `w`,
   * scaled by `exposure` and rolled off (see exposedHeat)
   */
  source: Blob;
}

/** The content of the heat line source (see heatLineFeatures) */
export type HeatLines = GeoJSON.FeatureCollection<
  GeoJSON.LineString,
  { heat: number }
>;

/** The lines of HeatLines as columns, see linesSource */
export interface FlatLines {
  /** `[lng, lat]` of every position of every line, one line after another */
  coordinates: Float64Array;
  /** Where each line ends in `coordinates`, counted in positions */
  ends: Uint32Array;
  /** The heat of each line */
  heats: Float64Array;
}

/** The lines of `lines` as columns, see FlatLines */
export function flatLines(lines: HeatLines): FlatLines {
  const { features } = lines;
  let positions = 0;
  for (const feature of features) {
    positions += feature.geometry.coordinates.length;
  }
  const coordinates = new Float64Array(positions * 2);
  const ends = new Uint32Array(features.length);
  const heats = new Float64Array(features.length);
  let at = 0;
  features.forEach((feature, index) => {
    for (const [lng, lat] of feature.geometry.coordinates) {
      coordinates[at++] = lng!;
      coordinates[at++] = lat!;
    }
    ends[index] = at / 2;
    heats[index] = feature.properties.heat;
  });
  return { coordinates, ends, heats };
}

/**
 * Features written into one string before the next is begun. A Blob of a
 * few hundred parts is made as fast as of one, without a string of 16 MB
 * for all years that would have to be put together first.
 */
const FEATURES_PER_PART = 1024;

/** A number as JSON.stringify writes it: null for one that is not finite */
export function json(value: number): string {
  return Number.isFinite(value) ? String(value) : "null";
}

/**
 * A longitude or latitude to `1 / scale` degrees. A double written whole
 * takes 17 digits, a third of the text. The points, merged in a pixel of
 * the heatmap's last zoom (about 10 m), need no finer than 5 decimals,
 * 1.1 m. The heat lines are drawn up to the map's last zoom, where a metre
 * is several pixels and 1.1 m would kink a traffic pattern or a taxi line,
 * so they get 7, about 1 cm.
 */
export const degrees = (value: number, scale = 1e5): string =>
  json(Math.round(value * scale) / scale);

/** A heat to 4 significant digits, finer than the heatmap can draw */
const weight = (value: number): string => json(+value.toPrecision(4));

/** A Blob of the text of a FeatureCollection of `count` features */
export function collection(
  count: number,
  feature: (index: number) => string,
): Blob {
  const parts = ['{"type":"FeatureCollection","features":['];
  for (let start = 0; start < count; start += FEATURES_PER_PART) {
    const end = Math.min(start + FEATURES_PER_PART, count);
    let part = start > 0 ? "," : "";
    for (let index = start; index < end; index++) {
      part += (index > start ? "," : "") + feature(index);
    }
    parts.push(part);
  }
  parts.push("]}");
  return new Blob(parts, { type: "application/json" });
}

/**
 * The last zoom the heatmap is drawn at, HEAT_LINES.fullZoom (which a test
 * holds it to: utils/constants.ts is no part of the worker's bundle), in
 * whose pixels the points of a heat are merged (see mergedPoints)
 */
export const HEAT_MERGE_ZOOM = 12.75;

/**
 * The fixes of a heat that lie in one pixel at HEAT_MERGE_ZOOM, as one
 * point: `[lat, lng, heat, fixes]` per point, at the mean of their places
 * weighed by their heat, with the sum of their heat and how many they are.
 *
 * Where many flights were flown the fixes lie on top of one another, a
 * few hundred circuits and the apron most of all, and the heatmap drew
 * every one of them into its texture, every frame. From map zoom 11 to
 * 12.75 a point reaches 16 to 24 px (see HEATMAP_RADIUS_PX) and the view
 * is the home field, so that became the dearest frame of the map, and
 * zooming in stuttered. Merged, the home field at 12 is drawn from 40 %
 * fewer points, the ones most on top of each other, and the texture takes
 * well under half the time. The heat of each place stays: the density is
 * a sum of weight times kernel, and no fix moves further than the
 * diagonal of a pixel of the last zoom the heatmap is drawn at, a sixth
 * of the kernel's deviation there and less at every zoom before (for what
 * MapLibre does to light points see heatmapWeight in ui/heatmapPaint.ts).
 * The cells are squares of the Mercator plane, as the exposure's are (see
 * calculations/heatExposure.ts), so a pixel of any latitude.
 */
function mergedPoints(heat: Float64Array, weights: Float64Array): number[] {
  const cell = 360 / (512 * 2 ** HEAT_MERGE_ZOOM);
  const cells = new Map<number, number>();
  const points: number[] = [];
  const moves: number[] = [];
  for (let index = 0; index < weights.length; index++) {
    const lat = heat[3 * index]!;
    const lng = heat[3 * index + 1]!;
    const weight = weights[index]!;
    const y = Math.atanh(Math.sin((lat * Math.PI) / 180)) * (180 / Math.PI);
    // A cell holds fewer than 2^21 columns either side of the meridian
    const key = Math.floor(y / cell) * 2 ** 22 + Math.floor(lng / cell);
    const at = cells.get(key);
    if (at === undefined) {
      cells.set(key, points.length);
      points.push(lat, lng, weight, 1);
      moves.push(0, 0);
    } else {
      // Weighed moves away from the first fix of the cell, which a point
      // of one fix keeps exactly
      moves[at / 2] = moves[at / 2]! + (lat - points[at]!) * weight;
      moves[at / 2 + 1] = moves[at / 2 + 1]! + (lng - points[at + 1]!) * weight;
      points[at + 2] = points[at + 2]! + weight;
      points[at + 3] = points[at + 3]! + 1;
    }
  }
  for (let at = 0; at < points.length; at += 4) {
    if (points[at + 3] === 1) continue;
    points[at] = points[at]! + moves[at / 2]! / points[at + 2]!;
    points[at + 1] = points[at + 1]! + moves[at / 2 + 1]! / points[at + 2]!;
  }
  return points;
}

/**
 * The heat of the points of `heat` (see heatColumns in
 * calculations/heatExposure.ts) as the heatmap draws it (see exposedHeat),
 * and the content of its source: one Point per point, `[lng, lat]`, with
 * its heat as `w` and, for a point of several fixes (see mergedPoints),
 * how many as `n`. A MultiPoint of all of them would be shorter, but the
 * source can only merge features into clusters, not the points of one
 * feature (see HEATMAP_CLUSTER).
 */
export function drawHeat(heat: Float64Array): DrawnHeat {
  const { exposure, weights } = exposedHeat(heat);
  const points = mergedPoints(heat, weights);
  const source = collection(points.length / 4, (index) => {
    const fixes = points[4 * index + 3]!;
    return (
      '{"type":"Feature","properties":{"w":' +
      weight(points[4 * index + 2]!) +
      (fixes > 1 ? ',"n":' + fixes : "") +
      '},"geometry":{"type":"Point","coordinates":[' +
      degrees(points[4 * index + 1]!) +
      "," +
      degrees(points[4 * index]!) +
      "]}}"
    );
  });
  return { exposure, source };
}

/**
 * The content of the heat line source, from the lines as flatLines packed
 * them: a LineString per line, with its heat as `heat`
 */
export function linesSource(lines: FlatLines): Blob {
  const { coordinates, ends, heats } = lines;
  return collection(heats.length, (index) => {
    let line = "";
    for (let at = index > 0 ? ends[index - 1]! : 0; at < ends[index]!; at++) {
      line +=
        (line ? ",[" : "[") +
        degrees(coordinates[2 * at]!, 1e7) +
        "," +
        degrees(coordinates[2 * at + 1]!, 1e7) +
        "]";
    }
    return (
      '{"type":"Feature","properties":{"heat":' +
      json(heats[index]!) +
      '},"geometry":{"type":"LineString","coordinates":[' +
      line +
      "]}}"
    );
  });
}
