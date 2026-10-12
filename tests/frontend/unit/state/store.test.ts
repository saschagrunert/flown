import { describe, it, expect, vi } from "vitest";
import {
  AppStore,
  STORE_ACCESSOR_KEYS,
  createDefaultState,
  defineStoreAccessors,
} from "../../../../flown/frontend/state/store";
import { TOGGLES } from "../../../../flown/frontend/state/toggles";

describe("createDefaultState", () => {
  it("returns expected defaults", () => {
    const state = createDefaultState();
    expect(state.selectedYear).toBe("all");
    expect(state.selectedAircraft).toBe("all");
    expect(state.selectedPathIds).toEqual(new Set());
    expect(state.heatmapVisible).toBe(true);
    expect(state.altitudeVisible).toBe(false);
    expect(state.currentData).toBeNull();
    expect(state.hasTimingData).toBe(false);
  });

  it("returns a fresh object each call", () => {
    const a = createDefaultState();
    const b = createDefaultState();
    expect(a).not.toBe(b);
    expect(a.selectedPathIds).not.toBe(b.selectedPathIds);
  });
});

describe("AppStore", () => {
  describe("get/set", () => {
    it("returns default values", () => {
      const store = new AppStore();
      expect(store.get("selectedYear")).toBe("all");
      expect(store.get("heatmapVisible")).toBe(true);
    });

    it("accepts initial overrides", () => {
      const store = new AppStore({
        selectedYear: "2024",
        heatmapVisible: false,
      });
      expect(store.get("selectedYear")).toBe("2024");
      expect(store.get("heatmapVisible")).toBe(false);
    });

    it("sets and retrieves values", () => {
      const store = new AppStore();
      store.set("selectedYear", "2025");
      expect(store.get("selectedYear")).toBe("2025");
    });
  });

  describe("equality short-circuit", () => {
    it("skips notification when value is identical", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      store.set("selectedYear", "all");
      expect(fn).not.toHaveBeenCalled();
    });

    it("notifies when value changes", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      store.set("selectedYear", "2025");
      expect(fn).toHaveBeenCalledWith("2025", "all");
    });
  });

  describe("subscribe/unsubscribe", () => {
    it("calls listener on change", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("heatmapVisible", fn);
      store.set("heatmapVisible", false);
      expect(fn).toHaveBeenCalledWith(false, true);
    });

    it("supports multiple listeners", () => {
      const store = new AppStore();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      store.subscribe("selectedYear", fn1);
      store.subscribe("selectedYear", fn2);
      store.set("selectedYear", "2024");
      expect(fn1).toHaveBeenCalledOnce();
      expect(fn2).toHaveBeenCalledOnce();
    });

    it("unsubscribes correctly", () => {
      const store = new AppStore();
      const fn = vi.fn();
      const unsub = store.subscribe("selectedYear", fn);
      unsub();
      store.set("selectedYear", "2025");
      expect(fn).not.toHaveBeenCalled();
    });

    it("unsubscribes once the signal it was given aborts", () => {
      const store = new AppStore();
      const fn = vi.fn();
      const keys = vi.fn();
      const owner = new AbortController();
      store.subscribe("selectedYear", fn, { signal: owner.signal });
      store.subscribeKeys(["selectedYear", "heatmapVisible"], keys, {
        signal: owner.signal,
      });

      store.set("selectedYear", "2025");
      owner.abort();
      store.set("selectedYear", "2024");
      store.set("heatmapVisible", false);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(keys).toHaveBeenCalledTimes(1);
    });

    it("drops the abort listener once it is unsubscribed", () => {
      // A signal as long-lived as the app must not keep every callback
      const store = new AppStore();
      const owner = new AbortController();
      const added = vi.spyOn(owner.signal, "addEventListener");
      const removed = vi.spyOn(owner.signal, "removeEventListener");
      const fn = vi.fn();
      const keys = vi.fn();

      store.subscribe("selectedYear", fn, { signal: owner.signal })();
      store.subscribeKeys(["selectedYear", "heatmapVisible"], keys, {
        signal: owner.signal,
      })();

      expect(added).toHaveBeenCalledTimes(3);
      expect(removed).toHaveBeenCalledTimes(3);
      for (const [type, listener] of added.mock.calls) {
        expect(removed).toHaveBeenCalledWith(type, listener);
      }
      owner.abort();
      store.set("selectedYear", "2025");
      store.set("heatmapVisible", false);
      expect(fn).not.toHaveBeenCalled();
      expect(keys).not.toHaveBeenCalled();
    });

    it("an unsubscribe after the abort does no harm", () => {
      const store = new AppStore();
      const owner = new AbortController();
      const fn = vi.fn();
      const other = vi.fn();
      const unsubscribe = store.subscribe("selectedYear", fn, {
        signal: owner.signal,
      });
      store.subscribe("selectedYear", other);

      owner.abort();
      unsubscribe();
      store.set("selectedYear", "2025");

      expect(fn).not.toHaveBeenCalled();
      expect(other).toHaveBeenCalledTimes(1);
    });

    it("subscribes nothing with a signal that has aborted already", () => {
      const store = new AppStore();
      const fn = vi.fn();
      const gone = AbortSignal.abort();
      const unsubscribe = store.subscribe("selectedYear", fn, {
        signal: gone,
      });
      store.subscribeKeys(["selectedYear"], fn, { signal: gone });

      store.set("selectedYear", "2025");

      expect(fn).not.toHaveBeenCalled();
      // Its unsubscribe does no harm
      expect(unsubscribe).not.toThrow();
    });

    it("does not affect other listeners on unsubscribe", () => {
      const store = new AppStore();
      const fn1 = vi.fn();
      const fn2 = vi.fn();
      const unsub1 = store.subscribe("selectedYear", fn1);
      store.subscribe("selectedYear", fn2);
      unsub1();
      store.set("selectedYear", "2025");
      expect(fn1).not.toHaveBeenCalled();
      expect(fn2).toHaveBeenCalledOnce();
    });
  });

  describe("a new selection", () => {
    it("is heard of with the selection of before", () => {
      const store = new AppStore();
      const before = store.get("selectedPathIds");
      const fn = vi.fn();
      store.subscribe("selectedPathIds", fn);
      store.set("selectedPathIds", new Set([42]));
      expect(fn).toHaveBeenCalledOnce();
      const [ids, old] = fn.mock.calls[0] as [Set<number>, Set<number>];
      expect(ids.has(42)).toBe(true);
      expect(old).toBe(before);
      expect(old.size).toBe(0);
    });
  });

  describe("batch", () => {
    it("defers notifications until batch completes", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      store.batch(() => {
        store.set("selectedYear", "2024");
        expect(fn).not.toHaveBeenCalled();
      });
      expect(fn).toHaveBeenCalledOnce();
    });

    it("preserves correct old values across batch", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("selectedYear", "2025");
      });
      expect(fn).toHaveBeenCalledWith("2025", "all");
    });

    it("batches multiple keys", () => {
      const store = new AppStore();
      const yearFn = vi.fn();
      const visFn = vi.fn();
      store.subscribe("selectedYear", yearFn);
      store.subscribe("heatmapVisible", visFn);
      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("heatmapVisible", false);
      });
      expect(yearFn).toHaveBeenCalledWith("2024", "all");
      expect(visFn).toHaveBeenCalledWith(false, true);
    });

    it("flushes even if batch function throws", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      expect(() => {
        store.batch(() => {
          store.set("selectedYear", "2024");
          throw new Error("test");
        });
      }).toThrow("test");
      expect(fn).toHaveBeenCalledWith("2024", "all");
    });

    it("skips notification when value reverted within batch", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("selectedYear", "all");
      });
      expect(fn).not.toHaveBeenCalled();
    });

    it("supports nested batch calls", () => {
      const store = new AppStore();
      const yearFn = vi.fn();
      const visFn = vi.fn();
      store.subscribe("selectedYear", yearFn);
      store.subscribe("heatmapVisible", visFn);
      store.batch(() => {
        store.set("selectedYear", "2024");
        store.batch(() => {
          store.set("heatmapVisible", false);
          expect(yearFn).not.toHaveBeenCalled();
          expect(visFn).not.toHaveBeenCalled();
        });
        // Inner batch exits but outer is still open
        expect(yearFn).not.toHaveBeenCalled();
        expect(visFn).not.toHaveBeenCalled();
      });
      // Outer batch exits, now both fire
      expect(yearFn).toHaveBeenCalledWith("2024", "all");
      expect(visFn).toHaveBeenCalledWith(false, true);
    });
  });

  describe("reentrancy", () => {
    it("defers set() called during notification", () => {
      const store = new AppStore();
      const yearFn = vi.fn();
      const aircraftFn = vi.fn();
      store.subscribe("selectedYear", () => {
        store.set("selectedAircraft", "D-EXYZ");
      });
      store.subscribe("selectedYear", yearFn);
      store.subscribe("selectedAircraft", aircraftFn);

      store.set("selectedYear", "2024");
      expect(yearFn).toHaveBeenCalledOnce();
      expect(aircraftFn).toHaveBeenCalledOnce();
      expect(store.get("selectedAircraft")).toBe("D-EXYZ");
    });

    it("does not stack overflow on mutual listeners", () => {
      const store = new AppStore();
      let yearCount = 0;
      let aircraftCount = 0;

      store.subscribe("selectedYear", () => {
        yearCount++;
        if (yearCount <= 2) {
          store.set("selectedAircraft", `aircraft-${yearCount}`);
        }
      });
      store.subscribe("selectedAircraft", () => {
        aircraftCount++;
        if (aircraftCount <= 2) {
          store.set("selectedYear", `year-${aircraftCount}`);
        }
      });

      expect(() => store.set("selectedYear", "2024")).not.toThrow();
    });

    it("stays quiet for an object set and set back within a batch", () => {
      const original = new Set([1]);
      const store = new AppStore({ selectedPathIds: original });
      const fn = vi.fn();
      store.subscribe("selectedPathIds", fn);

      store.batch(() => {
        store.set("selectedPathIds", new Set([2]));
        store.set("selectedPathIds", original);
      });

      expect(fn).not.toHaveBeenCalled();
    });

    it("drops every listener on unsubscribeAll", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedYear", fn);
      store.subscribeKeys(["heatmapVisible", "altitudeVisible"], fn);

      store.unsubscribeAll();
      store.set("selectedYear", "2024");
      store.set("heatmapVisible", false);

      expect(fn).not.toHaveBeenCalled();
    });

    it("defers a new selection during batch", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("selectedPathIds", fn);

      store.batch(() => {
        store.set("selectedPathIds", new Set([1]));
        expect(fn).not.toHaveBeenCalled();
      });
      expect(fn).toHaveBeenCalledOnce();
    });

    it("defers a new selection during notification", () => {
      const store = new AppStore();
      const pathFn = vi.fn();
      store.subscribe("selectedYear", () => {
        store.set("selectedPathIds", new Set([99]));
      });
      store.subscribe("selectedPathIds", pathFn);

      store.set("selectedYear", "2024");
      expect(pathFn).toHaveBeenCalledOnce();
    });

    it("notifies a key re-set by a listener once, against its pre-batch value", () => {
      const store = new AppStore({ selectedAircraft: "D-ABCD" });
      const aircraftFn = vi.fn();
      store.subscribe("selectedYear", () => {
        store.set("selectedAircraft", "D-XXXX");
      });
      store.subscribe("selectedAircraft", aircraftFn);

      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("selectedAircraft", "D-EFGH");
      });

      // Nobody sees the intermediate D-EFGH: one notification, from the
      // value before the batch to the value the listener settled on
      expect(aircraftFn).toHaveBeenCalledOnce();
      expect(aircraftFn).toHaveBeenCalledWith("D-XXXX", "D-ABCD");
    });

    it("notifies a delivered key again when a later listener changes it", () => {
      const store = new AppStore();
      const aircraftFn = vi.fn();
      store.subscribe("selectedAircraft", aircraftFn);
      store.subscribe("selectedYear", () => {
        store.set("selectedAircraft", "D-XXXX");
      });

      store.batch(() => {
        store.set("selectedAircraft", "D-EFGH");
        store.set("selectedYear", "2024");
      });

      expect(aircraftFn.mock.calls).toEqual([
        ["D-EFGH", "all"],
        ["D-XXXX", "D-EFGH"],
      ]);
    });

    it("gives up on listeners that keep changing each other's keys", () => {
      const store = new AppStore();
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      let rounds = 0;
      store.subscribe("selectedYear", (year) => {
        rounds++;
        store.set("selectedAircraft", `aircraft-${year}`);
      });
      store.subscribe("selectedAircraft", (aircraft) => {
        store.set("selectedYear", `year-${aircraft}`);
      });

      expect(() => store.set("selectedYear", "2024")).not.toThrow();

      expect(rounds).toBeLessThan(20);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("Store flush exceeded"),
      );
      // The state moved on, the last change is still pending
      expect(store.get("selectedYear")).toMatch(/^year-/);
      consoleSpy.mockRestore();
    });

    it("listener calling batch() during notification works", () => {
      const store = new AppStore();
      const aircraftFn = vi.fn();
      store.subscribe("selectedYear", () => {
        store.batch(() => {
          store.set("selectedAircraft", "D-EXYZ");
        });
      });
      store.subscribe("selectedAircraft", aircraftFn);

      store.set("selectedYear", "2024");
      expect(aircraftFn).toHaveBeenCalledWith("D-EXYZ", "all");
    });
  });

  describe("subscribeKeys", () => {
    it("runs again when a listener changes one of its keys after it ran", () => {
      const store = new AppStore();
      const seen: string[] = [];
      store.subscribeKeys(["selectedYear", "selectedAircraft"], () => {
        seen.push(store.get("selectedAircraft"));
      });
      store.subscribe("selectedYear", () => {
        store.set("selectedAircraft", "D-XXXX");
      });

      store.batch(() => {
        store.set("selectedAircraft", "D-EFGH");
        store.set("selectedYear", "2024");
      });

      // Once for the batch, once for the change the year listener made
      expect(seen).toEqual(["D-EFGH", "D-XXXX"]);
    });

    it("runs once for a batch that changes several of its keys", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribeKeys(["selectedYear", "selectedAircraft"], fn);

      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("selectedAircraft", "D-EXYZ");
      });

      expect(fn).toHaveBeenCalledOnce();
    });

    it("runs for each separate change and ignores other keys", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribeKeys(["selectedYear", "selectedAircraft"], fn);

      store.set("selectedYear", "2024");
      store.set("selectedAircraft", "D-EXYZ");
      store.set("heatmapVisible", false);

      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("sees the final state of the whole batch", () => {
      const store = new AppStore();
      const seen: string[] = [];
      store.subscribeKeys(["selectedYear", "selectedAircraft"], () => {
        seen.push(
          store.get("selectedYear") + "/" + store.get("selectedAircraft"),
        );
      });

      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("selectedAircraft", "D-EXYZ");
      });

      expect(seen).toEqual(["2024/D-EXYZ"]);
    });

    it("runs again for a key another listener changes after it ran", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribeKeys(["selectedYear", "selectedAircraft"], () => {
        fn(store.get("selectedAircraft"));
      });
      store.subscribe("selectedYear", () => {
        store.set("selectedAircraft", "D-EXYZ");
      });

      store.batch(() => {
        store.set("selectedYear", "2024");
      });

      expect(fn.mock.calls).toEqual([["all"], ["D-EXYZ"]]);
    });

    it("unsubscribes from every key", () => {
      const store = new AppStore();
      const fn = vi.fn();
      const unsubscribe = store.subscribeKeys(
        ["selectedYear", "selectedAircraft"],
        fn,
      );

      unsubscribe();
      store.set("selectedYear", "2024");
      store.set("selectedAircraft", "D-EXYZ");

      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe("listener safety", () => {
    it("keeps notifying after a listener throws", () => {
      const store = new AppStore();
      const error = new Error("broken listener");
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const after = vi.fn();
      const otherKey = vi.fn();
      store.subscribe("selectedYear", () => {
        throw error;
      });
      store.subscribe("selectedYear", after);
      store.subscribe("heatmapVisible", otherKey);

      store.batch(() => {
        store.set("selectedYear", "2024");
        store.set("heatmapVisible", false);
      });

      // The rest of the listeners and the rest of the flush still ran
      expect(after).toHaveBeenCalledOnce();
      expect(otherKey).toHaveBeenCalledOnce();
      expect(consoleSpy).toHaveBeenCalledWith(
        "Store listener for selectedYear failed:",
        error,
      );
      consoleSpy.mockRestore();
    });

    it("handles unsubscribe during notification", () => {
      const store = new AppStore();
      const calls: string[] = [];
      const unsub = { fn: () => {} };

      unsub.fn = store.subscribe("selectedYear", () => {
        calls.push("first");
        unsub.fn();
      });
      store.subscribe("selectedYear", () => {
        calls.push("second");
      });

      store.set("selectedYear", "2025");
      expect(calls).toEqual(["first", "second"]);
    });

    it("subscribes to nullable object key", () => {
      const store = new AppStore();
      const fn = vi.fn();
      store.subscribe("currentData", fn);

      const data = {
        path_segments: [],
        path_info: [],
        resolution: "full",
        original_points: 0,
      };
      store.set("currentData", data);
      expect(fn).toHaveBeenCalledWith(data, null);

      store.set("currentData", null);
      expect(fn).toHaveBeenCalledWith(null, data);
    });
  });

  describe("defineStoreAccessors", () => {
    it("forwards every accessor key to the store", () => {
      const store = new AppStore();
      const holder = { store } as { store: AppStore } & Record<string, unknown>;

      defineStoreAccessors(holder);

      for (const key of STORE_ACCESSOR_KEYS) {
        expect(holder[key]).toBe(store.get(key));
      }
      holder["selectedYear"] = "2025";
      expect(store.get("selectedYear")).toBe("2025");
      store.set("heatmapVisible", false);
      expect(holder["heatmapVisible"]).toBe(false);
    });

    it("notifies subscribers through the accessor", () => {
      const store = new AppStore();
      const holder = { store } as { store: AppStore } & Record<string, unknown>;
      defineStoreAccessors(holder);
      const fn = vi.fn();
      store.subscribe("selectedAircraft", fn);

      holder["selectedAircraft"] = "D-EAGJ";

      expect(fn).toHaveBeenCalledWith("D-EAGJ", "all");
    });

    it("covers every key of the default state, the panels included", () => {
      expect([...STORE_ACCESSOR_KEYS].sort()).toEqual(
        Object.keys(createDefaultState()).sort(),
      );
    });

    it("starts every toggle as its entry in the table says", () => {
      const state = createDefaultState();
      for (const toggle of TOGGLES) {
        expect(state[toggle.key], toggle.key).toBe(toggle.initial);
      }
    });
  });

  describe("share mode and the selection", () => {
    /** Each listener's view of both keys as it is told of a change */
    function watch(store: AppStore): [string, number, boolean][] {
      const seen: [string, number, boolean][] = [];
      for (const key of ["isolateSelection", "selectedPathIds"] as const) {
        store.subscribe(key, () => {
          seen.push([
            key,
            store.get("selectedPathIds").size,
            store.get("isolateSelection"),
          ]);
        });
      }
      return seen;
    }

    it("ends share mode with the last flight before any listener hears of either", () => {
      const store = new AppStore({
        selectedPathIds: new Set([1]),
        isolateSelection: true,
      });
      const seen = watch(store);

      store.set("selectedPathIds", new Set());

      expect(store.get("isolateSelection")).toBe(false);
      // Never an empty selection still shared
      expect(seen).toEqual([
        ["isolateSelection", 0, false],
        ["selectedPathIds", 0, false],
      ]);
    });

    it("keeps that in a batch whose keys come in any order", () => {
      const store = new AppStore({
        selectedPathIds: new Set([1]),
        isolateSelection: false,
      });
      const seen = watch(store);

      store.batch(() => {
        // Share mode first, then the flight it shared goes
        store.set("isolateSelection", true);
        store.set("selectedPathIds", new Set());
      });

      expect(seen).toEqual([["selectedPathIds", 0, false]]);
    });

    it("keeps share mode while a flight is left, and has no word for a mode already off", () => {
      const store = new AppStore({
        selectedPathIds: new Set([1, 2]),
        isolateSelection: true,
      });
      const seen = watch(store);

      store.set("selectedPathIds", new Set([2]));
      expect(store.get("isolateSelection")).toBe(true);

      store.set("isolateSelection", false);
      store.set("selectedPathIds", new Set());
      expect(seen).toEqual([
        ["selectedPathIds", 1, true],
        ["isolateSelection", 1, false],
        ["selectedPathIds", 0, false],
      ]);
    });
  });
});
