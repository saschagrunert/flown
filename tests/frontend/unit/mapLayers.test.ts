/**
 * The layer handles, on the mock app every ported suite builds on.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import type {
  Map as MapLibreMap,
  RasterDEMSourceSpecification,
  RasterSourceSpecification,
  StyleSpecification,
} from "maplibre-gl";
import {
  AIRPORTS_HIDDEN_CLASS,
  AVIATION_BAND,
  AVIATION_SHOWN_STATE,
  HEAT_SHOWN_STATE,
  setBaseStyle,
  withDataLayers,
} from "../../../flown/frontend/mapLayers";
import { heatmapRadiusPx } from "../../../flown/frontend/ui/heatmapPaint";
import {
  HEAT_LINES,
  HEATMAP_CLUSTER,
  MAP_LAYERS,
  MAP_MIN_ZOOM,
  MAP_SOURCES,
} from "../../../flown/frontend/utils/constants";
import { FALLBACK_STYLE } from "../../../flown/frontend/baseStyle";
import { createMapLibreMock, createMockApp } from "../testHelpers";
import { resetMapLibreMock } from "../../mocks/maplibre-gl";

describe("layer handles", () => {
  afterEach(() => {
    resetMapLibreMock();
  });

  it("start on a map that has every source and layer, all hidden", async () => {
    const app = createMockApp();
    const map = app.map!;

    // All but the elevation tiles and the satellite imagery, which come
    // with their code
    expect(Object.keys(map.sources).sort()).toEqual(
      Object.values(MAP_SOURCES)
        .filter(
          (id) => id !== MAP_SOURCES.terrain && id !== MAP_SOURCES.satellite,
        )
        .sort(),
    );
    for (const id of Object.values(MAP_LAYERS)) {
      expect(map.getLayer(id)).toBeDefined();
    }
    for (const id of [...app.heatmapLayer.ids, ...app.altitudeLayer.ids]) {
      expect(map.layer(id).layout["visibility"]).toBe("none");
    }
    await expect(app.mapReady).resolves.toBe(map);
  });

  it("switch every layer they own and nothing else", () => {
    const app = createMockApp();
    const map = app.map!;

    app.altitudeLayer.setVisible(true);

    expect(app.altitudeLayer.isVisible()).toBe(true);
    expect(map.layer(MAP_LAYERS.pathsAltitude).layout["visibility"]).toBe(
      "visible",
    );
    expect(
      map.layer(MAP_LAYERS.pathsAltitudeSelected).layout["visibility"],
    ).toBe("visible");
    expect(map.layer(MAP_LAYERS.pathsAirspeed).layout["visibility"]).toBe(
      "none",
    );

    app.altitudeLayer.setVisible(false);

    expect(map.layer(MAP_LAYERS.pathsAltitude).layout["visibility"]).toBe(
      "none",
    );
    expect(app.altitudeLayer.setVisible).toHaveBeenCalledTimes(2);
  });

  it("apply a switch made while the WebGL context was lost once the style is back", () => {
    const app = createMockApp();
    const map = app.map!;
    const getLayer = map.getLayer.getMockImplementation()!;
    map.getLayer.mockImplementation(() => undefined);

    app.altitudeLayer.setVisible(true);
    map.getLayer.mockImplementation(getLayer);
    expect(map.layer(MAP_LAYERS.pathsAltitude).layout["visibility"]).toBe(
      "none",
    );
    map.emit("webglcontextrestored");
    map.emit("style.load");

    expect(map.layer(MAP_LAYERS.pathsAltitude).layout["visibility"]).toBe(
      "visible",
    );
  });

  it("draw the heat source, which clusters the fixes, with one layer below the paths, and the isolated selection's alike", () => {
    const app = createMockApp();
    const map = app.map!;

    // The e2e driver reads the heatmap off `ids[0]`
    expect(app.heatmapLayer.ids).toEqual([
      MAP_LAYERS.heat,
      MAP_LAYERS.heatLinesGlow,
      MAP_LAYERS.heatLinesCore,
      MAP_LAYERS.heatIsolated,
    ]);
    for (const id of [MAP_SOURCES.heat, MAP_SOURCES.heatIsolated]) {
      expect(map.source(id).spec).toMatchObject({
        type: "geojson",
        cluster: true,
        clusterRadius: HEATMAP_CLUSTER.radius,
        clusterMaxZoom: HEATMAP_CLUSTER.maxZoom,
        // A cluster weighs the heat of its fixes, not their number
        clusterProperties: { w: ["+", ["get", "w"]] },
      });
      const layer = map.layer(id);
      expect(layer.type).toBe("heatmap");
      expect(layer.source).toBe(id);
      // One layer for every zoom: a second one could not show the tiles
      // of the level before while its own still load. It ends where it has
      // faded out, so its source is no longer cut into tiles further in.
      expect(layer.minzoom).toBeUndefined();
      expect(layer.maxzoom).toBe(HEAT_LINES.fullZoom);
      expect(layer.filter).toBeUndefined();
    }

    const order = map.getLayersOrder();
    const heat = order.indexOf(MAP_LAYERS.heat);
    expect(order[heat - 1]).toBe(MAP_LAYERS.aviation);
    expect(order[heat + 1]).toBe(MAP_LAYERS.heatIsolated);
    expect(order[heat + 2]).toBe(MAP_LAYERS.heatLinesGlow);
    expect(heat).toBeLessThan(order.indexOf(MAP_LAYERS.pathsAltitude));
  });

  it("draw the heat lines as a glow and a core over it, from where the heatmap fades", () => {
    const app = createMockApp();
    const map = app.map!;

    expect(map.source(MAP_SOURCES.heatLines).spec).toMatchObject({
      type: "geojson",
      tolerance: 0.25,
      maxzoom: 14,
    });
    for (const id of [MAP_LAYERS.heatLinesGlow, MAP_LAYERS.heatLinesCore]) {
      const layer = map.layer(id);
      expect(layer.type).toBe("line");
      expect(layer.source).toBe(MAP_SOURCES.heatLines);
      expect(layer.minzoom).toBe(HEAT_LINES.fromZoom);
      expect(layer.layout["visibility"]).toBe("none");
      // The lines of one flight meet end to end where its heat changes:
      // round caps overlapped there, a brighter bead on translucent lines
      expect(layer.layout["line-cap"]).toBe("butt");
      expect(layer.layout["line-join"]).toBe("round");
    }
    expect(HEAT_LINES.fullZoom).toBeGreaterThan(HEAT_LINES.fromZoom);

    const order = map.getLayersOrder();
    expect(order.indexOf(MAP_LAYERS.heatLinesCore)).toBe(
      order.indexOf(MAP_LAYERS.heatLinesGlow) + 1,
    );
    expect(order[order.indexOf(MAP_LAYERS.heatLinesCore) + 1]).toBe(
      MAP_LAYERS.selectionHighlight,
    );
  });

  it("cut the translucent colour lines square and keep the ends of a selection round", () => {
    const map = createMockApp().map!;

    // A flight is a line per run of one colour: round caps overlapped where
    // one run meets the next, a brighter bead on a translucent line
    for (const id of [MAP_LAYERS.pathsAltitude, MAP_LAYERS.pathsAirspeed]) {
      expect(map.layer(id).layout["line-cap"]).toBe("butt");
      expect(map.layer(id).layout["line-join"]).toBe("round");
    }
    for (const id of [
      MAP_LAYERS.pathsAltitudeSelected,
      MAP_LAYERS.pathsAirspeedSelected,
    ]) {
      expect(map.layer(id).layout["line-cap"]).toBe("round");
    }
  });

  it("draw the selection's lines over the heat, below the paths and the labels", () => {
    const app = createMockApp();
    const map = app.map!;

    expect(app.selectionHighlightLayer.ids).toEqual([
      MAP_LAYERS.selectionHighlight,
      MAP_LAYERS.selectionHighlightRibbons,
    ]);
    const line = map.layer(MAP_LAYERS.selectionHighlight);
    expect(line.type).toBe("line");
    expect(line.source).toBe(MAP_SOURCES.selectionHighlight);
    // At every zoom, the overview included
    expect(line.minzoom).toBeUndefined();
    expect(line.layout["visibility"]).toBe("none");
    // Thinner than a colour layer's line, and one colour: not taken for one
    expect(line.paint["line-width"]).toBeLessThan(
      map.layer(MAP_LAYERS.pathsAltitude).paint["line-width"] as number,
    );
    expect(line.paint["line-color"]).toBe("#f2f2f2");

    const order = map.getLayersOrder();
    const at = order.indexOf(MAP_LAYERS.selectionHighlight);
    expect(at).toBeGreaterThan(order.indexOf(MAP_LAYERS.heatLinesCore));
    expect(at).toBeLessThan(order.indexOf(MAP_LAYERS.pathsAltitude));
    expect(at).toBeLessThan(order.indexOf(MAP_LAYERS.airportLabels));
  });

  it("draw the selection's lines in the air of the 3D view as ribbons in their colour, with the other ribbons", () => {
    const map = createMockApp().map!;

    const ribbon = map.layer(MAP_LAYERS.selectionHighlightRibbons);
    expect(ribbon.type).toBe("fill-extrusion");
    expect(ribbon.source).toBe(MAP_SOURCES.selectionHighlightRibbons);
    expect(ribbon.layout["visibility"]).toBe("none");
    expect(ribbon.paint["fill-extrusion-color"]).toBe("#f2f2f2");
    expect(ribbon.paint["fill-extrusion-opacity"]).toBe(
      map.layer(MAP_LAYERS.selectionHighlight).paint["line-opacity"],
    );
    // Known by the id of their cut, like the other ribbons (see ribbonId)
    expect(map.source(ribbon.source!).spec).toMatchObject({
      tolerance: 0,
      promoteId: "k",
    });
    // In the air, among the ribbons: between the layers on the ground it
    // would have the relief drawn once more for every run of them
    const order = map.getLayersOrder();
    expect(order.indexOf(MAP_LAYERS.selectionHighlightRibbons)).toBe(
      order.indexOf(MAP_LAYERS.pathsAirspeedSelectedRibbons) + 1,
    );
    expect(order.indexOf(MAP_LAYERS.selectionHighlightRibbons)).toBe(
      order.indexOf(MAP_LAYERS.replayTrailRibbons) - 1,
    );
  });

  it("take the selection's colour from the stylesheet", () => {
    const root = document.documentElement.style;
    root.setProperty("--selection-highlight-color", "#ffffff");
    try {
      const map = createMockApp().map!;

      expect(map.layer(MAP_LAYERS.selectionHighlight).paint["line-color"]).toBe(
        "#ffffff",
      );
      expect(
        map.layer(MAP_LAYERS.selectionHighlightRibbons).paint[
          "fill-extrusion-color"
        ],
      ).toBe("#ffffff");
    } finally {
      root.removeProperty("--selection-highlight-color");
    }
  });

  it("draw the flights of each path source again as ribbons, from a source of their own", () => {
    const app = createMockApp();
    const map = app.map!;
    const pairs = [
      [MAP_LAYERS.pathsAltitude, MAP_LAYERS.pathsAltitudeRibbons],
      [MAP_LAYERS.pathsAirspeed, MAP_LAYERS.pathsAirspeedRibbons],
      [
        MAP_LAYERS.pathsAltitudeSelected,
        MAP_LAYERS.pathsAltitudeSelectedRibbons,
      ],
      [
        MAP_LAYERS.pathsAirspeedSelected,
        MAP_LAYERS.pathsAirspeedSelectedRibbons,
      ],
      [MAP_LAYERS.replayTrail, MAP_LAYERS.replayTrailRibbons],
    ] as const;

    for (const [lineId, ribbonId] of pairs) {
      const line = map.layer(lineId);
      const ribbon = map.layer(ribbonId);
      expect(ribbon.type).toBe("fill-extrusion");
      // A source of their own, named like the layer, and not simplified:
      // the lines' sources are
      expect(ribbon.source).toBe(ribbonId);
      expect(ribbon.source).not.toBe(line.source);
      expect(map.source(ribbonId).spec).toMatchObject({ tolerance: 0 });
      expect(line.filter).toBeUndefined();
      expect(ribbon.filter).toBeUndefined();
      // At every zoom
      expect(ribbon.minzoom).toBeUndefined();
      expect(ribbon.paint["fill-extrusion-color"]).toEqual(["get", "color"]);
    }
    // Drawn over every line, the replay's trail too, so the layers on the
    // ground are one run the relief draws in one pass, and under the
    // replay's trail in the air and the airport codes
    const order = map.getLayersOrder();
    expect(order.indexOf(MAP_LAYERS.pathsAltitudeRibbons)).toBe(
      order.indexOf(MAP_LAYERS.replayTrail) + 1,
    );
    expect(order.indexOf(MAP_LAYERS.replayTrail)).toBeGreaterThan(
      order.indexOf(MAP_LAYERS.pathsAirspeedSelected),
    );
    expect(order.indexOf(MAP_LAYERS.pathsAirspeedSelectedRibbons)).toBe(
      order.indexOf(MAP_LAYERS.replayTrailRibbons) - 2,
    );
  });

  it("switch the ribbons of a colour mode with its lines", () => {
    const app = createMockApp();
    const map = app.map!;

    app.altitudeLayer.setVisible(true);
    for (const id of [
      MAP_LAYERS.pathsAltitudeRibbons,
      MAP_LAYERS.pathsAltitudeSelectedRibbons,
    ]) {
      expect(map.layer(id).layout["visibility"]).toBe("visible");
    }
    expect(
      map.layer(MAP_LAYERS.pathsAirspeedRibbons).layout["visibility"],
    ).toBe("none");
  });

  it("switch the heat lines with the heatmap", () => {
    const app = createMockApp();
    const map = app.map!;

    app.heatmapLayer.setVisible(true);
    for (const id of [MAP_LAYERS.heatLinesGlow, MAP_LAYERS.heatLinesCore]) {
      expect(map.layer(id).layout["visibility"]).toBe("visible");
    }

    app.heatmapLayer.setVisible(false);
    for (const id of [MAP_LAYERS.heatLinesGlow, MAP_LAYERS.heatLinesCore]) {
      expect(map.layer(id).layout["visibility"]).toBe("none");
    }
  });

  it("keep the clusters finer than the reach of a point", () => {
    // A cluster radius near the reach of a point turns tracks into beads,
    // and the clusters of the last level are drawn up to the next, scaled
    // up to twice as far apart: the reach does not narrow before it
    expect(HEATMAP_CLUSTER.radius).toBeGreaterThan(0);
    expect(HEATMAP_CLUSTER.radius * 2).toBeLessThan(
      heatmapRadiusPx(HEATMAP_CLUSTER.maxZoom + 1),
    );
    expect(heatmapRadiusPx(HEATMAP_CLUSTER.maxZoom + 1)).toBe(
      heatmapRadiusPx(0),
    );
    expect(HEATMAP_CLUSTER.maxZoom).toBeGreaterThanOrEqual(MAP_MIN_ZOOM);
  });

  it("switch the heatmap on and off, and nothing else", () => {
    const app = createMockApp();
    const map = app.map!;
    const visibility = (): unknown =>
      map.layer(MAP_LAYERS.heat).layout["visibility"];

    app.heatmapLayer.setVisible(true);

    expect(app.heatmapLayer.isVisible()).toBe(true);
    expect(visibility()).toBe("visible");
    expect(map.layer(MAP_LAYERS.pathsAltitude).layout["visibility"]).toBe(
      "none",
    );

    app.heatmapLayer.setVisible(false);

    expect(app.heatmapLayer.isVisible()).toBe(false);
    expect(visibility()).toBe("none");
  });

  it("hide the airport markers through a class on the map container", () => {
    const app = createMockApp();
    const container = app.map!.getContainer();

    expect(container.classList.contains(AIRPORTS_HIDDEN_CLASS)).toBe(false);

    app.airportLayer.setVisible(false);
    expect(container.classList.contains(AIRPORTS_HIDDEN_CLASS)).toBe(true);

    app.airportLayer.setVisible(true);
    expect(container.classList.contains(AIRPORTS_HIDDEN_CLASS)).toBe(false);
  });

  it("switch the airport labels, a layer of the map, with their markers", () => {
    const app = createMockApp();
    const map = app.map!;
    const visibility = (): unknown[] =>
      [MAP_LAYERS.airportLabels, MAP_LAYERS.airportDots].map(
        (id) => map.layer(id).layout["visibility"],
      );

    // On by default, like the markers, and the stand-ins of the dots with
    // the labels that give way to them
    expect(visibility()).toEqual(["visible", "visible"]);

    app.airportLayer.setVisible(false);
    expect(visibility()).toEqual(["none", "none"]);

    app.airportLayer.setVisible(true);
    expect(visibility()).toEqual(["visible", "visible"]);
  });

  it("put the airport labels on top of every layer, labels of the style included", () => {
    const app = createMockApp();
    const order = app.map!.getLayersOrder();

    // The stand-ins of the dots above them, which the map places first
    expect(order.slice(-2)).toEqual([
      MAP_LAYERS.airportLabels,
      MAP_LAYERS.airportDots,
    ]);
    expect(app.map!.layer(MAP_LAYERS.airportLabels).type).toBe("symbol");
    expect(app.map!.layer(MAP_LAYERS.airportDots).type).toBe("symbol");
  });

  it("only remember the wish on an app without a map", () => {
    const app = createMockApp({ map: null });

    app.heatmapLayer.setVisible(true);

    expect(app.heatmapLayer.isVisible()).toBe(true);
  });
});

describe("withDataLayers", () => {
  const EMPTY = { type: "FeatureCollection", features: [] };
  const heat = { type: "geojson", data: "fixes", cluster: true } as const;
  // The map serialises its style anew for every transform, and the
  // transform may change it
  let previous: StyleSpecification;
  beforeEach(() => {
    previous = {
      version: 8,
      sources: { [MAP_SOURCES.heat]: heat },
      layers: [
        { id: "background", type: "background" },
        { id: MAP_LAYERS.heat, type: "heatmap", source: MAP_SOURCES.heat },
        { id: MAP_LAYERS.replayTrail, type: "line", source: MAP_SOURCES.heat },
      ],
    };
  });

  it("leaves a style alone that has none before it", () => {
    const next: StyleSpecification = { version: 8, sources: {}, layers: [] };

    expect(withDataLayers(undefined, next)).toBe(next);
  });

  it("goes on top of a style without labels, and leaves the old base behind", () => {
    const next: StyleSpecification = {
      version: 8,
      glyphs: "https://example.test/{fontstack}/{range}.pbf",
      sources: { base: { type: "raster", tiles: [] } },
      layers: [{ id: "base", type: "raster", source: "base" }],
    };

    const style = withDataLayers(previous, next);

    expect(style.layers.map((layer) => layer.id)).toEqual([
      "base",
      MAP_LAYERS.heat,
      MAP_LAYERS.replayTrail,
    ]);
    expect(style.sources).toEqual({
      base: next.sources["base"],
      [MAP_SOURCES.heat]: heat,
    });
    // The source as it was, not a copy the map would take for a new one
    expect(style.sources[MAP_SOURCES.heat]).toBe(heat);
    expect(style.glyphs).toBe(next.glyphs);
    expect(next.layers).toHaveLength(1);
    expect(style.projection).toBeUndefined();
  });

  it("carries a GeoJSON source without its data into a style the map diffs, the same in the style before", () => {
    const next: StyleSpecification = { version: 8, sources: {}, layers: [] };
    const aviation: RasterSourceSpecification = { type: "raster", tiles: [] };
    previous.sources[MAP_SOURCES.aviation] = aviation;

    const style = withDataLayers(previous, next, true);

    // The map compares the two, copies the new one and keeps the copy for
    // as long as it is on: equal, it leaves the source and its data alone
    const carried = style.sources[MAP_SOURCES.heat];
    expect(carried).toEqual({ ...heat, data: EMPTY });
    expect(previous.sources[MAP_SOURCES.heat]).toBe(carried);
    // Its options stay what they were, and the old data where it was
    expect(heat.data).toBe("fixes");
    // A source without data is carried as it is
    expect(style.sources[MAP_SOURCES.aviation]).toBe(aviation);
  });

  it("keeps the airport labels on top of the new style's labels", () => {
    const next: StyleSpecification = {
      version: 8,
      sources: { places: { type: "geojson", data: "places" } },
      layers: [
        { id: "base", type: "background" },
        { id: "place-labels", type: "symbol", source: "places" },
      ],
    };
    const labelled: StyleSpecification = {
      ...previous,
      layers: [
        ...previous.layers,
        {
          id: MAP_LAYERS.airportLabels,
          type: "symbol",
          source: MAP_SOURCES.heat,
        },
        {
          id: MAP_LAYERS.airportDots,
          type: "symbol",
          source: MAP_SOURCES.heat,
        },
      ],
    };

    const style = withDataLayers(labelled, next);

    expect(style.layers.map((layer) => layer.id)).toEqual([
      "base",
      MAP_LAYERS.heat,
      MAP_LAYERS.replayTrail,
      "place-labels",
      MAP_LAYERS.airportLabels,
      MAP_LAYERS.airportDots,
    ]);
  });

  it("steps the new style's labels back while the heat is drawn, and none of the app's", () => {
    const next: StyleSpecification = {
      version: 8,
      sources: { places: { type: "geojson", data: "places" } },
      layers: [
        { id: "base", type: "background" },
        {
          id: "place-labels",
          type: "symbol",
          source: "places",
          paint: { "text-color": "#fff" },
        },
        {
          id: "own-opacity",
          type: "symbol",
          source: "places",
          paint: {
            "text-opacity": 0.3,
            "text-halo-color": "#111",
            "text-halo-width": [
              "interpolate",
              ["linear"],
              ["zoom"],
              4,
              0.5,
              8,
              1,
            ],
          },
        },
      ],
    };
    const labelled: StyleSpecification = {
      ...previous,
      layers: [
        ...previous.layers,
        {
          id: MAP_LAYERS.airportLabels,
          type: "symbol",
          source: MAP_SOURCES.heat,
        },
        {
          id: MAP_LAYERS.airportDots,
          type: "symbol",
          source: MAP_SOURCES.heat,
        },
      ],
    };

    const style = withDataLayers(labelled, next);
    const paint = (id: string): unknown =>
      style.layers.find((layer) => layer.id === id)!.paint;

    const shown = ["global-state", HEAT_SHOWN_STATE];
    // Across the aviation chart's band, only while the chart is off: the
    // heat steps back for it there, by zoom in every frame of a pinch
    const byZoom = (value: unknown, otherwise: unknown): unknown => [
      "step",
      ["zoom"],
      ["case", shown, value, otherwise],
      AVIATION_BAND[0],
      [
        "case",
        [
          "all",
          shown,
          ["!", ["to-boolean", ["global-state", AVIATION_SHOWN_STATE]]],
        ],
        value,
        otherwise,
      ],
      AVIATION_BAND[1],
      ["case", shown, value, otherwise],
    ];
    // A little fainter, on a wider and darker halo than the style's none
    expect(paint("place-labels")).toEqual({
      "text-color": "#fff",
      "text-opacity": byZoom(0.78, 1),
      "text-halo-color": byZoom("rgba(14, 14, 14, 0.9)", "rgba(0, 0, 0, 0)"),
      "text-halo-width": byZoom(1.6, 0),
    });
    // Valid for MapLibre, as the style of the map is not validated
    expect(
      validateStyleMin({
        ...style,
        sources: next.sources,
        layers: style.layers.filter((layer) => layer.id === "place-labels"),
      }),
    ).toEqual([]);
    // An opacity of the style's own stays, and so does a halo that follows
    // the zoom, which a `case` cannot hold; the style it came in is left
    // as it was, and the airport labels and the stand-ins of their dots
    // are the app's
    expect(paint("own-opacity")).toEqual(next.layers[2]!.paint);
    expect(next.layers[1]!.paint).toEqual({ "text-color": "#fff" });
    expect(paint(MAP_LAYERS.airportLabels)).toBeUndefined();
    expect(paint(MAP_LAYERS.airportDots)).toBeUndefined();
  });

  it("draws the base style's band along the borders faintly, and its line as it is", () => {
    const next: StyleSpecification = {
      version: 8,
      sources: { borders: { type: "geojson", data: "borders" } },
      layers: [
        {
          id: "boundary_country_outline",
          type: "line",
          source: "borders",
          paint: {
            "line-color": "#2C353C",
            "line-opacity": 0.5,
            "line-width": 8,
          },
        },
        {
          id: "boundary_country_inner",
          type: "line",
          source: "borders",
          paint: { "line-opacity": 1 },
        },
      ],
    };

    const style = withDataLayers(previous, next);
    const paint = (id: string): unknown =>
      style.layers.find((layer) => layer.id === id)!.paint;

    expect(paint("boundary_country_outline")).toEqual({
      "line-color": "#2C353C",
      "line-opacity": 0.2,
      "line-width": 8,
    });
    expect(paint("boundary_country_inner")).toEqual({ "line-opacity": 1 });
  });

  it("keeps the sky of a tilted map, which the base style does not have", () => {
    const next: StyleSpecification = { version: 8, sources: {}, layers: [] };
    const sky = { "sky-color": "#000000" };

    expect(withDataLayers({ ...previous, sky }, next).sky).toEqual(sky);
    // A base style with a sky of its own keeps it
    const own = { "sky-color": "#ffffff" };
    expect(
      withDataLayers({ ...previous, sky }, { ...next, sky: own }).sky,
    ).toBe(own);
  });

  it("keeps the globe chosen before the base style arrived", () => {
    const next: StyleSpecification = { version: 8, sources: {}, layers: [] };

    const style = withDataLayers(
      { ...previous, projection: { type: "globe" } },
      next,
    );

    expect(style.projection).toEqual({ type: "globe" });
  });

  it("keeps the relief of the 3D view, and its elevation tiles", () => {
    const next: StyleSpecification = { version: 8, sources: {}, layers: [] };
    const dem: RasterDEMSourceSpecification = {
      type: "raster-dem",
      tiles: [],
      encoding: "terrarium",
    };
    const terrain = { source: MAP_SOURCES.terrain, exaggeration: 2 };

    const style = withDataLayers(
      {
        ...previous,
        sources: { ...previous.sources, [MAP_SOURCES.terrain]: dem },
        terrain,
      },
      next,
    );

    expect(style.terrain).toEqual(terrain);
    expect(style.sources[MAP_SOURCES.terrain]).toBe(dem);
    expect(withDataLayers(previous, next).terrain).toBeUndefined();
  });
});

describe("setBaseStyle", () => {
  /** A source's data: one fix */
  const fixesAt = (lng: number, lat: number): GeoJSON.FeatureCollection => ({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: null,
        geometry: { type: "Point", coordinates: [lng, lat] },
      },
    ],
  });
  const next: StyleSpecification = {
    version: 8,
    sources: {},
    layers: [{ id: "base", type: "background" }],
  };

  afterEach(() => {
    resetMapLibreMock();
  });

  it("leaves the data of the sources where it is when the map applies the difference", async () => {
    const app = createMockApp();
    await app.mapReady;
    const map = app.map!;
    const fixes = fixesAt(8, 50);
    const heat = map.source(MAP_SOURCES.heat);
    void heat.setData(fixes);
    heat.setData.mockClear();

    setBaseStyle(map as unknown as MapLibreMap, next);

    expect(map.source(MAP_SOURCES.heat)).toBe(heat);
    expect(heat.data).toBe(fixes);
    expect(heat.setData).not.toHaveBeenCalled();
    expect(map.getLayersOrder()[0]).toBe("base");
  });

  it("carries the data of the sources when the map builds the style anew", () => {
    // A map whose difference failed: it builds the style from the one it
    // was given, a frame later, on a style that has not loaded yet
    const fixes = fixesAt(8, 50);
    const map = {
      getStyle: () => undefined,
      setStyle: vi.fn(),
    };

    setBaseStyle(map as unknown as MapLibreMap, next);
    // Validated in a test instead (see withoutValidation)
    expect(map.setStyle.mock.calls[0]![1]).toMatchObject({ validate: false });
    const { transformStyle } = map.setStyle.mock.calls[0]![1] as {
      transformStyle: (
        previous: StyleSpecification,
        next: StyleSpecification,
      ) => StyleSpecification;
    };
    const built = transformStyle(
      {
        version: 8,
        sources: { [MAP_SOURCES.heat]: { type: "geojson", data: fixes } },
        layers: [],
      },
      next,
    );

    expect(built.sources[MAP_SOURCES.heat]).toEqual({
      type: "geojson",
      data: fixes,
    });
  });
});

describe("the style the app composes", () => {
  afterEach(() => {
    resetMapLibreMock();
  });

  /** The map's style as a plain style, without the fake's own fields */
  const styleOf = (map: ReturnType<typeof createMockApp>["map"]) => {
    const style = map!.getStyle() as unknown as StyleSpecification;
    return {
      ...style,
      layers: style.layers.map((layer) => {
        const { sourceLayer: _, ...plain } = layer as typeof layer & {
          sourceLayer?: string;
        };
        return plain;
      }),
    } as StyleSpecification;
  };

  // The map adds the app's layers and sources without validating them (see
  // withoutValidation), so a layer the style specification refuses would
  // only show as a map that draws nothing. This is where they are checked.
  it("passes the style specification's validation, on the start style and under a base style with labels", () => {
    const app = createMockApp({
      map: createMapLibreMock({ style: FALLBACK_STYLE }),
    });
    // Every layer the app can show, shown
    for (const handle of [
      app.heatmapLayer,
      app.altitudeLayer,
      app.airspeedLayer,
      app.aviationLayer,
      app.selectionHighlightLayer,
    ]) {
      handle.setVisible(true);
    }
    const started = { ...FALLBACK_STYLE, ...styleOf(app.map) };

    expect(validateStyleMin(started)).toEqual([]);

    const base: StyleSpecification = {
      version: 8,
      glyphs: "https://example.test/{fontstack}/{range}.pbf",
      sources: {
        base: { type: "vector", url: "https://example.test/tiles.json" },
      },
      layers: [
        { id: "background", type: "background" },
        {
          id: "place-labels",
          type: "symbol",
          source: "base",
          "source-layer": "place",
          layout: { "text-field": ["get", "name"] },
        },
      ],
    };
    const composed = withDataLayers(started, base, true);

    expect(composed.layers.length).toBe(started.layers.length + 1);
    expect(validateStyleMin(composed)).toEqual([]);
  });

  it("would be refused where a layer breaks the specification", () => {
    // The check itself: a line with a paint property of a fill
    const broken: StyleSpecification = {
      version: 8,
      sources: { lines: { type: "geojson", data: "lines.json" } },
      layers: [
        {
          id: "lines",
          type: "line",
          source: "lines",
          paint: { "fill-color": "#ffffff" } as never,
        },
      ],
    };

    expect(validateStyleMin(broken)).not.toEqual([]);
  });
});
