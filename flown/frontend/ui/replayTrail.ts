/**
 * The trail of the replay of one flight (see ui/replayRenderer.ts): the
 * runs of one colour its segments are added to, cut back on a backward
 * seek, and the features drawn of them.
 */
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
} from "geojson";
import type { MapApp } from "../mapApp";
import type { ReplayState, TrailTip } from "./replayState";
import type { PathSegment } from "../types";
import { toLngLat, toLngLatAfter, unwrapLng } from "../utils/mapHelpers";
import { getColorForAirspeed, getColorForAltitude } from "../utils/colors";
import { isLiftedAt } from "../calculations/lift";
import {
  ribbonOf,
  ribbonPieces,
  ribbonProperties,
  type RibbonPiece,
  type RibbonProperties,
} from "../calculations/ribbons";
import { appendCurve } from "../calculations/curves";

/** The trail is coloured by altitude unless the speed layer is the one on */
export function speedColouredTrail(
  app: Pick<MapApp, "airspeedVisible" | "altitudeVisible">,
): boolean {
  return app.airspeedVisible && !app.altitudeVisible;
}

/**
 * Colour of one replay segment. Segments without a groundspeed fall back to
 * the altitude colour, so both draw paths cover exactly the same segments.
 */
function replaySegmentColor(
  state: ReplayState,
  segment: PathSegment,
  useAirspeedColors: boolean,
): string {
  const speed = state.colorSpeedRange;
  const altitude = state.colorAltRange;
  return useAirspeedColors && segment.groundspeed_knots > 0
    ? getColorForAirspeed(
        segment.groundspeed_knots,
        speed.min,
        speed.max,
        speed.ranks,
      )
    : getColorForAltitude(
        segment.altitude_ft,
        altitude.min,
        altitude.max,
        altitude.ranks,
      );
}

/**
 * The points of the curve the segment at `index` adds to a line that ends
 * at its start (see appendCurve), or its end point without a curve
 */
function extendLine(
  state: Pick<ReplayState, "smoothed">,
  coords: [number, number][],
  index: number,
  to: readonly [number, number],
): void {
  const before = coords.length;
  if (state.smoothed) appendCurve(coords, state.smoothed, index);
  if (coords.length === before) {
    coords.push(toLngLatAfter(to, coords[before - 1]));
  }
}

/**
 * Add the segment at `index` to the trail. Consecutive segments of one
 * colour extend the last run, so the trail stays a handful of features
 * rather than one per segment. A run holds the points of the flight's
 * curve along its segments (see calculations/curves.ts), which is what
 * lets a backward seek cut it (see truncateTrail).
 */
export function appendTrailSegment(
  state: ReplayState,
  index: number,
  useAirspeedColors: boolean,
): void {
  const segment = state.segments[index];
  if (!segment) return;
  state.lastDrawnIndex = index;

  const [from, to] = segment.coords;

  const color = replaySegmentColor(state, segment, useAirspeedColors);
  const start = toLngLat(from);
  const last = state.trailRuns[state.trailRuns.length - 1];
  const tail = last?.coords[last.coords.length - 1];
  // A run goes on across the antimeridian in the next copy of the world,
  // and not into the next of several flights, which the airplane starts
  // anew where it may have landed
  const continues =
    last !== undefined &&
    tail !== undefined &&
    last.color === color &&
    last.lastIndex === index - 1 &&
    state.segments[index - 1]!.path_id === segment.path_id &&
    unwrapLng(start[0], tail[0]) === tail[0] &&
    tail[1] === start[1];

  if (continues) {
    extendLine(state, last.coords, index, to);
    last.lastIndex = index;
  } else {
    const coords = [start];
    extendLine(state, coords, index, to);
    state.trailRuns.push({
      color,
      coords,
      firstIndex: index,
      lastIndex: index,
    });
  }
  state.trailDirty = true;
}

/**
 * Cut the trail back to the segments flown at `time`. Seeking backwards
 * this way drops whole runs and shortens one, instead of colouring the
 * flight again from its start. At time 0 nothing is drawn, as a replay
 * starts (see ReplayRenderer.drawNewSegments).
 */
export function truncateTrail(state: ReplayState, time: number): void {
  const before = state.lastDrawnIndex;
  while (state.lastDrawnIndex >= 0) {
    const seg = state.segments[state.lastDrawnIndex];
    if (seg && time > 0 && (seg.time ?? 0) <= time) break;
    state.lastDrawnIndex--;
  }
  if (state.lastDrawnIndex === before) return;

  const runs = state.trailRuns;
  while ((runs[runs.length - 1]?.firstIndex ?? -1) > state.lastDrawnIndex) {
    runs.pop();
  }
  const last = runs[runs.length - 1];
  if (last && last.lastIndex > state.lastDrawnIndex) {
    last.lastIndex = state.lastDrawnIndex;
    // The points each of its segments added: those of its curve, or its end
    const smoothed = state.smoothed;
    let length = 1;
    for (let i = last.firstIndex; i <= last.lastIndex; i++) {
      length += smoothed?.chains[smoothed.chainOf[i]!]
        ? smoothed.to[i]! - smoothed.from[i]!
        : 1;
    }
    last.coords.length = length;
  }
  state.trailDirty = true;
}

/** What a feature of the trail carries: its colour, and a ribbon its height */
interface TrailProperties extends Partial<RibbonProperties> {
  color: string;
}

type TrailFeature = Feature<LineString | MultiPolygon, TrailProperties>;

/**
 * The ribbon of the part of the segment of `tip` the airplane has flown,
 * from the start of the segment to the airplane, joined to the ribbon
 * before it corner to corner (see ribbonOf)
 */
function tipPieces(
  curve: NonNullable<ReplayState["smoothed"]>,
  tip: TrailTip,
  widthZoom: number,
): RibbonPiece[] {
  const chain = curve.chains[curve.chainOf[tip.index]!]!;
  const from = curve.from[tip.index]!;
  const points = chain.points.slice(from, tip.point + 1);
  const heights = chain.heights.slice(from, tip.point + 1);
  points.push(tip.position);
  heights.push(tip.heightFt);
  const offsets = chain.offsets?.map((level, k) => [
    ...level.slice(from, tip.point + 1),
    tip.offsetsFt?.[k] ?? level[tip.point]!,
  ]);
  return ribbonPieces(
    points,
    heights,
    widthZoom,
    chain.points[from - 1],
    undefined,
    offsets,
  );
}

/**
 * The trail as the data of its source: one line per colour run, or in the
 * 3D view (`state.lifted`) the runs as ribbons at their height, cut for
 * the relief level `level` in its `epoch`-th visit (see ribbonId) and as
 * wide as `widthZoom` asks, for the ribbons' source; zoomed in as far as
 * LIFT_MAX_ZOOM, the lines again. Both run along the flight's curve
 * (`state.smoothed`), and end at the airplane (`state.trailTip`), part way
 * along the segment it flies. Only a run that has grown or changed its
 * width is cut again, and of the one the airplane is on only the part of
 * its segment flown: the others keep their pieces, so the trail costs no
 * more to write than its line.
 */
export function trailFeatureCollection(
  state: Pick<
    ReplayState,
    "trailRuns" | "smoothed" | "trailPieces" | "lifted" | "trailTip"
  >,
  widthZoom: number,
  level: number,
  epoch = 0,
): FeatureCollection<LineString | MultiPolygon, TrailProperties> {
  const curve = state.smoothed;
  const lifted = state.lifted && isLiftedAt(widthZoom) ? curve : null;
  const tip = state.trailTip;
  return {
    type: "FeatureCollection",
    features: state.trailRuns.flatMap((run): TrailFeature[] => {
      // The run the airplane flies on ends where it is
      const cutAt =
        tip?.index === run.lastIndex &&
        curve?.chains[curve.chainOf[run.lastIndex]!]
          ? tip
          : null;
      if (!lifted) {
        let coordinates = run.coords;
        if (cutAt) {
          coordinates = run.coords.slice(
            0,
            cutAt.point - curve!.from[run.firstIndex]! + 1,
          );
          coordinates.push(
            toLngLatAfter(cutAt.position, coordinates[coordinates.length - 1]),
          );
        }
        return [
          {
            type: "Feature" as const,
            properties: { color: run.color },
            geometry: { type: "LineString" as const, coordinates },
          },
        ];
      }
      const end = cutAt ? run.lastIndex : run.lastIndex + 1;
      let cut = state.trailPieces.get(run);
      if (cut?.end !== end || cut.widthZoom !== widthZoom) {
        // Cut from the flight's smoothed curve, so the runs of the trail
        // meet without a seam
        cut = {
          end,
          widthZoom,
          pieces:
            end > run.firstIndex
              ? ribbonOf(lifted, run.firstIndex, end, widthZoom)
              : [],
        };
        state.trailPieces.set(run, cut);
      }
      const pieces = cutAt
        ? [...cut.pieces, ...tipPieces(lifted, cutAt, widthZoom)]
        : cut.pieces;
      return pieces.map((piece) => ({
        type: "Feature" as const,
        properties: {
          color: run.color,
          ...ribbonProperties(piece, level, epoch),
        },
        geometry: piece.geometry,
      }));
    }),
  };
}
