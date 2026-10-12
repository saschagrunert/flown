/**
 * A few flights smoothed on their ground, each on its own: the selection
 * drawn as ribbons (ui/selectionRibbons.ts), the heat cloud of a
 * selection (ui/heatCloud.ts) and the shared flights a link's intro and
 * the replay of all flights play (keptGrounded). Only the feature bundle
 * asks, so this is kept out of groundProfile.ts, which smooths every
 * flight of the dataset for the first visit's 3D view.
 */
import type { PathSegment } from "../types";
import type { SmoothedFlights } from "./smoothing";
import {
  groundedFlights,
  groundProfilesFt,
  heldFlights,
  onGround,
  onReleaseGrounded,
  smoothAltitudes,
} from "./groundProfile";

/**
 * The flights of `segments` smoothed as groundedFlights smooths them, each
 * on its own, without holding them: for a few flights, such as the
 * selected ones (ui/selectionRibbons.ts), it takes a fraction of the time
 * of every flight of the dataset.
 */
export function smoothGrounded(
  segments: readonly PathSegment[],
  sampled: boolean,
  level: number,
): SmoothedFlights {
  // Each flight stands on its own fields (groundProfileFt), and on the
  // relief where it is drawn, as coarse as the level draws it, with the
  // ground of the levels around it
  return onGround(
    smoothAltitudes(segments),
    groundProfilesFt(segments, sampled, level),
  );
}

/** Segments, and their flights smoothed on the ground (see keptGrounded) */
export interface GroundedRun {
  segments: readonly PathSegment[];
  flights: SmoothedFlights;
}

/**
 * The most flights keptGrounded smooths on their own rather than with every
 * flight of the dataset: a day of them shared, and some more
 */
const FEW_FLIGHTS = 24;

/**
 * The flights keptGrounded smoothed on their own last, and what for. They
 * go with the flights of the dataset (releaseGroundedFlights): the
 * segments they are of may be those of all years.
 */
let few: (GroundedRun & { all: readonly PathSegment[]; key: string }) | null =
  null;
onReleaseGrounded(() => {
  few = null;
});

/**
 * The flights `keep` takes of `segments`, smoothed on the ground as
 * groundedFlights smooths them (see its arguments), with the segments the
 * curves are of: every flight of `segments` where groundedFlights holds
 * them, the flights are many or all of them, and otherwise the few alone,
 * smoothed on their own (smoothGrounded). The intro of a link to two
 * flights smoothed every flight of all years as its camera set out,
 * seconds on a phone, for curves nothing else drew. The last few are kept,
 * the same segments for the same flights, whose clock is worked out once
 * (flightClockOf).
 */
export function keptGrounded(
  segments: readonly PathSegment[],
  keep: (pathId: number) => boolean,
  sampled: boolean,
  level: number,
): GroundedRun {
  const held = heldFlights(segments, sampled, level);
  if (held) return { segments, flights: held };
  const kept = new Set<number>();
  // The flights of `segments`, each a run of them
  let flights = 0;
  let last: number | undefined;
  for (const { path_id } of segments) {
    if (path_id !== last) flights++;
    last = path_id;
    if (kept.has(path_id) || !keep(path_id)) continue;
    kept.add(path_id);
    if (kept.size > FEW_FLIGHTS) break;
  }
  if (kept.size > FEW_FLIGHTS || kept.size === flights) {
    return { segments, flights: groundedFlights(segments, sampled, level) };
  }
  const key = `${sampled}/${level}/${[...kept].join()}`;
  if (few?.all !== segments || few.key !== key) {
    const theirs = segments.filter((segment) => kept.has(segment.path_id));
    few = {
      all: segments,
      key,
      segments: theirs,
      flights: smoothGrounded(theirs, sampled, level),
    };
  }
  return few;
}
