/**
 * The page's side of the build worker (services/localWorker.ts).
 *
 * One worker serves every build of the page; it is started with the first
 * and ended with the panel (ui/localFlights.ts). A build reports its
 * progress as the lines the Python build logs, and answers with the data
 * files of a site, which the caller keeps (services/localStore.ts).
 */

import type {
  BuildOutcome,
  BuildRequest,
  BuildResponse,
  InputFile,
} from "./localWorker";
import { versioned } from "./lazyImport";

export type { BuildOutcome, InputFile };

/** The worker's bundle, next to the page */
const LOCAL_WORKER_BUNDLE = "localWorker.bundle.js";

/** Said when the worker cannot be started or dies on the way */
export const WORKER_FAILED_MESSAGE = "The build could not run in this browser";

export interface LocalWorkerLike {
  postMessage(message: BuildRequest, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<BuildResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  terminate(): void;
}

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

  constructor(private readonly start: () => LocalWorkerLike = startWorker) {}

  /** Whether a build is on its way */
  get busy(): boolean {
    return this.pending.size > 0;
  }

  /**
   * Build the data files of `files`; `progress` is told every line of the
   * build. Rejects with the build's message for files that make no site,
   * and with WORKER_FAILED_MESSAGE for a worker that does not answer.
   */
  build(
    files: InputFile[],
    terrain: boolean,
    progress: (message: string) => void,
  ): Promise<BuildOutcome> {
    const id = this.nextId++;
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
      // The bytes go over, not copies: the caller keeps its own in the store
      worker.postMessage(
        { id, build: { files, terrain } },
        files.map((file) => file.bytes),
      );
    });
  }

  private ready(): LocalWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.start();
    worker.onmessage = (event) => this.answer(event.data);
    worker.onerror = () => this.fail(new Error(WORKER_FAILED_MESSAGE));
    this.worker = worker;
    return worker;
  }

  private answer(response: BuildResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if ("progress" in response) {
      pending.progress(response.progress);
      return;
    }
    this.pending.delete(response.id);
    if ("done" in response) pending.resolve(response.done);
    else pending.reject(new Error(response.error));
  }

  /** The worker is lost: every build waiting on it fails, and it is let go */
  private fail(error: Error): void {
    const waiting = [...this.pending.values()];
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
    for (const pending of waiting) pending.reject(error);
  }

  destroy(): void {
    this.fail(new Error(WORKER_FAILED_MESSAGE));
  }
}
