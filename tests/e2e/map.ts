/**
 * Everything the specs know about the map library.
 *
 * The specs say what they want from the map (zoom there, is the heatmap on,
 * how many paths are drawn, where is the popup) and this file says how the
 * library answers: its class names, its layers, its methods. A spec that
 * reaches into `window.mapApp.map` or names a `.maplibregl-*` class itself
 * has to be rewritten with the library; one that goes through here does not.
 *
 * Zoom levels are the ones of saved state and shared links, which count one
 * higher than the map does: they date from a map with 256 pixel tiles, where
 * the same view had a zoom one greater, and old links still have to show the
 * same area. The specs were written in that unit and keep it; `getZoom` and
 * `setZoom` translate (see `stateZoomToMap` in utils/mapHelpers.ts).
 */
import { expect, type Locator, type Page } from "@playwright/test";
import type { GeoJSONSource } from "maplibre-gl";
// Type-only import so the window.mapApp / MAP_CONFIG globals are declared
import type {} from "../../flown/frontend/globals";

/** Matches ZOOM_OFFSET in utils/constants.ts */
const ZOOM_OFFSET = 1;

/* ==========================================================================
   Locators
   ========================================================================== */

/** The map container once the library has taken it over */
const MAP_READY_SELECTOR = "#map.maplibregl-map";

/** What the base map, the overlays and the paths are drawn on */
export function mapSurface(page: Page): Locator {
  return page.locator("#map canvas.maplibregl-canvas");
}

/** The library's own zoom buttons, which the page does not use */
export function zoomControl(page: Page): Locator {
  return page.locator(".maplibregl-ctrl-zoom-in, .maplibregl-ctrl-zoom-out");
}

/** The tile credit */
export function attributionControl(page: Page): Locator {
  return page.locator(".maplibregl-ctrl-attrib");
}

/** Every marker on the map: the airports, and the airplane during a replay */
export function mapMarkers(page: Page): Locator {
  return page.locator(".maplibregl-marker");
}

/**
 * Whether the markers are out of reach of the keyboard and the pointer, as
 * they are while a dialog takes the map over. Every marker has to agree, and
 * there has to be one: a page without markers would pass either way.
 */
export async function expectMarkersInert(
  page: Page,
  inert: boolean,
): Promise<void> {
  const markers = mapMarkers(page);
  expect(await markers.count(), "markers on the map").toBeGreaterThan(0);
  await expect
    .poll(() =>
      markers.evaluateAll((elements) => [
        ...new Set(elements.map((element) => element.hasAttribute("inert"))),
      ]),
    )
    .toEqual([inert]);
}

/** An open popup, frame and all; the hover tooltip of a path is not one */
export function mapPopup(page: Page): Locator {
  return page.locator(".maplibregl-popup:not(.segment-tooltip)");
}

/** The button that closes an open popup */
export function mapPopupCloseButton(page: Page): Locator {
  return mapPopup(page).locator(".maplibregl-popup-close-button");
}

/** The content of an open popup */
export function mapPopupContent(page: Page): Locator {
  return page.locator(".maplibregl-popup-content");
}

/** The details of a segment: a tooltip under a mouse, a popup under a finger */
export function segmentDetails(page: Page): Locator {
  return page.locator(".segment-details .maplibregl-popup-content");
}

/* ==========================================================================
   Readiness and view
   ========================================================================== */

/**
 * Wait until the library has set the map up and it is at rest: a camera
 * call made while the map still moves stops that movement, so a spec that
 * positions the map has to start from a map that stands still. The specs
 * run with reduced motion, which turns the map's animations off; the check
 * keeps a spec that turns it back on safe.
 */
export async function waitForMapReady(page: Page): Promise<void> {
  await page.waitForSelector(MAP_READY_SELECTOR, { timeout: 15000 });
  await page.waitForFunction(
    () => {
      const map = window.mapApp?.map;
      return !!map && !map.isMoving();
    },
    undefined,
    { timeout: 20000 },
  );
}

/**
 * Wait until the map has drawn what it was given: sources are handed to a
 * worker (the heat sources to the year worker first, see heatRequests in
 * ui/dataManager.ts), so data set a moment ago is not on the canvas, and
 * cannot be hit by a pointer, until the map has loaded it and stands
 * still. In CI it took up to 10.6 s in WebKit and 4.5 s in Chromium, so it
 * is given about three times as long.
 */
async function waitForMapIdle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const app = window.mapApp;
      const map = app?.map;
      // The heat sources are given their data once the year worker has
      // written it, and the map is idle meanwhile
      return (
        !!map &&
        map.loaded() &&
        !map.isMoving() &&
        !app?.dataManager?.heatRequests
      );
    },
    undefined,
    { timeout: 30000 },
  );
}

/**
 * Whether the map has drawn everything it was given and stands still, for a
 * spec that polls for it with a timeout of its own (see waitForMapIdle)
 */
export function mapIsIdle(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    const map = app.map!;
    return map.loaded() && !map.isMoving() && !app.dataManager.heatRequests;
  });
}

/**
 * Wait for the next `idle` of the map: a frame after which it has nothing
 * left to do, no tile to load, no move, no paint transition and no label
 * placement. mapIsIdle passes before the paint transitions end, such as
 * the ribbons of the 3D view being shown once their tiles are in
 * (settleRibbons in ui/terrain.ts). For a snapshot of the canvas, after
 * mapIsIdle, which bounds the wait.
 */
export function waitForMapIdleEvent(page: Page): Promise<void> {
  return page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const map = window.mapApp!.map!;
        map.once("idle", () => resolve());
        map.triggerRepaint();
      }),
  );
}

export function getZoom(page: Page): Promise<number> {
  return page.evaluate(
    (offset) => window.mapApp!.map!.getZoom() + offset,
    ZOOM_OFFSET,
  );
}

export function getCenter(page: Page): Promise<{ lat: number; lng: number }> {
  return page.evaluate(() => {
    const { lat, lng } = window.mapApp!.map!.getCenter();
    return { lat, lng };
  });
}

/**
 * Turn the wheel over the middle of the map, the way a user zooms in. The
 * zoom starts a frame later, so the caller polls `getZoom` for the answer.
 */
export async function wheelZoomIn(page: Page): Promise<void> {
  const box = await mapSurface(page).boundingBox();
  if (!box) throw new Error("the map is not on the page");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
}

/** Zoom around the centre without animating, and wait until the map is there */
export async function setZoom(page: Page, zoom: number): Promise<void> {
  await page.evaluate((z) => {
    window.mapApp!.map!.jumpTo({ zoom: z });
  }, zoom - ZOOM_OFFSET);
  await expect.poll(() => getZoom(page)).toBe(zoom);
  await waitForMapIdle(page);
}

/** Move the map to a coordinate without animating, and wait until it is there */
export async function setView(
  page: Page,
  at: readonly [number, number],
  zoom: number,
): Promise<void> {
  await jumpToView(page, at, zoom);
  await waitForMapIdle(page);
}

/**
 * Move the map like setView, but only wait for the view to arrive, not for
 * everything in it to be drawn. For a spec that polls for what it asserts:
 * the relief of the 3D view draws a frame in about a second in software
 * WebGL on a loaded machine, and idle waits for every source, the base map
 * and the heat included, which takes a frame or more per tile in view.
 */
export async function jumpToView(
  page: Page,
  [lat, lng]: readonly [number, number],
  zoom: number,
  { timeout = 15000 }: { timeout?: number } = {},
): Promise<void> {
  const view = { lat, lng, zoom: zoom - ZOOM_OFFSET };
  await page.evaluate((to) => {
    window.mapApp!.map!.jumpTo({ center: [to.lng, to.lat], zoom: to.zoom });
  }, view);
  // Arrived means in the middle of the map, to the pixel at that zoom,
  // which holds at every zoom where a fixed tolerance in degrees does not.
  // Asked of the camera rather than of `project`: over the relief of the
  // 3D view the map raises its centre onto the elevation tiles as they
  // land, and until then the point in the middle is drawn a little off it.
  await page.waitForFunction(
    (to) => {
      const map = window.mapApp!.map!;
      if (map.getZoom() !== to.zoom) return false;
      const center = map.getCenter();
      // Degrees of longitude a pixel spans; of latitude, fewer by the cosine
      const pixel = 360 / (512 * 2 ** to.zoom);
      return (
        Math.abs(center.lng - to.lng) <= pixel &&
        Math.abs(center.lat - to.lat) <=
          pixel * Math.cos((to.lat * Math.PI) / 180)
      );
    },
    view,
    // The camera is there as soon as jumpTo returns, but a page cutting
    // the flights anew for the relief on a loaded machine may not draw a
    // frame for seconds, so the predicate is asked on a timer rather than
    // once a frame (the default of waitForFunction)
    { timeout, polling: 250 },
  );
}

/** How the map is turned, tilted and projected */
export interface MapOrientation {
  /** Degrees the top of the map is turned from north, -180 to 180 */
  bearing: number;
  /** Degrees the map is tilted, 0 for flat */
  pitch: number;
  projection: "mercator" | "globe";
}

/**
 * The angles come rounded to a millionth of a degree: the map keeps them in
 * radians, and 120.26 degrees comes back as 120.26000000000002.
 */
export function getOrientation(page: Page): Promise<MapOrientation> {
  return page.evaluate(() => {
    const map = window.mapApp!.map!;
    const rounded = (degrees: number): number =>
      Math.round(degrees * 1e6) / 1e6 || 0;
    return {
      bearing: rounded(map.getBearing()),
      pitch: rounded(map.getPitch()),
      // A style names no projection until one is set, and means Mercator
      projection: map.getProjection()?.type === "globe" ? "globe" : "mercator",
    };
  });
}

/**
 * Turn and tilt the map without animating, the way a finished gesture leaves
 * it, and wait until it is there. The events a gesture fires come with it.
 * `idle: false` skips waiting for the tiles of the new view, for a spec that
 * only needs the orientation: in a 3D view out on the globe that is dozens
 * of elevation tiles, each shaded in software WebGL on CI.
 */
export async function setOrientation(
  page: Page,
  { bearing, pitch }: { bearing: number; pitch: number },
  { idle = true }: { idle?: boolean } = {},
): Promise<void> {
  // `jumpTo` is synchronous, so the orientation is read in the same call
  // rather than polled for: on CI a page drawing the 3D view took longer to
  // answer a second call than the poll waited. Not `jumpTo`'s own return
  // value, the map, which Playwright would copy out of the page with all its
  // tiles and buffers (seconds on CI).
  const turned = await page.evaluate(
    (to) => {
      const map = window.mapApp!.map!;
      map.jumpTo(to);
      const rounded = (degrees: number): number =>
        Math.round(degrees * 1e6) / 1e6 || 0;
      return {
        bearing: rounded(map.getBearing()),
        pitch: rounded(map.getPitch()),
      };
    },
    { bearing, pitch },
  );
  expect(turned).toEqual({ bearing, pitch });
  if (idle) await waitForMapIdle(page);
}

/**
 * Turn the map the way a mouse does: a drag with the right button. Returns
 * once the button is up; the caller polls `getOrientation` for the answer.
 */
export async function dragRotate(page: Page, pixels: number): Promise<void> {
  const box = await mapSurface(page).boundingBox();
  if (!box) throw new Error("the map is not on the page");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(x + pixels, y, { steps: 8 });
  await page.mouse.up({ button: "right" });
}

/**
 * Turn the map the way two fingers do: both on the map, a hand's width
 * apart, twisting round the middle between them. Chromium only, which is
 * where the touch events can be sent from (the devtools protocol).
 */
export async function twistRotate(page: Page, degrees: number): Promise<void> {
  const box = await mapSurface(page).boundingBox();
  if (!box) throw new Error("the map is not on the page");
  const middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const radius = 90;
  const fingers = (turned: number): { x: number; y: number; id: number }[] => {
    const radians = (turned * Math.PI) / 180;
    const dx = Math.cos(radians) * radius;
    const dy = Math.sin(radians) * radius;
    return [
      { x: middle.x + dx, y: middle.y + dy, id: 0 },
      { x: middle.x - dx, y: middle.y - dy, id: 1 },
    ];
  };
  const client = await page.context().newCDPSession(page);
  const steps = 12;
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: fingers(0),
  });
  for (let step = 1; step <= steps; step++) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: fingers((degrees * step) / steps),
    });
  }
  await client.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await client.detach();
}

/** The library's own compass and globe buttons, which the page does not use */
export function libraryOrientationControls(page: Page): Locator {
  return page.locator(".maplibregl-ctrl-compass, .maplibregl-ctrl-globe");
}

/** Markers the globe hides because they are on its far side */
export function coveredMarkers(page: Page): Locator {
  return page.locator(".maplibregl-marker.maplibregl-marker-covered");
}

/** Where a coordinate is drawn, in CSS pixels from the map's top left corner */
export function containerPoint(
  page: Page,
  [lat, lng]: readonly [number, number],
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    (at) => {
      const point = window.mapApp!.map!.project([at.lng, at.lat]);
      return { x: point.x, y: point.y };
    },
    { lat, lng },
  );
}

/**
 * Take the map's own drawing out of the picture, base map, paths, markers
 * and popups alike, and leave the page's chrome. Masking them is not an
 * option, because the canvas fills the viewport, so a mask over it covers
 * the controls as well. The map keeps its own background, so the layout
 * below it is unchanged.
 *
 * Through a constructed stylesheet rather than a <style> tag: the page's CSP
 * allows no inline style, and CSSOM stylesheets are not inline.
 */
export async function hideMapData(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      ".maplibregl-canvas, .maplibregl-marker, .maplibregl-popup " +
        "{ visibility: hidden !important; }",
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
}

/**
 * The other way round: take the page's chrome out of the picture, the
 * map's own controls (its credit) included, and leave the map's drawing
 * and its markers, for a snapshot of the map. Hidden rather than masked:
 * a mask takes the size of what it covers, so the snapshot would change
 * with the chrome. Through a constructed stylesheet, as above.
 */
export async function hideChrome(page: Page): Promise<void> {
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(
      "body > :not(main), main > :not(#map), " +
        "#map .maplibregl-control-container " +
        "{ visibility: hidden !important; }",
    );
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  });
}

/** An image the map put in place of its canvas, as it was when it appeared */
export interface MapStill {
  /** Pixels of the image itself */
  naturalWidth: number;
  naturalHeight: number;
  /** CSS pixels it is laid out at */
  width: number;
  height: number;
}

/**
 * Watch for the stills an export swaps in for the canvas, which are gone
 * again by the time the download arrives. Call the result once the export is
 * over. Seen from outside through a MutationObserver, so the app exposes
 * nothing for it.
 */
export async function watchMapStills(
  page: Page,
): Promise<() => Promise<MapStill[]>> {
  const stills = await page.evaluateHandle(() => {
    const seen: MapStill[] = [];
    const container = document.querySelector(
      "#map .maplibregl-canvas-container",
    );
    if (!container) throw new Error("the map has no canvas container");
    new MutationObserver((records) => {
      for (const node of records.flatMap((r) => [...r.addedNodes])) {
        if (!(node instanceof HTMLImageElement)) continue;
        const { naturalWidth, naturalHeight, width, height } = node;
        seen.push({ naturalWidth, naturalHeight, width, height });
      }
    }).observe(container, { childList: true });
    return seen;
  });
  return () => stills.jsonValue();
}

/** Size of the map's drawing surface, in device pixels and in CSS pixels */
export function mapSurfaceSize(
  page: Page,
): Promise<{ pixelWidth: number; width: number }> {
  return mapSurface(page).evaluate((canvas: HTMLCanvasElement) => ({
    pixelWidth: canvas.width,
    width: canvas.clientWidth,
  }));
}

/* ==========================================================================
   Requests

   The map fetches its style and its tiles itself, so none of them is an
   element a spec could find. What the page asked for is in the browser's
   resource timing, requests answered by the fixture included.
   ========================================================================== */

function requestedUrls(page: Page, host: string): Promise<string[]> {
  return page.evaluate(
    (hostname) =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => new URL(url).hostname.endsWith(hostname)),
    host,
  );
}

/** The request for the base map's style, which carries the API key */
export async function baseMapStyleRequest(page: Page): Promise<URL> {
  const host = "basemaps.cartocdn.com";
  await expect
    .poll(async () => (await requestedUrls(page, host)).length)
    .toBeGreaterThan(0);
  const urls = await requestedUrls(page, host);
  return new URL(urls.find((url) => url.includes("style.json")) ?? urls[0]!);
}

/** Requests for tiles of the open flightmaps aviation overlay so far */
function aviationTileRequests(page: Page): Promise<string[]> {
  return requestedUrls(page, "nwy-tiles-api.prod.newaydata.com");
}

/**
 * Zoom in far enough for the aviation overlay, which starts at zoom 7, and
 * wait for its tiles. They have to ask for the aeronautical layer of the
 * current AIRAC cycle.
 */
export async function expectAviationTiles(page: Page): Promise<void> {
  await setZoom(page, 8);
  await expect
    .poll(async () => (await aviationTileRequests(page)).length)
    .toBeGreaterThan(0);
  const tile = new URL((await aviationTileRequests(page))[0]!);
  expect(tile.searchParams.get("path")).toBe("latest/aero/latest");
}

/* ==========================================================================
   Airports
   ========================================================================== */

/** Where an airport's marker stands */
export function airportPosition(
  page: Page,
  name: string,
): Promise<[number, number]> {
  return page.evaluate((airport) => {
    const { lat, lng } = window.mapApp!.airportMarkers[airport]!.getLatLng();
    return [lat, lng] as [number, number];
  }, name);
}

/** Centre the map on an airport's marker */
export async function centerOnAirport(
  page: Page,
  name: string,
  zoom: number,
): Promise<void> {
  await setView(page, await airportPosition(page, name), zoom);
}

/** Give an airport's marker the keyboard focus */
export function focusAirportMarker(page: Page, name: string): Promise<void> {
  return page.evaluate((airport) => {
    window.mapApp!.airportMarkers[airport]!.getControl().focus();
  }, name);
}

export function airportMarkerIsFocused(
  page: Page,
  name: string,
): Promise<boolean> {
  return page.evaluate(
    (airport) =>
      document.activeElement ===
      window.mapApp!.airportMarkers[airport]!.getControl(),
    name,
  );
}

/** The middle of an airport's marker, in viewport coordinates */
export function airportMarkerCenter(
  page: Page,
  name: string,
): Promise<{ x: number; y: number }> {
  return page.evaluate((airport) => {
    const box = window
      .mapApp!.airportMarkers[airport]!.getElement()
      .getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, name);
}

/**
 * Count the airport popups taken out of the page from now on. Moving the
 * open popup to another airport must not close it in between, which would
 * flicker; the popup is the library's element, so this is watched here.
 * Call the result for the count so far.
 */
export async function watchPopupRemovals(
  page: Page,
): Promise<() => Promise<number>> {
  const removals = await page.evaluateHandle(() => {
    const seen = { count: 0 };
    new MutationObserver((records) => {
      for (const node of records.flatMap((r) => [...r.removedNodes])) {
        if (
          node instanceof Element &&
          node.matches(".maplibregl-popup:not(.segment-tooltip)")
        ) {
          seen.count++;
        }
      }
    }).observe(window.mapApp!.map!.getContainer(), {
      childList: true,
      subtree: true,
    });
    return seen;
  });
  return async () => (await removals.jsonValue()).count;
}

/** Open an airport's popup the way the app does, without a pointer */
export function openAirportPopup(page: Page, name: string): Promise<void> {
  return page.evaluate((airport) => {
    window.mapApp!.airportMarkers[airport]!.openPopup();
  }, name);
}

/**
 * Put replay's airplane under the close button of the open popup and expect
 * the button to be what a pointer there reaches. The two are siblings in one
 * stacking context; an airplane that wins covers the popup and takes the
 * clicks meant for its controls. Asked of the page as it is laid out, so it
 * holds whatever the stylesheets call the rules that decide it.
 */
export async function expectPopupAboveAirplane(page: Page): Promise<void> {
  const button = mapPopupCloseButton(page);
  await expect(button).toBeVisible();
  const box = (await button.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.evaluate((viewportPoint) => {
    const app = window.mapApp!;
    const frame = app.map!.getContainer().getBoundingClientRect();
    const { lat, lng } = app.map!.unproject([
      viewportPoint.x - frame.left,
      viewportPoint.y - frame.top,
    ]);
    app.replayState.airplaneMarker!.setLatLng([lat, lng]);
  }, at);
  // The airplane is where the button is, or the check below says nothing
  const airplane = (await page.locator(".replay-airplane-root").boundingBox())!;
  expect(airplane.x).toBeLessThan(at.x);
  expect(airplane.x + airplane.width).toBeGreaterThan(at.x);
  expect(airplane.y).toBeLessThan(at.y);
  expect(airplane.y + airplane.height).toBeGreaterThan(at.y);

  const reached = await page.evaluate(
    ({ x, y }) =>
      document.elementFromPoint(x, y)?.closest(".maplibregl-popup") !== null,
    at,
  );
  expect(reached, "the popup is what a pointer on its button reaches").toBe(
    true,
  );
}

/* ==========================================================================
   Layers
   ========================================================================== */

export type ColorLayer = "altitude" | "airspeed";

/** One piece of path as the map draws it: a feature and its layer's paint */
interface DrawnPath {
  color: string;
  weight: number;
}

/**
 * The pieces of path a colour layer draws, in drawing order, read from the
 * map: the features of the sources of the handle's layers that the layer's
 * filter lets through, with the colour and width of its paint. Hidden layers
 * draw nothing. Read once the map is idle, so the sources hold what the app
 * handed them last and the paint is applied.
 *
 * From the sources' data and not from `querySourceFeatures`: that answers for
 * the tiles in view only, cut up at their edges, so the count would follow
 * the camera. A source given a Blob URL (the lines of every flight, which
 * the year worker writes) is read from that URL: getData() of one never
 * answers (see scripts/vendor.js). Only the filter shapes the app writes
 * are understood; anything else throws rather than counting wrong.
 */
async function drawnPaths(page: Page, layer: ColorLayer): Promise<DrawnPath[]> {
  await waitForMapIdle(page);
  return page.evaluate(async (mode) => {
    type Properties = Record<string, unknown>;
    const evaluate = (expression: unknown, properties: Properties): unknown => {
      if (!Array.isArray(expression)) return expression;
      const [op, ...args] = expression as [string, ...unknown[]];
      switch (op) {
        case "literal":
          return args[0];
        case "get":
          return properties[String(args[0])];
        case "!":
          return !evaluate(args[0], properties);
        case "in": {
          const list = evaluate(args[1], properties);
          if (!Array.isArray(list)) throw new Error("`in` needs a list");
          return list.includes(evaluate(args[0], properties));
        }
        default:
          throw new Error(`the driver does not know the expression "${op}"`);
      }
    };

    const app = window.mapApp!;
    const map = app.map!;
    const drawn: { color: string; weight: number }[] = [];
    for (const id of app[`${mode}Layer`].ids) {
      const style = map.getLayer(id);
      if (!style) throw new Error(`no layer "${id}" on the map`);
      // The paths as lines; the ribbons of the 3D view are the same runs,
      // in sources of their own
      if (style.type !== "line") continue;
      if (map.getLayoutProperty(id, "visibility") === "none") continue;
      const source = map.getSource(style.source);
      if (source?.type !== "geojson") throw new Error(`"${id}" is not GeoJSON`);
      const { data: url } = (source as GeoJSONSource).serialize();
      const data =
        typeof url === "string"
          ? ((await (await fetch(url)).json()) as GeoJSON.GeoJSON)
          : await (source as GeoJSONSource).getData();
      if (data.type !== "FeatureCollection") {
        throw new Error(`the source of "${id}" is not a FeatureCollection`);
      }
      const filter: unknown = map.getFilter(id);
      const color: unknown = map.getPaintProperty(id, "line-color");
      const weight: unknown = map.getPaintProperty(id, "line-width");
      if (typeof weight !== "number") throw new Error(`"${id}": width`);
      for (const feature of data.features) {
        const properties = feature.properties ?? {};
        if (filter != null && evaluate(filter, properties) !== true) continue;
        drawn.push({ color: String(evaluate(color, properties)), weight });
      }
    }
    return drawn;
  }, layer);
}

/**
 * Options for `expect.poll` over pathCount, pathColors and pathWeights. Each
 * call first waits for the map to be idle (up to 15 s, waitForMapIdle), so a
 * poll with the default 5 s gave up before one call had answered on a slow
 * engine: WebKit in software WebGL did in CI.
 */
export const PATH_POLL = { timeout: 20000 };

/** How many pieces of path a colour layer has drawn */
export async function pathCount(
  page: Page,
  layer: ColorLayer,
): Promise<number> {
  return (await drawnPaths(page, layer)).length;
}

/**
 * How many pieces of ribbon a colour layer has written for the 3D view,
 * where its lines are empty (pathCount): the runs of a flight are ribbons
 * there, in sources of their own, and only around the view once zoomed in.
 * Read from the sources' data like drawnPaths, without the filter.
 */
export function ribbonCount(page: Page, layer: ColorLayer): Promise<number> {
  return page.evaluate(async (mode) => {
    const app = window.mapApp!;
    const map = app.map!;
    let count = 0;
    for (const id of app[`${mode}Layer`].ids) {
      const style = map.getLayer(id);
      if (style?.type !== "fill-extrusion") continue;
      if (map.getLayoutProperty(id, "visibility") === "none") continue;
      const source = map.getSource(style.source);
      if (source?.type !== "geojson") throw new Error(`"${id}" is not GeoJSON`);
      const data = await (source as GeoJSONSource).getData();
      if (data.type === "FeatureCollection") count += data.features.length;
    }
    return count;
  }, layer);
}

/** Stroke colour of every piece of path in a colour layer, in drawing order */
export async function pathColors(
  page: Page,
  layer: ColorLayer,
): Promise<string[]> {
  return (await drawnPaths(page, layer)).map((path) => path.color);
}

/** Stroke width of every piece of path in a colour layer, in drawing order */
export async function pathWeights(
  page: Page,
  layer: ColorLayer,
): Promise<number[]> {
  return (await drawnPaths(page, layer)).map((path) => path.weight);
}

/**
 * Whether the layers of a handle are shown, read from the map and not from
 * the handle: a handle that wrote to the wrong layer would still call itself
 * visible. A handle with some layers shown and some hidden is broken either
 * way, and throws.
 */
function layersOnMap(
  page: Page,
  handle: "heatmapLayer" | "aviationLayer" | "selectionHighlightLayer",
): Promise<boolean> {
  return page.evaluate((name) => {
    const app = window.mapApp!;
    const map = app.map!;
    const ids = app[name].ids;
    const shown = ids.filter((id) => {
      if (!map.getLayer(id)) throw new Error(`no layer "${id}" on the map`);
      // Unset means visible, the default of the style
      return map.getLayoutProperty(id, "visibility") !== "none";
    });
    if (shown.length !== 0 && shown.length !== ids.length) {
      throw new Error(
        `${name}: only ${shown.join(", ")} of ${ids.join(", ")} shown`,
      );
    }
    return ids.length > 0 && shown.length === ids.length;
  }, handle);
}

/** Whether the heatmap is on the map right now */
export function heatmapOnMap(page: Page): Promise<boolean> {
  return layersOnMap(page, "heatmapLayer");
}

/**
 * The heat cloud of the 3D view (ui/heatCloud.ts): whether its layer is on
 * the map, whether the flat heatmap steps aside for it, how many stretches
 * it drew in the last frame the map drew, and how strongly it drew its
 * pulses and the marks of the way flown there (see markStrength), which a
 * layer of shaders of its own tells rather than the map
 */
export function heatCloudOnMap(page: Page): Promise<{
  onMap: boolean;
  stepsIn: boolean;
  drawn: number;
  pulses: number;
  marks: number;
}> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    const layer = app.map!.getLayer("heat-cloud") as
      | {
          implementation?: { drawn: number; pulses: number; marks: number };
        }
      | undefined;
    const cloud = layer?.implementation;
    return {
      onMap: !!layer,
      stepsIn: app.store.get("heatCloud"),
      drawn: cloud?.drawn ?? 0,
      pulses: cloud?.pulses ?? 0,
      marks: cloud?.marks ?? 0,
    };
  });
}

/**
 * The home field: where the airport marker is of the airport most flights
 * start or end at
 */
export async function homeField(page: Page): Promise<[number, number]> {
  const name = await page.evaluate(
    () =>
      Object.entries(window.mapApp!.airportToPaths).sort(
        (a, b) => b[1].size - a[1].size,
      )[0]![0],
  );
  return airportPosition(page, name);
}

/** How much of the middle of the map glows, as canvasGlow reads it */
export interface CanvasGlow {
  /** The part of its pixels in the colours of the heat, from 0 to 1 */
  glow: number;
  /** Their mean luminance, from 0 to 255 */
  luminance: number;
}

/**
 * Read the middle of the map (half its width and half its height) off the
 * canvas, in the next frame the map draws, and say how much of it glows in
 * the colours of the heat: blue, cyan or white, where the blue is well
 * above the red and the green is not below it. The flights the colour
 * layers draw are purple to orange, and the ground is grey.
 *
 * The canvas keeps no frame (the map has no preserveDrawingBuffer), so it
 * is read as the image export reads it (withMapStill in mapHelpers.ts): in
 * the `render` event of a frame asked for, before the browser presents it
 * and clears the buffer. That is the frame as drawn, whatever the layers
 * report of themselves: a custom layer counts what it asked GL to draw,
 * not what landed on the screen.
 */
export function canvasGlow(page: Page): Promise<CanvasGlow> {
  return page.evaluate(async () => {
    const map = window.mapApp!.map!;
    const canvas = map.getCanvas();
    const url = await new Promise<string>((resolve, reject) => {
      map.once("render", () => {
        try {
          resolve(canvas.toDataURL("image/png"));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
      map.triggerRepaint();
    });
    const image = new Image();
    image.src = url;
    await image.decode();
    const copy = document.createElement("canvas");
    copy.width = image.naturalWidth;
    copy.height = image.naturalHeight;
    const context = copy.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(
      Math.round(copy.width / 4),
      Math.round(copy.height / 4),
      Math.round(copy.width / 2),
      Math.round(copy.height / 2),
    );
    let glowing = 0;
    let luminance = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
      luminance += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (b >= 64 && b - r >= 32 && g >= r) glowing++;
    }
    const pixels = data.length / 4;
    return { glow: glowing / pixels, luminance: luminance / pixels };
  });
}

/**
 * Whether the airport markers are on the map right now. They are DOM, and
 * what hides them all is a class on the map (AIRPORTS_HIDDEN_CLASS in
 * mapLayers.ts), with a rule of the stylesheet behind it.
 */
export function airportsOnMap(page: Page): Promise<boolean> {
  return page.evaluate(
    () =>
      !window.mapApp!.map!.getContainer().classList.contains("airports-hidden"),
  );
}

/** Whether the aviation overlay is on the map right now */
export function aviationOnMap(page: Page): Promise<boolean> {
  return layersOnMap(page, "aviationLayer");
}

/**
 * Whether the satellite imagery is on the map right now, and its tiles have
 * been asked for. Its layer only exists once the switch has first been on
 * (ui/satellite.ts).
 */
export async function satelliteOnMap(page: Page): Promise<boolean> {
  const shown = await page.evaluate(() => {
    const map = window.mapApp!.map!;
    return (
      !!map.getLayer("satellite") &&
      map.getLayoutProperty("satellite", "visibility") !== "none"
    );
  });
  return shown && (await requestedUrls(page, "tiles.maps.eox.at")).length > 0;
}

/**
 * The lines of a selection over the heatmap: whether they are on the map,
 * and how many lines their source was handed. Read once the map is idle.
 */
export async function selectionHighlightOnMap(
  page: Page,
): Promise<{ shown: boolean; lines: number }> {
  await waitForMapIdle(page);
  const shown = await layersOnMap(page, "selectionHighlightLayer");
  const lines = await page.evaluate(async () => {
    const app = window.mapApp!;
    const map = app.map!;
    const layer = map.getLayer(app.selectionHighlightLayer.ids[0]!)!;
    const source = map.getSource(layer.source) as GeoJSONSource;
    const data = await source.getData();
    return data.type === "FeatureCollection" ? data.features.length : 0;
  });
  return { shown, lines };
}

/**
 * How strongly the heatmap is drawn, from 0 to 1, before it fades out for
 * the heat lines (HEAT_LINES in constants.ts). The opacity is an
 * interpolation over the zoom whose first stop is that strength.
 */
export function heatmapOpacity(page: Page): Promise<number> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    const opacity: unknown = app.map!.getPaintProperty(
      app.heatmapLayer.ids[0]!,
      "heatmap-opacity",
    );
    if (typeof opacity === "number") return opacity;
    if (Array.isArray(opacity) && typeof opacity[4] === "number") {
      return opacity[4];
    }
    return 1;
  });
}

/** The heatmap is on the map and has points to draw */
export async function expectHeatmapPainted(page: Page): Promise<void> {
  expect(await heatmapOnMap(page)).toBe(true);
  await waitForMapIdle(page);
  const points = await page.evaluate(() => {
    const app = window.mapApp!;
    const layer = app.map!.getLayer(app.heatmapLayer.ids[0]!)!;
    return app.map!.querySourceFeatures(layer.source).length;
  });
  expect(points).toBeGreaterThan(0);
}

/** What the map holds of the flights, and where among its layers */
export interface FlightsOnMap {
  /** Every layer of the style, bottom to top */
  layers: string[];
  /** The app's layers as the map reports them: layout, paint and filter */
  looks: unknown[];
  /**
   * Features per GeoJSON source of the app, as handed to the map: as data,
   * or as the text behind a Blob URL
   */
  features: Record<string, number>;
  /** Features of the heat and the altitude source in the tiles in view */
  drawn: { heat: number; paths: number };
}

/**
 * Read the flights back from the map itself, once it has drawn them. The
 * sources are remembered on the first call, and a later one fails when the
 * map has made any of them anew: a source that was replaced has lost the
 * tiles it had and whatever `setData` was on its way to it.
 */
export async function flightsOnMap(page: Page): Promise<FlightsOnMap> {
  await waitForMapIdle(page);
  return page.evaluate(async () => {
    const app = window.mapApp!;
    const map = app.map!;
    const style = map.getStyle();
    const own = [
      ...app.aviationLayer.ids,
      ...app.heatmapLayer.ids,
      ...app.selectionHighlightLayer.ids,
      "replay-route",
      ...app.altitudeLayer.ids,
      ...app.airspeedLayer.ids,
      "replay-trail",
    ];
    const kept = window as unknown as { flightSources?: unknown[] };
    const sources = own.map((id) => map.getSource(map.getLayer(id)!.source));
    kept.flightSources ??= sources;
    if (kept.flightSources.some((source, i) => source !== sources[i])) {
      throw new Error("the map has replaced a source of the flights");
    }
    const features: Record<string, number> = {};
    for (const [id, source] of Object.entries(style.sources)) {
      if (source.type !== "geojson" || !own.includes(id)) continue;
      const data = (
        typeof source.data === "string"
          ? await (await fetch(source.data)).json()
          : source.data
      ) as GeoJSON.FeatureCollection;
      features[id] = data.features.length;
    }
    return {
      layers: style.layers.map((layer) => layer.id),
      looks: style.layers.filter((layer) => own.includes(layer.id)),
      features,
      drawn: {
        heat: map.querySourceFeatures(app.heatmapLayer.ids[0]!).length,
        paths: map.querySourceFeatures(app.altitudeLayer.ids[0]!).length,
      },
    };
  });
}

/**
 * The heatmap and the coloured paths are layers of one style, drawn in the
 * order they are listed in. The heat has to come first, or it paints over
 * the paths.
 */
export async function expectHeatUnderPaths(page: Page): Promise<void> {
  const order = await page.evaluate(() => {
    const app = window.mapApp!;
    const ids = app.map!.getStyle().layers.map((layer) => layer.id);
    const index = (id: string): number => ids.indexOf(id);
    return {
      heat: app.heatmapLayer.ids.map(index),
      paths: [...app.altitudeLayer.ids, ...app.airspeedLayer.ids].map(index),
    };
  });
  expect(order.heat.every((at) => at >= 0)).toBe(true);
  expect(order.paths.every((at) => at >= 0)).toBe(true);
  expect(
    Math.max(...order.heat),
    "the heatmap paints over the paths",
  ).toBeLessThan(Math.min(...order.paths));
}
