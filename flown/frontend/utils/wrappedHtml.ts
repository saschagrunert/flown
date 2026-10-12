/**
 * HTML of the Wrapped dialog. Only the lazily loaded Wrapped bundle uses
 * these generators, so they live apart from utils/htmlGenerators, which the
 * main bundle carries and shares.
 */
import type { FilteredStatistics, FunFact, YearStats } from "../types";
import { METERS_TO_FEET } from "./constants";
import { formatNumber } from "./formatters";
import { escapeHtml, pluralFlights, type AirportCount } from "./htmlGenerators";
import { markFlightTimeUnits, splitAirportName } from "./statsFormat";
import { icon, type IconName } from "./icons";

/**
 * Section heading for a Wrapped card: line icon plus label. An h2 under
 * the dialog's h1, with the id `wrapped-<className>` its card is labelled
 * by (map_template.html), so the card is named what it shows.
 */
function wrappedSectionTitle(
  className: string,
  iconName: Parameters<typeof icon>[0],
  label: string,
): string {
  return (
    `<h2 id="wrapped-${className}" class="${className}">` +
    icon(iconName, 20) +
    '<span class="section-title-text">' +
    label +
    "</span></h2>"
  );
}

/**
 * One tile of the Wrapped stat grid. The unit is a separate element so it can
 * be typeset smaller than the display figure it belongs to.
 *
 * No space between the two in the markup: `.stat-unit` opens the gap with a
 * margin instead, one hairline of `--unit-gap` rather than a word space. The
 * h and m that markFlightTimeUnits marks up carry the same class and so get
 * the same gap, which is the point: "5,118.2 nm" beside "51h 38m" was two
 * treatments of the same thing.
 */
function statCard(value: string, unit: string, label: string): string {
  const unitHtml = unit
    ? '<span class="stat-unit">' + escapeHtml(unit) + "</span>"
    : "";
  return (
    '<div class="stat-card">' +
    '<div class="stat-value">' +
    escapeHtml(value) +
    unitHtml +
    "</div>" +
    '<div class="stat-label">' +
    label +
    "</div>" +
    "</div>"
  );
}

function flightTimeCard(flightTime: string): string {
  return (
    '<div class="stat-card">' +
    '<div class="stat-value">' +
    markFlightTimeUnits(flightTime, "stat-unit") +
    "</div>" +
    '<div class="stat-label">Flight time</div>' +
    "</div>"
  );
}

/**
 * Generate stats grid HTML
 */
export function generateStatsHtml(
  yearStats: YearStats,
  filteredStats: FilteredStatistics | null,
  hasTimingData: boolean,
): string {
  const maxAltitudeM = filteredStats?.max_altitude_m;

  return (
    statCard(formatNumber(yearStats.total_flights), "", "Flights") +
    statCard(formatNumber(yearStats.num_airports), "", "Airports") +
    // One decimal, like the statistics panel: the same figure reading 4746
    // here and 4745.5 there only makes the reader wonder which one is right
    statCard(formatNumber(yearStats.total_distance_nm, 1), "nm", "Distance") +
    (hasTimingData
      ? flightTimeCard(yearStats.flight_time) +
        statCard(
          formatNumber(filteredStats?.max_groundspeed_knots || 0),
          "kt",
          "Max groundspeed",
        )
      : "") +
    // Like the timing cards: no data, no card, rather than a figure of 0 ft
    (maxAltitudeM === undefined
      ? ""
      : statCard(
          formatNumber(maxAltitudeM * METERS_TO_FEET),
          "ft",
          "Max altitude (MSL)",
        ))
  );
}

/**
 * Generate fun facts HTML. The fact text is trusted markup (see FunFact);
 * only the category, which ends up in an attribute, is escaped here.
 */
/**
 * Icon for a fact that names none of its own. The facts used to carry an
 * emoji each, which put a second icon family (and a platform-dependent one)
 * inside a dialog that is otherwise drawn from `utils/icons`.
 */
const FACT_ICONS: Record<string, IconName> = {
  distance: "distance",
  aircraft: "aircraft",
  countries: "globe",
  altitude: "altitude",
  time: "clock",
  speed: "speed",
  achievement: "trophy",
};

export function generateFunFactsHtml(funFacts: FunFact[]): string {
  let html = wrappedSectionTitle("fun-facts-title", "wrapped", "Facts");
  for (const fact of funFacts) {
    const factIcon = fact.icon ?? FACT_ICONS[fact.category] ?? "wrapped";
    html += `<div class="fun-fact" data-category="${escapeHtml(fact.category)}"><span class="fun-fact-icon">${icon(factIcon, 20)}</span><span class="fun-fact-text">${fact.text.html}</span></div>`;
  }
  return html;
}

/**
 * Colour class of one fleet entry, from its flight count relative to the
 * busiest and the quietest aircraft of the same fleet. A fleet whose entries
 * all have the same count is drawn entirely in the strongest tint.
 */
export function calculateAircraftColorClass(
  flights: number,
  maxFlights: number,
  minFlights: number,
): string {
  if (maxFlights === minFlights) return "fleet-aircraft-high";

  const normalized = (flights - minFlights) / (maxFlights - minFlights);
  if (normalized >= 0.75) {
    return "fleet-aircraft-high"; // Most flights, the strongest tint
  } else if (normalized >= 0.5) {
    return "fleet-aircraft-medium-high";
  } else if (normalized >= 0.25) {
    return "fleet-aircraft-medium-low";
  } else {
    return "fleet-aircraft-low"; // Fewest flights, the faintest tint
  }
}

/**
 * Generate aircraft fleet HTML
 */
export function generateAircraftFleetHtml(yearStats: YearStats): string {
  if (!yearStats.aircraft_list || yearStats.aircraft_list.length === 0) {
    return "";
  }

  let html = wrappedSectionTitle("aircraft-fleet-title", "aircraft", "Fleet");

  const maxFlights = yearStats.aircraft_list[0]?.flights ?? 0;
  const minFlights =
    yearStats.aircraft_list[yearStats.aircraft_list.length - 1]?.flights ?? 0;

  for (const aircraft of yearStats.aircraft_list) {
    const modelStr = aircraft.model || aircraft.type || "";
    const colorClass = calculateAircraftColorClass(
      aircraft.flights,
      maxFlights,
      minFlights,
    );
    const flightTimeStr = aircraft.flight_time_str || "---";

    html +=
      '<div class="fleet-aircraft ' +
      colorClass +
      '">' +
      '<div class="fleet-aircraft-info">' +
      '<div class="fleet-aircraft-model">' +
      escapeHtml(modelStr) +
      "</div>" +
      '<div class="fleet-aircraft-registration">' +
      escapeHtml(aircraft.registration) +
      "</div>" +
      "</div>" +
      '<div class="fleet-aircraft-stats">' +
      '<div class="fleet-aircraft-flights">' +
      pluralFlights(aircraft.flights) +
      "</div>" +
      '<div class="fleet-aircraft-time">' +
      escapeHtml(flightTimeStr) +
      "</div>" +
      "</div>" +
      "</div>";
  }

  return html;
}

/**
 * Generate home base HTML
 * @param code - The airport's ICAO code, which the export writes
 */
export function generateHomeBaseHtml(
  homeBase: AirportCount,
  code?: string,
): string {
  const { code: shownCode, name } = splitAirportName(homeBase.name, code);
  const codeHtml = shownCode
    ? '<span class="top-airport-code">' + escapeHtml(shownCode) + "</span>"
    : "";

  return (
    wrappedSectionTitle("top-airports-title", "airport", "Home base") +
    '<div class="top-airport">' +
    '<div class="top-airport-name">' +
    codeHtml +
    '<span class="top-airport-place">' +
    escapeHtml(name) +
    "</span>" +
    "</div>" +
    '<div class="top-airport-count">' +
    pluralFlights(homeBase.flight_count) +
    "</div>" +
    "</div>"
  );
}

export interface DestinationsOptions {
  /** Resolve a country code to its display name */
  countryName: (code: string) => string;
  /** Resolve a country code to its flag, or null when the site has none */
  flagSrc: (code: string) => string | null;
  /** Resolve an airport to its ICAO code, which the export writes */
  airportCode: (name: string) => string | undefined;
  /** Airport that carries the home base accent */
  homeBase?: string | null;
  /** Airport furthest from the home base; carries the second accent */
  furthest?: string | null;
}

/** One airport row: code, name and at most one accent tag */
function destinationRow(
  name: string,
  airportCode: string | undefined,
  isHome: boolean,
  isFurthest: boolean,
): string {
  const { code, name: place } = splitAirportName(name, airportCode);
  const stateClass = isHome ? " is-home" : isFurthest ? " is-furthest" : "";
  const codeHtml = code
    ? '<span class="destination-code">' + escapeHtml(code) + "</span>"
    : "";
  const tag = isHome ? "Home" : isFurthest ? "Furthest" : "";
  const tagHtml = tag ? '<span class="destination-tag">' + tag + "</span>" : "";

  return (
    '<li class="destination' +
    stateClass +
    '">' +
    codeHtml +
    '<span class="destination-name">' +
    escapeHtml(place) +
    "</span>" +
    tagHtml +
    "</li>"
  );
}

/**
 * The mark beside a country's name: its flag where the site carries one
 * (`<prefix>-flag`), otherwise the ISO code as a chip (`<prefix>-code`).
 * Either is decoration, as the name beside it says the country: a flag
 * with the code for its text had a screen reader say "DE Germany". Never
 * an emoji flag: Windows ships no glyphs for them.
 */
export function countryMark(
  code: string,
  src: string | null,
  prefix: string,
  width: number,
  height: number,
): string {
  return src
    ? `<img class="${prefix}-flag" src="${escapeHtml(src)}" alt="" width="${width}" height="${height}" loading="lazy">`
    : `<span class="${prefix}-code" aria-hidden="true">${escapeHtml(code)}</span>`;
}

/**
 * The heading of one country's airports in a list grouped by country (the
 * statistics rail and Wrapped's destinations): its mark (see countryMark),
 * its name and how many airports, classed `<prefix>-name` and
 * `<prefix>-count`. The "Other" group has no mark.
 */
export function countryHeading(
  className: string,
  prefix: string,
  code: string,
  label: string,
  count: number,
  src: string | null,
  width: number,
  height: number,
): string {
  return (
    `<div class="${className}">` +
    (code === "Other" ? "" : countryMark(code, src, prefix, width, height)) +
    `<span class="${prefix}-name">${escapeHtml(label)}</span>` +
    `<span class="${prefix}-count">${count}</span></div>`
  );
}

export function generateDestinationsHtml(
  grouped: Map<string, string[]>,
  options: DestinationsOptions,
): string {
  if (grouped.size === 0) return "";

  const { countryName, flagSrc, airportCode, homeBase, furthest } = options;
  let html = wrappedSectionTitle(
    "airports-grid-title",
    "airport",
    "Destinations",
  );

  for (const [code, airports] of grouped) {
    html +=
      '<div class="country-group">' +
      countryHeading(
        "country-group-title",
        "country",
        code,
        code === "Other" ? code : countryName(code),
        airports.length,
        flagSrc(code),
        18,
        14,
      ) +
      '<ul class="country-airports">';
    for (const name of airports) {
      const isHome = !!homeBase && name === homeBase;
      const isFurthest = !isHome && !!furthest && name === furthest;
      html += destinationRow(name, airportCode(name), isHome, isFurthest);
    }
    html += "</ul></div>";
  }

  return html;
}
