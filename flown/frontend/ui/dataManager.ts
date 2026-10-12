/**
 * Data Manager - Handles data loading and layer refresh
 */
import type { ExpressionSpecification, GeoJSONSource } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import type { StoreState } from "../state/store";
import type {
  KMLDataset,
  Airport,
  LoadingState,
  Metadata,
  PathSegment,
} from "../types";
import type { Coordinate } from "../utils/geometry";
import { DataLoader } from "../services/dataLoader";
import { datasetIndex } from "../calculations/datasetIndex";
import { segmentsForPathIds } from "../calculations/statistics";
import { calculateAltitudeRange } from "../features/layers";
import { heatWeight, type SegmentWeight } from "../calculations/heatLines";
import type { DrawnHeat } from "../services/heatSource";
import type { YearDecoder } from "../services/yearDecoder";
import { HEAT_LINES, MAP_LAYERS, MAP_SOURCES } from "../utils/constants";
import { domCache } from "../utils/domCache";
import { formatFileSize } from "../utils/formatters";
import { frameCoalescer } from "../utils/frameCoalescer";
import { logError } from "../utils/logger";
import { cssVar, onMapReady, whenContextRestored } from "../utils/mapHelpers";
import { dismissToast, showToast, type ToastAction } from "../utils/toast";
import { dimsHeatmap, dimsHeatmapAtAnyZoom } from "./layerVisibility";
import { AVIATION_BAND } from "../mapLayers";
import {
  HEATMAP_OPACITY,
  dimmedWithin,
  fadeOutToLines,
  heatLineOpacities,
  heatLinesPaint,
  heatmapPaint,
} from "./heatmapPaint";

/**
 * The points of a heat source with the heat of each, and the flights its
 * heat lines are of
 */
export interface Heat {
  points: readonly Coordinate[];
  /** The heat of each point, as the flights left it (see heatmapPoints) */
  weights: readonly number[];
  segments: PathSegment[];
  /** The paths the heat is of, null for all of `segments` */
  kept: ReadonlySet<number> | null;
  /**
   * How the heatmap draws the heat, its exposure and the weights scaled by
   * it and rolled off, and the content of its source: worked out by the
   * year worker (see DataManager.drawHeat), null until it has answered
   */
  drawn: DrawnHeat | null;
}

/** What a heat line source is given while there are no lines to show */
const NO_LINES: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/** Stand-in for `--heatmap-dimmed-opacity` when the stylesheet has none */
const HEATMAP_DIMMED_OPACITY_FALLBACK = 0.35;

/**
 * How many levels short of the hand-over to the heat lines a zoom may end
 * for them to be worked out (see writeHeatLines)
 */
const HEAT_LINES_LEAD = 1;

/** The keys that decide what the heatmap and the colour layers draw */
const DRAWN_KEYS: readonly (keyof StoreState)[] = [
  "currentData",
  "selectedYear",
  "selectedAircraft",
  "selectedPathIds",
  "isolateSelection",
];

/** What the indicator says: "Loading 2026 flights (1.1 MB)…" */
function loadingLabel(state: LoadingState): string {
  const what = state.all ? "all" : state.years.join(", ");
  const size =
    state.fileBytes !== undefined
      ? " (" + formatFileSize(state.fileBytes) + ")"
      : "";
  return "Loading " + (what ? what + " " : "") + "flights" + size + "…";
}

export class DataManager {
  private app: MapApp;
  private dataLoader: DataLoader;
  /** Set when the loader already reported a failure via toast */
  private loadErrorReported = false;
  /** The Retry of the failure toast of the load under way, and its year */
  private retry: ToastAction | undefined;
  private retryYear = "";
  /** The failures on screen, which stay until dismissed */
  private failures = new Set<string>();
  /**
   * Where a failure is said while the page has no flights at all, in place
   * of a toast: the note on the empty map with its Retry (see
   * followLoadFailure in appInitializer.ts). The two at once said the same
   * thing twice, in two places, styled apart.
   */
  failureNote: ((message: string) => void) | null = null;
  /**
   * Told when metadata.json arrives after the first load went without it
   * (see loadInitialData): a load of all years asks for it again
   */
  onMetadata: ((metadata: Metadata) => void) | null = null;
  /**
   * The failures said on that note since a load last ended. A load of all
   * years brings the ones that did load, which hide the note with the
   * failure of the others on it: they go into toasts then.
   */
  private noted: [string, ToastAction | undefined][] = [];
  /** What the layers were last drawn for, to tell a restyle from a rebuild */
  private drawn: {
    data: KMLDataset;
    year: string;
    aircraft: string;
    isolate: boolean;
  } | null = null;
  /** The heat layer has its paint; it is created without one */
  private heatmapPainted = false;
  /**
   * What the heat source is to show: its points, and the flights its heat
   * lines are drawn from. Kept for a map that cannot take it yet (no
   * source, or a lost WebGL context), and for the heat lines, which are
   * worked out only once they can show (see writeHeatLines).
   */
  heat: Heat | null = null;
  /**
   * What the source of an isolated selection is to show, null while none
   * is: the heatmap draws that instead of the heat source, which keeps its
   * points (see applyHeatmapEmphasis)
   */
  private isolated: Heat | null = null;
  /**
   * The last isolated selection's heat, and what it was worked out for:
   * isolated again, the source still holds its points
   */
  private isolatedFor: {
    data: KMLDataset;
    filter: string;
    ids: ReadonlySet<number>;
    heat: Heat;
  } | null = null;
  /**
   * The heat each heat source holds, to not send it a second time: the
   * source would read, parse and cut the text of 135000 points anew, in
   * MapLibre's worker, for the same heat
   */
  private heatWritten: Heat | null = null;
  private isolatedWritten: Heat | null = null;
  /**
   * The stylesheet's dimmed opacity, read the first time it is wanted: a
   * computed style read during a change can force the page's styles to be
   * worked out again, and the token does not change
   */
  private dimmedOpacity: number | undefined;
  /** The heat the heat lines source was last worked out for, if any */
  private heatLinesFor: Heat | null = null;
  /** Counts the requests for heat lines: only the last one is written */
  private linesRequest = 0;
  /** The heats the year worker is working out, see drawHeat */
  private readonly drawing = new WeakSet<Heat>();
  /** The Blob URL each source was given last, see writeSource */
  private readonly sourceUrls = new Map<string, string>();
  /**
   * Requests for the heat sources the year worker has not answered yet: a
   * map that is idle meanwhile is still to be given its heat, which
   * Wrapped's map (revealMapWhenPainted in ui/wrappedManager.ts) and the
   * e2e tests (waitForMapIdle in tests/e2e/map.ts) wait for
   */
  heatRequests = 0;
  /** Come to rest near the hand-over, the heat lines are worked out */
  private readonly handleZoomEnd = (): void => this.writeHeatLines();
  /** The indicator is up; asked on every chunk, so not asked of the DOM */
  private loadingShown = false;
  /** The operation the bar on screen belongs to, see LoadingState */
  private drawnOperation: number | null = null;
  /**
   * Chunks arrive far more often than the screen repaints, so the indicator
   * is brought up to date once per frame, from the latest state
   */
  private readonly loadingFrame = frameCoalescer<LoadingState>((state) =>
    this.drawLoading(state),
  );
  private destroyed = false;

  constructor(app: MapApp) {
    this.app = app;

    this.dataLoader = new DataLoader({
      dataDir: app.config.dataDir,
      showLoading: (state) => this.showLoading(state),
      hideLoading: () => this.hideLoading(),
      onMetadata: (metadata) => this.onMetadata?.(metadata),
      onLoadError: (failedYears, stale) => {
        this.loadErrorReported = true;
        // As the other failure of a load says it (see loadData)
        this.fail(
          "Could not load the flights of " +
            failedYears.join(", ") +
            // The site was published again since the page was loaded
            (stale ? ". Reload the page to update it." : ""),
          // The first load of all years has no signal, so it is not given
          // up when a switch replaces it, and reports its years later: the
          // Retry of that switch is not one for them
          this.retryYear === "all" || failedYears.includes(this.retryYear)
            ? this.retry
            : undefined,
        );
      },
    });

    // The layers follow the dataset, the filter and the selection, whoever
    // changes them. Before the first dataset there is nothing to draw.
    app.store.subscribeKeys(DRAWN_KEYS, () => this.followStore());

    onMapReady(app, "The heat", (map) => {
      map.on("zoomend", this.handleZoomEnd);
      // The sources are back with the data they held at the loss, the
      // last written (MapLibre keeps it with the style); what could not
      // reach them since is written now
      whenContextRestored(map, () => this.writeHeat(), app.signal);
    });
  }

  /**
   * Show the loading indicator, or bring it up to date: the loader calls
   * this on every change of what it is loading, down to every chunk.
   *
   * The label is announced by a live region. One that appears with its text
   * in place is passed over by many screen readers; what they announce is
   * text that changes while the region is displayed. So the indicator comes
   * up without a label, which also keeps the one of the last load from
   * showing while frames are held back, and is written a frame later.
   */
  showLoading(state: LoadingState): void {
    // A request that outlives the app still reports
    if (this.destroyed) return;
    if (!this.loadingShown) {
      const loadingEl = domCache.get("loading");
      if (!loadingEl) return;
      this.loadingShown = true;
      loadingEl.style.display = "block";
      const textEl = domCache.get("loading-text");
      if (textEl) textEl.textContent = "";
    }
    this.loadingFrame.schedule(state);
  }

  hideLoading(): void {
    this.loadingFrame.cancel();
    this.loadingShown = false;
    const loadingEl = domCache.get("loading");
    if (loadingEl) loadingEl.style.display = "none";
    const bar = domCache.get("loading-progress");
    if (bar) hideProgressBar(bar);
  }

  /**
   * Stop drawing, end the year worker, and take the indicator down: a load
   * that is still under way would otherwise leave it up with nobody to hide it
   */
  destroy(): void {
    this.destroyed = true;
    this.app.map?.off("zoomend", this.handleZoomEnd);
    this.dataLoader.destroy();
    this.hideLoading();
    for (const url of this.sourceUrls.values()) URL.revokeObjectURL(url);
    this.sourceUrls.clear();
  }

  private drawLoading(state: LoadingState): void {
    // Whatever changes what the label says is worth saying: another year,
    // all of them, or one that failed and is no longer waited for
    const textEl = domCache.get("loading-text");
    const label = loadingLabel(state);
    if (textEl && textEl.textContent !== label) textEl.textContent = label;

    const bar = domCache.get("loading-progress");
    if (!bar) return;
    const { operation, loadedBytes, totalBytes } = state;
    // Without a total there is no share to draw: the spinner already says
    // that something is loading, which is all that is known then
    if (totalBytes === undefined) {
      hideProgressBar(bar);
      return;
    }
    const incomplete = loadedBytes < totalBytes;
    // The stylesheet lets the bar appear a moment after it is displayed, so
    // that a load that is over at once shows none. A new operation gets
    // that moment again, or a year that joins from the HTTP cache would
    // flash past on the bar of a slow one; that takes the bar being taken
    // out and the style being worked out without it.
    if (operation !== this.drawnOperation && incomplete && !bar.hidden) {
      bar.hidden = true;
      void bar.offsetWidth;
    }
    this.drawnOperation = operation;
    // A bar that is up is kept, full; none is brought up for bytes that
    // are all in, since the delay would only put off its flash
    if (bar.hidden && !incomplete) return;

    bar.hidden = false;
    // The CSP allows no style attribute in the markup; the CSSOM is fine
    bar.style.setProperty(
      "--loading-progress",
      String(incomplete ? loadedBytes / totalBytes : 1),
    );
    // In steps of ten: a screen reader that follows the value would
    // otherwise have something new to say on every frame. Worked out on the
    // byte counts, which are whole numbers and land on a step exactly.
    const step = String(
      incomplete ? Math.floor((loadedBytes * 10) / totalBytes) * 10 : 100,
    );
    if (bar.getAttribute("aria-valuenow") !== step) {
      bar.setAttribute("aria-valuenow", step);
    }
  }

  /**
   * Fade the heatmap back while a colour layer, the selection's lines or
   * the aviation chart are drawn over it (see dimsHeatmap).
   *
   * Both are on by default, and the heatmap's cyan bloom under the altitude
   * or speed gradient washes out exactly the scale the user just switched on.
   * A thin line of a selection is lost in its white as well. The layer stays
   * visible and its toggle still owns whether it is there at all; this only
   * settles which reads first. The chart draws at a band of zooms only,
   * which the opacity follows by zoom (dimmedWithin): in every frame of a
   * pinch, where an opacity set once the map came to rest lagged behind.
   * Not so the cores of the heat lines, whose opacity follows the heat of
   * each line as well: MapLibre works such a paint out at whole zooms
   * only, and blends between them, so the end of the band just past zoom
   * 13 dimmed them up to 14, at rest. They step back where the map comes
   * to rest (dimsHeatmap).
   */
  applyHeatmapEmphasis(): void {
    const map = this.app.map;
    // The store may change before the style, and with it the layer, is there
    if (!map?.getLayer(MAP_LAYERS.heat)) return;
    const always = dimsHeatmapAtAnyZoom(this.app);
    const dimmed =
      (this.dimmedOpacity ??= dimmedHeatmapOpacity()) / HEATMAP_OPACITY;
    const strength = always ? dimmed : 1;
    const lines = heatLineOpacities(strength);
    // As strong as that, and dimmed across the chart's band while it is on
    const byZoom = (curve: ExpressionSpecification): ExpressionSpecification =>
      always || !this.app.aviationVisible
        ? curve
        : dimmedWithin(curve, dimmed, AVIATION_BAND);
    // One of the two heatmaps is drawn, the one of an isolated selection
    // while there is one; at no opacity the map leaves the other out. The
    // isolated one once its source was given the selection's heat (see
    // writeHeat): until the year worker has drawn it, its source still
    // holds the selection isolated before, and the heat of before is shown
    const isolated = !!this.isolated && this.isolatedWritten === this.isolated;
    const heat = byZoom(fadeOutToLines(HEATMAP_OPACITY * strength));
    for (const [id, drawn] of [
      [MAP_LAYERS.heat, !isolated],
      [MAP_LAYERS.heatIsolated, isolated],
    ] as const) {
      map.setPaintProperty(id, "heatmap-opacity", drawn ? heat : 0);
    }
    // The lines it hands over to step back as far
    for (const [id, lineOpacity] of [
      [MAP_LAYERS.heatLinesGlow, byZoom(lines.glow)],
      [
        MAP_LAYERS.heatLinesCore,
        heatLineOpacities(dimsHeatmap(this.app) ? dimmed : 1).core,
      ],
    ] as const) {
      if (map.getLayer(id))
        map.setPaintProperty(id, "line-opacity", lineOpacity);
    }
  }

  /**
   * Give the heat layer and its lines their look, once. They are created
   * bare (see addDataLayers), and what they look like is this module's
   * business.
   */
  private paintHeatmap(): void {
    const map = this.app.map;
    if (this.heatmapPainted || !map?.getLayer(MAP_LAYERS.heat)) return;
    const paint = heatmapPaint();
    for (const name of Object.keys(paint) as (keyof typeof paint)[]) {
      map.setPaintProperty(MAP_LAYERS.heat, name, paint[name]);
      map.setPaintProperty(MAP_LAYERS.heatIsolated, name, paint[name]);
    }
    for (const [id, linePaint] of Object.entries(heatLinesPaint())) {
      if (!map.getLayer(id)) continue;
      for (const name of Object.keys(linePaint) as (keyof typeof linePaint)[]) {
        map.setPaintProperty(id, name, linePaint[name]);
      }
    }
    this.heatmapPainted = true;
    // The paint above is the undimmed one
    this.applyHeatmapEmphasis();
  }

  /**
   * Hand the heat source its points, and the source of an isolated
   * selection its own, or none. A hidden layer takes them as well as a
   * visible one, so nothing has to wait for the layer to be shown.
   *
   * Not every redraw changes them: a selection, isolated or not, or an
   * aircraft that flew every path of the year, leaves the heat source's
   * points as they are, and the same points are not sent again. The
   * coordinates are the dataset's own arrays, never copies, so comparing
   * them one by one by identity is both exact and cheap, and the same
   * points carry the same heat.
   */
  private setHeatmapPoints(heat: Heat, isolated: Heat | null): void {
    const held = this.heat;
    const points = heat.points;
    if (
      held?.points.length !== points.length ||
      !held.points.every((point, index) => point === points[index])
    ) {
      this.heat = heat;
    }
    this.isolated = isolated;
    this.drawHeat(this.heat ?? heat);
    if (isolated) this.drawHeat(isolated);
    this.followExposure();
    this.applyHeatmapEmphasis();
    this.writeHeat();
  }

  /**
   * The heat legend says what the colours of the heat drawn stand for (see
   * ui/heatScale.ts): the exposure of the heat shown, once the year worker
   * has worked it out. Until then the heatmap still draws the heat of
   * before, and the legend keeps its exposure.
   */
  private followExposure(): void {
    const drawn = (this.isolated ?? this.heat)?.drawn;
    if (drawn) this.app.heatmapExposure = drawn.exposure;
  }

  /**
   * Have the year worker work out how the heatmap draws `heat`, and write
   * the content of its source (see services/heatSource.ts), once per heat.
   * The answer is shown if the heat still is one to show; one let go of
   * meanwhile keeps it, for an isolated selection that is isolated again.
   */
  private drawHeat(heat: Heat): void {
    if (heat.drawn || this.drawing.has(heat)) return;
    this.drawing.add(heat);
    this.askWorker(
      (decoder) =>
        decoder
          .drawHeat(heat.points, heat.weights)
          .finally(() => this.drawing.delete(heat)),
      (drawn) => {
        heat.drawn = drawn;
        if (heat === this.heat || heat === this.isolated) {
          this.followExposure();
          this.writeHeat();
        }
      },
    );
  }

  /**
   * Ask the year decoder, and hand its answer to `take` while the app is
   * still there: the worker ends with it, and takes its requests along.
   * A question that gets no answer is told to `failed`, and logged as one
   * of `what` was asked to draw. Counted in heatRequests until answered,
   * as the colour layers' lines are too (see LayerManager.setRuns).
   */
  askWorker<T>(
    ask: (decoder: YearDecoder) => Promise<T>,
    take: (answer: T) => void,
    failed?: () => void,
    what = "the heat",
  ): void {
    this.heatRequests++;
    void this.dataLoader
      .getDecoder()
      .then(ask)
      .then(
        (answer) => this.destroyed || take(answer),
        (error: unknown) => {
          if (this.destroyed) return;
          logError(`Could not draw ${what}:`, error);
          failed?.();
        },
      )
      .finally(() => {
        // An answer that is not written (one for a heat let go of) gives
        // the map nothing to draw, and so no `idle` to whoever waits for
        // the heat (see revealMapWhenPainted in ui/wrappedManager.ts)
        if (--this.heatRequests === 0 && !this.destroyed) {
          this.app.map?.triggerRepaint();
        }
      });
  }

  /**
   * Write what the heat sources are to show and do not hold yet: each heat
   * once the year worker has drawn it (see drawHeat)
   */
  private writeHeat(): void {
    const map = this.app.map;
    const heat = this.heat;
    const source = map?.getSource<GeoJSONSource>(MAP_SOURCES.heat);
    if (!heat || !source || this.destroyed) return;
    this.paintHeatmap();
    if (heat.drawn && this.heatWritten !== heat) {
      this.heatWritten = heat;
      void this.writeSource(source, heat.drawn.source);
    }
    const isolated = this.isolated;
    const isolatedSource = map?.getSource<GeoJSONSource>(
      MAP_SOURCES.heatIsolated,
    );
    if (
      isolated?.drawn &&
      isolatedSource &&
      this.isolatedWritten !== isolated
    ) {
      this.isolatedWritten = isolated;
      void this.writeSource(isolatedSource, isolated.drawn.source);
      // Drawn from that source from now on
      this.applyHeatmapEmphasis();
    }
    this.writeHeatLines();
  }

  /**
   * Give `source` the GeoJSON text of `content` by a Blob URL, which
   * MapLibre's worker reads and parses without the main thread (see
   * services/heatSource.ts), or GeoJSON as it is. The URL the source held
   * before is let go of once it has taken this one, and not before: a
   * source that was still reading it would fail. The one it holds stays,
   * for as long as it holds it. Settles once the source has taken it.
   */
  writeSource(
    source: GeoJSONSource,
    content: Blob | GeoJSON.FeatureCollection,
  ): Promise<unknown> {
    const { id } = source;
    const before = this.sourceUrls.get(id);
    const url =
      content instanceof Blob ? URL.createObjectURL(content) : undefined;
    if (url) this.sourceUrls.set(id, url);
    else this.sourceUrls.delete(id);
    // The promise is for the worker having taken the data. It does not
    // reject: a failure arrives as an `error` event of the map
    return source
      .setData(url ?? (content as GeoJSON.FeatureCollection))
      .then(() => {
        if (before) URL.revokeObjectURL(before);
      });
  }

  /**
   * The heat lines of the points the heatmap shows, worked out once they
   * can show soon: with the heatmap shown and a zoom that ended a level
   * short of where it hands over to them (see HEAT_LINES) or further in,
   * once per set of points. They are the same flights as the points, and
   * 150000 segments take the year worker 80 to 95 ms, which a hidden or
   * zoomed out heatmap has no use for. Worked out in a frame of the zoom,
   * they held up the pinch that crossed into them; a zoom in from a level
   * short of them finds them ready. The lines of other points are taken
   * off meanwhile: a zoom from further out would show them until it ends.
   */
  private writeHeatLines(): void {
    const map = this.app.map;
    const heat = this.isolated ?? this.heat;
    const source = map?.getSource<GeoJSONSource>(MAP_SOURCES.heatLines);
    const held = this.heatLinesFor;
    if (!map || !source || !heat || held === heat) return;
    const shown =
      this.app.heatmapLayer.isVisible() &&
      map.getZoom() >= HEAT_LINES.fromZoom - HEAT_LINES_LEAD;
    if (!shown && !held) return;
    // As bright as the heatmap draws the same heat (see exposedHeat), so
    // not before the year worker has worked that out (see drawHeat), which
    // writes them then; the heatmap draws the heat of before until then
    const drawn = heat.drawn;
    if (shown && !drawn) return;
    this.heatLinesFor = shown ? heat : null;
    const request = ++this.linesRequest;
    if (!shown || !drawn) {
      void this.writeSource(source, NO_LINES);
      return;
    }
    // Worked out and written by the year worker, along the flights it holds
    // (see services/flightLines.ts); only the lines asked for last are
    // written to the source
    const { segments, kept } = heat;
    this.askWorker(
      (decoder) => decoder.heatLines(segments, kept, drawn.exposure),
      (content) => {
        if (request === this.linesRequest) {
          void this.writeSource(source, content);
        }
      },
      // Asked for again at the next zoom rather than held as if written;
      // a heat that got no answer is asked for again with the next redraw
      () => {
        if (request === this.linesRequest) this.heatLinesFor = null;
      },
    );
  }

  /**
   * Show the heat layer, with the dimming it gets under a colour layer.
   * Every place that shows the layer goes through here, so none is left
   * without it.
   */
  showHeatmap(): void {
    if (!this.app.map) return;
    this.paintHeatmap();
    this.app.heatmapLayer.setVisible(true);
    this.writeHeatLines();
  }

  /**
   * Load a year's dataset. `signal` is aborted by a caller that no longer
   * waits for it (a year switch that another one replaced), so that the
   * indicator stops waiting for its year; another caller of the same year
   * still gets it.
   */
  async loadData(
    year: string,
    signal?: AbortSignal,
    retry?: ToastAction,
  ): Promise<KMLDataset | null> {
    this.loadErrorReported = false;
    // What the failure toast offers: the caller knows what trying again means
    this.retry = retry;
    this.retryYear = year;
    const data = await this.dataLoader.loadData(year, signal);
    const noted = this.noted.splice(0);
    if (data) {
      for (const [message, action] of noted) this.toastFailure(message, action);
    }
    if (data && !data.incomplete) {
      // The page has a whole dataset again: what failed before is over
      this.dismissFailures();
    } else if (
      !data &&
      !this.loadErrorReported &&
      !signal?.aborted &&
      !this.destroyed
    ) {
      this.fail(
        "Could not load the flights" + (year === "all" ? "" : " of " + year),
        retry,
      );
    }
    return data;
  }

  /** Take the failure toasts of loads off the screen, and no other error */
  dismissFailures(): void {
    for (const message of this.failures) dismissToast(message);
    this.failures.clear();
  }

  /**
   * Say that a load failed; an error stays until dismissed. On an empty
   * map the note there says it (failureNote).
   */
  private fail(message: string, retry: ToastAction | undefined): void {
    if (this.failureNote && !this.app.currentData) {
      this.noted.push([message, retry]);
      this.failureNote(message);
      return;
    }
    this.toastFailure(message, retry);
  }

  private toastFailure(message: string, retry: ToastAction | undefined): void {
    this.failures.add(message);
    showToast(message, "error", retry);
  }

  async loadAirports(): Promise<Airport[] | null> {
    return await this.dataLoader.loadAirports();
  }

  async loadMetadata(): Promise<Metadata | null> {
    return await this.dataLoader.loadMetadata();
  }

  /**
   * The dataset of a year this session holds already, without loading it
   * (Wrapped counts the airspace new in a year from those: see
   * calculations/newAreas.ts)
   */
  cachedData(year: string): KMLDataset | undefined {
    return this.dataLoader.cachedData(year);
  }

  /**
   * Rebuild what a change of the dataset or the filter changes. A change of
   * the selection or of isolation alone leaves the runs of the colour layers
   * as they are, whose layers leave out what they must not show by a filter
   * (see LayerManager.updateSelectionStyles); only the heatmap, which
   * isolation narrows to the selection, is given its points again.
   */
  private followStore(): void {
    const { currentData, selectedYear, selectedAircraft, isolateSelection } =
      this.app;
    const drawn = this.drawn;
    if (
      !currentData ||
      drawn?.data !== currentData ||
      drawn.year !== selectedYear ||
      drawn.aircraft !== selectedAircraft
    ) {
      this.updateLayers();
      return;
    }
    if (drawn.isolate || isolateSelection) {
      this.drawHeatmap(currentData);
    }
    this.app.layerManager.updateSelectionStyles();
  }

  /**
   * Rebuild the heatmap and the colour layers for the dataset on the map.
   * The statistics panel and the airport markers follow the store on their
   * own, the visibility of the layers as well (see ui/layerVisibility.ts).
   */
  updateLayers(): void {
    const data = this.app.currentData;
    if (!this.app.map || !data) return;

    this.drawHeatmap(data);

    // The altitude range of all segments, whatever the filter keeps
    if (data.path_segments.length > 0) {
      this.app.altitudeRange = calculateAltitudeRange(
        data.path_segments,
        this.app.altitudeRange,
        data.path_info,
      );
    }

    // Only the colour layers that show are drawn; the others are drawn as
    // they show, and hold no stale data meanwhile
    this.app.layerManager.syncModes(true);
  }

  /**
   * Give the heatmap the points of what the filter and isolation keep. The
   * heat of the filter is worked out again only for another dataset or
   * filter: a change of the selection or of isolation keeps it.
   */
  private drawHeatmap(data: KMLDataset): void {
    const { selectedYear: year, selectedAircraft: aircraft } = this.app;
    const drawn = this.drawn;
    const same =
      drawn?.data === data &&
      drawn.year === year &&
      drawn.aircraft === aircraft;
    this.drawn = { data, year, aircraft, isolate: this.app.isolateSelection };

    // What the year/aircraft filter keeps: a year filter over that year's
    // own file keeps every path
    const view = datasetIndex(data).filter(year, aircraft);
    const segments = data.path_segments;
    const kept = view.keepsAll ? null : view.pathIds;
    const heat =
      same && this.heat ? this.heat : heatOf(segments, segments, kept);
    this.setHeatmapPoints(
      heat,
      this.app.isolateSelection ? this.isolatedHeat(data, kept) : null,
    );
  }

  /**
   * The heat of the selected paths the filter keeps, exactly what the
   * colour layers draw of an isolated selection, worked out from their
   * segments alone; the one of before for the same selection (a new
   * selection is a new set, see PathSelection)
   */
  private isolatedHeat(
    data: KMLDataset,
    kept: ReadonlySet<number> | null,
  ): Heat {
    const ids = this.app.selectedPathIds;
    const filter = this.app.selectedYear + "/" + this.app.selectedAircraft;
    const held = this.isolatedFor;
    if (held?.data === data && held.filter === filter && held.ids === ids) {
      return held.heat;
    }
    const isolated = new Set([...ids].filter((id) => !kept || kept.has(id)));
    const segments = data.path_segments;
    const heat = heatOf(segmentsForPathIds(segments, ids), segments, isolated);
    this.isolatedFor = { data, filter, ids, heat };
    return heat;
  }
}

/**
 * The heat of the flights of `kept` (of all, for null): the points of
 * `pointSegments` (all of `segments` or the part of them those flights are
 * in) with their heat, and the lines of `segments`. How the heatmap draws
 * it, scaled by its exposure and rolled off, the year worker works out (see
 * drawHeat).
 */
function heatOf(
  pointSegments: PathSegment[],
  segments: PathSegment[],
  kept: ReadonlySet<number> | null,
): Heat {
  const { points, weights } = heatmapPoints(
    pointSegments,
    (pathId) => !kept || kept.has(pathId),
    heatWeight,
  );
  return { points, weights, segments, kept, drawn: null };
}

/**
 * Back to the state without a known share: no bar, no value. Asked of the
 * bar itself, so that it holds for one that another instance left behind;
 * cheap when it is hidden already, which is every frame of a load without
 * sizes.
 */
function hideProgressBar(bar: HTMLElement): void {
  if (bar.hidden) return;
  bar.hidden = true;
  bar.removeAttribute("aria-valuenow");
  bar.style.removeProperty("--loading-progress");
}

/**
 * How far the heatmap steps back under a colour layer. That is a design
 * decision, so it lives in the stylesheet with the rest of them; a paint
 * property cannot read `var()`, so the token is read here.
 */
export function dimmedHeatmapOpacity(): number {
  const value = Number.parseFloat(cssVar("--heatmap-dimmed-opacity"));
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : HEATMAP_DIMMED_OPACITY_FALLBACK;
}

/**
 * The heat of a point is counted in units of this many seconds: about the
 * pace a flight logger writes fixes at (2 to 5 s in the sample flights, 4
 * on average), so a fix of a track weighs about 1, as every fix did when
 * they were counted, and the look of the heatmap tuned for that holds
 */
const FIX_SECONDS = 4;

/**
 * The heatmap points of the paths `keep` accepts, and the heat of each:
 * every kept segment's start point, with the heat of the segment (see
 * heatWeight), the time until the next fix. So the heatmap counts the time
 * spent at a place rather than the fixes a logger wrote there: one that
 * writes a fix every 2 s no longer weighs two and a half times one that
 * writes every 5 s. The end of a flight has no time after it, and a point
 * of no heat is left out.
 */
export function heatmapPoints(
  segments: PathSegment[],
  keep: (pathId: number) => boolean,
  weigh: SegmentWeight,
): { points: Coordinate[]; weights: number[] } {
  const points: Coordinate[] = [];
  const weights: number[] = [];
  segments.forEach((segment, index) => {
    const weight = keep(segment.path_id)
      ? weigh(segment, segments[index + 1]) / FIX_SECONDS
      : 0;
    if (weight > 0) {
      points.push(segment.coords[0]);
      weights.push(weight);
    }
  });
  return { points, weights };
}
