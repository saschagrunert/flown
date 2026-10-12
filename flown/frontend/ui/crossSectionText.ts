/**
 * Cross-section text - what the chart of a section says in words
 *
 * The figures above the chart, its readout, the labels of its axis and of
 * the corridor's widths, and the summary a screen reader hears
 * (`sectionSummary`, which is also the chart's accessible name) all say a
 * section's heat the same way: as time spent (formatDuration), and its
 * heights in the unit the section was worked out in (`heightUnit`). The
 * tool (ui/crossSection.ts) and its chart (ui/crossSectionChart.ts) both
 * take their words from here, so the two never disagree.
 */
import type { CrossSection } from "../calculations/crossSection";
import { formatDuration } from "../utils/duration";
import { formatNumber } from "../utils/formatters";

/** The labels of the corridor's widths */
export function widthLabel(metres: number): string {
  return metres < 1000 ? `±${metres} m` : `±${metres / 1000} km`;
}

/** Kilometres, with a decimal under ten */
export function formatKm(metres: number): string {
  const km = metres / 1000;
  return `${formatNumber(km, km < 10 ? 1 : 0)} km`;
}

/**
 * The unit of the heights of a section, or of a flight profile
 * (ui/flightProfile.ts), which are above the ground always
 */
export function heightUnit(
  section: Pick<CrossSection, "fromTerrain"> &
    Partial<Pick<CrossSection, "reference">>,
): string {
  if (section.reference === "msl") return "ft MSL";
  return section.fromTerrain ? "ft AGL" : "ft above field";
}

/**
 * What the chart says, for a screen reader: the line, the corridor, the
 * time, the flights and where most of it was
 */
export function sectionSummary(
  section: CrossSection,
  selected: number,
): string {
  const where = `within ${widthLabel(section.halfWidthM).slice(1)} of a ${formatKm(section.lengthM)} line`;
  if (section.totalSeconds <= 0) {
    return `Cross-section: no ${selected ? "selected " : ""}flight passes ${where}`;
  }
  const flights = `${formatNumber(section.flights)} ${selected ? "selected " : ""}flight${section.flights === 1 ? "" : "s"}`;
  const busiest = section.busiest
    ? `, most of it in the air between ${formatNumber(section.busiest[0])} and ${formatNumber(section.busiest[1])} ${heightUnit(section)}`
    : "";
  return `Cross-section: ${formatDuration(section.totalSeconds)} from ${flights} ${where}${busiest}`;
}
