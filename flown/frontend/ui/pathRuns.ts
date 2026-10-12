/**
 * Path runs - the altitude and speed modes, and the runs they are cut into
 *
 * The colour layers of the altitude and the speed mode (ui/layerManager.ts)
 * draw every flight as runs: consecutive, contiguous segments of one path
 * whose value falls in the same one of COLOR_BINS steps of the colour
 * range, merged into one feature in the colour of the middle of its step.
 * This module holds what a mode is (CONFIGS: its sources and layers, the
 * ribbons of the 3D view among them, its value, its ramp, its range and
 * its legend), the state the layer manager keeps per mode and per source
 * (ModeState and RunTable, which ui/pathHover.ts reads the runs of the
 * features under the pointer from), and the cut itself (`cutRuns`), which
 * leaves out the flights the year and aircraft filter hides. Writing the
 * runs to the map, as lines or as ribbons, is the layer manager's
 * (LayerManager.setRuns): it knows which source holds them, and when.
 * `readyMap` is the map once the path sources exist on it, which every
 * write and every style waits for.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { Range } from "../state/store";
import type {
  KMLDataset,
  PathInfo,
  PathRunProperties,
  PathSegment,
} from "../types";
import {
  airspeedColorAt,
  altitudeColorAt,
  scalePosition,
} from "../utils/colors";
import { MAP_LAYERS, MAP_SOURCES } from "../utils/constants";
import { toLngLat, type LngLatTuple } from "../utils/mapHelpers";
import { appendCurve, flightCurves } from "../calculations/curves";
import { datasetIndex } from "../calculations/datasetIndex";
import { segmentRangesFor } from "../calculations/statistics";
import {
  calculateAirspeedRange,
  calculateAltitudeRange,
  formatAirspeedLabel,
  formatAltitudeLabel,
} from "../features/layers";
import type { Box } from "../utils/viewBox";
import type { RunsOnLayer } from "./pathHover";

export type LayerMode = "altitude" | "airspeed";

/** The two sources of a mode, and the layers drawn from them */
export type RunSet = "main" | "selected";

export const RUN_SETS: readonly RunSet[] = ["main", "selected"];

/**
 * What sets the two modes apart, the same for every app. The handle of a
 * mode's layers and its colour range are the app's (see
 * LayerManager.handleOf and rangeOf in ui/pathLook.ts).
 */
export interface LayerConfig {
  mode: LayerMode;
  /** Source and layer share their id, see MAP_SOURCES and MAP_LAYERS */
  sources: Record<RunSet, string>;
  layers: Record<RunSet, string>;
  /**
   * The sources the 3D view writes the runs to as ribbons, and their
   * layers, which share their id
   */
  ribbons: Record<RunSet, string>;
  getValue: (seg: PathSegment) => number;
  /** The ramp's colour at a position along it, from 0 to 1 */
  colorAt: (position: number) => string;
  /** Range of the given segments, `fallback` when they have no value */
  computeRange: (
    segments: PathSegment[],
    fallback: Range,
    paths: PathInfo[],
  ) => Range;
  filterSegment?: (seg: PathSegment) => boolean;
  legendMinId: string;
  /** The label of the middle of the ramp, a number in the unit of the ends */
  legendMidId: string;
  legendMaxId: string;
  /** Every label's, the middle's too: both units, one line each */
  formatLegend: (value: number) => string;
}

/** Colour steps a range is cut into; the merge key of a run */
const COLOR_BINS = 32;

export const MODES: readonly LayerMode[] = ["altitude", "airspeed"];

/** The two modes, made once rather than on every call that needs one */
export const CONFIGS: Readonly<Record<LayerMode, LayerConfig>> = {
  altitude: {
    mode: "altitude",
    sources: {
      main: MAP_SOURCES.pathsAltitude,
      selected: MAP_SOURCES.pathsAltitudeSelected,
    },
    layers: {
      main: MAP_LAYERS.pathsAltitude,
      selected: MAP_LAYERS.pathsAltitudeSelected,
    },
    ribbons: {
      main: MAP_SOURCES.pathsAltitudeRibbons,
      selected: MAP_SOURCES.pathsAltitudeSelectedRibbons,
    },
    getValue: (seg) => seg.altitude_ft,
    colorAt: altitudeColorAt,
    computeRange: calculateAltitudeRange,
    legendMinId: "legend-min",
    legendMidId: "legend-mid",
    legendMaxId: "legend-max",
    formatLegend: formatAltitudeLabel,
  },
  airspeed: {
    mode: "airspeed",
    sources: {
      main: MAP_SOURCES.pathsAirspeed,
      selected: MAP_SOURCES.pathsAirspeedSelected,
    },
    layers: {
      main: MAP_LAYERS.pathsAirspeed,
      selected: MAP_LAYERS.pathsAirspeedSelected,
    },
    ribbons: {
      main: MAP_SOURCES.pathsAirspeedRibbons,
      selected: MAP_SOURCES.pathsAirspeedSelectedRibbons,
    },
    getValue: (seg) => seg.groundspeed_knots,
    colorAt: airspeedColorAt,
    computeRange: (segments, fallback) =>
      calculateAirspeedRange(segments, fallback),
    filterSegment: (seg) => seg.groundspeed_knots > 0,
    legendMinId: "airspeed-legend-min",
    legendMidId: "airspeed-legend-mid",
    legendMaxId: "airspeed-legend-max",
    formatLegend: formatAirspeedLabel,
  },
};

/** One feature of a source: a run of segments of one path in one colour */
export interface Run {
  /** Half-open index range of the run within the drawn segment array */
  start: number;
  end: number;
  pathId: number;
  /**
   * Where the run is coloured on the ramp, from 0 to 1: the middle of its
   * colour step
   */
  value: number;
  color: string;
}

/** The runs of one source; the index of a run is the `r` of its feature */
interface RunTable {
  runs: Run[];
  /**
   * Bumped on every change of the runs, written or not; features of an
   * older one are stale
   */
  g: number;
  /**
   * Counts the writes of the runs to a source: the year worker's lines for
   * one that another write followed are dropped (see LayerManager.setRuns)
   */
  writes: number;
  /**
   * The source that holds the runs' features, null while none does, which
   * is how they are created: the lines' source, or in the 3D view the
   * ribbons' source
   */
  written: string | null;
  /**
   * How far the last `setData` has got: with the worker, with the tiles in
   * view being cut from it, or null once the map shows it. Until then the
   * tiles answer for the data before it.
   */
  landing: "worker" | "tiles" | null;
  /**
   * The zoom level the runs were last written for in the 3D view (see
   * ribbonWidthZoom), null outside it
   */
  widthZoom: number | null;
  /**
   * The part of the map the ribbons were written for (see viewBox), null
   * for all of them
   */
  box: Box | null;
  /**
   * A cut for another zoom or view was left out while share mode hid the
   * runs (see isolatedOut); they are written again as they show
   */
  behind: boolean;
}

/** The selection a mode's layers were last styled for */
export interface ShownSelection {
  selected: ReadonlySet<number>;
  isolate: boolean;
}

export interface ModeState {
  tables: Record<RunSet, RunTable>;
  /** The array the runs index into, null while the mode is not drawn */
  segments: PathSegment[] | null;
  shown: ShownSelection;
  /** The filter on the main layer, serialised, to set it only on a change */
  filterKey: string;
  /**
   * The colour range of the selection, and what it was worked out for (see
   * resolveColorRange)
   */
  selectionRange: {
    data: KMLDataset;
    full: Range;
    selected: ReadonlySet<number>;
    range: Range;
  } | null;
  /**
   * Its sources hold runs of before a change of the view that passed it by
   * while it was hidden; it is drawn again as a whole
   */
  dirty: boolean;
}

export function emptyModeState(): ModeState {
  const table = (): RunTable => ({
    runs: [],
    g: 0,
    writes: 0,
    written: null,
    landing: null,
    widthZoom: null,
    box: null,
    behind: false,
  });
  return {
    tables: { main: table(), selected: table() },
    segments: null,
    shown: { selected: new Set(), isolate: false },
    filterKey: "null",
    selectionRange: null,
    dirty: false,
  };
}

/**
 * The middle of the one of COLOR_BINS equal steps of the ramp that `value`
 * falls in on `range` (see scalePosition), from 0 to 1: the merge key of a
 * run, and where on the ramp it is coloured
 */
function stepPosition(value: number, range: Range): number {
  const position = scalePosition(value, range.min, range.max, range.ranks);
  const step = Math.floor(position * COLOR_BINS);
  return (Math.min(Math.max(step, 0), COLOR_BINS - 1) + 0.5) / COLOR_BINS;
}

/**
 * Cut the segments into runs: of every path on the full range, or with
 * `only` of the given paths on `range`. The year/aircraft filter and the
 * mode's own filter apply to both.
 */
export function cutRuns(
  app: MapApp,
  config: LayerConfig,
  data: KMLDataset,
  range: Range,
  only?: ReadonlySet<number>,
): Run[] {
  const segments = data.path_segments;
  // Resolve the filter once over the path info instead of re-deriving it per
  // segment: `null` means every path passes, so no lookup is needed at all
  const visiblePathIds = visiblePathIdsOf(app, data);
  const runs: Run[] = [];

  // The stretches of the array to walk: all of it, or the slices of the
  // wanted paths where the array is indexed by path
  let stretches: [number, number][] = [[0, segments.length]];
  const index = only ? segmentRangesFor(segments) : null;
  if (only && index) {
    stretches = [];
    for (const id of only) {
      const stretch = index.get(id);
      if (stretch) stretches.push([stretch[0], stretch[1]]);
    }
    stretches.sort((a, b) => a[0] - b[0]);
  }

  // Current merge run. Its key is the middle of its colour step.
  let runStart = -1;
  let runPathId = -1;
  let runKey = NaN;
  let runEnd: readonly number[] | null = null;

  const flush = (end: number): void => {
    if (runStart < 0) return;
    runs.push({
      start: runStart,
      end,
      pathId: runPathId,
      value: runKey,
      color: config.colorAt(runKey),
    });
    runStart = -1;
    runEnd = null;
  };

  for (const [from, to] of stretches) {
    for (let i = from; i < to; i++) {
      const segment = segments[i]!;
      const pathId = segment.path_id;
      const coords = segment.coords;

      if (
        (only && !only.has(pathId)) ||
        (visiblePathIds !== null && !visiblePathIds.has(pathId)) ||
        (config.filterSegment && !config.filterSegment(segment))
      ) {
        flush(i);
        continue;
      }

      const key = stepPosition(config.getValue(segment), range);
      const contiguous =
        runEnd !== null &&
        pathId === runPathId &&
        key === runKey &&
        runEnd[0] === coords[0][0] &&
        runEnd[1] === coords[0][1];

      if (!contiguous) {
        flush(i);
        runStart = i;
        runPathId = pathId;
        runKey = key;
      }
      runEnd = coords[1];
    }
    flush(to);
  }
  return runs;
}

/**
 * Ids of the paths the year/aircraft filter keeps, or `null` when no filter
 * is active and every segment is drawn regardless of its path info.
 */
function visiblePathIdsOf(app: MapApp, data: KMLDataset): Set<number> | null {
  const year = app.selectedYear;
  const aircraft = app.selectedAircraft;
  if (year === "all" && aircraft === "all") return null;
  return datasetIndex(data).filter(year, aircraft).pathIds;
}

/** What the features of a mode's lines of one set stand for */
export function runsOnLayer(state: ModeState, set: RunSet): RunsOnLayer {
  const { selected, isolate } = state.shown;
  return {
    table: state.tables[set],
    segments: state.segments ?? [],
    selected: set === "selected",
    lift: null,
    only: set === "main" && isolate ? selected : null,
  };
}

/**
 * Whether the runs of a set are out of sight as share mode shows the
 * selection alone: the main layers are filtered to nothing (see
 * applyLook). A zoom or a pan that would cut them again for the view, and
 * in the 3D view smooth every flight for it, leaves them as they are
 * until they show again (see updateSelectionStyles).
 */
export function isolatedOut(state: ModeState, set: RunSet): boolean {
  return set === "main" && state.shown.isolate;
}

/**
 * The map once the path sources exist on it. They are created when the
 * style has loaded, and a source that is not there cannot take data.
 */
export function readyMap(app: MapApp): MapLibreMap | null {
  const map = app.map;
  return map?.getSource(MAP_SOURCES.pathsAltitude) ? map : null;
}

/**
 * The runs of `segments` as lines along the curve through their fixes
 * (see calculations/curves.ts), each of the curve of its own flight alone
 */
export function runLines(
  segments: readonly PathSegment[],
  runs: readonly Pick<Run, "start" | "end" | "pathId" | "color">[],
  g: number,
): GeoJSON.Feature<GeoJSON.LineString, PathRunProperties>[] {
  return runs.map((run, r) => {
    const { curves, from } = flightCurves(segments, run.pathId);
    const coordinates: LngLatTuple[] = [
      toLngLat(segments[run.start]!.coords[0]),
    ];
    for (let i = run.start; i < run.end; i++) {
      appendCurve(coordinates, curves, i - from);
    }
    return {
      type: "Feature",
      properties: { r, g, pathId: run.pathId, color: run.color },
      geometry: { type: "LineString", coordinates },
    };
  });
}
