/**
 * The page's side of the build worker (services/localBuild.ts): a build
 * hands the files over as transferables, hears the progress, and settles
 * on done or error under its id; a worker that dies fails every build
 * waiting on it and is replaced by the next; a worker that cannot start
 * fails the build at once.
 */
import { describe, it, expect, vi } from "vitest";
import {
  LocalBuilder,
  WORKER_FAILED_MESSAGE,
  WORKER_LOAD_FAILED_MESSAGE,
  type BuildOutcome,
  type LocalWorkerLike,
} from "../../../../flown/frontend/services/localBuild";
import { CACHE_GONE_MESSAGE } from "../../../../flown/frontend/services/localStore";
import type {
  BuildRequest,
  WorkerMessage,
} from "../../../../flown/frontend/services/localWorker";

class FakeWorker implements LocalWorkerLike {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: [BuildRequest, Transferable[]][] = [];
  terminated = 0;

  postMessage(message: BuildRequest, transfer: Transferable[]): void {
    this.posted.push([message, transfer]);
  }

  terminate(): void {
    this.terminated++;
  }

  /** What the worker answers */
  answer(response: WorkerMessage): void {
    this.onmessage!({ data: response } as MessageEvent<WorkerMessage>);
  }

  /** An error its script threw, which the event carries the message of */
  die(): void {
    this.onerror!(new ErrorEvent("error", { message: "Uncaught boom" }));
  }

  /** Its bundle did not load: the event is a plain one */
  failToLoad(): void {
    this.onerror!(new Event("error") as ErrorEvent);
  }
}

const OUTCOME: BuildOutcome = {
  years: [2025],
  flights: 1,
  airports: 2,
  bounds: [
    [50, 11],
    [52, 13],
  ],
  files: [{ path: "metadata.json", bytes: new ArrayBuffer(2) }],
};

function setup(): { builder: LocalBuilder; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const builder = new LocalBuilder(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  return { builder, workers };
}

describe("LocalBuilder", () => {
  it("posts the files as transferables and resolves with the outcome", async () => {
    const { builder, workers } = setup();
    const bytes = new ArrayBuffer(4);
    const progress = vi.fn();

    const build = builder.build([{ name: "a.kml", bytes }], true, progress);
    expect(builder.busy).toBe(true);
    const [request, transfer] = workers[0]!.posted[0]!;
    expect(request).toEqual({
      id: 1,
      build: { files: [{ name: "a.kml", bytes }], terrain: true },
    });
    expect(transfer).toEqual([bytes]);

    workers[0]!.answer({ id: 1, progress: "Parsing 1 KML file(s)..." });
    workers[0]!.answer({ id: 1, done: OUTCOME });

    await expect(build).resolves.toBe(OUTCOME);
    expect(progress).toHaveBeenCalledWith("Parsing 1 KML file(s)...");
    expect(builder.busy).toBe(false);
  });

  it("rejects with the build's message on an error", async () => {
    const { builder, workers } = setup();

    const build = builder.build([], false, vi.fn());
    workers[0]!.answer({ id: 1, error: "No valid KML files to process!" });

    await expect(build).rejects.toThrow("No valid KML files to process!");
  });

  it("keeps the worker after a build's error, and lets it go when its runtime is lost", async () => {
    const { builder, workers } = setup();

    const one = builder.build([], false, vi.fn());
    workers[0]!.answer({ id: 1, error: "not a KML file" });
    await expect(one).rejects.toThrow("not a KML file");
    expect(workers[0]!.terminated).toBe(0);

    // Pyodide answers every call after a fatal error with another
    const two = builder.build([], false, vi.fn());
    workers[0]!.answer({ id: 2, error: "The runtime failed", lost: true });
    await expect(two).rejects.toThrow("The runtime failed");
    expect(workers[0]!.terminated).toBe(1);

    const three = builder.build([], false, vi.fn());
    expect(workers).toHaveLength(2);
    workers[1]!.answer({ id: 3, done: OUTCOME });
    await expect(three).resolves.toBe(OUTCOME);
  });

  it("gives every build its own id on one worker", async () => {
    const { builder, workers } = setup();
    const first = vi.fn();
    const second = vi.fn();

    const one = builder.build([], false, first);
    const two = builder.build([], false, second);
    expect(workers).toHaveLength(1);
    workers[0]!.answer({ id: 2, progress: "two" });
    workers[0]!.answer({ id: 2, done: OUTCOME });
    workers[0]!.answer({ id: 1, done: { ...OUTCOME, flights: 7 } });

    await expect(two).resolves.toBe(OUTCOME);
    await expect(one).resolves.toMatchObject({ flights: 7 });
    expect(second).toHaveBeenCalledWith("two");
    expect(first).not.toHaveBeenCalled();
  });

  it("ignores an answer under an id it is not waiting for", () => {
    const { builder, workers } = setup();
    void builder.build([], false, vi.fn()).catch(() => undefined);

    expect(() => workers[0]!.answer({ id: 9, done: OUTCOME })).not.toThrow();
    expect(builder.busy).toBe(true);
    builder.destroy();
  });

  it("fails every build waiting on a worker that dies, and starts a new one next", async () => {
    const { builder, workers } = setup();
    const one = builder.build([], false, vi.fn());
    const two = builder.build([], false, vi.fn());

    workers[0]!.die();

    await expect(one).rejects.toThrow(WORKER_FAILED_MESSAGE);
    await expect(two).rejects.toThrow(WORKER_FAILED_MESSAGE);
    expect(workers[0]!.terminated).toBe(1);
    expect(builder.busy).toBe(false);

    const three = builder.build([], false, vi.fn());
    expect(workers).toHaveLength(2);
    workers[1]!.answer({ id: 3, done: OUTCOME });
    await expect(three).resolves.toBe(OUTCOME);
  });

  it("says to check the connection when the worker's bundle did not load", async () => {
    const { builder, workers } = setup();
    const one = builder.build([], false, vi.fn());

    workers[0]!.failToLoad();

    await expect(one).rejects.toThrow(WORKER_LOAD_FAILED_MESSAGE);
  });

  it("says to check the connection when offline, whatever the error", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    try {
      const { builder, workers } = setup();
      const one = builder.build([], false, vi.fn());

      workers[0]!.die();

      await expect(one).rejects.toThrow(WORKER_LOAD_FAILED_MESSAGE);
    } finally {
      online.mockRestore();
    }
  });

  it("lets the worker go when another tab deleted the cache", async () => {
    const { builder, workers } = setup();
    const one = builder.build([], false, vi.fn());

    workers[0]!.answer({ cacheGone: true });

    await expect(one).rejects.toThrow(CACHE_GONE_MESSAGE);
    expect(workers[0]!.terminated).toBe(1);
    expect(builder.busy).toBe(false);
    const two = builder.build([], false, vi.fn());
    expect(workers).toHaveLength(2);
    workers[1]!.answer({ id: 2, done: OUTCOME });
    await expect(two).resolves.toBe(OUTCOME);
  });

  it("rejects pending builds when destroyed", async () => {
    const { builder, workers } = setup();
    const build = builder.build([], false, vi.fn());

    builder.destroy();

    await expect(build).rejects.toThrow(WORKER_FAILED_MESSAGE);
    expect(workers[0]!.terminated).toBe(1);
    // Destroyed twice is no error
    expect(() => builder.destroy()).not.toThrow();
  });

  it("rejects at once when the worker cannot be started", async () => {
    const failing = new LocalBuilder(() => {
      throw new Error("Worker is not defined");
    });

    await expect(failing.build([], false, vi.fn())).rejects.toThrow(
      "Worker is not defined",
    );
    expect(failing.busy).toBe(false);

    const odd = new LocalBuilder(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- what a browser without workers might throw
      throw "no worker";
    });
    await expect(odd.build([], false, vi.fn())).rejects.toThrow(
      WORKER_FAILED_MESSAGE,
    );
  });
});
