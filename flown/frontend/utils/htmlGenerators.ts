/**
 * HTML generation utilities for UI components
 * Pure functions that generate HTML strings
 *
 * Two spellings, split on purpose: a self-contained block of markup is a
 * template literal so the tags stay indented and readable, and markup
 * assembled a piece at a time from conditionals and loops is concatenated,
 * where a literal would need a `${}` around every fragment.
 */
import type { Range } from "../state/store";
import type { PathSegment } from "../types";
import { getColorForAirspeed, getColorForAltitude, rgbToRgba } from "./colors";
import { FEET_TO_METERS, NAUTICAL_MILES_TO_KM } from "./constants";
import { formatNumber, formatTrack } from "./formatters";
import { calculateBearing, ddToDms, type Coordinate } from "./geometry";
import { escapeHtml } from "./escape";
import { icon, type IconName } from "./icons";

export { escapeHtml } from "./escape";

/**
 * A count with its noun, pluralised: `pluralize(1, "flight")` is "1 flight",
 * `pluralize(2, "flight")` is "2 flights", and `pluralize(44143, "point")`
 * is "44,143 points", grouped like every other figure of the page.
 *
 * @param count - The number to render
 * @param singular - Noun in its singular form
 * @param plural - Plural form when appending an "s" does not produce it
 */
export function pluralize(
  count: number,
  singular: string,
  plural: string = singular + "s",
): string {
  return formatNumber(count) + " " + (count === 1 ? singular : plural);
}

/** "1 flight" or "12 flights" for a count */
export function pluralFlights(count: number): string {
  return pluralize(count, "flight");
}

export interface AirportCount {
  name: string;
  flight_count: number;
}

export interface AirportPopupParams {
  name: string;
  lat: number;
  lon: number;
  latDms: string;
  lonDms: string;
  flightCount: number;
  isHomeBase: boolean;
}

/** The airport popup, which its marker's aria-controls names while open */
export const AIRPORT_POPUP_ID = "airport-popup";

/**
 * Generate airport marker popup HTML. The container takes focus when a
 * keyboard opens the popup, and is named after the airport, so that the
 * focus lands on something a screen reader can name; the flight list is
 * added when it is shown (see ui/airportFlights.ts). Its count is of the
 * flights the filter shows, not of every flight there.
 */
export function generateAirportPopupHtml(params: AirportPopupParams): string {
  const googleMapsLink = `https://www.google.com/maps?q=${params.lat},${params.lon}`;
  const homeBadge = params.isHomeBase
    ? '<span class="kh-popup-home-badge">HOME</span>'
    : "";

  return `
    <div id="${AIRPORT_POPUP_ID}" class="popup-container kh-popup-airport" tabindex="-1" role="group" aria-label="${escapeHtml(params.name || "Unknown")}">
        <div class="popup-header kh-popup-header-airport${params.isHomeBase ? " kh-popup-header-home" : ""}">
            <span class="popup-header-icon">${icon("airport", 20)}</span>
            <span>${escapeHtml(params.name || "Unknown")}</span>
            ${homeBadge}
        </div>
        <div class="kh-popup-block">
            <div class="popup-section-label">Coordinates</div>
            <a href="${googleMapsLink}"
               target="_blank"
               rel="noopener noreferrer"
               class="kh-popup-link">
                <span>${params.latDms}<br>${params.lonDms}</span>
                ${icon("externalLink", 16, "Opens Google Maps in a new tab")}
            </a>
        </div>
        <div class="popup-metric kh-popup-metric-flights">
            <span class="kh-popup-metric-label">Flights shown</span>
            <span class="popup-metric-value kh-popup-accent">${params.flightCount}</span>
        </div>
    </div>`;
}

export interface SegmentPopupParams {
  segment: PathSegment;
  /** Position to show; the segment's end point when not given */
  position?: Coordinate;
  /** The colour ranges the segment is coloured on, as on the map */
  altRange: Range;
  speedRange: Range;
  title?: string;
  icon?: IconName;
}

/**
 * Generate path segment popup HTML with position, altitude, and groundspeed.
 * The data-driven altitude/speed colours travel as `data-metric-color`; the
 * CSP allows no style attribute, so applyMetricColors() carries them into
 * the custom properties `.kh-popup-metric-colored` reads. A segment without
 * a speed (0, a log without timing) shows none rather than 0 kt.
 */
export function generateSegmentPopupHtml(params: SegmentPopupParams): string {
  const { segment } = params;
  const title = params.title || "On this flight";
  const headerIcon = params.icon ?? "aircraft";

  const altFt = segment.altitude_ft;
  const altFtRounded = Math.round(altFt / 50) * 50;
  const altMRounded = altFtRounded * FEET_TO_METERS;
  const alt = params.altRange;
  const altColor = getColorForAltitude(altFt, alt.min, alt.max, alt.ranks);

  const [startCoord, endCoord] = segment.coords;
  const shown = params.position ?? endCoord;
  const lat = ddToDms(shown[0], true);
  const lon = ddToDms(shown[1], false);
  const trackStr = formatTrack(
    calculateBearing(startCoord[0], startCoord[1], endCoord[0], endCoord[1]),
  );

  return `
    <div class="popup-container">
        <div class="popup-header kh-popup-header-segment">
            <span class="popup-header-icon">${icon(headerIcon, 20)}</span>
            <span>${escapeHtml(title)}</span>
        </div>
        <div class="popup-coords kh-popup-block">
            ${lat} ${lon}<br><span class="kh-popup-track">Track: ${trackStr}</span>
        </div>
        <div class="kh-popup-block">
            <div class="popup-section-label">Altitude (MSL)</div>
            <div class="popup-metric kh-popup-metric-colored" data-metric-color="${altColor}">
                <span class="popup-metric-value">${formatNumber(altFtRounded)} ft</span>
                <span class="popup-metric-unit">(${formatNumber(altMRounded)} m)</span>
            </div>
        </div>${speedBlock(params)}
    </div>`;
}

/** The groundspeed of a segment popup, empty for a segment without one */
function speedBlock(params: SegmentPopupParams): string {
  const speedKt = params.segment.groundspeed_knots;
  if (!(speedKt > 0)) return "";
  const speedColor = getColorForAirspeed(
    speedKt,
    params.speedRange.min,
    params.speedRange.max,
    params.speedRange.ranks,
  );
  return `
        <div class="kh-popup-block">
            <div class="popup-section-label">Groundspeed</div>
            <div class="popup-metric kh-popup-metric-colored" data-metric-color="${speedColor}">
                <span class="popup-metric-value">${formatNumber(speedKt)} kt</span>
                <span class="popup-metric-unit">(${formatNumber(speedKt * NAUTICAL_MILES_TO_KM)} km/h)</span>
            </div>
        </div>`;
}

/** Colour the segment metrics below `root`; see generateSegmentPopupHtml() */
export function applyMetricColors(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-metric-color]")) {
    const color = el.dataset["metricColor"]!;
    el.style.setProperty("--kh-metric-color", color);
    el.style.setProperty("--kh-metric-bg", rgbToRgba(color, 0.15));
  }
}
