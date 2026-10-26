/**
 * The elevation tiles of a build in the worker (services/localWorker.ts).
 *
 * The Python build fetched them with the worker's synchronous request, one
 * after the other: 400 tiles took a minute, nearly all of it waiting on the
 * host, and decoding their PNGs in Python twenty seconds more. So the build
 * stops at the tiles its cache has not and names them (flown/browser.py,
 * build), the worker fetches them here several at a time, as the site build
 * does (FETCH_WORKERS in flown/terrain_fetch.py), decodes each as the
 * browser decodes an image, and hands both in to the build it runs again,
 * which checks the PNGs as it checks a download of its own.
 */

import type { Fetch } from "./localWorker";

/** A tile the build asks for: its URL, and the name it is handed in under */
export interface WantedTile {
  url: string;
  name: string;
}

/** Downloads at once (FETCH_WORKERS in flown/terrain_fetch.py) */
export const TILE_FETCHES = 8;
/** Anything far larger is not a tile (MAX_TILE_BYTES there) */
export const MAX_TILE_BYTES = 4 * 1024 * 1024;
/** How long a tile may take: one is some 100 KB */
export const TILE_TIMEOUT_MS = 30_000;
/**
 * Tiles in a row the host answered with a server error before it is given
 * up for the build (SERVER_ERROR_TILES_TO_GIVE_UP there)
 */
const SERVER_ERRORS_TO_GIVE_UP = 3;
/** Too many requests, and the server errors */
const SERVER_ERRORS = new Set([429, 500, 502, 503, 504]);
/** A Terrarium tile's side, in pixels (TILE_SIZE in flown/terrain_pixels.py) */
const TILE_SIDE = 256;
/** A name the build hands a tile in under (_TAKEN_TILE in flown/browser.py) */
const TILE_NAME = /^\d+-\d+-\d+$/;

/** Takes a tile fetched: its PNG, and its planes where it was decoded */
export type TileSink = (
  name: string,
  png: Uint8Array,
  planes: Uint8Array | null,
) => void;

/**
 * Fetch `tiles` into `keep`, `workers` at a time, once each, as the build in
 * the page tries each (flown/browser.py). A request that fails on the way
 * (offline, the host unknown, a timeout) stops the others, as do
 * SERVER_ERRORS_TO_GIVE_UP tiles in a row the host answered with a server
 * error; any other answer but a success misses that tile alone. A redirect
 * is one: the tiles never move, and the request must not end up at a host
 * nobody chose. No cookie and no referrer go with them. Answers with how
 * many tiles it kept.
 */
export async function fetchTiles(
  tiles: readonly WantedTile[],
  fetch: Fetch,
  keep: TileSink,
  decode: (png: ArrayBuffer) => Promise<Uint8Array | null> = decodeTile,
  workers = TILE_FETCHES,
): Promise<number> {
  let next = 0;
  let offline = false;
  let serverErrors = 0;
  let kept = 0;
  const one = async ({ url, name }: WantedTile): Promise<void> => {
    if (!url.startsWith("https://") || !TILE_NAME.test(name)) return;
    let bytes: ArrayBuffer;
    try {
      const response = await fetch(url, {
        redirect: "manual",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
      });
      if (!response.ok) {
        if (
          SERVER_ERRORS.has(response.status) &&
          ++serverErrors >= SERVER_ERRORS_TO_GIVE_UP
        ) {
          offline = true;
        }
        return;
      }
      serverErrors = 0;
      if (Number(response.headers.get("content-length")) > MAX_TILE_BYTES) {
        return;
      }
      bytes = await response.arrayBuffer();
    } catch {
      offline = true;
      return;
    }
    if (bytes.byteLength > MAX_TILE_BYTES) return;
    keep(name, new Uint8Array(bytes), await decode(bytes).catch(() => null));
    kept++;
  };
  const work = async (): Promise<void> => {
    while (!offline && next < tiles.length) await one(tiles[next++]!);
  };
  await Promise.all(
    Array.from({ length: Math.min(workers, tiles.length) }, work),
  );
  return kept;
}

/**
 * The red, the green and the blue plane of `rgba`, the pixels of a canvas,
 * as flown/terrain_pixels.py keeps them; null for a pixel that is not
 * opaque, which a Terrarium tile has none of and a canvas would have
 * multiplied by its alpha
 */
export function planesOf(rgba: Uint8ClampedArray | null): Uint8Array | null {
  if (!rgba) return null;
  const pixels = rgba.length / 4;
  const planes = new Uint8Array(pixels * 3);
  for (let pixel = 0, at = 0; pixel < pixels; pixel++, at += 4) {
    if (rgba[at + 3] !== 255) return null;
    planes[pixel] = rgba[at]!;
    planes[pixels + pixel] = rgba[at + 1]!;
    planes[2 * pixels + pixel] = rgba[at + 2]!;
  }
  return planes;
}

/** The pixels of the image `blob`, `side` pixels a side, as they are */
async function pixelsOf(
  blob: Blob,
  side: number,
): Promise<Uint8ClampedArray | null> {
  const bitmap = await createImageBitmap(blob, {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  try {
    if (bitmap.width !== side || bitmap.height !== side) return null;
    const context = new OffscreenCanvas(side, side).getContext("2d", {
      willReadFrequently: true,
    });
    if (!context) return null;
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, side, side).data;
  } finally {
    bitmap.close();
  }
}

/**
 * Whether the canvas hands back the pixels it was given: a browser that
 * adds noise to what a page reads of one (against fingerprinting: Brave,
 * Safari's private windows, Firefox's resistFingerprinting) would change
 * the ground by metres here and there. Of every value in every channel,
 * through a PNG, as a tile comes.
 */
async function canvasReadsExactly(): Promise<boolean> {
  try {
    const side = 64;
    const canvas = new OffscreenCanvas(side, side);
    const context = canvas.getContext("2d")!;
    const probe = context.createImageData(side, side);
    for (let pixel = 0; pixel < side * side; pixel++) {
      probe.data.set(
        [pixel & 255, (pixel * 7 + 3) & 255, (pixel * 13 + 5) & 255, 255],
        pixel * 4,
      );
    }
    context.putImageData(probe, 0, 0);
    const read = await pixelsOf(
      await canvas.convertToBlob({ type: "image/png" }),
      side,
    );
    return !!read && read.every((value, at) => value === probe.data[at]);
  } catch {
    return false;
  }
}

let exact: Promise<boolean> | undefined;

/**
 * The planes of the Terrarium tile `png`, decoded by the browser; null
 * where it cannot (no OffscreenCanvas), where its canvas does not read
 * back what it holds (canvasReadsExactly, asked once), and for a PNG that
 * is not a tile: the build decodes those itself
 */
export async function decodeTile(png: ArrayBuffer): Promise<Uint8Array | null> {
  if (
    typeof createImageBitmap !== "function" ||
    typeof OffscreenCanvas !== "function"
  ) {
    return null;
  }
  exact ??= canvasReadsExactly();
  if (!(await exact)) return null;
  return planesOf(
    await pixelsOf(new Blob([png], { type: "image/png" }), TILE_SIDE),
  );
}
