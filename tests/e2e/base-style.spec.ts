/**
 * The base map's style is fetched behind the flights' back: the map starts
 * on a plain background, the flights are drawn on it at once, and CARTO's
 * style goes under them whenever it answers, if it ever does.
 */
import {
  BASE_STYLE_LABELS,
  expect,
  failBaseStyle,
  HEAVY,
  holdBaseStyle,
  holdElevationTiles,
  test,
  type Page,
} from "./fixtures";
import {
  activateReplay,
  attachErrorCollectors,
  findSegmentFarFromAirports,
  firstPathId,
  gotoApp,
  playUntilProgress,
  relevantConsoleErrors,
  toastMessage,
  toggleLayer,
  togglePathSelection,
  waitForPathData,
} from "./helpers";
import {
  attributionControl,
  expectHeatmapPainted,
  flightsOnMap,
  ribbonCount,
  segmentDetails,
} from "./map";
import { BASE_STYLE_UNAVAILABLE_MESSAGE } from "../../flown/frontend/baseStyle";

/** The layers of the flights, bottom to top (MAP_LAYERS in constants.ts) */
const FLIGHT_LAYERS = [
  "aviation",
  "heat",
  "heat-isolated",
  "heat-lines-glow",
  "heat-lines-core",
  "selection-highlight",
  "replay-route",
  "paths-altitude",
  "paths-airspeed",
  "paths-altitude-selected",
  "paths-airspeed-selected",
  "replay-trail",
  "paths-altitude-3d",
  "paths-airspeed-3d",
  "paths-altitude-selected-3d",
  "paths-airspeed-selected-3d",
  "selection-highlight-3d",
  "replay-trail-3d",
];

/**
 * The room of the airport codes and of their dots, invisible labels on top
 * of all that the place names give way to (ui/airportLabels.ts)
 */
const AIRPORT_LABELS = ["airport-labels", "airport-dots"];

/** Flights on the map in every way the app changes a layer at runtime */
async function drawFlights(page: Page): Promise<void> {
  await gotoApp(page);
  await waitForPathData(page);
  await expectHeatmapPainted(page);
  // A selection fills a second source and dims the layer of the others
  await togglePathSelection(page, await firstPathId(page), 1);
  await toggleLayer(page, "aviation");
}

async function expectSegmentUnderPointer(page: Page): Promise<void> {
  const at = await findSegmentFarFromAirports(page);
  expect(at).not.toBeNull();
  await page.mouse.move(at!.x, at!.y);
  await expect(segmentDetails(page).first()).toBeVisible();
}

test.describe("Base style", () => {
  test("arrives late: the flights are there before it, and unchanged and in order after it @keys", async ({
    page,
  }) => {
    const errors = await attachErrorCollectors(page);
    const release = await holdBaseStyle(page);

    await drawFlights(page);
    const before = await flightsOnMap(page);

    expect(before.layers).toEqual([
      "background",
      ...FLIGHT_LAYERS,
      ...AIRPORT_LABELS,
    ]);
    expect(before.drawn.heat).toBeGreaterThan(0);
    expect(before.drawn.paths).toBeGreaterThan(0);
    expect(before.features["paths-altitude-selected"]).toBeGreaterThan(0);
    // Not worked out while the colour layer draws the selection itself
    // (ui/selectionHighlight.ts)
    expect(before.features["selection-highlight"]).toBe(0);
    await expect(attributionControl(page)).not.toContainText("CARTO");

    release();
    await expect
      .poll(async () => (await flightsOnMap(page)).layers)
      .toContain(BASE_STYLE_LABELS);
    // Also fails when the map made one of the flights' sources anew
    const after = await flightsOnMap(page);

    expect(after.layers).toEqual([
      "background",
      "base",
      ...FLIGHT_LAYERS,
      BASE_STYLE_LABELS,
      ...AIRPORT_LABELS,
    ]);
    expect(after.looks).toEqual(before.looks);
    expect(after.features).toEqual(before.features);
    expect(after.drawn).toEqual(before.drawn);
    await expect(attributionControl(page)).toContainText("CARTO");
    // The tiles still answer for the flights, and not as out of date
    await expectSegmentUnderPointer(page);
    // Zoomed in to where the overlay is drawn, which is when it is credited
    await expect(attributionControl(page)).toContainText("open flightmaps");
    expect(relevantConsoleErrors(errors)).toEqual([]);
  });

  test("arrives during a replay: the trail, the route and the airplane stay @keys", async ({
    page,
  }) => {
    const release = await holdBaseStyle(page);
    const pause = page.locator("#replay-pause-btn");
    const clock = (): Promise<number> =>
      page.evaluate(() => window.mapApp!.replayState.currentTime);

    await gotoApp(page);
    await activateReplay(page);
    await playUntilProgress(page);
    await pause.click();
    const before = await flightsOnMap(page);
    expect(before.features["replay-route"]).toBeGreaterThan(0);
    expect(before.features["replay-trail"]).toBeGreaterThan(0);

    // Released while the replay runs and writes its trail every frame
    await page.locator("#replay-play-btn").click();
    const releasedAt = await clock();
    release();
    await page.waitForFunction(
      (labels) => !!window.mapApp!.map!.getLayer(labels),
      BASE_STYLE_LABELS,
    );
    await expect.poll(clock).toBeGreaterThan(releasedAt);
    await pause.click();
    const after = await flightsOnMap(page);

    expect(after.layers).toEqual([
      "background",
      "base",
      ...FLIGHT_LAYERS,
      BASE_STYLE_LABELS,
      ...AIRPORT_LABELS,
    ]);
    expect(after.features["replay-route"]).toBe(
      before.features["replay-route"],
    );
    expect(after.features["replay-trail"]).toBeGreaterThanOrEqual(
      before.features["replay-trail"]!,
    );
    await expect(page.locator(".replay-airplane-root")).toBeVisible();
  });

  test("never arrives: the app is all there on the plain background @keys", async ({
    page,
  }) => {
    await failBaseStyle(page);

    await drawFlights(page);
    const flights = await flightsOnMap(page);

    expect(flights.layers).toEqual([
      "background",
      ...FLIGHT_LAYERS,
      ...AIRPORT_LABELS,
    ]);
    expect(flights.drawn.heat).toBeGreaterThan(0);
    expect(flights.drawn.paths).toBeGreaterThan(0);
    // The page says why the map is dark, once, and offers to ask again. It
    // is dismissed so it cannot stand over the segment hovered below.
    const toast = toastMessage(page, BASE_STYLE_UNAVAILABLE_MESSAGE);
    await expect(toast).toHaveCount(1);
    await expect(toast.getByRole("button", { name: "Retry" })).toBeVisible();
    await toast.getByRole("button", { name: "Dismiss" }).click();
    await expect(toast).toHaveCount(0);
    await expectSegmentUnderPointer(page);
    await expect(attributionControl(page)).toContainText("open flightmaps");
    await toggleLayer(page, "heatmap");
    expect((await flightsOnMap(page)).looks).not.toEqual(flights.looks);
  });
});

/**
 * The ribbon layers of the 3D view, and those of them without the paint
 * that lifts them: the map creates them bare, and ui/terrain.ts gives them
 * the paint once the feature bundle is there, and again to a style that
 * comes without it. A ribbon without it lies flat on the ground.
 */
function ribbonLayers(page: Page): Promise<{ ids: string[]; flat: string[] }> {
  return page.evaluate(() => {
    const map = window.mapApp!.map!;
    const ids = map
      .getStyle()
      .layers.filter((layer) => layer.type === "fill-extrusion")
      .map((layer) => layer.id);
    return {
      ids,
      flat: ids.filter(
        (id) => map.getPaintProperty(id, "fill-extrusion-height") === undefined,
      ),
    };
  });
}

test.describe("Base style in the 3D view", HEAVY, () => {
  // Any step may wait on a frame of the 3D view, which takes seconds in
  // software WebGL (see 3d-relief.spec.ts)
  const slowExpect = expect.configure({ timeout: 60000 });

  test("a link into the 3D view lifts the ribbons, before the base style arrives and after", async ({
    page,
  }) => {
    test.setTimeout(180000);
    // Not the relief, which nothing here looks at
    await holdElevationTiles(page);
    const release = await holdBaseStyle(page);

    // The feature bundle with the paint arrives after the map made the
    // ribbon layers. Not waitForPathData: it counts the lines once the map
    // is idle, which it never is while the elevation tiles are held.
    await gotoApp(page, "/?d=1");
    await expect(page.locator("#three-d-btn")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await toggleLayer(page, "altitude");
    await slowExpect
      .poll(() => ribbonCount(page, "altitude"))
      .toBeGreaterThan(0);
    await slowExpect
      .poll(async () => (await ribbonLayers(page)).flat)
      .toEqual([]);
    expect((await ribbonLayers(page)).ids).toContain("paths-altitude-3d");

    // The base style goes under the flights, and the ribbons keep their lift
    release();
    await slowExpect
      .poll(() =>
        page.evaluate(
          (labels) => !!window.mapApp!.map!.getLayer(labels),
          BASE_STYLE_LABELS,
        ),
      )
      .toBe(true);
    await slowExpect
      .poll(() => ribbonCount(page, "altitude"))
      .toBeGreaterThan(0);
    await slowExpect
      .poll(async () => (await ribbonLayers(page)).flat)
      .toEqual([]);
    expect((await ribbonLayers(page)).ids).toContain("paths-altitude-3d");
  });
});
