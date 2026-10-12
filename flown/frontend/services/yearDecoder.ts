/**
 * The page's side of the year worker (services/yearWorker.ts).
 *
 * Parsing and decoding a year file of a few megabytes took the main thread
 * some tens of milliseconds per year, in one piece. The worker does both and
 * answers with typed arrays, from which the dataset is built a slice at a
 * time (services/yearDataset.ts). One worker serves every year; it is
 * started with the first year file and ended with the app.
 *
 * This module is part of yearWorker.bundle.js like everything else that
 * works on year data, so that a first visit does not download it with the
 * app: the page imports that file (services/dataLoader.ts), and the file
 * starts itself a second time as the worker. That also puts the decoder at
 * hand here: a worker that does not start (an old browser, a blocked
 * script), that reports an error or that does not answer is given up on for
 * the rest of the visit, and the years are decoded on the main thread.
 *
 * The same worker writes the content of the heat sources
 * (services/heatSource.ts) and of the lines along the flights
 * (services/flightLines.ts), with the same fallback: a source the worker
 * cannot be asked for is written on the main thread, which still spares it
 * the objects MapLibre would otherwise have been given.
 */

import { logError } from "../utils/logger";
import { DATA_FORMAT_VERSION, decodeYearBytes } from "./yearDecode";
import { buildDatasetInSlices, combineYearData } from "./yearDataset";
import { drawHeat, type DrawnHeat } from "./heatSource";
import {
  columnBuffers,
  flatRuns,
  flightColumns,
  heatLinesSource,
  runsSource,
  type LineRun,
} from "./flightLines";
import { heatColumns } from "../calculations/heatExposure";
import { flatCurves } from "../calculations/curves";
import type { KMLDataset, PathSegment } from "../types";
import type { Coordinate } from "../utils/geometry";
import type { LinesRequest, YearRequest, YearResponse } from "./yearWorker";

/**
 * How long the worker may go without answering while requests wait. It
 * answers one at a time, and each takes it some milliseconds, so this only
 * ever ends a wait for a worker that hangs.
 */
const DECODE_TIMEOUT_MS = 30_000;

/** As much of a Worker as the decoder uses, so that tests can stand in */
export type YearWorkerLike = Pick<
  Worker,
  "postMessage" | "terminate" | "addEventListener"
>;

export interface YearDecoderOptions {
  /** Starts the worker; throws where there are no module workers */
  createWorker?: () => YearWorkerLike;
  timeoutMs?: number;
}

export interface YearDecoder {
  /**
   * Turn the body of a year file into its dataset
   * @param bytes - Body of <year>/data.json
   * @returns Rejects for a file that cannot be decoded
   */
  decode(bytes: ArrayBuffer): Promise<KMLDataset>;
  /**
   * How the heatmap draws a heat, and the content of its source (see
   * services/heatSource.ts)
   * @param points - The points of the heat
   * @param weights - The heat of each, see heatmapPoints in
   *   ui/dataManager.ts
   */
  drawHeat(
    points: readonly Coordinate[],
    weights: readonly number[],
  ): Promise<DrawnHeat>;
  /**
   * The content of the heat line source (see heatLinesSource in
   * services/flightLines.ts)
   * @param segments - The flights of the heat
   * @param keep - The paths it keeps, null for all of them
   * @param exposure - What the heat is scaled by, see heatExposure
   */
  heatLines(
    segments: readonly PathSegment[],
    keep: ReadonlySet<number> | null,
    exposure: number,
  ): Promise<Blob>;
  /**
   * The content of a colour layer's source: its runs as lines (see
   * runsSource in services/flightLines.ts)
   * @param segments - The segments the runs index into
   * @param runs - The runs
   * @param g - Their generation, see RunTable.g in ui/pathRuns.ts
   */
  runsSource(
    segments: readonly PathSegment[],
    runs: readonly LineRun[],
    g: number,
  ): Promise<Blob>;
  /** combineYearData of services/yearDataset.ts */
  combine: typeof combineYearData;
  /** End the worker, and the wait of whoever still waits for it */
  destroy(): void;
}

/**
 * The bundle is one file, so the URL of this module is the URL of the
 * worker, under whichever name the page imported it
 */
const startWorker = (): YearWorkerLike =>
  new Worker(import.meta.url, { type: "module" });

/** Omit of each member of a union, which Omit of the union is not */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

/**
 * Ends the wait for one answer of the worker: with the answer, with null
 * when the main thread has to decode instead, or with why there is none
 */
type Settle = (answer: YearResponse | Error | null) => void;

/**
 * Start the year worker
 * @param options - Stand-ins for tests
 * @returns What decodes the year files of one app
 */
export function createYearDecoder(
  options: YearDecoderOptions = {},
): YearDecoder {
  const { createWorker = startWorker, timeoutMs = DECODE_TIMEOUT_MS } = options;
  let worker: YearWorkerLike | null = null;
  /** Set once the worker has been given up on, or the app has ended */
  let workerDone = false;
  let destroyed = false;
  let nextId = 0;
  const pending = new Map<number, Settle>();
  /**
   * Gives up on a worker that has not answered for `timeoutMs` while some
   * request waits. Started by a request, again by every answer: a queue of
   * them behind a long one is the worker at work, not one that hangs.
   */
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const watch = (): void => {
    clearTimeout(watchdog);
    watchdog =
      pending.size > 0 && !workerDone
        ? setTimeout(() => giveUpOnWorker("no answer"), timeoutMs)
        : undefined;
  };

  /** Settle every request without an answer; none is waited for after */
  const settleAll = (answer: Error | null): void => {
    for (const settle of [...pending.values()]) settle(answer);
  };

  /** Stop using the worker; what it still owed is decoded here */
  const giveUpOnWorker = (reason: unknown): void => {
    if (workerDone) return;
    workerDone = true;
    logError("Year worker failed, decoding on the main thread:", reason);
    worker?.terminate();
    worker = null;
    settleAll(null);
  };

  /** The worker's answer; null when the main thread has to do the work */
  const askWorker = (
    target: YearWorkerLike,
    body: DistributiveOmit<YearRequest, "id">,
    transfer: Transferable[],
  ): Promise<YearResponse | null> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const settle: Settle = (answer) => {
        pending.delete(id);
        if (pending.size === 0) watch();
        if (answer instanceof Error) reject(answer);
        else resolve(answer);
      };
      pending.set(id, settle);
      if (watchdog === undefined) watch();
      // The bytes of a year file are copied, not transferred: the copy is a
      // fraction of a millisecond, and the bytes are still here if the
      // worker fails over them. The columns of flights are handed over:
      // what the worker cannot draw is drawn from the segments.
      const request: YearRequest = { id, ...body };
      try {
        target.postMessage(request, transfer);
      } catch (error) {
        giveUpOnWorker(error);
      }
    });

  try {
    worker = createWorker();
    worker.addEventListener("message", (event) => {
      const answer = (event as MessageEvent<YearResponse>).data;
      pending.get(answer.id)?.(answer);
      watch();
    });
    // A script that did not load, or an error nobody caught in it
    worker.addEventListener("error", (event) => giveUpOnWorker(event.message));
    worker.addEventListener("messageerror", giveUpOnWorker);
  } catch (error) {
    giveUpOnWorker(error);
  }

  /**
   * The worker's answer to `body`, taken by `take`, or else `work` done on the
   * main thread: where there is no worker, or it failed over the request
   * (logged as what it could not do, `what`). If the fault is in the data, the
   * work fails the same way, with the error and not its text. An error
   * the work would only meet again (`final` of the worker's answer) is not
   * worked for twice: it is thrown as the worker's, by its name and message.
   * `transfer` is handed over with the body.
   */
  const answerOf = async <T>(
    what: string,
    body: DistributiveOmit<YearRequest, "id">,
    take: (response: YearResponse) => T | undefined,
    work: () => T,
    final: (answer: { name: string; format: number }) => boolean = () => false,
    transfer: Transferable[] = [],
  ): Promise<T> => {
    if (destroyed) throw new Error("year decoder destroyed");
    const response = worker ? await askWorker(worker, body, transfer) : null;
    const taken = response ? take(response) : undefined;
    if (taken !== undefined) return taken;
    if (response && "error" in response) {
      if (final(response)) {
        throw Object.assign(new Error(response.error), {
          name: response.name,
        });
      }
      logError(`Year worker could not ${what}:`, response.error);
    }
    return work();
  };

  /** A number for each segment array, the one the worker holds as `held` */
  const arrays = new WeakMap<readonly PathSegment[], number>();
  let arrayCount = 0;
  let held = -1;

  /**
   * Lines along the flights of `segments` (see services/flightLines.ts):
   * the worker is handed them with the first lines asked of them, and keeps
   * them for the next. Drawn here instead, `work` draws them along the
   * curves of the page, and the worker is handed them again next time.
   */
  const linesOf = (
    what: string,
    segments: readonly PathSegment[],
    ask: DistributiveOmit<LinesRequest, "flights">,
    work: () => Blob,
  ): Promise<Blob> => {
    let key = arrays.get(segments);
    if (key === undefined) arrays.set(segments, (key = arrayCount++));
    const flights =
      worker && key !== held ? flightColumns(segments) : undefined;
    held = key;
    return answerOf(
      what,
      flights ? { flights, ...ask } : ask,
      (response) => ("source" in response ? response.source : undefined),
      () => {
        held = -1;
        return work();
      },
      undefined,
      flights && columnBuffers(flights),
    );
  };

  return {
    async decode(bytes) {
      const decoded = await answerOf(
        "decode",
        { bytes },
        (response) => ("decoded" in response ? response.decoded : undefined),
        () => decodeYearBytes(bytes),
        // A file of another release is one on the page too (decodeYear),
        // and a page open over a deploy would parse megabytes to find it.
        // Only when the worker reads the page's format, though:
        // yearWorker.bundle.js has no content hash and Pages caches it for
        // 600 s, so a deploy between the page's import of the file and the
        // worker's own fetch of it can start a worker of another release,
        // which finds the page's year file stale. The page then decodes it.
        ({ name, format }) =>
          name === "StaleDataError" && format === DATA_FORMAT_VERSION,
      );
      for (const warning of decoded.warnings) console.warn(warning);
      return buildDatasetInSlices(decoded);
    },
    drawHeat(points, weights) {
      // Packed here, on the page, into what is copied to the worker
      const heat = heatColumns(points, weights);
      return answerOf(
        "draw the heat",
        { heat },
        (response) => ("drawn" in response ? response.drawn : undefined),
        () => drawHeat(heat),
      );
    },
    heatLines(segments, keep, exposure) {
      const heatLines = { keep: keep && Float64Array.from(keep), exposure };
      return linesOf("draw the heat lines", segments, { heatLines }, () =>
        heatLinesSource({ segments, curves: flatCurves(segments) }, heatLines),
      );
    },
    runsSource(segments, runs, g) {
      const flat = flatRuns(runs, g);
      return linesOf("draw the lines", segments, { runs: flat }, () =>
        runsSource({ segments, curves: flatCurves(segments) }, flat),
      );
    },
    combine: combineYearData,
    destroy() {
      destroyed = workerDone = true;
      worker?.terminate();
      worker = null;
      settleAll(new Error("year decoder destroyed"));
    },
  };
}
