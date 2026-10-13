/**
 * The token of a shared link: everything a link carries (state/urlState.ts)
 * packed into one parameter, `?c=<token>`, which the page resolves back
 * into the ordinary link as it opens (resolveShareToken). Only Copy link
 * writes it; the address bar keeps the readable link.
 *
 * The token is a stream of bits, six to a base64url character, which a
 * query string carries as they are:
 *
 *   version      6 bits, FORMAT_VERSION
 *   present      1 bit for each of FIELDS, in their order
 *   flags        1 bit for each of FLAGS, the switches written "1"
 *   fields       each present field, in the order of FIELDS: the year, the
 *                aircraft, the layers, the centre, the zoom, the bearing,
 *                the tilt and the line of the cross-section
 *   flights      last, the selected path ids as Rice-coded gaps
 *
 * Every number goes in at exactly the precision the link writes it in, so
 * the link a token resolves to reads as the state it was packed from. A
 * link with a value the token has no room for is not packed at all
 * (packShareToken returns null), and Copy link hands on the long link.
 *
 * The format and the reading are here, in the first visit, which reads a
 * link with a token before anything else reads the link; the packing is
 * Copy link's alone, in the extras bundle (state/shareTokenPack.ts).
 */

import { logError } from "../utils/logger";
import {
  MAX_SELECTED_PATH_IDS,
  PATH_ID_BITS,
  SHARE_INTRO_PARAM,
  SHARE_TOKEN_PARAM,
  STATE_SCHEMA_VERSION,
} from "./urlState";

/**
 * The longest token packed or resolved: room for the most flights a link
 * selects (MAX_SELECTED_PATH_IDS) at the bits a site's ids take, while a
 * crafted link of a megabyte is not read at all
 */
export const MAX_SHARE_TOKEN_LENGTH = 50_000;

/**
 * The layout of the bits below, in VERSION_BITS. A token of another
 * version, written by a later release, does not resolve.
 */
export const FORMAT_VERSION = 0;
export const VERSION_BITS = 6;

export const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
export const CHAR_BITS = 6;

/** The fields with a value, each marked present or not, in token order */
export const FIELDS = [
  "y",
  "a",
  "v",
  "centre",
  "z",
  "b",
  "t",
  "x",
  "p",
] as const;

export type Field = (typeof FIELDS)[number];

/**
 * The switches of a link written "1" while on and left out while off: the
 * globe, 3D, satellite, the Flights tab and the intro of shared flights.
 * The fields follow them, so a new one takes a new FORMAT_VERSION, as does
 * a new field.
 */
export const FLAGS = ["g", "d", "s", "l", SHARE_INTRO_PARAM] as const;

/**
 * The parameters the token holds, in the order encodeStateToUrl writes
 * them; a link with any other but `debug` is not packed
 */
export const LINK_ORDER = [
  "y",
  "a",
  "p",
  "sv",
  "v",
  "lat",
  "lng",
  "z",
  "b",
  "t",
  "g",
  "d",
  "s",
  "l",
  "x",
  SHARE_INTRO_PARAM,
];

/** The characters of most registrations, at six bits each */
export const REGISTRATION = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
export const REGISTRATION_CHAR_BITS = 6;
export const REGISTRATION_LENGTH_BITS = 5;
export const TEXT_LENGTH_BITS = 8;

/** A year, or "all" */
export const YEAR_BITS = 12;

/** The Rice parameter of the selection, which is at most PATH_ID_BITS */
export const RICE_K_BITS = 6;

/**
 * A number of a link as an unsigned integer of `bits`: in units of
 * 1 / `scale` above `min`, written back to `decimals` places, or as
 * String writes it
 */
export interface FixedPoint {
  readonly scale: number;
  readonly min: number;
  readonly bits: number;
  readonly decimals?: number;
}

/** The centre, to the six decimals of `lat` and `lng` */
export const CENTRE_LAT: FixedPoint = {
  scale: 1e6,
  min: -90,
  bits: 28,
  decimals: 6,
};
export const CENTRE_LNG: FixedPoint = {
  scale: 1e6,
  min: -180,
  bits: 29,
  decimals: 6,
};
/** The zoom, to the two decimals of `z` */
export const ZOOM: FixedPoint = { scale: 100, min: 0, bits: 11, decimals: 2 };
/** The bearing and the tilt, to the tenth of a degree of `b` and `t` */
export const BEARING: FixedPoint = { scale: 10, min: -180, bits: 12 };
export const TILT: FixedPoint = { scale: 10, min: 0, bits: 10 };
/** The ends of the cross-section, to the five decimals of `x` */
const LINE_LAT: FixedPoint = { scale: 1e5, min: -90, bits: 25, decimals: 5 };
const LINE_LNG: FixedPoint = { scale: 1e5, min: -180, bits: 26, decimals: 5 };
export const LINE = [LINE_LAT, LINE_LNG, LINE_LAT, LINE_LNG];

/** A value the token has no room for, or text that is not a token */
export function fail(): never {
  throw new RangeError("Not a share token");
}

/** The bits of a token, read in order */
class BitReader {
  private bits = "";
  private at = 0;

  constructor(text: string) {
    for (const char of text) {
      const value = BASE64URL.indexOf(char);
      if (value < 0) fail();
      this.bits += value.toString(2).padStart(CHAR_BITS, "0");
    }
  }

  uint(width: number): number {
    if (this.at + width > this.bits.length) fail();
    const value = width
      ? parseInt(this.bits.slice(this.at, this.at + width), 2)
      : 0;
    this.at += width;
    return value;
  }

  bit(): boolean {
    return this.uint(1) === 1;
  }

  /** The zeros up to the next one, or null when only zeros are left */
  unary(): number | null {
    const one = this.bits.indexOf("1", this.at);
    if (one < 0) return null;
    const count = one - this.at;
    this.at = one + 1;
    return count;
  }
}

/** A number of a link as the token writes it back */
export function format(value: number, spec: FixedPoint): string {
  return spec.decimals === undefined
    ? String(value)
    : value.toFixed(spec.decimals);
}

function readFixed(input: BitReader, spec: FixedPoint): string {
  const units = input.uint(spec.bits) + spec.min * spec.scale;
  return format(units / spec.scale, spec);
}

function readText(input: BitReader): string {
  if (!input.bit()) {
    let text = "";
    for (let i = input.uint(REGISTRATION_LENGTH_BITS); i > 0; i--) {
      text += REGISTRATION[input.uint(REGISTRATION_CHAR_BITS)] ?? fail();
    }
    return text;
  }
  const bytes = new Uint8Array(input.uint(TEXT_LENGTH_BITS));
  for (let i = 0; i < bytes.length; i++) bytes[i] = input.uint(8);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function readSelection(input: BitReader): number[] {
  const k = input.uint(RICE_K_BITS);
  if (k > PATH_ID_BITS) fail();
  const ids: number[] = [];
  let previous = -1;
  // The first MAX_SELECTED_PATH_IDS, as a link holds no more (parsePathIds)
  while (ids.length < MAX_SELECTED_PATH_IDS) {
    const quotient = input.unary();
    if (quotient === null) break;
    previous += 1 + quotient * 2 ** k + input.uint(k);
    if (previous >= 2 ** PATH_ID_BITS) fail();
    ids.push(previous);
  }
  return ids;
}

export function unpack(token: string): URLSearchParams {
  const input = new BitReader(token);
  if (input.uint(VERSION_BITS) !== FORMAT_VERSION) fail();
  const present = new Set(FIELDS.filter(() => input.bit()));
  const flags = FLAGS.filter(() => input.bit());

  const params = new URLSearchParams();
  if (present.has("y")) {
    params.set("y", input.bit() ? "all" : String(input.uint(YEAR_BITS)));
  }
  if (present.has("a")) params.set("a", readText(input));
  if (present.has("v")) {
    let slots = "";
    for (let i = 0; i < 9; i++) slots += input.bit() ? "1" : "0";
    params.set("v", slots);
  }
  if (present.has("centre")) {
    params.set("lat", readFixed(input, CENTRE_LAT));
    params.set("lng", readFixed(input, CENTRE_LNG));
  }
  if (present.has("z")) params.set("z", readFixed(input, ZOOM));
  if (present.has("b")) params.set("b", readFixed(input, BEARING));
  if (present.has("t")) params.set("t", readFixed(input, TILT));
  if (present.has("x")) {
    params.set("x", LINE.map((spec) => readFixed(input, spec)).join(","));
  }
  if (present.has("p")) {
    // The ids of the current schema, which the token does not write: one
    // that gives the same ids another meaning takes a new FORMAT_VERSION
    // (see the test that pins STATE_SCHEMA_VERSION), one that only writes
    // them differently, like 3 to 4, does not
    const ids = readSelection(input);
    if (ids.length > 0) {
      params.set("p", ids.map((id) => id.toString(36)).join(","));
      params.set("sv", String(STATE_SCHEMA_VERSION));
    }
  }
  for (const flag of flags) params.set(flag, "1");
  // In the order encodeStateToUrl writes a link in
  const ordered = new URLSearchParams();
  for (const key of LINK_ORDER) {
    const value = params.get(key);
    if (value !== null) ordered.set(key, value);
  }
  return ordered;
}

/** The link a token resolves to, or null when it is not one */
export function unpackShareToken(token: string): URLSearchParams | null {
  if (token.length > MAX_SHARE_TOKEN_LENGTH) return null;
  try {
    return unpack(token);
  } catch {
    return null;
  }
}

/**
 * Turn a shared link back into the ordinary link in the address bar, before
 * anything reads it: the rest of the page never sees a token. A token that
 * does not resolve opens the page as a link without one would; `debug`
 * stays as it was.
 */
export function resolveShareToken(): void {
  const current = new URLSearchParams(window.location.search);
  const token = current.get(SHARE_TOKEN_PARAM);
  if (token === null) return;
  const resolved = unpackShareToken(token);
  if (!resolved) logError("Shared link could not be read:", token.slice(0, 80));
  const params = resolved ?? new URLSearchParams();
  const debug = current.get("debug");
  if (debug !== null) params.set("debug", debug);
  const query = params.toString();
  history.replaceState(
    history.state,
    "",
    (query ? "?" + query : window.location.pathname) + window.location.hash,
  );
}
