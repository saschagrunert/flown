/**
 * Export of the map as an image (the Export control, and the Export row
 * of the phone's More sheet). It comes with the extras bundle (extras.ts),
 * which the app fetches as Export is first used, or ahead of it on a phone
 * (MobileBar): nothing of it is part of a first visit. The control's busy
 * state and the messages of a failure stay with the app (UIToggles), which
 * says them when this bundle cannot be fetched either.
 *
 * html-to-image draws the map's element into a canvas; the map's WebGL
 * canvas copies blank, so it stands still as an image of itself while it
 * is captured (withMapStill).
 */
import type { MapApp } from "../mapApp";
import { isPhoneLayout, isSmallDevice } from "../utils/device";
import { importWithRetry } from "../services/lazyImport";
import { logError } from "../utils/logger";
import {
  MAP_COMPLETE_TIMEOUT_MS,
  whenMapComplete,
  withMapStill,
} from "../utils/mapHelpers";
import { MAP_SOURCES } from "../utils/constants";
import { showToast } from "../utils/toast";
import { EXPORT_UNAVAILABLE_MESSAGE } from "./uiToggles";

/**
 * html-to-image is only needed for export, so it is imported on first use.
 * It is no part of the bundles: the build points the import at the module
 * scripts/vendor.js puts next to the page, the way it does with MapLibre
 * (see build.js). Same-origin, so the page's CSP covers it as it is.
 */
export const HTML_TO_IMAGE_URL = "./vendor/html-to-image.mjs";

/** Largest canvas iOS Safari will draw into (16.7 million pixels) */
export const MAX_CANVAS_PIXELS = 16_777_216;
/** Phones get their pixel density up to this factor */
const MAX_PHONE_EXPORT_SCALE = 3;

/** What the export uses of html-to-image */
export type HtmlToImage = Pick<typeof import("html-to-image"), "toJpeg">;

/**
 * The import itself, replaceable by tests and exported for them (see
 * services/lazyImport.ts)
 */
export const importFromVendor = (failedImports: number): Promise<HtmlToImage> =>
  importWithRetry(
    () => import("html-to-image"),
    HTML_TO_IMAGE_URL,
    failedImports,
  );

let importHtmlToImage = importFromVendor;
let htmlToImagePromise: Promise<HtmlToImage | null> | null = null;
let failedImports = 0;

/**
 * Load html-to-image on demand. Resolves with null when the module cannot be
 * loaded (offline, a site published without the vendor directory); that is
 * not kept, so the next export asks the server again.
 */
export function loadHtmlToImage(): Promise<HtmlToImage | null> {
  htmlToImagePromise ??= importHtmlToImage(failedImports).catch(
    (error: unknown) => {
      logError("Could not load html-to-image:", error);
      failedImports++;
      htmlToImagePromise = null;
      return null;
    },
  );
  return htmlToImagePromise;
}

/** Forget the cached import, and replace it (used by tests) */
export function resetHtmlToImageLoader(
  importer: typeof importHtmlToImage = importFromVendor,
): void {
  htmlToImagePromise = null;
  failedImports = 0;
  importHtmlToImage = importer;
}

/**
 * Scale of the exported image relative to the map's CSS size. Desktops get
 * 2x. A phone gets its own pixel density, since 1x left a 390x844 image on
 * a 3x screen. Either way the canvas stays within what iOS will allocate,
 * past which the export comes out blank.
 */
export function exportScale(width: number, height: number): number {
  const preferred = isPhoneLayout()
    ? Math.min(
        Math.max(window.devicePixelRatio || 1, 1),
        MAX_PHONE_EXPORT_SCALE,
      )
    : 2;
  const area = width * height;
  if (area <= 0) return preferred;
  return Math.min(preferred, Math.sqrt(MAX_CANVAS_PIXELS / area));
}

/** Convert a data: URL into a Blob without going through fetch() */
export function dataUrlToBlob(dataUrl: string): Blob {
  const commaIndex = dataUrl.indexOf(",");
  const header = commaIndex >= 0 ? dataUrl.slice(0, commaIndex) : "";
  const payload = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : "";
  const mimeMatch = /^data:([^;,]+)/.exec(header);
  const type = mimeMatch?.[1] ?? "application/octet-stream";

  if (!/;base64$/i.test(header)) {
    return new Blob([decodeURIComponent(payload)], { type });
  }

  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function downloadBlob(blob: Blob, fallbackHref: string, filename: string) {
  const hasObjectUrl = typeof URL.createObjectURL === "function";
  const href = hasObjectUrl ? URL.createObjectURL(blob) : fallbackHref;

  const link = document.createElement("a");
  link.download = filename;
  link.href = href;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();

  if (hasObjectUrl) {
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  }
}

type DeliveryOutcome = "shared" | "downloaded" | "cancelled";

/**
 * How long an export that goes to the share sheet waits in all, from the
 * tap on Export, before the image is taken (ms): for the library and for
 * the map to be complete. `navigator.share` needs the tap to be recent,
 * and the full MAP_COMPLETE_TIMEOUT_MS outlasted that on a slow phone, as
 * did two seconds for the map after the library: the share failed with
 * NotAllowedError and the image was downloaded instead.
 */
export const EXPORT_SHARE_WAIT_MS = 1000;

/**
 * Of EXPORT_SHARE_WAIT_MS, what the wait for the map leaves to the frame
 * of the still (ms): a map that draws at all draws within a frame or two,
 * and one heavy frame of a slow phone fits as well. The frame itself is
 * waited for as long as ever (MAP_STILL_TIMEOUT_MS): one that comes late
 * still makes the image, which is downloaded where the share sheet no
 * longer opens, where giving up on it failed the export.
 */
export const EXPORT_SHARE_FRAME_MS = 400;

/** Whether the export goes to the share sheet of a phone (see deliverImage) */
function sharesFiles(): boolean {
  return (
    isSmallDevice() &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function"
  );
}

/**
 * Hand the exported image to the user: the native share sheet on mobile
 * devices that support file sharing, a download otherwise.
 */
async function deliverImage(
  dataUrl: string,
  filename: string,
): Promise<DeliveryOutcome> {
  const blob = dataUrlToBlob(dataUrl);

  if (sharesFiles()) {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: document.title });
        return "shared";
      } catch (error) {
        if (isAbortError(error)) return "cancelled";
        // Sharing failed for another reason: fall back to a download
      }
    }
  }

  downloadBlob(blob, dataUrl, filename);
  return "downloaded";
}

/**
 * Capture the map of `app` as an image and hand it over: to the share
 * sheet of a phone, or as a download. `tapped` is when Export was tapped
 * (Date.now()), which the share sheet's deadline counts from (see
 * EXPORT_SHARE_WAIT_MS): this module may have come over the network since.
 */
export async function exportImage(
  app: MapApp,
  mapContainer: HTMLElement,
  tapped: number,
): Promise<void> {
  const shareBy = sharesFiles() ? tapped + EXPORT_SHARE_WAIT_MS : null;
  const htmlToImage = await loadHtmlToImage();
  if (!htmlToImage) {
    showToast(EXPORT_UNAVAILABLE_MESSAGE, "error");
    return;
  }

  const scale = exportScale(
    mapContainer.offsetWidth,
    mapContainer.offsetHeight,
  );
  const options = {
    // The canvas is the map's CSS size times this; the clone keeps the
    // map's own layout
    pixelRatio: scale,
    // The page has no web fonts to inline, so there is no point in
    // reading every stylesheet to look for them
    skipFonts: true,
    backgroundColor:
      getComputedStyle(document.documentElement)
        .getPropertyValue("--color-bg-primary")
        .trim() || "#1a1a1a",
    quality: 0.95,
  };
  // Not before the map is complete: an export taken while its tiles or
  // the heat of a year that has just come in were on their way had gaps
  // in the map, or the heat of before.
  // html-to-image copies DOM, and the map's WebGL canvas copies blank, so
  // the map stands still as an image of itself while it is captured,
  // drawn at the scale of the export so it is as sharp as the page on it.
  // Not as long on the way to the share sheet, which needs the tap on
  // Export to be recent: the waits keep within one deadline (see
  // EXPORT_SHARE_WAIT_MS), where a download follows that is not.
  const map = app.map;
  if (map) {
    await whenMapComplete(
      map,
      () => !app.dataManager.heatRequests,
      [MAP_SOURCES.heat, MAP_SOURCES.heatIsolated, MAP_SOURCES.heatLines],
      shareBy === null
        ? MAP_COMPLETE_TIMEOUT_MS
        : shareBy - EXPORT_SHARE_FRAME_MS - Date.now(),
    );
  }
  const capture = (): Promise<string> =>
    htmlToImage.toJpeg(mapContainer, options);
  const dataUrl = map
    ? await withMapStill(map, capture, scale)
    : await capture();

  // Named after the year shown, not the time of the export: an image
  // posted right after a flight would give its time of day away
  const filename = "heatmap_" + app.store.get("selectedYear") + ".jpg";

  const outcome = await deliverImage(dataUrl, filename);
  if (outcome === "shared") {
    showToast("Map shared", "info");
  } else if (outcome === "downloaded") {
    showToast("Map exported", "info");
  }
}
