/**
 * Lookups derived from one dataset.
 *
 * Every value here is a pure function of the dataset and, for a filter view,
 * of the year/aircraft filter. The index is built on first use and kept in a
 * WeakMap beside the dataset: a new dataset starts from an empty index, and
 * no consumer has to compare arrays or lengths to notice that it changed.
 *
 * The per-path segment slices are one lookup kept elsewhere
 * (`segmentRangesFor` in statistics.ts): their callers hold a bare segment
 * array rather than a dataset, so that index hangs off the array instead.
 * The statistics of a view are another (`filterStatistics` in
 * panelStats.ts): only the lazily loaded panels show them.
 */
import {
  calculateAirportFlightCounts,
  type AirportCounts,
} from "../features/airports";
import type { KMLDataset, PathInfo, PathSegment } from "../types";
import { filterPaths, segmentsForPathIds } from "./statistics";

/** Kept path ids per airport, the shape `MapApp.airportToPaths` exposes */
export type PathIdsByAirport = Record<string, Set<number>>;

/** What one year/aircraft filter keeps of a dataset */
export class FilterView {
  /** Paths the filter keeps, in path_info order */
  readonly paths: PathInfo[];
  /** Ids of those paths */
  readonly pathIds: Set<number>;
  /** The filter keeps every entry of path_info */
  readonly keepsAll: boolean;

  private counts: AirportCounts | null = null;
  private byAirport: PathIdsByAirport | null = null;
  private keptSegments: PathSegment[] | null = null;

  constructor(
    private readonly data: KMLDataset,
    year: string,
    aircraft: string,
  ) {
    this.paths = filterPaths(data.path_info, year, aircraft);
    this.pathIds = new Set(this.paths.map((path) => path.id));
    this.keepsAll = this.paths.length === data.path_info.length;
  }

  /** Flights per airport; a round trip counts once */
  airportCounts(): AirportCounts {
    if (!this.counts) {
      this.counts = calculateAirportFlightCounts(this.paths);
    }
    return this.counts;
  }

  /** Kept path ids per airport they start or end at */
  pathIdsByAirport(): PathIdsByAirport {
    if (this.byAirport) return this.byAirport;
    // No prototype: an airport name is data, and "constructor" is no key
    const byAirport = Object.create(null) as PathIdsByAirport;
    for (const path of this.paths) {
      for (const airport of [path.start_airport, path.end_airport]) {
        if (!airport) continue;
        const ids = byAirport[airport] ?? new Set<number>();
        ids.add(path.id);
        byAirport[airport] = ids;
      }
    }
    this.byAirport = byAirport;
    return byAirport;
  }

  /** Segments of the kept paths, in dataset order */
  segments(): PathSegment[] {
    if (!this.keptSegments) {
      this.keptSegments = this.keepsAll
        ? this.data.path_segments
        : segmentsForPathIds(this.data.path_segments, this.pathIds);
    }
    return this.keptSegments;
  }
}

export class DatasetIndex {
  private byId: Map<number, PathInfo> | null = null;
  /** Filter views by year, then by aircraft */
  private readonly views = new Map<string, Map<string, FilterView>>();

  constructor(private readonly data: KMLDataset) {}

  /** Path info by path id */
  get pathInfoById(): Map<number, PathInfo> {
    if (!this.byId) {
      this.byId = new Map(this.data.path_info.map((path) => [path.id, path]));
    }
    return this.byId;
  }

  /** The view of a year/aircraft filter, built once per filter */
  filter(year: string, aircraft: string): FilterView {
    let byAircraft = this.views.get(year);
    if (!byAircraft) {
      byAircraft = new Map();
      this.views.set(year, byAircraft);
    }
    let view = byAircraft.get(aircraft);
    if (!view) {
      view = new FilterView(this.data, year, aircraft);
      byAircraft.set(aircraft, view);
    }
    return view;
  }
}

const indexes = new WeakMap<KMLDataset, DatasetIndex>();

/** The index of a dataset, created on first use */
export function datasetIndex(data: KMLDataset): DatasetIndex {
  let index = indexes.get(data);
  if (!index) {
    index = new DatasetIndex(data);
    indexes.set(data, index);
  }
  return index;
}

/** The keys of the store a filtered selection is worked out from */
interface FilterState {
  readonly currentData: KMLDataset | null;
  readonly selectedYear: string;
  readonly selectedAircraft: string;
  readonly selectedPathIds: ReadonlySet<number>;
}

/** The flights of `data` the year and aircraft filters of `app` show */
export function shownPathIds(
  app: FilterState,
  data: KMLDataset,
): ReadonlySet<number> {
  return datasetIndex(data).filter(app.selectedYear, app.selectedAircraft)
    .pathIds;
}

/**
 * The selected flights the year and aircraft filters show: what is drawn,
 * counted, framed and replayed of the selection. A filter change cleared
 * the selection, so nothing that read it asked the filter; share mode now
 * keeps the flights a filter hides (ui/filterManager.ts), and only its
 * chip and its link speak of them. The selection itself where the filter
 * shows all of it, as it does outside share mode.
 */
export function shownSelection(app: FilterState): ReadonlySet<number> {
  const selected = app.selectedPathIds;
  const data = app.currentData;
  if (!data || selected.size === 0) return selected;
  const shown = shownPathIds(app, data);
  const kept = [...selected].filter((pathId) => shown.has(pathId));
  return kept.length === selected.size ? selected : new Set(kept);
}
