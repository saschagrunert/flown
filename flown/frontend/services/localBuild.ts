/**
 * The page's side of the build worker (services/localWorker.ts).
 *
 * One worker serves the builds of the page; it is started with the first,
 * and ended with the panel (ui/localFlights.ts) or once no build came for
 * a while (WORKER_IDLE_MS), the next starting another. A build reports its
 * progress as the steps the Python build takes, and answers with the data
 * files of a site, which the caller keeps (services/localStore.ts).
 */

import type {
  BuildOptions,
  BuildOutcome,
  BuildRequest,
  InputFile,
  WorkerMessage,
} from "./localWorker";
import { versioned } from "./lazyImport";
import { CACHE_GONE_MESSAGE } from "./localStore";

export type { BuildOptions, BuildOutcome, InputFile };

/** The worker's bundle, next to the page */
const LOCAL_WORKER_BUNDLE = "localWorker.bundle.js";

/**
 * Said when the worker cannot be started or dies on the way: an old
 * browser, or one that refuses module workers or WebAssembly
 */
export const WORKER_FAILED_MESSAGE =
  "The build could not run in this browser; try a current Chrome, Edge, Firefox or Safari";
/**
 * Said when the worker's bundle did not load, offline most often: the
 * browser's error then has no message of a script that ran
 */
export const WORKER_LOAD_FAILED_MESSAGE =
  "Could not load the build. Check the connection and try again.";

export interface LocalWorkerLike {
  postMessage(message: BuildRequest, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  // A plain Event in fact for a load that failed, which has no message
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

/**
 * What a worker's error event says went wrong: one of its script carries
 * the message of what was thrown, one of its load (offline, a bundle the
 * server has not) none
 */
function workerFailure(event: ErrorEvent | Event): string {
  const ran = "message" in event && !!event.message;
  return navigator.onLine === false || !ran
    ? WORKER_LOAD_FAILED_MESSAGE
    : WORKER_FAILED_MESSAGE;
}

/**
 * How long the worker is kept once no build is on its way: its runtime, and
 * the cache it read in, take hundreds of megabytes of the page's memory,
 * which a page that goes on (a build with the panel closed or the map held,
 * or one that failed) has no use for. A build soon after (a file removed,
 * Build again) finds it still there.
 */
export const WORKER_IDLE_MS = 60_000;

const startWorker = (): LocalWorkerLike =>
  new Worker(new URL(versioned(`./${LOCAL_WORKER_BUNDLE}`), import.meta.url), {
    type: "module",
  });

interface Pending {
  progress: (message: string) => void;
  resolve: (outcome: BuildOutcome) => void;
  reject: (error: Error) => void;
}

export class LocalBuilder {
  private worker: LocalWorkerLike | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  /** The wait to let an idle worker go (WORKER_IDLE_MS) */
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly start: () => LocalWorkerLike = startWorker,
    private readonly idleMs = WORKER_IDLE_MS,
  ) {}

  /** Whether a build is on its way */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Build the data files of `files`; `progress` is told every step of
   * the build. Rejects with the build's message for files that make no
   * site, and with WORKER_FAILED_MESSAGE for a worker that does not answer.
   */
  build(
    files: InputFile[],
    terrain: boolean,
    progress: (message: string) => void,
    options: BuildOptions = {},
  ): Promise<BuildOutcome> {
    const id = this.nextId++;
    clearTimeout(this.idle);
    return new Promise<BuildOutcome>((resolve, reject) => {
      let worker: LocalWorkerLike;
      try {
        worker = this.ready();
      } catch (error) {
        reject(
          error instanceof Error ? error : new Error(WORKER_FAILED_MESSAGE),
        );
        return;
      }
      this.pending.set(id, { progress, resolve, reject });
      // The files as Blobs, which hand over no bytes: the worker reads them
      worker.postMessage({ id, build: { files, terrain, ...options } }, []);
    });
  }

  private ready(): LocalWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.start();
    worker.onmessage = (event) => this.answer(event.data);
    worker.onerror = (event) => this.fail(new Error(workerFailure(event)));
    this.worker = worker;
    return worker;
  }

  private answer(response: WorkerMessage): void {
    // Another tab's Remove all deleted the cache, which the worker let go
    // of and does not build with again: the next build starts another
    if ("cacheGone" in response) {
      this.fail(new Error(CACHE_GONE_MESSAGE));
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if ("progress" in response) {
      pending.progress(response.progress);
      return;
    }
    this.pending.delete(response.id);
    if (!this.pending.size) {
      this.idle = setTimeout(() => this.fail(), this.idleMs);
    }
    if ("done" in response) {
      pending.resolve(response.done);
      return;
    }
    const error = new Error(response.error);
    pending.reject(error);
    // The runtime in it failed for good: the next build starts another
    if (response.lost) this.fail(error);
  }

  /**
   * The worker is let go, lost or idle: every build waiting on it fails,
   * and the next starts another
   */
  private fail(error = new Error(WORKER_FAILED_MESSAGE)): void {
    clearTimeout(this.idle);
    const waiting = [...this.pending.values()];
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    for (const pending of waiting) pending.reject(error);
  }

  destroy(): void {
    this.fail();
  }
}
