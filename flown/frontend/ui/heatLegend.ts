/**
 * The heat legend: the colours of the heat, of the flat heatmap and of the
 * cloud of the 3D view alike, as one short row: "Time spent", "Less", the
 * bar and "More". Its markup is in the page; it shows with the other colour
 * legends (see followLayerVisibility), and says what the cloud shows while
 * the cloud draws the heat.
 *
 * The bar spans four steps of four flights' worth of time spent (see
 * ui/heatScale.ts), from the colour of about one pass of a flight on the
 * left to that of 64 on the right for the heatmap drawn unscaled, and it
 * is drawn in a scale of those steps: the ramp is laid under round numbers
 * rather than round numbers over the ramp, whatever the exposure. The
 * first is the power of two nearest the flights' worth the colour of one
 * flight at full strength stands for. The numbers are in the bar's
 * accessible name and in the legend's tooltip; on the screen "Less" and
 * "More" say which way the time grows, which the numbers under the bar
 * ("≈1 pass · 4 · 16 · 64") left to be worked out.
 *
 * A flight's worth is the heat of one pass over a place, of any flight:
 * the time it takes.
 */
import type { MapApp } from "../mapApp";
import { domCache } from "../utils/domCache";
import { heatUntone } from "../calculations/heatTone";
import { HEAT_FLIGHT_DENSITY } from "../calculations/heatExposure";
import { HEATMAP_GRADIENT } from "./heatmapPaint";
import { heatScale } from "./heatScale";

/**
 * The flights' worth of the legend, four steps of four, and its bar as a
 * CSS gradient, for heat drawn at the density `perFlight` for each
 * flight's worth (see heatScale). The bar spans the four steps, the step
 * of the ramp's colours, half a step on either side of the outer ones, and
 * the colour at the middle of each quarter is the one its count is drawn
 * in. The ramp's faintest colour, a quarter of one flight's, lies a step
 * left of the first, off the bar; where it fades in from nothing, further
 * left still (on this scale infinitely far), is left out. The colours
 * beyond the knee of the heat stand for the flights' worth rolled off to
 * them (see heatTone), further apart than their densities.
 */
export function heatLegend(perFlight: number): {
  counts: number[];
  gradient: string;
} {
  const first = Math.max(
    1,
    2 ** Math.round(Math.log2(HEAT_FLIGHT_DENSITY / perFlight)),
  );
  // A step of four is two powers of two, a quarter of the bar
  const stops = HEATMAP_GRADIENT.slice(1).map(
    ([density, rgb, alpha]) =>
      `rgba(${rgb}, ${alpha}) ${12.5 * (Math.log2((heatUntone(density / HEAT_FLIGHT_DENSITY) * HEAT_FLIGHT_DENSITY) / perFlight / first) + 1)}%`,
  );
  return {
    counts: [1, 4, 16, 64].map((step) => first * step),
    gradient: `linear-gradient(to right, ${stops.join()})`,
  };
}

/**
 * What the two ends of the bar stand for, in words, for its accessible
 * name and the legend's tooltip: the first and the last of `counts`, in
 * the colours they are drawn in. The last is light cyan, not white: past
 * the knee the heat is rolled off (see heatTone), and white stands for
 * far more passes, off the bar.
 */
export function heatLegendText(counts: readonly number[]): string {
  const first = counts[0]!;
  return (
    `Time spent: blue for about ${first} ${first > 1 ? "passes" : "pass"} of a flight, ` +
    `light cyan for about ${counts[counts.length - 1]!}, white for many more`
  );
}

/**
 * Keep the bar of the heat legend and what its ends stand for in step
 * with the scale of the heat (see heatScale), and what the cloud shows in
 * it while the cloud draws the heat, from now on for as long as the app
 * lives
 */
export function followHeatLegend(app: MapApp): void {
  const legend = domCache.get("heat-legend");
  if (!legend) return;
  const bar = legend.querySelector<HTMLElement>(".gradient-bar")!;
  // The tooltip is the row's: on the legend, a region, a screen reader
  // would read it out again as the region's description
  const row = bar.parentElement!;
  const about = domCache.get("heat-cloud-about");
  const label = (): void => {
    const { counts, gradient } = heatLegend(heatScale(app));
    bar.style.backgroundImage = gradient;
    const text = heatLegendText(counts);
    bar.setAttribute("aria-label", text);
    row.title = text;
    if (about) about.hidden = !app.heatCloud;
  };
  app.store.subscribeKeys(
    ["heatCloud", "heatCloudScale", "heatmapExposure"],
    label,
  );
  label();
}
