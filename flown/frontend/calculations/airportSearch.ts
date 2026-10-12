/**
 * The site's own airports for the search of places (ui/locationSearch.ts),
 * found as the visitor types and without asking any server: airports.json
 * is on the page already, so they are matched here, offline and on every
 * keystroke, and listed ahead of what the geocoder finds.
 *
 * An airport answers to its ICAO code, to its name and to the name or code
 * of its country, without regard to case or accents ("zurich" finds
 * "Zürich"). How well it answers decides the order: the code typed in full
 * first, then a code that starts with what was typed, a name that does, a
 * word of the name that does, every word typed starting a word of the
 * airport (its name, code or country, in any order, so "stuttgart germany"
 * and "germany" find it), and last what is only somewhere inside the name.
 * Among equals the shorter name goes first, then the alphabet.
 */
import type { Airport } from "../types";
import { countryDisplayName } from "../utils/formatters";

/** How many airports the search lists at most */
export const AIRPORT_RESULTS = 5;

/** How an airport answers a query, best first (see the module comment) */
const AIRPORT_RANK = {
  code: 0,
  codeStart: 1,
  nameStart: 2,
  wordStart: 3,
  allWords: 4,
  inside: 5,
} as const;

/**
 * The letters of names that are no letter and an accent, which NFD leaves
 * whole: "Łódź" is found as "lodz", "København" as "kobenhavn"
 */
const LETTERS: Readonly<Record<string, string>> = {
  ø: "o",
  æ: "ae",
  œ: "oe",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ß: "ss",
  ı: "i",
  ħ: "h",
};

/** Lower case and without accents, so "Zürich" is found as "zurich" */
export function foldText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[øæœłđðþßıħ]/g, (letter) => LETTERS[letter]!)
    .trim();
}

/** The words of a text, split at anything but a letter or a digit */
function wordsOf(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** What an airport is searched by, folded once per list of airports */
interface Searchable {
  airport: Airport;
  name: string;
  code: string;
  nameWords: string[];
  /** The words of its name, its code, its country's code and name */
  allWords: string[];
}

/** The searchable airports of the last list they were made for */
let indexed: { source: readonly Airport[]; entries: Searchable[] } | null =
  null;

function searchable(airports: readonly Airport[]): Searchable[] {
  if (indexed?.source === airports) return indexed.entries;
  const entries = airports.map((airport) => {
    const name = foldText(airport.name);
    const code = foldText(airport.code ?? "");
    const nameWords = wordsOf(name);
    const country = airport.country
      ? [airport.country, countryDisplayName(airport.country)]
      : [];
    return {
      airport,
      name,
      code,
      nameWords,
      allWords: [
        ...nameWords,
        ...(code ? [code] : []),
        ...wordsOf(foldText(country.join(" "))),
      ],
    };
  });
  indexed = { source: airports, entries };
  return entries;
}

/**
 * How well an airport answers a folded query (see foldText) and its words,
 * as one of AIRPORT_RANK, or null when it does not at all
 */
function rankOf(
  entry: Searchable,
  query: string,
  typed: readonly string[],
): number | null {
  if (entry.code && entry.code === query) return AIRPORT_RANK.code;
  if (entry.code.startsWith(query)) return AIRPORT_RANK.codeStart;
  if (entry.name.startsWith(query)) return AIRPORT_RANK.nameStart;
  if (entry.nameWords.some((word) => word.startsWith(query))) {
    return AIRPORT_RANK.wordStart;
  }
  if (
    typed.length > 0 &&
    typed.every((word) => entry.allWords.some((own) => own.startsWith(word)))
  ) {
    return AIRPORT_RANK.allWords;
  }
  return entry.name.includes(query) ? AIRPORT_RANK.inside : null;
}

/**
 * Whether `query` is the code or the whole name of one of the `airports`:
 * the search has found it, and asks the geocoder nothing about it
 */
export function namesAirport(
  airports: readonly Airport[],
  query: string,
): boolean {
  const folded = foldText(query);
  return searchable(airports).some(
    (entry) => entry.code === folded || entry.name === folded,
  );
}

/**
 * The airports that answer `query`, best first, at most `limit` of them;
 * none for a query of nothing but spaces
 */
export function matchAirports(
  airports: readonly Airport[],
  query: string,
  limit = AIRPORT_RESULTS,
): Airport[] {
  const folded = foldText(query);
  if (!folded) return [];
  // Once per query rather than once per airport
  const typed = wordsOf(folded);
  const ranked: { entry: Searchable; rank: number }[] = [];
  for (const entry of searchable(airports)) {
    const rank = rankOf(entry, folded, typed);
    if (rank !== null) ranked.push({ entry, rank });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.entry.name.length - b.entry.name.length ||
      a.entry.name.localeCompare(b.entry.name),
  );
  return ranked.slice(0, limit).map(({ entry }) => entry.airport);
}
