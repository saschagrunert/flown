/**
 * The worker that builds the flights a visitor drops
 * (services/localWorker.ts), with a Pyodide in memory: the runtime is
 * loaded once and told of its sources and cache before the package is
 * imported, a build writes the inputs, runs the Python with the terrain
 * switch and the report, and hands back what came out under /site, a
 * Python failure is answered with its message and the cache is synced
 * either way, and the worker's scope answers every request under its id.
 */
import { webcrypto } from "node:crypto";
import { ReadableStream } from "node:stream/web";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  CACHE_LOAD_MS,
  CACHE_SLOW_MESSAGE,
  FETCHING_GROUND_MESSAGE,
  fetchSources,
  importPyodide,
  importVerified,
  LOADING_PACKAGE_MESSAGE,
  LOADING_PARSER_MESSAGE,
  LOADING_RUNTIME_MESSAGE,
  PYODIDE_INTEGRITY,
  PYODIDE_URL,
  DOWNLOAD_IDLE_MS,
  pythonErrorMessage,
  Runtime,
  RUNTIME_START_MS,
  runtimeWatch,
  type RuntimeWatch,
  serveBuilds,
  verifiedFetch,
  type Fetch,
  type BuildRequest,
  type LocalWorkerScope,
  type WorkerMessage,
  type PyodideLike,
  type PyodideLoader,
  RUNTIME_FAILED_MESSAGE,
  RUNTIME_LOST_MESSAGE,
} from "../../../../flown/frontend/services/localWorker";
import {
  CACHE_BUSY_MESSAGE,
  CACHE_GONE_MESSAGE,
  CACHE_WAIT_MS,
} from "../../../../flown/frontend/services/localStore";

const OUTCOME = {
  years: [2025],
  flights: 1,
  airports: 2,
  bounds: [
    [50, 11],
    [52, 13],
  ],
};

/** What Pyodide throws for an exception of the Python run */
class PythonError extends Error {
  /** The name of the Python exception's class */
  type = "Exception";
}

/** The cache's connection as IDBFS opens it on a sync, and keeps */
class FakeConnection {
  onversionchange: (() => void) | null = null;
  closed = 0;
  close(): void {
    this.closed++;
  }
}

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
  /** Whether a sync never comes back: a cache read in slowly */
  syncHangs = false;
  /** Whether lxml did not come, which its load does not say (loadPackage) */
  parserMissing = false;
  /** Whether lxml's load never settles: its download stalled */
  parserHangs = false;
  /** The files under /input as the Python run saw them */
  inputsAtRun = new Map<string, Uint8Array>();
  /** What a write of a file fails with, if anything: memory run out */
  writeError: Error | null = null;
  /** Whether the cache's opening waits: a deletion holds it up */
  openHangs = false;
  /** Lets the opening that waits come */
  openLate: (() => void) | null = null;
  /** Called as a sync reads the cache in, before it is done */
  onRead: (() => void) | null = null;
  /** Called as a sync writes the cache back, before it is done */
  onWrite: (() => void) | null = null;
  /** IDBFS's connections, by the mount's path, and its opening of one */
  readonly idbfs = {
    dbs: {} as Record<string, FakeConnection | undefined>,
    getDB: (
      name: string,
      callback: (error: unknown, db?: FakeConnection) => void,
    ): void => {
      const open = () =>
        callback(null, (this.idbfs.dbs[name] ??= new FakeConnection()));
      if (this.openHangs) this.openLate = open;
      else open();
    },
  };
  readonly ffi = { PythonError };
  /** Where the cache is mounted */
  mountedAt: string | null = null;
  readonly globals = {
    set: (name: string, value: unknown): void => {
      if (name === "report") {
        this.report = value as (level: string, message: string) => void;
      }
    },
  };
  readonly FS = {
    filesystems: { IDBFS: this.idbfs },
    mkdirTree: (path: string): void => {
      const parts = path.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        this.dirs.add("/" + parts.slice(0, i).join("/"));
      }
    },
    mount: (type: unknown, _options: object, path: string): void => {
      this.mounted.push(`${type === this.idbfs ? "idbfs" : "?"}:${path}`);
      this.mountedAt = path;
    },
    syncfs: (populate: boolean, callback: (error: unknown) => void): void => {
      this.synced.push(populate);
      // Opened by the first sync if it is not yet, and kept, as IDBFS does
      let connection: FakeConnection | undefined;
      if (this.mountedAt) {
        this.idbfs.getDB(this.mountedAt, (_, db) => (connection = db));
      }
      (populate ? this.onRead : this.onWrite)?.();
      // IDBFS reads and then writes with the connection it began with,
      // which throws once closed: the sync never comes back then
      if (connection?.closed) return;
      if (!this.syncHangs) callback(this.syncError);
    },
    writeFile: (path: string, data: Uint8Array): void => {
      if (this.writeError) throw this.writeError;
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

  // As Pyodide's: it resolves whether or not the package came, and only
  // warns of one that did not; the import then fails
  loadPackage(name: string): Promise<unknown> {
    this.packages.push(name);
    if (this.parserHangs) return new Promise(() => {});
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
    if (this.parserMissing && code.includes("import lxml")) {
      throw new PythonError("ModuleNotFoundError: No module named 'lxml'");
    }
    return undefined;
  }

  runPythonAsync(code: string): Promise<unknown> {
    this.python.push(code);
    this.inputsAtRun = new Map(
      [...this.files].filter(([path]) => path.startsWith("/input/")),
    );
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

/** A file as the page hands it over: as the store keeps it */
const bytes = (...values: number[]): Blob => new Blob([new Uint8Array(values)]);

/** An exception of the Python run, as Pyodide throws it */
const pythonError = (message: string, type = "Exception"): Error =>
  Object.assign(new PythonError(message), { type });

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
    // The parser is tried before anything else of the package runs
    expect(pyodide.python[0]).toBe("import lxml.etree");
    expect(pyodide.python[1]).toContain('sys.path.insert(0, "/lib/flown-src")');
    expect(pyodide.python[1]).toContain(
      'os.environ["FLOWN_CACHE_DIR"] = "/flown-cache"',
    );
    expect(pyodide.python[1]).toContain('os.environ["HOME"] = "/flown-cache"');
    expect(PYODIDE_URL).toMatch(/^https:\/\/cdn\.jsdelivr\.net\/pyodide\/v\d/);
  });

  it("mounts the cache where it is told, for a page off the root", async () => {
    const pyodide = new FakePyodide();
    const { runtime } = runtimeOf(pyodide, "/flown-cache%3A%2Fa%2F");

    await runtime.ready(vi.fn());

    expect(pyodide.mounted).toEqual(["idbfs:/flown-cache%3A%2Fa%2F"]);
    expect(pyodide.python[1]).toContain(
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
    // Mounted once: a second mount on the same directory is refused
    expect(pyodide.mounted).toEqual(["idbfs:/flown-cache"]);
  });

  it("keeps the runtime after a start that failed past it, and tries only the rest", async () => {
    const pyodide = new FakePyodide();
    const { runtime, loader, sources } = runtimeOf(pyodide);
    // The package's archive of a deploy that is on its way
    sources.mockRejectedValueOnce(new Error("HTTP 404"));
    const report = vi.fn<(message: string) => void>();

    await expect(runtime.ready(report)).rejects.toThrow("HTTP 404");
    report.mockClear();
    await expect(runtime.ready(report)).resolves.toBe(pyodide);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(sources).toHaveBeenCalledTimes(2);
    expect(report.mock.calls.map(([m]) => m)).toEqual([
      LOADING_PARSER_MESSAGE,
      LOADING_PACKAGE_MESSAGE,
    ]);
    expect(pyodide.mounted).toEqual(["idbfs:/flown-cache"]);
  });

  it("lets go of a runtime that failed for good in a start, and loads anew", async () => {
    const pyodide = new FakePyodide();
    const { runtime, loader } = runtimeOf(pyodide);
    vi.spyOn(pyodide, "loadPackage").mockRejectedValueOnce(
      new Error("Pyodide already fatally failed and can no longer be used."),
    );
    const report = vi.fn<(message: string) => void>();

    // As lost, which the page lets the worker go with
    await expect(runtime.build([], true, report)).rejects.toThrow(
      RUNTIME_LOST_MESSAGE,
    );
    await expect(runtime.ready(report)).resolves.toBe(pyodide);
    expect(loader).toHaveBeenCalledTimes(2);
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
    const inputs = [
      { name: "a.kml", bytes: bytes(1, 2, 3) },
      { name: "sub/b.kml", bytes: bytes(4) },
      // As kept: beside an a_c.kml, it would take that one's place
      { name: "a\\c.kml", bytes: bytes(5) },
      { name: "a_c.kml", bytes: bytes(6) },
    ];

    const outcome = await runtime.build(inputs, true, progress);

    expect([...pyodide.inputsAtRun.keys()]).toEqual([
      "/input/a.kml",
      "/input/sub_b.kml",
      "/input/a\\c.kml",
      "/input/a_c.kml",
    ]);
    expect(pyodide.inputsAtRun.get("/input/a.kml")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    // Neither the inputs nor the outputs stay in the worker's memory
    expect([...pyodide.files.keys()]).toEqual([]);
    expect([...pyodide.dirs].filter((d) => /^\/(input|site)/.test(d))).toEqual(
      [],
    );
    const run = pyodide.python.at(-1)!;
    expect(run).toContain(
      'browser.build("/input", "/site", report, terrain=True, retry=False, tiles_dir=None, flags=json.loads("null"))',
    );
    expect(outcome).toMatchObject(OUTCOME);
    expect(outcome.files.map((f) => f.path).sort()).toEqual([
      "2025/data.json",
      "metadata.json",
    ]);
    const metadata = outcome.files.find((f) => f.path === "metadata.json")!;
    expect(new Uint8Array(metadata.bytes)).toEqual(new Uint8Array([1, 2]));
    // The cache went out after the build
    expect(pyodide.synced).toEqual([true, false]);
  });

  it("fetches the tiles the build asks for, and builds again with them", async () => {
    const pyodide = new FakePyodide();
    const tiles = [
      { url: "https://tiles.example/10/1/2.png", name: "10-1-2" },
      { url: "https://tiles.example/10/1/3.png", name: "10-1-3" },
    ];
    const run = vi.spyOn(pyodide, "runPythonAsync");
    const answers = [JSON.stringify({ tiles }), JSON.stringify(OUTCOME)];
    const handedIn: string[][] = [];
    run.mockImplementation((code: string) => {
      pyodide.python.push(code);
      handedIn.push(
        [...pyodide.files.keys()].filter((path) => path.startsWith("/tiles/")),
      );
      pyodide.FS.mkdirTree("/site/2025");
      pyodide.files.set("/site/metadata.json", new Uint8Array([1, 2]));
      return Promise.resolve(answers.shift()!);
    });
    const fetchTile = vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        (input as string).endsWith("3.png")
          ? new Response(null, { status: 404 })
          : new Response(new Uint8Array([7, 7])),
      ),
    );
    const runtime = new Runtime(
      vi.fn(() => Promise.resolve(vi.fn(() => Promise.resolve(pyodide)))),
      vi.fn(() => Promise.resolve(new ArrayBuffer(8))),
      undefined,
      undefined,
      fetchTile,
    );
    const progress = vi.fn();

    const outcome = await runtime.build(
      [{ name: "a.kml", bytes: bytes(1) }],
      true,
      progress,
      { retry: true },
    );

    expect(fetchTile).toHaveBeenCalledTimes(2);
    expect(progress).toHaveBeenCalledWith(FETCHING_GROUND_MESSAGE);
    // The one it got, handed in to the second run, which downloads nothing
    // again of what the first could not
    expect(handedIn).toEqual([[], ["/tiles/10-1-2.png"]]);
    const [first, second] = pyodide.python.slice(-2);
    expect(first).toContain("retry=True, tiles_dir=None");
    expect(second).toContain('retry=False, tiles_dir="/tiles"');
    expect(outcome).toMatchObject(OUTCOME);
    expect([...pyodide.dirs].filter((d) => d.startsWith("/tiles"))).toEqual([]);
    expect(pyodide.synced).toEqual([true, false]);
  });

  it("hands the build the page's flags, and fetches the sources of its build", async () => {
    const pyodide = new FakePyodide();
    const { runtime, sources } = runtimeOf(pyodide);

    await runtime.build([], true, vi.fn(), {
      flags: ["de", 'x"y'],
      version: "abc:123",
    });

    expect(sources).toHaveBeenCalledWith("abc:123");
    // A JSON string Python reads as one: no quote of a code ends it early
    expect(pyodide.python.at(-1)).toContain(
      `flags=json.loads(${JSON.stringify(JSON.stringify(["de", 'x"y']))})`,
    );
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

  it("downloads again what the last build could not where asked", async () => {
    const pyodide = new FakePyodide();
    const { runtime } = runtimeOf(pyodide);

    await runtime.build([], true, vi.fn(), { retry: true });

    expect(pyodide.python.at(-1)).toContain("retry=True");
  });

  it("answers a Python failure with its message and syncs the cache still", async () => {
    const pyodide = new FakePyodide();
    pyodide.answer = pythonError(
      "Traceback\nflown.exceptions.ExportError: Export failed: no room",
    );
    const { runtime } = runtimeOf(pyodide);
    await runtime.ready(vi.fn());
    pyodide.synced.length = 0;
    pyodide.syncError = new Error("later");

    pyodide.FS.mkdirTree("/input");
    pyodide.files.set("/input/kept.kml", new Uint8Array([8]));

    await expect(runtime.build([], true, vi.fn())).rejects.toThrow(
      "Export failed: no room",
    );
    expect(pyodide.synced).toEqual([false]);
    // Nor do the files of a build that failed stay
    expect([...pyodide.files.keys()]).toEqual([]);
  });

  it("lets the runtime go when the Python ran out of memory", async () => {
    const pyodide = new FakePyodide();
    pyodide.answer = pythonError("Traceback\nMemoryError", "MemoryError");
    const { runtime } = runtimeOf(pyodide);

    // A new runtime has all the memory again, which this one keeps taken
    await expect(runtime.build([], true, vi.fn())).rejects.toThrow(
      RUNTIME_LOST_MESSAGE,
    );
  });

  it("lets the runtime go when the files cannot be written into it", async () => {
    const pyodide = new FakePyodide();
    pyodide.writeError = new RangeError("Array buffer allocation failed");
    const { runtime } = runtimeOf(pyodide);

    await expect(
      runtime.build([{ name: "a.kml", bytes: bytes(1) }], true, vi.fn()),
    ).rejects.toThrow(RUNTIME_LOST_MESSAGE);
  });

  it("names a file kept that the store cannot read, and keeps the runtime", async () => {
    const pyodide = new FakePyodide();
    const { runtime, loader } = runtimeOf(pyodide);
    // What a Blob of the store answers once what it kept of it is lost
    const lost = new Blob([new Uint8Array([2])]);
    vi.spyOn(lost, "arrayBuffer").mockRejectedValue(
      new DOMException("The file could not be read", "NotReadableError"),
    );
    const inputs = [
      { name: "a.kml", bytes: bytes(1) },
      { name: "b.kml", bytes: lost },
    ];

    await expect(runtime.build(inputs, true, vi.fn())).rejects.toThrow(
      "Could not read b.kml; remove it and add it again",
    );
    // No build ran on the rest, and nothing of them stays
    expect(pyodide.python.join("\n")).not.toContain("browser.build(");
    expect([...pyodide.files.keys()]).toEqual([]);
    // Not lost: the next build takes the same runtime
    inputs.pop();
    await expect(runtime.build(inputs, true, vi.fn())).resolves.toMatchObject(
      OUTCOME,
    );
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("lets go of the cache another tab deletes, and writes nothing back into it", async () => {
    const pyodide = new FakePyodide();
    const { runtime } = runtimeOf(pyodide);
    const gone = vi.fn();
    runtime.onCacheGone = gone;
    let release!: (answer: string) => void;
    await runtime.ready(vi.fn());
    const connection = pyodide.idbfs.dbs["/flown-cache"]!;
    vi.spyOn(pyodide, "runPythonAsync").mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    pyodide.synced.length = 0;

    const building = runtime.build([], true, vi.fn());
    await vi.waitFor(() => expect(release).toBeDefined());
    // That tab's deletion waits on this connection
    connection.onversionchange!();
    release(JSON.stringify(OUTCOME));
    await building;

    expect(gone).toHaveBeenCalledTimes(1);
    expect(connection.closed).toBe(1);
    expect(pyodide.idbfs.dbs["/flown-cache"]).toBeUndefined();
    // A sync would open the database again, with the old cache in it
    expect(pyodide.synced).toEqual([]);
    await expect(runtime.build([], true, vi.fn())).rejects.toThrow(
      CACHE_GONE_MESSAGE,
    );
    expect(pyodide.synced).toEqual([]);
  });

  it("watches the cache from its opening, before it is read in", async () => {
    const pyodide = new FakePyodide();
    const { runtime } = runtimeOf(pyodide);
    const gone = vi.fn();
    runtime.onCacheGone = gone;
    // Another tab's Remove all while the cache is read in, which takes a
    // while on a slow phone: it waits on this connection, which the read
    // keeps until it is done
    let connection: FakeConnection | undefined;
    pyodide.onRead = () => {
      connection = pyodide.idbfs.dbs["/flown-cache"];
      connection!.onversionchange!();
    };

    await expect(runtime.build([], true, vi.fn())).rejects.toThrow(
      CACHE_GONE_MESSAGE,
    );

    expect(gone).toHaveBeenCalledTimes(1);
    expect(connection?.closed).toBe(1);
    expect(pyodide.idbfs.dbs["/flown-cache"]).toBeUndefined();
    // Nothing was built, nor written back
    expect(pyodide.synced).toEqual([true]);
    expect(pyodide.python.some((code) => code.includes("browser.build"))).toBe(
      false,
    );
  });

  it("lets the runtime go when lxml did not come, which its load does not say", async () => {
    const pyodide = new FakePyodide();
    pyodide.parserMissing = true;
    const { runtime, loader } = runtimeOf(pyodide);

    const failed = runtime.build([], true, vi.fn());

    // Said as the runtime that could not be loaded, and lost: the page
    // starts a new worker for the next build
    await expect(failed).rejects.toThrow(RUNTIME_FAILED_MESSAGE);
    await expect(failed).rejects.toBeInstanceOf(Error);
    expect(pyodide.python).toEqual(["import lxml.etree"]);
    pyodide.parserMissing = false;
    await expect(runtime.ready(vi.fn())).resolves.toBe(pyodide);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("serveBuilds", () => {
  function scopeOf(runtime: Runtime): {
    scope: LocalWorkerScope;
    posted: [WorkerMessage, Transferable[] | undefined][];
    send(request: BuildRequest): void;
  } {
    const posted: [WorkerMessage, Transferable[] | undefined][] = [];
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
    pyodide.answer = pythonError("KMLParseError: not a KML file");
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

  it("answers a failure of the runtime itself as lost, for the page to let the worker go", async () => {
    const pyodide = new FakePyodide();
    // A WebAssembly trap, after which Pyodide refuses every call
    pyodide.answer = new Error("RuntimeError: unreachable");
    const { runtime } = runtimeOf(pyodide);
    const { posted, send } = scopeOf(runtime);

    send({ id: 6, build: { files: [], terrain: true } });
    await vi.waitFor(() =>
      expect(posted.some(([m]) => "error" in m)).toBe(true),
    );

    expect(posted.at(-1)).toEqual([
      { id: 6, error: RUNTIME_LOST_MESSAGE, lost: true },
      undefined,
    ]);
  });

  it("tells the page when another tab deleted the cache, and answers the next build as lost", async () => {
    const pyodide = new FakePyodide();
    const { runtime } = runtimeOf(pyodide);
    const { posted, send } = scopeOf(runtime);
    await runtime.ready(vi.fn());

    pyodide.idbfs.dbs["/flown-cache"]!.onversionchange!();
    expect(posted).toEqual([[{ cacheGone: true }, undefined]]);

    send({ id: 8, build: { files: [], terrain: true } });
    await vi.waitFor(() =>
      expect(posted.some(([m]) => "error" in m)).toBe(true),
    );
    expect(posted.at(-1)).toEqual([
      { id: 8, error: CACHE_GONE_MESSAGE, lost: true },
      undefined,
    ]);
  });

  it("answers a build whose Python ran before it says the cache is gone", async () => {
    const pyodide = new FakePyodide();
    const { runtime } = runtimeOf(pyodide);
    const { posted, send } = scopeOf(runtime);
    await runtime.ready(vi.fn());
    const connection = pyodide.idbfs.dbs["/flown-cache"]!;
    // The deletion comes as the cache is written back after the run, which
    // keeps the connection until it is done
    pyodide.onWrite = () => connection.onversionchange!();

    send({ id: 9, build: { files: [], terrain: true } });
    await vi.waitFor(() =>
      expect(posted.some(([m]) => "cacheGone" in m)).toBe(true),
    );

    // The page keeps what was built, unless the files are gone too
    // (putDataset), and only then lets the worker go
    const answers = posted.map(([m]) => m).filter((m) => !("progress" in m));
    expect(answers.map((m) => Object.keys(m).sort().join())).toEqual([
      "done,id",
      "cacheGone",
    ]);
    expect(connection.closed).toBe(1);
  });

  it("answers a parser that did not come as a runtime that could not load, and lost", async () => {
    const pyodide = new FakePyodide();
    pyodide.parserMissing = true;
    const { runtime } = runtimeOf(pyodide);
    const { posted, send } = scopeOf(runtime);

    send({ id: 7, build: { files: [], terrain: true } });
    await vi.waitFor(() =>
      expect(posted.some(([m]) => "error" in m)).toBe(true),
    );

    expect(posted.at(-1)).toEqual([
      { id: 7, error: RUNTIME_FAILED_MESSAGE, lost: true },
      undefined,
    ]);
  });
});

describe("the files of Pyodide", () => {
  const ok = (body = ""): Response => new Response(body);

  // jsdom has no SubtleCrypto; the worker has the browser's
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** The integrity of `text`, as subresource integrity writes it */
  async function sri(text: string, bits = 384): Promise<string> {
    const digest = await crypto.subtle.digest(
      `SHA-${bits}`,
      new TextEncoder().encode(text),
    );
    return `sha${bits}-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
  }

  /** A watch that counts what it is told */
  function counting(): RuntimeWatch & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      failed: new Promise<never>(() => {}),
      begin: () => calls.push("begin"),
      progress: () => calls.push("progress"),
      end: () => calls.push("end"),
      fail: () => calls.push("fail"),
      stop: () => calls.push("stop"),
    };
  }

  it("has a hash for every file the runtime is made of", () => {
    expect(Object.keys(PYODIDE_INTEGRITY).sort()).toEqual([
      "pyodide-lock.json",
      "pyodide.asm.mjs",
      "pyodide.asm.wasm",
      "pyodide.mjs",
      "python_stdlib.zip",
    ]);
    for (const hash of Object.values(PYODIDE_INTEGRITY)) {
      expect(hash).toMatch(/^sha384-[A-Za-z0-9+/]{64}$/);
    }
  });

  it("are checked here, part by part, and handed on as they came", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of ["ab", "c"]) {
          controller.enqueue(new TextEncoder().encode(part));
        }
        controller.close();
      },
    });
    const fetch = vi.fn<Fetch>(() =>
      Promise.resolve(
        new Response(body as unknown as BodyInit, {
          headers: { "content-type": "application/wasm" },
        }),
      ),
    );
    const watch = counting();
    // A package, with the hash the lock file gives it
    const integrity = await sri("abc", 256);

    const answer = await verifiedFetch(fetch, () => watch)(
      `${PYODIDE_URL}lxml-1.whl`,
      { integrity },
    );

    expect(await answer.text()).toBe("abc");
    expect(answer.headers.get("content-type")).toBe("application/wasm");
    // The browser's own check would read the whole file before answering
    expect(fetch.mock.calls[0]![1]).toMatchObject({ integrity: "" });
    expect(watch.calls).toEqual(["begin", "progress", "progress", "end"]);
  });

  it("refuses a file that is not the one pinned", async () => {
    const fetch = vi.fn<Fetch>(() => Promise.resolve(new Response("evil")));
    const watch = counting();
    const checked = verifiedFetch(fetch, () => watch);

    await expect(checked(`${PYODIDE_URL}pyodide.asm.wasm`)).rejects.toThrow(
      "is not the file pinned",
    );
    await expect(
      checked(new URL(`${PYODIDE_URL}lxml-1.whl`), {
        integrity: await sri("good"),
      }),
    ).rejects.toThrow(TypeError);
    expect(watch.calls.filter((call) => call === "fail")).toHaveLength(2);
  });

  it("refuses an answer that is no success, whatever its body", async () => {
    // A lock file of its own under a 500 or a 404: Pyodide reads the lock
    // file without looking at the status, and would take its hashes
    const lock = '{"packages": {"lxml": {"sha256": "00"}}}';
    const watch = counting();
    for (const status of [500, 404]) {
      const fetch = vi.fn<Fetch>(() =>
        Promise.resolve(new Response(lock, { status })),
      );
      await expect(
        verifiedFetch(fetch, () => watch)(`${PYODIDE_URL}pyodide-lock.json`),
      ).rejects.toThrow(`HTTP ${status}`);
    }
    // A package, with the hash the lock file gives it, the same way
    const fetch = vi.fn<Fetch>(() =>
      Promise.resolve(new Response("abc", { status: 500 })),
    );
    await expect(
      verifiedFetch(fetch, () => watch)(`${PYODIDE_URL}lxml-1.whl`, {
        integrity: await sri("abc", 256),
      }),
    ).rejects.toThrow(TypeError);
    expect(watch.calls.filter((call) => call === "fail")).toHaveLength(3);
  });

  it("refuses a file of the release that has no hash, pinned or asked for", async () => {
    const fetch = vi.fn<Fetch>(() => Promise.resolve(ok("export {}")));
    const checked = verifiedFetch(fetch);

    for (const url of [
      `${PYODIDE_URL}other.mjs`,
      `${PYODIDE_URL}pyodide.mjs?v=2`,
      // Spellings of the release's URL that are the same once resolved
      `${PYODIDE_URL}./x/../other.mjs`,
      PYODIDE_URL.replace("cdn.jsdelivr.net", "CDN.jsdelivr.net") + "a.js",
    ]) {
      await expect(checked(url)).rejects.toThrow("has no hash pinned");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tells the watch of a download that failed", async () => {
    const fetch = vi.fn<Fetch>(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    const watch = counting();

    await expect(
      verifiedFetch(fetch, () => watch)(`${PYODIDE_URL}python_stdlib.zip`),
    ).rejects.toThrow("Failed to fetch");
    expect(watch.calls).toEqual(["begin", "fail"]);
  });

  it("leaves what is no file of the runtime alone", async () => {
    const answer = new Response("zip");
    const fetch = vi.fn<Fetch>(() => Promise.resolve(answer));
    const watch = counting();

    await expect(
      verifiedFetch(fetch, () => watch)("flown-src.zip?v=1", { method: "GET" }),
    ).resolves.toBe(answer);
    expect(fetch).toHaveBeenCalledWith("flown-src.zip?v=1", { method: "GET" });
    expect(watch.calls).toEqual([]);
  });

  it("imports a module from the bytes it fetched, not from its URL", async () => {
    const fetch = vi.fn<Fetch>(() => Promise.resolve(ok("export default 1")));
    const imported: string[] = [];
    const revoke = vi.spyOn(URL, "revokeObjectURL");

    const module = await importVerified<{ default: number }>(
      "pyodide.mjs",
      fetch,
      (url) => {
        imported.push(url);
        return Promise.resolve({ default: 1 });
      },
    );

    expect(module.default).toBe(1);
    expect(fetch).toHaveBeenCalledWith(`${PYODIDE_URL}pyodide.mjs`);
    expect(imported).toHaveLength(1);
    expect(imported[0]).toMatch(/^blob:/);
    expect(revoke).toHaveBeenCalledWith(imported[0]);
  });

  it("says which module it could not fetch", async () => {
    const fetch = vi.fn<Fetch>(() =>
      Promise.resolve(new Response("", { status: 404 })),
    );

    await expect(importVerified("pyodide.mjs", fetch, vi.fn())).rejects.toThrow(
      "Could not fetch pyodide.mjs: HTTP 404",
    );
  });

  it("hands Pyodide its interpreter, checked, rather than letting it import one", async () => {
    const fetch = vi.fn<Fetch>(() => Promise.resolve(ok()));
    const create = vi.fn();
    const loadPyodide = vi.fn(() => Promise.resolve(new FakePyodide()));
    let call = 0;
    const loader = await importPyodide(fetch, () =>
      Promise.resolve(call++ === 0 ? { loadPyodide } : { default: create }),
    );

    await loader({ indexURL: PYODIDE_URL });

    expect(
      fetch.mock.calls.map(([url]) =>
        (url as string).slice(PYODIDE_URL.length),
      ),
    ).toEqual(["pyodide.mjs", "pyodide.asm.mjs"]);
    expect(loadPyodide).toHaveBeenCalledWith({
      indexURL: PYODIDE_URL,
      createPyodideModule: create,
    });
  });
});

describe("fetchSources", () => {
  const href = "https://example.test/flown/localWorker.bundle.js";

  it("fetches the archive next to the worker, as the site's build", async () => {
    const fetch = vi.fn<Fetch>(() =>
      Promise.resolve(new Response(new Uint8Array([1, 2]))),
    );

    const bytes = await fetchSources(href, fetch, "a:b");

    expect((fetch.mock.calls[0]![0] as URL).href).toBe(
      "https://example.test/flown/flown-src.zip?v=a%3Ab",
    );
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2]));
  });

  it("says what went wrong for an answer that is no archive", async () => {
    const fetch = vi.fn<Fetch>(() =>
      Promise.resolve(new Response("", { status: 403 })),
    );

    await expect(fetchSources(href, fetch)).rejects.toThrow(
      "Could not fetch flown-src.zip: HTTP 403",
    );
  });
});

describe("a start of the runtime that never comes", () => {
  /** A Pyodide whose load never settles, as when its interpreter fails */
  function hangingRuntime(watches: RuntimeWatch[]): {
    runtime: Runtime;
    loader: ReturnType<typeof vi.fn>;
  } {
    const loadPyodide: PyodideLoader = vi.fn(
      () => new Promise<PyodideLike>(() => {}),
    );
    const loader = vi.fn(() => Promise.resolve(loadPyodide));
    const sources = vi.fn(() => Promise.resolve(new ArrayBuffer(8)));
    const runtime = new Runtime(loader, sources, "/flown-cache", () => {
      const watch = runtimeWatch();
      watches.push(watch);
      return watch;
    });
    return { runtime, loader };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails the build when a file of it fails, and the next one tries again", async () => {
    const watches: RuntimeWatch[] = [];
    const { runtime, loader } = hangingRuntime(watches);

    const build = runtime.build([], true, vi.fn());
    await vi.waitFor(() => expect(watches).toHaveLength(1));
    // Its hash did not match, or the browser is offline
    watches[0]!.begin();
    watches[0]!.fail(new TypeError("Failed to fetch"));

    await expect(build).rejects.toThrow(RUNTIME_FAILED_MESSAGE);
    const again = runtime.build([], true, vi.fn());
    await vi.waitFor(() => expect(watches).toHaveLength(2));
    expect(loader).toHaveBeenCalledTimes(2);
    watches[1]!.fail(new Error("HTTP 404"));
    await expect(again).rejects.toThrow(RUNTIME_FAILED_MESSAGE);
  });

  it("fails the build when its files came but it does not start in time", async () => {
    vi.useFakeTimers();
    const watches: RuntimeWatch[] = [];
    const { runtime } = hangingRuntime(watches);
    const build = runtime.build([], true, vi.fn());
    let settled = false;
    const failed = expect(
      build.finally(() => {
        settled = true;
      }),
    ).rejects.toThrow(RUNTIME_FAILED_MESSAGE);
    await vi.waitFor(() => expect(watches).toHaveLength(1));

    // A policy that refuses WebAssembly: the bytes came, nothing runs
    watches[0]!.begin();
    watches[0]!.end();
    await vi.advanceTimersByTimeAsync(RUNTIME_START_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await failed;
  });

  it("gives a download as long as its parts keep coming, and fails one that stalls", async () => {
    vi.useFakeTimers();
    const watch = runtimeWatch(RUNTIME_START_MS, DOWNLOAD_IDLE_MS);
    const rejected = vi.fn();
    watch.failed.catch(rejected);

    watch.begin();
    // Ten minutes of a slow line, a part every 50 s
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(DOWNLOAD_IDLE_MS - 10_000);
      watch.progress();
    }
    expect(rejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DOWNLOAD_IDLE_MS);
    expect(rejected).toHaveBeenCalledWith(new Error("Stalled"));
  });

  it("starts the start's limit once the last download came", async () => {
    vi.useFakeTimers();
    const watch = runtimeWatch(100, 50);
    const rejected = vi.fn();
    watch.failed.catch(rejected);

    watch.begin();
    watch.begin();
    watch.end();
    // One still on its way: the downloads' limit holds, not the start's
    await vi.advanceTimersByTimeAsync(49);
    watch.end();
    await vi.advanceTimersByTimeAsync(99);
    expect(rejected).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rejected).toHaveBeenCalledWith(new Error("No start"));
  });

  it("fails a start whose downloads never begin, and stops watching one that came", async () => {
    vi.useFakeTimers();
    const idle = runtimeWatch(100, 50);
    const neverBegun = vi.fn();
    idle.failed.catch(neverBegun);
    await vi.advanceTimersByTimeAsync(50);
    expect(neverBegun).toHaveBeenCalledWith(new Error("No download"));

    const started = runtimeWatch(100, 50);
    const rejected = vi.fn();
    started.failed.catch(rejected);
    started.begin();
    started.end();
    started.stop();
    // Told of nothing more, as Pyodide's later fetches (lxml) are
    started.begin();
    started.fail(new Error("late"));
    await vi.advanceTimersByTimeAsync(500);
    expect(rejected).not.toHaveBeenCalled();
  });

  it("fails the build when lxml's download stalls, rather than load it for good", async () => {
    vi.useFakeTimers();
    const pyodide = new FakePyodide();
    pyodide.parserHangs = true;
    const watches: RuntimeWatch[] = [];
    const runtime = new Runtime(
      () => Promise.resolve(() => Promise.resolve(pyodide)),
      () => Promise.resolve(new ArrayBuffer(8)),
      "/flown-cache",
      () => {
        const watch = runtimeWatch();
        watches.push(watch);
        return watch;
      },
    );
    const build = runtime.build([], true, vi.fn());
    const failed = expect(build).rejects.toThrow(RUNTIME_FAILED_MESSAGE);
    // One for the runtime, one for the parser
    await vi.waitFor(() => expect(watches).toHaveLength(2));

    watches[1]!.begin();
    await vi.advanceTimersByTimeAsync(DOWNLOAD_IDLE_MS);

    await failed;
  });

  it("says another tab holds the files when the cache does not open in time", async () => {
    vi.useFakeTimers();
    const pyodide = new FakePyodide();
    // A deletion waiting on another tab holds the opening up
    pyodide.openHangs = true;
    const runtime = new Runtime(
      () => Promise.resolve(() => Promise.resolve(pyodide)),
      () => Promise.resolve(new ArrayBuffer(8)),
      "/flown-cache",
      runtimeWatch,
    );

    const build = runtime.build([], true, vi.fn());
    const failed = expect(build).rejects.toThrow(CACHE_BUSY_MESSAGE);
    await vi.advanceTimersByTimeAsync(CACHE_WAIT_MS);

    await failed;
    expect(pyodide.synced).toEqual([]);

    // Opened once that tab let go, which IDBFS keeps: watched all the same,
    // or the next Remove all of another tab would wait on it for good
    const gone = vi.fn();
    runtime.onCacheGone = gone;
    pyodide.openLate!();
    pyodide.idbfs.dbs["/flown-cache"]!.onversionchange!();
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("gives reading the cache in a longer while, and says so when it takes longer", async () => {
    vi.useFakeTimers();
    const pyodide = new FakePyodide();
    pyodide.syncHangs = true;
    const { runtime } = runtimeOf(pyodide);
    const build = runtime.build([], true, vi.fn());
    let settled = false;
    const failed = expect(
      build.finally(() => {
        settled = true;
      }),
    ).rejects.toThrow(CACHE_SLOW_MESSAGE);

    // Tens of megabytes of tiles on a slow phone: past the wait on a tab
    await vi.advanceTimersByTimeAsync(CACHE_WAIT_MS * 2);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(CACHE_LOAD_MS);

    await failed;
  });
});
