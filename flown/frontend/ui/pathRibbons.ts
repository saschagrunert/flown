/**
 * Path ribbons - the runs of the 3D view, cut as ribbons
 *
 * In the 3D view (calculations/lift.ts) each run of the colour layers is
 * written as a ribbon at its height rather than as a line, cut from its
 * flight's smoothed curve, and from CULL_FROM_ZOOM on only for the part of
 * the map around the view (see utils/viewBox.ts). The layer manager
 * (ui/layerManager.ts) decides when the ribbons are cut again: as the
 * relief comes or goes, as a zoom ends on another level and as the view
 * leaves the part they were written for. This module cuts them
 * (`ribbonFeatures`), from every flight smoothed at its height on the
 * ground of the relief's level (`smoothedFlights`). It comes with the
 * feature bundle, as the relief does, which the 3D view fetches: a visit
 * that never opens the 3D view does not download it.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { PathRunProperties, PathSegment } from "../types";
import type { SmoothedFlights } from "../calculations/smoothing";
import { groundedFlights } from "../calculations/groundProfile";
import { liftExaggeration, liftOffsetPx } from "../calculations/lift";
import { ribbonHeightFt } from "../calculations/ribbonPaint";
import { ribbonOf, ribbonProperties } from "../calculations/ribbons";
import {
  CULL_FROM_ZOOM,
  leavesBox,
  overlaps,
  ribbonsTopM,
  VIEW_SPARE,
  viewBox,
  type Box,
} from "../utils/viewBox";
import { boxOf } from "../utils/curveBox";
import type { Run } from "./pathRuns";

/**
 * Every flight smoothed at its height above its ground, on the ground and
 * at the level the relief is drawn for (see groundedFlights), kept for as
 * long as the dataset, the ground and the level are the same
 */
function smoothedFlights(
  app: MapApp,
  segments: readonly PathSegment[],
): SmoothedFlights {
  return groundedFlights(segments, app.terrainActive, app.reliefLevel);
}

/** The part of the map the ribbon of a run lies in, along its curve */
function runBox(run: Run, smoothed: SmoothedFlights): Box {
  return boxOf(
    smoothed.chains[smoothed.chainOf[run.start]!]!.points,
    smoothed.from[run.start],
    smoothed.to[run.end - 1],
  );
}

/**
 * The runs `runs` of the flights `segments` as ribbons at their height,
 * the features of a source of the 3D view, under the generation `g` of
 * its run table. Each run is cut from its flight's smoothed curve, so it
 * meets the runs on either side without a seam, for the pixels of the
 * zoom level `widthZoom`, and only where it reaches into `box`, if one
 * is given. Every piece of a run is a feature of that run.
 */
export function ribbonFeatures(
  app: MapApp,
  segments: readonly PathSegment[],
  runs: readonly Run[],
  g: number,
  widthZoom: number,
  box: Box | null,
): GeoJSON.Feature<GeoJSON.MultiPolygon, PathRunProperties>[] {
  const smoothed = smoothedFlights(app, segments);
  const level = app.reliefLevel;
  const features: GeoJSON.Feature<GeoJSON.MultiPolygon, PathRunProperties>[] =
    [];
  runs.forEach((run, r) => {
    if (box && !overlaps(box, runBox(run, smoothed))) return;
    for (const piece of ribbonOf(
      smoothed,
      run.start,
      run.end,
      widthZoom,
      true,
    )) {
      features.push({
        type: "Feature",
        properties: {
          r,
          g,
          pathId: run.pathId,
          color: run.color,
          ...ribbonProperties(piece, level, app.relief.epoch),
        },
        geometry: piece.geometry,
      });
    }
  });
  return features;
}

/**
 * How high the highest flight may be drawn above its ground, in metres,
 * in the 3D view: no higher than its altitude
 */
function topM(app: MapApp): number {
  return ribbonsTopM(app.altitudeRange.max, app.reliefLevel);
}

/**
 * The part of the map the ribbons cut for the zoom level `widthZoom` are
 * written for: around the view from CULL_FROM_ZOOM on, with VIEW_SPARE to
 * pan into, and the whole map (null) further out
 */
export function ribbonBox(
  app: MapApp,
  map: MapLibreMap,
  widthZoom: number,
): Box | null {
  return widthZoom >= CULL_FROM_ZOOM
    ? viewBox(map, topM(app), VIEW_SPARE)
    : null;
}

/** Whether the view has reached past an edge of `box` (see ribbonBox) */
export function viewLeaves(app: MapApp, map: MapLibreMap, box: Box): boolean {
  return leavesBox(viewBox(map, topM(app), 0), box);
}

/**
 * How many pixels up the screen the ribbon of the feature with
 * `properties` is drawn above its ground (see liftOffsetPx, which scales
 * by the centre), at the exaggeration the map is drawn for, which every
 * ribbon has (see ribbonHeights)
 */
export function ribbonLiftPx(
  app: MapApp,
  map: MapLibreMap,
  properties: Partial<PathRunProperties>,
): number {
  return liftOffsetPx(
    map,
    map.getCenter().lat,
    ribbonHeightFt(properties, map.getZoom()),
    liftExaggeration(app.reliefLevel),
  );
}
