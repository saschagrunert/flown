/**
 * The cross-section tool (ui/crossSection.ts): drawing a line on the map by
 * pointer, drag and keyboard, its corridor (ui/crossSectionCorridor.ts),
 * the chart and its readout (ui/crossSectionChart.ts, with its words from
 * ui/crossSectionText.ts), and how it shares the bottom of the map with
 * replay, Wrapped and the profile.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  CROSS_SECTION_HEIGHT_VAR,
  crossSectionOpen,
  followCrossSection,
  toggleCrossSection,
} from "../../../../flown/frontend/ui/crossSection";
import {
  CROSS_SECTION_LAYERS,
  CROSS_SECTION_SOURCE,
} from "../../../../flown/frontend/ui/crossSectionCorridor";
import {
  densityColour,
  densityReference,
} from "../../../../flown/frontend/ui/crossSectionChart";
import { HEATMAP_GRADIENT } from "../../../../flown/frontend/ui/heatmapPaint";
import {
  heightUnit,
  sectionSummary,
} from "../../../../flown/frontend/ui/crossSectionText";
import type { CrossSection } from "../../../../flown/frontend/calculations/crossSection";
import { isSectionLine } from "../../../../flown/frontend/state/urlState";
import { MobileSheet } from "../../../../flown/frontend/ui/mobileSheet";
import type { PathSegment } from "../../../../flown/frontend/types";
import type {
  Map as MockMap,
  Marker as MockMarker,
} from "../../../mocks/maplibre-gl";
import {
  asMapApp,
  createDataset,
  createMockApp,
  stubAnimationFrames,
  type MockApp,
  type StubbedAnimationFrames,
} from "../../testHelpers";

// The shared fake, keeping the markers the code under test made
const markers = vi.hoisted((): unknown[] => []);
vi.mock("maplibre-gl", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../mocks/maplibre-gl")>();
  class Marker extends actual.Marker {
    constructor(options: Record<string, unknown> = {}) {
      super(options);
      markers.push(this);
    }
  }
  return { ...actual, Marker, default: { ...actual.default, Marker } };
});

/** The line's middle, and where the map is centred */
const LAT = 50;
const LON = 8.035;
/** The mock map draws a degree as 1000 pixels around its centre */
const PX_PER_DEGREE = 1000;

/** A flight due north across the middle of the map, 1,000 ft over ground */
function crossing(pathId: number, lon = LON): PathSegment[] {
  return Array.from({ length: 40 }, (_, i) => ({
    path_id: pathId,
    coords: [
      [LAT - 0.04 + i * 0.002, lon],
      [LAT - 0.04 + (i + 1) * 0.002, lon],
    ],
    altitude_ft: 1300,
    groundspeed_knots: 90,
    time: i * 10,
    ground_ft: 300,
  }));
}

/** Where a longitude and latitude are on the screen */
function screen(lon: number, lat = LAT): { clientX: number; clientY: number } {
  return {
    clientX: (lon - LON) * PX_PER_DEGREE,
    clientY: -(lat - LAT) * PX_PER_DEGREE,
  };
}

function pointer(
  type: string,
  at: { clientX: number; clientY: number },
  options: PointerEventInit = {},
): PointerEvent {
  return new PointerEvent(type, {
    ...at,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

let lifetime = new AbortController();
let frames: StubbedAnimationFrames;

interface Setup {
  app: MockApp;
  map: MockMap;
  canvas: HTMLElement;
  button: HTMLButtonElement;
}

async function setup(overrides: Parameters<typeof createMockApp>[0] = {}) {
  const app = createMockApp({
    currentData: createDataset(
      [{ id: 1 }, { id: 2 }],
      [...crossing(1), ...crossing(2, LON + 1)],
    ),
    signal: lifetime.signal,
    ...overrides,
  });
  const map = app.map as unknown as MockMap;
  map.jumpTo({ center: [LON, LAT], zoom: 12 });
  // The tool listens on the map once it is ready
  await app.mapReady;
  await Promise.resolve();
  return {
    app,
    map,
    canvas: map.getCanvas() as HTMLElement,
    button: document.getElementById("cross-section-btn") as HTMLButtonElement,
  } satisfies Setup;
}

/** Open the tool, whose listeners on the map come as it is ready */
async function open(app: MockApp): Promise<void> {
  toggleCrossSection(asMapApp(app));
  await Promise.resolve();
}

const root = (): HTMLElement => document.getElementById("cross-section")!;
const part = (selector: string): HTMLElement =>
  root().querySelector<HTMLElement>(selector)!;
const summary = (): string | null =>
  part(".section-plot").getAttribute("aria-label");

/** Click on the map at `lon`, as a press and a release in place */
function tap(canvas: HTMLElement, lon: number, lat = LAT): boolean {
  canvas.dispatchEvent(pointer("pointerdown", screen(lon, lat)));
  canvas.dispatchEvent(pointer("pointerup", screen(lon, lat)));
  return canvas.dispatchEvent(
    new MouseEvent("click", {
      ...screen(lon, lat),
      bubbles: true,
      cancelable: true,
    }),
  );
}

/** Draw the line from 0.035 degrees west of the middle to as far east */
function drawLine(canvas: HTMLElement): void {
  tap(canvas, LON - 0.035);
  tap(canvas, LON + 0.035);
}

/** The markers of the two ends, A first */
function handles(): MockMarker[] {
  return (markers as MockMarker[]).filter((marker) =>
    marker.getElement().classList.contains("section-handle"),
  );
}

describe("cross-section", () => {
  beforeEach(() => {
    lifetime = new AbortController();
    markers.length = 0;
    frames = stubAnimationFrames();
    document.body.className = "";
    document.body.innerHTML = `
      <button id="cross-section-btn" aria-pressed="false"></button>
      <main><div id="map"></div></main>`;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
      clearRect: vi.fn(),
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
  });

  afterEach(() => {
    lifetime.abort();
  });

  describe("drawing the line", () => {
    it("opens ready to place A, over the map's own drag", async () => {
      const { app, map, button } = await setup();
      const listener = vi.fn();
      followCrossSection(asMapApp(app), listener, lifetime.signal);

      toggleCrossSection(asMapApp(app));

      expect(crossSectionOpen(asMapApp(app))).toBe(true);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(root().hidden).toBe(false);
      // Ahead of the map in the tab order
      expect(root().nextElementSibling?.id).toBe("map");
      expect(document.body.classList.contains("cross-section-open")).toBe(true);
      expect(button.getAttribute("aria-pressed")).toBe("true");
      // The class draws the pressed look, as for the other toggles
      expect(button.classList).toContain("active");
      expect(map.dragPan.isEnabled()).toBe(false);
      expect(map.getContainer().classList).toContain("is-drawing-section");
      expect(part(".section-hint").textContent).toContain("two points");
      const place = part(".section-place-btn");
      expect(place.textContent).toBe("Set A at the map centre");
      expect(document.activeElement).toBe(place);
      expect(part(".section-plot").hidden).toBe(true);
      // The corridor's layers, below the airport labels
      const order = map.getLayersOrder();
      for (const id of Object.values(CROSS_SECTION_LAYERS)) {
        expect(order.indexOf(id)).toBeGreaterThanOrEqual(0);
        expect(order.indexOf(id)).toBeLessThan(order.indexOf("airport-labels"));
      }
    });

    it("places two points by click, and the chart shows the time there", async () => {
      const { app, map, canvas } = await setup();
      await open(app);

      // A click that places a point selects no flight
      const underneath = vi.fn();
      map.getCanvasContainer().addEventListener("click", underneath);
      expect(tap(canvas, LON - 0.035)).toBe(false);
      expect(underneath).not.toHaveBeenCalled();
      expect(handles()[0]!.map).toBe(map);
      expect(part(".section-place-btn").textContent).toBe(
        "Set B at the map centre",
      );
      // The mouse drags the line along before B is placed, once a frame to
      // where the pointer is last
      const source = map.source(CROSS_SECTION_SOURCE);
      const setData = source.setData;
      setData.mockClear();
      window.dispatchEvent(pointer("pointermove", screen(LON - 0.01)));
      window.dispatchEvent(pointer("pointermove", screen(LON)));
      expect(setData).not.toHaveBeenCalled();
      frames.run();
      expect(setData).toHaveBeenCalledOnce();
      const preview = source.data as GeoJSON.FeatureCollection;
      expect(preview.features).toHaveLength(2);
      const line = preview.features[1]!.geometry as GeoJSON.LineString;
      expect(line.coordinates.at(-1)![0]).toBeCloseTo(LON, 6);
      frames.run();
      expect(setData).toHaveBeenCalledOnce();

      expect(tap(canvas, LON + 0.035)).toBe(false);

      expect(map.dragPan.isEnabled()).toBe(true);
      expect(map.getContainer().classList).not.toContain("is-drawing-section");
      expect(handles().map((handle) => handle.map)).toEqual([map, map]);
      expect(part(".section-plot").hidden).toBe(false);
      // The corridor for the zoom: about 40 px either side
      expect(root().querySelector<HTMLSelectElement>("select")!.value).toBe(
        "500",
      );
      expect(summary()).toMatch(
        /^Cross-section: \d+ (s|min) from 1 flight within 500 m of a 5\.0 km line, most of it in the air between 1,000 and 1,125 ft AGL$/,
      );
      expect(part(".visually-hidden").textContent).toBe(summary());
      const stats = part(".profile-stats").textContent;
      expect(stats).toMatch(/Time \d+ (s|min)/);
      expect(stats).toContain("Flights 1");
      expect(stats).toContain("Most flown 1,000 to 1,125 ft AGL");
      expect(part(".profile-axis").textContent).toBe("A · 0 km5.0 km · B");
      expect(part(".section-unit").textContent).toBe("ft AGL");
      expect(part(".section-grid").getAttribute("d")).toMatch(/^M0 /);
      // No ground drawn above the ground itself
      expect(part(".section-ground").getAttribute("d")).toBe("");
      const shown = map.source(CROSS_SECTION_SOURCE)
        .data as GeoJSON.FeatureCollection;
      expect(
        shown.features.map((f) => f.properties!["kind"] as string),
      ).toEqual(["corridor", "line"]);

      // Clicks go to the map again
      expect(tap(canvas, LON)).toBe(true);
      expect(underneath).toHaveBeenCalledTimes(1);
    });

    it("draws a line by dragging", async () => {
      const { app, map, canvas } = await setup();
      await open(app);

      canvas.dispatchEvent(pointer("pointerdown", screen(LON - 0.035)));
      window.dispatchEvent(pointer("pointermove", screen(LON - 0.034)));
      expect(handles()[0]!.map).toBeNull();
      window.dispatchEvent(pointer("pointermove", screen(LON)));
      expect(handles()[0]!.map).not.toBeNull();
      window.dispatchEvent(pointer("pointerup", screen(LON + 0.035)));

      expect(summary()).toContain("of a 5.0 km line");
      // The frame the last move asked for draws no line being drawn over it
      frames.run();
      const drawn = map.source(CROSS_SECTION_SOURCE)
        .data as GeoJSON.FeatureCollection;
      const line = drawn.features[1]!.geometry as GeoJSON.LineString;
      expect(line.coordinates.at(-1)![0]).toBeCloseTo(LON + 0.035, 6);
    });

    it("gives the next click back to the map after a drag without one", async () => {
      const { app, map, canvas } = await setup();
      await open(app);
      const touch = { pointerType: "touch" };

      // A finger that drags the line has no click to end it
      canvas.dispatchEvent(pointer("pointerdown", screen(LON - 0.035), touch));
      window.dispatchEvent(pointer("pointermove", screen(LON), touch));
      window.dispatchEvent(pointer("pointerup", screen(LON + 0.035), touch));
      expect(summary()).toContain("of a 5.0 km line");

      const underneath = vi.fn();
      map.getCanvasContainer().addEventListener("click", underneath);
      expect(tap(canvas, LON)).toBe(true);
      expect(underneath).toHaveBeenCalledTimes(1);
    });

    it("keeps a double click or tap that places B from zooming the map", async () => {
      const { app, map, canvas } = await setup();
      await open(app);
      // The double tap's recogniser is off while the points are placed
      expect(map.doubleClickZoom.isEnabled()).toBe(false);
      const underneath = vi.fn();
      map.getCanvasContainer().addEventListener("dblclick", underneath);
      const click = (type: string, lon: number, detail: number): boolean =>
        canvas.dispatchEvent(
          new MouseEvent(type, {
            ...screen(lon),
            detail,
            bubbles: true,
            cancelable: true,
          }),
        );

      tap(canvas, LON - 0.002);
      canvas.dispatchEvent(pointer("pointerdown", screen(LON + 0.002)));
      canvas.dispatchEvent(pointer("pointerup", screen(LON + 0.002)));
      expect(click("click", LON + 0.002, 2)).toBe(false);
      expect(click("dblclick", LON + 0.002, 2)).toBe(false);
      expect(underneath).not.toHaveBeenCalled();
      expect(summary()).toContain("of a 0.3 km line");
      expect(map.doubleClickZoom.isEnabled()).toBe(true);

      // A double click of the map with the line shown is the map's
      tap(canvas, LON);
      expect(click("dblclick", LON, 2)).toBe(true);
      expect(underneath).toHaveBeenCalledTimes(1);
    });

    it("leaves the double tap switched off where the map had it off", async () => {
      const { app, map, canvas } = await setup();
      map.doubleClickZoom.disable();
      await open(app);
      drawLine(canvas);
      expect(map.doubleClickZoom.isEnabled()).toBe(false);
    });

    it("takes a press as a pinch when a second finger comes", async () => {
      const { app, canvas, map } = await setup();
      await open(app);

      canvas.dispatchEvent(pointer("pointerdown", screen(LON - 0.035)));
      canvas.dispatchEvent(
        pointer("pointerdown", screen(LON), { pointerId: 2, isPrimary: false }),
      );
      window.dispatchEvent(pointer("pointerup", screen(LON - 0.035)));
      expect(handles()[0]!.map).toBeNull();

      // A cancelled press, and a press beside the map, place nothing
      canvas.dispatchEvent(pointer("pointerdown", screen(LON - 0.035)));
      window.dispatchEvent(pointer("pointercancel", screen(LON - 0.035)));
      window.dispatchEvent(pointer("pointerup", screen(LON - 0.035)));
      map
        .getContainer()
        .dispatchEvent(pointer("pointerdown", screen(LON - 0.035)));
      window.dispatchEvent(pointer("pointerup", screen(LON - 0.035)));
      canvas.dispatchEvent(
        pointer("pointerdown", screen(LON - 0.035), { button: 2 }),
      );
      window.dispatchEvent(pointer("pointerup", screen(LON - 0.035)));
      expect(handles()[0]!.map).toBeNull();
      expect(root().hidden).toBe(false);
    });

    it("places the points at the map centre from the keyboard", async () => {
      const { app, map } = await setup();
      toggleCrossSection(asMapApp(app));
      const place = part(".section-place-btn");

      place.click();
      // B where A is: the map has to move first
      place.click();
      expect(part(".visually-hidden").textContent).toContain("B is where A is");
      expect(part(".section-plot").hidden).toBe(true);

      map.jumpTo({ center: [LON + 0.05, LAT] });
      place.focus();
      place.click();
      expect(summary()).toContain("of a 3.6 km line");
      // The button that placed B is gone: focus goes to the one in its place
      const redraw = part(".section-btn[aria-label='Draw a new line']");
      expect(document.activeElement).toBe(redraw);

      redraw.click();
      expect(document.activeElement).toBe(place);
    });

    it("cancels with Escape: the point, then the tool", async () => {
      const { app, canvas, map, button } = await setup();
      await open(app);
      const escape = (): boolean =>
        document.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );

      tap(canvas, LON - 0.035);
      expect(escape()).toBe(false);
      expect(handles()[0]!.map).toBeNull();
      expect(root().hidden).toBe(false);
      // Other keys, and an Escape something else took, do nothing
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
      const taken = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      taken.preventDefault();
      document.dispatchEvent(taken);
      expect(root().hidden).toBe(false);

      part(".section-place-btn").focus();
      escape();
      expect(root().hidden).toBe(true);
      expect(crossSectionOpen(asMapApp(app))).toBe(false);
      expect(map.dragPan.isEnabled()).toBe(true);
      expect(map.getLayer(CROSS_SECTION_LAYERS.line)).toBeUndefined();
      expect(map.getSource(CROSS_SECTION_SOURCE)).toBeUndefined();
      expect(button.getAttribute("aria-pressed")).toBe("false");
      expect(button.classList).not.toContain("active");
      expect(document.activeElement).toBe(button);
      // Closed, Escape is not its own
      expect(escape()).toBe(true);
    });

    it("leaves an Escape in a popup or for an airport's popup to them", async () => {
      const { app, canvas, map, button } = await setup();
      await open(app);
      drawLine(canvas);
      const escapeIn = (element: HTMLElement): boolean => {
        map.getContainer().append(element);
        element.tabIndex = 0;
        element.focus();
        return element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      };

      const popup = document.createElement("div");
      popup.className = "maplibregl-popup";
      expect(escapeIn(popup)).toBe(true);
      // A marker that closed its popup prevents the Escape
      const marker = document.createElement("div");
      marker.className = "maplibregl-marker";
      marker.addEventListener("keydown", (event) => event.preventDefault());
      expect(escapeIn(marker)).toBe(false);
      // Nor one in a text field, which empties it
      const search = document.createElement("input");
      search.type = "search";
      expect(escapeIn(search)).toBe(true);
      search.remove();
      expect(root().hidden).toBe(false);
      marker.remove();

      // One on a marker with no popup open is the tool's, as is one on an
      // end of its own: it closes, and focus goes to the control
      const b = handles()[1]!.getElement();
      b.classList.add("maplibregl-marker");
      expect(escapeIn(b)).toBe(false);
      expect(root().hidden).toBe(true);
      expect(document.activeElement).toBe(button);
    });

    it("puts its line in the store for the link, and takes it out as it closes", async () => {
      const { app, canvas } = await setup();
      await open(app);
      expect(app.crossSectionLine).toBe("");

      drawLine(canvas);
      const [a, b] = app.crossSectionLine.split(",").map(Number) as [
        number,
        number,
      ];
      expect(app.crossSectionLine.split(",")).toHaveLength(4);
      expect(a).toBeCloseTo(LAT, 4);
      expect(b).toBeCloseTo(LON - 0.035, 4);

      toggleCrossSection(asMapApp(app));
      expect(app.crossSectionLine).toBe("");
    });

    it("writes a line across the antimeridian for the link within 180 degrees", async () => {
      const { app, map, canvas } = await setup();
      // The map's centre just west of 180: the east end comes past it
      map.jumpTo({ center: [179.99, LAT], zoom: 12 });
      await open(app);

      drawLine(canvas);

      const [, west, , east] = app.crossSectionLine.split(",").map(Number);
      expect(west).toBeCloseTo(179.955, 4);
      expect(east).toBeCloseTo(-179.975, 4);
      expect(isSectionLine(app.crossSectionLine)).toBe(true);
    });

    it("opens on the line of the link, drawn and ready to read", async () => {
      const line = `${LAT},${LON - 0.035},${LAT},${LON + 0.035}`;
      const { app, map } = await setup({ crossSectionLine: line });

      await open(app);

      expect(part(".section-plot").hidden).toBe(false);
      expect(summary()).not.toBeNull();
      // The focus stays where it was: the page opened on the line, and
      // nobody pressed for it
      expect(document.activeElement).toBe(document.body);
      expect(map.dragPan.isEnabled()).toBe(true);
      expect(handles().map((handle) => handle.map)).toEqual([map, map]);
      expect(app.crossSectionLine.split(",").map(Number)).toEqual([
        LAT,
        LON - 0.035,
        LAT,
        LON + 0.035,
      ]);
    });

    it.each([[`${LAT},${LON},${LAT},${LON}`], ["0,-180,0,180"]])(
      "places a line of its own where the link's is too short: %s",
      async (line) => {
        const { app } = await setup({ crossSectionLine: line });

        await open(app);

        expect(part(".section-plot").hidden).toBe(true);
        expect(handles().some((handle) => handle.map)).toBe(false);
        // Neither in the link nor in the saved state any longer
        expect(app.crossSectionLine).toBe("");
      },
    );

    it("hands the focus to the More tab on a phone as it closes", async () => {
      const { app } = await setup();
      const more = document.createElement("button");
      more.id = "mobile-tab-more";
      document.body.append(more);
      app.mobileBar = {
        isVisible: () => true,
      } as unknown as MockApp["mobileBar"];
      await open(app);

      part(".section-btn[aria-label='Close the cross-section']").click();

      // The control of the columns is hidden there
      expect(document.activeElement).toBe(more);
      more.remove();
    });

    it("draws a new line, and Escape goes back to the one before", async () => {
      const { app, canvas } = await setup();
      await open(app);
      drawLine(canvas);
      const before = summary();

      part(".section-btn[aria-label='Draw a new line']").click();
      expect(part(".section-place").hidden).toBe(false);
      expect(summary()).toBeNull();
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );

      expect(part(".section-place").hidden).toBe(true);
      expect(summary()).toBe(before);
      // Shown, Escape closes it
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(root().hidden).toBe(true);
    });

    it("leaves an Escape to the phone's sheet open over it", async () => {
      const { app, canvas } = await setup();
      await open(app);
      drawLine(canvas);
      const sheet = new MobileSheet("test-sheet");
      sheet.mount(document.body);
      sheet.openWith("More", []);
      const escape = (): void => {
        sheet.root.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Escape",
            bubbles: true,
            cancelable: true,
          }),
        );
      };

      try {
        escape();
        expect(sheet.isOpen()).toBe(false);
        expect(root().hidden).toBe(false);
        // With the sheet away, the next one is the tool's
        escape();
        expect(root().hidden).toBe(true);
      } finally {
        sheet.destroy();
      }
    });

    it("closes by its button and by its control", async () => {
      const { app, canvas } = await setup();
      await open(app);
      drawLine(canvas);
      part(".section-btn[aria-label='Close the cross-section']").click();
      expect(root().hidden).toBe(true);

      toggleCrossSection(asMapApp(app));
      expect(root().hidden).toBe(false);
      toggleCrossSection(asMapApp(app));
      expect(root().hidden).toBe(true);
    });
  });

  describe("the chart", () => {
    it("reads out the cells under the pointer and marks the place", async () => {
      const { app, canvas, map } = await setup();
      await open(app);
      drawLine(canvas);
      const plot = part(".section-plot");
      vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
        left: 0,
        width: 200,
        bottom: 64,
        height: 64,
      } as DOMRect);

      // The middle column, at 1,000 ft of a chart up to 1,250
      plot.dispatchEvent(
        pointer("pointermove", { clientX: 100, clientY: 64 - 0.82 * 64 }),
      );
      expect(part(".profile-readout").textContent).toMatch(
        /^2\.5 km · [\d,]+ to [\d,]+ ft AGL · \d+ (s|min)$/,
      );
      expect(part(".section-hover").getAttribute("visibility")).toBe("visible");
      expect(part(".section-window").getAttribute("visibility")).toBe(
        "visible",
      );
      const dot = map.getCanvasContainer().querySelector(".profile-map-dot");
      expect(dot).not.toBeNull();
      // Moved as the pointer goes on, not taken off the map and put on anew
      const marker = (markers as MockMarker[]).find(
        (made) => made.getElement() === dot,
      )!;
      const first = marker.getLngLat()!.lng;
      plot.dispatchEvent(
        pointer("pointermove", { clientX: 150, clientY: 64 - 0.82 * 64 }),
      );
      expect(marker.addTo).toHaveBeenCalledOnce();
      expect(marker.getLngLat()!.lng).toBeGreaterThan(first);

      // Away from the flight there was no time
      plot.dispatchEvent(pointer("pointermove", { clientX: 10, clientY: 60 }));
      expect(part(".profile-readout").textContent).toContain("no flights here");

      plot.dispatchEvent(new PointerEvent("pointerleave"));
      expect(part(".profile-readout").textContent).toBe("");
      expect(part(".section-hover").getAttribute("visibility")).toBe("hidden");
      expect(
        map.getCanvasContainer().querySelector(".profile-map-dot"),
      ).toBeNull();

      // A finger reads while it is down
      plot.dispatchEvent(
        pointer(
          "pointerdown",
          { clientX: 100, clientY: 20 },
          {
            pointerType: "touch",
          },
        ),
      );
      expect(part(".profile-readout").textContent).not.toBe("");
      plot.dispatchEvent(
        pointer(
          "pointerup",
          { clientX: 100, clientY: 20 },
          {
            pointerType: "touch",
          },
        ),
      );
      expect(part(".profile-readout").textContent).toBe("");
      plot.dispatchEvent(pointer("pointerdown", { clientX: 100, clientY: 20 }));
      plot.dispatchEvent(pointer("pointerup", { clientX: 100, clientY: 20 }));
      expect(part(".profile-readout").textContent).not.toBe("");

      // Nothing to read on a plot without a size
      vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
        left: 0,
        width: 0,
        bottom: 0,
        height: 0,
      } as DOMRect);
      plot.dispatchEvent(new PointerEvent("pointerleave"));
      plot.dispatchEvent(pointer("pointermove", { clientX: 10, clientY: 10 }));
      expect(part(".profile-readout").textContent).toBe("");
    });

    it("widens the corridor and switches to heights above sea level", async () => {
      const { app, canvas, map } = await setup();
      await open(app);
      drawLine(canvas);
      const [width, heights] = root().querySelectorAll("select");

      width!.value = "2000";
      width!.dispatchEvent(new Event("change"));
      expect(summary()).toContain("within 2 km of a 5.0 km line");
      const ring = (
        map.source(CROSS_SECTION_SOURCE)
          .data as GeoJSON.FeatureCollection<GeoJSON.Polygon>
      ).features[0]!.geometry.coordinates[0]!;
      expect(Math.abs(ring[0]![1]! - LAT)).toBeCloseTo(2000 / 111320, 5);

      heights!.value = "msl";
      heights!.dispatchEvent(new Event("change"));
      expect(summary()).toContain("ft MSL");
      expect(part(".section-ground").getAttribute("d")).toMatch(/Z$/);

      // A new line keeps the corridor picked
      part(".section-btn[aria-label='Draw a new line']").click();
      drawLine(canvas);
      expect(summary()).toContain("within 2 km");
    });

    it("counts the selected flights alone", async () => {
      const { app, canvas } = await setup();
      await open(app);
      drawLine(canvas);

      app.selectedPathIds = new Set([2]);
      expect(summary()).toBe(
        "Cross-section: no selected flight passes within 500 m of a 5.0 km line",
      );
      expect(part(".profile-stats").textContent).toContain(
        "Selected flights 0",
      );

      app.selectedPathIds = new Set([1, 2]);
      expect(summary()).toContain("from 1 selected flight within");
    });

    it("weighs like the heatmap, and reads the time out", async () => {
      const { app, canvas } = await setup({
        currentData: createDataset([{ id: 1 }], crossing(1)),
      });
      await open(app);
      drawLine(canvas);
      expect(summary()).toMatch(/^Cross-section: \d+ (s|min) from 1 flight/);
      expect(part(".profile-stats").textContent).toMatch(/^Time \d+ (s|min)/);
      const plot = part(".section-plot");
      vi.spyOn(plot, "getBoundingClientRect").mockReturnValue({
        left: 0,
        width: 200,
        bottom: 64,
        height: 64,
      } as DOMRect);
      plot.dispatchEvent(
        pointer("pointermove", { clientX: 100, clientY: 64 - 0.82 * 64 }),
      );
      expect(part(".profile-readout").textContent).toMatch(
        /^2\.5 km · [\d,]+ to [\d,]+ ft AGL · \d+ (s|min)$/,
      );
    });

    it("draws nothing without data", async () => {
      const { app, canvas } = await setup({ currentData: null });
      await open(app);
      drawLine(canvas);
      expect(summary()).toBeNull();
      expect(part(".profile-stats").textContent).toBe("");
      expect(part(".visually-hidden").textContent).toBe("");
    });

    it("draws the density smoothed at the chart's pixels on the screen", async () => {
      const observers: ResizeObserverCallback[] = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: ResizeObserverCallback) {
            observers.push(callback);
          }
          observe(): void {}
          disconnect(): void {}
        },
      );
      vi.stubGlobal("devicePixelRatio", 2);
      const { app, canvas } = await setup();
      await open(app);
      const plot = part(".section-plot");
      vi.spyOn(plot, "clientWidth", "get").mockReturnValue(300);
      vi.spyOn(plot, "clientHeight", "get").mockReturnValue(120);
      const context = HTMLCanvasElement.prototype.getContext(
        "2d",
      ) as unknown as { drawImage: ReturnType<typeof vi.fn> };
      drawLine(canvas);

      const chart = part(".section-density") as HTMLCanvasElement;
      expect([chart.width, chart.height]).toEqual([600, 240]);
      expect(context.drawImage).toHaveBeenLastCalledWith(
        expect.any(HTMLCanvasElement),
        0,
        0,
        600,
        240,
      );
      // And again at a new size
      vi.spyOn(plot, "clientWidth", "get").mockReturnValue(200);
      observers[0]!([], {} as ResizeObserver);
      expect(chart.width).toBe(400);
    });

    it("keeps the panel's height for the toasts", async () => {
      const observers: ResizeObserverCallback[] = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: ResizeObserverCallback) {
            observers.push(callback);
          }
          observe(): void {}
          disconnect(): void {}
        },
      );
      const { app } = await setup();
      toggleCrossSection(asMapApp(app));
      vi.spyOn(root(), "offsetHeight", "get").mockReturnValue(180);
      observers[0]!([], {} as ResizeObserver);
      expect(
        document.documentElement.style.getPropertyValue(
          CROSS_SECTION_HEIGHT_VAR,
        ),
      ).toBe("180px");
      vi.spyOn(root(), "offsetHeight", "get").mockReturnValue(0);
      observers[0]!([], {} as ResizeObserver);
      expect(
        document.documentElement.style.getPropertyValue(
          CROSS_SECTION_HEIGHT_VAR,
        ),
      ).toBe("180px");
    });
  });

  describe("moving the ends", () => {
    it("follows a drag of an end in the next frame", async () => {
      const { app, canvas } = await setup();
      await open(app);
      drawLine(canvas);
      const [a] = handles();

      a!.setLngLat([LON - 0.07, LAT]);
      a!.emit("drag");
      a!.emit("drag");
      expect(frames.pending()).toBe(1);
      frames.run();
      expect(summary()).toContain("of a 7.5 km line");

      vi.useFakeTimers();
      try {
        a!.emit("dragend");
        vi.advanceTimersByTime(1000);
      } finally {
        vi.useRealTimers();
      }
      expect(part(".visually-hidden").textContent).toContain("7.5 km line");
    });

    it("moves an end with the arrow keys, further with Shift", async () => {
      const { app, canvas } = await setup();
      await open(app);
      drawLine(canvas);
      const b = handles()[1]!;
      const key = (init: KeyboardEventInit): KeyboardEvent => {
        const event = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ...init,
        });
        b.getElement().dispatchEvent(event);
        return event;
      };

      expect(key({ key: "ArrowRight" }).defaultPrevented).toBe(true);
      expect(b.getLngLat()!.lng).toBeCloseTo(LON + 0.045, 6);
      key({ key: "ArrowLeft", shiftKey: true });
      expect(b.getLngLat()!.lng).toBeCloseTo(LON - 0.005, 6);
      key({ key: "ArrowUp" });
      key({ key: "ArrowDown" });
      expect(b.getLngLat()!.lat).toBeCloseTo(LAT, 6);
      // Other keys are the map's
      expect(key({ key: "Enter" }).defaultPrevented).toBe(false);
      frames.run();
      expect(summary()).toContain("of a 2.1 km line");
    });

    it("keeps an end off the other, dragged or by the keys", async () => {
      const { app, canvas } = await setup();
      await open(app);
      drawLine(canvas);
      const [a, b] = handles();

      // Dragged onto A, B counts where it was and goes back there
      b!.setLngLat(a!.getLngLat()!);
      b!.emit("drag");
      expect(frames.pending()).toBe(0);
      b!.emit("dragend");
      expect(b!.getLngLat()!.lng).toBeCloseTo(LON + 0.035, 6);

      // A key that would put B on A leaves it where it is
      const key = (init: KeyboardEventInit): void => {
        b!.getElement().dispatchEvent(
          new KeyboardEvent("keydown", {
            bubbles: true,
            cancelable: true,
            ...init,
          }),
        );
      };
      key({ key: "ArrowLeft", shiftKey: true });
      key({ key: "ArrowLeft" });
      expect(b!.getLngLat()!.lng).toBeCloseTo(LON - 0.025, 6);
      key({ key: "ArrowLeft" });
      expect(b!.getLngLat()!.lng).toBeCloseTo(LON - 0.025, 6);
      frames.run();
      expect(summary()).toContain("of a 0.7 km line");
    });

    it("leaves a drag of an end alone while a line is drawn", async () => {
      const { app, canvas } = await setup();
      await open(app);
      drawLine(canvas);
      const before = summary();
      part(".section-btn[aria-label='Draw a new line']").click();
      const [a] = handles();
      a!.setLngLat([LON - 0.07, LAT]);
      a!.emit("drag");
      expect(frames.pending()).toBe(0);
      // Nor does a frame asked for before draw anything once it is closed
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      expect(summary()).toBe(before);
    });
  });

  describe("sharing the map", () => {
    it("closes as replay or Wrapped takes the map, and does not open then", async () => {
      const { app, canvas } = await setup();
      await open(app);
      drawLine(canvas);

      app.replayActive = true;
      expect(root().hidden).toBe(true);
      toggleCrossSection(asMapApp(app));
      expect(root().hidden).toBe(true);
      app.replayActive = false;

      toggleCrossSection(asMapApp(app));
      expect(root().hidden).toBe(false);
      app.wrappedVisible = true;
      expect(root().hidden).toBe(true);
    });

    it("does not open while the hotspot tour holds the map", async () => {
      const { app } = await setup();
      // Set by the tour, which closes the cross-section as it starts
      app.tourView = {
        center: { lat: LAT, lng: LON },
        zoom: 8,
        bearing: 0,
        pitch: 0,
        globeVisible: false,
        threeDVisible: false,
        heatmapVisible: true,
      };

      await open(app);

      expect(crossSectionOpen(asMapApp(app))).toBe(false);
      app.tourView = null;
      await open(app);
      expect(crossSectionOpen(asMapApp(app))).toBe(true);
    });

    it("puts its corridor back on a new base style", async () => {
      const { app, canvas, map } = await setup();
      await open(app);
      drawLine(canvas);

      map.removeLayer(CROSS_SECTION_LAYERS.line);
      map.removeLayer(CROSS_SECTION_LAYERS.edge);
      map.removeLayer(CROSS_SECTION_LAYERS.corridor);
      map.removeSource(CROSS_SECTION_SOURCE);
      map.emit("styledata");

      expect(map.getLayer(CROSS_SECTION_LAYERS.line)).toBeDefined();
      const data = map.source(CROSS_SECTION_SOURCE)
        .data as GeoJSON.FeatureCollection;
      expect(data.features).toHaveLength(2);
      // With its source there, or closed, a new style changes nothing
      map.emit("styledata");
      toggleCrossSection(asMapApp(app));
      map.emit("styledata");
      expect(map.getSource(CROSS_SECTION_SOURCE)).toBeUndefined();
    });

    it("puts its panel after the page where the map is elsewhere", async () => {
      const { app } = await setup();
      const holder = document.createElement("div");
      document.body.append(holder);
      holder.append(document.getElementById("map")!);
      toggleCrossSection(asMapApp(app));
      expect(document.body.lastElementChild).toBe(root());
    });

    it("does not open without a map", () => {
      const app = createMockApp({ map: null, signal: lifetime.signal });
      toggleCrossSection(asMapApp(app));
      expect(crossSectionOpen(asMapApp(app))).toBe(false);
    });

    it("goes with the app", async () => {
      const { app, canvas, map } = await setup();
      const listener = vi.fn();
      followCrossSection(asMapApp(app), listener, new AbortController().signal);
      await open(app);
      drawLine(canvas);
      listener.mockClear();

      lifetime.abort();

      expect(document.getElementById("cross-section")).toBeNull();
      expect(map.getSource(CROSS_SECTION_SOURCE)).toBeUndefined();
      expect(document.body.classList.contains("cross-section-open")).toBe(
        false,
      );
      expect(listener).toHaveBeenCalledTimes(1);
      expect(crossSectionOpen(asMapApp(app))).toBe(false);
    });

    it("listens to the map and the page only while it is open", async () => {
      const { app, canvas, map } = await setup();
      const styled = map.listenerCount("styledata");
      await open(app);
      expect(map.listenerCount("styledata")).toBe(styled + 1);

      toggleCrossSection(asMapApp(app));

      expect(map.listenerCount("styledata")).toBe(styled);
      // Presses and clicks on the map are the map's again
      canvas.dispatchEvent(pointer("pointerdown", screen(LON)));
      window.dispatchEvent(pointer("pointerup", screen(LON)));
      expect(tap(canvas, LON)).toBe(true);
      expect(handles()[0]!.map).toBeNull();
    });
  });
});

describe("the figures", () => {
  const section = (overrides: Partial<CrossSection> = {}): CrossSection => ({
    lengthM: 12_300,
    halfWidthM: 1000,
    reference: "agl",
    columns: 2,
    rows: 2,
    bottomFt: 0,
    topFt: 2000,
    gridStepFt: 500,
    seconds: new Float64Array(4),
    totalSeconds: 3600,
    aboveSeconds: 0,
    flights: 3,
    groundFt: null,
    fromTerrain: true,
    busiest: null,
    ...overrides,
  });

  it("says the time as the page says a length of time", () => {
    // Seconds, minutes, hours and minutes, and whole hours from ten of them
    // (utils/duration.ts): "485 min" was eight hours
    const said = (totalSeconds: number): string =>
      sectionSummary(section({ totalSeconds }), 0).split(" from ")[0]!;
    expect(said(30)).toBe("Cross-section: 30 s");
    expect(said(42 * 60)).toBe("Cross-section: 42 min");
    expect(said(485 * 60)).toBe("Cross-section: 8 h 5 min");
    expect(said(10 * 3600)).toBe("Cross-section: 10 h");
  });

  it("names the heights' unit", () => {
    expect(heightUnit(section())).toBe("ft AGL");
    expect(heightUnit(section({ fromTerrain: false }))).toBe("ft above field");
    expect(heightUnit(section({ reference: "msl" }))).toBe("ft MSL");
  });

  it("sums the chart up", () => {
    expect(sectionSummary(section(), 0)).toBe(
      "Cross-section: 1 h from 3 flights within 1 km of a 12 km line",
    );
  });

  it("takes the colours' white end from the fuller cells", () => {
    expect(densityReference(new Float64Array([0, 0]))).toBe(0);
    const values = Float64Array.from({ length: 100 }, (_, i) => i + 1);
    expect(densityReference(values)).toBe(96);
  });

  it("picks the cell a full sort would", () => {
    let seed = 7;
    const random = (): number =>
      (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let round = 0; round < 50; round++) {
      const values = Float64Array.from({ length: 1 + round * 37 }, () =>
        random() < 0.3 ? 0 : Math.round(random() * 50),
      );
      const filled = values.filter((value) => value > 0).sort();
      const expected = filled.length
        ? filled[Math.min(filled.length - 1, Math.floor(filled.length * 0.95))]
        : 0;
      const before = values.slice();
      expect(densityReference(values)).toBe(expected);
      // The cells it was given stay as they were, with a scratch grid of
      // another section's cells too
      expect(densityReference(values, new Float64Array(2000).fill(99))).toBe(
        expected,
      );
      expect(values).toEqual(before);
    }
  });
});

describe("the chart's colours", () => {
  it("are the heatmap's at each of its stops", () => {
    const out = new Uint8ClampedArray(4);
    for (const [share, rgb, alpha] of HEATMAP_GRADIENT) {
      densityColour(share, out, 0);
      expect(Array.from(out)).toEqual([
        ...rgb.split(",").map(Number),
        Math.round(255 * alpha),
      ]);
    }
  });

  it("draws a cell of every fullness", async () => {
    const lifetimeHere = new AbortController();
    document.body.innerHTML = `<div id="map"></div>`;
    const put = vi.fn();
    let image: { data: Uint8ClampedArray } | null = null;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (width: number, height: number) =>
        (image = { data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: put,
    } as unknown as CanvasRenderingContext2D);
    const app = createMockApp({
      // A second flight, slower, fills its cells fuller
      currentData: createDataset(
        [{ id: 1 }, { id: 3 }],
        [
          ...crossing(1),
          ...crossing(3, LON + 0.01).map((segment) => ({
            ...segment,
            time: segment.time! * 12,
          })),
        ],
      ),
      signal: lifetimeHere.signal,
    });
    const map = app.map as unknown as MockMap;
    map.jumpTo({ center: [LON, LAT], zoom: 12 });
    await app.mapReady;
    await Promise.resolve();
    await open(app);
    const canvas = map.getCanvas() as HTMLElement;
    drawLine(canvas);

    expect(put).toHaveBeenCalled();
    const alphas = new Set<number>();
    for (let i = 3; i < image!.data.length; i += 4) {
      if (image!.data[i]) alphas.add(image!.data[i]!);
    }
    expect(alphas.size).toBeGreaterThan(1);
    expect(Math.max(...alphas)).toBe(255);
    lifetimeHere.abort();
  });

  it("draws every section into one image, cleared first", async () => {
    const lifetimeHere = new AbortController();
    const ownFrames = stubAnimationFrames();
    markers.length = 0;
    document.body.innerHTML = `<div id="map"></div>`;
    const images: { data: Uint8ClampedArray }[] = [];
    const put = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      createImageData: (width: number, height: number) => {
        const image = { data: new Uint8ClampedArray(width * height * 4) };
        images.push(image);
        return image;
      },
      putImageData: put,
    } as unknown as CanvasRenderingContext2D);
    const app = createMockApp({
      currentData: createDataset([{ id: 1 }], crossing(1)),
      signal: lifetimeHere.signal,
    });
    const map = app.map as unknown as MockMap;
    map.jumpTo({ center: [LON, LAT], zoom: 12 });
    await app.mapReady;
    await Promise.resolve();
    await open(app);
    const canvas = map.getCanvas() as HTMLElement;
    drawLine(canvas);
    expect(images).toHaveLength(1);
    const filled = (): number =>
      images[0]!.data.filter((_, i) => i % 4 === 3 && images[0]!.data[i]! > 0)
        .length;
    expect(filled()).toBeGreaterThan(0);

    // A line far from the flight leaves the image empty, not as it was
    const calls = put.mock.calls.length;
    const [a, b] = handles();
    a!.setLngLat([LON - 0.035, LAT + 0.5]);
    b!.setLngLat([LON + 0.035, LAT + 0.5]);
    a!.emit("drag");
    ownFrames.run();
    expect(put.mock.calls.length).toBeGreaterThan(calls);
    expect(images).toHaveLength(1);
    expect(filled()).toBe(0);
    lifetimeHere.abort();
  });
});
