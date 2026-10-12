import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Map as MapLibreMap, Popup as MapLibrePopup } from "maplibre-gl";
import {
  cameraDistanceRatio,
  closeWhenBehindGlobe,
  createActivationFilter,
  cssVar,
  DOUBLE_TAP_MS,
  FIELDS,
  firstSymbolLayerId,
  fromLngLat,
  isBehindGlobe,
  isMapStill,
  isOnMarker,
  isPageEscape,
  keepMarkerTapsFromZoom,
  MAP_STILL_TIMEOUT_MS,
  mapSize,
  mapZoomToState,
  onMapReady,
  panPopupIntoView,
  slideMapBesideRail,
  stateZoomToMap,
  toBounds,
  toLngLat,
  toLngLatAfter,
  unwrapLng,
  whenContextRestored,
  whenMapComplete,
  whenStyleReady,
  withMapStill,
  withoutValidation,
} from "../../../../flown/frontend/utils/mapHelpers";
import {
  Map as MockMap,
  Popup as MockPopup,
  mockControl,
  resetMapLibreMock,
} from "../../../mocks/maplibre-gl";
import { measureSafeArea, setDevicePixelRatio } from "../../testHelpers";
import { resetSafeArea } from "../../../../flown/frontend/utils/safeArea";
import { logError } from "../../../../flown/frontend/utils/logger";

vi.mock("../../../../flown/frontend/utils/logger", () => ({
  logDebug: vi.fn(),
  logError: vi.fn(),
}));

/** A mock map, typed the way the helpers take it */
function mapStub(options: Record<string, unknown> = {}): MapLibreMap & MockMap {
  const container = document.createElement("div");
  document.body.append(container);
  return new MockMap({
    container,
    style: "style.json",
    ...options,
  }) as MapLibreMap & MockMap;
}

function rect(
  left: number,
  top: number,
  right: number,
  bottom: number,
): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

describe("mapSize", () => {
  it("measures the container once, and again after the map resized", () => {
    const map = mapStub();
    let width = 800;
    const reads = vi.fn();
    Object.defineProperty(map.getContainer(), "clientWidth", {
      get: () => {
        reads();
        return width;
      },
    });
    Object.defineProperty(map.getContainer(), "clientHeight", {
      value: 600,
    });

    expect(mapSize(map)).toEqual({ width: 800, height: 600 });
    mapSize(map);
    mapSize(map);
    // Asked in every frame of the replay's camera, it lays nothing out
    expect(reads).toHaveBeenCalledTimes(1);

    width = 400;
    expect(mapSize(map).width).toBe(800);
    map.emit("resize");
    expect(mapSize(map)).toEqual({ width: 400, height: 600 });
    expect(reads).toHaveBeenCalledTimes(2);
    // One listener per map, however often it resizes
    map.emit("resize");
    mapSize(map);
    expect(map.listenerCount("resize")).toBe(1);
  });
});

describe("mapHelpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetMapLibreMock();
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("style");
  });

  describe("coordinates", () => {
    it("swaps latitude-first data into MapLibre's order and back", () => {
      expect(toLngLat([50.1, 8.6])).toEqual([8.6, 50.1]);
      expect(fromLngLat({ lng: 8.6, lat: 50.1 })).toEqual([50.1, 8.6]);
    });

    it("drops an altitude behind the pair", () => {
      expect(toLngLat([50.1, 8.6, 1200])).toEqual([8.6, 50.1]);
    });

    it("takes a longitude to the copy of the world nearest another", () => {
      expect(unwrapLng(-179.9, 179.9)).toBeCloseTo(180.1, 9);
      expect(unwrapLng(179.9, -179.9)).toBeCloseTo(-180.1, 9);
      expect(unwrapLng(8.6, 8.5)).toBe(8.6);
      expect(unwrapLng(8.6, 368.5)).toBe(368.6);
    });

    it("carries a line on across the antimeridian instead of round the world", () => {
      const first = toLngLatAfter([60, 179.9], undefined);
      const second = toLngLatAfter([60.1, -179.9], first);
      expect(first).toEqual([179.9, 60]);
      expect(second[0]).toBeCloseTo(180.1, 9);
      expect(second[1]).toBe(60.1);
      expect(toLngLatAfter([60.2, -179.8], second)[0]).toBeCloseTo(180.2, 9);
    });

    it("turns the configured bounds into south-west and north-east", () => {
      expect(
        toBounds([
          [49, 7],
          [51, 9],
        ]),
      ).toEqual([
        [7, 49],
        [9, 51],
      ]);
    });
  });

  describe("zoom units", () => {
    it("keeps saved state one level above the map", () => {
      expect(stateZoomToMap(10)).toBe(9);
      expect(mapZoomToState(9)).toBe(10);
      expect(mapZoomToState(stateZoomToMap(12.25))).toBe(12.25);
    });
  });

  describe("whenStyleReady", () => {
    it("resolves with the map on style.load", async () => {
      mockControl.autoLoadStyle = false;
      const map = mapStub();
      const ready = vi.fn();
      void whenStyleReady(map).then(ready);

      await Promise.resolve();
      expect(ready).not.toHaveBeenCalled();

      map.finishStyleLoad();
      await Promise.resolve();
      expect(ready).toHaveBeenCalledWith(map);
    });
  });

  describe("onMapReady", () => {
    it("runs with the map once it is ready, unless the app is gone by then", async () => {
      const map = mapStub();
      const lifetime = new AbortController();
      const ready = vi.fn();
      const app = { mapReady: Promise.resolve(map), signal: lifetime.signal };
      onMapReady(app, "Test", ready);
      await Promise.resolve();
      expect(ready).toHaveBeenCalledWith(map);

      lifetime.abort();
      const late = vi.fn();
      onMapReady(app, "Test", late);
      await Promise.resolve();
      expect(late).not.toHaveBeenCalled();
    });

    it("logs what it throws, and leaves a map that never got ready alone", async () => {
      const failure = new Error("no source");
      onMapReady({ mapReady: Promise.resolve(mapStub()) }, "Test", () => {
        throw failure;
      });
      const never = vi.fn();
      onMapReady(
        { mapReady: Promise.reject(new Error("gone")) },
        "Test",
        never,
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(logError).toHaveBeenCalledWith(
        "Test: the map got ready, but not for them",
        failure,
      );
      expect(never).not.toHaveBeenCalled();
    });
  });

  describe("whenContextRestored", () => {
    it("calls back once the style is back after a lost context, until the signal aborts", () => {
      const map = mapStub();
      const lifetime = new AbortController();
      const restored = vi.fn();
      whenContextRestored(map, restored, lifetime.signal);

      map.emit("webglcontextrestored");
      expect(restored).not.toHaveBeenCalled();
      map.emit("style.load");
      expect(restored).toHaveBeenCalledTimes(1);

      // A style on its way as the app goes is not followed either
      map.emit("webglcontextrestored");
      lifetime.abort();
      map.emit("style.load");
      map.emit("webglcontextrestored");
      map.emit("style.load");
      expect(restored).toHaveBeenCalledTimes(1);
      expect(map.listenerCount("webglcontextrestored")).toBe(0);
    });
  });

  describe("whenMapComplete", () => {
    it("does not take the old view's tiles for the new one's right after a jump", async () => {
      // The sources are only marked to be updated: the tiles held are the
      // old view's, all loaded, and `loaded` is false until the next frame
      const map = mapStub();
      vi.spyOn(map, "areTilesLoaded").mockReturnValue(true);
      vi.spyOn(map, "loaded").mockReturnValue(false);
      const complete = vi.fn();
      void whenMapComplete(map, () => true).then(complete);
      await Promise.resolve();
      expect(complete).not.toHaveBeenCalled();

      // In a frame the tiles are the new view's; `loaded` waiting on the
      // labels as well does not hold it up
      map.emit("render");
      await Promise.resolve();
      expect(complete).toHaveBeenCalledTimes(1);
    });

    it("resolves at the frame that completes the map, or at once on abort", async () => {
      const map = mapStub();
      vi.spyOn(map, "areTilesLoaded").mockReturnValue(false);
      const renders = map.listenerCount("render");
      const complete = vi.fn();
      void whenMapComplete(map, () => true).then(complete);
      map.emit("render");
      await Promise.resolve();
      expect(complete).not.toHaveBeenCalled();

      vi.mocked(map.areTilesLoaded).mockReturnValue(true);
      map.emit("render");
      await Promise.resolve();
      expect(complete).toHaveBeenCalledTimes(1);
      expect(map.listenerCount("render")).toBe(renders);

      // A caller that no longer waits takes its listener off with it
      vi.mocked(map.areTilesLoaded).mockReturnValue(false);
      const waiting = new AbortController();
      const given = vi.fn();
      void whenMapComplete(map, () => true, [], 5000, waiting.signal).then(
        given,
      );
      expect(map.listenerCount("render")).toBe(renders + 1);
      waiting.abort();
      await Promise.resolve();
      expect(given).toHaveBeenCalledTimes(1);
      expect(map.listenerCount("render")).toBe(renders);
    });
  });

  describe("firstSymbolLayerId", () => {
    it("names the lowest label layer", async () => {
      const map = mapStub({
        style: {
          version: 8,
          sources: {},
          layers: [
            { id: "land", type: "background" },
            { id: "roads", type: "line" },
            { id: "road-names", type: "symbol" },
            { id: "places", type: "symbol" },
          ],
        },
      });
      await whenStyleReady(map);

      expect(firstSymbolLayerId(map)).toBe("road-names");
    });

    it("is undefined for a style without labels", async () => {
      const map = mapStub({
        style: {
          version: 8,
          sources: {},
          layers: [{ id: "land", type: "background" }],
        },
      });
      await whenStyleReady(map);

      expect(firstSymbolLayerId(map)).toBeUndefined();
    });
  });

  describe("panPopupIntoView", () => {
    function openPopup(
      map: MapLibreMap & MockMap,
      box: DOMRect,
    ): MapLibrePopup {
      vi.spyOn(map.getContainer(), "getBoundingClientRect").mockReturnValue(
        rect(0, 0, 800, 600),
      );
      const popup = new MockPopup().setLngLat([8, 50]).addTo(map);
      vi.spyOn(popup.getElement(), "getBoundingClientRect").mockReturnValue(
        box,
      );
      return popup as unknown as MapLibrePopup;
    }

    it("leaves a popup that is inside the padding alone", () => {
      const map = mapStub();
      panPopupIntoView(map, openPopup(map, rect(100, 100, 300, 300)), 16);

      expect(map.panBy).not.toHaveBeenCalled();
    });

    it("pans by what sticks out at the top left, plus the padding", () => {
      const map = mapStub();
      panPopupIntoView(map, openPopup(map, rect(-20, 6, 180, 200)), 16);

      expect(map.panBy).toHaveBeenCalledWith([-36, -10], { animate: true });
    });

    it("pans by what sticks out at the bottom right", () => {
      const map = mapStub();
      panPopupIntoView(
        map,
        openPopup(map, rect(600, 400, 820, 590)),
        16,
        false,
      );

      expect(map.panBy).toHaveBeenCalledWith([36, 6], { animate: false });
    });

    it("shows the start of a popup larger than the map", () => {
      const map = mapStub();
      panPopupIntoView(map, openPopup(map, rect(-50, 100, 900, 300)), 16);

      expect(map.panBy).toHaveBeenCalledWith([-66, 0], { animate: true });
    });

    it("does nothing for a closed popup", () => {
      const map = mapStub();
      const popup = openPopup(map, rect(-50, 100, 900, 300));
      popup.remove();

      panPopupIntoView(map, popup, 16);

      expect(map.panBy).not.toHaveBeenCalled();
    });

    it("keeps a popup clear of the status bar and the home indicator where the map fills the screen", () => {
      // Measured afresh, not the zeros of the tests before
      resetSafeArea();
      // The insets of an iPhone's home screen app, held upright
      measureSafeArea({ top: 59, bottom: 34 });
      vi.spyOn(window, "innerHeight", "get").mockReturnValue(600);
      try {
        const map = mapStub();
        // 40 px from the top is under the island: down to 59 + 16
        panPopupIntoView(map, openPopup(map, rect(100, 40, 300, 200)), 16);
        expect(map.panBy).toHaveBeenLastCalledWith([0, -35], {
          animate: true,
        });
        // Up from the home indicator: 600 - 34 - 16
        panPopupIntoView(map, openPopup(map, rect(100, 400, 300, 560)), 16);
        expect(map.panBy).toHaveBeenLastCalledWith([0, 10], { animate: true });
      } finally {
        vi.restoreAllMocks();
        resetSafeArea();
      }
    });

    it("still pans a turned map by pixels, which is exact while it is flat", () => {
      const map = mapStub({ bearing: 120 });
      panPopupIntoView(map, openPopup(map, rect(-20, 6, 180, 200)), 16);

      expect(map.panBy).toHaveBeenCalledWith([-36, -10], { animate: true });
      expect(map.panTo).not.toHaveBeenCalled();
    });

    it("moves the popup's place, not the centre, by what sticks out on a tilted map", () => {
      // In the browser a panBy of 200 px brought a popup at the top of a map
      // tilted by 60 degrees down by 44
      const map = mapStub({ center: [8, 50], bearing: 30, pitch: 60 });
      panPopupIntoView(map, openPopup(map, rect(-20, 6, 180, 200)), 16, false);

      expect(map.panBy).not.toHaveBeenCalled();
      expect(map.panTo).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
        animate: false,
      });
      // The popup sits on [8, 50], which was in the middle of the map
      const place = map.project([8, 50]);
      expect(place.x).toBeCloseTo(36, 6);
      expect(place.y).toBeCloseTo(10, 6);
    });

    it("does the same on a globe", () => {
      const map = mapStub({ center: [8, 50] });
      map.finishStyleLoad();
      map.setProjection({ type: "globe" });
      panPopupIntoView(map, openPopup(map, rect(600, 400, 820, 590)), 16);

      expect(map.panBy).not.toHaveBeenCalled();
      const place = map.project([8, 50]);
      expect(place.x).toBeCloseTo(-36, 3);
      expect(place.y).toBeCloseTo(-6, 3);
    });
  });

  describe("cameraDistanceRatio", () => {
    /** A map 800 px tall, tilted by `pitch` */
    function tilted(pitch: number): MapLibreMap & MockMap {
      const map = mapStub({ center: [10, 50] });
      Object.defineProperty(map.getContainer(), "clientHeight", {
        value: 800,
      });
      map.jumpTo({ pitch });
      return map;
    }

    it("is 1 on a flat map and in the middle of a tilted one", () => {
      expect(cameraDistanceRatio(tilted(0), { lng: 10, lat: 50.3 })).toBe(1);
      expect(cameraDistanceRatio(tilted(60), { lng: 10, lat: 50 })).toBeCloseTo(
        1,
        9,
      );
    });

    it("grows towards the top of a tilted map, and is Infinity past its horizon", () => {
      const map = tilted(60);
      const near = cameraDistanceRatio(map, { lng: 10, lat: 49.9 });
      const far = cameraDistanceRatio(map, { lng: 10, lat: 50.2 });

      expect(near).toBeLessThan(1);
      expect(far).toBeGreaterThan(1);
      // The ray to a place drawn y pixels over the middle leaves the camera
      // atan(y / focal) above the middle's, which meets the ground at 60°
      const focal = 400 / Math.tan((36.87 * Math.PI) / 360);
      const y = -map.project([10, 50.2]).y;
      const angle = Math.PI / 3 + Math.atan(y / focal);
      expect(far).toBeCloseTo(Math.cos(Math.PI / 3) / Math.cos(angle), 6);
      expect(cameraDistanceRatio(map, { lng: 10, lat: 60 })).toBe(Infinity);
    });
  });

  describe("isBehindGlobe", () => {
    function globe(): MapLibreMap & MockMap {
      const map = mapStub({ center: [10, 50] });
      map.finishStyleLoad();
      map.setProjection({ type: "globe" });
      return map;
    }

    it("is never true on a flat map, however far away the place is", () => {
      const map = mapStub({ center: [10, 50] });

      expect(isBehindGlobe(map, { lng: -170, lat: -50 })).toBe(false);
      // No projection means Mercator, and costs no look at the map
      expect(map.project).not.toHaveBeenCalled();
    });

    it("tells the near side of a globe from the far side", () => {
      const map = globe();

      expect(isBehindGlobe(map, { lng: 10, lat: 50 })).toBe(false);
      expect(isBehindGlobe(map, { lng: 95, lat: 20 })).toBe(false);
      expect(isBehindGlobe(map, { lng: -75, lat: 20 })).toBe(false);
      expect(isBehindGlobe(map, { lng: 105, lat: 20 })).toBe(true);
      expect(isBehindGlobe(map, { lng: -170, lat: 50 })).toBe(true);
    });

    it("follows the globe as it turns", () => {
      const map = globe();
      expect(isBehindGlobe(map, { lng: -170, lat: 50 })).toBe(true);

      map.jumpTo({ center: [-150, 50] });

      expect(isBehindGlobe(map, { lng: -170, lat: 50 })).toBe(false);
      expect(isBehindGlobe(map, { lng: 10, lat: 50 })).toBe(true);
    });

    it("takes a place across the antimeridian for the near one it is", () => {
      const map = globe();
      map.jumpTo({ center: [175, 0] });

      expect(isBehindGlobe(map, { lng: -175, lat: 0 })).toBe(false);
    });
  });

  describe("closeWhenBehindGlobe", () => {
    function globeWithPopup(): {
      map: MapLibreMap & MockMap;
      popup: MockPopup;
    } {
      const map = mapStub({ center: [10, 50] });
      map.finishStyleLoad();
      map.setProjection({ type: "globe" });
      const popup = new MockPopup();
      closeWhenBehindGlobe(map, popup as unknown as MapLibrePopup);
      popup.setLngLat([10, 50]).addTo(map);
      return { map, popup };
    }

    it("leaves the popup open while its place is on the near side", () => {
      const { map, popup } = globeWithPopup();

      map.jumpTo({ center: [60, 40] });
      map.emit("move");

      expect(popup.isOpen()).toBe(true);
    });

    it("closes the popup once the globe has turned its place away", () => {
      const { map, popup } = globeWithPopup();

      map.jumpTo({ center: [-160, 40] });
      map.emit("move");

      expect(popup.isOpen()).toBe(false);
    });

    it("listens to the map only while the popup is open", () => {
      const { map, popup } = globeWithPopup();
      expect(map.listenerCount("move")).toBe(1);

      popup.remove();
      expect(map.listenerCount("move")).toBe(0);

      popup.addTo(map);
      expect(map.listenerCount("move")).toBe(1);
    });
  });

  describe("isOnMarker", () => {
    it("tells an event aimed at a marker, or inside one, from the rest", () => {
      const container = document.createElement("div");
      const canvas = document.createElement("canvas");
      const marker = document.createElement("button");
      marker.className = "maplibregl-marker airport-marker";
      const label = document.createElement("span");
      marker.append(label);
      container.append(canvas, marker);
      const aimedAt = (target: Element): { originalEvent: Event } => {
        const originalEvent = new Event("click", { bubbles: true });
        target.dispatchEvent(originalEvent);
        return { originalEvent };
      };

      expect(isOnMarker(aimedAt(marker))).toBe(true);
      expect(isOnMarker(aimedAt(label))).toBe(true);
      expect(isOnMarker(aimedAt(canvas))).toBe(false);
      // An event the app made up carries none
      expect(isOnMarker({})).toBe(false);
    });
  });

  describe("isPageEscape", () => {
    it("leaves an Escape to a popup, a marker, what else it is told of, and whoever took it", () => {
      document.body.innerHTML =
        '<div class="maplibregl-popup"><button id="in-popup"></button></div>' +
        '<div class="maplibregl-marker" id="marker"></div>' +
        '<div class="maplibregl-marker end" id="end"></div>' +
        '<select id="speed"></select><button id="plain"></button>';
      const escape = (id: string, key = "Escape"): KeyboardEvent => {
        let seen!: KeyboardEvent;
        const target = document.getElementById(id)!;
        target.addEventListener("keydown", (e) => (seen = e), { once: true });
        target.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            bubbles: true,
            cancelable: true,
          }),
        );
        return seen;
      };

      expect(isPageEscape(escape("plain"))).toBe(true);
      expect(isPageEscape(escape("plain", "Enter"))).toBe(false);
      expect(isPageEscape(escape("in-popup"))).toBe(false);
      expect(isPageEscape(escape("marker"))).toBe(false);
      expect(isPageEscape(escape("speed"))).toBe(true);
      expect(isPageEscape(escape("speed"), ",#speed")).toBe(false);
      // Markers whose Escape it is
      expect(isPageEscape(escape("end"), ":not(.end)")).toBe(true);
      expect(isPageEscape(escape("marker"), ":not(.end)")).toBe(false);
      const taken = escape("plain");
      taken.preventDefault();
      expect(isPageEscape(taken)).toBe(false);
      document.body.innerHTML = "";
    });

    it("leaves an Escape in a text field or a select to the field with FIELDS", () => {
      document.body.innerHTML =
        '<input type="search" id="search"><input type="text" id="text">' +
        '<textarea id="area"></textarea><select id="speed"></select>' +
        '<div contenteditable="true" id="edit"></div>' +
        '<input type="range" id="slider"><input type="checkbox" id="box">';
      const escape = (id: string): KeyboardEvent => {
        const event = new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        });
        document.getElementById(id)!.dispatchEvent(event);
        return event;
      };

      for (const id of ["search", "text", "area", "speed", "edit"]) {
        expect(isPageEscape(escape(id))).toBe(true);
        expect(isPageEscape(escape(id), FIELDS)).toBe(false);
      }
      expect(isPageEscape(escape("slider"), FIELDS)).toBe(true);
      expect(isPageEscape(escape("box"), FIELDS)).toBe(true);
      document.body.innerHTML = "";
    });
  });

  describe("createActivationFilter", () => {
    /** A click as the browser reports it, at a time in milliseconds */
    function click(detail: number, timeStamp: number): MouseEvent {
      return { detail, timeStamp } as MouseEvent;
    }

    it("takes clicks further apart than a double tap", () => {
      const isActivation = createActivationFilter();
      expect(isActivation(click(1, 1000))).toBe(true);
      expect(isActivation(click(1, 1000 + DOUBLE_TAP_MS))).toBe(true);
    });

    it("drops the later clicks of a burst the browser counts", () => {
      const isActivation = createActivationFilter();
      expect(isActivation(click(1, 1000))).toBe(true);
      expect(isActivation(click(2, 1000 + DOUBLE_TAP_MS))).toBe(false);
    });

    it("drops a second tap that WebKit reports as a single click", () => {
      const isActivation = createActivationFilter();
      expect(isActivation(click(1, 1000))).toBe(true);
      expect(isActivation(click(1, 1100))).toBe(false);
      // Each tap of the burst moves its end
      expect(isActivation(click(1, 1100 + DOUBLE_TAP_MS - 1))).toBe(false);
    });

    it("always takes a key, which reports no clicks", () => {
      const isActivation = createActivationFilter();
      expect(isActivation(click(1, 1000))).toBe(true);
      expect(isActivation(click(0, 1001))).toBe(true);
      expect(isActivation(click(0, 1002))).toBe(true);
    });
  });

  describe("keepMarkerTapsFromZoom", () => {
    function mapWithMarker(): {
      map: MapLibreMap & MockMap;
      onMarker: (
        type: string,
        fingersLeft?: number,
      ) => { originalEvent: Event };
      onCanvas: (
        type: string,
        fingersLeft?: number,
      ) => { originalEvent: Event };
    } {
      const map = mapStub();
      const marker = document.createElement("button");
      marker.className = "maplibregl-marker";
      map.getCanvasContainer().append(marker);
      const aimedAt =
        (target: Element) =>
        (type: string, fingersLeft = 0): { originalEvent: Event } => {
          const originalEvent = Object.assign(
            new Event(type, { bubbles: true }),
            { touches: new Array<object>(fingersLeft).fill({}) },
          );
          target.dispatchEvent(originalEvent);
          return { originalEvent };
        };
      return {
        map,
        onMarker: aimedAt(marker),
        onCanvas: aimedAt(map.getCanvas()),
      };
    }

    it("prevents the zoom of a double click on a marker only", () => {
      const { map, onMarker, onCanvas } = mapWithMarker();
      keepMarkerTapsFromZoom(map);
      const preventDefault = vi.fn();

      map.emit("dblclick", { ...onCanvas("dblclick"), preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();

      map.emit("dblclick", { ...onMarker("dblclick"), preventDefault });
      expect(preventDefault).toHaveBeenCalledTimes(1);
    });

    it("switches the tap zoom off for the length of a touch on a marker", () => {
      const { map, onMarker, onCanvas } = mapWithMarker();
      keepMarkerTapsFromZoom(map);

      map.emit("touchstart", onCanvas("touchstart"));
      expect(map.doubleClickZoom.isEnabled()).toBe(true);
      map.emit("touchend", onCanvas("touchend"));
      expect(map.doubleClickZoom.enable).not.toHaveBeenCalled();

      map.emit("touchstart", onMarker("touchstart"));
      expect(map.doubleClickZoom.isEnabled()).toBe(false);
      // The pan is not touched: a drag that starts on a marker moves the map
      expect(map.dragPan.disable).not.toHaveBeenCalled();

      // A second finger that lifts leaves the one on the marker down, and
      // the recogniser stays out of the rest of the gesture
      map.emit("touchend", onCanvas("touchend", 1));
      expect(map.doubleClickZoom.isEnabled()).toBe(false);

      map.emit("touchend", onMarker("touchend"));
      expect(map.doubleClickZoom.isEnabled()).toBe(true);
    });

    it("keeps the second tap of a double tap off the map from zooming", () => {
      const { map, onMarker, onCanvas } = mapWithMarker();
      keepMarkerTapsFromZoom(map);
      const at = (timeStamp: number) => (event: { originalEvent: Event }) => {
        Object.defineProperty(event.originalEvent, "timeStamp", {
          value: timeStamp,
        });
        return event;
      };
      map.emit("touchstart", at(1000)(onMarker("touchstart")));
      map.emit("touchend", at(1050)(onMarker("touchend")));
      expect(map.doubleClickZoom.isEnabled()).toBe(true);

      // The popup's pan carried the marker off: the second tap is beside it
      map.emit(
        "touchstart",
        at(1000 + DOUBLE_TAP_MS - 1)(onCanvas("touchstart")),
      );
      expect(map.doubleClickZoom.isEnabled()).toBe(false);
      // Its dblclick, which a busy page hands over seconds later
      const preventDefault = vi.fn();
      map.emit("dblclick", {
        ...at(9000)(onCanvas("dblclick")),
        preventDefault,
      });
      expect(preventDefault).toHaveBeenCalledOnce();
      map.emit("touchend", at(1000 + DOUBLE_TAP_MS)(onCanvas("touchend")));
      expect(map.doubleClickZoom.isEnabled()).toBe(true);

      // A tap of its own zooms as ever, and so does its dblclick
      map.emit("touchstart", at(1000 + DOUBLE_TAP_MS)(onCanvas("touchstart")));
      expect(map.doubleClickZoom.isEnabled()).toBe(true);
      map.emit("dblclick", {
        ...at(9500)(onCanvas("dblclick")),
        preventDefault,
      });
      expect(preventDefault).toHaveBeenCalledOnce();
    });

    /** A press of `pointerType` on `target`, and the mousedown it hands on */
    function press(
      map: MapLibreMap & MockMap,
      target: Element,
      pointerType: string,
      detail: number,
    ): void {
      target.dispatchEvent(
        Object.assign(new Event("pointerdown", { bubbles: true }), {
          pointerType,
        }),
      );
      const originalEvent = Object.assign(
        new Event("mousedown", { bubbles: true }),
        { detail },
      );
      target.dispatchEvent(originalEvent);
      map.emit("mousedown", { originalEvent });
    }

    it("keeps the second click of a mouse's double click off the map from zooming", () => {
      const { map, onCanvas } = mapWithMarker();
      keepMarkerTapsFromZoom(map);
      const marker = map.getCanvasContainer().querySelector("button")!;
      const preventDefault = vi.fn();

      // The popup of the first click panned the marker from under the second
      press(map, marker, "mouse", 1);
      press(map, map.getCanvas(), "mouse", 2);
      map.emit("dblclick", { ...onCanvas("dblclick"), preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();

      // A double click of its own on the map zooms
      press(map, map.getCanvas(), "mouse", 1);
      press(map, map.getCanvas(), "mouse", 2);
      map.emit("dblclick", { ...onCanvas("dblclick"), preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    });

    it("lets a mouse's double click zoom after a touch on a marker", () => {
      const { map, onMarker, onCanvas } = mapWithMarker();
      keepMarkerTapsFromZoom(map);
      map.emit("touchstart", onMarker("touchstart"));
      map.emit("touchend", onMarker("touchend"));
      const preventDefault = vi.fn();

      press(map, map.getCanvas(), "mouse", 1);
      press(map, map.getCanvas(), "mouse", 2);
      map.emit("dblclick", { ...onCanvas("dblclick"), preventDefault });

      expect(preventDefault).not.toHaveBeenCalled();
    });

    it("goes by a pen's press as by a mouse's", () => {
      const { map, onCanvas } = mapWithMarker();
      keepMarkerTapsFromZoom(map);
      const marker = map.getCanvasContainer().querySelector("button")!;
      const preventDefault = vi.fn();
      // A mouse's click on a marker, then a pen's double click on the map
      press(map, marker, "mouse", 1);
      press(map, map.getCanvas(), "pen", 1);
      press(map, map.getCanvas(), "pen", 2);
      map.emit("dblclick", { ...onCanvas("dblclick"), preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();

      // And a pen's double click whose popup panned the marker away
      press(map, marker, "pen", 1);
      press(map, map.getCanvas(), "pen", 2);
      map.emit("dblclick", { ...onCanvas("dblclick"), preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
    });

    it("goes by the touch, not the mousedown a tap hands over after it", () => {
      const { map, onMarker, onCanvas } = mapWithMarker();
      keepMarkerTapsFromZoom(map);
      const marker = map.getCanvasContainer().querySelector("button")!;
      map.emit("touchstart", onMarker("touchstart"));
      map.emit("touchend", onMarker("touchend"));
      press(map, marker, "touch", 1);
      // The second tap, off the marker, with the detail WebKit gives a tap
      map.emit("touchstart", onCanvas("touchstart"));
      map.emit("touchend", onCanvas("touchend"));
      press(map, map.getCanvas(), "touch", 1);
      const preventDefault = vi.fn();

      map.emit("dblclick", { ...onCanvas("dblclick"), preventDefault });

      expect(preventDefault).toHaveBeenCalledOnce();
    });

    it("leaves a zoom that was switched off by someone else off", () => {
      const { map, onMarker } = mapWithMarker();
      map.doubleClickZoom.disable();
      keepMarkerTapsFromZoom(map);

      map.emit("touchstart", onMarker("touchstart"));
      map.emit("touchcancel", onMarker("touchcancel"));

      expect(map.doubleClickZoom.isEnabled()).toBe(false);
    });

    it("takes everything back, a zoom it had switched off included", () => {
      const { map, onMarker } = mapWithMarker();
      const release = keepMarkerTapsFromZoom(map);
      map.emit("touchstart", onMarker("touchstart"));

      release();

      expect(map.doubleClickZoom.isEnabled()).toBe(true);
      for (const type of [
        "mousedown",
        "dblclick",
        "touchstart",
        "touchend",
        "touchcancel",
      ]) {
        expect(map.listenerCount(type)).toBe(0);
      }
    });
  });

  describe("withMapStill", () => {
    beforeEach(() => {
      vi.useRealTimers();
      // jsdom does not implement it
      HTMLImageElement.prototype.decode = vi.fn(() => Promise.resolve());
    });

    afterEach(() => {
      // The workers share one jsdom, so the prototype is put back
      delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
    });

    function stillMap(): MapLibreMap & MockMap {
      const map = mapStub();
      vi.spyOn(map.getCanvas(), "toDataURL").mockReturnValue(
        "data:image/png;base64,AAAA",
      );
      return map;
    }

    it("shows a still of the rendered frame while the callback runs", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      const parent = canvas.parentElement!;

      const result = await withMapStill(map, () => {
        const still = parent.querySelector("img")!;
        expect(parent.contains(canvas)).toBe(false);
        expect(still.src).toBe("data:image/png;base64,AAAA");
        expect(still.className).toBe(canvas.className);
        return "done";
      });

      expect(result).toBe("done");
      expect(map.triggerRepaint).toHaveBeenCalledOnce();
      expect(canvas.toDataURL).toHaveBeenCalledWith("image/png");
      expect(parent.contains(canvas)).toBe(true);
      expect(parent.querySelector("img")).toBeNull();
    });

    it("tells what moves on the map by itself to hold still, from the frame it takes until the canvas is back", async () => {
      const map = stillMap();
      const repaint = map.triggerRepaint.getMockImplementation();
      const inFrame: boolean[] = [];
      map.triggerRepaint.mockImplementation(() => {
        inFrame.push(isMapStill(map));
        repaint?.();
      });
      expect(isMapStill(map)).toBe(false);

      await withMapStill(map, () => {
        expect(isMapStill(map)).toBe(true);
        // Another map is not held
        expect(isMapStill(mapStub())).toBe(false);
      });

      expect(inFrame).toEqual([true]);
      expect(isMapStill(map)).toBe(false);
      await expect(
        withMapStill(map, () => Promise.reject(new Error("capture failed"))),
      ).rejects.toThrow("capture failed");
      expect(isMapStill(map)).toBe(false);
    });

    it("reads the canvas inside the render event, not before", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      map.triggerRepaint.mockImplementation(() => {
        expect(canvas.toDataURL).not.toHaveBeenCalled();
        queueMicrotask(() => map.emit("render"));
      });

      await withMapStill(map, () => undefined);

      expect(canvas.toDataURL).toHaveBeenCalledOnce();
    });

    it("puts the canvas back when the callback fails", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      const parent = canvas.parentElement!;

      await expect(
        withMapStill(map, () => Promise.reject(new Error("capture failed"))),
      ).rejects.toThrow("capture failed");

      expect(parent.contains(canvas)).toBe(true);
      expect(parent.querySelector("img")).toBeNull();
    });

    it("rejects when the canvas cannot be read, and leaves the map as it was", async () => {
      const map = stillMap();
      const canvas = map.getCanvas();
      const parent = canvas.parentElement!;
      vi.mocked(canvas.toDataURL).mockImplementation(() => {
        throw new Error("tainted canvas");
      });
      const fn = vi.fn();

      await expect(withMapStill(map, fn)).rejects.toThrow("tainted canvas");

      expect(fn).not.toHaveBeenCalled();
      expect(parent.contains(canvas)).toBe(true);
      expect(map.listenerCount("render")).toBe(0);
    });

    it("rejects when the map draws no frame in time, as after a lost context", async () => {
      vi.useFakeTimers();
      const map = stillMap();
      const canvas = map.getCanvas();
      const parent = canvas.parentElement!;
      map.triggerRepaint.mockImplementation(() => undefined);
      const fn = vi.fn();

      const pending = withMapStill(map, fn);
      const settled = expect(pending).rejects.toThrow(
        "the map did not draw in time",
      );
      await vi.advanceTimersByTimeAsync(MAP_STILL_TIMEOUT_MS);
      await settled;

      expect(fn).not.toHaveBeenCalled();
      expect(parent.contains(canvas)).toBe(true);
      // A frame that comes late after all finds nobody waiting
      expect(map.listenerCount("render")).toBe(0);
      vi.useRealTimers();
    });

    it("stops the clock once the frame is there", async () => {
      vi.useFakeTimers();
      const map = stillMap();

      await withMapStill(map, () => undefined);

      expect(vi.getTimerCount()).toBe(0);
      expect(map.listenerCount("render")).toBe(0);
      vi.useRealTimers();
    });

    it("carries on with an image that does not decode", async () => {
      HTMLImageElement.prototype.decode = vi.fn(() =>
        Promise.reject(new Error("decode")),
      );
      const map = stillMap();
      const fn = vi.fn();

      await withMapStill(map, fn);

      expect(fn).toHaveBeenCalledOnce();
    });

    describe("at a pixel ratio", () => {
      afterEach(() => setDevicePixelRatio(1));

      it("draws the still at the ratio asked for and hands the map back to the screen's", async () => {
        const map = stillMap();
        const canvas = map.getCanvas();
        const steps: string[] = [];
        map.setPixelRatio.mockImplementation((ratio: number | null) => {
          steps.push(`ratio ${String(ratio)}`);
        });
        vi.mocked(canvas.toDataURL).mockImplementation(() => {
          steps.push("frame read");
          return "data:image/png;base64,AAAA";
        });
        await withMapStill(
          map,
          () => {
            steps.push(
              canvas.parentElement ? "capture of canvas" : "capture of still",
            );
          },
          2,
        );
        steps.push(canvas.parentElement ? "canvas back" : "canvas gone");

        // Null, not 1: the map follows the screen again instead of being
        // pinned to the ratio the screen had during the export
        expect(steps).toEqual([
          "ratio 2",
          "frame read",
          "capture of still",
          "ratio null",
          "canvas back",
        ]);
      });

      it("puts the canvas back even when the ratio cannot be restored", async () => {
        // A map removed during the capture throws on the resize behind
        // setPixelRatio; the page must not be left showing a still
        const map = stillMap();
        const canvas = map.getCanvas();
        const parent = canvas.parentElement!;
        map.setPixelRatio.mockImplementation((ratio: number | null) => {
          if (ratio === null) throw new TypeError("the map is gone");
        });

        await expect(withMapStill(map, () => undefined, 2)).rejects.toThrow(
          "the map is gone",
        );

        expect(parent.contains(canvas)).toBe(true);
        expect(parent.querySelector("img")).toBeNull();
      });

      it("hands the map back to the screen although the screen changed meanwhile", async () => {
        // A browser zoom or another monitor during the capture: asked at the
        // end, the map would look like one with a ratio of its own and be
        // pinned to the old one
        const map = stillMap();
        const restored: (number | null)[] = [];
        map.setPixelRatio.mockImplementation((ratio: number | null) => {
          restored.push(ratio);
        });

        await withMapStill(map, () => setDevicePixelRatio(1.25), 2);

        expect(restored).toEqual([2, null]);
      });

      it("leaves a canvas alone that is already as large as it can get", async () => {
        // MapLibre holds the canvas below the ratio it was asked for once it
        // hits its size limit; raising the ratio would cost two resizes, and
        // their move events, to take the same still
        const map = stillMap();
        const canvas = map.getCanvas();
        Object.defineProperty(canvas, "clientWidth", {
          value: 5000,
          configurable: true,
        });
        canvas.width = 4096;

        await withMapStill(map, () => undefined, 2);

        expect(map.setPixelRatio).not.toHaveBeenCalled();
      });

      it("puts the canvas back only after the ratio is restored", async () => {
        const map = stillMap();
        const canvas = map.getCanvas();
        const attached: boolean[] = [];
        map.setPixelRatio.mockImplementation(() => {
          attached.push(canvas.parentElement !== null);
        });

        await withMapStill(map, () => undefined, 2);

        // Raised on the canvas in the page, lowered behind the still
        expect(attached).toEqual([true, false]);
      });

      it("restores a ratio the map was given, as the number it was", async () => {
        const map = stillMap();
        map.setPixelRatio(1.5);
        map.setPixelRatio.mockClear();

        await withMapStill(map, () => undefined, 2);

        expect(map.setPixelRatio.mock.calls).toEqual([[2], [1.5]]);
        expect(map.getPixelRatio()).toBe(1.5);
      });

      it.each([
        ["denser than", 3],
        ["as dense as", 2],
      ])(
        "leaves the ratio alone on a screen %s the export",
        async (_name, screen) => {
          setDevicePixelRatio(screen);
          const map = stillMap();
          const fn = vi.fn();

          await withMapStill(map, fn, 2);

          expect(fn).toHaveBeenCalledOnce();
          expect(map.setPixelRatio).not.toHaveBeenCalled();
        },
      );

      it("leaves the ratio alone when none is asked for", async () => {
        const map = stillMap();

        await withMapStill(map, () => undefined);

        expect(map.setPixelRatio).not.toHaveBeenCalled();
      });

      it("restores the ratio when the callback fails", async () => {
        const map = stillMap();
        const canvas = map.getCanvas();
        const parent = canvas.parentElement!;

        await expect(
          withMapStill(
            map,
            () => Promise.reject(new Error("capture failed")),
            2,
          ),
        ).rejects.toThrow("capture failed");

        expect(map.setPixelRatio.mock.calls).toEqual([[2], [null]]);
        expect(parent.contains(canvas)).toBe(true);
        expect(parent.querySelector("img")).toBeNull();
      });

      it("restores the ratio when the canvas cannot be read", async () => {
        const map = stillMap();
        const canvas = map.getCanvas();
        vi.mocked(canvas.toDataURL).mockImplementation(() => {
          throw new Error("tainted canvas");
        });

        await expect(withMapStill(map, vi.fn(), 2)).rejects.toThrow(
          "tainted canvas",
        );

        expect(map.setPixelRatio.mock.calls).toEqual([[2], [null]]);
        expect(canvas.parentElement).not.toBeNull();
        expect(map.listenerCount("render")).toBe(0);
      });

      it("restores the ratio when the map draws no frame in time", async () => {
        vi.useFakeTimers();
        const map = stillMap();
        map.triggerRepaint.mockImplementation(() => undefined);

        const pending = withMapStill(map, vi.fn(), 2);
        const settled = expect(pending).rejects.toThrow(
          "the map did not draw in time",
        );
        await vi.advanceTimersByTimeAsync(MAP_STILL_TIMEOUT_MS);
        await settled;

        expect(map.setPixelRatio.mock.calls).toEqual([[2], [null]]);
        expect(map.getCanvas().parentElement).not.toBeNull();
        expect(map.listenerCount("render")).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
      });

      it("lets go of the frame once the canvas is back", async () => {
        const map = stillMap();
        const parent = map.getCanvas().parentElement!;
        let still: HTMLImageElement | null = null;

        await withMapStill(
          map,
          () => {
            still = parent.querySelector("img");
          },
          2,
        );

        expect(still!.hasAttribute("src")).toBe(false);
      });
    });
  });

  describe("cssVar", () => {
    it("reads a token of the root element, trimmed", () => {
      document.documentElement.style.setProperty("--color-test", "  #123456 ");

      expect(cssVar("--color-test")).toBe("#123456");
    });

    it("is empty for a token that is not set", () => {
      expect(cssVar("--color-unset")).toBe("");
    });
  });

  describe("withoutValidation", () => {
    /**
     * A map whose style records what it is given, with its methods on its
     * prototype like MapLibre's
     */
    const styled = () => {
      const added = { layers: vi.fn(), sources: vi.fn() };
      class Style {
        addLayer(...args: unknown[]): this {
          added.layers(this, ...args);
          return this;
        }
        addSource(...args: unknown[]): void {
          added.sources(this, ...args);
        }
      }
      const style = new Style();
      return { added, style, map: { style } as unknown as MapLibreMap };
    };

    it("adds layers and sources without validating them, for as long as it runs", () => {
      const { added, style, map } = styled();
      const layer = { id: "a", type: "background" } as const;

      const result = withoutValidation(map, () => {
        // Through the style, as `Map.addLayer` and a style's difference do
        map.style.addLayer(layer, "b");
        map.style.addSource("s", { type: "geojson", data: "s.json" }, {});
        return 42;
      });

      expect(result).toBe(42);
      expect(added.layers).toHaveBeenCalledWith(style, layer, "b", {
        validate: false,
      });
      expect(added.sources).toHaveBeenCalledWith(
        style,
        "s",
        { type: "geojson", data: "s.json" },
        { validate: false },
      );
      // And validating again afterwards, with the style's own methods
      expect(Object.hasOwn(style, "addLayer")).toBe(false);
      expect(Object.hasOwn(style, "addSource")).toBe(false);
      map.style.addLayer(layer, "b");
      expect(added.layers).toHaveBeenLastCalledWith(style, layer, "b");
    });

    it("validates again after a throw", () => {
      const { style, map } = styled();

      expect(() =>
        withoutValidation(map, () => {
          throw new Error("refused");
        }),
      ).toThrow("refused");
      expect(Object.hasOwn(style, "addLayer")).toBe(false);
    });

    it("runs on a map without a style", () => {
      expect(withoutValidation({} as MapLibreMap, () => "ran")).toBe("ran");
    });
  });

  describe("slideMapBesideRail", () => {
    let container: HTMLElement;
    const classes = () => [...document.body.classList].sort();
    const transitionEnd = (target: HTMLElement, propertyName: string) => {
      const event = new Event("transitionend", { bubbles: true });
      Object.assign(event, { propertyName });
      target.dispatchEvent(event);
    };

    beforeEach(() => {
      vi.useFakeTimers();
      container = document.createElement("div");
      document.body.appendChild(container);
    });

    afterEach(() => {
      vi.useRealTimers();
      container.remove();
      document.body.className = "";
    });

    it("slides the map at its whole width until the rail has opened", () => {
      slideMapBesideRail(container, true, true);

      expect(classes()).toEqual(["rail-sliding", "stats-open"]);
      // A transition of something inside the map is not the slide's
      const child = document.createElement("span");
      container.appendChild(child);
      transitionEnd(child, "transform");
      transitionEnd(container, "left");
      expect(classes()).toContain("rail-sliding");

      transitionEnd(container, "transform");
      expect(classes()).toEqual(["stats-open"]);
    });

    it("starts a closing slide where the open rail left the map", () => {
      document.body.classList.add("stats-open");
      const seen: string[][] = [];
      const read = vi
        .spyOn(window, "getComputedStyle")
        .mockImplementation(() => {
          seen.push(classes());
          return {} as CSSStyleDeclaration;
        });

      slideMapBesideRail(container, false, true);

      // Read once in the start position, then sliding back
      expect(seen).toEqual([["rail-leaving"]]);
      expect(classes()).toEqual(["rail-sliding"]);
      read.mockRestore();
      // No transition to end it: the phone's sheet does not move the map
      vi.advanceTimersByTime(350);
      expect(classes()).toEqual([]);
    });

    it("ends a slide under way when the rail turns back", () => {
      slideMapBesideRail(container, true, true);
      slideMapBesideRail(container, false, true);
      vi.advanceTimersByTime(349);
      expect(classes()).toEqual(["rail-sliding"]);

      vi.advanceTimersByTime(1);
      expect(classes()).toEqual([]);
    });

    it("only switches the rail without an animation or a map", () => {
      slideMapBesideRail(container, true, false);
      expect(classes()).toEqual(["stats-open"]);

      slideMapBesideRail(null, false, true);
      expect(classes()).toEqual([]);
    });
  });
});
