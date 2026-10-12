import { describe, it, expect, vi } from "vitest";
import { AppStore } from "../../../../flown/frontend/state/store";
import {
  PATH_RIBBON_SOURCES,
  RIBBON_SOURCES,
  ReliefState,
} from "../../../../flown/frontend/ui/reliefState";
import {
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../flown/frontend/utils/constants";

describe("ReliefState", () => {
  /** The store's relief switches, in the order they were written */
  function recorded(store: AppStore): string[] {
    const writes: string[] = [];
    store.subscribe("terrainActive", (active) =>
      writes.push(`terrainActive=${active}`),
    );
    store.subscribe("reliefLevel", (level) =>
      writes.push(`reliefLevel=${level}`),
    );
    return writes;
  }

  it("begins a new visit with every level, and none for the same one", () => {
    const store = new AppStore();
    const relief = new ReliefState(store);

    relief.moveTo(8, true);
    expect(relief.epoch).toBe(1);
    relief.moveTo(8, false);
    relief.moveTo(8);
    expect(relief.epoch).toBe(1);
    relief.moveTo(9);
    relief.moveTo(8);
    expect(relief.epoch).toBe(3);
  });

  it("takes the relief away before the level changes, and puts it back after", () => {
    const store = new AppStore();
    const relief = new ReliefState(store);
    relief.moveTo(8, true);
    const writes = recorded(store);

    relief.moveTo(9, false);
    relief.moveTo(10, true);

    expect(writes).toEqual([
      "terrainActive=false",
      "reliefLevel=9",
      "reliefLevel=10",
      "terrainActive=true",
    ]);
  });

  it("keeps the relief as it is unless told otherwise", () => {
    const store = new AppStore();
    const relief = new ReliefState(store);
    relief.moveTo(8, true);

    relief.moveTo(9);

    expect(store.get("terrainActive")).toBe(true);
    expect(store.get("reliefLevel")).toBe(9);
  });

  it("shades the relief through the store", () => {
    const store = new AppStore();
    const relief = new ReliefState(store);

    relief.shade(true);
    expect(store.get("reliefShaded")).toBe(true);
    relief.shade(false);
    expect(store.get("reliefShaded")).toBe(false);
  });

  it("tells its followers of every hide and show, until they stop", () => {
    const relief = new ReliefState(new AppStore());
    const restyle = vi.fn(() => relief.ribbonsShown);
    const stop = relief.onRibbonsShown(restyle);
    expect(relief.ribbonsShown).toBe(1);

    relief.showRibbons(false);
    relief.showRibbons(false);
    relief.showRibbons(true);
    stop();
    relief.showRibbons(false);

    expect(restyle.mock.results.map(({ value }) => value as number)).toEqual([
      0, 0, 1,
    ]);
    expect(relief.ribbonsShown).toBe(0);
  });

  it("names every source of ribbons once, the trail's last, each its layer's id", () => {
    expect(new Set(RIBBON_SOURCES).size).toBe(RIBBON_SOURCES.length);
    expect(RIBBON_SOURCES).toEqual([
      ...PATH_RIBBON_SOURCES,
      MAP_SOURCES.selectionHighlightRibbons,
      MAP_SOURCES.replayTrailRibbons,
    ]);
    expect(Object.values(MAP_LAYERS)).toEqual(
      expect.arrayContaining([...RIBBON_SOURCES]),
    );
    expect(
      Object.entries(MAP_SOURCES)
        .filter(([key]) => key.endsWith("Ribbons"))
        .map(([, id]) => id)
        .sort(),
    ).toEqual([...RIBBON_SOURCES].sort());
  });
});
