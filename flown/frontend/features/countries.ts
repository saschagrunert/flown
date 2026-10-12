/**
 * The countries of the airports, for the statistics rail and Wrapped: the
 * flag of a country and the airports grouped or counted by theirs (its
 * name is utils/formatters.ts's countryDisplayName, which the search uses
 * as well). Only the Wrapped bundle shows them, so they are kept out of
 * features/airports.ts, which the map draws its markers with on the first
 * visit.
 */
import { getAirportsByName } from "./airports";
import { siteData } from "../state/siteData";

/**
 * Path to a country's flag, relative to the page, or null when this site
 * does not carry it.
 *
 * The export lists what it published: the flags are copied per site for the
 * countries actually visited, and a build without them (the wheel leaves
 * them out) lists none, which is the caller's cue to fall back to the code.
 */
export function countryFlagSrc(code: string): string | null {
  const available = siteData.metadata?.available_flags;
  const lower = code.toLowerCase();
  return available?.includes(lower) ? `flags/${lower}.svg` : null;
}

export function countCountries(airportNames: string[]): Set<string> {
  const countries = new Set<string>();
  const map = getAirportsByName();

  for (const name of airportNames) {
    const country = map.get(name)?.country;
    if (country) countries.add(country);
  }
  return countries;
}

export function groupByCountry(airportNames: string[]): Map<string, string[]> {
  const map = getAirportsByName();
  const groups = new Map<string, string[]>();

  for (const name of airportNames) {
    const key = map.get(name)?.country || "Other";
    const list = groups.get(key);
    if (list) {
      list.push(name);
    } else {
      groups.set(key, [name]);
    }
  }

  return groups;
}
