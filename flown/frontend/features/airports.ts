/**
 * Airport management functionality
 * Pure helpers for airport data, flight counting and visibility
 */

import type { Airport, PathInfo } from "../types";
import { siteData } from "../state/siteData";
import { NAUTICAL_MILES_TO_KM } from "../utils/constants";

/** Class of the element MapLibre positions */
export const AIRPORT_MARKER_CLASS = "airport-marker-root";

/** Class of the button round an airport's dot */
const DOT_CONTROL_CLASS = "airport-marker-container";

/**
 * Build the element of an airport marker, which MapLibre positions, around
 * the two parts of it that may take the pointer and the focus: a button
 * round the dot, and the chip of its ICAO code, on a stem where there is
 * room (see ui/airportLabels.ts). One of them at a time is the airport's
 * target (setAirportTarget); a press on the other part, where it takes
 * one, is a press on the airport as well.
 *
 * The button is a 24px square around a dot a third that size: the dot is
 * what is drawn, the square is what a finger has to hit. WCAG asks for 24,
 * and where airports lie closer than that the square of the one that
 * places its code first keeps it, and the other's code takes its place.
 * @param name - Airport name
 * @param code - The code it shows
 * @param isHomeBase - Whether the airport is the current home base
 */
export function createAirportElement(
  name: string,
  code: string,
  isHomeBase = false,
): HTMLElement {
  const root = document.createElement("div");
  root.className = AIRPORT_MARKER_CLASS;
  const button = document.createElement("button");
  button.type = "button";
  button.className = DOT_CONTROL_CLASS;
  // The name a pointer reads and the name a screen reader announces; the
  // label on the map is only the code
  button.title = name;
  button.setAttribute("aria-label", name);
  // It opens and closes the airport's popup; AirportManager keeps this true
  button.setAttribute("aria-expanded", "false");
  const dot = document.createElement("span");
  dot.className = "airport-marker";
  button.append(dot);
  root.append(button, createCodeElement(code));

  if (isHomeBase) setAirportElementHome(root, true);
  return root;
}

/**
 * An airport's code, for its marker: a chip at the end of an arm, with the
 * stem from the dot, left out until it is placed (see
 * ui/airportLabels.ts). Hidden from assistive technology while the button
 * round the dot is the airport's target, which is named after it.
 */
export function createCodeElement(code: string): HTMLElement {
  const arm = document.createElement("span");
  arm.className = "airport-code-arm is-hidden";
  arm.setAttribute("aria-hidden", "true");
  const stem = document.createElement("span");
  stem.className = "airport-code-stem";
  const chip = document.createElement("span");
  chip.className = "airport-code";
  const face = document.createElement("span");
  face.className = "airport-code-face";
  face.textContent = code;
  chip.append(face);
  arm.append(stem, chip);
  return arm;
}

/** The parts of an airport's marker that may take the pointer */
function parts(
  root: HTMLElement,
): { dot: HTMLElement; chip: HTMLElement } | null {
  const dot = root.querySelector<HTMLElement>("." + DOT_CONTROL_CLASS);
  const chip = root.querySelector<HTMLElement>(".airport-code");
  return dot && chip ? { dot, chip } : null;
}

/**
 * What of an airport's marker takes the focus and is announced: the chip
 * of its code where that is its target, the button round its dot otherwise
 */
export function airportControl(root: HTMLElement): HTMLElement {
  const found = parts(root);
  if (!found) return root;
  return found.chip.getAttribute("role") === "button" ? found.chip : found.dot;
}

/**
 * Tell assistive technology whether an airport's popup is open, on its
 * button and on its chip while that is a button
 */
export function setAirportExpanded(
  root: HTMLElement,
  expanded: boolean,
  controls: string,
): void {
  const found = parts(root);
  if (!found) return;
  for (const element of [found.dot, found.chip]) {
    if (element === found.chip && element.getAttribute("role") !== "button") {
      element.removeAttribute("aria-expanded");
      element.removeAttribute("aria-controls");
      continue;
    }
    element.setAttribute("aria-expanded", String(expanded));
    if (expanded) element.setAttribute("aria-controls", controls);
    else element.removeAttribute("aria-controls");
  }
}

/** Where an airport's marker takes the pointer and the focus */
export interface AirportTarget {
  /**
   * The chip of its code: a neighbour's square lies too close to its dot
   * for a square of its own, and its code is drawn
   */
  chip: boolean;
  /**
   * Half the square round its dot, in pixels: smaller than the full one
   * where a neighbour's lies close and there is no chip to take its place;
   * null for the full square
   */
  half: number | null;
  /** Neither: a panel lies over its dot */
  out: boolean;
}

/**
 * Make one part of an airport's marker its target (AirportTarget): that one
 * takes the pointer, the focus and the airport's name, the other none of
 * them (inert, which only this sets on these parts; dialogs make the whole
 * marker inert). The focus goes along to the new target.
 */
export function setAirportTarget(
  root: HTMLElement,
  { chip, half, out }: AirportTarget,
): void {
  const found = parts(root);
  if (!found) return;
  const { dot, chip: code } = found;
  const useChip = chip && !out;
  const was = airportControl(root);
  const focused = document.activeElement === was;
  const arm = code.parentElement;
  if (useChip) {
    code.setAttribute("role", "button");
    code.tabIndex = 0;
    code.setAttribute("aria-label", dot.getAttribute("aria-label") ?? "");
    code.title = dot.title;
    arm?.removeAttribute("aria-hidden");
    const expanded = dot.getAttribute("aria-expanded") === "true";
    const controls = dot.getAttribute("aria-controls");
    code.setAttribute("aria-expanded", String(expanded));
    if (controls) code.setAttribute("aria-controls", controls);
  } else if (code.hasAttribute("role")) {
    for (const name of [
      "role",
      "tabindex",
      "aria-label",
      "title",
      "aria-expanded",
      "aria-controls",
    ]) {
      code.removeAttribute(name);
    }
    arm?.setAttribute("aria-hidden", "true");
  }
  const now = useChip ? code : dot;
  if (focused && now !== was) now.focus({ preventScroll: true });
  setInert(dot, useChip || out);
  setInert(code, out);
  if (half === null || useChip) root.style.removeProperty("--marker-target");
  else root.style.setProperty("--marker-target", `${2 * half}px`);
}

function setInert(element: HTMLElement, inert: boolean): void {
  if (element.hasAttribute("inert") !== inert) {
    element.toggleAttribute("inert", inert);
  }
}

/** Activate the chip of an airport's code from the keyboard, as a button */
export function onChipKey(event: KeyboardEvent): void {
  const chip = event.target as HTMLElement | null;
  if (chip?.getAttribute("role") !== "button") return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  chip.click();
}

/**
 * The airport whose code a press on a marker hit, when that is another's:
 * a code drawn into the square of another airport's marker would give it
 * its press (ui/airportLabels.ts keeps them apart). Null for a press on
 * the marker itself: on its dot, on its code, or from the keyboard (no
 * place on the screen).
 */
export function codeOwnerAt(
  event: MouseEvent,
  element: HTMLElement,
): string | null {
  const target = event.target as Element | null;
  if (event.detail === 0 || target?.closest(".airport-code")) return null;
  for (const hit of document.elementsFromPoint?.(
    event.clientX,
    event.clientY,
  ) ?? []) {
    if (hit.classList.contains("airport-marker") && element.contains(hit)) {
      return null;
    }
    const owner = hit
      .closest(".airport-code")
      ?.closest<HTMLElement>("." + AIRPORT_MARKER_CLASS);
    if (owner && owner !== element) {
      return (
        owner
          .querySelector("." + DOT_CONTROL_CLASS)
          ?.getAttribute("aria-label") ?? null
      );
    }
  }
  return null;
}

/**
 * Style a marker element as the home base, or as any other airport: its dot
 * and its code. The element stays the same, so its focus and its listeners
 * survive a change of home base.
 */
export function setAirportElementHome(
  element: HTMLElement,
  isHomeBase: boolean,
): void {
  element.classList.toggle("is-home", isHomeBase);
  element
    .querySelector(".airport-marker")
    ?.classList.toggle("airport-marker-home", isHomeBase);
}

let _airportsByName: Map<string, Airport> | null = null;
/** The airport list the map was built from */
let _airportsSource: readonly Airport[] | null = null;

/**
 * Airports by name, from the airport list the page holds. The map follows
 * the list: airports.json may arrive after the first lookup (the loader
 * fetches it while the app starts), and a list loaded later replaces an
 * earlier one. The countries of the airports (features/countries.ts) read
 * the same map.
 */
export function getAirportsByName(): Map<string, Airport> {
  const kmlAirports = siteData.airports;
  if (_airportsByName && kmlAirports === _airportsSource) {
    return _airportsByName;
  }
  _airportsByName = new Map(kmlAirports?.map((a) => [a.name, a]));
  _airportsSource = kmlAirports;
  return _airportsByName;
}

/**
 * The ICAO code of an airport, as the export found it in the name
 * (airports.json's `code`, from airport_icao_code in
 * flown/airport_lookup.py, which also merges the airports by it);
 * undefined for a name without one. The names of path_info are those of
 * the airports, so this answers for either.
 */
export function airportCode(name: string): string | undefined {
  return getAirportsByName().get(name)?.code;
}

/*
 * How the lists name a flight, by the codes of its airports: the flight
 * list of the statistics rail (ui/flightList.ts), the list of an airport's
 * popup (ui/airportFlights.ts), the replay and the flight profile. Here, in
 * the app, as the bundles of those share no module of their own: one that
 * only lazy bundles shared would get a chunk of its own, which the site
 * does not publish.
 */

/** An airport as a list names it: its code where it has one */
function routeEnd(label = "?"): string {
  return airportCode(label) ?? label;
}

/**
 * A flight's route by the codes of its airports ("EDAQ → EDDP"), the way
 * the airport popup's list and the flight list of the statistics rail name
 * it
 */
export function flightRoute(path: PathInfo): string {
  return routeEnd(path.start_airport) + " → " + routeEnd(path.end_airport);
}

/**
 * How a list names a flight: its route, aircraft, year and the `km` it
 * covered, in nautical miles. The airport popup's rows and the checkboxes
 * of both lists say it, so a row is not one of several "EDXX → EDXX"
 * circuits of one aircraft alike.
 */
export function flightLabel(path: PathInfo, km = 0): string {
  // Under half a mile says nothing a row could tell apart: none rather
  // than "0 nm"
  const nm = Math.round(km / NAUTICAL_MILES_TO_KM);
  return [
    flightRoute(path),
    path.aircraft_registration,
    path.year,
    nm && nm + " nm",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The checkbox of a listed flight, which adds it to the selection or takes
 * it out, while the rest of its row picks it alone (see
 * PathSelection.pickFromList). Named after the flight by `label`, which is
 * escaped already. The airport popup's list and the flight list of the
 * statistics rail have one per row. In a label, which a finger's
 * stylesheet widens around the box: a tap that missed it by a few pixels
 * picked the flight alone and dropped the rest of the selection.
 */
export function pickBox(id: number, label: string): string {
  return (
    '<label class="pick-hit"><input type="checkbox" class="pick-box" data-path-id="' +
    id +
    '" aria-label="Select ' +
    label +
    '"></label>'
  );
}

/**
 * Airport flight counts
 */
export interface AirportCounts {
  [airportName: string]: number;
}

/**
 * Calculate airport flight counts of paths (those a filter keeps: see
 * FilterView.airportCounts)
 * @param paths - Array of path info objects
 * @returns Map of airport name to flight count
 */
export function calculateAirportFlightCounts(
  paths: readonly PathInfo[],
): AirportCounts {
  // No prototype: an airport name is data, and "constructor" is no key
  const counts = Object.create(null) as AirportCounts;

  // Count unique airports per flight (avoid double-counting round trips)
  for (const path of paths) {
    const uniqueAirports = new Set<string>();
    if (path.start_airport) {
      uniqueAirports.add(path.start_airport);
    }
    if (path.end_airport) {
      uniqueAirports.add(path.end_airport);
    }
    for (const airport of uniqueAirports) {
      counts[airport] = (counts[airport] || 0) + 1;
    }
  }

  return counts;
}

/**
 * Find the home base airport (most visited)
 * @param airportCounts - Map of airport name to count
 * @returns Home base airport name or null
 */
export function findHomeBase(airportCounts: AirportCounts): string | null {
  let homeBaseName: string | null = null;
  let maxCount = 0;

  for (const [name, count] of Object.entries(airportCounts)) {
    if (count > maxCount) {
      maxCount = count;
      homeBaseName = name;
    }
  }

  return homeBaseName;
}

/**
 * Determine which airports are visible for the current filter and selection.
 *
 * - no filter and no share mode: every airport (returns null)
 * - year/aircraft filter: airports touched by matching paths
 * - selection: airports of the selected paths are added, so a selection
 *   never hides an airport the filter shows (with or without a filter)
 * - share mode: only airports of the selected paths
 * @param filtered - The paths the year/aircraft filter keeps, null for none
 * @param selectedPathIds - The selected paths the filter shows (share mode
 *   keeps the ones it hides, whose airports are not to show either)
 * @param isolateSelection - Whether the selection is shared, which the
 *   store ends with the last flight
 * @param pathInfoById - The paths of the dataset by id
 * @returns Set of visible airport names, or null when all are visible
 */
export function calculateVisibleAirports(
  filtered: readonly PathInfo[] | null,
  selectedPathIds: ReadonlySet<number>,
  isolateSelection: boolean,
  pathInfoById: ReadonlyMap<number, PathInfo>,
): Set<string> | null {
  if (!filtered && !isolateSelection) return null;

  const visible = new Set<string>();
  const add = (info: PathInfo | undefined): void => {
    if (info?.start_airport) visible.add(info.start_airport);
    if (info?.end_airport) visible.add(info.end_airport);
  };
  // Share mode ignores filter-only airports
  if (filtered && !isolateSelection) filtered.forEach(add);
  for (const pathId of selectedPathIds) add(pathInfoById.get(pathId));
  return visible;
}
