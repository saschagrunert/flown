/**
 * Map utility helpers
 * The places where the app's conventions meet MapLibre's: coordinate order,
 * zoom units, style readiness and the few things Leaflet did by itself
 */
import type {
  LngLatBoundsLike,
  Map as MapLibreMap,
  MapMouseEvent,
  MapTouchEvent,
  Point,
  Popup,
} from "maplibre-gl";
import { ZOOM_OFFSET } from "./constants";
import { DEGREES_TO_RADIANS, focalLengthPx } from "./geometry";
import { logError } from "./logger";
import { withTimeout } from "./withTimeout";
import { safeAreaInsets } from "./safeArea";

/** A position the way the data files carry it: latitude first */
export type LatLon = readonly [lat: number, lon: number, ...rest: number[]];

/** A position the way MapLibre and GeoJSON want it: longitude first */
export type LngLatTuple = [lng: number, lat: number];

/**
 * Turn a `[lat, lon]` pair of the data files into MapLibre's `[lng, lat]`.
 * The data stays latitude first, so every position crosses here on its way
 * to the map; an altitude behind the pair is dropped.
 */
export function toLngLat(latLon: LatLon): LngLatTuple {
  return [latLon[1], latLon[0]];
}

/**
 * `lng` moved by whole turns to the copy of the world within 180 degrees of
 * `near`. A line through the points of a flight takes each one near the one
 * before, so across the antimeridian it goes on past 180 rather than back
 * round the world; MapLibre draws a longitude beyond 180 where it belongs.
 */
export function unwrapLng(lng: number, near: number): number {
  return lng + 360 * Math.round((near - lng) / 360);
}

/** The size of each map, as mapSize last measured it */
const measuredSizes = new WeakMap<
  MapLibreMap,
  { width: number; height: number } | null
>();

/**
 * The size of the map's container in CSS pixels, measured once and again
 * after each `resize` of the map, which MapLibre fires as it follows the
 * container. Asking the container itself lays the page out, which the
 * map's own writes of the frame before (the markers it moved) have made
 * stale: the replay's camera asked in every frame, and on a phone spent up
 * to half a second of a frame of the chase view laying the page out.
 */
export function mapSize(map: MapLibreMap): { width: number; height: number } {
  let size = measuredSizes.get(map);
  if (size === undefined) {
    // Once per map: its size is measured anew when next asked
    map.on("resize", () => measuredSizes.set(map, null));
  }
  if (!size) {
    const container = map.getContainer();
    size = { width: container.clientWidth, height: container.clientHeight };
    measuredSizes.set(map, size);
  }
  return size;
}

/** `toLngLat`, in the copy of the world of the point before on a line */
export function toLngLatAfter(
  latLon: LatLon,
  previous: LngLatTuple | undefined,
): LngLatTuple {
  const [lng, lat] = toLngLat(latLon);
  return [previous ? unwrapLng(lng, previous[0]) : lng, lat];
}

/** Turn a position MapLibre reports back into the data's `[lat, lon]` */
export function fromLngLat(lngLat: {
  lng: number;
  lat: number;
}): [lat: number, lon: number] {
  return [lngLat.lat, lngLat.lng];
}

/**
 * Turn `[[minLat, minLon], [maxLat, maxLon]]`, the bounds of the page
 * configuration, into MapLibre's south-west and north-east corners.
 */
export function toBounds(
  bounds: readonly [LatLon, LatLon],
): [LngLatTuple, LngLatTuple] & LngLatBoundsLike {
  return [toLngLat(bounds[0]), toLngLat(bounds[1])];
}

/** A zoom of saved state or a link (legacy units) as a zoom of the map */
export function stateZoomToMap(zoom: number): number {
  return zoom - ZOOM_OFFSET;
}

/** A zoom of the map as the zoom saved state and links carry */
export function mapZoomToState(zoom: number): number {
  return zoom + ZOOM_OFFSET;
}

/**
 * Resolve with the map once it has a style to add sources and layers to.
 * Call it in the same turn the map is created in: it waits for `style.load`,
 * which fires once per style, and a map that already saw it would wait for
 * good. `isStyleLoaded()` cannot stand in for the event: it turns false
 * again after every `setData` until the worker has answered. A style that
 * fails to load never fires it; the caller owns that case (see MapApp, which
 * starts on a style that needs no network and swaps the real one in later).
 */
export function whenStyleReady(map: MapLibreMap): Promise<MapLibreMap> {
  return new Promise((resolve) => {
    void map.once("style.load", () => resolve(map));
  });
}

/**
 * Run `ready` with the map once it has its sources and layers (the app's
 * `mapReady`), unless the app was destroyed by then. A map that never gets
 * ready is no business of the caller: the start-up reports it and takes
 * the app down (MapApp.initialize). What `ready` throws is logged, with
 * `what` it was setting up: it runs in a promise nobody waits for, where
 * it would surface as an unhandled rejection without a word of where it
 * came from.
 */
export function onMapReady(
  app: {
    readonly mapReady: Promise<MapLibreMap>;
    readonly signal?: AbortSignal;
  },
  what: string,
  ready: (map: MapLibreMap) => void,
): void {
  app.mapReady.then(
    (map) => {
      if (app.signal?.aborted) return;
      try {
        ready(map);
      } catch (error) {
        logError(`${what}: the map got ready, but not for them`, error);
      }
    },
    () => {},
  );
}

/**
 * Call `onRestored` whenever the map has its style back after it lost its
 * WebGL context. MapLibre builds the style anew from what it held at the
 * loss, every source with the data it had then, and loads it a frame after
 * `webglcontextrestored`; data handed over in between had no source to go
 * to and has to be written again. For as long as the map lives, or until
 * `signal` aborts: the app is destroyed with the map left as it is.
 */
export function whenContextRestored(
  map: MapLibreMap,
  onRestored: () => void,
  signal?: AbortSignal,
): void {
  const restored = map.on("webglcontextrestored", () => {
    void map.once("style.load", () => {
      if (!signal?.aborted) onRestored();
    });
  });
  signal?.addEventListener("abort", () => restored.unsubscribe(), {
    once: true,
  });
}

/** Maps that have lost their WebGL context and not had their style back */
const lostContexts = new WeakSet<MapLibreMap>();

/**
 * Follow the WebGL context of the map from now on, for hasLostContext.
 * Called as the map is created, so the style that comes back after a loss
 * says so before anyone else hears of it (see whenContextRestored).
 */
export function followContextLoss(map: MapLibreMap): void {
  map.on("webglcontextlost", () => lostContexts.add(map));
  whenContextRestored(map, () => lostContexts.delete(map));
}

/**
 * Whether the map has lost its WebGL context and has not had its style
 * back yet. MapLibre drops the style meanwhile, and most of what is asked
 * of the map throws: the replay's frames skip their work on it until then.
 */
export function hasLostContext(map: MapLibreMap): boolean {
  return lostContexts.has(map);
}

/**
 * What the app's scripted cameras pass along with their moves: the replay's
 * follow pan and chase view (ReplayCamera), the orbit of the replay of all
 * flights, and the moves of ui/cameraScript.ts (Wrapped's intro, the hotspot
 * tour). MapLibre ends each jump with `moveend`, and `zoomend` if it zoomed:
 * what the app does once the map comes to rest skips these (isReplayCameraMove)
 * and runs once the camera itself rests, which fires both again untagged.
 */
export const REPLAY_CAMERA_MOVE = { replayCamera: true } as const;

/** Whether an event of the map is one of a jump of the replay's camera */
export function isReplayCameraMove(event: object): boolean {
  return (event as { replayCamera?: unknown }).replayCamera === true;
}

/**
 * Whether an event of the map was aimed at a marker. MapLibre listens on
 * the container the markers sit in and does not ask: a pointer over a marker
 * moves over the map as well, and a click on one is a click on the map. The
 * app's own map handlers ask here, so no marker has to opt out of them, and
 * none stops its events: the press and the touch move the map when a drag
 * starts on a marker, as they always have.
 */
export function isOnMarker(e: { originalEvent?: Event | undefined }): boolean {
  return isInMarker(e.originalEvent?.target);
}

/** Longest gap between the taps of a double tap, in milliseconds */
export const DOUBLE_TAP_MS = 400;

/**
 * Tell a marker's own activations apart from the later clicks of a double
 * click or a double tap, which would close the popup the first one opened.
 * Returns a filter for the marker's clicks, true for an activation.
 *
 * `detail` counts the clicks of a burst, but WebKit reports every tap as a
 * click with a `detail` of 1. A click that follows the last one within the
 * double tap time counts as part of its burst as well. A key reports a
 * `detail` of 0 and is always an activation.
 */
export function createActivationFilter(): (event: MouseEvent) => boolean {
  let lastClickAt = -Infinity;
  return ({ detail, timeStamp }) => {
    if (!detail) return true;
    const isFirst = detail < 2 && timeStamp - lastClickAt >= DOUBLE_TAP_MS;
    lastClickAt = timeStamp;
    return isFirst;
  };
}

/** Whether an element, or whatever else an event was aimed at, is part of a marker */
export function isInMarker(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && !!target.closest(".maplibregl-marker");
}

/**
 * The fields that take keys of their own: a text field, where Escape
 * clears what was typed (the search of the flights) and `/` is typed, and
 * a select, whose own list Escape closes and whose options a key picks.
 * Not a slider or a box to tick, which have no use for either: the page's
 * Escape and its `/` (followSearchKey) work there.
 */
export const KEYED_FIELDS =
  "input:not([type=range]):not([type=checkbox]):not([type=radio])," +
  "textarea,select,[contenteditable]";

/** KEYED_FIELDS for the `besides` of isPageEscape */
export const FIELDS = "," + KEYED_FIELDS;

/**
 * Whether `event` is an Escape for what the page has open: not one a
 * listener before has taken, nor one in a popup or on a marker of the map,
 * which close the popup first. `besides` goes on the end of the selectors
 * of those: `,#id` for one more (a select, whose own list it closes), or
 * `:not(.class)` for markers whose Escape it is.
 */
export function isPageEscape(event: KeyboardEvent, besides = ""): boolean {
  const target = event.target;
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !(
      target instanceof Element &&
      target.closest(".maplibregl-popup,.maplibregl-marker" + besides)
    )
  );
}

/**
 * Keep a double click and a double tap on a marker from zooming the map,
 * for every marker there is or will be, and on whatever else `isTarget`
 * finds at the point of the map (a label that opens a popup like its
 * marker does). Returns what takes it back.
 *
 * A `dblclick` of the map can be prevented, which skips the zoom. A double
 * tap has no event to prevent: the zoom is recognised from `touchstart` and
 * `touchend`, and preventing the map's `touchstart` would skip the pan with
 * it, so a drag that starts on a marker would not move the map. Switched
 * off for the length of the touch instead, the recogniser never sees a tap
 * on a marker begin, and the pan is left alone. The map's events come before
 * its gesture handlers see the same DOM event, so both switches are in time.
 * Only a zoom this switched off is switched on again, once the last finger
 * has left.
 *
 * A touch within a double tap of one on a marker counts as on the marker
 * too, and so does the `dblclick` that follows it: the popup the first tap
 * opens pans the map until it shows in full, which can carry the marker
 * out from under the second, and that one would zoom the map beside it.
 * The touches are told by their time, as in createActivationFilter, but
 * the `dblclick` by the touch before it: a busy page hands it over seconds
 * late, and with the time it is handed over.
 *
 * A mouse's double click is told by its first press, for the same pan: a
 * press on a target makes the `dblclick` after it one on the target too,
 * and one beside every target makes it the map's, whatever a touch before
 * had left (a laptop with a touch screen has both). A pen's press counts
 * as a mouse's, a touch's does not: a touch hands one over as well, after
 * it has ended and with the `detail` of 1 WebKit gives every tap, and that
 * one would take the second tap of a double tap off the marker.
 *
 * Left as it is: a tap followed by a press and a drag, MapLibre's zoom with
 * one finger. Its only switch is `touchZoomRotate`, which is the pinch as
 * well, and a pinch with a finger on a marker has to go on working. The
 * gesture is a deliberate one and zooms where the marker is.
 */
export function keepMarkerTapsFromZoom(
  map: MapLibreMap,
  isTarget: (point: Point) => boolean = () => false,
): () => void {
  let switchedOff = false;
  /** When the last touch on a target began */
  let touchedAt = -Infinity;
  /**
   * Whether the last touch was on a target, or within a double tap of one,
   * or the last first press of a mouse
   */
  let onTargetLast = false;
  const onTarget = (e: MapMouseEvent | MapTouchEvent): boolean =>
    isOnMarker(e) || isTarget(e.point);
  const onDoubleClick = (e: MapMouseEvent): void => {
    if (onTarget(e) || onTargetLast) e.preventDefault();
  };
  /** Whether the last press was a mouse's or a pen's, by its pointer event */
  let mouse = false;
  const onPointerDown = (e: PointerEvent): void => {
    mouse = e.pointerType !== "touch";
  };
  const onMouseDown = (e: MapMouseEvent): void => {
    if (mouse && e.originalEvent.detail < 2) onTargetLast = onTarget(e);
  };
  const onTouchStart = (e: MapTouchEvent): void => {
    const at = e.originalEvent.timeStamp;
    if (onTarget(e)) touchedAt = at;
    onTargetLast = at - touchedAt < DOUBLE_TAP_MS;
    if (!onTargetLast || !map.doubleClickZoom.isEnabled()) return;
    map.doubleClickZoom.disable();
    switchedOff = true;
  };
  const switchBackOn = (): void => {
    if (!switchedOff) return;
    switchedOff = false;
    map.doubleClickZoom.enable();
  };
  const onTouchEnd = (e: MapTouchEvent): void => {
    // With a second finger still down the recogniser would come back in
    // the middle of a gesture
    if (e.originalEvent.touches.length === 0) switchBackOn();
  };
  // Before the target of the press hears of it: the marker's own
  const container = map.getCanvasContainer();
  container.addEventListener("pointerdown", onPointerDown, true);
  map.on("mousedown", onMouseDown);
  map.on("dblclick", onDoubleClick);
  map.on("touchstart", onTouchStart);
  map.on("touchend", onTouchEnd);
  map.on("touchcancel", onTouchEnd);
  return () => {
    switchBackOn();
    container.removeEventListener("pointerdown", onPointerDown, true);
    map.off("mousedown", onMouseDown);
    map.off("dblclick", onDoubleClick);
    map.off("touchstart", onTouchStart);
    map.off("touchend", onTouchEnd);
    map.off("touchcancel", onTouchEnd);
  };
}

/**
 * Id of the lowest label layer of the style, the one data layers are
 * inserted below so place names stay readable on top of them. Undefined for
 * a style without labels, which makes `addLayer` put the layer on top.
 */
export function firstSymbolLayerId(map: MapLibreMap): string | undefined {
  return map.getStyle().layers.find((layer) => layer.type === "symbol")?.id;
}

/**
 * Run `apply` with MapLibre's validation of the layers and sources it adds
 * turned off, whether it adds them itself or through the difference a
 * `setStyle` applies. The map validates each of them against a copy of the
 * whole style it serialises anew for every one, so a style of a hundred
 * layers cost a hundred copies of itself: on a phone the swap to the base
 * style went from about 130 to over 400 ms once the 3D ribbons' layers
 * grew, and takes 30 ms without it. `setStyle(..., { validate: false })` alone does not reach them, as
 * the difference adds its layers without passing the option on, and
 * `Map.addLayer` takes none. The app's own layers are validated by a unit
 * test instead (mapLayers.test.ts), and CARTO's style is one MapLibre
 * reads every day.
 */
export function withoutValidation<T>(map: MapLibreMap, apply: () => T): T {
  const style = map.style;
  // A map that has no style yet (the tests' fake has none at all)
  if (!style) return apply();
  const addLayer = style.addLayer.bind(style);
  const addSource = style.addSource.bind(style);
  style.addLayer = (layer, before, options) =>
    addLayer(layer, before, { ...options, validate: false });
  style.addSource = (id, source, options) =>
    addSource(id, source, { ...options, validate: false });
  try {
    return apply();
  } finally {
    // Back to the methods of the style's prototype
    const own: Partial<typeof style> = style;
    delete own.addLayer;
    delete own.addSource;
  }
}

/** Longest a slide of the map beside the rail may take: --duration-base */
const RAIL_SLIDE_MS = 350;

/** The end of the slide under way, by map container */
const railSlides = new WeakMap<HTMLElement, () => void>();

/**
 * Open or close the statistics rail beside the map (`stats-open` on the
 * body) and slide the map along. Sliding it by its `left` edge resized it
 * on every frame of the transition, and each resize is a new drawing
 * buffer for the canvas and a render of the whole map: 7 or 8 of them, and
 * half a second of main thread with the 3D flights on. So for the length
 * of the slide the map keeps the larger of its two sizes, the whole width,
 * and moves by half the rail with a transform, which is where its middle
 * ends up (styles.css, `rail-sliding`). It is resized once: when the rail
 * has opened, and as it starts to close. MapLibre follows the size of its
 * container by itself, and keeps the middle of the map where the middle of
 * the container is, so the view does not jump either time.
 */
export function slideMapBesideRail(
  container: HTMLElement | null,
  open: boolean,
  animate: boolean,
): void {
  const body = document.body;
  if (container) railSlides.get(container)?.();
  if (!container || !animate) {
    body.classList.toggle("stats-open", open);
    return;
  }
  if (open) {
    body.classList.add("stats-open", "rail-sliding");
  } else {
    // The slide starts where the open rail left the map, at the whole
    // width; the style is read so the transform has a start to leave from
    body.classList.add("rail-leaving");
    body.classList.remove("stats-open");
    void getComputedStyle(container).transform;
    body.classList.replace("rail-leaving", "rail-sliding");
  }
  const onEnd = (e: TransitionEvent): void => {
    if (e.target === container && e.propertyName === "transform") end();
  };
  const end = (): void => {
    clearTimeout(timer);
    container.removeEventListener("transitionend", onEnd);
    railSlides.delete(container);
    body.classList.remove("rail-sliding");
  };
  container.addEventListener("transitionend", onEnd);
  // The phone's rail is a sheet over the map, which does not move for it
  const timer = setTimeout(end, RAIL_SLIDE_MS);
  railSlides.set(container, end);
}

/**
 * Pan the map just far enough that an open popup is inside it, `padding`
 * pixels clear of every edge. Leaflet did this by itself (autoPan); MapLibre
 * opens a popup wherever its anchor is, half outside the map if need be.
 * A popup larger than the map is aligned at its top left, where it starts
 * to read. Where the map fills the screen, the edges are those of the safe
 * area, clear of the status bar and the home indicator.
 */
export function panPopupIntoView(
  map: MapLibreMap,
  popup: Popup,
  padding = 16,
  animate = true,
): void {
  if (!popup.isOpen()) return;
  const box = popup.getElement().getBoundingClientRect();
  const frame = map.getContainer().getBoundingClientRect();
  const safe = safeAreaInsets();
  const top = Math.max(frame.top, safe.top);
  const left = Math.max(frame.left, safe.left);
  const right = Math.min(frame.right, window.innerWidth - safe.right);
  const bottom = Math.min(frame.bottom, window.innerHeight - safe.bottom);

  const overflow = (before: number, after: number): number => {
    // The near edge wins when both are out, so the content's start shows
    if (before < 0) return before;
    return after > 0 ? after : 0;
  };
  const dx = overflow(
    box.left - (left + padding),
    box.right - (right - padding),
  );
  const dy = overflow(
    box.top - (top + padding),
    box.bottom - (bottom - padding),
  );
  if (dx === 0 && dy === 0) return;
  if (map.getPitch() === 0 && map.getProjection()?.type !== "globe") {
    map.panBy([dx, dy], { animate });
    return;
  }
  // `panBy` moves the centre by the pixels it is given, and only on a flat
  // map does everything else move as far: tilted by 60 degrees, a popup at
  // the top of the map came down 44 of the 200 pixels asked for. So the
  // place that is now drawn where the popup's own has to go takes the
  // measure: the map moves by what lies between the two.
  const place = popup.getLngLat();
  const at = map.project(place);
  const target = map.unproject([at.x - dx, at.y - dy]);
  const center = map.getCenter();
  map.panTo(
    [
      center.lng + place.lng - target.lng,
      Math.max(-85, Math.min(85, center.lat + place.lat - target.lat)),
    ],
    { animate },
  );
}

/**
 * How many times farther from the camera a place on the ground is than the
 * middle of the map: 1 there, more towards the top of a tilted map, and
 * Infinity at and beyond its horizon. Worked out from where the place is
 * drawn: the ray to it leaves the camera the more steeply the lower it is
 * on the screen, and meets the ground the farther off the flatter it is.
 */
export function cameraDistanceRatio(
  map: MapLibreMap,
  place: { lng: number; lat: number },
): number {
  const pitch = map.getPitch() * DEGREES_TO_RADIANS;
  if (pitch === 0) return 1;
  const fov = map.getVerticalFieldOfView() * DEGREES_TO_RADIANS;
  // The distance from the camera to the screen, in pixels
  const focal = focalLengthPx(mapSize(map).height, fov);
  const centre = map.project(map.getCenter());
  const at = map.project([place.lng, place.lat]);
  // The ray's angle from the ground straight below the camera
  const angle = pitch + Math.atan2(centre.y - at.y, focal);
  if (angle >= Math.PI / 2) return Infinity;
  return Math.cos(pitch) / Math.cos(angle);
}

/** How far off a place may come back from the round trip of `isBehindGlobe` */
const GLOBE_ROUND_TRIP_DEGREES = 0.01;

/**
 * Whether a place is on the far side of the globe. MapLibre knows, and
 * tells nobody: `project` answers for such a place with a point inside the
 * disc, where the near side is drawn. Asked what is at that point, the map
 * names the place on the near side, so a place that does not come back from
 * the round trip is behind the globe. Measured against MapLibre's own
 * verdict: a place in view on the near side comes back within a hundred
 * thousandth of a degree, and of the places behind, only those within a
 * hundredth of a degree of the rim do. A place far outside the map may be
 * called behind when it is not; it is out of sight either way.
 */
export function isBehindGlobe(
  map: MapLibreMap,
  place: { lng: number; lat: number },
): boolean {
  if (map.getProjection()?.type !== "globe") return false;
  const back = map.unproject(map.project([place.lng, place.lat]));
  const turn = Math.abs(back.lng - place.lng) % 360;
  return (
    Math.abs(back.lat - place.lat) > GLOBE_ROUND_TRIP_DEGREES ||
    Math.min(turn, 360 - turn) > GLOBE_ROUND_TRIP_DEGREES
  );
}

/**
 * Close a popup once the place it points at has gone behind the globe.
 * MapLibre leaves it open at the point the place projects to, over another
 * part of the world, with its buttons working.
 */
export function closeWhenBehindGlobe(map: MapLibreMap, popup: Popup): void {
  const check = (): void => {
    if (isBehindGlobe(map, popup.getLngLat())) popup.remove();
  };
  popup.on("open", () => map.on("move", check));
  popup.on("close", () => map.off("move", check));
}

/**
 * How long `withMapStill` waits for the frame it asked for (ms). A map draws
 * within a frame or two; one that has lost its WebGL context never does.
 */
export const MAP_STILL_TIMEOUT_MS = 3000;

/**
 * How long `whenMapComplete` waits for the map to finish drawing (ms)
 * before it settles for what there is
 */
export const MAP_COMPLETE_TIMEOUT_MS = 5000;

/**
 * Resolve once the map has drawn all there is to draw: no tile loading,
 * the `sources` the map has loaded and `drawn` true, which is the heat the
 * year worker still works on (see DataManager.heatRequests). The sources
 * as well: `areTilesLoaded` asks only about the tiles in view, which are
 * all there while the GeoJSON worker still cuts the data `setData` handed
 * it. Checked at once and at every frame, which a tile or a heat that
 * lands asks for. At once only with `loaded` as well: right after a
 * `jumpTo` or an unanimated fit the sources of the new view are only marked
 * to be updated, and the tiles still held are the old view's, all loaded,
 * while `loaded` stays false until a frame has asked for the new ones. In a
 * frame that is done, and `loaded` waits on more than the tiles (the
 * labels' glyphs), which the reveal of Wrapped's far globe is not to wait
 * for. The frames are `render`s, not `idle`, which a map whose heat cloud
 * pulses never reaches. After `timeoutMs` at the latest: a tile that does not load,
 * offline, must not hold the caller for good. At once when `signal` aborts,
 * as for a caller that no longer waits (the close of Wrapped).
 */
export function whenMapComplete(
  map: MapLibreMap,
  drawn: () => boolean,
  sources: readonly string[] = [],
  timeoutMs = MAP_COMPLETE_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const check = (now?: unknown): void => {
      if (
        drawn() &&
        (now !== true || map.loaded()) &&
        map.areTilesLoaded() &&
        sources.every((id) => !map.getSource(id) || map.isSourceLoaded(id))
      ) {
        done();
      }
    };
    const done = (): void => {
      clearTimeout(timer);
      map.off("render", check);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    map.on("render", check);
    signal?.addEventListener("abort", done);
    if (signal?.aborted) done();
    else check(true);
  });
}

/** The maps `withMapStill` is capturing */
const stillMaps = new WeakSet<MapLibreMap>();

/**
 * Whether `withMapStill` is capturing the map: what moves on it by itself,
 * the pulses of the heat cloud, holds still for the frame it takes
 */
export function isMapStill(map: MapLibreMap): boolean {
  return stillMaps.has(map);
}

/**
 * The frame the map draws next, as a PNG data URL. Rejects when no frame
 * comes in time or the canvas cannot be read: a promise that never settled
 * would leave the caller's busy state on for good.
 */
function nextFrameAsDataUrl(map: MapLibreMap): Promise<string> {
  const canvas = map.getCanvas();
  let onRender!: () => void;
  const frame = new Promise<string>((resolve, reject) => {
    onRender = (): void => {
      try {
        resolve(canvas.toDataURL("image/png"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    map.on("render", onRender);
    map.triggerRepaint();
  });
  return withTimeout(
    frame,
    MAP_STILL_TIMEOUT_MS,
    "the map did not draw in time",
  ).finally(() => map.off("render", onRender));
}

/**
 * Run `fn` while the map shows a still image of itself in place of its
 * canvas, and put the canvas back afterwards.
 *
 * html-to-image copies DOM, and a WebGL canvas copied that way is blank: the
 * drawing buffer is cleared once a frame has been presented. It can only be
 * read inside the frame that drew it, so the still is taken in a `render`
 * handler after asking for a repaint. `preserveDrawingBuffer` would make the
 * canvas readable at any time, at a cost every frame pays. Markers and popups
 * are DOM next to the canvas and need no help.
 *
 * With `pixelRatio` the still is drawn at that many device pixels per CSS
 * pixel, so an image exported at 2x from a 1x screen gets a map as sharp as
 * the page around it instead of an enlarged one. The ratio is only ever
 * raised: a screen denser than the export already has the better frame, and
 * a smaller canvas would cost a redraw to make the image softer. MapLibre
 * keeps the canvas within `maxCanvasSize` and what the GPU allocates by
 * lowering the ratio itself, and the still keeps the canvas's CSS size, so
 * a ratio that was not met in full needs no handling here.
 *
 * Changing the ratio resizes the canvas, which clears it. Nothing blank is
 * presented: the frame asked for is drawn before the browser paints again.
 * No tile is loaded for it (tiles do not depend on the ratio), so that one
 * frame is complete and there is no `idle` to wait for. A resize is not free
 * of side effects, though: MapLibre stops the camera, which resets a gesture
 * that is just beginning, and fires `movestart`, `move` and `moveend`
 * without a camera change, once on the way up and once on the way back. The
 * listeners of this app take that in their stride (a saved view is written
 * again, unchanged). That is the reason not to raise a ratio for nothing.
 */
export async function withMapStill<T>(
  map: MapLibreMap,
  fn: () => Promise<T> | T,
  pixelRatio?: number,
): Promise<T> {
  const canvas = map.getCanvas();
  const screenRatio = map.getPixelRatio();
  // Asked now and not when the ratio goes back: a browser zoom or a move to
  // another monitor during the capture changes devicePixelRatio, and the
  // comparison would then pin a map that had been following the screen
  const followsScreen = screenRatio === window.devicePixelRatio;
  // What MapLibre asks for and what the canvas has differ once the canvas
  // hit `maxCanvasSize` or the GPU's limit. A canvas that is already held
  // below the ratio it has cannot get any larger, and raising it would cost
  // two resizes to take the same still.
  const applied =
    canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : screenRatio;
  const clamped = applied < screenRatio * 0.99;
  const raised =
    pixelRatio !== undefined && pixelRatio > screenRatio && !clamped;
  let still: HTMLImageElement | null = null;
  stillMaps.add(map);
  try {
    if (raised) map.setPixelRatio(pixelRatio);
    const dataUrl = await nextFrameAsDataUrl(map);

    still = document.createElement("img");
    still.className = canvas.className;
    still.alt = "";
    // The canvas is sized in CSS pixels by MapLibre; its width and height
    // attributes are device pixels and would blow the image up
    still.width = canvas.clientWidth;
    still.height = canvas.clientHeight;
    still.src = dataUrl;
    // Decoded before the swap, so the capture never sees an empty image. A
    // failure to decode leaves a blank map in the export, which is what there
    // was to show anyway; the swap back below must still happen.
    await still.decode().catch(() => undefined);

    canvas.replaceWith(still);
    return await fn();
  } finally {
    // The ratio goes back while the still is showing, so the canvas returns
    // at the size it had. A map that followed the screen's ratio follows it
    // again (null lifts the override, which the typings leave out): a number
    // would pin it, and the map would stay soft after a browser zoom.
    try {
      if (raised) {
        map.setPixelRatio(
          followsScreen ? (null as unknown as number) : screenRatio,
        );
      }
    } finally {
      // Whatever happened above: a map that was removed during the capture
      // throws on the resize, and the page must not be left showing a still.
      // Does nothing for a still that never made it into the page.
      still?.replaceWith(canvas);
      // A 2x frame of a large monitor is tens of megabytes once decoded
      still?.removeAttribute("src");
      stillMaps.delete(map);
    }
  }
}

/**
 * Value of a CSS custom property on the root element, trimmed. Paint
 * properties of map layers cannot read `var()`, so the tokens of the
 * stylesheet reach the map through here. Empty when the token is not set.
 */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}
