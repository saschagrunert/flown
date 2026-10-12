/**
 * The paint of the heatmap and of the heat lines (ui/heatmapPaint.ts):
 * the intensity and weight over the zoom, the colour ramp, and the fade
 * from the one to the other
 */
import { describe, it, expect } from "vitest";
import {
  heatLinesPaint,
  heatmapPaint,
  heatmapRadiusPx,
  HEATMAP_LEAST_CONTRIBUTION,
  HEATMAP_LEAST_POINT_CONTRIBUTION,
  HEATMAP_RADIUS_PX,
} from "../../../../flown/frontend/ui/heatmapPaint";
import {
  HEAT_LINES,
  HEATMAP_CLUSTER,
  MAP_LAYERS,
  MAP_MAX_ZOOM,
  MAP_MIN_ZOOM,
} from "../../../../flown/frontend/utils/constants";

describe("heatmapPaint", () => {
  const paint = heatmapPaint();

  it("halves the intensity per zoom level out, up to where fixes turn into dots, and gives a narrower reach as much more", () => {
    const intensity = paint["heatmap-intensity"] as unknown[];
    expect(intensity.slice(0, 3)).toEqual([
      "interpolate",
      ["exponential", 2],
      ["zoom"],
    ]);
    const stops = intensity.slice(3) as number[];
    const zooms = stops.filter((_, i) => i % 2 === 0);
    const values = stops.filter((_, i) => i % 2 === 1);
    // A stop per half level, and the last one's value beyond
    expect(zooms.slice(0, -1)).toEqual(
      Array.from({ length: zooms.length - 1 }, (_, i) => i / 2),
    );
    expect(values.at(-1)).toBe(values.at(-2));
    for (let i = 1; i < zooms.length - 1; i++) {
      // The ridge of a track, intensity times reach, doubles per level in
      expect(
        (values[i]! * heatmapRadiusPx(zooms[i]!)) /
          (values[i - 1]! * heatmapRadiusPx(zooms[i - 1]!)),
      ).toBeCloseTo(Math.SQRT2, 12);
    }
    // Where the reach is the same, a power of two per level makes the
    // base 2 curve exactly 2^zoom
    expect(values[6]! / values[4]!).toBe(2);
    // Where it narrows, within a few per cent
    for (let zoom = 9; zoom <= 10; zoom += 0.05) {
      expect(
        (intensityAt(zoom) * heatmapRadiusPx(zoom) * 2 ** (12 - zoom)) /
          (intensityAt(8) * heatmapRadiusPx(8) * 2 ** 4),
      ).toBeCloseTo(1, 1);
    }
  });

  /** What the intensity comes to at `zoom`, by the rule of the expression */
  const intensityAt = (zoom: number): number => {
    const stops = (paint["heatmap-intensity"] as unknown[]).slice(
      3,
    ) as number[];
    const zooms = stops.filter((_, i) => i % 2 === 0);
    const values = stops.filter((_, i) => i % 2 === 1);
    if (zoom <= zooms[0]!) return values[0]!;
    const upper = zooms.findIndex((z) => z > zoom);
    if (upper < 0) return values.at(-1)!;
    const [from, to] = [zooms[upper - 1]!, zooms[upper]!];
    // MapLibre's exponential interpolation
    const t = (2 ** (zoom - from) - 1) / (2 ** (to - from) - 1);
    return values[upper - 1]! + (values[upper]! - values[upper - 1]!) * t;
  };

  /**
   * What the weight comes to for a feature with these properties. Only the
   * shape heatmapWeight builds is understood: an interpolation over the
   * zoom whose outputs are made of `get`, `coalesce`, `max`, `*` and `-`.
   */
  const weightAt = (
    zoom: number,
    properties: { w?: number; n?: number },
  ): number => {
    const weight = paint["heatmap-weight"] as unknown[];
    expect(weight.slice(0, 3)).toEqual([
      "interpolate",
      ["exponential", 0.5],
      ["zoom"],
    ]);
    const feature = { w: 1, ...properties } as Record<string, number>;
    const output = (value: unknown): number => {
      if (typeof value === "number") return value;
      const [operator, ...args] = value as [string, ...unknown[]];
      switch (operator) {
        case "get":
          return feature[args[0] as string] ?? NaN;
        case "coalesce": {
          const [name, fallback] = args as [[string, string], number];
          return feature[name[1]] ?? fallback;
        }
        case "max":
          return Math.max(...args.map(output));
        case "*":
          return args.map(output).reduce((a, b) => a * b);
        case "-":
          return output(args[0]) - output(args[1]);
      }
      throw new Error(`not understood: ${JSON.stringify(value)}`);
    };
    const stops = weight.slice(3);
    const zooms = stops.filter((_, i) => i % 2 === 0) as number[];
    const outputs = stops.filter((_, i) => i % 2 === 1).map(output);
    if (zoom <= zooms[0]!) return outputs[0]!;
    const last = zooms.length - 1;
    if (zoom >= zooms[last]!) return outputs[last]!;
    const upper = zooms.findIndex((z) => z > zoom);
    const [from, to] = [zooms[upper - 1]!, zooms[upper]!];
    // MapLibre's exponential interpolation
    const t = (0.5 ** (zoom - from) - 1) / (0.5 ** (to - from) - 1);
    return outputs[upper - 1]! + (outputs[upper]! - outputs[upper - 1]!) * t;
  };

  it("never lets a lone fix contribute less than at the first zoom without clusters", () => {
    // No spacing of the fixes assumed: a fix of the heat of one that found
    // no cluster, however far out the map is
    expect(HEATMAP_LEAST_CONTRIBUTION).toBeGreaterThanOrEqual(0.004);
    expect(HEATMAP_LEAST_CONTRIBUTION).toBe(
      intensityAt(HEATMAP_CLUSTER.maxZoom + 1),
    );
    // Between two levels of another reach the two curves are a few per
    // cent apart, and the kernel of such a fix is still whole
    for (let zoom = 0; zoom <= MAP_MAX_ZOOM; zoom += 0.25) {
      const contribution = weightAt(zoom, {}) * intensityAt(zoom);
      expect(contribution).toBeGreaterThanOrEqual(
        HEATMAP_LEAST_CONTRIBUTION * 0.97,
      );
    }
    expect(MAP_MIN_ZOOM).toBeGreaterThanOrEqual(0);
  });

  it("holds a lone fix at the floor while clusters are drawn", () => {
    for (let zoom = 0; zoom <= HEATMAP_CLUSTER.maxZoom + 1; zoom += 0.25) {
      const contribution = weightAt(zoom, {}) * intensityAt(zoom);
      // Exactly at each level, and between two where the reach is the same
      if (zoom % 1 === 0 || zoom < HEATMAP_RADIUS_PX[0]![0]) {
        expect(contribution).toBeCloseTo(HEATMAP_LEAST_CONTRIBUTION, 12);
      }
      expect(contribution / HEATMAP_LEAST_CONTRIBUTION).toBeCloseTo(1, 1);
    }
  });

  it("weighs a fix by its heat where fixes are drawn, and a big cluster by the heat of its fixes", () => {
    for (let zoom = HEATMAP_CLUSTER.maxZoom + 1; zoom <= MAP_MAX_ZOOM; zoom++) {
      expect(weightAt(zoom, {})).toBe(1);
      expect(weightAt(zoom, { w: 0.4 })).toBe(0.4);
    }
    for (let zoom = 0; zoom <= HEATMAP_CLUSTER.maxZoom; zoom += 0.5) {
      expect(weightAt(zoom, { w: 100000 })).toBe(100000);
      // The floor only ever adds
      expect(weightAt(zoom, { w: 3 })).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps the lightest point drawn where the fixes are drawn as they are", () => {
    // MapLibre's kernel has no size under weight times intensity times
    // 1 / sqrt(2 pi) of 1 / 255 / 16, and the point drops out
    const collapses = 1 / 255 / 16 / 0.3989422804014327;
    expect(HEATMAP_LEAST_POINT_CONTRIBUTION).toBeGreaterThan(collapses);
    expect(HEATMAP_LEAST_POINT_CONTRIBUTION).toBeLessThan(
      HEATMAP_LEAST_CONTRIBUTION / 4,
    );
    for (
      let zoom = HEATMAP_CLUSTER.maxZoom + 1;
      zoom <= MAP_MAX_ZOOM;
      zoom += 0.5
    ) {
      // A fix a tenth of a second on, under the least exposure
      expect(
        (weightAt(zoom, { w: 0.00625 }) * intensityAt(zoom)) /
          HEATMAP_LEAST_POINT_CONTRIBUTION,
      ).toBeCloseTo(1, 1);
    }
  });

  it("draws a point of merged fixes as its fixes were, with their floors and less the cuts they no longer lose", () => {
    for (let zoom = 0; zoom <= HEATMAP_CLUSTER.maxZoom; zoom += 0.5) {
      // A cluster has no count, and a point of merged fixes is one fix
      // among the clusters, which take no floor of their own
      expect(weightAt(zoom, { w: 3, n: 4 })).toBe(weightAt(zoom, { w: 3 }));
    }
    for (let zoom = HEATMAP_CLUSTER.maxZoom + 1; zoom <= MAP_MAX_ZOOM; zoom++) {
      const floor = HEATMAP_LEAST_POINT_CONTRIBUTION / intensityAt(zoom);
      const cut = weightAt(zoom, { w: 50 }) - weightAt(zoom, { w: 50, n: 2 });
      // What MapLibre's cut takes out of a point: more than the least it
      // draws at all, less than the floor
      expect(cut * intensityAt(zoom)).toBeGreaterThan(
        1 / 255 / 16 / 0.3989422804014327,
      );
      expect(cut).toBeLessThan(floor);
      // Heavy fixes weigh their heat, light ones their floors, each less
      // the cut for every fix beyond the first
      expect(weightAt(zoom, { w: 50, n: 3 })).toBeCloseTo(50 - 2 * cut, 9);
      expect(weightAt(zoom, { w: floor / 100, n: 3 })).toBeCloseTo(
        3 * floor - 2 * cut,
        9,
      );
      expect(weightAt(zoom, { w: 2, n: 1 })).toBe(2);
    }
  });

  /** The stops of the colour ramp as `[density, r, g, b, alpha]` */
  const colorStops = (): number[][] => {
    const stops = (paint["heatmap-color"] as unknown[]).slice(3);
    expect(stops.length % 2).toBe(0);
    const parsed: number[][] = [];
    for (let i = 0; i < stops.length; i += 2) {
      const match = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(
        stops[i + 1] as string,
      );
      expect(match).not.toBeNull();
      parsed.push([stops[i] as number, ...match!.slice(1).map(Number)]);
    }
    return parsed;
  };

  it("colours by density, from nothing at 0 up to 1", () => {
    const color = paint["heatmap-color"] as unknown[];
    expect(color.slice(0, 3)).toEqual([
      "interpolate",
      ["linear"],
      ["heatmap-density"],
    ]);
    const densities = colorStops().map((stop) => stop[0]!);
    expect(densities).toEqual([...densities].sort((a, b) => a - b));
    expect(new Set(densities).size).toBe(densities.length);
    expect(densities[0]).toBe(0);
    expect(densities[densities.length - 1]).toBe(1);
    for (const [, r, g, b] of colorStops()) {
      for (const channel of [r!, g!, b!]) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(255);
      }
    }
  });

  it("gets more opaque with the density, from fully transparent to opaque", () => {
    const alphas = colorStops().map((stop) => stop[4]!);
    for (let i = 1; i < alphas.length; i++) {
      expect(alphas[i]).toBeGreaterThanOrEqual(alphas[i - 1]!);
    }
    // Nothing where there is no flight, or the whole map is tinted
    expect(alphas[0]).toBe(0);
    expect(alphas[alphas.length - 1]).toBe(1);
  });

  it("draws its faintest heat soft, and a flight's worth at half strength", () => {
    const visible = colorStops()
      .map((stop) => stop[4]!)
      .filter((alpha) => alpha > 0);
    // At 0.4 and 0.58 a route flown once was a band of even blue with
    // crisp edges, as strong as a busy corridor
    expect(Math.min(...visible)).toBe(0.22);
    expect(visible.slice(0, 2)).toEqual([0.22, 0.5]);
  });

  it("gives the low end of the ramp more steps of lightness than the top", () => {
    // The lightness of each stop over the dark base map (#0e0e0e)
    const lightness = colorStops()
      .slice(1)
      .map(
        ([, r, g, b, a]) =>
          a! * (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) + (1 - a!) * 14,
      );
    expect(lightness).toEqual([...lightness].sort((a, b) => a - b));
    const [quarter, one, two, four] = lightness as [
      number,
      number,
      number,
      number,
    ];
    // A quarter of a flight, one, two and four each about half as light
    // again as the one before, four well over twice as light as one
    for (const [lower, higher] of [
      [quarter, one],
      [one, two],
      [two, four],
    ] as const) {
      expect(higher / lower).toBeGreaterThan(1.4);
    }
    expect(four / one).toBeGreaterThan(2.2);
  });

  it("starts at full opacity and fades out for the heat lines", () => {
    expect(paint["heatmap-opacity"]).toEqual([
      "interpolate",
      ["linear"],
      ["zoom"],
      HEAT_LINES.midZoom,
      1,
      HEAT_LINES.fullZoom,
      0,
    ]);
  });

  it("fades the heatmap out only once the heat lines are all there", () => {
    // Both half faded at once lay a grey haze beside lines too faint yet
    expect(HEAT_LINES.fromZoom).toBeLessThan(HEAT_LINES.midZoom);
    expect(HEAT_LINES.midZoom).toBeLessThan(HEAT_LINES.fullZoom);
  });

  it("fades the heat lines in as the heatmap fades out", () => {
    for (const linePaint of Object.values(heatLinesPaint())) {
      const opacity = linePaint["line-opacity"] as unknown[];
      expect(opacity.slice(0, 5)).toEqual([
        "interpolate",
        ["linear"],
        ["zoom"],
        HEAT_LINES.fromZoom,
        0,
      ]);
      expect(opacity[5]).toBe(HEAT_LINES.midZoom);
    }
    // The glow is even, the core fainter where less time was spent
    const glow = heatLinesPaint()[MAP_LAYERS.heatLinesGlow]["line-opacity"];
    expect((glow as unknown[])[6]).toBeGreaterThan(0);
    expect((glow as unknown[])[6]).toBeLessThan(1);
    const core = (
      heatLinesPaint()[MAP_LAYERS.heatLinesCore]["line-opacity"] as unknown[]
    )[6] as unknown[];
    expect(core.slice(0, 3)).toEqual([
      "interpolate",
      ["linear"],
      ["get", "heat"],
    ]);
    const byHeat = core.slice(3).filter((_, i) => i % 2 === 1) as number[];
    expect(byHeat).toEqual([...byHeat].sort((a, b) => a - b));
    expect(byHeat[byHeat.length - 1]).toBe(1);
  });

  it("colours the heat lines with the heatmap's colours, by the seconds spent", () => {
    const heatColors = colorStops()
      .slice(1)
      .map(([, r, g, b]) => `rgb(${r}, ${g}, ${b})`);
    for (const linePaint of Object.values(heatLinesPaint())) {
      const color = linePaint["line-color"] as unknown[];
      expect(color.slice(0, 3)).toEqual([
        "interpolate",
        ["linear"],
        ["get", "heat"],
      ]);
      const stops = color.slice(3);
      const seconds = stops.filter((_, i) => i % 2 === 0) as number[];
      expect(stops.filter((_, i) => i % 2 === 1)).toEqual(heatColors);
      expect(seconds).toEqual([...seconds].sort((a, b) => a - b));
      expect(new Set(seconds).size).toBe(seconds.length);
    }
  });
});
