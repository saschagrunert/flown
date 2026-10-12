/**
 * Wrapped/Year-in-Review functionality helpers
 * Generate year-end statistics and fun facts from flight data
 */

import { KM_TO_NAUTICAL_MILES } from "../utils/constants";
import { formatNumber } from "../utils/formatters";
import { pluralize } from "../utils/htmlGenerators";
import { formatFlightTime } from "../utils/statsFormat";
import { markup } from "../utils/markup";
import { countCountries } from "./countries";
import { calculateDistance, type Coordinate } from "../utils/geometry";
import type {
  AircraftModels,
  FilteredStatistics,
  FunFact,
  YearStats,
} from "../types";

/**
 * Find the airport furthest from the home base. Airports without known
 * coordinates are skipped; ties keep the first airport in the list.
 *
 * @param homeBase - Name of the home base airport
 * @param airportNames - Airports to consider
 * @param coordinates - Airport name to [lat, lon]
 * @returns Name of the furthest airport, or null when it cannot be determined
 */
export function findFurthestAirport(
  homeBase: string | null,
  airportNames: string[],
  coordinates: Map<string, Coordinate>,
): string | null {
  if (!homeBase) return null;
  const home = coordinates.get(homeBase);
  if (!home) return null;

  let furthest: string | null = null;
  let maxDistanceKm = 0;
  for (const name of airportNames) {
    if (name === homeBase) continue;
    const coords = coordinates.get(name);
    if (!coords) continue;
    const distanceKm = calculateDistance(home, coords);
    if (distanceKm > maxDistanceKm) {
      maxDistanceKm = distanceKm;
      furthest = name;
    }
  }

  return furthest;
}

/** The statistics of the selected year and aircraft the fun facts draw on */
type FunFactStats = Pick<
  FilteredStatistics,
  | "landings"
  | "total_altitude_gain_ft"
  | "total_flight_time_seconds"
  | "cruise_speed_knots"
  | "cruise_height_above_terrain"
  | "longest_flight_nm"
  | "max_altitude_ft"
  | "most_common_cruise_altitude_ft"
  | "most_common_cruise_altitude_m"
>;

/**
 * Well-known city pairs used to put the longest flight into perspective.
 * Distances are approximate great-circle distances in nautical miles.
 */
export const REFERENCE_DISTANCES: ReadonlyArray<{
  nm: number;
  label: string;
}> = [
  { nm: 83, label: "Frankfurt to Stuttgart" },
  { nm: 138, label: "Hamburg to Berlin" },
  { nm: 185, label: "London to Paris" },
  { nm: 274, label: "Berlin to Munich" },
  { nm: 475, label: "Paris to Berlin" },
  { nm: 620, label: "New York to Chicago" },
  { nm: 776, label: "London to Rome" },
  { nm: 1250, label: "Lisbon to Berlin" },
  { nm: 2140, label: "New York to Los Angeles" },
  { nm: 3010, label: "London to New York" },
];

/** Only compare when the reference is reasonably close to the actual value */
const REFERENCE_TOLERANCE = 0.25;

/**
 * Find the reference distance closest to the given distance, or null when
 * no reference is within the tolerance.
 */
export function findClosestReferenceDistance(
  distanceNm: number,
): { nm: number; label: string } | null {
  if (!(distanceNm > 0)) return null;

  let closest: { nm: number; label: string } | null = null;
  let closestDiff = Infinity;
  for (const ref of REFERENCE_DISTANCES) {
    const diff = Math.abs(ref.nm - distanceNm);
    if (diff < closestDiff) {
      closest = ref;
      closestDiff = diff;
    }
  }

  if (!closest || closestDiff / distanceNm > REFERENCE_TOLERANCE) return null;
  return closest;
}

/**
 * The figures of Wrapped's title card, of the paths the year and aircraft
 * filter keeps. They take the flights, the airports, the distance, the
 * flight time and the aircraft from `filtered`, the statistics of the same
 * filter, rather than walk the paths or every segment again for them.
 */
export function calculateYearStats(
  aircraftModels: AircraftModels,
  filtered: FilteredStatistics,
): YearStats {
  const totalDistanceNm = filtered.total_distance_km * KM_TO_NAUTICAL_MILES;
  const flightTime = formatFlightTime(filtered.total_flight_time_seconds ?? 0);
  // Copies: the model is added below, and the statistics are kept
  const aircraftList = filtered.aircraft_list.map((ac) => ({ ...ac }));

  // The full model name only comes from aircraft.json. An own-key lookup, so
  // a registration can never read something off the object prototype
  for (const ac of aircraftList) {
    const model = Object.hasOwn(aircraftModels, ac.registration)
      ? aircraftModels[ac.registration]
      : undefined;
    if (model) ac.model = model;
  }

  return {
    total_flights: filtered.num_paths,
    total_distance_nm: totalDistanceNm,
    num_airports: filtered.num_airports,
    airport_names: filtered.airport_names,
    flight_time: flightTime,
    aircraft_list: aircraftList,
  };
}

/**
 * The period a fact talks about: the selected year, or all of them. "This
 * year" read wrong in the All Years view and for any year but the current.
 */
function periodPhrase(year: string): string {
  return year === "all" ? "in total" : "in " + year;
}

/**
 * Generate fun facts from year statistics
 * @param yearStats - The Wrapped summary of the selected year and aircraft
 * @param filteredStats - The statistics of the same selection
 * @param year - The selected year, or "all"
 * @param newAreaKm2 - The area the year's flights passed over and none of
 * an earlier year did (see yearNewAreaKm2), where known
 */
export function generateFunFacts(
  yearStats: YearStats,
  filteredStats: FunFactStats | null = null,
  year: string = "all",
  newAreaKm2: number | null = null,
): FunFact[] {
  const facts: FunFact[] = [];
  const period = periodPhrase(year);

  if (newAreaKm2) {
    facts.push({
      icon: "milestone",
      text: markup`<strong>${formatNumber(newAreaKm2)} km²</strong> of new airspace ${period}, never flown in the years before.`,
      category: "explore",
      priority: 9,
    });
  }

  // Distance facts. The distance itself is a figure on the card above;
  // said again here it only repeated it.
  const distanceNm = yearStats.total_distance_nm;
  const earthCircumferenceNm = 21639; // Nautical miles

  if (distanceNm > earthCircumferenceNm * 0.5) {
    const ratio = (distanceNm / earthCircumferenceNm).toFixed(1);
    facts.push({
      icon: "earth",
      text: markup`You flew <strong>${ratio}x</strong> around the Earth!`,
      category: "distance",
      priority: 10,
    });
  }

  // Aircraft facts
  const numAircraft = yearStats.aircraft_list.length;
  const [onlyAircraft] = yearStats.aircraft_list;
  if (numAircraft === 1 && onlyAircraft) {
    // The list only has registered aircraft; flights without a registration
    // (some exports carry none) count in the year total but not here
    const model =
      onlyAircraft.model || onlyAircraft.type || onlyAircraft.registration;
    const registration = onlyAircraft.registration;
    const flights = onlyAircraft.flights;
    const plural = flights !== 1 ? "s" : "";
    // "All 1 flight" for a year of one
    if (flights > 1 && flights === yearStats.total_flights) {
      facts.push({
        icon: "aircraft",
        text: markup`Loyal to <strong>${registration}</strong>, all ${flights} flight${plural} in this ${model}!`,
        category: "aircraft",
        priority: 9,
      });
    } else {
      facts.push({
        icon: "aircraft",
        text: markup`<strong>${registration}</strong> took you on ${flights} flight${plural} in this ${model}.`,
        category: "aircraft",
        priority: 7,
      });
    }
  } else if (numAircraft === 2) {
    facts.push({
      icon: "aircraft",
      text: markup`You flew <strong>${numAircraft} different aircraft</strong> ${period}.`,
      category: "aircraft",
      priority: 7,
    });
  } else if (numAircraft >= 3) {
    facts.push({
      icon: "aircraft",
      text: markup`Aircraft explorer! You flew <strong>${numAircraft} different aircraft</strong>.`,
      category: "aircraft",
      priority: 8,
    });
  }

  // Country facts
  const numCountries = yearStats.airport_names
    ? countCountries(yearStats.airport_names).size
    : 0;
  if (numCountries >= 3) {
    facts.push({
      icon: "globe",
      text: markup`You flew to airports in <strong>${numCountries} countries</strong>.`,
      category: "countries",
      priority: 9,
    });
  } else if (numCountries === 2) {
    facts.push({
      icon: "globe",
      text: markup`You crossed borders, visiting <strong>2 countries</strong>.`,
      category: "countries",
      priority: 7,
    });
  }

  // Average distance per flight. Of a single flight it is the distance on
  // the card above, and so is its longest journey.
  const several = yearStats.total_flights > 1;
  const average =
    several && distanceNm > 0
      ? markup`<strong>${formatNumber(distanceNm / yearStats.total_flights, 1)} nm</strong>`
      : null;
  // The cruise speed only with timing data
  const cruise = filteredStats?.cruise_speed_knots;
  if (cruise) {
    const speed = markup`Cruising at <strong>${formatNumber(cruise)} kt</strong>`;
    facts.push({
      icon: "speed",
      text: average
        ? markup`${speed}, averaging ${average} per trip.`
        : markup`${speed}.`,
      category: "distance",
      priority: 8,
    });
  } else if (average) {
    facts.push({
      icon: "ruler",
      text: markup`Averaging ${average} per trip.`,
      category: "distance",
      priority: 8,
    });
  }

  if (filteredStats) {
    // Longest journey fact
    if (
      several &&
      filteredStats.longest_flight_nm &&
      filteredStats.longest_flight_nm > 0
    ) {
      const longestNm = filteredStats.longest_flight_nm;
      const reference = findClosestReferenceDistance(longestNm);
      const comparison = reference
        ? `, about the distance from ${reference.label}`
        : "";
      facts.push({
        icon: "milestone",
        text: markup`Your longest journey: <strong>${formatNumber(longestNm, 1)} nm</strong>${comparison}.`,
        category: "distance",
        priority: 8,
      });
    }

    // Altitude facts
    if (filteredStats.total_altitude_gain_ft) {
      const totalGainFt = filteredStats.total_altitude_gain_ft;
      facts.push({
        icon: "climb",
        text: markup`Total elevation gain: <strong>${formatNumber(totalGainFt)} ft</strong>.`,
        category: "altitude",
        priority: 8,
      });

      const everestFt = 29029;
      if (filteredStats.total_altitude_gain_ft > everestFt) {
        const ratio = (
          filteredStats.total_altitude_gain_ft / everestFt
        ).toFixed(1);
        facts.push({
          icon: "altitude",
          text: markup`You climbed <strong>${ratio}x</strong> Mount Everest in altitude!`,
          category: "altitude",
          priority: 9,
        });
      }
    }

    // Most common cruise altitude
    if (
      filteredStats.most_common_cruise_altitude_ft &&
      filteredStats.most_common_cruise_altitude_m
    ) {
      const cruiseAltFt = filteredStats.most_common_cruise_altitude_ft;
      const cruiseAltM = filteredStats.most_common_cruise_altitude_m;
      // Above the field where a flight had no terrain in the export
      const reference =
        filteredStats.cruise_height_above_terrain === false
          ? "above the field"
          : "AGL";
      facts.push({
        icon: "ruler",
        text: markup`Most common cruise: <strong>${formatNumber(cruiseAltFt)} ft</strong> ${reference} (<strong>${formatNumber(cruiseAltM)} m</strong>).`,
        category: "altitude",
        priority: 7,
      });
    }

    landingFacts(facts, filteredStats, period);

    // Time facts (lower priority - time is shown in stats cards above)
    if (filteredStats.total_flight_time_seconds) {
      const seconds = filteredStats.total_flight_time_seconds;
      // Under an hour, whole hours would read "0 hours in the air"; one
      // hour is not "1 hours"
      const duration =
        seconds >= 3600
          ? pluralize(Math.floor(seconds / 3600), "hour")
          : formatFlightTime(seconds);
      facts.push({
        icon: "clock",
        text: markup`Total flight time: <strong>${duration}</strong> in the air!`,
        category: "time",
        priority: 4,
      });
    }

    // Achievement facts
    if (
      filteredStats.max_altitude_ft &&
      filteredStats.max_altitude_ft > 40000
    ) {
      facts.push({
        icon: "trophy",
        text: markup`High altitude achievement: <strong>${formatNumber(filteredStats.max_altitude_ft)} feet</strong>!`,
        category: "achievement",
        priority: 9,
      });
    }
  }

  // Select diverse facts
  return selectDiverseFacts(facts);
}

/**
 * The facts of the landings: the touch-and-goes of the period, the most of
 * them in one flight and the runway used most. Counts only: when any of
 * them happened is nobody's business.
 */
function landingFacts(
  facts: FunFact[],
  stats: FunFactStats,
  period: string,
): void {
  const landings = stats.landings;
  if (!landings) return;
  const { touchAndGoes, mostTouchAndGoes } = landings;
  if (touchAndGoes > 1) {
    const inOne =
      mostTouchAndGoes > 1 && mostTouchAndGoes < touchAndGoes
        ? markup`, <strong>${formatNumber(mostTouchAndGoes)}</strong> of them in one flight`
        : "";
    facts.push({
      icon: "airport",
      text: markup`<strong>${formatNumber(touchAndGoes)} touch-and-goes</strong> ${period}${inOne}.`,
      category: "landings",
      priority: 9,
    });
  }
  const busiest = landings.busiestRunway;
  if (busiest && busiest.share < 1) {
    facts.push({
      icon: "compass",
      text: markup`Favourite runway: <strong>RWY ${busiest.runway}</strong> at ${busiest.airport}, ${Math.round(busiest.share * 100)}% of the touchdowns there.`,
      category: "landings",
      priority: 6,
    });
  }
}

/**
 * Select diverse facts with priority and category limits
 */
export function selectDiverseFacts(allFacts: FunFact[]): FunFact[] {
  if (allFacts.length === 0) {
    return [];
  }

  // Sort by priority descending
  const sortedFacts = [...allFacts].sort((a, b) => b.priority - a.priority);

  // Select facts with category limit
  const selected: FunFact[] = [];
  const categoryCount: Record<string, number> = {};
  const maxPerCategory = 3; // Allow up to 3 facts per category
  const minFacts = 4;
  const maxFacts = 6;

  for (const fact of sortedFacts) {
    const count = categoryCount[fact.category] || 0;
    if (count < maxPerCategory) {
      selected.push(fact);
      categoryCount[fact.category] = count + 1;
    }

    if (selected.length >= maxFacts) {
      break;
    }
  }

  // Ensure at least minFacts if available
  if (selected.length < minFacts && allFacts.length >= minFacts) {
    // Add more facts without category limit to reach minimum
    for (const fact of sortedFacts) {
      if (!selected.includes(fact)) {
        selected.push(fact);
        if (selected.length >= minFacts) {
          break;
        }
      }
    }
  }

  return selected;
}
