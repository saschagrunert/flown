/**
 * Cross-section chart - the heights flown along the line, side on
 *
 * The chart of the cross-section's panel (ui/crossSection.ts): distance
 * along the line across, height up, the time spent in each cell of
 * COLUMNS by ROWS as a density image in the heatmap's colours, drawn
 * smoothed onto a canvas a pixel for each of the screen's, with the grid of
 * heights, the ground under the flights above sea level and the figures of
 * the section above it. Pointed at, it reads the cells around the pointer
 * (`readAt`) and puts a dot on the map where that is along the line.
 *
 * `createChart` builds the chart into the panel and returns what the tool
 * needs of it: the plot and the axis, which it hides while a line is being
 * drawn, and the functions that draw it, paint it again at a new size and
 * read it. The chart keeps no section of its own: the tool works one out
 * as the line, the corridor or the flights change and hands it in. Like
 * the tool, it is a closure rather than a class, as the bundle carries a
 * class's member names as they are written.
 */
import { Marker, type Map as MapLibreMap } from "maplibre-gl";
import type { MapApp } from "../mapApp";
import {
  fromFrame,
  smoothCells,
  windowSeconds,
  type CrossSection,
  type LineFrame,
} from "../calculations/crossSection";
import { nthSmallest } from "../calculations/heatCloud";
import { formatDuration } from "../utils/duration";
import { formatNumber } from "../utils/formatters";
import { toLngLat } from "../utils/mapHelpers";
import { element, shape } from "./crossSectionElements";
import { formatKm, heightUnit, sectionSummary } from "./crossSectionText";
import { HEATMAP_GRADIENT } from "./heatmapPaint";

/**
 * Cells of the density image along the line and up: about one per pixel of
 * the chart on a screen of one device pixel per CSS pixel, two by two on a
 * finer one, which it is drawn smoothed on (see smoothCells)
 */
export const COLUMNS = 400;
export const ROWS = 128;

/** The chart's own units: it is stretched to the plot (see the CSS) */
const VIEW_W = 1000;
const VIEW_H = 100;

/**
 * Cells either way of the one pointed at that the readout adds up: a
 * single cell is some ten metres by some ten feet, and mostly empty. The
 * window reaches past what smoothCells spreads a cell by, so a place the
 * chart colours never reads as empty.
 */
const READOUT_RADIUS = 4;

/**
 * The heatmap's colours by density, `[share of the fullest cell,
 * [r, g, b], alpha]`: taken from its stops, so the chart reads in the
 * colours of the map it is read against
 */
const DENSITY_STOPS = HEATMAP_GRADIENT.map(
  ([share, rgb, alpha]) => [share, rgb.split(",").map(Number), alpha] as const,
);

/**
 * Share of the cells with any time that sets the white end of the colours:
 * the apron and a holding point would otherwise take white alone and leave
 * the circuits in the dark
 */
const DENSITY_REFERENCE_QUANTILE = 0.95;

/** The colour of a cell holding `share` of the reference, as RGBA */
export function densityColour(
  share: number,
  out: Uint8ClampedArray,
  at: number,
): void {
  const t = Math.min(1, share);
  let i = 1;
  while (i < DENSITY_STOPS.length - 1 && DENSITY_STOPS[i]![0] < t) i++;
  const [from, rgbFrom, alphaFrom] = DENSITY_STOPS[i - 1]!;
  const [to, rgbTo, alphaTo] = DENSITY_STOPS[i]!;
  const f = Math.min(1, Math.max(0, (t - from) / (to - from)));
  for (let c = 0; c < 3; c++) {
    out[at + c] = rgbFrom[c]! + (rgbTo[c]! - rgbFrom[c]!) * f;
  }
  out[at + 3] = 255 * (alphaFrom + (alphaTo - alphaFrom) * f);
}

/**
 * The seconds of the cell the colours reach white at. A selection rather
 * than a sort, among the filled cells copied into `scratch`: it runs every
 * frame a handle of the line is dragged.
 */
export function densityReference(
  seconds: Float64Array,
  scratch = new Float64Array(seconds.length),
): number {
  let count = 0;
  for (const value of seconds) {
    if (value > 0) scratch[count++] = value;
  }
  if (!count) return 0;
  return nthSmallest(
    scratch.subarray(0, count),
    Math.min(count - 1, Math.floor(count * DENSITY_REFERENCE_QUANTILE)),
  );
}

/** The chart of a section, and what the tool does with it */
export interface SectionChart {
  /** The chart itself, hidden while a line is being drawn */
  plot: HTMLDivElement;
  /** The distances along the line under it, hidden with it */
  axis: HTMLDivElement;
  /** Draw `section`, or clear the chart for none */
  draw: (section: CrossSection | null) => void;
  /** Draw the density image of `section` again, at the chart's size */
  paint: (section: CrossSection | null) => void;
  /** Take the readout, the marks and the dot on the map away */
  leave: () => void;
  /** Read `section` under a pointer at `clientX`, `clientY` */
  readAt: (
    section: CrossSection | null,
    frame: LineFrame | null,
    clientX: number,
    clientY: number,
  ) => void;
}

/**
 * Build the chart into the panel `root`, after what it holds so far, with
 * its figures written to `stats` and its readout to `readout`
 */
export function createChart(
  app: MapApp,
  root: HTMLElement,
  stats: HTMLElement,
  readout: HTMLElement,
): SectionChart {
  const plot = element("div", "section-plot", root);
  plot.setAttribute("role", "img");
  // The chart's canvas, a pixel for each of the screen's, and the density
  // image it draws smoothed, a pixel per cell
  const canvas = element("canvas", "section-density", plot);
  const cellImage = document.createElement("canvas");
  cellImage.width = COLUMNS;
  cellImage.height = ROWS;
  const svg = shape("svg", "section-chart", plot);
  svg.setAttribute("viewBox", `0 0 ${VIEW_W} ${VIEW_H}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const grid = shape("path", "section-grid", svg);
  const ground = shape("path", "section-ground", svg);
  const hover = shape("line", "section-hover", svg);
  hover.setAttribute("y2", String(VIEW_H));
  /** The cells the readout adds up */
  const cells = shape("rect", "section-window", svg);
  for (const mark of [hover, cells]) mark.setAttribute("visibility", "hidden");
  const ticks = element("div", "section-ticks", plot);
  ticks.setAttribute("aria-hidden", "true");
  const axis = element("div", "profile-axis", root);
  axis.setAttribute("aria-hidden", "true");
  const axisStart = element("span", "", axis);
  const axisEnd = element("span", "", axis);

  /** The seconds of the cell the colours reach white at */
  let densityRef = 0;
  /** The density image's pixels, made once and cleared for each section */
  let image: ImageData | null = null;
  /**
   * The grids the density is worked out in, made once: a section is drawn
   * on every frame of a drag
   */
  const density = new Float64Array(COLUMNS * ROWS);
  const scratch = new Float64Array(COLUMNS * ROWS);
  /** The scale the ticks were written for */
  let ticked = "";
  /** The place on the map the pointer on the chart stands for */
  let dot: Marker | null = null;

  const map = (): MapLibreMap | null => app.map;

  const draw = (section: CrossSection | null): void => {
    leave();
    if (!section) {
      stats.textContent = "";
      plot.removeAttribute("aria-label");
      return;
    }
    const shown = section;
    // The density image, a pixel per cell, the bottom row last
    const context = cellImage.getContext("2d");
    smoothCells(shown.seconds, COLUMNS, ROWS, density, scratch);
    densityRef = densityReference(density, scratch);
    if (context) {
      if (image) image.data.fill(0);
      else image = context.createImageData(COLUMNS, ROWS);
      for (let row = 0; row < ROWS; row++) {
        for (let column = 0; column < COLUMNS; column++) {
          const value = density[row * COLUMNS + column]!;
          if (value <= 0) continue;
          const at = ((ROWS - 1 - row) * COLUMNS + column) * 4;
          densityColour(value / densityRef, image.data, at);
        }
      }
      context.putImageData(image, 0, 0);
    }
    paint(section);
    const { bottomFt, topFt, gridStepFt } = shown;
    const yOf = (feet: number): string =>
      (VIEW_H - ((feet - bottomFt) / (topFt - bottomFt)) * VIEW_H).toFixed(1);
    // The scale stays while a drag keeps to its heights
    const scale = `${bottomFt} ${topFt} ${gridStepFt} ${heightUnit(shown)}`;
    if (scale !== ticked) {
      ticked = scale;
      let lines = "";
      ticks.replaceChildren();
      for (let feet = bottomFt; feet < topFt; feet += gridStepFt) {
        if (feet > bottomFt) lines += `M0 ${yOf(feet)}H${VIEW_W}`;
        const tick = element("span", "section-tick", ticks);
        tick.style.bottom = `${((feet - bottomFt) / (topFt - bottomFt)) * 100}%`;
        tick.textContent = formatNumber(feet);
      }
      element("span", "section-tick section-unit", ticks).textContent =
        heightUnit(shown);
      grid.setAttribute("d", lines);
    }
    // Above sea level, the ground under the flights, filled in
    let floor = "";
    if (shown.reference === "msl" && shown.groundFt) {
      const columnW = VIEW_W / COLUMNS;
      floor = `M0 ${VIEW_H}`;
      shown.groundFt.forEach((feet, column) => {
        floor += `L${((column + 0.5) * columnW).toFixed(1)} ${yOf(feet)}`;
      });
      floor += `L${VIEW_W} ${yOf(shown.groundFt[COLUMNS - 1]!)}L${VIEW_W} ${VIEW_H}Z`;
    }
    ground.setAttribute("d", floor);

    const unit = heightUnit(shown);
    const figures: [string, string][] = [
      ["Time", formatDuration(shown.totalSeconds)],
      [
        app.selectedPathIds.size ? "Selected flights" : "Flights",
        formatNumber(shown.flights),
      ],
    ];
    if (shown.busiest) {
      figures.push([
        "Most flown",
        `${formatNumber(shown.busiest[0])} to ${formatNumber(shown.busiest[1])} ${unit}`,
      ]);
    }
    if (shown.aboveSeconds >= 30) {
      figures.push(["Higher", formatDuration(shown.aboveSeconds)]);
    }
    stats.replaceChildren();
    for (const [label, value] of figures) {
      const stat = element("span", "profile-stat", stats);
      element("span", "profile-stat-label", stat).textContent = label;
      stat.append(" ", value);
    }
    axisStart.textContent = "A · 0 km";
    axisEnd.textContent = `${formatKm(shown.lengthM)} · B`;
    plot.setAttribute(
      "aria-label",
      sectionSummary(shown, app.selectedPathIds.size),
    );
  };

  /**
   * Draw the density image onto the chart, stretched to its pixels on the
   * screen and smoothed; again whenever the chart changes size
   */
  const paint = (section: CrossSection | null): void => {
    const context = canvas.getContext("2d");
    const scale = window.devicePixelRatio || 1;
    const width = Math.round(plot.clientWidth * scale);
    const height = Math.round(plot.clientHeight * scale);
    if (!context || !section || width <= 0 || height <= 0) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(cellImage, 0, 0, width, height);
  };

  // Reading the chart

  const leave = (): void => {
    hover.setAttribute("visibility", "hidden");
    cells.setAttribute("visibility", "hidden");
    readout.textContent = "";
    dot?.remove();
  };

  /** Read the chart under a pointer at `clientX`, `clientY` */
  const readAt = (
    section: CrossSection | null,
    frame: LineFrame | null,
    clientX: number,
    clientY: number,
  ): void => {
    if (!section || !frame) return;
    const box = plot.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    const x = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    const y = Math.min(1, Math.max(0, (box.bottom - clientY) / box.height));
    const column = Math.min(COLUMNS - 1, Math.floor(x * COLUMNS));
    const row = Math.min(ROWS - 1, Math.floor(y * ROWS));
    const along = x * section.lengthM;
    const rowFt = (section.topFt - section.bottomFt) / ROWS;
    // The band the readout adds up, to the nearest 10 ft
    const tens = (edge: number): string =>
      formatNumber(
        Math.max(0, Math.round((section.bottomFt + edge * rowFt) / 10) * 10),
      );
    const low = Math.max(0, row - READOUT_RADIUS);
    const high = Math.min(ROWS, row + READOUT_RADIUS + 1);
    const seconds = windowSeconds(section, column, row, READOUT_RADIUS);
    readout.textContent = [
      formatKm(along),
      `${tens(low)} to ${tens(high)} ${heightUnit(section)}`,
      seconds > 0 ? formatDuration(seconds) : "no flights here",
    ].join(" · ");
    const chartX = (x * VIEW_W).toFixed(1);
    hover.setAttribute("x1", chartX);
    hover.setAttribute("x2", chartX);
    const left = Math.max(0, column - READOUT_RADIUS);
    const right = Math.min(COLUMNS, column + READOUT_RADIUS + 1);
    cells.setAttribute("x", String((left / COLUMNS) * VIEW_W));
    cells.setAttribute("width", String(((right - left) / COLUMNS) * VIEW_W));
    cells.setAttribute("y", String(VIEW_H - (high / ROWS) * VIEW_H));
    cells.setAttribute("height", String(((high - low) / ROWS) * VIEW_H));
    for (const mark of [hover, cells])
      mark.setAttribute("visibility", "visible");
    const target = map();
    if (!target) return;
    dot ??= new Marker({
      element: Object.assign(document.createElement("div"), {
        className: "profile-map-dot",
      }),
    });
    dot.setLngLat(toLngLat(fromFrame(frame, along, 0)));
    // Put on the map once and moved after that: MapLibre takes a marker
    // off the map and puts it on again for every addTo, which was at every
    // move of the pointer over the chart
    if (!dot.getElement().parentNode) dot.addTo(target);
  };

  return { plot, axis, draw, paint, leave, readAt };
}
