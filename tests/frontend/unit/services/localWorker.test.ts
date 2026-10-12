/**
 * The worker that builds the flights a visitor drops
 * (services/localWorker.ts), with a Pyodide in memory: the runtime is
 * loaded once and told of its sources and cache before the package is
 * imported, a build writes the inputs, runs the Python with the terrain
 * switch and the report, and hands back what came out under /site, a
 * Python failure is answered with its message and the cache is synced
 * either way, and the worker's scope answers every request under its id.
 */
import { describe, it, expect, vi } from "vitest";
import {
  LOADING_PACKAGE_MESSAGE,
  LOADING_PARSER_MESSAGE,
  LOADING_RUNTIME_MESSAGE,
  PYODIDE_URL,
  pythonErrorMessage,
  Runtime,
  serveBuilds,
  type BuildRequest,
  type BuildResponse,
  type LocalWorkerScope,
  type PyodideLike,
  type PyodideLoader,
  RUNTIME_FAILED_MESSAGE,
} from "../../../../flown/frontend/services/localWorker";

const OUTCOME = {
  years: [2025],
  flights: 1,
  airports: 2,
  center: [51, 12],
  bounds: [
    [50, 11],
    [52, 13],
  ],
};

/** A Pyodide whose file system is a map of paths, directories ending in / */
class FakePyodide implements PyodideLike {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  readonly python: string[] = [];
  readonly packages: string[] = [];
  readonly mounted: string[] = [];
  readonly synced: boolean[] = [];
  readonly unpacked: { buffer: ArrayBuffer; dir: string | undefined }[] = [];
  report: ((level: string, message: string) => void) | null = null;
  /** What runPythonAsync answers, or throws when an Error */
  answer: string | Error = JSON.stringify(OUTCOME);
  /** What a sync fails with, if anything */
  syncError: unknown = null;
  readonly globals = {
    set: (name: string, value: unknown): void => {
      if (name === "report") {
        this.report = value as (level: string, message: string) => void;
      }
    },
  };
  readonly FS = {
    filesystems: { IDBFS: "idbfs" },
    mkdirTree: (path: string): void => {
      const parts = path.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        this.dirs.add("/" + parts.slice(0, i).join("/"));
      }
    },
    mount: (type: unknown, _options: object, path: string): void => {
      this.mounted.push(`${String(type)}:${path}`);
    },
    syncfs: (populate: boolean, callback: (error: unknown) => void): void => {
      this.synced.push(populate);
      callback(this.syncError);
    },
    writeFile: (path: string, data: Uint8Array): void => {
      this.files.set(path, data);
    },
    readFile: (path: string): Uint8Array => this.files.get(path)!,
    readdir: (path: string): string[] => {
      const names = new Set<string>([".", ".."]);
      const prefix = path.endsWith("/") ? path : `${path}/`;
      for (const key of [...this.files.keys(), ...this.dirs]) {
        if (key.startsWith(prefix) && key !== path) {
          names.add(key.slice(prefix.length).split("/")[0]!);
        }
      }
      return [...names];
    },
    isDir: (mode: number): boolean => mode === 1,
    stat: (path: string): { mode: number } => ({
      mode: this.dirs.has(path) ? 1 : 0,
    }),
    analyzePath: (path: string): { exists: boolean } => ({
      exists: this.dirs.has(path) || this.files.has(path),
    }),
    unlink: (path: string): void => {
      this.files.delete(path);
    },
    rmdir: (path: string): void => {
      this.dirs.delete(path);
    },
  };

  loadPackage(name: string): Promise<unknown> {
    this.packages.push(name);
    return Promise.resolve();
  }

  unpackArchive(
    buffer: ArrayBuffer,
    _format: string,
    options?: { extractDir?: string },
  ): void {
    this.unpacked.push({ buffer, dir: options?.extractDir });
  }

  runPython(code: string): unknown {
    this.python.push(code);
    return undefined;
  }

  runPythonAsync(code: string): Promise<unknown> {
    this.python.push(code);
    if (this.answer instanceof Error) return Promise.reject(this.answer);
    // The build writes its data files as it answers
    this.FS.mkdirTree("/site/2025");
    this.files.set("/site/metadata.json", new Uint8Array([1, 2]));
    this.files.set("/site/2025/data.json", new Uint8Array([3]));
    return Promise.resolve(this.answer);
  }
}

function runtimeOf(
  pyodide: FakePyodide,
  cacheDir?: string,
): {
  runtime: Runtime;
  loader: ReturnType<typeof vi.fn>;
  sources: ReturnType<typeof vi.fn>;
} {
  const loadPyodide: PyodideLoader = vi.fn(() => Promise.resolve(pyodide));
  const loader = vi.fn(() => Promise.resolve(loadPyodide));
  const sources = vi.fn(() => Promise.resolve(new ArrayBuffer(8)));
  return {
    runtime: new Runtime(loader, sources, cacheDir),
    loader,
    sources,
  };
}

const bytes = (...values: number[]): ArrayBuffer =>
  new Uint8Array(values).buffer;

describe("pythonErrorMessage", () => {
  it("takes the message off the last line of a traceback", () => {
    const error = new Error(
      "Traceback (most recent call last):\n" +
        '  File "<exec>", line 3, in <module>\n' +
        "flown.exceptions.InvalidInputError: No valid KML files to process!\n",
    );
    expect(pythonErrorMessage(error)).toBe("No valid KML files to process!");
  });

  it("takes a plain error's message", () => {
    expect(pythonErrorMessage(new Error("Worker died"))).toBe("Worker died");
  });

  it("takes the last line where no error name is on it", () => {
    expect(pythonErrorMessage("one\ntwo")).toBe("two");
  });

  it("says the build failed where there is nothing to say", () => {
    expect(pythonErrorMessage("")).toBe("The build failed");
    expect(pythonErrorMessage(new Error("ValueError: "))).toBe("ValueError:");
  });
});

describe("Runtime", () => {
  it("loads once, telling of each step, and gets the package ready", async () => {
    const pyodide = new FakePyodide();
    const { runtime, loader, sources } = runtimeOf(pyodide);
    const report = vi.fn<(message: string) => void>();

    await runtime.ready(report);
    await runtime.ready(report);

    expect(report.mock.calls.map(([m]) => m)).toEqual([
      LOADING_RUNTIME_MESSAGE,
      LOADING_PARSER_MESSAGE,
      LOADING_PACKAGE_MESSAGE,
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(sources).toHaveBeenCalledTimes(1);
    expect(pyodide.packages).toEqual(["lxml"]);
    expect(pyodide.unpacked[0]!.dir).toBe("/lib/flown-src");
    // The cache under the page's name (localCacheDbName), at the root here
    expect(pyodide.mounted).toEqual(["idbfs:/flown-cache"]);
    expect(pyodide.synced).toEqual([true]);
    expect(pyodide.python[0]).toContain('sys.path.insert(0, "/lib/flown-src")');
    expect(pyodide.python[0]).toContain(
      'os.environ["FLOWN_CACHE_DIR"] = "/flown-cache"',
    );
    expect(pyodide.python[0]).toContain('os.environ["HOME"] = "/flown-cache"');
    expect(PYODIDE_URL).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/pyodide\/v\d/);
  });

  it("mounts the cache where it is told, for a page off the root", async () => {
    const pyodide = new FakePyodide();
    const { runtime } = runtimeOf(pyodide, "/flown-cache%3A%2Fa%2F");

    await runtime.ready(vi.fn());

    expect(pyodide.mounted).toEqual(["idbfs:/flown-cache%3A%2Fa%2F"]);
    expect(pyodide.python[0]).toContain(
      'os.environ["FLOWN_CACHE_DIR"] = "/flown-cache%3A%2Fa%2F"',
    );
  });

  it("tries again on the next build after a start that failed", async () => {
    const pyodide = new FakePyodide();
    const { runtime, loader } = runtimeOf(pyodide);
    loader.mockRejectedValueOnce(new Error("offline"));

    await expect(runtime.ready(vi.fn())).rejects.toThrow("offline");
    await expect(runtime.ready(vi.fn())).resolves.toBe(pyodide);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("says in plain words when the runtime cannot be loaded for a build", async () => {
    const pyodide = new FakePyodide();
    const { runtime, loader } = runtimeOf(pyodide);
    loader.mockRejectedValueOnce(new Error("Failed to fetch"));

    await expect(runtime.build([], true, vi.fn())).rejects.toThrow(
      RUNTIME_FAILED_MESSAGE,
    );
  });

  it("fails the start when the cache cannot be read", async () => {
    const pyodide = new FakePyodide();
    pyodide.syncError = new Error("no storage");
    const { runtime } = runtimeOf(pyodide);

    await expect(runtime.ready(vi.fn())).rejects.toThrow("no storage");

    pyodide.syncError = "odd";
    await expect(runtime.ready(vi.fn())).rejects.toThrow("syncfs failed");
  });

  it("builds: the inputs in, the Python run, the files out", async () => {
    const pyodide = new FakePyodide();
    const { runtime } = runtimeOf(pyodide);
    // What an earlier build left
    pyodide.FS.mkdirTree("/site/2024");
    pyodide.files.set("/site/2024/data.json", new Uint8Array([9]));
    pyodide.FS.mkdirTree("/input");
    pyodide.files.set("/input/old.kml", new Uint8Array([8]));
    const progress = vi.fn();

    const outcome = await runtime.build(
      [
        { name: "a.kml", bytes: bytes(1, 2, 3) },
        { name: "sub/b.kml", bytes: bytes(4) },
      ],
      true,
      progress,
    );

    expect(
      [...pyodide.files.keys()].filter((p) => p.startsWith("/input")),
    ).toEqual(["/input/a.kml", "/input/sub_b.kml"]);
    expect(pyodide.files.get("/input/a.kml")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(pyodide.files.has("/site/2024/data.json")).toBe(false);
    const run = pyodide.python.at(-1)!;
    expect(run).toContain(
      'browser.build("/input", "/site", report, terrain=True)',
    );
    expect(outcome).toMatchObject(OUTCOME);
    expect(outcome.files.map((f) => f.path).sort()).toEqual([
      "2025/data.json",
      "metadata.json",
    ]);
    const metadata = outcome.files.find((f) => f.path === "metadata.json")!;
    expect(new Uint8Array(metadata.bytes)).toEqual(new Uint8Array([1, 2]));
    // A copy, not the file system's own buffer
    expect(metadata.bytes).not.toBe(
      pyodide.files.get("/site/metadata.json")!.buffer,
    );
    // The cache went out after the build
    expect(pyodide.synced).toEqual([true, false]);
  });

  it("relays the Python's report as progress, and builds without terrain", async () => {
    const pyodide = new FakePyodide();
    const { runtime } = runtimeOf(pyodide);
    const progress = vi.fn();

    await runtime.build([], false, progress);
    pyodide.report!("info", "Parsing 1 KML file(s)...");

    expect(progress).toHaveBeenCalledWith("Parsing 1 KML file(s)...");
    expect(pyodide.python.at(-1)).toContain("terrain=False");
  });

  it("answers a Python failure with its message and syncs the cache still", async () => {
    const pyodide = new FakePyodide();
    pyodide.answer = new Error(
      "Traceback\nflown.exceptions.ExportError: Export failed: no room",
    );
    const { runtime } = runtimeOf(pyodide);
    await runtime.ready(vi.fn());
    pyodide.synced.length = 0;
    pyodide.syncError = new Error("later");

    await expect(runtime.build([], true, vi.fn())).rejects.toThrow(
      "Export failed: no room",
    );
    expect(pyodide.synced).toEqual([false]);
  });
});

describe("serveBuilds", () => {
  function scopeOf(runtime: Runtime): {
    scope: LocalWorkerScope;
    posted: [BuildResponse, Transferable[] | undefined][];
    send(request: BuildRequest): void;
  } {
    const posted: [BuildResponse, Transferable[] | undefined][] = [];
    const scope: LocalWorkerScope = {
      onmessage: null,
      postMessage: (message, transfer) => {
        posted.push([message, transfer]);
      },
      location: { href: "https://example.test/flown/localWorker.bundle.js" },
    };
    serveBuilds(scope, runtime);
    return {
      scope,
      posted,
      send: (request) =>
        scope.onmessage!({ data: request } as MessageEvent<BuildRequest>),
    };
  }

  it("answers with the progress and the outcome under the request's id", async () => {
    const pyodide = new FakePyodide();
    const { runtime } = runtimeOf(pyodide);
    const { posted, send } = scopeOf(runtime);

    send({ id: 4, build: { files: [], terrain: false } });
    await vi.waitFor(() =>
      expect(posted.some(([m]) => "done" in m)).toBe(true),
    );

    expect(posted[0]).toEqual([
      { id: 4, progress: LOADING_RUNTIME_MESSAGE },
      undefined,
    ]);
    const [done, transfer] = posted.at(-1)!;
    expect(done).toMatchObject({ id: 4, done: OUTCOME });
    expect(transfer).toEqual(
      ("done" in done ? done.done.files : []).map((file) => file.bytes),
    );
  });

  it("answers a failure with its message", async () => {
    const pyodide = new FakePyodide();
    pyodide.answer = new Error("KMLParseError: not a KML file");
    const { runtime } = runtimeOf(pyodide);
    const { posted, send } = scopeOf(runtime);

    send({ id: 5, build: { files: [], terrain: true } });
    await vi.waitFor(() =>
      expect(posted.some(([m]) => "error" in m)).toBe(true),
    );

    expect(posted.at(-1)).toEqual([
      { id: 5, error: "not a KML file" },
      undefined,
    ]);
  });
});
