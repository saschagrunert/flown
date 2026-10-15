/**
 * Mock implementation of maplibre-gl for testing.
 *
 * jsdom has no WebGL, so the real map cannot be constructed. This one keeps
 * what the app tells it: the sources with their last `setData`, the layers in
 * drawing order with their layout, paint and filter, the camera, and the
 * handlers registered with `on` and `once`, which `emit` really calls. A test
 * therefore asserts on the state of the map (`map.layers`, `map.sources`)
 * rather than on a list of calls, and drives the app by emitting map events.
 *
 * Positions are validated as `[lng, lat]`, so a latitude-first pair that
 * slipped through fails loudly whenever its second number cannot be a
 * latitude.
 *
 * What the app sets on a layer after it was added (paint, layout, filter) is
 * checked against the style specification, as MapLibre would, also where the
 * app passes `validate: false`: a property it refuses would otherwise only
 * show as a map that draws nothing.
 *
 * Every method a mock offers is named against the MapLibre type it stands in
 * for (see `MockOf`), so `npm run typecheck:tests` fails when a mock grows a
 * method MapLibre does not have or MapLibre drops one the mocks still offer.
 * The fields outside `MockOf` are test conveniences the real objects lack.
 */
import type * as maplibregl from "maplibre-gl";
import {
  validateStyleMin,
  type StyleSpecification,
} from "@maplibre/maplibre-gl-style-spec";
import { vi, type Mock } from "vitest";

/**
 * Spies for the named methods of a MapLibre type. The constraint on `K` is
 * the drift check: a name that is not a member of `T` does not compile.
 */
type MockOf<T, K extends keyof T> = Record<K, Mock>;

type Handler = (event?: unknown) => void;

/** Switches for how the next maps behave; `resetMapLibreMock` restores them */
export const mockControl = {
  /**
   * Fire `style.load` by itself, a microtask after construction or
   * `setStyle`. A test of a failing style turns this off and emits `error`.
   */
  autoLoadStyle: true,
};

/** Every map constructed since the last reset, oldest first */
export const maps: Map[] = [];

/** The map the code under test created last */
export function lastMap(): Map {
  const map = maps.at(-1);
  if (!map) throw new Error("no map was constructed");
  return map;
}

/** Forget the constructed maps and restore the default behaviour */
export function resetMapLibreMock(): void {
  maps.length = 0;
  mockControl.autoLoadStyle = true;
}

/** Validate and normalise anything MapLibre accepts as a position */
export function assertLngLat(value: unknown, context = "lngLat"): LngLat {
  let lng: unknown;
  let lat: unknown;
  if (Array.isArray(value)) {
    [lng, lat] = value as unknown[];
  } else if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    lng = v["lng"] ?? v["lon"];
    lat = v["lat"];
  }
  if (
    typeof lng !== "number" ||
    typeof lat !== "number" ||
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    Math.abs(lat) > 90
  ) {
    throw new Error(
      `${context}: expected [lng, lat], got ${JSON.stringify(value)}`,
    );
  }
  return new LngLat(lng, lat);
}

export class Point {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

export class LngLat {
  constructor(
    public lng: number,
    public lat: number,
  ) {}

  toArray(): [number, number] {
    return [this.lng, this.lat];
  }

  wrap(): LngLat {
    const lng = ((((this.lng + 180) % 360) + 360) % 360) - 180;
    return new LngLat(lng === -180 ? 180 : lng, this.lat);
  }
}

export class LngLatBounds {
  private sw: LngLat | null = null;
  private ne: LngLat | null = null;

  constructor(sw?: unknown, ne?: unknown) {
    if (sw !== undefined) this.extend(sw);
    if (ne !== undefined) this.extend(ne);
  }

  extend(value: unknown): this {
    if (value instanceof LngLatBounds) {
      if (value.sw && value.ne) this.extend(value.sw).extend(value.ne);
      return this;
    }
    if (
      Array.isArray(value) &&
      (Array.isArray(value[0]) || typeof value[0] === "object")
    ) {
      for (const corner of value as unknown[]) this.extend(corner);
      return this;
    }
    const p = assertLngLat(value, "LngLatBounds.extend");
    this.sw = new LngLat(
      Math.min(p.lng, this.sw?.lng ?? p.lng),
      Math.min(p.lat, this.sw?.lat ?? p.lat),
    );
    this.ne = new LngLat(
      Math.max(p.lng, this.ne?.lng ?? p.lng),
      Math.max(p.lat, this.ne?.lat ?? p.lat),
    );
    return this;
  }

  getSouthWest(): LngLat {
    return this.sw ?? new LngLat(0, 0);
  }

  getNorthEast(): LngLat {
    return this.ne ?? new LngLat(0, 0);
  }

  getCenter(): LngLat {
    const sw = this.getSouthWest();
    const ne = this.getNorthEast();
    return new LngLat((sw.lng + ne.lng) / 2, (sw.lat + ne.lat) / 2);
  }

  contains(value: unknown): boolean {
    const p = assertLngLat(value, "LngLatBounds.contains");
    const sw = this.getSouthWest();
    const ne = this.getNorthEast();
    return (
      p.lng >= sw.lng && p.lng <= ne.lng && p.lat >= sw.lat && p.lat <= ne.lat
    );
  }

  toArray(): [[number, number], [number, number]] {
    return [this.getSouthWest().toArray(), this.getNorthEast().toArray()];
  }
}

/** What the camera methods of the mock map take */
interface MockCameraOptions {
  center?: unknown;
  zoom?: number;
  bearing?: number;
  pitch?: number;
  elevation?: number;
}

/** `on`, `once` and `off` that keep their handlers, and `emit` to call them */
class MockEvented {
  readonly handlers = new globalThis.Map<string, Set<Handler>>();

  /**
   * A listener for one layer, `on(type, layerId, handler)`, is kept under
   * `type:layerId`: `emit("mouseenter:airport-labels")` calls it
   */
  on = vi.fn(
    (type: string, layerOrHandler: string | Handler, handler?: Handler) => {
      const key =
        typeof layerOrHandler === "string" ? `${type}:${layerOrHandler}` : type;
      const listener =
        typeof layerOrHandler === "string" ? handler! : layerOrHandler;
      let set = this.handlers.get(key);
      if (!set) this.handlers.set(key, (set = new Set()));
      set.add(listener);
      return { unsubscribe: () => this.off(key, listener) };
    },
  );

  once = vi.fn((type: string, handler?: Handler) => {
    // Like MapLibre: without a handler the next event is promised
    if (!handler) {
      return new Promise((resolve) => {
        void this.once(type, resolve);
      });
    }
    const wrapped: Handler = (event) => {
      this.off(type, wrapped);
      handler(event);
    };
    this.on(type, wrapped);
    return this;
  });

  off = vi.fn((type: string, handler: Handler) => {
    this.handlers.get(type)?.delete(handler);
    return this;
  });

  /** Call what is registered for `type`, the way the map would */
  emit(type: string, event: object = {}): void {
    for (const handler of [...(this.handlers.get(type) ?? [])]) {
      handler({ type, target: this, ...event });
    }
  }

  /** MapLibre's own `fire`, for an event the app raises on the map */
  fire = vi.fn((type: string, event: object = {}) => {
    this.emit(type, event);
    return this;
  });

  /** How many handlers listen to `type` right now */
  listenerCount(type: string): number {
    return this.handlers.get(type)?.size ?? 0;
  }
}

/** A source as the mock map keeps it */
export interface MockSource {
  id: string;
  spec: Record<string, unknown>;
  /** What the last `setData` passed, or the data of the specification */
  data: unknown;
  setData: Mock;
  /** The specification with the data it holds now, as the map reports it */
  serialize: Mock;
}

/** A layer as the mock map keeps it; the setters of the map write through */
export interface MockLayer {
  id: string;
  type: string;
  source?: string;
  /** The `source-layer` of the spec, under the name the map's layers use */
  sourceLayer?: string;
  minzoom?: number;
  maxzoom?: number;
  layout: Record<string, unknown>;
  paint: Record<string, unknown>;
  filter?: unknown;
}

/** Layers a style fetched by URL stands in with: one below, labels on top */
const URL_STYLE_LAYERS: MockLayer[] = [
  { id: "background", type: "background", layout: {}, paint: {} },
  { id: "place-labels", type: "symbol", layout: {}, paint: {} },
];

function toMockLayer(layer: Record<string, unknown>): MockLayer {
  const sourceLayer = layer["source-layer"];
  return {
    ...(layer as unknown as MockLayer),
    ...(typeof sourceLayer === "string" && { sourceLayer }),
    layout: { ...(layer["layout"] as Record<string, unknown> | undefined) },
    paint: { ...(layer["paint"] as Record<string, unknown> | undefined) },
  };
}

/**
 * A gesture handler. `isActive` answers false, no gesture being under way,
 * until a test says otherwise with `mockReturnValue`.
 */
function mockHandler(): {
  enable: Mock;
  disable: Mock;
  isEnabled: Mock;
  isActive: Mock<() => boolean>;
} {
  let enabled = true;
  return {
    enable: vi.fn(() => (enabled = true)),
    disable: vi.fn(() => (enabled = false)),
    isEnabled: vi.fn(() => enabled),
    isActive: vi.fn(() => false),
  };
}

export class Map
  extends MockEvented
  implements
    MockOf<
      maplibregl.Map,
      | "on"
      | "once"
      | "off"
      | "addSource"
      | "getSource"
      | "removeSource"
      | "addLayer"
      | "getLayer"
      | "removeLayer"
      | "moveLayer"
      | "getLayersOrder"
      | "setLayoutProperty"
      | "getLayoutProperty"
      | "setPaintProperty"
      | "getPaintProperty"
      | "setFilter"
      | "getStyle"
      | "setStyle"
      | "isStyleLoaded"
      | "isSourceLoaded"
      | "loaded"
      | "areTilesLoaded"
      | "getZoom"
      | "setZoom"
      | "getCenter"
      | "setCenter"
      | "getBounds"
      | "getRenderWorldCopies"
      | "getBearing"
      | "getPitch"
      | "getVerticalFieldOfView"
      | "getCenterElevation"
      | "setCenterClampedToGround"
      | "queryTerrainElevation"
      | "calculateCameraOptionsFromTo"
      | "getProjection"
      | "setProjection"
      | "fitBounds"
      | "cameraForBounds"
      | "setPadding"
      | "jumpTo"
      | "easeTo"
      | "flyTo"
      | "panBy"
      | "panTo"
      | "stop"
      | "isMoving"
      | "isZooming"
      | "resize"
      | "getPixelRatio"
      | "setPixelRatio"
      | "project"
      | "unproject"
      | "queryRenderedFeatures"
      | "getContainer"
      | "getCanvas"
      | "getCanvasContainer"
      | "triggerRepaint"
      | "getGlobalState"
      | "setGlobalStateProperty"
      | "addControl"
      | "remove"
    >
{
  /** The options the map was constructed with */
  readonly options: Record<string, unknown>;
  /** Sources by id */
  readonly sources: Record<string, MockSource> = {};
  /** Layers in drawing order, bottom first */
  layers: MockLayer[] = [];
  /** Controls with the corner they were added to */
  readonly controls: { control: unknown; position: string | undefined }[] = [];
  /** What `queryRenderedFeatures` answers; a test sets it */
  renderedFeatures: unknown[] = [];
  removed = false;

  /** Whether the style has loaded; sources and layers need one */
  private styleLoaded = false;
  private zoom: number;
  private center: LngLat;
  private bearing: number;
  private pitch: number;
  /** Undefined until one is set, like a style that names none */
  private projection: { type: string } | undefined;
  private readonly container: HTMLElement;
  private readonly canvasContainer: HTMLElement;
  private readonly canvas: HTMLCanvasElement;

  readonly touchZoomRotate = { ...mockHandler(), disableRotation: vi.fn() };
  readonly keyboard = { ...mockHandler(), disableRotation: vi.fn() };
  readonly dragPan = mockHandler();
  readonly dragRotate = mockHandler();
  readonly scrollZoom = mockHandler();
  readonly doubleClickZoom = mockHandler();

  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    const container = options["container"];
    this.container =
      typeof container === "string"
        ? (document.getElementById(container) ?? document.createElement("div"))
        : (container as HTMLElement);
    this.container.classList.add("maplibregl-map");
    this.canvasContainer = document.createElement("div");
    this.canvasContainer.className = "maplibregl-canvas-container";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "maplibregl-canvas";
    this.canvas.tabIndex = 0;
    this.canvasContainer.append(this.canvas);
    this.container.append(this.canvasContainer);

    this.zoom = typeof options["zoom"] === "number" ? options["zoom"] : 0;
    this.bearing =
      typeof options["bearing"] === "number" ? options["bearing"] : 0;
    this.pitch = typeof options["pitch"] === "number" ? options["pitch"] : 0;
    this.center =
      options["center"] !== undefined
        ? assertLngLat(options["center"], "Map center")
        : new LngLat(0, 0);
    if (options["bounds"] !== undefined) {
      this.center = new LngLatBounds(options["bounds"]).getCenter();
    }

    maps.push(this);
    this.loadStyle(options["style"]);
  }

  private loadStyle(style: unknown): void {
    this.styleLoaded = false;
    for (const id of Object.keys(this.sources)) delete this.sources[id];
    this.layers = [];
    if (!mockControl.autoLoadStyle) return;
    queueMicrotask(() => this.finishStyleLoad(style));
  }

  /** Finish loading a style; a test with `autoLoadStyle` off calls this */
  finishStyleLoad(style: unknown = this.options["style"]): void {
    if (this.removed) return;
    const layers =
      typeof style === "object" && style !== null
        ? ((style as { layers?: Record<string, unknown>[] }).layers ?? []).map(
            toMockLayer,
          )
        : URL_STYLE_LAYERS.map((layer) => ({ ...layer }));
    this.layers = layers;
    this.styleLoaded = true;
    this.emit("style.load");
    this.emit("load");
  }

  /** The layer with this id; throws, so a test reads as an assertion */
  layer(id: string): MockLayer {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) throw new Error(`no layer "${id}"`);
    return layer;
  }

  /** The source with this id; throws like `layer` */
  source(id: string): MockSource {
    const source = this.sources[id];
    if (!source) throw new Error(`no source "${id}"`);
    return source;
  }

  addSource = vi.fn((id: string, spec: Record<string, unknown>) => {
    if (!this.styleLoaded) throw new Error("Style is not done loading.");
    if (this.sources[id]) throw new Error(`Source "${id}" already exists.`);
    const source: MockSource = {
      id,
      spec,
      data: spec["data"],
      // Like a GeoJSON source: the promise settles once the worker has the
      // data. The fake has no worker, so at once; a test of the time in
      // between hands out a promise of its own with `mockReturnValueOnce`.
      setData: vi.fn((data: unknown) => {
        source.data = data;
        return Promise.resolve();
      }),
      serialize: vi.fn(() =>
        source.data === undefined ? spec : { ...spec, data: source.data },
      ),
    };
    this.sources[id] = source;
    return this;
  });

  getSource = vi.fn((id: string) => this.sources[id]);

  // MapLibre throws for both
  removeSource = vi.fn((id: string) => {
    if (!this.sources[id]) throw new Error("There is no source with this ID");
    const user = this.layers.find((l) => l.source === id);
    if (user) {
      throw new Error(
        `Source "${id}" cannot be removed while layer "${user.id}" is using it.`,
      );
    }
    delete this.sources[id];
    return this;
  });

  addLayer = vi.fn((layer: Record<string, unknown>, beforeId?: string) => {
    if (!this.styleLoaded) throw new Error("Style is not done loading.");
    const id = layer["id"] as string;
    if (this.layers.some((l) => l.id === id)) {
      throw new Error(`Layer "${id}" already exists on this map.`);
    }
    const source = layer["source"];
    if (typeof source === "string" && !this.sources[source]) {
      throw new Error(`Source "${source}" not found.`);
    }
    const index = this.beforeIndex(beforeId, `add layer "${id}"`);
    this.layers.splice(index, 0, toMockLayer(layer));
    return this;
  });

  /**
   * Where a layer goes before `beforeId`, the end without one. MapLibre
   * fires an error and leaves the layer out (or, moving it, out of the
   * order) for an id it does not have, which the fake throws for instead,
   * as for every other id it does not know: a test would not see the event.
   */
  private beforeIndex(beforeId: string | undefined, action: string): number {
    if (!beforeId) return this.layers.length;
    const index = this.layers.findIndex((l) => l.id === beforeId);
    if (index < 0) {
      throw new Error(
        `Cannot ${action} before non-existing layer "${beforeId}".`,
      );
    }
    return index;
  }

  getLayer = vi.fn((id: string) => this.layers.find((l) => l.id === id));

  removeLayer = vi.fn((id: string) => {
    const layer = this.layer(id);
    this.layers = this.layers.filter((l) => l !== layer);
    return this;
  });

  moveLayer = vi.fn((id: string, beforeId?: string) => {
    const layer = this.layer(id);
    if (id === beforeId) return this;
    this.layers = this.layers.filter((l) => l !== layer);
    this.layers.splice(
      this.beforeIndex(beforeId, `move layer "${id}"`),
      0,
      layer,
    );
    return this;
  });

  getLayersOrder = vi.fn(() => this.layers.map((l) => l.id));

  setLayoutProperty = vi.fn((id: string, name: string, value: unknown) => {
    const layer = this.layer(id);
    layer.layout[name] = value;
    this.checkLayer(layer);
    return this;
  });

  getLayoutProperty = vi.fn(
    (id: string, name: string) => this.layer(id).layout[name],
  );

  setLayerZoomRange = vi.fn((id: string, minzoom: number, maxzoom: number) => {
    const layer = this.layer(id);
    layer.minzoom = minzoom;
    layer.maxzoom = maxzoom;
    return this;
  });

  setPaintProperty = vi.fn((id: string, name: string, value: unknown) => {
    const layer = this.layer(id);
    layer.paint[name] = value;
    this.checkLayer(layer);
    return this;
  });

  getPaintProperty = vi.fn(
    (id: string, name: string) => this.layer(id).paint[name],
  );

  setFilter = vi.fn((id: string, filter: unknown) => {
    const layer = this.layer(id);
    layer.filter = filter;
    this.checkLayer(layer);
    return this;
  });

  /**
   * Throw for a layer the style specification refuses, checked on its own
   * in a style of its source (a GeoJSON one where the fake has none). A
   * custom layer has nothing the specification describes. A null filter or
   * property is one taken off, as MapLibre takes it.
   */
  private checkLayer(layer: MockLayer): void {
    if (layer.type === "custom") return;
    const { sourceLayer, ...spec } = layer;
    const source = typeof spec.source === "string" ? spec.source : undefined;
    const style = JSON.parse(
      JSON.stringify({
        version: 8,
        sources: source
          ? {
              [source]: this.sources[source]?.spec ?? {
                type: "geojson",
                data: { type: "FeatureCollection", features: [] },
              },
            }
          : {},
        layers: [
          { ...spec, ...(sourceLayer && { "source-layer": sourceLayer }) },
        ],
      }),
      function (this: unknown, _key: string, value: unknown) {
        return value === null && !Array.isArray(this) ? undefined : value;
      },
    ) as StyleSpecification;
    const errors = validateStyleMin(style);
    if (errors.length > 0) {
      throw new Error(errors.map((error) => error.message).join("; "));
    }
  }

  getStyle = vi.fn(() => ({
    version: 8,
    sources: Object.fromEntries(
      Object.values(this.sources).map((s) => [s.id, s.serialize()]),
    ),
    layers: this.layers,
  }));

  /**
   * With `transformStyle` on a loaded style, like the map's diff: sources
   * and layers the next style keeps stay the objects they are, the others
   * come and go, and `style.load` fires at once. A GeoJSON source whose
   * data differs from the data in the style before, as the transform left
   * it, is handed the new data. Anything else starts over.
   */
  setStyle = vi.fn(
    (
      style: unknown,
      options?: {
        transformStyle?: (
          previous: unknown,
          next: unknown,
        ) => {
          sources: Record<string, Record<string, unknown>>;
          layers: Record<string, unknown>[];
        };
      },
    ) => {
      if (!options?.transformStyle || !this.styleLoaded) {
        this.loadStyle(style);
        return this;
      }
      const previous = this.getStyle() as {
        sources: Record<string, { data?: unknown } | undefined>;
      };
      const next = options.transformStyle(previous, style);
      for (const id of Object.keys(this.sources)) {
        if (!(id in next.sources)) delete this.sources[id];
      }
      for (const [id, spec] of Object.entries(next.sources)) {
        const source = this.sources[id];
        if (!source) {
          this.addSource(id, spec);
        } else if (
          spec["type"] === "geojson" &&
          JSON.stringify(previous.sources[id]?.data) !==
            JSON.stringify(spec["data"])
        ) {
          void source.setData(spec["data"]);
        }
      }
      this.layers = next.layers.map(
        (layer) =>
          this.layers.find((l) => l.id === layer["id"]) ?? toMockLayer(layer),
      );
      this.emit("style.load");
      return this;
    },
  );

  /**
   * Whether a source has taken in its last `setData` and cut the tiles in
   * view from it. The fake has no worker, so it always has; a test of the
   * time in between says otherwise with `mockReturnValue`.
   */
  isSourceLoaded = vi.fn((id: string) => this.source(id) !== undefined);

  /** Like MapLibre: the global state the style's expressions read */
  globalState: Record<string, unknown> = {};
  getGlobalState = vi.fn(() => this.globalState);
  setGlobalStateProperty = vi.fn((name: string, value: unknown) => {
    if (!this.styleLoaded) throw new Error("Style is not done loading.");
    this.globalState[name] = value;
    return this;
  });

  isStyleLoaded = vi.fn(() => this.styleLoaded);
  loaded = vi.fn(() => this.styleLoaded);
  /** Whether the tiles in view are in; the fake's always are */
  areTilesLoaded = vi.fn(() => true);

  getZoom = vi.fn(() => this.zoom);
  setZoom = vi.fn((zoom: number) => {
    this.zoom = zoom;
    return this;
  });

  getCenter = vi.fn(() => this.center);
  setCenter = vi.fn((center: unknown) => {
    this.center = assertLngLat(center, "setCenter");
    return this;
  });

  getRenderWorldCopies = vi.fn(() => true);

  getBounds = vi.fn(
    () =>
      new LngLatBounds(
        [this.center.lng - 1, Math.max(-90, this.center.lat - 1)],
        [this.center.lng + 1, Math.min(90, this.center.lat + 1)],
      ),
  );

  getBearing = vi.fn(() => this.bearing);
  getPitch = vi.fn(() => this.pitch);
  getVerticalFieldOfView = vi.fn(() => 36.87);

  /**
   * The height the camera looks at, in metres: the ground's while the
   * centre is clamped to it (sea level here, the fake has no relief), and
   * what a camera move says otherwise, like MapLibre
   */
  private elevation = 0;
  private clampedToGround = true;
  getCenterElevation = vi.fn(() => this.elevation);
  setCenterClampedToGround = vi.fn((clamped: boolean) => {
    this.clampedToGround = clamped;
    if (clamped) this.elevation = 0;
  });
  /** The relief under a point: none without terrain, level ground with it */
  queryTerrainElevation = vi.fn((_lngLat: unknown): number | null =>
    this.terrain ? 0 : null,
  );
  /** The camera that looks from one point at another, pointing where it is */
  calculateCameraOptionsFromTo = vi.fn(
    (
      _from: unknown,
      _altitudeFrom: number,
      to: unknown,
      altitudeTo?: number,
    ) => ({
      center: assertLngLat(to, "calculateCameraOptionsFromTo"),
      elevation: altitudeTo ?? 0,
      zoom: this.zoom,
      bearing: this.bearing,
      pitch: this.pitch,
    }),
  );

  getProjection = vi.fn(() => this.projection);
  /** Like MapLibre: a projection is part of the style, so it needs one */
  setProjection = vi.fn((projection: { type: string }) => {
    if (!this.styleLoaded) throw new Error("Style is not done loading.");
    this.projection = projection;
    this.emit("projectiontransition", { newProjection: projection.type });
    return this;
  });

  terrain: { source: string; exaggeration?: number } | null = null;
  getTerrain = vi.fn(() => this.terrain);
  /** Like MapLibre: the relief needs a style and its elevation source */
  setTerrain = vi.fn(
    (terrain: { source: string; exaggeration?: number } | null) => {
      if (!this.styleLoaded) throw new Error("Style is not done loading.");
      if (terrain && !this.sources[terrain.source]) {
        throw new Error(`no source with ID: ${terrain.source}`);
      }
      this.terrain = terrain;
      return this;
    },
  );

  /** Like MapLibre: a fit turns the map north up unless it names a bearing */
  fitBounds = vi.fn((bounds: unknown, options: MockCameraOptions = {}) => {
    this.center = new LngLatBounds(bounds).getCenter();
    this.bearing = options.bearing ?? 0;
    if (options.pitch !== undefined) this.pitch = options.pitch;
    return this;
  });

  /** Where fitBounds takes the camera: the centre of the bounds, north up */
  cameraForBounds = vi.fn(
    (bounds: unknown, options: MockCameraOptions = {}) => ({
      center: new LngLatBounds(bounds).getCenter(),
      zoom: this.zoom,
      bearing: options.bearing ?? 0,
    }),
  );

  /** The padding of the view, which does not move the fake's camera */
  padding: maplibregl.PaddingOptions = { top: 0, right: 0, bottom: 0, left: 0 };
  setPadding = vi.fn((padding: maplibregl.PaddingOptions) => {
    this.padding = padding;
    return this;
  });

  /** The camera moves apply at once; none of them animates or fires events */
  private moveTo(options: MockCameraOptions): this {
    if (options.center !== undefined) {
      this.center = assertLngLat(options.center, "camera center");
    }
    if (options.zoom !== undefined) this.zoom = options.zoom;
    if (options.bearing !== undefined) this.bearing = options.bearing;
    if (options.pitch !== undefined) this.pitch = options.pitch;
    if (options.elevation !== undefined && !this.clampedToGround) {
      this.elevation = options.elevation;
    }
    return this;
  }

  /** `eventData` goes with the events of a move, which the fake fires none of */
  jumpTo = vi.fn((options: MockCameraOptions, _eventData?: object) =>
    this.moveTo(options),
  );
  easeTo = vi.fn((options: MockCameraOptions) => this.moveTo(options));
  flyTo = vi.fn((options: MockCameraOptions) => this.moveTo(options));
  panTo = vi.fn((center: unknown, _options?: object) =>
    this.moveTo({ center }),
  );
  panBy = vi.fn(() => this);
  stop = vi.fn(() => this);
  isMoving = vi.fn(() => false);
  isZooming = vi.fn(() => false);
  resize = vi.fn(() => this);

  /** Follows the screen until a ratio is set, and again once null is */
  private pixelRatioOverride: number | null = null;
  getPixelRatio = vi.fn(
    () => this.pixelRatioOverride ?? window.devicePixelRatio,
  );
  setPixelRatio = vi.fn((pixelRatio: number | null) => {
    this.pixelRatioOverride = pixelRatio;
  });

  /**
   * One pixel per thousandth of a degree around the centre, y growing down
   * the screen. The bearing turns it and the pitch foreshortens what runs up
   * the screen, without the perspective of the real thing.
   *
   * A globe is one seen from far away along the equator of its centre: what
   * lies east or west comes closer together towards the rim, 90 degrees of
   * longitude away, and what is further round than that is behind the globe
   * and answers with the point its mirror image is drawn at, like MapLibre.
   */
  project = vi.fn((lngLat: unknown) => {
    const p = assertLngLat(lngLat, "project");
    const east = this.eastOf(p.lng - this.center.lng) * 1000;
    const north = (p.lat - this.center.lat) * 1000;
    const { sin, cos } = this.turn();
    return new Point(
      east * cos - north * sin,
      -(east * sin + north * cos) * this.flatten(),
    );
  });

  unproject = vi.fn((point: Point | [number, number]) => {
    const [x, y] = Array.isArray(point) ? point : [point.x, point.y];
    const up = -y / this.flatten();
    const { sin, cos } = this.turn();
    return new LngLat(
      this.center.lng + this.degreesEast((x * cos + up * sin) / 1000),
      this.center.lat + (up * cos - x * sin) / 1000,
    );
  });

  /** Degrees of longitude from the centre as degrees across the map */
  private eastOf(degrees: number): number {
    if (this.projection?.type !== "globe") return degrees;
    return (Math.sin((degrees * Math.PI) / 180) * 180) / Math.PI;
  }

  /** The other way round; on a globe the answer is on the near side */
  private degreesEast(across: number): number {
    if (this.projection?.type !== "globe") return across;
    const sine = Math.max(-1, Math.min(1, (across * Math.PI) / 180));
    return (Math.asin(sine) * 180) / Math.PI;
  }

  private turn(): { sin: number; cos: number } {
    const radians = (this.bearing * Math.PI) / 180;
    return { sin: Math.sin(radians), cos: Math.cos(radians) };
  }

  private flatten(): number {
    return Math.cos((this.pitch * Math.PI) / 180);
  }

  /** `renderedFeatures`, those of the asked for layers only */
  queryRenderedFeatures = vi.fn(
    (_where?: unknown, options?: { layers?: string[] }) =>
      options?.layers
        ? this.renderedFeatures.filter((feature) =>
            options.layers!.includes(
              (feature as { layer?: { id?: string } }).layer?.id ?? "",
            ),
          )
        : this.renderedFeatures,
  );

  /** The state the app set per feature, by `source:id` */
  readonly featureStates = new globalThis.Map<string, object>();
  setFeatureState = vi.fn(
    (feature: { source: string; id?: string | number }, state: object) => {
      const key = `${feature.source}:${String(feature.id)}`;
      this.featureStates.set(key, { ...this.featureStates.get(key), ...state });
    },
  );
  removeFeatureState = vi.fn(
    (feature: { source: string; id?: string | number }, key?: string) => {
      const id = `${feature.source}:${String(feature.id)}`;
      const state: Record<string, unknown> = {
        ...this.featureStates.get(id),
      };
      if (key === undefined) {
        this.featureStates.delete(id);
        return;
      }
      delete state[key];
      this.featureStates.set(id, state);
    },
  );

  /** The images the map was given, by name */
  readonly images = new globalThis.Map<string, unknown>();
  hasImage = vi.fn((id: string) => this.images.has(id));
  addImage = vi.fn((id: string, image: unknown) => {
    this.images.set(id, image);
  });

  getContainer = vi.fn(() => this.container);
  getCanvas = vi.fn(() => this.canvas);
  getCanvasContainer = vi.fn(() => this.canvasContainer);

  /** A repaint is a `render` event, a microtask later like a frame would be */
  triggerRepaint = vi.fn(() => {
    queueMicrotask(() => this.emit("render"));
  });

  addControl = vi.fn((control: unknown, position?: string) => {
    this.controls.push({ control, position });
    return this;
  });

  remove = vi.fn(() => {
    this.removed = true;
    this.handlers.clear();
    this.canvasContainer.remove();
  });
}

export class AttributionControl {
  constructor(readonly options: Record<string, unknown> = {}) {}
}

export class Popup
  extends MockEvented
  implements
    MockOf<
      maplibregl.Popup,
      | "on"
      | "once"
      | "off"
      | "addTo"
      | "remove"
      | "isOpen"
      | "getElement"
      | "setLngLat"
      | "getLngLat"
      | "setHTML"
      | "setOffset"
      | "trackPointer"
    >
{
  /** The map the popup is open on */
  map: Map | null = null;
  /** True after `trackPointer()`, until the next `setLngLat` */
  tracksPointer = false;
  private lngLat: LngLat | null = null;
  private readonly element = document.createElement("div");
  private readonly content = document.createElement("div");

  constructor(readonly options: Record<string, unknown> = {}) {
    super();
    this.element.className = "maplibregl-popup";
    const className = options["className"];
    if (typeof className === "string" && className) {
      this.element.classList.add(...className.split(/\s+/));
    }
    this.content.className = "maplibregl-popup-content";
    this.element.append(this.content);
  }

  addTo = vi.fn((map: Map) => {
    this.map = map;
    map.getContainer().append(this.element);
    this.emit("open");
    return this;
  });

  remove = vi.fn(() => {
    if (!this.map) return this;
    this.map = null;
    this.element.remove();
    this.emit("close");
    return this;
  });

  isOpen = vi.fn(() => this.map !== null);
  // MapLibre's is undefined while the popup is closed; the mock keeps one
  // element for life, which a test can hold on to
  getElement = vi.fn(() => this.element);

  setLngLat = vi.fn((lngLat: unknown) => {
    this.lngLat = assertLngLat(lngLat, "Popup.setLngLat");
    this.tracksPointer = false;
    return this;
  });

  getLngLat = vi.fn(() => this.lngLat);

  setHTML = vi.fn((html: string) => {
    this.content.innerHTML = html;
    return this;
  });

  setOffset = vi.fn(() => this);

  trackPointer = vi.fn(() => {
    this.tracksPointer = true;
    return this;
  });
}

export class Marker
  extends MockEvented
  implements
    MockOf<
      maplibregl.Marker,
      | "on"
      | "once"
      | "off"
      | "addTo"
      | "remove"
      | "getElement"
      | "setLngLat"
      | "getLngLat"
      | "setPopup"
      | "getPopup"
      | "setRotation"
      | "setOffset"
      | "setPitchAlignment"
      | "getPitchAlignment"
    >
{
  /** The map the marker is on */
  map: Map | null = null;
  private lngLat: LngLat | null = null;
  private popup: Popup | null = null;
  private readonly element: HTMLElement;

  constructor(readonly options: Record<string, unknown> = {}) {
    super();
    const element = options["element"];
    this.element =
      element instanceof HTMLElement ? element : document.createElement("div");
    this.element.classList.add("maplibregl-marker");
    if (typeof options["pitchAlignment"] === "string") {
      this.pitchAlignment = options["pitchAlignment"];
    }
  }

  addTo = vi.fn((map: Map) => {
    this.map = map;
    map.getCanvasContainer().append(this.element);
    return this;
  });

  remove = vi.fn(() => {
    this.map = null;
    this.element.remove();
    return this;
  });

  getElement = vi.fn(() => this.element);

  setLngLat = vi.fn((lngLat: unknown) => {
    this.lngLat = assertLngLat(lngLat, "Marker.setLngLat");
    return this;
  });

  getLngLat = vi.fn(() => this.lngLat);

  setPopup = vi.fn((popup?: Popup | null) => {
    this.popup = popup ?? null;
    return this;
  });

  getPopup = vi.fn(() => this.popup);

  setRotation = vi.fn(() => this);
  setOffset = vi.fn(() => this);

  /** Laid on the map or standing in the screen */
  private pitchAlignment = "auto";
  setPitchAlignment = vi.fn((alignment?: string) => {
    this.pitchAlignment = alignment ?? "auto";
    return this;
  });
  getPitchAlignment = vi.fn(() => this.pitchAlignment);
}

export default {
  Map,
  Marker,
  Popup,
  AttributionControl,
  LngLat,
  LngLatBounds,
  Point,
};
