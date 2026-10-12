/**
 * What the statistics rail and Wrapped format that the map does not: the
 * build date, an airport label split into its code and its name, and the
 * units of a flight time. Only the Wrapped bundle prints them, so they are
 * kept out of formatters.ts and htmlGenerators.ts, which the first visit
 * carries.
 */
import { escapeHtml } from "./htmlGenerators";

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * Format the build date map_config.js carries (e.g., "21 Sep 2026"). In
 * English, so every viewer reads the same text. The build carries no time
 * of day, which would tell when a flight just before it ended.
 * @param iso - "YYYY-MM-DD", the day in UTC
 * @returns Formatted date, or null when the value is not one
 */
export function formatBuildDate(iso: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;
  const [, year, month, day] = match;
  const monthName = MONTHS[Number(month) - 1];
  if (!monthName) return null;
  return `${Number(day)} ${monthName} ${year}`;
}

/** An airport label split into its ICAO code and its name */
export interface AirportLabel {
  /** ICAO/IATA style code, empty when the label carries none */
  code: string;
  /** Airport name without the leading code */
  name: string;
}

/**
 * Split a label such as "EDAQ Halle-Oppin" into its code and its name so the
 * two can be typeset differently. The code is the airport's own, which the
 * export writes (see airportCode in features/airports.ts) rather than one
 * guessed from the label here. A label that does not lead with it, or is
 * nothing else, keeps its full text as the name.
 */
export function splitAirportName(label: string, code?: string): AirportLabel {
  const trimmed = label.trim();
  if (code && trimmed.startsWith(code + " ")) {
    const name = trimmed.slice(code.length + 1).trim();
    if (name) return { code, name };
  }
  return { code: "", name: trimmed };
}

/** The two surfaces that set a unit in small muted type */
export type UnitClass = "stat-unit" | "kh-stats-lead-unit";

/**
 * Mark the h and m of a flight time as units.
 *
 * Every other lead figure sets its unit in the small muted type ("4,745.5
 * nm"), so "47h 44m" has to do the same rather than shouting both letters at
 * full weight. The class differs per surface, hence the parameter, which is a
 * closed set rather than a string: it lands inside a class attribute, and a
 * caller reaching this with something it read from the data would be writing
 * markup through it.
 *
 * @param flightTime - Formatted time, e.g. "47h 44m"
 * @param unitClass - Class the h and m are wrapped in
 */
export function markFlightTimeUnits(
  flightTime: string,
  unitClass: UnitClass,
): string {
  return escapeHtml(flightTime).replace(
    /(\d+)\s*(h)\s*(\d+)\s*(m)/,
    (_match, hours: string, hourUnit: string, mins: string, minUnit: string) =>
      hours +
      '<span class="' +
      unitClass +
      '">' +
      hourUnit +
      "</span> " +
      mins +
      '<span class="' +
      unitClass +
      '">' +
      minUnit +
      "</span>",
  );
}

/**
 * Format seconds into flight time string (e.g., "2h 30m")
 * @param seconds - Total seconds
 * @returns Formatted flight time
 */
export function formatFlightTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}
