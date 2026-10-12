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
 * it by URL (services/localBuild.ts) and shares no module with it. The
 * import of Pyodide is left to the browser (`external` in the build), from
 * a pinned version: an update is a change here, checked like any other.
 */

import { versioned } from "./lazyImport";
import { localCacheDbName } from "../state/localFlags";

/** The Pyodide release, which matches the Python the package needs */
const PYODIDE_VERSION = "314.0.7";
export const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
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

export type BuildRequest = {
  id: number;
  build: { files: InputFile[]; terrain: boolean };
};

/** What the build answers with (flown.browser.build), plus the files */
export interface BuildOutcome {
  years: number[];
  flights: number;
  airports: number;
  center: [number, number];
  bounds: [[number, number], [number, number]];
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

/** Said when the runtime, the parser or the package cannot be fetched */
export const RUNTIME_FAILED_MESSAGE =
  "Could not load the Python runtime. Check the connection and try again.";
/** Said while the runtime, the parser and the package are fetched */
export const LOADING_RUNTIME_MESSAGE = "Loading the Python runtime…";
export const LOADING_PARSER_MESSAGE = "Loading the KML parser…";
export const LOADING_PACKAGE_MESSAGE = "Loading the build…";

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
    private readonly fetchSources: () => Promise<ArrayBuffer>,
    /** Where the cache is mounted, the name of its database (localFlags) */
    private readonly cacheDir: string = localCacheDbName(),
  ) {}

  ready(report: ProgressReport): Promise<PyodideLike> {
    this.pyodide ??= this.start(report).catch((error: unknown) => {
      // The next build tries again
      this.pyodide = null;
      throw error;
    });
    return this.pyodide;
  }

  private async start(report: ProgressReport): Promise<PyodideLike> {
    report(LOADING_RUNTIME_MESSAGE);
    const loadPyodide = await this.loadPyodide();
    const pyodide = await loadPyodide({ indexURL: PYODIDE_URL });
    report(LOADING_PARSER_MESSAGE);
    await pyodide.loadPackage("lxml");
    report(LOADING_PACKAGE_MESSAGE);
    const sources = await this.fetchSources();
    pyodide.FS.mkdirTree(SOURCES_DIR);
    pyodide.unpackArchive(sources, "zip", { extractDir: SOURCES_DIR });
    pyodide.FS.mkdirTree(this.cacheDir);
    pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, this.cacheDir);
    await syncfs(pyodide, true);
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
  ): Promise<BuildOutcome> {
    let pyodide: PyodideLike;
    try {
      pyodide = await this.ready(report);
    } catch (error) {
      throw new Error(RUNTIME_FAILED_MESSAGE, { cause: error });
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
      const result = (await pyodide.runPythonAsync(
        `import json\n` +
          `from flown import browser\n` +
          `json.dumps(browser.build(${JSON.stringify(INPUT_DIR)}, ` +
          `${JSON.stringify(OUTPUT_DIR)}, report, terrain=${terrain ? "True" : "False"}))`,
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
      .build(build.files, build.terrain, report)
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

/** Pyodide from its CDN, as a module the browser resolves */
async function importPyodide(): Promise<PyodideLoader> {
  const module = (await import(
    /* webpackIgnore: true */ `${PYODIDE_URL}pyodide.mjs`
  )) as {
    loadPyodide: PyodideLoader;
  };
  return module.loadPyodide;
}

async function fetchSources(href: string): Promise<ArrayBuffer> {
  // With the build as a query, as the page fetches its lazy bundles: the
  // archive of an earlier deploy may still be in the browser's cache
  const response = await fetch(new URL(versioned(SOURCES_FILE), href));
  if (!response.ok) {
    throw new Error(`Could not fetch ${SOURCES_FILE}: HTTP ${response.status}`);
  }
  return response.arrayBuffer();
}

// Only a worker has this constructor; a page that imports the file does not
if ("WorkerGlobalScope" in globalThis) {
  const scope = globalThis as unknown as LocalWorkerScope;
  // The page's directory is the bundle's (site_assets puts them side by side)
  serveBuilds(
    scope,
    new Runtime(
      importPyodide,
      () => fetchSources(scope.location.href),
      localCacheDbName(new URL(scope.location.href).pathname),
    ),
  );
}
