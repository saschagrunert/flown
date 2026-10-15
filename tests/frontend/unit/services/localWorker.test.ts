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
  type BuildResponse,
  type LocalWorkerScope,
  type PyodideLike,
  type PyodideLoader,
  RUNTIME_FAILED_MESSAGE,
  RUNTIME_LOST_MESSAGE,
} from "../../../../flown/frontend/services/localWorker";
import {
  CACHE_BUSY_MESSAGE,
  CACHE_WAIT_MS,
} from "../../../../flown/frontend/services/localStore";

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

/** What Pyodide throws for an exception of the Python run */
class PythonError extends Error {}

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
  /** Whether a sync never comes back: another tab holds the cache */
  syncHangs = false;
  readonly ffi = { PythonError };
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
      if (!this.syncHangs) callback(this.syncError);
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

/** An exception of the Python run, as Pyodide throws it */
const pythonError = (message: string): Error => new PythonError(message);

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
      'browser.build("/input", "/site", report, terrain=True, flags=json.loads("null"))',
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

  it("answers a Python failure with its message and syncs the cache still", async () => {
    const pyodide = new FakePyodide();
    pyodide.answer = pythonError(
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

  it("says another tab holds the files when the cache does not open in time", async () => {
    vi.useFakeTimers();
    const pyodide = new FakePyodide();
    pyodide.syncHangs = true;
    const { runtime } = runtimeOf(pyodide);

    const build = runtime.build([], true, vi.fn());
    const failed = expect(build).rejects.toThrow(CACHE_BUSY_MESSAGE);
    await vi.advanceTimersByTimeAsync(CACHE_WAIT_MS);

    await failed;
  });
});
