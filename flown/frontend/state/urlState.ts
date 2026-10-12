/**
 * URL state management utilities
 * Handles encoding/decoding application state to/from URL parameters
 */

import type { AppState } from "../types";
import { MAX_ZOOM, MIN_ZOOM } from "../utils/constants";
import { toMapBearing, toMapCenter, toMapPitch } from "../utils/geometry";
import {
  initialToggles,
  TOGGLES,
  VISIBILITY_SLOTS,
  type ToggleUrl,
} from "./toggles";

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Schema version of the persisted selection. Ids saved by an older release
 * refer to different flights and must be discarded rather than silently
 * applied. Version 3 ids are derived from the flight content instead of its
 * position in the export, so they stay valid across re-exports; an id whose
 * flight was removed is dropped once the data has loaded.
 *
 * Version 4 names the very same flights and only writes them differently: in
 * base 36 rather than in decimal, which takes about a third off a link that
 * carries a large selection. Both versions are therefore still read, so
 * links and saved states from before the change keep working.
 */
export const STATE_SCHEMA_VERSION = 4;

/** The versions whose ids this build understands, newest last */
const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [3, 4];

/** The radix each supported version writes its path ids in */
const PATH_ID_RADIX = new Map([
  [3, 10],
  [4, 36],
]);

/** Path ids are 40-bit content hashes (PATH_ID_BITS in data_exporter.py) */
const PATH_ID_LIMIT = 2 ** 40;

/**
 * Whether a saved selection was written by a version this build can read.
 * Used for the URL and for the localStorage copy alike.
 */
export function isSupportedSchemaVersion(version: unknown): boolean {
  return (
    typeof version === "number" && SUPPORTED_SCHEMA_VERSIONS.includes(version)
  );
}

/** Whether a value can be a path id, from a link or from localStorage */
export function isPathId(id: unknown): id is number {
  return (
    Number.isInteger(id) &&
    (id as number) >= 0 &&
    (id as number) < PATH_ID_LIMIT
  );
}

/** A path id as written in a link, or null when it is not one */
function parsePathId(text: string, radix: number): number | null {
  // parseInt stops at the first invalid digit, so the shape is checked first
  const valid = radix === 36 ? /^[0-9a-z]+$/ : /^[0-9]+$/;
  if (!valid.test(text)) return null;
  const id = parseInt(text, radix);
  return isPathId(id) ? id : null;
}

/**
 * Whether `text`, from a link or the saved state, is the line of the
 * cross-section as a link writes it, "lat,lng,lat,lng" from its start to
 * its end (see ui/crossSection.ts): four numbers, the latitudes within 90
 * degrees and the longitudes within 180, where a map can put its ends
 */
export function isSectionLine(text: unknown): text is string {
  const values = String(text).split(",").map(parseFloat);
  return (
    values.length === 4 &&
    values.every((value, i) => Math.abs(value) <= (i % 2 ? 180 : 90))
  );
}

/** The link's `v` string of a first visit, which a link leaves out */
const INITIAL_VISIBILITY = visibilityString(initialToggles());

/**
 * The `v` string of a state: a "1" or "0" per slot of the toggles that have
 * one. A toggle the state leaves out is written as off, and so is slot 7,
 * which the control chrome had before it stopped hiding.
 */
function visibilityString(state: AppState): string {
  const slots: string[] = new Array<string>(VISIBILITY_SLOTS).fill("0");
  for (const toggle of TOGGLES) {
    const url: ToggleUrl = toggle.url;
    if ("slot" in url && state[toggle.key]) slots[url.slot] = "1";
  }
  return slots.join("");
}

/**
 * Read the toggles off a link. Only a `v` of all nine slots counts: the
 * shorter ones of the releases before the isolate flag are ignored, and the
 * layers of such a link open as a first visit's. The toggles with a
 * parameter of their own are only ever written while on, so a link without
 * one leaves them as they are.
 */
function parseToggles(urlParams: URLSearchParams, state: AppState): void {
  const vis = urlParams.get("v");
  const slots = vis?.length === VISIBILITY_SLOTS ? vis : null;
  for (const toggle of TOGGLES) {
    const url: ToggleUrl = toggle.url;
    if ("slot" in url) {
      if (slots) state[toggle.key] = slots[url.slot] === "1";
    } else if (urlParams.get(url.param) === "1") {
      state[toggle.key] = true;
    }
  }
}

/** A value's text in a link, when there is one */
function paramText(urlParams: URLSearchParams, name: string): string | null {
  return urlParams.get(name) || null;
}

/**
 * Selected paths, only when they were written with an id scheme this build
 * reads. The radix follows the version: decimal up to 3, base 36 from 4 on.
 */
function parsePathIds(urlParams: URLSearchParams): number[] | undefined {
  const radix = PATH_ID_RADIX.get(parseInt(urlParams.get("sv") ?? "", 10));
  const pathStr = paramText(urlParams, "p");
  if (radix === undefined || !pathStr) return undefined;
  return pathStr
    .split(",")
    .map((id) => parsePathId(id.trim(), radix))
    .filter((id): id is number => id !== null);
}

/**
 * Parse URL parameters into state object
 * URL parameter schema:
 *   y - selectedYear (string: 'all' or year like '2024')
 *   a - selectedAircraft (string: 'all' or aircraft identifier)
 *   p - selectedPathIds (comma-separated, base 36 from schema 4 on:
 *       'a5,1x,3kf'; decimal in schema 3)
 *   sv - schema version of p (an unknown one means p is ignored)
 *   v - toggles with a slot (9-char binary string: '100100000', see
 *       state/toggles.ts)
 *   lat, lng - map center coordinates
 *   z - zoom level, in state units (one above the map's, see ZOOM_OFFSET)
 *   b - bearing in degrees, clockwise from north (absent: north up)
 *   t - tilt (pitch) in degrees (absent: flat)
 *   g, d, s, l - toggles with a parameter of their own, '1' when on: the
 *       globe, 3D, satellite imagery and the Flights tab of the
 *       statistics rail (absent: off). The `r` of the heat counted by
 *       distance and the `h` of the heat cloud's band of heights, which
 *       are gone, are ignored like any unknown parameter
 *   x - the line of the cross-section, from its start to its end:
 *       '51.5,12.1,51.6,12.3' (absent: the tool is closed)
 *   i - '1' on a link Copy link hands on in share mode: it opens with the
 *       intro of the shared flights, once (see takeShareIntro). Not part
 *       of the state, and never written back
 * @param params - URLSearchParams object or search string
 * @returns Parsed state or null if no params
 */
export function parseUrlParams(
  params: URLSearchParams | string,
): AppState | null {
  const urlParams =
    typeof params === "string" ? new URLSearchParams(params) : params;
  if (urlParams.toString() === "") {
    return null;
  }

  const state: AppState = {};
  const year = paramText(urlParams, "y");
  if (year) state.selectedYear = year;
  const aircraft = paramText(urlParams, "a");
  if (aircraft) state.selectedAircraft = aircraft;
  const pathIds = parsePathIds(urlParams);
  if (pathIds) state.selectedPathIds = pathIds;
  parseToggles(urlParams, state);

  // Map position
  const latStr = paramText(urlParams, "lat");
  const lngStr = paramText(urlParams, "lng");
  if (latStr && lngStr) {
    const center = toMapCenter({
      lat: parseFloat(latStr),
      lng: parseFloat(lngStr),
    });
    if (center) state.center = center;
  }

  // Zoom level, clamped to the map's zoom range in the unit of the link
  const zoom = parseFloat(urlParams.get("z") ?? "");
  if (!isNaN(zoom)) state.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));

  // Orientation. A link from before the map could turn has neither and
  // opens north up and flat, as it always did. `parseFloat("")` is NaN,
  // which both checks turn away.
  const bearing = toMapBearing(parseFloat(urlParams.get("b") ?? ""));
  if (bearing !== null) state.bearing = bearing;
  const pitch = toMapPitch(parseFloat(urlParams.get("t") ?? ""));
  if (pitch !== null) state.pitch = pitch;
  const line = paramText(urlParams, "x");
  if (isSectionLine(line)) state.crossSectionLine = line;

  return state;
}

/**
 * The parameter of a link to shared flights that plays their intro as the
 * link opens (ui/shareIntro.ts): Copy link adds it while share mode is on
 * (UIToggles.shareLink), and nothing else ever writes it
 */
export const SHARE_INTRO_PARAM = "i";

/**
 * Whether the page was opened from a link with the intro of its shared
 * flights (SHARE_INTRO_PARAM), which is taken off the address bar there and
 * then: the intro plays once, whether it plays to the end, is skipped or
 * cannot play at all, and a reload, a link copied from the address bar and
 * the saved state never carry it. The saves of the state cannot put it
 * back either, as encodeStateToUrl writes a link anew from the state.
 */
export function takeShareIntro(): boolean {
  const params = new URLSearchParams(window.location.search);
  const marked = params.has(SHARE_INTRO_PARAM);
  params.delete(SHARE_INTRO_PARAM);
  if (marked) history.replaceState(history.state, "", "?" + params.toString());
  return marked;
}

/**
 * Encode current state to URL parameters
 * Preserves non-state parameters like debug
 * @param state - Current state object
 * @returns URL search params string (without leading '?')
 */
export function encodeStateToUrl(state: AppState): string {
  const params = new URLSearchParams();

  // Preserve non-state parameters from current URL
  const debug = new URLSearchParams(window.location.search).get("debug");
  if (debug !== null) params.set("debug", debug);

  // Always include year parameter (including 'all') because default is current year
  if (state.selectedYear) {
    params.set("y", state.selectedYear);
  }

  // Only add aircraft if not 'all' (default is 'all')
  if (state.selectedAircraft && state.selectedAircraft !== "all") {
    params.set("a", state.selectedAircraft);
  }

  if (state.selectedPathIds && state.selectedPathIds.length > 0) {
    // Base 36 keeps a large selection out of the length limits proxies and
    // chat clients put on a link
    params.set(
      "p",
      state.selectedPathIds.map((id) => id.toString(36)).join(","),
    );
    params.set("sv", String(STATE_SCHEMA_VERSION));
  }

  // The toggles with a slot, unless the state has none of them or they are
  // as on a first visit
  const hasVisibility = TOGGLES.some(
    (toggle) => "slot" in toggle.url && state[toggle.key] !== undefined,
  );
  const vis = visibilityString(state);
  if (hasVisibility && vis !== INITIAL_VISIBILITY) {
    params.set("v", vis);
  }

  // Add map position (always include for complete shareable state)
  if (state.center) {
    params.set("lat", state.center.lat.toFixed(6));
    params.set("lng", state.center.lng.toFixed(6));
  }

  if (state.zoom !== undefined) {
    params.set("z", state.zoom.toFixed(2));
  }

  // The defaults stay out of the link: most views are north up, flat and
  // in Mercator, and their links are no longer than they were. A tenth of
  // a degree is finer than anyone can see.
  const bearing = roundToTenth(state.bearing ?? 0);
  if (bearing !== 0) params.set("b", String(bearing));
  const pitch = roundToTenth(state.pitch ?? 0);
  if (pitch !== 0) params.set("t", String(pitch));
  for (const toggle of TOGGLES) {
    const url: ToggleUrl = toggle.url;
    if ("param" in url && state[toggle.key]) params.set(url.param, "1");
  }
  if (state.crossSectionLine) params.set("x", state.crossSectionLine);

  return params.toString();
}
