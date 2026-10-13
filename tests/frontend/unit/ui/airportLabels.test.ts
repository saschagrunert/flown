import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  addAirportLabelImages,
  AirportCodes,
  airportDotLayer,
  airportLabelLayer,
  NO_CODE_LABEL,
  pinScale,
  type CodeHost,
  type CodeMarker,
} from "../../../../flown/frontend/ui/airportLabels";
import { createAirportElement } from "../../../../flown/frontend/features/airports";
import {
  AIRPORT_HIDE_MARKERS_BELOW_ZOOM,
  MAP_LAYERS,
  MAP_SOURCES,
} from "../../../../flown/frontend/utils/constants";
import { resetMapLibreMock } from "../../../mocks/maplibre-gl";
import { createMapLibreMock } from "../../testHelpers";

/** The size the step expression gives at a zoom */
function sizeAt(expression: unknown[], zoom: number): number {
  let size = expression[2] as number;
  for (let i = 3; i < expression.length; i += 2) {
    if (zoom >= (expression[i] as number)) {
      size = expression[i + 1] as number;
    }
  }
  return size;
}

describe("airport labels", () => {
  afterEach(() => resetMapLibreMock());

  describe("airportLabelLayer", () => {
    it("takes the room of each code drawn, and draws nothing", () => {
      const layer = airportLabelLayer();

      expect(layer.id).toBe(MAP_LAYERS.airportLabels);
      expect(layer.source).toBe(MAP_SOURCES.airportLabels);
      expect(layer.minzoom).toBe(AIRPORT_HIDE_MARKERS_BELOW_ZOOM);
      // Only the airports whose code is drawn, where it is drawn
      expect(layer.filter).toEqual(["has", "o"]);
      expect(layer.layout).toMatchObject({
        visibility: "none",
        "text-field": ["get", "icao"],
        // As large as the code is drawn there (see AirportCodes)
        "text-size": ["get", "s"],
        "text-offset": ["array", "number", 2, ["get", "o"]],
        // Always placed, so the place names give way to it
        "text-allow-overlap": true,
      });
      expect(layer.layout).not.toHaveProperty("text-ignore-placement");
      expect(layer.paint).toEqual({ "text-opacity": 0 });
    });

    it("asks the glyph server for the base style's font, with a local fallback", () => {
      const font = airportLabelLayer().layout!["text-font"] as string[];

      expect(font[0]).toBe("Roboto Medium");
      expect(font.at(-1)).toBe("sans-serif");
    });
  });

  describe("airportDotLayer", () => {
    it("stands in for each dot of the label source, placed whatever it overlaps", () => {
      const layer = airportDotLayer();

      expect(layer.id).toBe(MAP_LAYERS.airportDots);
      expect(layer.source).toBe(MAP_SOURCES.airportLabels);
      expect(layer.layout).toMatchObject({
        visibility: "none",
        "icon-image": "airport-dot-room",
        "icon-allow-overlap": true,
        "icon-padding": 0,
      });
      expect(layer.layout).not.toHaveProperty("icon-ignore-placement");
    });

    it("is as large as the dot with its ring at every zoom", () => {
      const size = airportDotLayer().layout!["icon-size"] as unknown[];

      // --marker-size and twice --marker-border of styles.css
      expect(sizeAt(size, 4)).toBe(8);
      expect(sizeAt(size, 5)).toBe(9);
      expect(sizeAt(size, 7)).toBe(10);
      expect(sizeAt(size, 9)).toBe(14);
      expect(sizeAt(size, 11)).toBe(15);
      expect(sizeAt(size, 13)).toBe(16);
    });
  });

  describe("addAirportLabelImages", () => {
    it("gives the stand-in of a dot a transparent pixel, and gives it back to a new style", () => {
      const map = createMapLibreMock();
      addAirportLabelImages(map as unknown as MapLibreMap);

      expect(map.images.get("airport-dot-room")).toEqual({
        width: 1,
        height: 1,
        data: new Uint8Array(4),
      });

      map.images.clear();
      map.emit("styleimagemissing", { id: "some-sprite-icon" });
      expect(map.images.size).toBe(0);
      map.emit("styleimagemissing", { id: "airport-dot-room" });
      expect(map.images.size).toBe(1);
    });
  });

  describe("pinScale", () => {
    it("follows the map's perspective ratio within bounds, in steps", () => {
      expect(pinScale(1, 12, 0)).toBe(1);
      expect(pinScale(1.07, 12, 0)).toBeCloseTo(1.05);
      expect(pinScale(2, 12, 0)).toBeCloseTo(1.15);
      expect(pinScale(0.4, 13, 0)).toBeCloseTo(0.7);
    });

    it("never draws text smaller than the layout's smallest, nor 9 pixels", () => {
      // 11 pixels at most 9/11 smaller
      expect(pinScale(0.4, 11, 0) * 11).toBeGreaterThanOrEqual(9 - 0.3);
      // A phone's 12 pixels are its smallest: never smaller there
      expect(pinScale(0.4, 12, 12)).toBe(1);
    });
  });

  describe("AirportCodes", () => {
    let map: ReturnType<typeof createMapLibreMock>;
    let markers: CodeMarker[];
    let overview: boolean;
    let moved: ReturnType<typeof vi.fn<(name: string) => void>>;
    let stop: AbortController;

    /** An airport `east` and `south` pixels from the map's middle */
    function marker(name: string, east: number, south: number): CodeMarker {
      const element = createAirportElement(name, name.slice(0, 4));
      return {
        name,
        element,
        arm: element.querySelector<HTMLElement>(".airport-code-arm"),
        lng: 8 + east / 1000,
        lat: 51 - south / 1000,
      };
    }

    function codes(): AirportCodes {
      const host: CodeHost = {
        map: map as unknown as MapLibreMap,
        ranked: () => markers,
        overview: () => overview,
        moved,
      };
      return new AirportCodes(host, stop.signal);
    }

    const arm = (at: CodeMarker): HTMLElement =>
      at.element.querySelector<HTMLElement>(".airport-code-arm")!;

    beforeEach(() => {
      vi.useFakeTimers({
        toFake: [
          "setTimeout",
          "clearTimeout",
          "requestAnimationFrame",
          "cancelAnimationFrame",
        ],
      });
      map = createMapLibreMock();
      map.jumpTo({ center: [8, 51], zoom: 6 });
      const container = map.getContainer();
      Object.defineProperty(container, "clientWidth", { value: 800 });
      Object.defineProperty(container, "clientHeight", { value: 600 });
      markers = [marker("EDDF Frankfurt", 300, 300)];
      overview = false;
      moved = vi.fn<(name: string) => void>();
      stop = new AbortController();
    });

    afterEach(() => {
      stop.abort();
      vi.useRealTimers();
    });

    it("draws a code above its dot, gliding there by its custom properties", () => {
      codes().update();
      const codeArm = arm(markers[0]!);

      expect(codeArm.classList.contains("is-hidden")).toBe(false);
      expect(codeArm.style.getPropertyValue("--code-angle")).toBe("-90deg");
      expect(codeArm.style.getPropertyValue("--code-from")).toMatch(/px$/);
      expect(Number(codeArm.style.getPropertyValue("--code-stem"))).toBe(5);
      // Shown for the first time, it is there at once and fades in
      expect(codeArm.classList.contains("is-jump")).toBe(true);
      vi.advanceTimersToNextFrame();
      expect(codeArm.classList.contains("is-jump")).toBe(false);
      expect(moved).toHaveBeenCalledWith("EDDF Frankfurt");
    });

    it("turns a code that has to go round its dot the short way", () => {
      const placer = codes();
      placer.update();
      // An airport right above it takes the room above
      markers = [marker("EDDK Cologne", 300, 278), markers[0]!];
      placer.update();

      const angle = parseFloat(
        arm(markers[1]!).style.getPropertyValue("--code-angle"),
      );
      expect(angle).not.toBe(-90);
      expect(Math.abs(angle + 90)).toBeLessThanOrEqual(180);
      expect(placer.placeOf("EDDF Frankfurt")?.angle).toBe(
        ((angle + 540) % 360) - 180,
      );
    });

    it("tells of a code that went elsewhere once it is there", () => {
      // An open popup asks where the code is now, to keep clear of it
      const placer = codes();
      placer.update();
      const told: (number | undefined)[] = [];
      moved.mockImplementation((name) =>
        told.push(placer.placeOf(name)?.angle),
      );
      markers = [marker("EDDK Cologne", 300, 278), markers[0]!];

      placer.update();

      expect(told).toHaveLength(2);
      expect(told[1]).toBe(placer.placeOf("EDDF Frankfurt")!.angle);
      expect(told[1]).not.toBe(-90);
    });

    it("places the code of an airport in the world the map shows", () => {
      // Ranked with the map a world away: MapLibre draws the marker on the
      // copy of the world the map is centred on
      markers[0]!.lng -= 360;

      codes().update();

      expect(arm(markers[0]!).classList.contains("is-hidden")).toBe(false);
    });

    it("tells the map of the room the codes take, every dot's and each drawn code's", () => {
      markers.push(marker("EDDM Munich", 500, 400));
      markers[1]!.element.hidden = true;
      codes().update();

      const data = map.source(MAP_SOURCES.airportLabels).data as {
        features: {
          properties: Record<string, unknown>;
          geometry: { coordinates: number[] };
        }[];
      };
      expect(data.features).toHaveLength(1);
      const [feature] = data.features;
      expect(feature!.properties["name"]).toBe("EDDF Frankfurt");
      expect(feature!.properties["icao"]).toBe("EDDF");
      // Above the airport, in ems of the label's size at zoom 6 (11 px)
      const [x, y] = feature!.properties["o"] as [number, number];
      expect(x).toBeCloseTo(0);
      expect(y).toBeLessThan(0);
      expect(feature!.geometry.coordinates).toEqual([8.3, 50.7]);
    });

    it("tells the map nothing new when the codes have not moved", () => {
      const placer = codes();
      placer.update();
      const source = map.source(MAP_SOURCES.airportLabels);
      const written = source.setData;
      written.mockClear();
      placer.update();
      expect(written).not.toHaveBeenCalled();

      map.jumpTo({ zoom: 9 });
      placer.update();
      expect(written).toHaveBeenCalledTimes(1);
    });

    /** The room of the codes the map was last told of */
    function reserved(): Record<string, unknown>[] {
      const data = map.source(MAP_SOURCES.airportLabels).data as {
        features: { properties: Record<string, unknown> }[];
      };
      return data.features.map((feature) => feature.properties);
    }

    it("tells the map only of the dots it draws", () => {
      markers = [
        marker("EDDF Frankfurt", 300, 300),
        marker("EDDM Munich", 100, 100),
        marker("EDDK Cologne", 200, 400),
      ];
      // The relief hides one, a panel lies over another
      markers[1]!.element.classList.add("maplibregl-marker-covered");
      const panel = document.createElement("div");
      panel.id = "replay-controls";
      panel.getBoundingClientRect = () =>
        ({
          left: 150,
          top: 350,
          right: 250,
          bottom: 450,
          width: 100,
          height: 100,
        }) as DOMRect;
      document.body.append(panel);
      try {
        codes().update();
        expect(reserved().map((properties) => properties["name"])).toEqual([
          "EDDF Frankfurt",
        ]);
      } finally {
        panel.remove();
      }
    });

    it("tells the map the size of each code, the stylesheet's by zoom", () => {
      codes().update();
      expect(reserved()[0]!["s"]).toBe(11);

      map.jumpTo({ zoom: 9 });
      codes().update();
      expect(reserved()[0]!["s"]).toBe(12);

      map.jumpTo({ zoom: 13 });
      codes().update();
      expect(reserved()[0]!["s"]).toBe(13);
    });

    it("makes the room of a code on a tilted map as much larger as the map draws it smaller", () => {
      // Below the map's middle, nearer the camera: drawn larger by the map,
      // so its stand-in is made smaller, by MapLibre's perspective ratio;
      // the code is a pin there, drawn larger by as much (within bounds)
      map.jumpTo({ pitch: 60 });
      const placer = codes();
      placer.update();
      const s = reserved()[0]!["s"] as number;
      const scale = placer.placeOf("EDDF Frankfurt")!.scale;
      const { y } = map.project([8.3, 50.7]);
      const centre = map.project(map.getCenter());
      const focal = 600 / 2 / Math.tan(((36.87 / 2) * Math.PI) / 180);
      const ratio =
        1 + (0.5 * (y - centre.y) * Math.tan((60 * Math.PI) / 180)) / focal;

      expect(ratio).toBeGreaterThan(1);
      expect(scale).toBe(pinScale(ratio, 11, 0));
      expect(scale).toBeGreaterThan(1);
      expect(s).toBeCloseTo((11 * scale) / ratio);
    });

    it("draws codes as pins on a tilted map, the nearer larger, and flat at scale 1", () => {
      // The mock draws the map's middle at its top left: the lower, the nearer
      markers = [
        marker("EDDF Frankfurt", 400, 550),
        marker("EDDM Munich", 200, 60),
      ];
      const placer = codes();
      placer.update();
      expect(placer.placeOf("EDDF Frankfurt")!.scale).toBe(1);
      expect(arm(markers[0]!).style.getPropertyValue("--code-scale")).toBe("1");

      map.jumpTo({ pitch: 50 });
      placer.update();
      const near = placer.placeOf("EDDF Frankfurt")!;
      const far = placer.placeOf("EDDM Munich")!;
      expect(near.scale).toBeGreaterThan(1);
      expect(far.scale).toBeLessThan(near.scale);
      expect(near.angle).toBe(-90);
      // The chip and the stem at its scale
      expect(near.hh).toBeGreaterThan(far.hh);
      expect(arm(markers[0]!).style.getPropertyValue("--code-scale")).toBe(
        String(near.scale),
      );
    });

    it("draws an overview's codes flat, however it is tilted", () => {
      overview = true;
      map.jumpTo({ pitch: 50 });
      const placer = codes();
      placer.update();
      expect(placer.placeOf("EDDF Frankfurt")!.scale).toBe(1);
    });

    it("leaves out the code of a marker the relief covers, which takes no room", () => {
      markers = [marker("EDDK Cologne", 300, 278), markers[0]!];
      const placer = codes();
      placer.update();
      expect(placer.placeOf("EDDF Frankfurt")!.angle).not.toBe(-90);

      markers[0]!.element.classList.add("maplibregl-marker-covered");
      placer.update();
      expect(placer.placeOf("EDDK Cologne")).toBeNull();
      expect(arm(markers[0]!).classList.contains("is-hidden")).toBe(true);
      // Its dot gives no room either: the code below takes the room above
      expect(placer.placeOf("EDDF Frankfurt")!.angle).toBe(-90);
    });

    it("measures the full chip, also while it is drawn narrower", () => {
      const chip =
        markers[0]!.element.querySelector<HTMLElement>(".airport-code")!;
      chip.classList.add("is-narrow");
      // The face is measured, not the chip round it, which is at least a
      // finger's size
      Object.defineProperty(chip, "offsetWidth", { value: 30 });
      Object.defineProperty(chip, "offsetHeight", { value: 24 });
      const face = chip.querySelector<HTMLElement>(".airport-code-face")!;
      Object.defineProperty(face, "offsetWidth", { value: 30 });
      Object.defineProperty(face, "offsetHeight", { value: 16 });
      const placer = codes();
      placer.update();

      // The 4 pixels the narrower chip saves are the full chip's
      expect(placer.placeOf("EDDF Frankfurt")!.hw).toBe(17);
      expect(placer.placeOf("EDDF Frankfurt")!.hh).toBe(8);
    });

    it("shows a code it shows again where it goes at once, styled there before it may glide", () => {
      const placer = codes();
      map.jumpTo({ zoom: 3 });
      placer.update();
      expect(arm(markers[0]!).classList.contains("is-hidden")).toBe(true);

      const styled = vi.spyOn(window, "getComputedStyle");
      map.jumpTo({ zoom: 6 });
      placer.update();

      expect(styled).toHaveBeenCalledWith(arm(markers[0]!));
      expect(arm(markers[0]!).classList.contains("is-jump")).toBe(true);
      vi.advanceTimersToNextFrame();
      expect(arm(markers[0]!).classList.contains("is-jump")).toBe(false);
      styled.mockRestore();
    });

    it("places them again when a panel over the map comes, goes or changes its size", async () => {
      const panel = document.createElement("div");
      panel.id = "flight-profile";
      panel.hidden = true;
      try {
        const placer = codes();
        placer.update();
        expect(placer.placeOf("EDDF Frankfurt")!.angle).toBe(-90);

        // A panel made later is followed from when it is on the page
        document.body.append(panel);
        await Promise.resolve();

        // It shows, over the room above the dot
        panel.getBoundingClientRect = () =>
          ({
            left: 250,
            top: 250,
            right: 350,
            bottom: 295,
            width: 100,
            height: 45,
          }) as DOMRect;
        panel.hidden = false;
        await Promise.resolve();
        vi.advanceTimersToNextFrame();

        expect(placer.placeOf("EDDF Frankfurt")!.angle).not.toBe(-90);
      } finally {
        panel.remove();
      }
    });

    const dotButton = (at: CodeMarker): HTMLElement =>
      at.element.querySelector<HTMLElement>(".airport-marker-container")!;
    const chip = (at: CodeMarker): HTMLElement =>
      at.element.querySelector<HTMLElement>(".airport-code")!;

    it("takes a marker under a panel out of the targets until it is no longer under it", () => {
      const panel = document.createElement("div");
      panel.id = "replay-controls";
      panel.getBoundingClientRect = () =>
        ({
          left: 250,
          top: 250,
          right: 350,
          bottom: 350,
          width: 100,
          height: 100,
        }) as DOMRect;
      document.body.append(panel);
      try {
        const placer = codes();
        placer.update();
        expect(dotButton(markers[0]!).hasAttribute("inert")).toBe(true);
        expect(chip(markers[0]!).hasAttribute("inert")).toBe(true);
        expect(placer.placeOf("EDDF Frankfurt")).toBeNull();

        panel.hidden = true;
        placer.update();
        expect(dotButton(markers[0]!).hasAttribute("inert")).toBe(false);
      } finally {
        panel.remove();
      }
    });

    it("never touches the inert a dialog sets on a whole marker", () => {
      const panel = document.createElement("div");
      panel.id = "replay-controls";
      panel.getBoundingClientRect = () =>
        ({
          left: 250,
          top: 250,
          right: 350,
          bottom: 350,
          width: 100,
          height: 100,
        }) as DOMRect;
      document.body.append(panel);
      const { element } = markers[0]!;
      try {
        // Wrapped makes every marker inert while it is open
        element.setAttribute("inert", "");
        const placer = codes();
        placer.update();
        panel.hidden = true;
        placer.update();
        expect(element.hasAttribute("inert")).toBe(true);
        element.removeAttribute("inert");
        panel.hidden = false;
        placer.update();
        expect(element.hasAttribute("inert")).toBe(false);
      } finally {
        panel.remove();
      }
    });

    it("hands the target of an airport too close to a busier one's square to its code", () => {
      // 14 pixels apart: their 24 pixel squares would overlap
      markers = [
        marker("EDDF Frankfurt", 300, 300),
        marker("EDFE Egelsbach", 314, 300),
      ];
      codes().update();
      const [first, second] = markers as [CodeMarker, CodeMarker];

      // The first placed keeps its square round the dot
      expect(dotButton(first).hasAttribute("inert")).toBe(false);
      expect(chip(first).hasAttribute("role")).toBe(false);
      // The other's code is its target, its dot no target at all
      expect(dotButton(second).hasAttribute("inert")).toBe(true);
      expect(chip(second).getAttribute("role")).toBe("button");
      expect(chip(second).getAttribute("aria-label")).toBe("EDFE Egelsbach");
    });

    it("gives the dot back its target as soon as the code that was it goes in a move", () => {
      // A replay that follows the aircraft moves the map in every frame, so
      // the map never comes to rest
      markers = [
        marker("EDDF Frankfurt", 300, 300),
        marker("EDFE Egelsbach", 314, 300),
      ];
      codes().update();
      const second = markers[1]!;
      expect(dotButton(second).hasAttribute("inert")).toBe(true);

      // Below the zoom of the codes, the dots still drawn
      map.jumpTo({ zoom: 3 });
      map.emit("move");
      vi.advanceTimersToNextFrame();

      expect(arm(second).classList.contains("is-hidden")).toBe(true);
      expect(dotButton(second).hasAttribute("inert")).toBe(false);
    });

    it("gives an airport with no room for its code the largest square clear of the others", () => {
      markers = [
        marker("EDDF Frankfurt", 300, 300),
        marker("EDFE Egelsbach", 314, 300),
      ];
      // Codes are drawn from zoom 4, the markers from zoom 2
      map.jumpTo({ zoom: 3 });
      codes().update();
      const [first, second] = markers as [CodeMarker, CodeMarker];

      expect(first.element.style.getPropertyValue("--marker-target")).toBe("");
      // 14 pixels apart, 12 of them the first's: a square 4 pixels across
      expect(
        parseFloat(second.element.style.getPropertyValue("--marker-target")),
      ).toBeCloseTo(4, 0);
      expect(dotButton(second).hasAttribute("inert")).toBe(false);
    });

    it("leaves the marker that has the focus where the keyboard can reach it", () => {
      const panel = document.createElement("div");
      panel.id = "replay-controls";
      panel.getBoundingClientRect = () =>
        ({
          left: 250,
          top: 250,
          right: 350,
          bottom: 350,
          width: 100,
          height: 100,
        }) as DOMRect;
      document.body.append(panel);
      const { element } = markers[0]!;
      document.body.append(element);
      dotButton(markers[0]!).focus();
      try {
        codes().update();
        expect(dotButton(markers[0]!).hasAttribute("inert")).toBe(false);
        expect(document.activeElement).toBe(dotButton(markers[0]!));
      } finally {
        panel.remove();
        element.remove();
      }
    });

    it("leaves the codes out below the zoom of the labels, but not in an overview", () => {
      map.jumpTo({ zoom: 3 });
      codes().update();
      expect(arm(markers[0]!).classList.contains("is-hidden")).toBe(true);

      overview = true;
      codes().update();
      expect(arm(markers[0]!).classList.contains("is-hidden")).toBe(false);
    });

    it("leaves out the code of a hidden marker, one off the map, and one with the airports off", () => {
      markers.push(marker("EDDM Munich", 900, 300));
      markers.push(marker("EDDK Cologne", 100, 100));
      markers[2]!.element.hidden = true;
      const placer = codes();
      placer.update();

      expect(arm(markers[1]!).classList.contains("is-hidden")).toBe(true);
      expect(arm(markers[2]!).classList.contains("is-hidden")).toBe(true);
      expect(arm(markers[0]!).classList.contains("is-hidden")).toBe(false);

      map.getContainer().classList.add("airports-hidden");
      placer.update();
      expect(arm(markers[0]!).classList.contains("is-hidden")).toBe(true);
      expect(placer.placeOf("EDDF Frankfurt")).toBeNull();
    });

    it("keeps a code where it is while the map moves, and at rest takes the best place", () => {
      const placer = codes();
      markers = [marker("EDDK Cologne", 300, 278), markers[0]!];
      placer.update();
      const aside = placer.placeOf("EDDF Frankfurt")!;
      expect(aside.angle).not.toBe(-90);

      // Cologne goes (hidden by a filter), the map moves
      markers[0]!.element.hidden = true;
      map.emit("move");
      vi.advanceTimersToNextFrame();
      expect(placer.placeOf("EDDF Frankfurt")).toEqual(aside);

      map.emit("moveend");
      vi.advanceTimersByTime(150);
      vi.advanceTimersToNextFrame();
      expect(placer.placeOf("EDDF Frankfurt")!.angle).toBe(-90);
    });

    it("places them again once the map has a new size", () => {
      const placer = codes();
      placer.update();
      markers = [marker("EDDK Cologne", 300, 278), markers[0]!];

      map.emit("resize");
      vi.advanceTimersToNextFrame();

      expect(placer.placeOf("EDDF Frankfurt")!.angle).not.toBe(-90);
    });

    it("keeps clear of the panels over the map, but for an overview", () => {
      const panel = document.createElement("div");
      panel.id = "left-buttons";
      document.body.append(panel);
      // Over the room above the dot
      panel.getBoundingClientRect = () =>
        ({
          left: 250,
          top: 250,
          right: 350,
          bottom: 295,
          width: 100,
          height: 45,
        }) as DOMRect;
      try {
        const placer = codes();
        placer.update();
        expect(placer.placeOf("EDDF Frankfurt")!.angle).not.toBe(-90);

        overview = true;
        placer.update();
        expect(placer.placeOf("EDDF Frankfurt")!.angle).toBe(-90);
      } finally {
        panel.remove();
      }
    });

    it("stops following the map once its signal ends", () => {
      const placer = codes();
      placer.update();
      markers = [marker("EDDK Cologne", 300, 278), markers[0]!];
      stop.abort();

      map.emit("resize");
      vi.advanceTimersToNextFrame();

      expect(placer.placeOf("EDDF Frankfurt")!.angle).toBe(-90);
    });

    it("says APT for an airport without a code of its own", () => {
      expect(NO_CODE_LABEL).toBe("APT");
    });
  });
});
