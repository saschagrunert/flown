/**
 * Data loading and caching service
 * Handles loading KML data files, airports, and metadata
 */

import { logDebug, logError } from "../utils/logger";
import type { YearDecoder } from "./yearDecoder";
import { importWithRetry, timedImports } from "./lazyImport";
import { siteData } from "../state/siteData";
import type {
  KMLDataset,
  Airport,
  Metadata,
  FetchJsonOptions,
  LoadingState,
} from "../types";

/**
 * Validate year parameter to prevent path traversal attacks
 * @param year - Year string to validate
 * @returns true if valid
 */
export function isValidYear(year: string): boolean {
  // Must be 'all' or a four-digit year. The shape is what keeps the value out
  // of the path; which years actually exist is metadata.available_years, so no
  // numeric range is imposed here.
  if (year === "all") return true;
  return /^\d{4}$/.test(year);
}

/**
 * How long a data file may take to load. The largest year file is a few MB,
 * so this leaves room for a slow connection; a request that neither loads
 * nor errors within it (a stalled connection) is aborted, so the year can be
 * requested again instead of staying in flight forever.
 */
const LOAD_TIMEOUT_MS = 120_000;

/**
 * The body of a response, counted as it passes through.
 *
 * What the stream yields is the body after the browser has undone the
 * transfer encoding, so the count runs up to the size of the file on disk
 * (metadata.year_file_bytes), not to Content-Length, which is the gzipped
 * size on a server that compresses.
 *
 * The chunks are passed on untouched, for the browser to collect, decode and
 * parse natively, which is what makes this the cheap path: all it adds to
 * `response.json()` is one call per chunk of some tens of kilobytes. Decoding
 * the chunks here instead would build the text of a year file from thousands
 * of appended pieces, which the engine has to flatten into a second copy
 * before it can parse it. A transform is also simpler to get right than a
 * tee of the body: there is one consumer, so its backpressure reaches the
 * network, nothing buffers for a slower branch, and an abort or a broken
 * connection errors the one pipe from end to end.
 * @param body - Body stream of the response
 * @param onProgress - Called with the running total after every chunk
 * @returns A stream of the same bytes
 */
function countBytes(
  body: ReadableStream<Uint8Array>,
  onProgress: (loadedBytes: number) => void,
): ReadableStream<Uint8Array> {
  let loadedBytes = 0;
  let report: typeof onProgress | null = onProgress;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        loadedBytes += chunk.byteLength;
        // A throw in here would error the stream, and with it fail the
        // download of a file that is arriving fine. Whoever listens is
        // dropped after the first one instead.
        try {
          report?.(loadedBytes);
        } catch (error) {
          report = null;
          logError("Progress callback failed:", error);
        }
      },
    }),
  );
}

/**
 * Fetch a file of the site and read its body
 * @param url - URL to load
 * @param options - Timeout and progress callback, see FetchJsonOptions
 * @param read - Reads the body off the response, which may be a counted one
 * @returns What `read` made of the body
 */
async function fetchBody<T>(
  url: string,
  options: FetchJsonOptions,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  const { timeoutMs = LOAD_TIMEOUT_MS, onProgress } = options;
  const controller = new AbortController();
  // The timer spans the body as well: a response whose headers arrived can
  // still stall halfway through a year file
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    // Counting is paid for only when somebody asked for the count
    if (!onProgress || !response.body || !("TransformStream" in globalThis)) {
      return await read(response);
    }
    return await read(new Response(countBytes(response.body, onProgress)));
  } catch (error) {
    const reason = controller.signal.aborted
      ? "Timed out loading"
      : "Failed to load";
    // Whatever went wrong, a body that is still arriving is let go of
    controller.abort();
    throw new Error(`${reason} ${url}`, { cause: error });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch and parse a JSON file of the site
 * @param url - URL to load
 * @param options - Timeout and progress callback, see FetchJsonOptions
 * @returns The parsed contents
 */
export function fetchJson(
  url: string,
  options: FetchJsonOptions = {},
): Promise<unknown> {
  return fetchBody(url, options, (response) => response.json());
}

/**
 * Fetch a file of the site as it is. A year file is fetched this way: it is
 * the year worker that parses it (services/yearDecoder.ts), and bytes are
 * what can be handed to it without the main thread reading them first.
 * @param url - URL to load
 * @param options - Timeout and progress callback, see FetchJsonOptions
 * @returns The bytes of the body
 */
export function fetchBytes(
  url: string,
  options: FetchJsonOptions = {},
): Promise<ArrayBuffer> {
  return fetchBody(url, options, (response) => response.arrayBuffer());
}

/** What build.js names the bundle of ./yearWorker, next to this one */
const YEAR_WORKER_BUNDLE = "./yearWorker.bundle.js";

/** What the loader uses of services/yearWorker.ts */
type YearTools = Pick<typeof import("./yearWorker"), "createYearDecoder">;

/**
 * Import what works on year data: the worker that parses and decodes the
 * year files, and what builds the datasets from its answers. None of it is
 * part of the app's bundles; the build resolves the specifier to
 * yearWorker.bundle.js, which the page fetches next to the first year file
 * (see services/lazyImport.ts for a retry).
 * @param failedImports - Imports that were rejected before this one
 * @returns The exports of services/yearWorker.ts
 */
export function importYearTools(failedImports: number): Promise<YearTools> {
  return importWithRetry(
    () => import("./yearWorker"),
    YEAR_WORKER_BUNDLE,
    failedImports,
  );
}

/**
 * DataLoader constructor options
 */
export interface DataLoaderOptions {
  dataDir?: string;
  /** `onProgress` is given for year files of a known size, the ones a bar is drawn for */
  fetchJson?: (url: string, options?: FetchJsonOptions) => Promise<unknown>;
  /** Fetches the year files, which the year worker parses; same options */
  fetchBytes?: (
    url: string,
    options?: FetchJsonOptions,
  ) => Promise<ArrayBuffer>;
  /** Imports the year worker's bundle, see importYearTools */
  importYearTools?: typeof importYearTools;
  /** Invoked whenever the loading operation changes, see LoadingState */
  showLoading?: (state: LoadingState) => void;
  hideLoading?: () => void;
  /**
   * Invoked once per top-level load when one or more year files failed to
   * load, with the list of failed years. `stale` is set once a year file
   * turned out to be of another format than this page reads: a cached page
   * next to newer data, which a reload of the page cures.
   */
  onLoadError?: (failedYears: string[], stale?: boolean) => void;
  /** Invoked once, when metadata.json has arrived, whoever asked for it */
  onMetadata?: (metadata: Metadata) => void;
}

/** One year file of the loading operation, see DataLoader */
interface Download {
  /** Size of the file from the metadata; undefined when it is unknown */
  size: number | undefined;
  /** Bytes of the body read so far, as counted */
  received: number;
  /** Bytes that had arrived before the operation began */
  before: number;
  /** Still in flight: neither arrived nor failed */
  pending: boolean;
  /** Part of the indicator; not once every caller has given up on it */
  held: boolean;
  /** Callers waiting for it; one without a signal waits to the end */
  waiters: number;
}

/** The load of every year, shared by its callers, see loadAndCombineAllYears */
interface AllYearsRun {
  promise: Promise<KMLDataset | null>;
  /** Aborted once every caller has given up on it */
  controller: AbortController;
  /** Callers waiting for it; one without a signal waits to the end */
  waiters: number;
}

/**
 * Name of the error a year file of another format fails with (decodeYear).
 * Spelled out in both places: an import of the other module would move it
 * into a chunk of its own, which the page would then load up front. A page
 * that a cache kept next to newer data is what usually causes it.
 */
const STALE_DATA_ERROR = "StaleDataError";

/** The value, if it passes the guard; the file's name in the error if not */
function checked<T>(
  json: unknown,
  guard: (value: unknown) => value is T,
  file: string,
): T {
  if (!guard(json)) throw new Error("Unexpected contents of " + file);
  return json;
}

/** The fields of airports.json that the page reads */
function isAirports(value: unknown): value is { airports: Airport[] } {
  const airports = (value as { airports?: unknown } | null)?.airports;
  return (
    Array.isArray(airports) &&
    airports.every(
      (airport: Partial<Airport> | null) =>
        typeof airport?.name === "string" &&
        typeof airport.lat === "number" &&
        typeof airport.lon === "number",
    )
  );
}

/** The field of metadata.json that the page cannot do without */
function isMetadata(value: unknown): value is Metadata {
  return Array.isArray((value as Partial<Metadata> | null)?.available_years);
}

/**
 * Data loader class with caching, in-flight request deduplication and a
 * reference-counted loading indicator.
 *
 * The indicator shows one loading operation: the year files being downloaded,
 * how large they are and how much of them has arrived. Label and bar are
 * both derived from that one model (see LoadingState), anew on every report:
 * it has one entry per year file, so there is nothing to gain from sums kept
 * on the side, which could drift from it. A year that is cached is part of
 * neither label nor bar, since it is not downloaded.
 *
 * Loads can overlap: the user picks another year while one is loading, or
 * "all" while a year is. Within an operation the share only grows: a file
 * that has arrived stays in it as loaded, which is what lets the years of
 * "all" fill one bar. Whenever the set changes in any other way (a load
 * joins, or one fails) a new operation begins. Its bar covers the loads
 * still in flight and only the bytes they still have to download, so it
 * starts over from nothing, rather than dropping to some share in between
 * or counting bytes that never arrived. The label keeps naming whole files
 * and their whole size.
 */
export class DataLoader {
  private dataDir: string;
  private cache: Map<string, KMLDataset>;
  private inflight: Map<string, Promise<KMLDataset | null>>;
  private loadingDepth: number;
  /** "all" is among the loads, which decides what the label calls them */
  private loadingAll = false;
  /** The load of every year in flight, see loadAndCombineAllYears */
  private allRun: AllYearsRun | null = null;
  /** Counts the operations, so that the indicator can tell them apart */
  private operation = 0;
  private fetchJson: NonNullable<DataLoaderOptions["fetchJson"]>;
  private fetchBytes: NonNullable<DataLoaderOptions["fetchBytes"]>;
  /**
   * Imports the year tools (see importYearTools), each given up on after
   * as long as a year file may take
   */
  private importYearTools: () => ReturnType<typeof importYearTools>;
  /** Started with the first year file, see getDecoder */
  private decoder: YearDecoder | null = null;
  private decoderRequest: Promise<YearDecoder> | null = null;
  /** Set by destroy(); a load that ends after it has nobody to tell */
  private destroyed = false;
  /** The year files of the loading operation; emptied with the indicator */
  private downloads = new Map<string, Download>();
  /** Every year file in flight, shown or not */
  private yearDownloads = new Map<string, Download>();
  /** A year file was written by another release than this page's */
  private staleData = false;
  /** The request in flight, so that concurrent callers share it */
  private airportsRequest: Promise<{ airports: Airport[] }> | null = null;
  private metadataRequest: Promise<Metadata> | null = null;
  private showLoading: (state: LoadingState) => void;
  private hideLoading: () => void;
  private onLoadError: NonNullable<DataLoaderOptions["onLoadError"]>;
  private onMetadata: DataLoaderOptions["onMetadata"];

  constructor(options: DataLoaderOptions = {}) {
    this.dataDir = options.dataDir || "data";
    this.cache = new Map();
    this.inflight = new Map();
    this.loadingDepth = 0;
    this.fetchJson = options.fetchJson || fetchJson;
    this.fetchBytes = options.fetchBytes || fetchBytes;
    this.importYearTools = timedImports(
      options.importYearTools || importYearTools,
      LOAD_TIMEOUT_MS,
      "Timed out loading " + YEAR_WORKER_BUNDLE,
    );
    this.showLoading = options.showLoading || (() => {});
    this.hideLoading = options.hideLoading || (() => {});
    this.onLoadError = options.onLoadError || (() => {});
    this.onMetadata = options.onMetadata;
  }

  /**
   * Tell the indicator what the operation looks like now. The indicator is
   * not the loader's business: if it throws, the load it reports on goes on,
   * and the count of loads that takes the indicator down again stays right.
   */
  private report(): void {
    try {
      if (this.loadingDepth === 0) {
        this.hideLoading();
        return;
      }
      let loadedBytes = 0;
      let totalBytes = 0;
      let fileBytes = 0;
      // Nothing can be a share of an unknown total: one file of unknown
      // size, or no file yet, leaves all three numbers out
      let sized = this.downloads.size > 0;
      for (const { size, received, before } of this.downloads.values()) {
        if (size === undefined) {
          sized = false;
          break;
        }
        fileBytes += size;
        totalBytes += size - before;
        // A file counts up to its expected size and no further, so one that
        // turns out larger than the metadata said cannot stand in for
        // another that is still missing
        loadedBytes += Math.min(received, size) - before;
      }
      this.showLoading({
        operation: this.operation,
        all: this.loadingAll,
        years: [...this.downloads.keys()],
        fileBytes: sized ? fileBytes : undefined,
        loadedBytes: sized ? loadedBytes : 0,
        totalBytes: sized ? totalBytes : undefined,
      });
    } catch (error) {
      logError("Loading indicator failed:", error);
    }
  }

  /**
   * Begin a new operation with the loads that are still in flight, each
   * counted from where it stands now (see the class comment)
   */
  private restartOperation(): void {
    this.operation++;
    for (const [year, download] of this.downloads) {
      if (!download.pending) this.downloads.delete(year);
      else download.before = Math.min(download.received, download.size ?? 0);
    }
  }

  /** A year file starts downloading */
  private beginDownload(year: string): Download {
    const size = siteData.metadata?.year_file_bytes?.[year];
    const download: Download = {
      // A size of zero is as good as none: nothing can be a share of it
      size: size !== undefined && size > 0 ? size : undefined,
      received: 0,
      before: 0,
      pending: true,
      held: false,
      waiters: 0,
    };
    this.yearDownloads.set(year, download);
    return download;
  }

  /**
   * A caller waits for a year file. The file is part of the indicator for
   * as long as one does: once each has aborted its signal (it switched to
   * another year, one that may be cached), the indicator lets go of the
   * file, which still downloads into the cache. A caller that comes back
   * for it before it has arrived brings it back.
   */
  private wait(year: string, download: Download, signal?: AbortSignal): void {
    download.waiters += signal ? 1 : Infinity;
    if (!download.held) {
      download.held = true;
      this.loadingDepth++;
      this.restartOperation();
      this.downloads.set(year, download);
      this.report();
    }
    signal?.addEventListener(
      "abort",
      () => {
        if (--download.waiters > 0 || !download.held) return;
        download.held = false;
        this.downloads.delete(year);
        this.restartOperation();
        this.endLoading();
      },
      { once: true },
    );
  }

  /** More of a year file has arrived */
  private advanceDownload(download: Download, fileBytes: number): void {
    const { size, received } = download;
    // A request that was given up on may still report
    if (!download.pending || size === undefined || fileBytes <= received) {
      return;
    }
    download.received = fileBytes;
    if (fileBytes > size) {
      // Said once, when the file outgrows its size: the bar stands still at
      // full from here on, which is otherwise hard to explain
      if (received <= size) {
        logDebug(
          "Year file is larger than metadata.year_file_bytes says:",
          size,
        );
      }
      // Counted up to its size already, so nothing on screen changes
      if (received >= size) return;
    }
    // Counted, not shown, while no caller waits for it (see wait)
    if (download.held) this.report();
  }

  /**
   * A year file has arrived or failed. One that arrived counts in full,
   * whatever was counted on the way: a browser that cannot count a body
   * still advances file by file. One that failed is no part of what is
   * being loaded any more, so the rest goes on as a new operation.
   */
  private endDownload(
    year: string,
    download: Download,
    arrived: boolean,
  ): void {
    download.pending = false;
    this.yearDownloads.delete(year);
    // Given up on by every caller: it left the indicator then
    if (!download.held) return;
    download.held = false;
    const { size, received } = download;
    if (!arrived) {
      this.restartOperation();
    } else if (size !== undefined) {
      // The data directory has no cache busting, so a cache can serve an
      // old metadata.json next to a new year file; the bar then jumps
      if (received > 0 && received < size) {
        logDebug("Year file is smaller than metadata.year_file_bytes says:", {
          size,
          received,
        });
      }
      download.received = size;
    }
    this.endLoading();
  }

  private endLoading(): void {
    this.loadingDepth = Math.max(this.loadingDepth - 1, 0);
    if (this.loadingDepth === 0) this.downloads.clear();
    this.report();
  }

  /**
   * Count an index file as a load while it is on its way. The indicator
   * came up with the first year file, which is asked for once the index
   * of years is in: on a slow line the page was an empty map for a second
   * and more before it, with a legend and a filter that said nothing of
   * a load.
   */
  private async indexing<T>(request: Promise<T>): Promise<T> {
    this.loadingDepth++;
    this.report();
    try {
      return await request;
    } finally {
      this.endLoading();
    }
  }

  /**
   * Load data for a year or all years ('all')
   * @param year - Year string or 'all'
   * @returns Data object or null on error
   */
  async loadData(
    year: string = "all",
    signal?: AbortSignal,
  ): Promise<KMLDataset | null> {
    // Security: Validate input to prevent path traversal and arbitrary file loading
    if (!isValidYear(year)) {
      logError(`Invalid year parameter: ${year}`);
      return null;
    }

    if (year === "all") {
      return this.loadAndCombineAllYears(signal);
    }

    const data = await this.getYear(year, signal);
    // A caller that gave up on the year has moved on: its failure is news
    // to nobody
    if (!data && !this.destroyed && !signal?.aborted) {
      this.onLoadError([year], this.staleData);
    }
    return data;
  }

  /**
   * The dataset of a year (or "all") this session holds already, without
   * loading it
   */
  cachedData(year: string): KMLDataset | undefined {
    return this.cache.get(year);
  }

  /**
   * End the year worker. Loads that are still under way end without a
   * dataset and without a report: the app they were for is gone.
   */
  destroy(): void {
    this.destroyed = true;
    this.decoder?.destroy();
    this.decoder = null;
  }

  /**
   * The year decoder, which starts the year worker. One for all years, and
   * one import for all callers. A failed import is not kept, here or (see
   * importYearTools) by the browser, so the next year asks the server again.
   * The data manager has the worker write the heat sources through it as
   * well (see services/heatSource.ts): there is a heat only once a year
   * has been loaded, and with it the decoder.
   */
  getDecoder(): Promise<YearDecoder> {
    if (this.decoder) return Promise.resolve(this.decoder);
    this.decoderRequest ??= this.importYearTools()
      .then(
        ({ createYearDecoder }) => {
          // Not started for an app that ended while the import was under way
          if (this.destroyed) throw new Error("the loader was destroyed");
          return (this.decoder = createYearDecoder());
        },
        (error: unknown) => {
          throw new Error("Could not load " + YEAR_WORKER_BUNDLE, {
            cause: error,
          });
        },
      )
      .finally(() => {
        this.decoderRequest = null;
      });
    return this.decoderRequest;
  }

  /**
   * Cached and de-duplicated single-year load
   */
  private getYear(
    year: string,
    signal?: AbortSignal,
  ): Promise<KMLDataset | null> {
    const promise = this.shared(year, () => this.loadYear(year));
    const download = this.yearDownloads.get(year);
    if (download) this.wait(year, download, signal);
    return promise;
  }

  /** The cached dataset of `key`, or else the one request for it in flight */
  private shared(
    key: string,
    load: () => Promise<KMLDataset | null>,
  ): Promise<KMLDataset | null> {
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached);

    let promise = this.inflight.get(key);
    if (!promise) {
      promise = load().finally(() => this.inflight.delete(key));
      this.inflight.set(key, promise);
    }
    return promise;
  }

  private async loadYear(year: string): Promise<KMLDataset | null> {
    const download = this.beginDownload(year);
    let arrived = false;
    try {
      logDebug("Loading data (" + year + ")...");
      // Asked for now, so that the worker is up once the file has arrived.
      // The rejection is met where it is awaited, below.
      const decoder = this.getDecoder();
      decoder.catch(() => {});
      // The template preloads the latest year, so this request is usually
      // answered by one that is already under way, which is why the file is
      // fetched here and not by the worker: a preload serves the page that
      // made it. Bytes are counted only for a file whose size is known:
      // without it no bar is drawn.
      const bytes = await this.fetchBytes(
        this.dataDir + "/" + year + "/data.json",
        download.size === undefined
          ? undefined
          : {
              onProgress: (loadedBytes) =>
                this.advanceDownload(download, loadedBytes),
            },
      );
      const data = await (await decoder).decode(bytes);

      this.cache.set(year, data);
      arrived = true;
      logDebug(
        "✓ Loaded data (" + year + "):",
        data.original_points + " points",
      );
      return data;
    } catch (error) {
      logError("Error loading data for year " + year + ":", error);
      if ((error as Error | null)?.name === STALE_DATA_ERROR) {
        this.staleData = true;
      }
      return null;
    } finally {
      this.endDownload(year, download, arrived);
    }
  }

  /**
   * Load and combine data from all available years.
   * Years that fail to load are reported through onLoadError; the remaining
   * years are still combined. Returns null only when nothing could be loaded.
   *
   * Its callers share one load, which is given up on as a year is (see
   * wait) once each of them has aborted its signal: the indicator lets go
   * of it, its failures are news to nobody, and the year files go on
   * downloading into the cache. A caller that comes later starts a load of
   * its own, which picks the years up where they are.
   * @returns Combined data object or null on error
   */
  loadAndCombineAllYears(signal?: AbortSignal): Promise<KMLDataset | null> {
    const cached = this.cache.get("all");
    if (cached) return Promise.resolve(cached);
    // Gave up already: it would wait on the load for good, as its abort
    // event has fired before it could listen
    if (signal?.aborted) return Promise.resolve(null);
    let run = this.allRun;
    if (!run) {
      const controller = new AbortController();
      const promise = this.loadAllYears(controller.signal).finally(() => {
        if (this.allRun === started) this.allRun = null;
      });
      const started: AllYearsRun = { promise, controller, waiters: 0 };
      run = this.allRun = started;
    }
    const joined = run;
    joined.waiters += signal ? 1 : Infinity;
    signal?.addEventListener(
      "abort",
      () => {
        if (--joined.waiters > 0) return;
        if (this.allRun === joined) this.allRun = null;
        joined.controller.abort();
      },
      { once: true },
    );
    return joined.promise;
  }

  private async loadAllYears(signal: AbortSignal): Promise<KMLDataset | null> {
    this.loadingDepth++;
    this.loadingAll = true;
    let held = true;
    const release = (): void => {
      if (!held) return;
      held = false;
      this.loadingAll = false;
      this.endLoading();
    };
    signal.addEventListener("abort", release, { once: true });
    // The years join a moment later, each with a report of its own. The
    // indicator draws once per frame, so it shows the last of them.
    this.report();
    try {
      const metadata = await this.loadMetadata();
      if (signal.aborted) return null;
      if (!metadata || !metadata.available_years) {
        logError("No metadata or available years found");
        return null;
      }

      const years = metadata.available_years.map((y) => String(y));
      logDebug("Loading all years:", years);

      // Load all year files in parallel (deduplicated per year)
      const yearDatasets = await Promise.all(
        years.map((year) => this.getYear(year, signal)),
      );
      if (signal.aborted) return null;

      const failedYears = years.filter((_, i) => !yearDatasets[i]);
      if (failedYears.length > 0 && !this.destroyed) {
        this.onLoadError(failedYears, this.staleData);
      }
      if (years.length > 0 && failedYears.length === years.length) {
        return null;
      }

      const combined = (await this.getDecoder()).combine(yearDatasets);
      // Caching a partial combination would make the gap permanent for the
      // rest of the session; retry the missing years on the next call
      if (failedYears.length === 0) {
        this.cache.set("all", combined);
      } else {
        combined.incomplete = true;
      }
      logDebug("Combined all years:", combined.original_points + " points");
      return combined;
    } catch (error) {
      logError("Error loading and combining all years:", error);
      return null;
    } finally {
      release();
    }
  }

  /**
   * Load airports data, published in state/siteData.ts, which is where the
   * code that needs it without a loader at hand reads it from
   * @returns Array of airport objects, null when it could not be loaded
   *   (asked for again on the next call)
   */
  async loadAirports(): Promise<Airport[] | null> {
    try {
      if (!siteData.airports) {
        this.airportsRequest ??= this.fetchJson(
          this.dataDir + "/airports.json",
        ).then((json) => checked(json, isAirports, "airports.json"));
        siteData.airports = (
          await this.indexing(this.airportsRequest)
        ).airports;
      }
      return siteData.airports;
    } catch (error) {
      logError("Error loading airports:", error);
      return null;
    } finally {
      this.airportsRequest = null;
    }
  }

  /**
   * Load metadata, published in state/siteData.ts like the airports
   * @returns Metadata object or null on error
   */
  async loadMetadata(): Promise<Metadata | null> {
    try {
      if (!siteData.metadata) {
        this.metadataRequest ??= this.fetchJson(
          this.dataDir + "/metadata.json",
        ).then((json) => checked(json, isMetadata, "metadata.json"));
        const metadata = await this.indexing(this.metadataRequest);
        // Callers that shared the request are told once
        if (!siteData.metadata) {
          siteData.metadata = metadata;
          this.onMetadata?.(metadata);
        }
      }
      return siteData.metadata;
    } catch (error) {
      logError("Error loading metadata:", error);
      return null;
    } finally {
      this.metadataRequest = null;
    }
  }
}
