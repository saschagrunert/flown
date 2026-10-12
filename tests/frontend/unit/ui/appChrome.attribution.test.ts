/**
 * The height of the map's credit kept in --attribution-h, and the tap that
 * expands it (followAttributionHeight in ui/appChrome.ts)
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import { afterEach, describe, expect, it, vi } from "vitest";
import { followAttributionHeight } from "../../../../flown/frontend/ui/appChrome";

/** The ResizeObservers made since the last test, with what each observes */
const observers: {
  callback: ResizeObserverCallback;
  observed: Element[];
  disconnected: boolean;
}[] = [];

class FakeResizeObserver {
  private readonly entry: (typeof observers)[number];
  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, observed: [], disconnected: false };
    observers.push(this.entry);
  }
  observe(element: Element): void {
    this.entry.observed.push(element);
  }
  disconnect(): void {
    this.entry.disconnected = true;
  }
}

/** A map whose container holds a credit `height` pixels tall, or none */
function mapWithCredit(height: number | null): {
  map: MapLibreMap;
  credit: HTMLElement | null;
} {
  const container = document.createElement("div");
  let credit: HTMLElement | null = null;
  if (height !== null) {
    credit = document.createElement("div");
    credit.className = "maplibregl-ctrl-attrib";
    credit.innerHTML =
      '<a href="https://example.org">Tiles</a> <span>more</span>';
    vi.spyOn(credit, "getBoundingClientRect").mockReturnValue({
      height,
    } as DOMRect);
    container.append(credit);
  }
  return {
    map: { getContainer: () => container } as unknown as MapLibreMap,
    credit,
  };
}

/** Run the callback of the one observer, as a resize of the credit would */
function resize(): void {
  const [observer] = observers;
  observer!.callback([], {} as ResizeObserver);
}

afterEach(() => {
  observers.length = 0;
  document.documentElement.style.removeProperty("--attribution-h");
});

describe("followAttributionHeight", () => {
  it("keeps --attribution-h at the credit's height as it changes", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { map, credit } = mapWithCredit(18);

    followAttributionHeight(map, new AbortController().signal);

    expect(observers[0]!.observed).toEqual([credit]);
    resize();
    expect(
      document.documentElement.style.getPropertyValue("--attribution-h"),
    ).toBe("18px");
  });

  it("keeps the last height while a sheet hides the credit", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { map, credit } = mapWithCredit(36);
    followAttributionHeight(map, new AbortController().signal);
    resize();

    vi.spyOn(credit!, "getBoundingClientRect").mockReturnValue({
      height: 0,
    } as DOMRect);
    resize();

    expect(
      document.documentElement.style.getPropertyValue("--attribution-h"),
    ).toBe("36px");
  });

  it("expands on a tap beside its links, not on a link", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { map, credit } = mapWithCredit(18);
    followAttributionHeight(map, new AbortController().signal);

    credit!.querySelector("a")!.click();
    expect(credit!.classList.contains("is-expanded")).toBe(false);

    credit!.querySelector("span")!.click();
    expect(credit!.classList.contains("is-expanded")).toBe(true);
    credit!.querySelector("span")!.click();
    expect(credit!.classList.contains("is-expanded")).toBe(false);
  });

  it("stops following and listening with the signal", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { map, credit } = mapWithCredit(18);
    const lifetime = new AbortController();
    followAttributionHeight(map, lifetime.signal);

    lifetime.abort();

    expect(observers[0]!.disconnected).toBe(true);
    credit!.querySelector("span")!.click();
    expect(credit!.classList.contains("is-expanded")).toBe(false);
  });

  it("still expands where there is no ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { map, credit } = mapWithCredit(18);

    followAttributionHeight(map, new AbortController().signal);

    expect(observers).toEqual([]);
    credit!.querySelector("span")!.click();
    expect(credit!.classList.contains("is-expanded")).toBe(true);
  });

  it("does nothing on a map without a credit", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { map } = mapWithCredit(null);

    followAttributionHeight(map, new AbortController().signal);

    expect(observers).toEqual([]);
  });
});
