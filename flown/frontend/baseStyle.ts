/**
 * The base style - CARTO's map under the flights, and what stands in for it
 *
 * The map starts on FALLBACK_STYLE, which needs no network, and MapApp
 * swaps CARTO's vector style in under the flights once it has been fetched
 * (MapApp.loadBaseStyle, then setBaseStyle in mapLayers.ts). This module
 * holds what that takes that is not the app's own state: the style's URL,
 * the API key put on every request to CARTO, the fallback style and how
 * long a failed request waits before it is made once more. The site's
 * preloads ask for the very same URL (CARTO_STYLE_URL in site_assets.py),
 * so a change here goes there as well.
 */
import type { RequestTransformFunction, StyleSpecification } from "maplibre-gl";
import { MAP_SKY } from "./utils/constants";

/**
 * The CARTO vector style that replaces the raster `dark_all` tiles. The
 * style, its tiles, glyphs and sprite all come from hosts under
 * basemaps.cartocdn.com.
 */
const CARTO_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const CARTO_HOST = /(^|\.)basemaps\.cartocdn\.com$/;

/** The base style, with the API key when the site was built with one */
export function cartoStyleUrl(apiKey?: string): string {
  return apiKey
    ? `${CARTO_STYLE_URL}?key=${encodeURIComponent(apiKey)}`
    : CARTO_STYLE_URL;
}

/**
 * Put the API key on every request to CARTO, not only on the style. CARTO
 * documents the key for the style URL, but the requests that count against
 * the quota are the tiles, and the style names those without it.
 */
export function cartoTransformRequest(
  apiKey?: string,
): RequestTransformFunction | null {
  if (!apiKey) return null;
  return (url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // Relative, so one of the site's own files
      return undefined;
    }
    if (!CARTO_HOST.test(parsed.hostname) || parsed.searchParams.has("key")) {
      return undefined;
    }
    // Appended by hand, so the rest of the URL stays byte for byte what
    // MapLibre asked for
    const separator = url.includes("?") ? "&" : "?";
    return { url: `${url}${separator}key=${encodeURIComponent(apiKey)}` };
  };
}

/**
 * What the map starts on, and stays on when the base style cannot be
 * fetched: the page background and nothing else. It needs no network, so
 * the flights are drawn without waiting for CARTO, whose style is swapped
 * in under them when it arrives (see `loadBaseStyle`). The colour is the
 * one of that style's background layer and of `#map` (--color-map-bg).
 */
export const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sky: MAP_SKY,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#0e0e0e" },
    },
  ],
};

/**
 * How long after a failed request the base style is asked for once more. A
 * connection that was reset or a CDN node that answered 5xx is usually fine
 * a moment later; whatever still fails then is not cured by asking again,
 * except by the network coming back, which `online` reports.
 */
export const BASE_STYLE_RETRY_MS = 5_000;

/**
 * Said once a page, as the base style first fails: without it the map is
 * the flights on a plain background, which looks like a broken page. Its
 * Retry asks at once, as coming back online does.
 */
export const BASE_STYLE_UNAVAILABLE_MESSAGE =
  "The base map could not be loaded, showing the flights alone";
