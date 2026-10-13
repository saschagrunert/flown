/**
 * The worker that builds the flights a visitor drops on the page.
 *
 * It runs the Python package the site was built with, in Pyodide: the
 * runtime and lxml come from the Pyodide CDN the first time, the package
 * from `flown-src.zip` next to the page (site_assets.py writes it). The
 * dropped files go into the worker's file system, `flown.browser.build`
 * (flown/browser.py) writes the data files of a site from them, and the
 * worker hands those back to the page, which keeps them in the browser
 * (services/localStore.ts). The airport database and the elevation tiles
 * the build fetches are kept in a directory mounted on IndexedDB, so the
 * second build needs neither again.
 *
 * A build of its own (build.js, localWorkerBuildOptions): the page starts
 * it by URL (services/localBuild.ts) and shares no module with it. Pyodide
 * comes from its CDN in a pinned version, and every file of it the worker
 * runs is checked against the hash it had when that version was pinned
 * (PYODIDE_INTEGRITY): the worker shares the page's origin and its storage,
 * the visitor's files among it, and the page's policy does not reach it
 * (SECURITY.md). An update is a change here, hashes and all, checked like
 * any other.
 */

import { versioned } from "./lazyImport";
import { localCacheDbName } from "../state/localFlags";
import { CACHE_BUSY_MESSAGE, CACHE_WAIT_MS } from "./localStore";

/** The Pyodide release, which matches the Python the package needs */
const PYODIDE_VERSION = "314.0.7";
export const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
/**
 * The files of that release the runtime is made of, by their SHA-384 as
 * the release has them (the npm package `pyodide` of the same version holds
 * the same bytes): the module, the interpreter, the standard library and
 * the lock file, which carries the hash of every package Pyodide loads and
 * which it checks them against (lxml). A file the CDN serves otherwise is
 * refused by the browser, and the build says the runtime could not load.
 */
export const PYODIDE_INTEGRITY: Readonly<Record<string, string>> = {
  "pyodide.mjs":
    "sha384-Lp79fMwxa4n2BLtugpUAoQMlbxIdg8iCUiP1r3h7nJLkQjwlXT1JzZTeHVL+f4Dg",
  "pyodide.asm.mjs":
    "sha384-/2281iaC0Iimw0B3Kagy1DBfZcJG3W4KYW+EmOqhsdY3fR9BJ88FE2Zt6y0KQKpa",
  "pyodide.asm.wasm":
    "sha384-y++qrQ72KPA1fTjLIuGMP+jppgGxjbLCgfdb0zMrnNnQVhxRUXTOTF6rTxNzllSu",
  "python_stdlib.zip":
    "sha384-xW3A5jmenkrPXbsgrIaB1FCJh9OuLT7FRMagsJMgtlhVc19k/mSy3+7nMaF/d767",
  "pyodide-lock.json":
    "sha384-o8SQQvpVlZnOl04+3dFTJipKxul9GbViVusA379wlOrfHSgxbzt0yPiqCTxOiYES",
};
/** The package's Python, next to the page (site_assets.PYTHON_SOURCES_FILE) */
const SOURCES_FILE = "flown-src.zip";

const INPUT_DIR = "/input";
const OUTPUT_DIR = "/site";
const SOURCES_DIR = "/lib/flown-src";

/** A file the page hands over, as it was dropped */
export interface InputFile {
  name: string;
  bytes: ArrayBuffer;
}

/** What a build is asked for besides the files (flown.browser.build) */
export interface BuildOptions {
  /** The country codes the page has a flag for (its available_flags) */
  flags?: string[] | undefined;
  /** The site's build, which the package's archive is fetched as */
  version?: string | undefined;
}

export type BuildRequest = {
  id: number;
  build: { files: InputFile[]; terrain: boolean } & BuildOptions;
};

/** A file the build left out, and why (flown.browser.build) */
interface SkippedFile {
  file: string;
  reason: string;
}

/** What the build answers with (flown.browser.build), plus the files */
export interface BuildOutcome {
  years: number[];
  flights: number;
  airports: number;
  center: [number, number];
  bounds: [[number, number], [number, number]];
  /** The files that made no flight, which the rest were built without */
  skipped?: SkippedFile[] | undefined;
  /** What the build warned of, for the panel to show */
  warnings?: string[] | undefined;
  files: { path: string; bytes: ArrayBuffer }[];
}

export type BuildResponse = { id: number } & (
  { progress: string } | { done: BuildOutcome } | { error: string }
);

/** What the worker uses of Pyodide */
export interface PyodideLike {
  loadPackage(name: string): Promise<unknown>;
  unpackArchive(
    buffer: ArrayBuffer,
    format: string,
    options?: { extractDir?: string },
  ): void;
  runPython(code: string): unknown;
  runPythonAsync(code: string): Promise<unknown>;
  globals: { set(name: string, value: unknown): void };
  FS: {
    mkdirTree(path: string): void;
    mount(type: unknown, options: object, path: string): void;
    syncfs(populate: boolean, callback: (error: unknown) => void): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    readdir(path: string): string[];
    isDir(mode: number): boolean;
    stat(path: string): { mode: number };
    analyzePath(path: string): { exists: boolean };
    unlink(path: string): void;
    rmdir(path: string): void;
    filesystems: { IDBFS: unknown };
  };
}

export type ProgressReport = (message: string) => void;

export interface PyodideLoader {
  (options: { indexURL: string }): Promise<PyodideLike>;
}

/** fetch as the worker has it */
export type Fetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * How long the runtime may take to start once its files have come:
 * Pyodide compiles and starts it in a few seconds, a slow phone in tens
 */
export const RUNTIME_START_MS = 120_000;
/**
 * How long the files of the runtime may go without a byte coming: some
 * 10 MB on a slow line take minutes, but they come in parts all along
 */
export const DOWNLOAD_IDLE_MS = 60_000;

/** What watches one start of the runtime (runtimeWatch) */
export interface RuntimeWatch {
  /** Rejects when the runtime cannot be had, or does not start in time */
  failed: Promise<never>;
  /** A download of the runtime began */
  begin(): void;
  /** A part of one came */
  progress(): void;
  /** One came whole, and checked */
  end(): void;
  /** One failed: offline, or bytes that are not the ones pinned */
  fail(error: unknown): void;
  /** The runtime started, or the start was given up: nothing to watch */
  stop(): void;
}

/**
 * Watch a start of the runtime for the failures Pyodide only warns of,
 * whose load never settles then, and the panel said it was loading the
 * runtime for good: a file whose download failed or stalls for
 * `idleMs`, or a runtime that does not start within `startMs` of its last
 * file coming (a policy that refuses WebAssembly). The downloads have
 * `idleMs` to begin, too.
 */
export function runtimeWatch(
  startMs = RUNTIME_START_MS,
  idleMs = DOWNLOAD_IDLE_MS,
): RuntimeWatch {
  let reject!: (error: unknown) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let downloads = 0;
  let stopped = false;
  const failed = new Promise<never>((_, rejectWith) => {
    reject = rejectWith;
  });
  // Heard through the race of the start, if at all
  failed.catch(() => undefined);
  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
  };
  const fail = (error: unknown): void => {
    if (stopped) return;
    stop();
    reject(error);
  };
  const wait = (ms: number, why: string): void => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(() => fail(new Error(why)), ms);
  };
  wait(idleMs, "No download");
  return {
    failed,
    begin() {
      downloads++;
      wait(idleMs, "Stalled");
    },
    progress: () => wait(idleMs, "Stalled"),
    end() {
      if (--downloads > 0) wait(idleMs, "Stalled");
      else wait(startMs, "No start");
    },
    fail,
    stop,
  };
}

/** Said when the runtime, the parser or the package cannot be fetched */
export const RUNTIME_FAILED_MESSAGE =
  "Could not load the Python runtime. Check the connection and try again.";
/** Said while the runtime, the parser and the package are fetched */
export const LOADING_RUNTIME_MESSAGE = "Loading the Python runtime…";
export const LOADING_PARSER_MESSAGE = "Loading the KML parser…";
export const LOADING_PACKAGE_MESSAGE = "Loading the build…";

/** `promise`, or a rejection with `message` after `ms` */
function within<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function syncfs(pyodide: PyodideLike, populate: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    pyodide.FS.syncfs(populate, (error) => {
      if (!error) resolve();
      else reject(error instanceof Error ? error : new Error("syncfs failed"));
    });
  });
}

/** Remove `path` and everything in it, if it exists */
function removeTree(pyodide: PyodideLike, path: string): void {
  const fs = pyodide.FS;
  if (!fs.analyzePath(path).exists) return;
  for (const name of fs.readdir(path)) {
    if (name === "." || name === "..") continue;
    const child = `${path}/${name}`;
    if (fs.isDir(fs.stat(child).mode)) removeTree(pyodide, child);
    else fs.unlink(child);
  }
  fs.rmdir(path);
}

/** Every file under `path`, by its path relative to it */
function filesUnder(
  pyodide: PyodideLike,
  path: string,
  prefix = "",
): { path: string; bytes: ArrayBuffer }[] {
  const fs = pyodide.FS;
  const files: { path: string; bytes: ArrayBuffer }[] = [];
  for (const name of fs.readdir(path)) {
    if (name === "." || name === "..") continue;
    const child = `${path}/${name}`;
    if (fs.isDir(fs.stat(child).mode)) {
      files.push(...filesUnder(pyodide, child, `${prefix}${name}/`));
    } else {
      // A copy of its own, so it can be handed to the page
      const bytes = fs.readFile(child).slice();
      files.push({ path: `${prefix}${name}`, bytes: bytes.buffer });
    }
  }
  return files;
}

/** The message of a Python error, without the traceback before it */
export function pythonErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const lines = text.trim().split("\n");
  const last = lines[lines.length - 1] ?? "";
  const match = /^[\w.]*(?:Error|Exception)\s*:\s*(.*)$/.exec(last);
  return match?.[1]?.trim() || last.trim() || "The build failed";
}

/**
 * The runtime, loaded once for the worker's lifetime: the package's
 * sources unpacked, the cache directory mounted on IndexedDB and told to
 * the package before it is imported (flown/browser.py says why).
 */
export class Runtime {
  private pyodide: Promise<PyodideLike> | null = null;

  constructor(
    private readonly loadPyodide: () => Promise<PyodideLoader>,
    /** The package's archive, of the site's build `version` */
    private readonly fetchSources: (version?: string) => Promise<ArrayBuffer>,
    /** Where the cache is mounted, the name of its database (localFlags) */
    private readonly cacheDir: string = localCacheDbName(),
    /** What watches each start, a new one for every try (runtimeWatch) */
    private readonly watchStart: () => RuntimeWatch = runtimeWatch,
  ) {}

  ready(report: ProgressReport, version?: string): Promise<PyodideLike> {
    this.pyodide ??= this.start(report, version).catch((error: unknown) => {
      // The next build tries again
      this.pyodide = null;
      throw error;
    });
    return this.pyodide;
  }

  private async start(
    report: ProgressReport,
    version: string | undefined,
  ): Promise<PyodideLike> {
    report(LOADING_RUNTIME_MESSAGE);
    const watch = this.watchStart();
    let pyodide: PyodideLike;
    try {
      const loadPyodide = await this.loadPyodide();
      pyodide = await Promise.race([
        loadPyodide({ indexURL: PYODIDE_URL }),
        watch.failed,
      ]);
    } finally {
      watch.stop();
    }
    report(LOADING_PARSER_MESSAGE);
    await pyodide.loadPackage("lxml");
    report(LOADING_PACKAGE_MESSAGE);
    const sources = await this.fetchSources(version);
    pyodide.FS.mkdirTree(SOURCES_DIR);
    pyodide.unpackArchive(sources, "zip", { extractDir: SOURCES_DIR });
    pyodide.FS.mkdirTree(this.cacheDir);
    pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, this.cacheDir);
    // Held up for as long as another tab holds the cache open, or a
    // deletion of it waits on one (localStore.ts, deleteCache)
    await within(syncfs(pyodide, true), CACHE_WAIT_MS, CACHE_BUSY_MESSAGE);
    pyodide.runPython(
      `import os, sys\n` +
        `sys.path.insert(0, ${JSON.stringify(SOURCES_DIR)})\n` +
        `os.environ["FLOWN_CACHE_DIR"] = ${JSON.stringify(this.cacheDir)}\n` +
        `os.environ["HOME"] = ${JSON.stringify(this.cacheDir)}\n`,
    );
    return pyodide;
  }

  async build(
    files: InputFile[],
    terrain: boolean,
    report: ProgressReport,
    { flags, version }: BuildOptions = {},
  ): Promise<BuildOutcome> {
    let pyodide: PyodideLike;
    try {
      pyodide = await this.ready(report, version);
    } catch (error) {
      const busy =
        error instanceof Error && error.message === CACHE_BUSY_MESSAGE;
      throw new Error(busy ? CACHE_BUSY_MESSAGE : RUNTIME_FAILED_MESSAGE, {
        cause: error,
      });
    }
    const fs = pyodide.FS;
    removeTree(pyodide, INPUT_DIR);
    removeTree(pyodide, OUTPUT_DIR);
    fs.mkdirTree(INPUT_DIR);
    for (const file of files) {
      // The name decides the aircraft and the year (flown/browser.py)
      const name = file.name.replace(/[/\\]/g, "_");
      fs.writeFile(`${INPUT_DIR}/${name}`, new Uint8Array(file.bytes));
    }
    pyodide.globals.set("report", (_level: string, message: string) =>
      report(message),
    );
    let outcome: Omit<BuildOutcome, "files">;
    try {
      // The flags as a JSON string, which Python reads as a literal
      const result = (await pyodide.runPythonAsync(
        `import json\n` +
          `from flown import browser\n` +
          `json.dumps(browser.build(${JSON.stringify(INPUT_DIR)}, ` +
          `${JSON.stringify(OUTPUT_DIR)}, report, terrain=${terrain ? "True" : "False"}, ` +
          `flags=json.loads(${JSON.stringify(JSON.stringify(flags ?? null))})))`,
      )) as string;
      outcome = JSON.parse(result) as Omit<BuildOutcome, "files">;
    } catch (error) {
      throw new Error(pythonErrorMessage(error), { cause: error });
    } finally {
      // The tiles and the airports fetched on the way stay for the next build
      await syncfs(pyodide, false).catch(() => undefined);
    }
    return { ...outcome, files: filesUnder(pyodide, OUTPUT_DIR) };
  }
}

export interface LocalWorkerScope {
  onmessage: ((event: MessageEvent<BuildRequest>) => void) | null;
  postMessage(message: BuildResponse, transfer?: Transferable[]): void;
  location: { href: string };
}

/** Answer the page's build requests with `runtime` */
export function serveBuilds(scope: LocalWorkerScope, runtime: Runtime): void {
  scope.onmessage = (event) => {
    const { id, build } = event.data;
    const report = (message: string) =>
      scope.postMessage({ id, progress: message });
    runtime
      .build(build.files, build.terrain, report, build)
      .then((done) => {
        scope.postMessage(
          { id, done },
          done.files.map((file) => file.bytes),
        );
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        scope.postMessage({ id, error: message });
      });
  };
}

/**
 * Whether `bytes` are the ones `integrity` names: the first of its hashes,
 * as subresource integrity writes them (sha384-<base64>)
 */
async function hasIntegrity(
  bytes: ArrayBuffer,
  integrity: string,
): Promise<boolean> {
  const [algorithm = "", expected] = integrity
    .trim()
    .split(/\s+/)[0]!
    .split("-", 2);
  const digest = await crypto.subtle.digest(
    algorithm.replace("sha", "SHA-"),
    bytes,
  );
  return btoa(String.fromCharCode(...new Uint8Array(digest))) === expected;
}

/**
 * `fetch` that checks every file of the pinned release against its hash
 * (PYODIDE_INTEGRITY): Pyodide fetches the interpreter, the standard
 * library and the lock file with the worker's `fetch`, and the packages
 * with the hash the lock file gives them, which is checked the same way.
 * Checked here rather than by the browser, which reads the whole of a file
 * before it answers: `watch` sees each part as it comes (runtimeWatch). A
 * file that is not the one pinned rejects, as the browser's check would.
 */
export function verifiedFetch(
  fetch: Fetch,
  watch: () => RuntimeWatch | undefined = () => undefined,
): Fetch {
  return async (input, init) => {
    // A relative URL is the site's, never the CDN's
    const url = input instanceof Request ? input.url : String(input);
    const integrity =
      init?.integrity ||
      (url.startsWith(PYODIDE_URL)
        ? PYODIDE_INTEGRITY[url.slice(PYODIDE_URL.length)]
        : undefined);
    if (!integrity) return fetch(input, init);
    const watcher = watch();
    watcher?.begin();
    try {
      const response = await fetch(input, { ...init, integrity: "" });
      const parts: Uint8Array<ArrayBuffer>[] = [];
      const reader = response.body?.getReader();
      for (;;) {
        const part = await reader?.read();
        if (!part || part.done) break;
        parts.push(part.value);
        watcher?.progress();
      }
      const bytes = await new Blob(parts).arrayBuffer();
      if (response.ok && !(await hasIntegrity(bytes, integrity))) {
        throw new TypeError(`${url} is not the file pinned`);
      }
      watcher?.end();
      return new Response(bytes, response);
    } catch (error) {
      watcher?.fail(error);
      throw error;
    }
  };
}

/**
 * A module of the release, fetched and checked (verifiedFetch) and then
 * imported from those bytes: an import of its URL would take whatever the
 * CDN answers, which no hash of the page's can check.
 */
export async function importVerified<T>(
  name: string,
  fetch: Fetch,
  importModule: (url: string) => Promise<unknown> = (url) =>
    import(/* webpackIgnore: true */ url),
): Promise<T> {
  const response = await fetch(`${PYODIDE_URL}${name}`);
  if (!response.ok) {
    throw new Error(`Could not fetch ${name}: HTTP ${response.status}`);
  }
  const url = URL.createObjectURL(
    new Blob([await response.text()], { type: "text/javascript" }),
  );
  try {
    return (await importModule(url)) as T;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Pyodide from its CDN, checked: its module, and the interpreter's, which
 * it is handed rather than importing it by URL (`createPyodideModule`)
 */
export async function importPyodide(
  fetch: Fetch,
  importModule?: (url: string) => Promise<unknown>,
): Promise<PyodideLoader> {
  const [pyodide, asm] = await Promise.all([
    importVerified<{
      loadPyodide: (options: object) => Promise<PyodideLike>;
    }>("pyodide.mjs", fetch, importModule),
    importVerified<{ default: unknown }>(
      "pyodide.asm.mjs",
      fetch,
      importModule,
    ),
  ]);
  return (options) =>
    pyodide.loadPyodide({ ...options, createPyodideModule: asm.default });
}

/** The package's archive next to `href`, as the site's build `version` */
export async function fetchSources(
  href: string,
  fetch: Fetch,
  version?: string,
): Promise<ArrayBuffer> {
  // With the build as a query, as the page fetches its lazy bundles: the
  // archive of an earlier deploy may still be in the browser's cache. The
  // page's build covers the Python as well (localFlights.ts, siteBuild).
  const name = version
    ? `${SOURCES_FILE}?v=${encodeURIComponent(version)}`
    : versioned(SOURCES_FILE);
  const response = await fetch(new URL(name, href));
  if (!response.ok) {
    throw new Error(`Could not fetch ${SOURCES_FILE}: HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

// Only a worker has this constructor; a page that imports the file does not
if ("WorkerGlobalScope" in globalThis) {
  const scope = globalThis as unknown as LocalWorkerScope;
  // Every fetch of the worker, Pyodide's own among them, the downloads of
  // the runtime watched by the start they are for
  let watch: RuntimeWatch | undefined;
  const fetch = verifiedFetch(globalThis.fetch.bind(globalThis), () => watch);
  globalThis.fetch = fetch;
  // The page's directory is the bundle's (site_assets puts them side by side)
  serveBuilds(
    scope,
    new Runtime(
      () => importPyodide(fetch),
      (version) => fetchSources(scope.location.href, fetch, version),
      localCacheDbName(new URL(scope.location.href).pathname),
      () => (watch = runtimeWatch()),
    ),
  );
}
