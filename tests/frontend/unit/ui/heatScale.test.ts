/**
 * The heat scale: the colour a flight's worth of heat is drawn in, by the
 * heatmap under its exposure, the heat lines it hands over to, and the
 * cloud of the 3D view with the scale it hands to the store.
 */
import { describe, it, expect } from "vitest";
import {
  createExpression,
  type StylePropertySpecification,
} from "@maplibre/maplibre-gl-style-spec";
import { heatScale } from "../../../../flown/frontend/ui/heatScale";
import { HEAT_FLIGHT_DENSITY } from "../../../../flown/frontend/calculations/heatExposure";
import {
  heatLinesPaint,
  heatmapPaint,
  heatmapRadiusPx,
  intensityAt,
} from "../../../../flown/frontend/ui/heatmapPaint";
import { heatmapPoints } from "../../../../flown/frontend/ui/dataManager";
import {
  heatLineFeatures,
  heatWeight,
} from "../../../../flown/frontend/calculations/heatLines";
import { DEGREES_TO_RADIANS } from "../../../../flown/frontend/utils/geometry";
import { MAP_LAYERS } from "../../../../flown/frontend/utils/constants";
import { asMapApp, createMockApp, createSegment } from "../../testHelpers";

/**
 * The colour `paint` gives, as MapLibre works it out: `[r, g, b]` from 0
 * to 255, without the alpha the heatmap's colours carry
 */
function colourOf(
  paint: unknown,
  globals: { heatmapDensity?: number },
  properties: Record<string, number> = {},
): number[] {
  // Only the type matters to the parser here
  const spec = { type: "color" } as StylePropertySpecification;
  const parsed = createExpression(paint, "paint.color", spec);
  if (parsed.result !== "success") throw new Error("not an expression");
  const colour = parsed.value.evaluate(
    { zoom: 14, ...globals },
    { type: "Point", properties },
  ) as { r: number; g: number; b: number; a: number };
  return [colour.r, colour.g, colour.b].map((c) => (c / colour.a) * 255);
}

/** The latitude of the flights below, and a degree of longitude there */
const LAT = 50;
const LNG_DEGREE_M = 111320 * Math.cos(LAT * DEGREES_TO_RADIANS);

/**
 * `flights` cruises over the same place: at 100 kt, logged every 5 s,
 * fixes 257 m apart, each in a cell of the heat lines of its own
 */
function cruises(flights: number) {
  return Array.from({ length: flights }, (_, flight) =>
    Array.from({ length: 12 }, (_, i) =>
      createSegment({
        path_id: flight + 1,
        coords: [
          [LAT, 10 + i * 0.0036],
          [LAT, 10 + (i + 1) * 0.0036],
        ],
        time: i * 5,
        groundspeed_knots: 100,
      }),
    ),
  ).flat();
}

/** The heat the lines give those, weighed by time and scaled by `exposure` */
function heatOfLines(flights: number, exposure: number): Set<number> {
  const { features } = heatLineFeatures(
    cruises(flights),
    () => true,
    (segment, next) => heatWeight(segment, next) * exposure,
  );
  return new Set(features.map((feature) => feature.properties.heat));
}

describe("heat scale", () => {
  it("draws a flight's worth in the heatmap's colour of one track", () => {
    const app = createMockApp();
    app.map!.setZoom(8);
    expect(heatScale(asMapApp(app))).toBe(HEAT_FLIGHT_DENSITY);
    expect(HEAT_FLIGHT_DENSITY).toBe(0.015);
  });

  it("is about the density a lone cruise's ridge is drawn at, at every reach", () => {
    // MapLibre's kernel of a point is GAUSS_COEF * exp(-4.5 * (d / radius)^2)
    // times weight times intensity, at the reference zoom 12 and further
    // out, where the reach is wider and the intensity less. The ridge
    // ripples between the fixes, so its mean between two of them in the
    // middle of the track.
    const GAUSS_COEF = 0.3989422804014327;
    for (const zoom of [12, 11.5, 11, 10, 8.5]) {
      const metresPerPx =
        (40075016.686 * Math.cos(LAT * DEGREES_TO_RADIANS)) / (512 * 2 ** zoom);
      const { points, weights } = heatmapPoints(
        cruises(1),
        () => true,
        heatWeight,
      );
      let ridge = 0;
      const samples = 20;
      for (let step = 0; step < samples; step++) {
        const lng = 10 + (6 + step / samples) * 0.0036;
        points.forEach(([, at], index) => {
          const px = ((at - lng) * LNG_DEGREE_M) / metresPerPx;
          ridge +=
            (weights[index]! *
              intensityAt(zoom) *
              GAUSS_COEF *
              Math.exp(-4.5 * (px / heatmapRadiusPx(zoom)) ** 2)) /
            samples;
        });
      }
      const at = `${zoom}`;
      expect(ridge / HEAT_FLIGHT_DENSITY, at).toBeGreaterThan(0.9);
      expect(ridge / HEAT_FLIGHT_DENSITY, at).toBeLessThan(1.2);
    }
  });

  it("draws n passes in the heat lines as the heatmap draws n flights' worth, under its exposure", () => {
    const heatmap = heatmapPaint()["heatmap-color"];
    const lines = heatLinesPaint()[MAP_LAYERS.heatLinesCore]["line-color"];
    for (const exposure of [0.5, 1, 2]) {
      const app = createMockApp({ heatmapExposure: exposure });
      const perFlight = heatScale(asMapApp(app));
      expect(perFlight).toBeCloseTo(HEAT_FLIGHT_DENSITY * exposure, 12);
      // The labels of the legend, the white of 64 among them
      for (const flights of [1, 4, 16, 64]) {
        const at = `${flights} at ${exposure}`;
        // Rounded to a power of two along the way: 4 s for a lone pass
        const heat = 4 * flights * exposure;
        expect(heatOfLines(flights, exposure), at).toEqual(new Set([heat]));
        const drawn = colourOf(lines, {}, { heat });
        const legend = colourOf(heatmap, {
          heatmapDensity: flights * perFlight,
        });
        drawn.forEach((channel, i) =>
          expect(channel, at).toBeCloseTo(legend[i]!, 0),
        );
      }
    }
    // 64 flights' worth is near white on both sides of the hand-over
    expect(Math.min(...colourOf(lines, {}, { heat: 256 }))).toBeGreaterThan(
      240,
    );
  });

  it("follows the cloud's scale while the cloud stands in for the heatmap", () => {
    // The exposure of the flat heatmap is not the cloud's
    const app = createMockApp({ heatCloud: true, heatmapExposure: 3 });
    app.map!.setZoom(14);
    app.store.set("heatCloudScale", 0.25);
    expect(heatScale(asMapApp(app))).toBeCloseTo(HEAT_FLIGHT_DENSITY / 4, 12);
    // Before its points are cut, as it draws a lone cruise at full strength
    app.store.set("heatCloudScale", 0);
    expect(heatScale(asMapApp(app))).toBe(HEAT_FLIGHT_DENSITY);
    // A scale left over from the cloud counts for nothing without it
    app.store.set("heatCloudScale", 0.25);
    app.heatCloud = false;
    expect(heatScale(asMapApp(app))).toBeCloseTo(HEAT_FLIGHT_DENSITY * 3, 12);
  });

  it("does without a map", () => {
    const app = createMockApp({ map: null });
    expect(heatScale(asMapApp(app))).toBe(HEAT_FLIGHT_DENSITY);
  });
});
