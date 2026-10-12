/**
 * Formatting utility functions
 */

/**
 * The formatter of each number of decimals, made once. `toLocaleString`
 * with options builds a new one on every call, about 30 times the cost of
 * formatting with one that exists: the replay readout formats several
 * numbers a frame, and that was a fifth of a second in every eight on a
 * phone.
 */
const numberFormats = new Map<number, Intl.NumberFormat>();

/**
 * A measurement with grouped digits, so five- and six-figure values stay
 * readable ("264,400" rather than "264400"). Every surface that prints a
 * number goes through this, so the panel, the legends, the tooltips and the
 * replay readout all group the same way.
 *
 * @param value - The number to render
 * @param decimals - Fixed number of decimals (default: none)
 */
export function formatNumber(value: number, decimals = 0): string {
  if (!Number.isFinite(value)) return "0";
  let format = numberFormats.get(decimals);
  if (!format) {
    format = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    numberFormats.set(decimals, format);
  }
  return format.format(value);
}

/**
 * Compass track for a bearing, normalised and zero padded ("072°"). The
 * rounding comes first, so 359.6 degrees reads 000, never 360.
 * @param bearing - Bearing in degrees, any range
 */
export function formatTrack(bearing: number): string {
  const normalised = ((Math.round(bearing) % 360) + 360) % 360;
  return String(normalised).padStart(3, "0") + "°";
}

/**
 * Format a byte count into a human-readable file size (e.g., "1.1 MB")
 * @param bytes - Size in bytes
 * @returns Formatted size
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let i = 1; i < units.length && value >= 1024; i++) {
    value /= 1024;
    unit = units[i]!;
  }
  const text = value < 10 ? value.toFixed(1) : String(Math.round(value));
  return `${text} ${unit}`;
}

const regions =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

/**
 * The English name of a country by its ISO code ("DE" is "Germany"), or
 * the code where the browser has no name for it. For the statistics, Wrapped
 * and the search: here, where the app reaches it, so the two lazy bundles
 * share it without a chunk of their own (see build.js).
 */
export function countryDisplayName(code: string): string {
  try {
    return regions?.of(code) || code;
  } catch {
    return code;
  }
}
