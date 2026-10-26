/**
 * The flights a visitor drops on the page, kept in the browser (IndexedDB).
 *
 * Three things are kept: the files as they were dropped, their bytes apart
 * from their names and sizes (`files` and `blobs`), so the panel lists them
 * without reading hundreds of megabytes, and what the build in the worker
 * made of them (`dataset`), the data files the page reads in place of the
 * site's (see ui/localFlights.ts and services/localBuild.ts), with one
 * record about them (`info`). Nothing leaves the browser: the storage is
 * the page's own, named for its directory (LOCAL_DB_NAME), and goes with
 * the site's data when the visitor clears it.
 *
 * One connection serves the page: the start reads every data file through
 * it (localStartConfig), and the panel its lists. Every call answers a
 * promise; a browser without IndexedDB (none the map runs in) or one that
 * refuses it (a private window of an older Firefox) rejects, and the
 * callers say so.
 */

import { LOCAL_DB_NAME, localCacheDbName } from "../state/localFlags";

const DB_VERSION = 1;
const FILES = "files";
const BLOBS = "blobs";
const DATASET = "dataset";
const INFO = "info";
const INFO_KEY = "info";

/** A dropped file as the panel lists it */
export interface StoredFile {
  name: string;
  size: number;
  /** When it was dropped, ms since the epoch */
  added: number;
  /**
   * When the file was last changed (File.lastModified), which a drop of it
   * again tells an unchanged one by; absent for files kept before
   */
  modified?: number | undefined;
}

/** A dropped file with its bytes, as it is kept */
export interface StoredFileWithBytes extends StoredFile {
  bytes: ArrayBuffer;
}

/** What the build made of the files, which the page opens on */
export interface LocalInfo {
  years: number[];
  flights: number;
  airports: number;
  bounds: [[number, number], [number, number]];
  /** The names of the files the dataset was built from */
  files: string[];
  /** Those files by name, size and time (fileStamp): what a rebuild tells by */
  stamp: string;
  /**
   * The build of the site that made it, its frontend and its Python (see
   * siteBuild in ui/localFlights.ts); its format is that build's
   */
  build: string | undefined;
  /** When it was built, ms since the epoch */
  builtAt: number;
  /** The files that made no flight, which the rest were built without */
  skipped?: { file: string; reason: string }[] | undefined;
  /** What the build warned of, which the panel shows */
  warnings?: string[] | undefined;
  /** Whether the ground under the flights was sampled (absent: it was) */
  terrain?: boolean | undefined;
  /**
   * What the build went without for want of a connection, the airport
   * names, the runways alone or the ground ("airports", "runways",
   * "terrain"), which the panel offers to build again for (absent: nothing)
   */
  degraded?: string[] | undefined;
}

/** A data file of the dataset, by its path in the site's data directory */
export interface DatasetFile {
  path: string;
  bytes: ArrayBuffer;
}

/** What tells a set of files from another: a line per file, in name order */
export function fileStamp(files: readonly StoredFile[]): string {
  return files
    .map((file) => `${file.name}\u0000${file.size}\u0000${file.added}`)
    .sort()
    .join("\n");
}

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB"));
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    // The error of the request that failed, which the event comes up from
    // (a put over the quota): the transaction's own is still null then
    transaction.onerror = (event) =>
      reject(
        (event.target as { error?: DOMException | null } | null)?.error ??
          transaction.error ??
          new Error("IndexedDB"),
      );
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB aborted"));
  });
}

let opened: Promise<IDBDatabase> | null = null;

/** The page's connection, opened on the first call and kept */
function open(): Promise<IDBDatabase> {
  if (opened) return opened;
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("This browser has no IndexedDB"));
  }
  const request = indexedDB.open(LOCAL_DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const [name, options] of [
      [FILES, { keyPath: "name" }],
      [BLOBS, { keyPath: "name" }],
      [DATASET, { keyPath: "path" }],
      [INFO, undefined],
    ] as const) {
      if (!db.objectStoreNames.contains(name)) {
        db.createObjectStore(name, options);
      }
    }
  };
  const opening = settle(request).then((db) => {
    // Closed by the browser, or asked to make way for a newer page: the
    // next call opens again
    const forget = (): void => {
      if (opened === opening) opened = null;
    };
    db.onclose = forget;
    db.onversionchange = () => {
      db.close();
      forget();
    };
    return db;
  });
  opening.catch(() => {
    if (opened === opening) opened = null;
  });
  opened = opening;
  return opening;
}

/** Let the connection go; the next call opens again (for the tests) */
export function closeStore(): void {
  void opened?.then((db) => db.close()).catch(() => undefined);
  opened = null;
}

/** Run `use` in a transaction over `stores` */
async function withStores<T>(
  stores: string[],
  mode: IDBTransactionMode,
  use: (transaction: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await open();
  const transaction = db.transaction(stores, mode);
  const finished = done(transaction);
  // Settled either way: a failure of `use` is what the caller hears, and
  // the transaction's own failure would go unheard (unhandled) beside it
  finished.catch(() => undefined);
  const result = await use(transaction);
  await finished;
  return result;
}

/** The dropped files, oldest first, without their bytes */
export function listFiles(): Promise<StoredFile[]> {
  return withStores([FILES], "readonly", async (t) => {
    const files: unknown = await settle(t.objectStore(FILES).getAll());
    return (files as StoredFile[]).sort((a, b) => a.added - b.added);
  });
}

/** The bytes of a dropped file, null for one that is not kept */
export function readFileBytes(name: string): Promise<ArrayBuffer | null> {
  return withStores([BLOBS], "readonly", async (t) => {
    const blob: unknown = await settle(t.objectStore(BLOBS).get(name));
    return (blob as { bytes: ArrayBuffer } | undefined)?.bytes ?? null;
  });
}

/** Keep `files`; one dropped again under the same name replaces the old */
export function putFiles(files: StoredFileWithBytes[]): Promise<void> {
  return withStores([FILES, BLOBS], "readwrite", (t) => {
    const listing = t.objectStore(FILES);
    const blobs = t.objectStore(BLOBS);
    for (const { bytes, ...file } of files) {
      listing.put(file);
      blobs.put({ name: file.name, bytes });
    }
  });
}

export function removeFile(name: string): Promise<void> {
  return withStores([FILES, BLOBS], "readwrite", (t) => {
    t.objectStore(FILES).delete(name);
    t.objectStore(BLOBS).delete(name);
  });
}

/**
 * Replace the dataset and what is known about it, unless the files are
 * gone: another tab's Remove all while it was built, which may clear them
 * before this or after (CACHE_GONE_MESSAGE then)
 */
export function putDataset(
  files: DatasetFile[],
  info: LocalInfo,
): Promise<void> {
  return withStores([FILES, DATASET, INFO], "readwrite", async (t) => {
    if (!(await settle(t.objectStore(FILES).count()))) {
      throw new Error(CACHE_GONE_MESSAGE);
    }
    const dataset = t.objectStore(DATASET);
    dataset.clear();
    for (const file of files) dataset.put(file);
    t.objectStore(INFO).put(info, INFO_KEY);
  });
}

/** What the page knows about the dataset, null before a build */
export function readInfo(): Promise<LocalInfo | null> {
  return withStores([INFO], "readonly", async (t) => {
    const info: unknown = await settle(t.objectStore(INFO).get(INFO_KEY));
    return (info as LocalInfo | undefined) ?? null;
  });
}

/** The bytes of a data file of the dataset, null for one it has not */
export function readDatasetFile(path: string): Promise<ArrayBuffer | null> {
  return withStores([DATASET], "readonly", async (t) => {
    const file: unknown = await settle(t.objectStore(DATASET).get(path));
    return (file as DatasetFile | undefined)?.bytes ?? null;
  });
}

/** Everything goes: the files, the dataset and what was known about it */
export function clearAll(): Promise<void> {
  return withStores([FILES, BLOBS, DATASET, INFO], "readwrite", (t) => {
    for (const name of [FILES, BLOBS, DATASET, INFO]) {
      t.objectStore(name).clear();
    }
  });
}

/**
 * How long a deletion of the worker's cache, or the worker's opening of it,
 * waits on another tab that holds it open (its own worker, building)
 */
export const CACHE_WAIT_MS = 10_000;
/** Said when that tab does not let go in time */
export const CACHE_BUSY_MESSAGE =
  "Another tab of this page holds the files open; close it and try again";
/**
 * Said by a build of a tab whose worker let the cache go, which another
 * tab's Remove all deleted (services/localWorker.ts, watchCache)
 */
export const CACHE_GONE_MESSAGE = "Your files were removed in another tab";

/**
 * Delete the worker's cache: the airport database, the elevation tiles
 * and the parsed tracks of the flights (services/localWorker.ts). The
 * worker has to be gone first (LocalBuilder.destroy), or its connection
 * holds the deletion up; a database that was never made deletes fine.
 *
 * One that another tab still holds is deleted as soon as that tab lets it
 * go, which is waited for up to CACHE_WAIT_MS: past that, this rejects
 * with CACHE_BUSY_MESSAGE, and the files are not said to be gone. The
 * deletion stays asked for, which holds up the next opening of the cache
 * until that tab closes (the worker bounds its own wait the same way).
 */
export function deleteCache(waitMs = CACHE_WAIT_MS): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(localCacheDbName());
    let timer: ReturnType<typeof setTimeout> | undefined;
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error ?? new Error("IndexedDB"));
    };
    request.onblocked = () => {
      timer = setTimeout(() => reject(new Error(CACHE_BUSY_MESSAGE)), waitMs);
    };
  });
}

/**
 * Ask the browser to keep the storage rather than evict it when space is
 * short, once; whether it agreed. Chrome decides by the site's use and
 * Firefox asks the visitor; Safari has no such request.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    return (await navigator.storage?.persist?.()) ?? false;
  } catch {
    return false;
  }
}
