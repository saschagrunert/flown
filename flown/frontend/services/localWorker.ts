/**
 * The worker that builds the flights a visitor drops on the page.
 *
 * It runs the Python package the site was built with, in Pyodide: the
 * runtime and lxml come from the Pyodide CDN the first time, the package
 * from `flown-src.zip` next to the page (site_assets.py writes it). The
 * dropped files go into the worker's file system, `flown.browser.build`
 * (flown/browser.py) writes the data files of a site from them, and the
 * worker hands those back to the page, which keeps them in the browser
 * (services/localStore.ts). The airport database the build fetches, and
 * the elevation tiles the worker fetches for it (services/localTiles.ts),
 * are kept in a directory mounted on IndexedDB, so the second build needs
 * neither again.
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
import { fetchTiles, type WantedTile } from "./localTiles";
import { localCacheDbName } from "../state/localFlags";
import {
  CACHE_BUSY_MESSAGE,
  CACHE_GONE_MESSAGE,
  CACHE_WAIT_MS,
} from "./localStore";

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
/** Where the tiles the worker fetched are handed in (flown/browser.py) */
const TILES_DIR = "/tiles";
const SOURCES_DIR = "/lib/flown-src";

/**
 * A file the page hands over, as it was dropped: as the store keeps it,
 * read here one file at a time (Runtime.run)
 */
export interface InputFile {
  name: string;
  bytes: Blob;
}

/** What a build is asked for besides the files (flown.browser.build) */
export interface BuildOptions {
  /** The country codes the page has a flag for (its available_flags) */
  flags?: string[] | undefined;
  /** The site's build, which the package's archive is fetched as */
  version?: string | undefined;
  /**
   * Download again at once what the last build could not (Build again),
   * which a failed download holds back for an hour otherwise
   */
  retry?: boolean | undefined;
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
  bounds: [[number, number], [number, number]];
  /** The files that made no flight, which the rest were built without */
  skipped?: SkippedFile[] | undefined;
  /** What the build warned of, for the panel to show */
  warnings?: string[] | undefined;
  /** What it went without, offline ("airports", "runways", "terrain") */
  degraded?: string[] | undefined;
  files: { path: string; bytes: ArrayBuffer }[];
}

/** What a run of the Python build answers with: the build, or the tiles it needs */
type PythonOutcome = Omit<BuildOutcome, "files"> | { tiles: WantedTile[] };

type BuildResponse = { id: number } & (
  | { progress: string }
  | { done: BuildOutcome }
  // `lost`: the runtime failed with it, and the worker goes (RuntimeLost)
  | { error: string; lost?: true }
);

/**
 * What the worker says to the page: the answers to its builds, and that
 * another tab deleted the cache (Runtime.onCacheGone), which the worker
 * goes with
 */
export type WorkerMessage = BuildResponse | { cacheGone: true };

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
  /** The class of what a Python exception throws in JavaScript */
  ffi: { PythonError: abstract new (...args: never[]) => Error };
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

/**
 * What IDBFS is besides a file system: it keeps the connection to the
 * database of a mount, by the mount's path, that `getDB` opens (as every
 * sync does first), for as long as the worker lives, and never closes it
 */
interface IdbfsConnections {
  dbs: Record<string, IDBDatabase | undefined>;
  getDB(
    name: string,
    callback: (error: unknown, db?: IDBDatabase) => void,
  ): void;
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
/** Said while the worker fetches the elevation tiles the build needs */
export const FETCHING_GROUND_MESSAGE =
  "Fetching the ground under your flights…";

/**
 * How long the cache may take to be read into the worker's memory once it
 * is open: all of it comes in at every start, and stays for the worker's
 * life. The airport database, some 20 MB, the parses of the files, and the
 * pixels of the elevation tiles, some 100 KB a tile (flown/browser.py keeps
 * no PNG beside them): 60 MB for a few hundred tiles, which a slow phone
 * takes a while over
 */
export const CACHE_LOAD_MS = 120_000;
/** Said when that takes longer */
export const CACHE_SLOW_MESSAGE =
  "Reading what the build keeps in this browser took too long; try again";

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

/**
 * Open the database of the cache mounted at `name` as IDBFS opens it, for
 * the syncs to use (IdbfsConnections), and hand it to `opened` as soon as
 * it is open, also after a wait for it was given up: this is what waits on
 * another tab that holds it, or on a deletion of it that waits on one
 * (localStore.ts, deleteCache), before the cache in it is read
 */
function openCache(
  idbfs: IdbfsConnections,
  name: string,
  opened: (db: IDBDatabase) => void,
): Promise<void> {
  return new Promise((resolve, reject) =>
    idbfs.getDB(name, (error, db) => {
      if (!db) return reject(new Error("IndexedDB", { cause: error }));
      opened(db);
      resolve();
    }),
  );
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
 * Said when the runtime itself failed in a build, which a new one gets:
 * most often for lack of memory, which every file kept takes its share of
 * in every build
 */
export const RUNTIME_LOST_MESSAGE =
  "The Python runtime failed, perhaps for lack of memory; try again, or remove some files";

/**
 * An error of the build that leaves the runtime fatally failed: anything
 * the Python run throws that is no Python exception (a WebAssembly trap,
 * the memory run out), after which Pyodide answers every call with "already
 * fatally failed", and such a failure of a start. The page lets the worker
 * go with it (LocalBuilder).
 */
class RuntimeLost extends Error {}

/** A trap, or what Pyodide says to every call after one */
function fatal(error: unknown): boolean {
  return (
    error instanceof WebAssembly.RuntimeError ||
    (error instanceof Error && error.message.includes("fatally failed"))
  );
}

/**
 * The runtime, loaded once for the worker's lifetime: the package's
 * sources unpacked, the cache directory mounted on IndexedDB and told to
 * the package before it is imported (flown/browser.py says why). A start
 * that fails after Pyodide came (the package's archive around a deploy,
 * another tab holding the cache) keeps that Pyodide, and the next build
 * tries only the steps after it: a second one would load the whole runtime
 * again, and hold two in memory for a while. Unless the failure was the
 * runtime's own, or its parser's (RuntimeLost, loadParser).
 */
export class Runtime {
  private pyodide: Promise<PyodideLike> | null = null;
  private loaded: Promise<PyodideLike> | null = null;
  /** Whether the cache is mounted, which a second mount would refuse */
  private mounted = false;
  /** The cache's connection that is watched (watchCache) */
  private watched: IDBDatabase | null = null;
  /** Set once another tab deleted the cache: nothing goes into it again */
  private cacheGone = false;
  /** The sync of the cache on its way, settled either way (sync) */
  private syncing: Promise<unknown> = Promise.resolve();
  /** Told that another tab deleted the cache (serveBuilds tells the page) */
  onCacheGone: () => void = () => undefined;

  constructor(
    private readonly loadPyodide: () => Promise<PyodideLoader>,
    /** The package's archive, of the site's build `version` */
    private readonly fetchSources: (version?: string) => Promise<ArrayBuffer>,
    /** Where the cache is mounted, the name of its database (localFlags) */
    private readonly cacheDir: string = localCacheDbName(),
    /** What watches each start, a new one for every try (runtimeWatch) */
    private readonly watchStart: () => RuntimeWatch = runtimeWatch,
    /** What fetches the elevation tiles (services/localTiles.ts) */
    private readonly fetchTile: Fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {}

  ready(report: ProgressReport, version?: string): Promise<PyodideLike> {
    this.pyodide ??= this.start(report, version).catch((error: unknown) => {
      // The next build tries again
      this.pyodide = null;
      throw error;
    });
    return this.pyodide;
  }

  private async load(report: ProgressReport): Promise<PyodideLike> {
    report(LOADING_RUNTIME_MESSAGE);
    const watch = this.watchStart();
    try {
      const loadPyodide = await this.loadPyodide();
      return await Promise.race([
        loadPyodide({ indexURL: PYODIDE_URL }),
        watch.failed,
      ]);
    } finally {
      watch.stop();
    }
  }

  private async start(
    report: ProgressReport,
    version: string | undefined,
  ): Promise<PyodideLike> {
    this.loaded ??= this.load(report).catch((error: unknown) => {
      this.loaded = null;
      throw error;
    });
    const pyodide = await this.loaded;
    try {
      report(LOADING_PARSER_MESSAGE);
      await this.loadParser(pyodide);
      report(LOADING_PACKAGE_MESSAGE);
      const sources = await this.fetchSources(version);
      pyodide.FS.mkdirTree(SOURCES_DIR);
      pyodide.unpackArchive(sources, "zip", { extractDir: SOURCES_DIR });
      if (!this.mounted) {
        pyodide.FS.mkdirTree(this.cacheDir);
        pyodide.FS.mount(pyodide.FS.filesystems.IDBFS, {}, this.cacheDir);
        this.mounted = true;
      }
      // Held up for as long as another tab holds the cache open, or a
      // deletion of it waits on one (localStore.ts, deleteCache), which
      // the opening alone tells, and watched from then on, before it is
      // read (a deletion then would wait on it for good); reading it all
      // in has a limit of its own
      const idbfs = pyodide.FS.filesystems.IDBFS as IdbfsConnections;
      await within(
        openCache(idbfs, this.cacheDir, (db) => this.watchCache(idbfs, db)),
        CACHE_WAIT_MS,
        CACHE_BUSY_MESSAGE,
      );
      await within(this.sync(pyodide, true), CACHE_LOAD_MS, CACHE_SLOW_MESSAGE);
      pyodide.runPython(
        `import os, sys\n` +
          `sys.path.insert(0, ${JSON.stringify(SOURCES_DIR)})\n` +
          `os.environ["FLOWN_CACHE_DIR"] = ${JSON.stringify(this.cacheDir)}\n` +
          `os.environ["HOME"] = ${JSON.stringify(this.cacheDir)}\n`,
      );
    } catch (error) {
      // A trap, or what Pyodide says to every call after one: the runtime
      // is not kept for the next try, and the worker goes with it
      if (error instanceof RuntimeLost) {
        this.loaded = null;
        throw error;
      }
      if (fatal(error)) {
        this.loaded = null;
        throw new RuntimeLost(RUNTIME_LOST_MESSAGE, { cause: error });
      }
      throw error;
    }
    return pyodide;
  }

  /**
   * Let go of the cache's connection when another tab deletes the cache
   * (localStore.ts, deleteCache, for its Remove all), which waits on it:
   * IDBFS never closes it, and that tab's Remove all would wait and fail.
   * Closed alone it would be opened again by the next sync, which would
   * write the cache back with the parses of the files removed: so nothing
   * syncs again, the next build refuses, and the page lets the worker go.
   * A sync on its way keeps it until it is done: IDBFS writes what it read
   * with the connection it read it with, which throws once closed, and that
   * sync, and the build waiting on it, would never end.
   */
  private watchCache(idbfs: IdbfsConnections, db: IDBDatabase): void {
    if (db === this.watched) return;
    this.watched = db;
    db.onversionchange = () => {
      this.cacheGone = true;
      delete idbfs.dbs[this.cacheDir];
      void this.syncing.then(() => db.close());
      this.onCacheGone();
    };
  }

  /** Sync the cache, as watchCache knows of until it is done */
  private sync(pyodide: PyodideLike, populate: boolean): Promise<void> {
    const sync = syncfs(pyodide, populate);
    this.syncing = sync.catch(() => undefined);
    return sync;
  }

  /**
   * lxml, the KML parser. Pyodide's load of a package resolves whether or
   * not it came: a failed download or a hash that does not match is only
   * written to the console, and every build would then fail on the import.
   * And a download that stalls never settles. So the load is watched as
   * the runtime's is, and the import tried. Either failing lets the runtime
   * go (RuntimeLost), whose loader may still wait on the stalled download:
   * the next build starts a worker of its own.
   */
  private async loadParser(pyodide: PyodideLike): Promise<void> {
    const watch = this.watchStart();
    try {
      await Promise.race([pyodide.loadPackage("lxml"), watch.failed]);
      pyodide.runPython("import lxml.etree");
    } catch (error) {
      if (fatal(error)) throw error;
      throw new RuntimeLost(RUNTIME_FAILED_MESSAGE, { cause: error });
    } finally {
      watch.stop();
    }
  }

  async build(
    files: InputFile[],
    terrain: boolean,
    report: ProgressReport,
    { flags, version, retry }: BuildOptions = {},
  ): Promise<BuildOutcome> {
    let pyodide: PyodideLike;
    try {
      pyodide = await this.ready(report, version);
    } catch (error) {
      if (error instanceof RuntimeLost) throw error;
      const message = error instanceof Error ? error.message : "";
      const said = [CACHE_BUSY_MESSAGE, CACHE_SLOW_MESSAGE].includes(message);
      throw new Error(said ? message : RUNTIME_FAILED_MESSAGE, {
        cause: error,
      });
    }
    // Deleted before this build, or while the runtime started for it
    if (this.cacheGone) throw new RuntimeLost(CACHE_GONE_MESSAGE);
    try {
      return await this.run(pyodide, files, terrain, report, flags, retry);
    } finally {
      // Nothing of the files stays in the worker's memory between builds:
      // the page keeps them, and the next build writes them again
      try {
        removeTree(pyodide, INPUT_DIR);
        removeTree(pyodide, OUTPUT_DIR);
        removeTree(pyodide, TILES_DIR);
      } catch {
        // A runtime lost, which goes with the worker
      }
    }
  }

  private async run(
    pyodide: PyodideLike,
    files: InputFile[],
    terrain: boolean,
    report: ProgressReport,
    flags: string[] | undefined,
    retry = false,
  ): Promise<BuildOutcome> {
    const fs = pyodide.FS;
    let unread = "";
    try {
      removeTree(pyodide, INPUT_DIR);
      removeTree(pyodide, OUTPUT_DIR);
      removeTree(pyodide, TILES_DIR);
      fs.mkdirTree(INPUT_DIR);
      for (const file of files) {
        // The name decides the aircraft (flown/browser.py), and the file is
        // named by it in what the build says: as it is kept, but for a
        // slash, the one character no file name in the worker can hold
        const name = file.name.replaceAll("/", "_");
        // Read one at a time: the file system holds the only copy of each
        await file.bytes.arrayBuffer().then(
          (bytes) =>
            fs.writeFile(`${INPUT_DIR}/${name}`, new Uint8Array(bytes)),
          () => (unread ||= file.name),
        );
      }
    } catch (error) {
      // The memory for the files' copies, which the runtime could not
      // get: a new one starts with all of it again
      throw new RuntimeLost(RUNTIME_LOST_MESSAGE, { cause: error });
    }
    // A file kept that the store could not read, which is no failure of
    // the runtime: what the store kept of it is lost, and goes with a
    // Remove (the same file dropped again is taken as kept). Not built
    // without it, as a single file would leave nothing to build, and a
    // build without one is easily taken for whole
    if (unread) {
      throw new Error(`Could not read ${unread}; remove it and add it again`);
    }
    pyodide.globals.set("report", (_level: string, message: string) =>
      report(message),
    );
    let outcome: PythonOutcome;
    try {
      outcome = await this.python(pyodide, terrain, flags, retry, null);
      // The tiles the cache has not, which the build stopped at: fetched
      // here several at a time, decoded, and handed in to it again, which
      // takes any it could not get for missing
      if ("tiles" in outcome) {
        report(FETCHING_GROUND_MESSAGE);
        fs.mkdirTree(TILES_DIR);
        await fetchTiles(outcome.tiles, this.fetchTile, (name, png, planes) => {
          fs.writeFile(`${TILES_DIR}/${name}.png`, png);
          if (planes) fs.writeFile(`${TILES_DIR}/${name}.planes`, planes);
        });
        removeTree(pyodide, OUTPUT_DIR);
        outcome = await this.python(pyodide, terrain, flags, false, TILES_DIR);
        removeTree(pyodide, TILES_DIR);
        if ("tiles" in outcome)
          throw new Error("The build asked for its tiles twice");
      }
    } catch (error) {
      // A Python exception leaves the runtime as it was, but for one of
      // memory (flown/browser.py raises one for a year that ran out): the
      // memory the runtime took stays taken, which a new one has again
      if (
        error instanceof pyodide.ffi.PythonError &&
        (error as { type?: unknown }).type !== "MemoryError"
      ) {
        throw new Error(pythonErrorMessage(error), { cause: error });
      }
      throw new RuntimeLost(RUNTIME_LOST_MESSAGE, { cause: error });
    } finally {
      // The tiles and the airports fetched on the way stay for the next
      // build, unless another tab deleted the cache meanwhile (watchCache)
      if (!this.cacheGone) {
        await this.sync(pyodide, false).catch(() => undefined);
      }
    }
    return { ...outcome, files: filesUnder(pyodide, OUTPUT_DIR) };
  }

  /** One run of the Python build (flown.browser.build), `tilesDir` handed in */
  private async python(
    pyodide: PyodideLike,
    terrain: boolean,
    flags: string[] | undefined,
    retry: boolean,
    tilesDir: string | null,
  ): Promise<PythonOutcome> {
    // The flags as a JSON string, which Python reads as a literal
    const result = (await pyodide.runPythonAsync(
      `import json\n` +
        `from flown import browser\n` +
        `json.dumps(browser.build(${JSON.stringify(INPUT_DIR)}, ` +
        `${JSON.stringify(OUTPUT_DIR)}, report, terrain=${terrain ? "True" : "False"}, ` +
        `retry=${retry ? "True" : "False"}, ` +
        `tiles_dir=${tilesDir ? JSON.stringify(tilesDir) : "None"}, ` +
        `flags=json.loads(${JSON.stringify(JSON.stringify(flags ?? null))})))`,
    )) as string;
    return JSON.parse(result) as PythonOutcome;
  }
}

export interface LocalWorkerScope {
  onmessage: ((event: MessageEvent<BuildRequest>) => void) | null;
  postMessage(message: WorkerMessage, transfer?: Transferable[]): void;
  location: { href: string };
}

/**
 * Answer the page's build requests with `runtime`. That another tab deleted
 * the cache is said once the builds on their way are answered: one whose
 * Python ran is done, with the files the page handed over, and the page
 * keeps it unless those are gone too (localStore.ts, putDataset).
 */
export function serveBuilds(scope: LocalWorkerScope, runtime: Runtime): void {
  let running = 0;
  let gone = false;
  const tell = (): void => {
    if (!gone || running) return;
    gone = false;
    scope.postMessage({ cacheGone: true });
  };
  runtime.onCacheGone = () => {
    gone = true;
    tell();
  };
  scope.onmessage = (event) => {
    const { id, build } = event.data;
    const report = (message: string) =>
      scope.postMessage({ id, progress: message });
    running++;
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
        scope.postMessage({
          id,
          error: message,
          ...(error instanceof RuntimeLost && { lost: true }),
        });
      })
      .finally(() => {
        running--;
        tell();
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
 *
 * It fails closed. An answer that is no success rejects whatever its body:
 * Pyodide reads the lock file without looking at the status, so a 404 or
 * a 500 with a lock file of its own would hand it other hashes for the
 * packages, and their code would run with the page's origin. And a file
 * under the release's URL with no hash, pinned or asked for, rejects too.
 */
export function verifiedFetch(
  fetch: Fetch,
  watch: () => RuntimeWatch | undefined = () => undefined,
): Fetch {
  return async (input, init) => {
    // A relative URL is the site's, never the CDN's; resolved, so no
    // spelling of one under the release (a dot segment, the host in
    // capitals) passes as another
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      location.href,
    ).href;
    const release = url.startsWith(PYODIDE_URL);
    const integrity =
      init?.integrity ||
      (release ? PYODIDE_INTEGRITY[url.slice(PYODIDE_URL.length)] : undefined);
    if (!integrity && !release) return fetch(input, init);
    const watcher = watch();
    watcher?.begin();
    try {
      if (!integrity) throw new TypeError(`${url} has no hash pinned`);
      const response = await fetch(input, { ...init, integrity: "" });
      if (!response.ok) {
        throw new TypeError(`${url}: HTTP ${response.status}`);
      }
      const parts: Uint8Array<ArrayBuffer>[] = [];
      const reader = response.body?.getReader();
      for (;;) {
        const part = await reader?.read();
        if (!part || part.done) break;
        parts.push(part.value);
        watcher?.progress();
      }
      const bytes = await new Blob(parts).arrayBuffer();
      if (!(await hasIntegrity(bytes, integrity))) {
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
