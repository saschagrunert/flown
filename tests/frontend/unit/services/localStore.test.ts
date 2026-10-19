/**
 * The store of the flights a visitor drops on the page
 * (services/localStore.ts), run against an IndexedDB in memory: the files
 * are listed oldest first without their bytes, which are read by name, one
 * dropped again replaces its namesake, a dataset replaces the one before
 * it whole, what is read before anything was kept is null, Remove all
 * leaves nothing, one connection serves every call until it is let go or
 * asked to make way, and a browser without IndexedDB or one that refuses
 * persistence is answered rather than thrown at.
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  CACHE_BUSY_MESSAGE,
  CACHE_GONE_MESSAGE,
  clearAll,
  closeStore,
  deleteCache,
  fileStamp,
  listFiles,
  putDataset,
  putFiles,
  readDatasetFile,
  readFileBytes,
  readInfo,
  removeFile,
  requestPersistence,
  type LocalInfo,
  type StoredFileWithBytes,
} from "../../../../flown/frontend/services/localStore";
import {
  LOCAL_DB_NAME,
  localCacheDbName,
} from "../../../../flown/frontend/state/localFlags";

const bytes = (text: string): ArrayBuffer =>
  new TextEncoder().encode(text).buffer;
const text = (buffer: ArrayBuffer | null): string | null =>
  buffer && new TextDecoder().decode(buffer);

const file = (
  name: string,
  added: number,
  content = name,
): StoredFileWithBytes => ({
  name,
  size: content.length,
  bytes: bytes(content),
  added,
});

const INFO: LocalInfo = {
  years: [2025],
  flights: 2,
  airports: 3,
  bounds: [
    [51.1, 12.0],
    [51.5, 13.7],
  ],
  files: ["a.kml", "b.kml"],
  stamp: "a.kml\u00005\u000010\nb.kml\u00005\u000020",
  build: undefined,
  builtAt: 1_700_000_000_000,
};

beforeEach(() => {
  // A fresh database for every test, and no connection to the last one's
  closeStore();
  vi.stubGlobal("indexedDB", new IDBFactory());
});

afterEach(() => closeStore());

describe("fileStamp", () => {
  it("tells a set of files by name, size and time, in name order", () => {
    const stamp = fileStamp([
      { name: "b.kml", size: 2, added: 20 },
      { name: "a.kml", size: 1, added: 10 },
    ]);

    expect(stamp).toBe("a.kml\u00001\u000010\nb.kml\u00002\u000020");
    expect(fileStamp([{ name: "a.kml", size: 1, added: 11 }])).not.toBe(
      fileStamp([{ name: "a.kml", size: 1, added: 10 }]),
    );
    expect(fileStamp([{ name: "a.kml", size: 2, added: 10 }])).not.toBe(
      fileStamp([{ name: "a.kml", size: 1, added: 10 }]),
    );
    expect(fileStamp([])).toBe("");
  });
});

describe("the files", () => {
  it("lists nothing before any was kept", async () => {
    await expect(listFiles()).resolves.toEqual([]);
    await expect(readFileBytes("a.kml")).resolves.toBeNull();
  });

  it("keeps them, lists them oldest first without their bytes, and reads the bytes by name", async () => {
    await putFiles([file("b.kml", 20), file("a.kml", 10)]);
    await putFiles([file("c.kml", 30)]);

    const files = await listFiles();
    expect(files).toEqual([
      { name: "a.kml", size: 5, added: 10 },
      { name: "b.kml", size: 5, added: 20 },
      { name: "c.kml", size: 5, added: 30 },
    ]);
    expect(text(await readFileBytes("a.kml"))).toBe("a.kml");
    await expect(readFileBytes("none.kml")).resolves.toBeNull();
  });

  it("replaces a file dropped again under the same name", async () => {
    await putFiles([file("a.kml", 10, "old")]);
    await putFiles([file("a.kml", 20, "new!")]);

    const files = await listFiles();
    expect(files).toEqual([{ name: "a.kml", size: 4, added: 20 }]);
    expect(text(await readFileBytes("a.kml"))).toBe("new!");
  });

  it("removes one by name with its bytes, and a name it has not without complaint", async () => {
    await putFiles([file("a.kml", 10), file("b.kml", 20)]);

    await removeFile("a.kml");
    await removeFile("none.kml");

    expect((await listFiles()).map((f) => f.name)).toEqual(["b.kml"]);
    await expect(readFileBytes("a.kml")).resolves.toBeNull();
    expect(text(await readFileBytes("b.kml"))).toBe("b.kml");
  });
});

describe("the dataset", () => {
  it("has no info and no files before a build", async () => {
    await expect(readInfo()).resolves.toBeNull();
    await expect(readDatasetFile("metadata.json")).resolves.toBeNull();
  });

  it("keeps the files and what is known about them", async () => {
    await putFiles([file("a.kml", 10)]);
    await putDataset(
      [
        { path: "metadata.json", bytes: bytes("{}") },
        { path: "2025/data.json", bytes: bytes("year") },
      ],
      INFO,
    );

    await expect(readInfo()).resolves.toEqual(INFO);
    expect(text(await readDatasetFile("2025/data.json"))).toBe("year");
    await expect(readDatasetFile("2024/data.json")).resolves.toBeNull();
  });

  it("keeps nothing once the files are gone, removed in another tab", async () => {
    await putFiles([file("a.kml", 10)]);
    await putDataset([{ path: "2024/data.json", bytes: bytes("old") }], INFO);
    // That tab's Remove all came first
    await clearAll();

    await expect(
      putDataset([{ path: "2025/data.json", bytes: bytes("new") }], INFO),
    ).rejects.toThrow(CACHE_GONE_MESSAGE);

    await expect(readInfo()).resolves.toBeNull();
    await expect(readDatasetFile("2025/data.json")).resolves.toBeNull();
  });

  it("replaces the dataset before it whole", async () => {
    await putFiles([file("a.kml", 10)]);
    await putDataset([{ path: "2024/data.json", bytes: bytes("old") }], {
      ...INFO,
      years: [2024],
    });

    await putDataset([{ path: "2025/data.json", bytes: bytes("new") }], INFO);

    await expect(readDatasetFile("2024/data.json")).resolves.toBeNull();
    expect(text(await readDatasetFile("2025/data.json"))).toBe("new");
    expect((await readInfo())?.years).toEqual([2025]);
  });
});

describe("clearAll", () => {
  it("leaves no file, no bytes, no dataset and no info", async () => {
    await putFiles([file("a.kml", 10)]);
    await putDataset([{ path: "metadata.json", bytes: bytes("{}") }], INFO);

    await clearAll();

    await expect(listFiles()).resolves.toEqual([]);
    await expect(readFileBytes("a.kml")).resolves.toBeNull();
    await expect(readInfo()).resolves.toBeNull();
    await expect(readDatasetFile("metadata.json")).resolves.toBeNull();
  });
});

describe("the connection", () => {
  it("is opened once for the page, under the name of its directory", async () => {
    const open = vi.spyOn(indexedDB, "open");

    await putFiles([file("a.kml", 10)]);
    await listFiles();
    await readInfo();

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(LOCAL_DB_NAME, 1);
    expect(LOCAL_DB_NAME).toBe("flown-local");
  });

  it("is opened again once let go", async () => {
    const open = vi.spyOn(indexedDB, "open");
    await listFiles();

    closeStore();
    await listFiles();

    expect(open).toHaveBeenCalledTimes(2);
  });

  it("makes way for a page that wants a newer database", async () => {
    await putFiles([file("a.kml", 10)]);

    // Blocked for good by a connection that did not close on the ask
    const newer = indexedDB.open(LOCAL_DB_NAME, 2);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      newer.onsuccess = () => resolve(newer.result);
      newer.onerror = () => reject(newer.error ?? new Error("open"));
    });
    db.close();

    // The old connection is forgotten, and the next call opens afresh:
    // the database is of a newer version now, which that open refuses
    await expect(listFiles()).rejects.toThrow();
  });
});

describe("a transaction that fails", () => {
  it("rejects when the browser aborts it", async () => {
    // Out of space, say, which aborts the transaction the write is in
    let aborted = false;
    const put = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (this: IDBObjectStore) {
        if (!aborted) this.transaction.abort();
        aborted = true;
        return {} as IDBRequest<IDBValidKey>;
      });

    await expect(
      putFiles([
        { name: "a.kml", size: 1, added: 1, bytes: new ArrayBuffer(1) },
      ]),
    ).rejects.toThrow("IndexedDB aborted");
    put.mockRestore();
    await expect(listFiles()).resolves.toEqual([]);
  });

  it("rejects with the error of the request that failed, a full quota among them", async () => {
    // As the browser has it: the request's error comes up to the
    // transaction, whose own error is still null then
    const quota = new DOMException("Over the quota", "QuotaExceededError");
    const put = vi
      .spyOn(IDBObjectStore.prototype, "put")
      .mockImplementation(function (this: IDBObjectStore) {
        const transaction = this.transaction;
        queueMicrotask(() => {
          transaction.onerror?.call(transaction, {
            target: { error: quota },
          } as unknown as Event);
        });
        return {} as IDBRequest<IDBValidKey>;
      });

    await expect(
      putFiles([
        { name: "a.kml", size: 1, added: 1, bytes: new ArrayBuffer(1) },
      ]),
    ).rejects.toBe(quota);
    put.mockRestore();
  });

  it("rejects with what went wrong in it, and nothing else unheard", async () => {
    const getAll = vi
      .spyOn(IDBObjectStore.prototype, "getAll")
      .mockImplementation(() => {
        throw new Error("broken store");
      });

    await expect(listFiles()).rejects.toThrow("broken store");
    getAll.mockRestore();
  });
});

describe("deleteCache", () => {
  /** A connection to the worker's cache database, made if it is not there */
  function openCache(): Promise<IDBDatabase> {
    const request = indexedDB.open(localCacheDbName(), 1);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("open"));
    });
  }

  it("deletes the worker's cache database", async () => {
    (await openCache()).close();
    const deleteDatabase = vi.spyOn(indexedDB, "deleteDatabase");

    await expect(deleteCache()).resolves.toBeUndefined();

    expect(deleteDatabase).toHaveBeenCalledWith(localCacheDbName());
    expect(
      (await indexedDB.databases()).map((database) => database.name),
    ).not.toContain(localCacheDbName());
  });

  it("deletes fine where there never was one", async () => {
    await expect(deleteCache()).resolves.toBeUndefined();
  });

  it("waits for a tab that holds the cache open to let go", async () => {
    // Another tab's worker, building
    const held = await openCache();
    held.onversionchange = () => {};
    let settled = false;
    const deleting = deleteCache(1000).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);

    held.close();
    await deleting;

    expect(
      (await indexedDB.databases()).map((database) => database.name),
    ).not.toContain(localCacheDbName());
  });

  it("says another tab holds the files when it does not let go in time", async () => {
    const held = await openCache();
    // The ask to make way is not taken up: the deletion stays blocked
    held.onversionchange = () => {};

    await expect(deleteCache(20)).rejects.toThrow(CACHE_BUSY_MESSAGE);

    held.close();
  });

  it("is nothing to do without IndexedDB", async () => {
    vi.stubGlobal("indexedDB", undefined);

    await expect(deleteCache()).resolves.toBeUndefined();
  });
});

describe("without IndexedDB", () => {
  it("rejects rather than throws", async () => {
    vi.stubGlobal("indexedDB", undefined);

    await expect(listFiles()).rejects.toThrow("This browser has no IndexedDB");
    await expect(putFiles([file("a.kml", 1)])).rejects.toThrow("IndexedDB");
  });

  it("opens again after a failed open", async () => {
    vi.stubGlobal("indexedDB", undefined);
    await expect(listFiles()).rejects.toThrow();

    vi.stubGlobal("indexedDB", new IDBFactory());
    await expect(listFiles()).resolves.toEqual([]);
  });
});

describe("requestPersistence", () => {
  it("is false where the browser has no such request", async () => {
    vi.stubGlobal("navigator", {});
    await expect(requestPersistence()).resolves.toBe(false);

    vi.stubGlobal("navigator", { storage: {} });
    await expect(requestPersistence()).resolves.toBe(false);
  });

  it("is what the browser answers", async () => {
    vi.stubGlobal("navigator", {
      storage: { persist: vi.fn(() => Promise.resolve(true)) },
    });
    await expect(requestPersistence()).resolves.toBe(true);
  });

  it("is false when the browser refuses the question", async () => {
    vi.stubGlobal("navigator", {
      storage: {
        persist: vi.fn(() => Promise.reject(new Error("not allowed"))),
      },
    });
    await expect(requestPersistence()).resolves.toBe(false);
  });
});
