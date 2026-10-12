/**
 * Which flights of a dataset the 3D view's layers and panels count: the
 * heat cloud, its readout, the replay of all flights and the cross-section.
 */
import type { MapApp } from "../mapApp";
import { datasetIndex } from "../calculations/datasetIndex";
import type { KMLDataset } from "../types";

/**
 * Whether a flight of `data` counts: one the year and aircraft filters of
 * `app` keep and, where `only` is given, among it (an isolated selection,
 * or the flights a run was asked for)
 */
export function keptFlights(
  app: Pick<MapApp, "selectedYear" | "selectedAircraft">,
  data: KMLDataset,
  only?: ReadonlySet<number> | null,
): (pathId: number) => boolean {
  const kept = datasetIndex(data).filter(
    app.selectedYear,
    app.selectedAircraft,
  ).pathIds;
  return only
    ? (pathId) => kept.has(pathId) && only.has(pathId)
    : (pathId) => kept.has(pathId);
}

/** Path ids as a key, the same for the same ids in any order */
export function idsKey(ids: Iterable<number>): string {
  return [...ids].sort((a, b) => a - b).join();
}
