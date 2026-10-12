/**
 * The heat legend: its bar and the words of its ends worked out from the
 * scale of the heat, with the markup of map_template.html. When it shows is up to
 * followLayerVisibility (layerVisibility.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  followHeatLegend,
  heatLegend,
  heatLegendText,
} from "../../../../flown/frontend/ui/heatLegend";
import { HEAT_FLIGHT_DENSITY } from "../../../../flown/frontend/calculations/heatExposure";
import { HEATMAP_GRADIENT } from "../../../../flown/frontend/ui/heatmapPaint";
import { asMapApp, createMockApp, type MockApp } from "../../testHelpers";

/** A gradient as the page's style spells it */
function styled(gradient: string): string {
  const element = document.createElement("div");
  element.style.backgroundImage = gradient;
  return element.style.backgroundImage;
}

/** The heat legend as the page has it */
function heatLegendOfPage(): HTMLElement {
  const template = readFileSync(
    join(process.cwd(), "flown/templates/map_template.html"),
    "utf8",
  );
  const page = new DOMParser().parseFromString(template, "text/html");
  return document.importNode(page.getElementById("heat-legend")!, true);
}

/** The stops of a gradient of heatLegend: [rgba, position in percent] */
function stopsOf(gradient: string): [string, number][] {
  return [...gradient.matchAll(/(rgba\([^)]*\)) (-?[\d.e-]+)%/g)].map(
    ([, colour, at]) => [colour!, Number(at)],
  );
}

/** Where on the bar, in percent, the heat of `density` is drawn */
function positionOf(gradient: string, density: number): number {
  const index = HEATMAP_GRADIENT.findIndex(([d]) => d === density);
  return stopsOf(gradient)[index - 1]![1];
}

describe("heatLegend", () => {
  it("labels the heatmap as drawn: 1 flight, 4, 16 and 64", () => {
    const { counts, gradient } = heatLegend(HEAT_FLIGHT_DENSITY);
    expect(counts).toEqual([1, 4, 16, 64]);
    expect(gradient.startsWith("linear-gradient(to right, ")).toBe(true);
    // Every colour of the ramp from its faintest on, in its order and its
    // own opacity
    const stops = stopsOf(gradient);
    expect(stops.map(([colour]) => colour)).toEqual(
      HEATMAP_GRADIENT.slice(1).map(
        ([, rgb, alpha]) => `rgba(${rgb}, ${alpha})`,
      ),
    );
    // One flight under the middle of the first quarter, four under the
    // second: the colours a step of four apart are a quarter apart
    expect(positionOf(gradient, 0.015)).toBeCloseTo(12.5, 9);
    expect(positionOf(gradient, 0.06)).toBeCloseTo(37.5, 9);
    expect(positionOf(gradient, 0.03)).toBeCloseTo(25, 9);
    // Past the knee the colours stand for the heat rolled off to them: the
    // light cyan a density of 0.25 draws for about 20 flights, a little
    // right of the label 16, the pale cyan for about 200 and white (a density of 1) for
    // thousands, both off the bar, whose end at 128 is between the two
    expect(positionOf(gradient, 0.25)).toBeGreaterThan(62.5);
    expect(positionOf(gradient, 0.25)).toBeLessThan(70);
    expect(positionOf(gradient, 0.6)).toBeGreaterThan(100);
    expect(positionOf(gradient, 1)).toBeGreaterThan(positionOf(gradient, 0.6));
    // The faintest colour a step left of one flight's, off the bar
    expect(stops[0]![1]).toBeLessThan(0);
  });

  it("keeps the labels round under an exposure, and the colours under them", () => {
    // The cloud of a busy field, drawn at a quarter
    const quarter = heatLegend(HEAT_FLIGHT_DENSITY / 4);
    expect(quarter.counts).toEqual([4, 16, 64, 256]);
    expect(positionOf(quarter.gradient, 0.015)).toBeCloseTo(12.5, 9);

    // Drawn at 0.3: 3.3 flights' worth in the colour of one flight, so the
    // labels start at 4, a little to the right of that colour
    const perFlight = HEAT_FLIGHT_DENSITY * 0.3;
    const dim = heatLegend(perFlight);
    expect(dim.counts).toEqual([4, 16, 64, 256]);
    const at = positionOf(dim.gradient, 0.015);
    expect(at).toBeLessThan(12.5);
    // The colour under the first label is that of 4 flights' worth
    expect(at).toBeCloseTo(12.5 * (Math.log2(0.015 / (4 * perFlight)) + 1), 9);
    // However the ramp is shifted, its faintest colour stays off the bar
    expect(stopsOf(dim.gradient)[0]![1]).toBeLessThan(0);
  });

  it("starts at one flight however bright a flight is drawn", () => {
    expect(heatLegend(HEAT_FLIGHT_DENSITY * 3).counts).toEqual([1, 4, 16, 64]);
  });
});

describe("heatLegendText", () => {
  it("says which way the time grows and what the ends stand for", () => {
    expect(heatLegendText([1, 4, 16, 64])).toBe(
      "Time spent: blue for about 1 pass of a flight, light cyan for about 64, white for many more",
    );
    expect(heatLegendText([4, 16, 64, 256])).toBe(
      "Time spent: blue for about 4 passes of a flight, light cyan for about 256, white for many more",
    );
  });
});

describe("followHeatLegend", () => {
  let app: MockApp;
  let legend: HTMLElement;

  const bar = (): HTMLElement =>
    legend.querySelector<HTMLElement>(".gradient-bar")!;
  /** What the bar is named, and the legend's tooltip with it */
  const said = (): string => {
    const row = legend.querySelector<HTMLElement>(".labels")!;
    expect(row.title).toBe(bar().getAttribute("aria-label"));
    // Not the region's, which would be read out as its description
    expect(legend.hasAttribute("title")).toBe(false);
    return row.title;
  };

  beforeEach(() => {
    legend = heatLegendOfPage();
    document.body.appendChild(legend);
    app = createMockApp({ heatmapVisible: true });
  });

  afterEach(() => {
    legend.remove();
  });

  it("is one row: its title, less, the bar and more", () => {
    const row = [...legend.querySelector(".labels")!.children];
    expect(row.map((part) => part.textContent.trim())).toEqual([
      "Time spent",
      "Less",
      "",
      "More",
    ]);
    expect(row[2]).toBe(bar());
    expect(bar().getAttribute("role")).toBe("img");
    // The page names the bar as the heatmap is drawn unscaled
    expect(bar().getAttribute("aria-label")).toBe(
      heatLegendText([1, 4, 16, 64]),
    );
  });

  it("draws the bar of the heatmap and names its ends", () => {
    followHeatLegend(asMapApp(app));
    expect(bar().style.backgroundImage).toBe(
      styled(heatLegend(HEAT_FLIGHT_DENSITY).gradient),
    );
    expect(said()).toBe(heatLegendText([1, 4, 16, 64]));
  });

  it("follows the cloud's scale while the cloud is drawn", () => {
    followHeatLegend(asMapApp(app));
    app.store.batch(() => {
      app.heatCloud = true;
      app.store.set("heatCloudScale", 0.5);
    });
    expect(said()).toBe(heatLegendText([2, 8, 32, 128]));
    expect(bar().style.backgroundImage).toBe(
      styled(heatLegend(HEAT_FLIGHT_DENSITY / 2).gradient),
    );
    app.store.set("heatCloudScale", 0.25);
    expect(said()).toBe(heatLegendText([4, 16, 64, 256]));

    app.heatCloud = false;
    expect(said()).toBe(heatLegendText([1, 4, 16, 64]));
  });

  it("follows the exposure of the flat heatmap, but not in the cloud's place", () => {
    followHeatLegend(asMapApp(app));
    // A logbook of many years, drawn at a quarter
    app.heatmapExposure = 0.25;
    expect(said()).toBe(heatLegendText([4, 16, 64, 256]));
    expect(bar().style.backgroundImage).toBe(
      styled(heatLegend(HEAT_FLIGHT_DENSITY / 4).gradient),
    );
    // A lone flight, drawn at twice its heat: one flight's colour is
    // brighter, and the bar starts at one all the same
    app.heatmapExposure = 2;
    expect(said()).toBe(heatLegendText([1, 4, 16, 64]));
    expect(bar().style.backgroundImage).toBe(
      styled(heatLegend(HEAT_FLIGHT_DENSITY * 2).gradient),
    );

    app.store.batch(() => {
      app.heatCloud = true;
      app.store.set("heatCloudScale", 0.5);
    });
    expect(said()).toBe(heatLegendText([2, 8, 32, 128]));
  });

  it("says what the cloud shows while the cloud draws the heat", () => {
    const about = legend.querySelector<HTMLElement>("#heat-cloud-about")!;
    expect(about.hidden).toBe(true);
    followHeatLegend(asMapApp(app));
    expect(about.hidden).toBe(true);
    app.heatCloud = true;
    expect(about.hidden).toBe(false);
    app.heatCloud = false;
    expect(about.hidden).toBe(true);
  });

  it("says the direction flown shows by the pulses or the chevrons at rest, and by the chevrons alone under reduced motion", () => {
    const wording = (selector: string): string =>
      legend.querySelector(selector)!.textContent.replace(/\s+/g, " ").trim();
    expect(wording("#heat-cloud-about .heat-cloud-moving")).toBe(
      "Pulses, or chevrons at rest: the direction flown",
    );
    expect(wording("#heat-cloud-about .heat-cloud-still")).toBe(
      "Chevrons: the direction flown",
    );
    // The stylesheet shows one of the two: the chevrons' own under reduced
    // motion, where the pulses rest
    const css = readFileSync(
      join(process.cwd(), "flown/static/features.css"),
      "utf8",
    ).replace(/\s+/g, " ");
    expect(css).toContain("#heat-legend .heat-cloud-still { display: none; }");
    expect(css).toContain(
      "@media (prefers-reduced-motion: reduce) { #heat-legend .heat-cloud-moving { display: none; } #heat-legend .heat-cloud-still { display: inline; } }",
    );
  });

  it("does nothing on a page without it", () => {
    legend.remove();
    expect(() => followHeatLegend(asMapApp(app))).not.toThrow();
  });
});
