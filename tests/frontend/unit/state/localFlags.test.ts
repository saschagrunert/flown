/**
 * The flags the app and the bundle of Your flights share
 * (state/localFlags.ts): the names keyed to the page's directory, so two
 * maps of one origin keep apart, and the ask to reopen the panel across
 * the reload that switches the flights, read, taken once, and answered
 * with no when the session storage is not to be had.
 */
import { describe, it, expect, vi } from "vitest";
import {
  askReopen,
  flightsKey,
  keyedToPage,
  LOCAL_DB_NAME,
  localCacheDbName,
  LOCAL_FLIGHTS_KEY,
  LOCAL_STATE_KEY,
  REOPEN_KEY,
  takeReopen,
  wantsReopen,
} from "../../../../flown/frontend/state/localFlags";
import { storageKey } from "../../../../flown/frontend/ui/stateManager";

describe("keyedToPage", () => {
  it("is the bare name for a map at the root of its origin", () => {
    expect(keyedToPage("flown-x", "/")).toBe("flown-x");
    expect(keyedToPage("flown-x", "/index.html")).toBe("flown-x");
  });

  it("carries the page's directory otherwise, the page and its folder alike", () => {
    expect(keyedToPage("flown-x", "/a/")).toBe("flown-x:/a/");
    expect(keyedToPage("flown-x", "/a/index.html")).toBe("flown-x:/a/");
    expect(keyedToPage("flown-x", "/b/")).not.toBe(
      keyedToPage("flown-x", "/a/"),
    );
  });

  it("keeps the visitor's flights apart, under :local", () => {
    expect(flightsKey("flown-x", false, "/a/")).toBe("flown-x:/a/");
    expect(flightsKey("flown-x", true, "/a/")).toBe("flown-x:local:/a/");
    // The key Remove all lets go of is the one the state is saved under
    expect(LOCAL_STATE_KEY).toBe(storageKey(location.pathname, true));
  });

  it("names the flags and the database for this page, at the root here", () => {
    expect(LOCAL_FLIGHTS_KEY).toBe("flown-local-flights");
    expect(REOPEN_KEY).toBe("flown-local-reopen");
    expect(LOCAL_DB_NAME).toBe("flown-local");
  });

  it("names the worker's cache as one path, its directory encoded", () => {
    expect(localCacheDbName("/")).toBe("/flown-cache");
    expect(localCacheDbName()).toBe("/flown-cache");
    // One name with no slash past the first: the mount point names the
    // database, and a directory in it would be a directory in the worker
    expect(localCacheDbName("/a/index.html")).toBe("/flown-cache%3A%2Fa%2F");
    expect(localCacheDbName("/a/")).not.toBe(localCacheDbName("/b/"));
  });
});

describe("the reopen ask", () => {
  it("is not there until asked for", () => {
    expect(wantsReopen()).toBe(false);
    expect(takeReopen()).toBe(false);
  });

  it("is there once asked for, and taken once", () => {
    askReopen();

    expect(sessionStorage.getItem(REOPEN_KEY)).toBe("1");
    expect(wantsReopen()).toBe(true);
    // Reading does not take it
    expect(wantsReopen()).toBe(true);
    expect(takeReopen()).toBe(true);
    expect(sessionStorage.getItem(REOPEN_KEY)).toBeNull();
    expect(takeReopen()).toBe(false);
  });

  it("is no when the storage refuses", () => {
    const refusing = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      removeItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };
    vi.stubGlobal("sessionStorage", refusing);

    expect(() => askReopen()).not.toThrow();
    expect(wantsReopen()).toBe(false);
    expect(takeReopen()).toBe(false);
  });

  it("does not throw when the ask cannot be taken away", () => {
    askReopen();
    const stuck = {
      getItem: vi.fn(() => "1"),
      removeItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };
    vi.stubGlobal("sessionStorage", stuck);

    expect(takeReopen()).toBe(true);
    expect(stuck.removeItem).toHaveBeenCalledWith(REOPEN_KEY);
  });
});
