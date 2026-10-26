/**
 * The packing of a link into the token of a shared link (state/shareToken.ts
 * has the format and the reading of it): Copy link's alone, so it comes
 * with the extras bundle, while a link with a token is read as the page
 * opens, before anything else reads it.
 */
import { wrapDegrees } from "../utils/geometry";
import { parseUrlParams, PATH_ID_BITS, STATE_SCHEMA_VERSION } from "./urlState";
import {
  BASE64URL,
  BEARING,
  CENTRE_LAT,
  CENTRE_LNG,
  CHAR_BITS,
  checksum,
  fail,
  FIELDS,
  FLAGS,
  format,
  FORMAT_VERSION,
  LINE,
  LINK_ORDER,
  MAX_SHARE_TOKEN_LENGTH,
  REGISTRATION,
  REGISTRATION_CHAR_BITS,
  REGISTRATION_LENGTH_BITS,
  RICE_K_BITS,
  TEXT_LENGTH_BITS,
  TILT,
  unpack,
  YEAR_BITS,
  ZOOM,
  type Field,
  type FixedPoint,
} from "./shareToken";

/** The nine slots of `v` */
const VISIBILITY = /^[01]{9}$/;

/** The numbers of a link with a fixed point, by parameter */
const NUMBERS = new Map<string, readonly FixedPoint[]>([
  ["lat", [CENTRE_LAT]],
  ["lng", [CENTRE_LNG]],
  ["z", [ZOOM]],
  ["b", [BEARING]],
  ["t", [TILT]],
  ["x", LINE],
]);

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

function writeFixed(out: BitWriter, text: string, spec: FixedPoint): void {
  const value = parseFloat(text);
  if (!isFinite(value)) fail();
  out.uint(Math.round(value * spec.scale) - spec.min * spec.scale, spec.bits);
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
  for (let next = 1; next <= PATH_ID_BITS; next++) {
    if (length(next) < length(k)) k = next;
  }
  out.uint(k, RICE_K_BITS);
  for (const gap of gaps) {
    const quotient = Math.floor(gap / 2 ** k);
    out.unary(quotient);
    out.uint(gap - quotient * 2 ** k, k);
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
  const body = out.toString();
  return BASE64URL[FORMAT_VERSION]! + checksum(body) + body;
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
    if (token.length > MAX_SHARE_TOKEN_LENGTH) return null;
    return entries(unpack(token)) === entries(params) ? token : null;
  } catch {
    return null;
  }
}
