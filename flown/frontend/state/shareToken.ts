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
 */

import { wrapDegrees } from "../utils/geometry";
import { logError } from "../utils/logger";
import {
  parseUrlParams,
  SHARE_INTRO_PARAM,
  STATE_SCHEMA_VERSION,
} from "./urlState";

/** The parameter of a shared link that holds the token */
export const SHARE_TOKEN_PARAM = "c";

/**
 * The layout of the bits below, in VERSION_BITS. A token of another
 * version, written by a later release, does not resolve.
 */
const FORMAT_VERSION = 0;
const VERSION_BITS = 6;

const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CHAR_BITS = 6;

/** The fields with a value, each marked present or not, in token order */
const FIELDS = ["y", "a", "v", "centre", "z", "b", "t", "x", "p"] as const;

type Field = (typeof FIELDS)[number];

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
const LINK_ORDER = [
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
const REGISTRATION = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-";
const REGISTRATION_CHAR_BITS = 6;
const REGISTRATION_LENGTH_BITS = 5;
const TEXT_LENGTH_BITS = 8;

/** A year, or "all" */
const YEAR_BITS = 12;

/** The nine slots of `v` */
const VISIBILITY = /^[01]{9}$/;

/** Path ids are 40-bit content hashes (PATH_ID_BITS in path_content.py) */
const ID_BITS = 40;

/** The Rice parameter of the selection, which is at most ID_BITS */
const RICE_K_BITS = 6;

/**
 * A number of a link as an unsigned integer of `bits`: in units of
 * 1 / `scale` above `min`, written back to `decimals` places, or as
 * String writes it
 */
interface FixedPoint {
  readonly scale: number;
  readonly min: number;
  readonly bits: number;
  readonly decimals?: number;
}

/** The centre, to the six decimals of `lat` and `lng` */
const CENTRE_LAT: FixedPoint = { scale: 1e6, min: -90, bits: 28, decimals: 6 };
const CENTRE_LNG: FixedPoint = { scale: 1e6, min: -180, bits: 29, decimals: 6 };
/** The zoom, to the two decimals of `z` */
const ZOOM: FixedPoint = { scale: 100, min: 0, bits: 11, decimals: 2 };
/** The bearing and the tilt, to the tenth of a degree of `b` and `t` */
const BEARING: FixedPoint = { scale: 10, min: -180, bits: 12 };
const TILT: FixedPoint = { scale: 10, min: 0, bits: 10 };
/** The ends of the cross-section, to the five decimals of `x` */
const LINE_LAT: FixedPoint = { scale: 1e5, min: -90, bits: 25, decimals: 5 };
const LINE_LNG: FixedPoint = { scale: 1e5, min: -180, bits: 26, decimals: 5 };
const LINE = [LINE_LAT, LINE_LNG, LINE_LAT, LINE_LNG];

/** The numbers of a link with a fixed point, by parameter */
const NUMBERS = new Map<string, readonly FixedPoint[]>([
  ["lat", [CENTRE_LAT]],
  ["lng", [CENTRE_LNG]],
  ["z", [ZOOM]],
  ["b", [BEARING]],
  ["t", [TILT]],
  ["x", LINE],
]);

/** A value the token has no room for, or text that is not a token */
function fail(): never {
  throw new RangeError("Not a share token");
}

/** The bits of a token as "0" and "1", written in order */
class BitWriter {
  private bits = "";

  /** `value` in `width` bits, most significant first */
  uint(value: number, width: number): void {
    if (!Number.isInteger(value) || value < 0 || value >= 2 ** width) fail();
    if (width) this.bits += value.toString(2).padStart(width, "0");
  }

  bit(on: boolean): void {
    this.bits += on ? "1" : "0";
  }

  /** `count` zeros closed by a one */
  unary(count: number): void {
    this.bits += "0".repeat(count) + "1";
  }

  toString(): string {
    let text = "";
    for (let i = 0; i < this.bits.length; i += CHAR_BITS) {
      const char = this.bits.slice(i, i + CHAR_BITS).padEnd(CHAR_BITS, "0");
      text += BASE64URL[parseInt(char, 2)]!;
    }
    return text;
  }
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
function format(value: number, spec: FixedPoint): string {
  return spec.decimals === undefined
    ? String(value)
    : value.toFixed(spec.decimals);
}

function writeFixed(out: BitWriter, text: string, spec: FixedPoint): void {
  const value = parseFloat(text);
  if (!isFinite(value)) fail();
  out.uint(Math.round(value * spec.scale) - spec.min * spec.scale, spec.bits);
}

function readFixed(input: BitReader, spec: FixedPoint): string {
  const units = input.uint(spec.bits) + spec.min * spec.scale;
  return format(units / spec.scale, spec);
}

/**
 * Text: a registration at six bits a character when it fits, anything else
 * as its UTF-8 bytes
 */
function writeText(out: BitWriter, text: string): void {
  const compact =
    text.length > 0 &&
    text.length < 2 ** REGISTRATION_LENGTH_BITS &&
    [...text].every((char) => REGISTRATION.includes(char));
  out.bit(!compact);
  if (compact) {
    out.uint(text.length, REGISTRATION_LENGTH_BITS);
    for (const char of text)
      out.uint(REGISTRATION.indexOf(char), REGISTRATION_CHAR_BITS);
    return;
  }
  const bytes = new TextEncoder().encode(text);
  out.uint(bytes.length, TEXT_LENGTH_BITS);
  for (const byte of bytes) out.uint(byte, 8);
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

/** The ids of `p`, sorted and each once, as the token holds them */
function selectionOf(params: URLSearchParams): number[] {
  const ids =
    parseUrlParams(
      new URLSearchParams({
        p: params.get("p") ?? "",
        sv: params.get("sv") ?? "",
      }),
    )?.selectedPathIds ?? fail();
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * The sorted ids as the gaps between them, each a Rice code: the quotient
 * by 2^k as that many zeros closed by a one, then the rest in k bits, with
 * the k that writes them in the fewest bits. The flights are the last of
 * the token, so the zeros that pad its last character can never read as
 * one more.
 */
function writeSelection(out: BitWriter, ids: readonly number[]): void {
  const gaps = ids.map((id, i) => (i === 0 ? id : id - ids[i - 1]! - 1));
  const length = (k: number): number =>
    gaps.reduce((sum, gap) => sum + Math.floor(gap / 2 ** k) + 1 + k, 0);
  let k = 0;
  for (let next = 1; next <= ID_BITS; next++) {
    if (length(next) < length(k)) k = next;
  }
  out.uint(k, RICE_K_BITS);
  for (const gap of gaps) {
    const quotient = Math.floor(gap / 2 ** k);
    out.unary(quotient);
    out.uint(gap - quotient * 2 ** k, k);
  }
}

function readSelection(input: BitReader): number[] {
  const k = input.uint(RICE_K_BITS);
  if (k > ID_BITS) fail();
  const ids: number[] = [];
  let previous = -1;
  for (;;) {
    const quotient = input.unary();
    if (quotient === null) return ids;
    previous += 1 + quotient * 2 ** k + input.uint(k);
    if (previous >= 2 ** ID_BITS) fail();
    ids.push(previous);
  }
}

/**
 * The link as the token holds it: without `debug`, which a shared link
 * leaves out, each parameter once as the page reads it (the first), the
 * longitude of the centre in -180 to 180, where the page puts it as it
 * reads the link anyway, every number in one spelling ("0.000000" for
 * "-0.000000", say), and the flights sorted, each once
 */
function normalized(params: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams();
  for (const [key, value] of params) {
    if (key === "debug" || key === "sv" || result.has(key)) continue;
    const specs = NUMBERS.get(key);
    if (specs) {
      const parts = value.split(",");
      if (key === "lng" && Math.abs(parseFloat(value)) > 180) {
        parts[0] = String(wrapDegrees(parseFloat(value)));
      }
      result.set(
        key,
        parts.length === specs.length
          ? parts
              .map((part, i) => {
                const spec = specs[i]!;
                const number = parseFloat(part);
                return isFinite(number)
                  ? format(Math.round(number * spec.scale) / spec.scale, spec)
                  : part;
              })
              .join(",")
          : value,
      );
    } else if (key === "p") {
      result.set(
        "p",
        selectionOf(params)
          .map((id) => id.toString(36))
          .join(","),
      );
      result.set("sv", String(STATE_SCHEMA_VERSION));
    } else {
      result.set(key, value);
    }
  }
  return result;
}

function pack(params: URLSearchParams): string {
  for (const key of params.keys()) {
    if (!LINK_ORDER.includes(key)) fail();
  }
  const has = (field: Field): boolean =>
    field === "centre"
      ? params.has("lat") && params.has("lng")
      : params.has(field);
  const text = (key: string): string => params.get(key)!;

  const out = new BitWriter();
  out.uint(FORMAT_VERSION, VERSION_BITS);
  for (const field of FIELDS) out.bit(has(field));
  for (const flag of FLAGS) {
    const value = params.get(flag);
    if (value !== null && value !== "1") fail();
    out.bit(value === "1");
  }

  if (has("y")) {
    const year = text("y");
    out.bit(year === "all");
    if (year !== "all") {
      if (!/^[1-9]\d{0,3}$/.test(year)) fail();
      out.uint(Number(year), YEAR_BITS);
    }
  }
  if (has("a")) writeText(out, text("a"));
  if (has("v")) {
    if (!VISIBILITY.test(text("v"))) fail();
    for (const slot of text("v")) out.bit(slot === "1");
  }
  if (has("centre")) {
    writeFixed(out, text("lat"), CENTRE_LAT);
    writeFixed(out, text("lng"), CENTRE_LNG);
  }
  if (has("z")) writeFixed(out, text("z"), ZOOM);
  if (has("b")) writeFixed(out, text("b"), BEARING);
  if (has("t")) writeFixed(out, text("t"), TILT);
  if (has("x")) {
    const ends = text("x").split(",");
    if (ends.length !== LINE.length) fail();
    ends.forEach((end, i) => writeFixed(out, end, LINE[i]!));
  }
  if (has("p")) writeSelection(out, selectionOf(params));
  return out.toString();
}

function unpack(token: string): URLSearchParams {
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

/** The entries of a link in one order, to tell two links apart by */
function entries(params: URLSearchParams): string {
  return JSON.stringify([...params].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The token of a link's query (encodeStateToUrl, and the intro's `i=1` of
 * a link to shared flights), or null when the link holds a value the
 * token has no room for. A token is only handed out once it resolves to
 * the link it was packed from, normalized (see normalized).
 */
export function packShareToken(query: string): string | null {
  try {
    const params = normalized(new URLSearchParams(query));
    const token = pack(params);
    return entries(unpack(token)) === entries(params) ? token : null;
  } catch {
    return null;
  }
}

/** The link a token resolves to, or null when it is not one */
export function unpackShareToken(token: string): URLSearchParams | null {
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
  if (!resolved) logError("Shared link could not be read:", token);
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
