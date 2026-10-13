/**
 * The still of the map an export captures in place of its WebGL canvas
 * (withMapStill in ui/mapExport.ts), and what it tells the rest of the
 * page while it does (isMapStill in utils/mapHelpers.ts)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  MAP_STILL_TIMEOUT_MS,
  withMapStill,
} from "../../../../flown/frontend/ui/mapExport";
import { isMapStill } from "../../../../flown/frontend/utils/mapHelpers";
import { Map as MockMap, resetMapLibreMock } from "../../../mocks/maplibre-gl";
import { setDevicePixelRatio } from "../../testHelpers";

vi.mock("../../../../flown/frontend/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

/** A mock map, typed the way the helpers take it */
function mapStub(options: Record<string, unknown> = {}): MapLibreMap & MockMap {
  const container = document.createElement("div");
  document.body.append(container);
  return new MockMap({
    container,
    style: "style.json",
    ...options,
  }) as MapLibreMap & MockMap;
}

afterEach(() => {
  vi.useRealTimers();
  resetMapLibreMock();
  document.body.innerHTML = "";
});

describe("withMapStill", () => {
  beforeEach(() => {
    vi.useRealTimers();
    // jsdom does not implement it
    HTMLImageElement.prototype.decode = vi.fn(() => Promise.resolve());
  });

  afterEach(() => {
    // The workers share one jsdom, so the prototype is put back
    delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
  });

  function stillMap(): MapLibreMap & MockMap {
    const map = mapStub();
    vi.spyOn(map.getCanvas(), "toDataURL").mockReturnValue(
      "data:image/png;base64,AAAA",
    );
    return map;
  }

  it("shows a still of the rendered frame while the callback runs", async () => {
    const map = stillMap();
    const canvas = map.getCanvas();
    const parent = canvas.parentElement!;

    const result = await withMapStill(map, () => {
      const still = parent.querySelector("img")!;
      expect(parent.contains(canvas)).toBe(false);
      expect(still.src).toBe("data:image/png;base64,AAAA");
      expect(still.className).toBe(canvas.className);
      return "done";
    });

    expect(result).toBe("done");
    expect(map.triggerRepaint).toHaveBeenCalledOnce();
    expect(canvas.toDataURL).toHaveBeenCalledWith("image/png");
    expect(parent.contains(canvas)).toBe(true);
    expect(parent.querySelector("img")).toBeNull();
  });

  it("tells what moves on the map by itself to hold still, from the frame it takes until the canvas is back", async () => {
    const map = stillMap();
    const repaint = map.triggerRepaint.getMockImplementation();
    const inFrame: boolean[] = [];
    map.triggerRepaint.mockImplementation(() => {
      inFrame.push(isMapStill(map));
      repaint?.();
    });
    expect(isMapStill(map)).toBe(false);

    await withMapStill(map, () => {
      expect(isMapStill(map)).toBe(true);
      // Another map is not held
      expect(isMapStill(mapStub())).toBe(false);
    });

    expect(inFrame).toEqual([true]);
    expect(isMapStill(map)).toBe(false);
    await expect(
      withMapStill(map, () => Promise.reject(new Error("capture failed"))),
    ).rejects.toThrow("capture failed");
    expect(isMapStill(map)).toBe(false);
  });

  it("reads the canvas inside the render event, not before", async () => {
    const map = stillMap();
    const canvas = map.getCanvas();
    map.triggerRepaint.mockImplementation(() => {
      expect(canvas.toDataURL).not.toHaveBeenCalled();
      queueMicrotask(() => map.emit("render"));
    });

    await withMapStill(map, () => undefined);

    expect(canvas.toDataURL).toHaveBeenCalledOnce();
  });

  it("puts the canvas back when the callback fails", async () => {
    const map = stillMap();
    const canvas = map.getCanvas();
    const parent = canvas.parentElement!;

    await expect(
      withMapStill(map, () => Promise.reject(new Error("capture failed"))),
    ).rejects.toThrow("capture failed");

    expect(parent.contains(canvas)).toBe(true);
    expect(parent.querySelector("img")).toBeNull();
  });

  it("rejects when the canvas cannot be read, and leaves the map as it was", async () => {
    const map = stillMap();
    const canvas = map.getCanvas();
    const parent = canvas.parentElement!;
    vi.mocked(canvas.toDataURL).mockImplementation(() => {
      throw new Error("tainted canvas");
    });
    const fn = vi.fn();

    await expect(withMapStill(map, fn)).rejects.toThrow("tainted canvas");

    expect(fn).not.toHaveBeenCalled();
    expect(parent.contains(canvas)).toBe(true);
    expect(map.listenerCount("render")).toBe(0);
  });

  it("rejects when the map draws no frame in time, as after a lost context", async () => {
    vi.useFakeTimers();
    const map = stillMap();
    const canvas = map.getCanvas();
    const parent = canvas.parentElement!;
    map.triggerRepaint.mockImplementation(() => undefined);
    const fn = vi.fn();

    const pending = withMapStill(map, fn);
    const settled = expect(pending).rejects.toThrow(
      "the map did not draw in time",
    );
    await vi.advanceTimersByTimeAsync(MAP_STILL_TIMEOUT_MS);
    await settled;

    expect(fn).not.toHaveBeenCalled();
    expect(parent.contains(canvas)).toBe(true);
    // A frame that comes late after all finds nobody waiting
    expect(map.listenerCount("render")).toBe(0);
    vi.useRealTimers();
  });

  it("stops the clock once the frame is there", async () => {
    vi.useFakeTimers();
    const map = stillMap();

    await withMapStill(map, () => undefined);

    expect(vi.getTimerCount()).toBe(0);
    expect(map.listenerCount("render")).toBe(0);
    vi.useRealTimers();
  });

  it("carries on with an image that does not decode", async () => {
    HTMLImageElement.prototype.decode = vi.fn(() =>
      Promise.reject(new Error("decode")),
    );
    const map = stillMap();
    const fn = vi.fn();

    await withMapStill(map, fn);

    expect(fn).toHaveBeenCalledOnce();
  });

  describe("at a pixel ratio", () => {
    afterEach(() => setDevicePixelRatio(1));

    it("draws the still at the ratio asked for and hands the map back to the screen's", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      const steps: string[] = [];
      map.setPixelRatio.mockImplementation((ratio: number | null) => {
        steps.push(`ratio ${String(ratio)}`);
      });
      vi.mocked(canvas.toDataURL).mockImplementation(() => {
        steps.push("frame read");
        return "data:image/png;base64,AAAA";
      });
      await withMapStill(
        map,
        () => {
          steps.push(
            canvas.parentElement ? "capture of canvas" : "capture of still",
          );
        },
        2,
      );
      steps.push(canvas.parentElement ? "canvas back" : "canvas gone");

      // Null, not 1: the map follows the screen again instead of being
      // pinned to the ratio the screen had during the export
      expect(steps).toEqual([
        "ratio 2",
        "frame read",
        "capture of still",
        "ratio null",
        "canvas back",
      ]);
    });

    it("puts the canvas back even when the ratio cannot be restored", async () => {
      // A map removed during the capture throws on the resize behind
      // setPixelRatio; the page must not be left showing a still
      const map = stillMap();
      const canvas = map.getCanvas();
      const parent = canvas.parentElement!;
      map.setPixelRatio.mockImplementation((ratio: number | null) => {
        if (ratio === null) throw new TypeError("the map is gone");
      });

      await expect(withMapStill(map, () => undefined, 2)).rejects.toThrow(
        "the map is gone",
      );

      expect(parent.contains(canvas)).toBe(true);
      expect(parent.querySelector("img")).toBeNull();
    });

    it("hands the map back to the screen although the screen changed meanwhile", async () => {
      // A browser zoom or another monitor during the capture: asked at the
      // end, the map would look like one with a ratio of its own and be
      // pinned to the old one
      const map = stillMap();
      const restored: (number | null)[] = [];
      map.setPixelRatio.mockImplementation((ratio: number | null) => {
        restored.push(ratio);
      });

      await withMapStill(map, () => setDevicePixelRatio(1.25), 2);

      expect(restored).toEqual([2, null]);
    });

    it("leaves a canvas alone that is already as large as it can get", async () => {
      // MapLibre holds the canvas below the ratio it was asked for once it
      // hits its size limit; raising the ratio would cost two resizes, and
      // their move events, to take the same still
      const map = stillMap();
      const canvas = map.getCanvas();
      Object.defineProperty(canvas, "clientWidth", {
        value: 5000,
        configurable: true,
      });
      canvas.width = 4096;

      await withMapStill(map, () => undefined, 2);

      expect(map.setPixelRatio).not.toHaveBeenCalled();
    });

    it("puts the canvas back only after the ratio is restored", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      const attached: boolean[] = [];
      map.setPixelRatio.mockImplementation(() => {
        attached.push(canvas.parentElement !== null);
      });

      await withMapStill(map, () => undefined, 2);

      // Raised on the canvas in the page, lowered behind the still
      expect(attached).toEqual([true, false]);
    });

    it("restores a ratio the map was given, as the number it was", async () => {
      const map = stillMap();
      map.setPixelRatio(1.5);
      map.setPixelRatio.mockClear();

      await withMapStill(map, () => undefined, 2);

      expect(map.setPixelRatio.mock.calls).toEqual([[2], [1.5]]);
      expect(map.getPixelRatio()).toBe(1.5);
    });

    it.each([
      ["denser than", 3],
      ["as dense as", 2],
    ])(
      "leaves the ratio alone on a screen %s the export",
      async (_name, screen) => {
        setDevicePixelRatio(screen);
        const map = stillMap();
        const fn = vi.fn();

        await withMapStill(map, fn, 2);

        expect(fn).toHaveBeenCalledOnce();
        expect(map.setPixelRatio).not.toHaveBeenCalled();
      },
    );

    it("leaves the ratio alone when none is asked for", async () => {
      const map = stillMap();

      await withMapStill(map, () => undefined);

      expect(map.setPixelRatio).not.toHaveBeenCalled();
    });

    it("restores the ratio when the callback fails", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      const parent = canvas.parentElement!;

      await expect(
        withMapStill(map, () => Promise.reject(new Error("capture failed")), 2),
      ).rejects.toThrow("capture failed");

      expect(map.setPixelRatio.mock.calls).toEqual([[2], [null]]);
      expect(parent.contains(canvas)).toBe(true);
      expect(parent.querySelector("img")).toBeNull();
    });

    it("restores the ratio when the canvas cannot be read", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      vi.mocked(canvas.toDataURL).mockImplementation(() => {
        throw new Error("tainted canvas");
      });

      await expect(withMapStill(map, vi.fn(), 2)).rejects.toThrow(
        "tainted canvas",
      );

      expect(map.setPixelRatio.mock.calls).toEqual([[2], [null]]);
      expect(canvas.parentElement).not.toBeNull();
      expect(map.listenerCount("render")).toBe(0);
    });

    it("restores the ratio when the map draws no frame in time", async () => {
      vi.useFakeTimers();
      const map = stillMap();
      map.triggerRepaint.mockImplementation(() => undefined);

      const pending = withMapStill(map, vi.fn(), 2);
      const settled = expect(pending).rejects.toThrow(
        "the map did not draw in time",
      );
      await vi.advanceTimersByTimeAsync(MAP_STILL_TIMEOUT_MS);
      await settled;

      expect(map.setPixelRatio.mock.calls).toEqual([[2], [null]]);
      expect(map.getCanvas().parentElement).not.toBeNull();
      expect(map.listenerCount("render")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    });

    it("lets go of the frame once the canvas is back", async () => {
      const map = stillMap();
      const parent = map.getCanvas().parentElement!;
      let still: HTMLImageElement | null = null;

      await withMapStill(
        map,
        () => {
          still = parent.querySelector("img");
        },
        2,
      );

      expect(still!.hasAttribute("src")).toBe(false);
    });
  });
});
