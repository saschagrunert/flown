/**
 * The 3D view on the relief: the ground it draws, the flights and the heat
 * cloud on it, a chase over it and a slope under it.
 *
 * Split from orientation.spec.ts, and named to sort first: CI runs the
 * tests tagged @heavy in a job of two browsers, which take the specs in
 * the order of their files. These run one after the other in one worker
 * and take the longest, so they start at once while the other browser
 * works through the rest; after the heavy tests of cloud-readout.spec.ts
 * and hotspot-tour.spec.ts the other browser sat idle for minutes at the
 * end of the job.
 */
import {
  test,
  expect,
  HEAVY,
  HEAVY_SECOND,
  slopeElevationM,
  TERRAIN_ELEVATION_M,
  type Locator,
  type Page,
} from "./fixtures";
import {
  activateReplay,
  findSegmentFarFromAirports,
  gotoApp,
  layerButton,
  toggleLayer,
  waitForPathData,
} from "./helpers";
import {
  airportPosition,
  canvasGlow,
  expectHeatmapPainted,
  heatCloudOnMap,
  heatmapOnMap,
  homeField,
  getOrientation,
  jumpToView,
  mapIsIdle,
  mapSurface,
  segmentDetails,
} from "./map";

const globe = (page: Page): Locator => page.locator("#globe-btn");

/**
 * The relief of the 3D view in software WebGL draws a frame in half a
 * second to two and a half on one core, where the flat map takes a tenth
 * of that, and the map asks for the tiles of the view as it draws: with a
 * browser per core of the CI runner a frame took four seconds, and a view
 * with the relief a minute to complete. Cutting the flights anew on the
 * other ground holds the page up for seconds there as well. A smaller map
 * (RELIEF_VIEWPORT) without the heat draws a frame a third faster.
 */
const RELIEF_TIMEOUT_MS = 60000;
/**
 * What the relief's specs wait for: any step may wait on a frame of the
 * relief, which took up to 16 s with a browser per core
 */
const reliefExpect = expect.configure({ timeout: RELIEF_TIMEOUT_MS });
/** A test that enters the relief, three waits of RELIEF_TIMEOUT_MS */
const RELIEF_TEST_TIMEOUT_MS = 180000;
/** Still the desktop layout (MOBILE_BREAKPOINT_PX), half the pixels of 720p */
const RELIEF_VIEWPORT = { width: 800, height: 500 };

/** The relief the map draws, null for none */
function relief(page: Page): Promise<unknown> {
  return page.evaluate(() => window.mapApp!.map!.getTerrain());
}

/**
 * The ground the relief stands on in the middle of the map, exaggerated;
 * null until its elevation tile landed
 */
function ground(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const map = window.mapApp!.map!;
    return map.queryTerrainElevation(map.getCenter());
  });
}

/** Whether the shading of the relief shows, "absent" before it exists */
function hillshade(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const map = window.mapApp!.map!;
    return map.getLayer("terrain-hillshade")
      ? map.getLayoutProperty("terrain-hillshade", "visibility")
      : "absent";
  });
}

/**
 * Whether the ribbons show and their tiles have all been drawn.
 * ui/terrain.ts shows the ribbons once they have, or after a few seconds
 * at most, which a slow frame in software WebGL takes. Not every elevation
 * tile in view: towards the horizon of the tilted map they are many, and
 * with a browser per core they took up to a minute to land after the
 * ribbons had, while what is checked is in the middle of the map. The
 * specs poll for the relief there instead.
 */
function ribbonsSettled(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const app = window.mapApp!;
    const map = app.map!;
    return (
      app.relief.ribbonsShown === 1 &&
      Object.keys(map.getStyle().sources)
        .filter((id) => id.endsWith("-3d"))
        .every((id) => map.isSourceLoaded(id))
    );
  });
}

/**
 * Move to `coord` at map zoom 11 (the state's 12), where the relief is
 * drawn from the deepest elevation tiles, on a smaller map
 * (RELIEF_VIEWPORT) without the heat, which none of the relief's specs
 * look at, turn the 3D view on and wait until the ribbons stand on the
 * relief (ribbonsSettled)
 */
async function enterRelief(
  page: Page,
  coord: readonly [number, number],
): Promise<void> {
  await page.setViewportSize(RELIEF_VIEWPORT);
  await toggleLayer(page, "heatmap");
  // Zoomed in first, the flights are cut for the 3D view once, on the
  // relief, rather than for the whole map and then again
  await jumpToView(page, coord, 12);
  await page.locator("#three-d-btn").click();
  await reliefExpect(page.locator("#three-d-btn")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await reliefExpect
    .poll(() => relief(page))
    .toMatchObject({ source: "terrain" });
  await reliefExpect.poll(() => ribbonsSettled(page)).toBe(true);
}

/**
 * Find a point of the map where a ribbon of one flight alone is drawn, put
 * the pointer there, and expect the tooltip of that flight: the hit test
 * looks for the ribbon through `unproject`, which meets the relief. Tried
 * again until it holds: the elevation tiles still landing move the ribbons
 * on the screen between the search and the pointer.
 */
async function expectRibbonUnderPointer(page: Page): Promise<void> {
  await expect(() => ribbonUnderPointer(page)).toPass({
    timeout: RELIEF_TIMEOUT_MS,
  });
}

async function ribbonUnderPointer(page: Page): Promise<void> {
  const ribbon = await page.evaluate(() => {
    const map = window.mapApp!.map!;
    const layers = ["paths-altitude-3d", "paths-altitude-selected-3d"];
    const { clientWidth: width, clientHeight: height } = map.getContainer();
    // From the middle out: towards the horizon the ribbons are thin, and
    // the hit test measures their lift by the middle of the map
    const rows = [];
    for (let y = 20; y < height - 20; y += 6) rows.push(y);
    rows.sort((a, b) => Math.abs(a - height / 2) - Math.abs(b - height / 2));
    for (const y of rows) {
      for (let x = width / 4; x < (width * 3) / 4; x += 6) {
        if (map.queryRenderedFeatures([x, y], { layers }).length === 0) {
          continue;
        }
        const around = map.queryRenderedFeatures(
          [
            [x - 10, y - 10],
            [x + 10, y + 10],
          ],
          { layers },
        );
        const pathIds = new Set(
          around.map((feature) => feature.properties["pathId"] as number),
        );
        if (pathIds.size === 1) return { x, y, pathId: [...pathIds][0]! };
      }
    }
    return null;
  });
  expect(ribbon).not.toBeNull();
  const box = (await mapSurface(page).boundingBox())!;
  await page.mouse.move(box.x + ribbon!.x, box.y + ribbon!.y);
  await expect(segmentDetails(page).first()).toBeVisible();
  const hit = await page.evaluate(
    ({ x, y }) => window.mapApp!.layerManager.hitTest({ x, y } as never),
    ribbon!,
  );
  expect(hit).toMatchObject({ pathId: ribbon!.pathId });
}

test.describe("Map orientation on the relief", HEAVY, () => {
  // One after the other in one worker, not side by side: a frame of the
  // relief takes seconds in software WebGL, and with two of them drawn
  // at once besides the other specs of the run, a step took as long as
  // their waits allow. No retry: a test that passes only on its retry
  // fails the run anyway (failOnFlakyTests in playwright.config.ts), so a
  // retry would only tell a flaky failure from a steady one, and here an
  // attempt takes minutes.
  test.describe.configure({ mode: "default", retries: 0 });

  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("the 3D view draws the relief, the flights on it stay under the pointer, and the globe only shades it", async ({
    page,
  }) => {
    test.setTimeout(RELIEF_TEST_TIMEOUT_MS);
    // A flight well away from the airports, whose markers lie over it
    const at = await findSegmentFarFromAirports(page);
    expect(at).not.toBeNull();
    const coord = [at!.coord[0]!, at!.coord[1]!] as const;
    await enterRelief(page, coord);
    // The relief stands on the elevation tiles: the flat ground of the
    // fixture, exaggerated
    const { exaggeration } = (await relief(page)) as { exaggeration: number };
    await reliefExpect
      .poll(() => ground(page))
      .toBeCloseTo(TERRAIN_ELEVATION_M * exaggeration, 0);
    await reliefExpect.poll(() => hillshade(page)).not.toBe("none");
    expect(await hillshade(page)).not.toBe("absent");
    expect(
      await page.evaluate(() => window.mapApp!.map!.getPitch()),
    ).toBeGreaterThan(20);
    // The flat ground of the fixture is 500 m up, 1 km with the
    // exaggeration: a ribbon is found only where it is drawn over it
    await expectRibbonUnderPointer(page);

    // The globe shades the relief but leaves it out, and the flights stand
    // on the line between their fields there
    await globe(page).click();
    await reliefExpect
      .poll(() => getOrientation(page))
      .toMatchObject({ projection: "globe" });
    await reliefExpect.poll(() => relief(page)).toBeNull();
    expect(await hillshade(page)).not.toBe("none");
    expect(
      await page.evaluate(() => window.mapApp!.store.get("reliefShaded")),
    ).toBe(true);
    await globe(page).click();
    await reliefExpect
      .poll(() => relief(page))
      .toMatchObject({ source: "terrain" });
  });

  test("the 3D view draws the heat as a cloud in place of the flat heatmap, under the same switch", async ({
    page,
  }) => {
    test.setTimeout(RELIEF_TEST_TIMEOUT_MS);
    await page.setViewportSize(RELIEF_VIEWPORT);
    await expectHeatmapPainted(page);
    await page.locator("#three-d-btn").click();

    // The flat heatmap steps aside for the cloud, and the switch stays on
    await reliefExpect
      .poll(() => heatCloudOnMap(page))
      .toMatchObject({ onMap: true, stepsIn: true });
    expect(await heatmapOnMap(page)).toBe(false);
    await expect(layerButton(page, "heatmap")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Drawn in a frame of the map: a frame of the relief takes seconds
    // in software WebGL, where the cloud's own shaders run as well
    await reliefExpect
      .poll(async () => (await heatCloudOnMap(page)).drawn)
      .toBeGreaterThan(0);

    // The switch hides the cloud as it hides the heatmap
    await toggleLayer(page, "heatmap");
    await reliefExpect
      .poll(async () => (await heatCloudOnMap(page)).drawn)
      .toBe(0);
    expect(await heatmapOnMap(page)).toBe(false);
    await toggleLayer(page, "heatmap");
    await reliefExpect
      .poll(async () => (await heatCloudOnMap(page)).drawn)
      .toBeGreaterThan(0);

    // Out of the 3D view: the flat heatmap again, and no cloud
    await page.locator("#three-d-btn").click();
    await reliefExpect
      .poll(() => heatCloudOnMap(page))
      .toMatchObject({ onMap: false, stepsIn: false });
    await reliefExpect.poll(() => heatmapOnMap(page)).toBe(true);
  });

  // A test of its own: every step on the relief waits on its frames, and
  // with the one above this took longer than RELIEF_TEST_TIMEOUT_MS
  test("zoomed out, the 3D view still draws the relief, exaggerated more and the flights as much", async ({
    page,
  }) => {
    test.setTimeout(RELIEF_TEST_TIMEOUT_MS);
    const at = await findSegmentFarFromAirports(page);
    expect(at).not.toBeNull();
    const coord = [at!.coord[0]!, at!.coord[1]!] as const;
    await enterRelief(page, coord);
    const { exaggeration } = (await relief(page)) as { exaggeration: number };

    // Asked for one by one rather than by waiting for the map to be idle,
    // which takes the base map and the heat of the whole view along (see
    // jumpToView)
    await jumpToView(page, coord, 8, { timeout: RELIEF_TIMEOUT_MS });
    await reliefExpect
      .poll(
        async () =>
          ((await relief(page)) as { exaggeration: number } | null)
            ?.exaggeration,
      )
      .toBeGreaterThan(exaggeration);
    await reliefExpect.poll(() => ribbonsSettled(page)).toBe(true);
    // The ribbons are cut for the level the relief is drawn for, and
    // exaggerated as it is by that (see ribbonHeights in lift.ts)
    const lifted = await page.evaluate(() => {
      const app = window.mapApp!;
      const map = app.map!;
      return {
        relief: map.getTerrain()!.exaggeration ?? 1,
        level: app.store.get("reliefLevel"),
        ribbons: [
          ...new Set(
            map
              .querySourceFeatures("paths-altitude-3d")
              .map((feature) => feature.properties["l"] as number),
          ),
        ],
      };
    });
    expect(lifted.ribbons).toEqual([lifted.level]);
    await reliefExpect
      .poll(() => ground(page))
      .toBeCloseTo(TERRAIN_ELEVATION_M * lifted.relief, 0);
    expect(await hillshade(page)).not.toBe("none");

    // Out of the 3D view: no relief, and no shading
    await page.locator("#three-d-btn").click();
    await reliefExpect.poll(() => relief(page)).toBeNull();
    expect(await hillshade(page)).toBe("none");
    expect(
      await page.evaluate(() => window.mapApp!.store.get("terrainActive")),
    ).toBe(false);
  });

  // What the layer reports is what it asked GL to draw: a shader, a
  // layout or a buffer that went wrong still counts its stretches. So the
  // canvas itself is read, with the Heatmap on and off in the same view,
  // once the map has drawn everything (canvasGlow). The suite runs with
  // reduced motion, so the cloud's pulses rest and the frames with and
  // without it differ by the cloud alone. The thresholds are a sixth of
  // what software WebGL drew over the home field of data/: a third of
  // the middle of the map glowed with the cloud, a thousandth without.
  test("the 3D view's cloud glows on the canvas over the home field, and goes with the Heatmap", async ({
    page,
  }) => {
    test.setTimeout(RELIEF_TEST_TIMEOUT_MS);
    await page.setViewportSize(RELIEF_VIEWPORT);
    await waitForPathData(page);
    await jumpToView(page, await homeField(page), 10);
    await page.locator("#three-d-btn").click();
    await reliefExpect
      .poll(async () => (await heatCloudOnMap(page)).drawn)
      .toBeGreaterThan(0);
    // The glow is the cloud's alone: the flat heatmap has stepped aside
    expect(await heatmapOnMap(page)).toBe(false);
    await reliefExpect.poll(() => mapIsIdle(page)).toBe(true);
    const on = await canvasGlow(page);

    await toggleLayer(page, "heatmap");
    await reliefExpect
      .poll(async () => (await heatCloudOnMap(page)).drawn)
      .toBe(0);
    await reliefExpect.poll(() => mapIsIdle(page)).toBe(true);
    const off = await canvasGlow(page);

    expect(on.glow - off.glow, JSON.stringify({ on, off })).toBeGreaterThan(
      0.05,
    );
    expect(on.luminance - off.luminance).toBeGreaterThan(3);
  });

  // The suite asks for reduced motion (playwright.config.ts), under which
  // the cloud's pulses never run: the marks of the way flown show instead.
  // How they hand over to the pulses is timed by the frames, which take
  // seconds here: the unit tests of the layer check that.
  test("under reduced motion the cloud shows the way flown with its marks, not its pulses", async ({
    page,
  }) => {
    test.setTimeout(RELIEF_TEST_TIMEOUT_MS);
    await page.setViewportSize(RELIEF_VIEWPORT);
    await expectHeatmapPainted(page);
    await page.locator("#three-d-btn").click();
    await reliefExpect
      .poll(async () => (await heatCloudOnMap(page)).drawn)
      .toBeGreaterThan(0);
    // Close enough in for the marks to show in full (see markStrength);
    // using the map wakes no pulse while the system asks for less motion
    const center = await page.evaluate(() => {
      const { lat, lng } = window.mapApp!.map!.getCenter();
      return [lat, lng] as const;
    });
    await jumpToView(page, center, 10, { timeout: RELIEF_TIMEOUT_MS });
    await reliefExpect
      .poll(async () => {
        const { drawn, marks, pulses } = await heatCloudOnMap(page);
        return drawn > 0 && marks === 1 && pulses === 0;
      })
      .toBe(true);
  });

  test.describe("with motion", HEAVY_SECOND, () => {
    // Before the page loads, as in replay.spec.ts: the chase view is off
    // with reduced motion, which the suite asks for
    test.use({ reducedMotion: "no-preference" });

    test("a chase over the relief draws the trail up to the airplane", async ({
      page,
    }) => {
      test.setTimeout(RELIEF_TEST_TIMEOUT_MS);
      const at = await findSegmentFarFromAirports(page);
      expect(at).not.toBeNull();
      await enterRelief(page, [at!.coord[0]!, at!.coord[1]!] as const);
      await activateReplay(page, { timeout: RELIEF_TIMEOUT_MS });
      await page.evaluate(() => {
        const state = window.mapApp!.replayState;
        window.mapApp!.replayManager!.seekReplay(
          String(Math.floor(state.maxTime / 2)),
        );
      });
      const chase = page.locator("#replay-chase-btn");
      await chase.click();
      await reliefExpect(chase).toHaveAttribute("aria-pressed", "true");
      // The camera looks at the airplane up in the air, above the highest
      // point of the relief: MapLibre left the tiles of the trail under
      // it out of the view, and no trail was drawn near the airplane
      // (see VENDOR_PATCHES in scripts/vendor.js)
      await reliefExpect
        .poll(() =>
          page.evaluate(
            () =>
              window.mapApp!.map!.queryRenderedFeatures({
                layers: ["replay-trail-3d"],
              }).length,
          ),
        )
        .toBeGreaterThan(0);
    });
  });

  test.describe("on a slope", HEAVY_SECOND, () => {
    // Elevation tiles that rise and fall with the longitude (see
    // slopeElevationM). The ribbons stand on the ground the build sampled
    // from the real elevation tiles, so they do not follow this one; what
    // is checked is what uses the relief the page draws: the elevation the
    // map reads from it, the markers on it, and the pointer finding the
    // flights over it.
    test.use({ terrain: "slope" });

    test("the relief rises and falls with the ground, and the airports and the flights stand where it is drawn", async ({
      page,
    }) => {
      test.setTimeout(RELIEF_TEST_TIMEOUT_MS);
      const at = await findSegmentFarFromAirports(page);
      expect(at).not.toBeNull();
      const coord = [at!.coord[0]!, at!.coord[1]!] as const;
      await enterRelief(page, coord);

      // Two points on the same flank, a tenth of a degree apart, near the
      // middle of the map where the elevation tiles are loaded
      const flank = Math.floor(coord[1] * 2) / 2;
      const west = Math.min(
        Math.max(coord[1] - 0.05, flank + 0.01),
        flank + 0.39,
      );
      const east = west + 0.1;
      const readRelief = (): Promise<{
        exaggeration: number;
        elevations: (number | null)[];
      }> =>
        page.evaluate(
          ([lat, lngs]) => {
            const map = window.mapApp!.map!;
            return {
              exaggeration: map.getTerrain()!.exaggeration ?? 1,
              elevations: lngs.map((lng) =>
                map.queryTerrainElevation([lng, lat]),
              ),
            };
          },
          [coord[0], [west, east]] as const,
        );
      // Until the elevation tile under a point has landed, the map answers
      // from a coarser one or not at all, so the reading is polled
      const offBy = async (): Promise<number> => {
        const { exaggeration, elevations } = await readRelief();
        const [westM, eastM] = elevations;
        if (westM == null || eastM == null) return Infinity;
        return Math.max(
          Math.abs(westM - slopeElevationM(west) * exaggeration),
          Math.abs(eastM - slopeElevationM(east) * exaggeration),
        );
      };
      const { exaggeration } = await readRelief();
      // 200 m either way on the ground, twice that with the exaggeration
      expect(
        Math.abs(
          (slopeElevationM(east) - slopeElevationM(west)) * exaggeration,
        ),
      ).toBeGreaterThan(300);
      await reliefExpect.poll(offBy).toBeLessThan(10);

      // The pointer finds a flight over the slope, the one drawn there
      await expectRibbonUnderPointer(page);

      // An airport off the middle of the map, on ground a few hundred
      // metres higher or lower than the middle: its marker is where the
      // relief under it is drawn, so pointing there finds the airport
      const name = await page.evaluate(
        () => Object.keys(window.mapApp!.airportMarkers)[0]!,
      );
      const [lat, lng] = await airportPosition(page, name);
      const side = Math.floor(lng * 2) / 2 + 0.25 > lng ? 0.1 : -0.1;
      await jumpToView(page, [lat - 0.02, lng + side], 12, {
        timeout: RELIEF_TIMEOUT_MS,
      });
      const measure = (): Promise<{ ground: number[]; rise: number }> =>
        page.evaluate((airport) => {
          const map = window.mapApp!.map!;
          const marker = window.mapApp!.airportMarkers[airport]!;
          const box = marker.getElement().getBoundingClientRect();
          const container = map.getContainer().getBoundingClientRect();
          const point: [number, number] = [
            box.x + box.width / 2 - container.x,
            box.y + box.height / 2 - container.y,
          ];
          const { lat, lng } = marker.getLatLng();
          const ground = map.unproject(point);
          // Null until the tile under a point has landed: no rise yet
          const at = map.queryTerrainElevation([lng, lat]);
          const middle = map.queryTerrainElevation(map.getCenter());
          return {
            ground: [ground.lat, ground.lng],
            rise: at === null || middle === null ? NaN : at - middle,
          };
        }, name);
      // The elevation tiles under the airport and the middle land one by one,
      // and in software WebGL the whole map is not loaded for minutes, so the
      // placement itself is polled rather than map.loaded()
      const off = (p: { ground: number[]; rise: number }): number =>
        Math.abs(p.rise) > 150
          ? Math.max(
              Math.abs(p.ground[0]! - lat) / 0.0005,
              Math.abs(p.ground[1]! - lng) / 0.0008,
            )
          : Infinity;
      await reliefExpect.poll(async () => off(await measure())).toBeLessThan(1);
      const placed = await measure();
      expect(Math.abs(placed.rise)).toBeGreaterThan(150);
      // About 50 m; a marker at the height of the middle of the map would
      // point at ground a kilometre or more away
      expect(Math.abs(placed.ground[0]! - lat)).toBeLessThan(0.0005);
      expect(Math.abs(placed.ground[1]! - lng)).toBeLessThan(0.0008);
    });
  });
});
