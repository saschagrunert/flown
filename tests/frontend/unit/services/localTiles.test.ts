/**
 * The elevation tiles the build worker fetches and decodes for the build in
 * the page (services/localTiles.ts). The decoding is the browser's, which
 * jsdom has not: here its canvas is a stand-in, and the e2e suite checks the
 * planes of a real browser against the build's own decoder
 * (local-flights.spec.ts).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Fetch } from "../../../../flown/frontend/services/localWorker";

const tile = (name: string) => ({
  url: `https://tiles.example/${name.replaceAll("-", "/")}.png`,
  name,
});

/** A fetch answering each URL with `answer` of it, counting at once */
function fakeFetch(answer: (url: string) => Promise<Response> | Response): {
  fetch: Fetch;
  urls: string[];
  most: () => number;
  inits: (RequestInit | undefined)[];
} {
  const urls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  let running = 0;
  let most = 0;
  const fetch: Fetch = async (input, init) => {
    // The tiles are asked for by their URLs
    const url = input as string;
    urls.push(url);
    inits.push(init);
    running++;
    most = Math.max(most, running);
    try {
      await Promise.resolve();
      return await answer(url);
    } finally {
      running--;
    }
  };
  return { fetch, urls, most: () => most, inits };
}

async function load() {
  vi.resetModules();
  return import("../../../../flown/frontend/services/localTiles");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTiles", () => {
  it("fetches every tile once, some at a time, with no cookie or referrer", async () => {
    const { fetchTiles, TILE_FETCHES } = await load();
    const tiles = Array.from({ length: 20 }, (_, i) => tile(`10-${i}-1`));
    const { fetch, urls, most, inits } = fakeFetch(
      (url) => new Response(new TextEncoder().encode(url)),
    );
    const kept: [string, string, Uint8Array | null][] = [];

    const count = await fetchTiles(
      tiles,
      fetch,
      (name, png, planes) =>
        kept.push([name, new TextDecoder().decode(png), planes]),
      () => Promise.resolve(new Uint8Array([1])),
    );

    expect(count).toBe(20);
    expect([...urls].sort()).toEqual(tiles.map((t) => t.url).sort());
    expect(most()).toBe(TILE_FETCHES);
    expect(kept.find(([name]) => name === "10-3-1")).toEqual([
      "10-3-1",
      tiles[3]!.url,
      new Uint8Array([1]),
    ]);
    expect(inits[0]).toMatchObject({
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  });

  it("stops the others once a request fails on the way: offline", async () => {
    const { fetchTiles } = await load();
    const tiles = Array.from({ length: 30 }, (_, i) => tile(`10-${i}-1`));
    const { fetch, urls } = fakeFetch(() =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    const keep = vi.fn();

    expect(await fetchTiles(tiles, fetch, keep)).toBe(0);
    // Those already on their way, no more
    expect(urls.length).toBeLessThanOrEqual(8);
    expect(keep).not.toHaveBeenCalled();
  });

  it("misses a tile the host answers otherwise, and gives the host up after server errors in a row", async () => {
    const { fetchTiles } = await load();
    const answers: Record<string, Response> = {
      "10-1-1": new Response(null, { status: 404 }),
      "10-2-1": new Response(new Uint8Array([2])),
    };
    const { fetch } = fakeFetch((url) => {
      const name = url.split("/").slice(-3).join("-").replace(".png", "");
      return answers[name] ?? new Response(null, { status: 503 });
    });
    const keep = vi.fn();
    const tiles = Array.from({ length: 10 }, (_, i) => tile(`10-${i + 1}-1`));

    const count = await fetchTiles(
      tiles,
      fetch,
      keep,
      () => Promise.resolve(null),
      1,
    );

    expect(count).toBe(1);
    expect(keep).toHaveBeenCalledWith("10-2-1", new Uint8Array([2]), null);
    // Three 503s in a row after it: the rest are not asked for
    expect(keep).toHaveBeenCalledTimes(1);
  });

  it("refuses a redirect, a body too large, a URL that is not https and a name that is no tile's", async () => {
    const { fetchTiles, MAX_TILE_BYTES } = await load();
    const { fetch, urls } = fakeFetch((url) => {
      if (url.includes("/1/")) {
        // What a redirect answers a request that asks for none
        return {
          ok: false,
          status: 0,
          type: "opaqueredirect",
          headers: new Headers(),
        } as unknown as Response;
      }
      return new Response(new Uint8Array(MAX_TILE_BYTES + 1));
    });
    const keep = vi.fn();

    const count = await fetchTiles(
      [
        tile("10-1-1"),
        tile("10-2-1"),
        { url: "http://tiles.example/10/3/1.png", name: "10-3-1" },
        { url: "https://tiles.example/x.png", name: "../x" },
      ],
      fetch,
      keep,
    );

    expect(count).toBe(0);
    expect(keep).not.toHaveBeenCalled();
    expect(urls).toHaveLength(2);
  });

  it("keeps a tile without its planes when the decoding fails", async () => {
    const { fetchTiles } = await load();
    const { fetch } = fakeFetch(() => new Response(new Uint8Array([5])));
    const keep = vi.fn();

    await fetchTiles([tile("10-1-1")], fetch, keep, () =>
      Promise.reject(new Error("not an image")),
    );

    expect(keep).toHaveBeenCalledWith("10-1-1", new Uint8Array([5]), null);
  });
});

describe("planesOf", () => {
  it("splits the pixels of a canvas into the planes the build keeps", async () => {
    const { planesOf } = await load();
    const rgba = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);

    expect(planesOf(rgba)).toEqual(new Uint8Array([1, 4, 2, 5, 3, 6]));
  });

  it("refuses a pixel that is not opaque, which a canvas multiplied", async () => {
    const { planesOf } = await load();

    expect(planesOf(new Uint8ClampedArray([1, 2, 3, 254]))).toBeNull();
    expect(planesOf(null)).toBeNull();
  });
});

/**
 * A browser's image decoding and canvas: `noise` added to what a page
 * reads of the canvas, as a browser against fingerprinting does
 */
function stubCanvas(noise = 0, side = 256): { decoded: number } {
  const seen = { decoded: 0 };
  // Every image is `side` pixels a side, of these pixels; the probe the
  // pixels it was drawn from
  let drawn: Uint8ClampedArray | null = null;
  const image = (size: number) => {
    const pixels = new Uint8ClampedArray(size * size * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels.set([i & 255, 7, 9, 255], i);
    }
    return pixels;
  };
  class Bitmap {
    constructor(
      readonly width: number,
      readonly height: number,
      readonly pixels: Uint8ClampedArray,
    ) {}
    close(): void {}
  }
  class Canvas {
    pixels: Uint8ClampedArray;
    constructor(
      readonly width: number,
      readonly height: number,
    ) {
      this.pixels = new Uint8ClampedArray(width * height * 4);
    }
    getContext() {
      return {
        createImageData: (w: number, h: number) => ({
          data: new Uint8ClampedArray(w * h * 4),
        }),
        putImageData: (data: { data: Uint8ClampedArray }) => {
          this.pixels = data.data.slice();
        },
        drawImage: (bitmap: Bitmap) => {
          this.pixels = bitmap.pixels.slice();
        },
        getImageData: () => ({
          data: this.pixels.map((value, at) =>
            at % 4 === 3 ? value : Math.min(255, value + noise),
          ),
        }),
      };
    }
    convertToBlob(): Promise<Blob> {
      drawn = this.pixels.slice();
      return Promise.resolve(new Blob(["probe"]));
    }
  }
  vi.stubGlobal("OffscreenCanvas", Canvas);
  vi.stubGlobal("createImageBitmap", async (blob: Blob) => {
    if ((await blob.text()) === "probe") {
      return new Bitmap(64, 64, drawn!);
    }
    seen.decoded++;
    return new Bitmap(side, side, image(side));
  });
  return seen;
}

describe("decodeTile", () => {
  it("has the browser decode a tile into its planes", async () => {
    const seen = stubCanvas();
    const { decodeTile } = await load();

    const planes = await decodeTile(new ArrayBuffer(4));

    expect(seen.decoded).toBe(1);
    expect(planes).toHaveLength(3 * 256 * 256);
    expect(planes![1]).toBe(4);
    expect(planes![256 * 256]).toBe(7);
    expect(planes![2 * 256 * 256]).toBe(9);
  });

  it("leaves the decoding to the build where the canvas reads back noise", async () => {
    const seen = stubCanvas(1);
    const { decodeTile } = await load();

    expect(await decodeTile(new ArrayBuffer(4))).toBeNull();
    expect(await decodeTile(new ArrayBuffer(4))).toBeNull();
    expect(seen.decoded).toBe(0);
  });

  it("leaves an image that is not of a tile's size to the build", async () => {
    stubCanvas(0, 512);
    const { decodeTile } = await load();

    expect(await decodeTile(new ArrayBuffer(4))).toBeNull();
  });

  it("leaves it to the build where the browser has no canvas off the page", async () => {
    vi.stubGlobal("OffscreenCanvas", undefined);
    const { decodeTile } = await load();

    expect(await decodeTile(new ArrayBuffer(4))).toBeNull();
  });
});
