import { test, expect, holdElevationTiles, type Page } from "./fixtures";
import {
  closeMobileSheet,
  firstPathId,
  expectToggle,
  gotoApp,
  knownYears,
  layerButton,
  openMobileSheet,
  readSavedState,
  selectionParams,
  selectPathForReplay,
  setAircraftFilter,
  setYearFilter,
  toggleLayer,
  togglePathSelection,
  usesMobileBar,
  waitForPathData,
  waitForAircraftFilter,
  waitForAppReady,
  waitForStatsContent,
  waitForYearFilter,
} from "./helpers";
import {
  attributionControl,
  getCenter,
  getOrientation,
  satelliteOnMap,
  setOrientation,
  waitForMapReady,
} from "./map";

/**
 * Whether Reset view offers itself: its button, or on a phone the row of
 * the More sheet, which is only there while the sheet is open
 */
async function expectResetAvailable(
  page: Page,
  mobile: boolean,
  available: boolean,
): Promise<void> {
  if (mobile) await openMobileSheet(page, "more");
  const control = page.locator(
    mobile ? '.sheet-row[data-row="reset-view"]' : "#reset-view-btn",
  );
  await expect(control).toHaveAttribute("aria-disabled", String(!available));
  // A sheet row dims its label and keeps its hint at full strength
  const dimmed = mobile ? control.locator(".sheet-row-label") : control;
  await expect(dimmed).toHaveCSS("opacity", available ? "1" : "0.5");
  if (mobile) await closeMobileSheet(page);
}

test.describe("State Persistence", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test.describe("localStorage", () => {
    test("state is saved to localStorage", async ({ page }) => {
      await page.evaluate(() => localStorage.removeItem("flown-state"));

      await toggleLayer(page, "heatmap");
      await expectToggle(layerButton(page, "heatmap"), false);

      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);
    });

    test("state is restored on reload", async ({ page }) => {
      await toggleLayer(page, "heatmap");
      await expectToggle(layerButton(page, "heatmap"), false);
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await page.reload();
      await waitForAppReady(page);

      await expectToggle(layerButton(page, "heatmap"), false);
    });

    test("localStorage stores expected state fields", async ({ page }) => {
      await toggleLayer(page, "heatmap");
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      const state = await readSavedState(page);

      const expectedKeys = [
        "schemaVersion",
        "center",
        "zoom",
        "heatmapVisible",
        "altitudeVisible",
        "airspeedVisible",
        "airportsVisible",
        "selectedYear",
        "selectedAircraft",
        "selectedPathIds",
        "statsPanelVisible",
        "isolateSelection",
      ];

      for (const key of expectedKeys) {
        expect(state).toHaveProperty(key);
      }
    });

    test("selected path IDs persist across reload", async ({ page }) => {
      await selectPathForReplay(page);

      await expect
        .poll(async () => {
          const ids = (await readSavedState(page))["selectedPathIds"];
          return Array.isArray(ids) ? ids.length : 0;
        })
        .toBe(1);

      await page.reload();
      await waitForAppReady(page);

      await page.waitForFunction(
        () => window.mapApp!.selectedPathIds.size > 0,
        undefined,
        { timeout: 15000 },
      );
      expect(
        await page.evaluate(() => window.mapApp!.selectedPathIds.size),
      ).toBe(1);
    });
  });

  test.describe("URL and localStorage Combinations", () => {
    test("URL parameters take priority over localStorage", async ({ page }) => {
      await toggleLayer(page, "heatmap");
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await gotoApp(page, "/?v=100100000");

      await expectToggle(layerButton(page, "heatmap"), true);
    });

    test("URL year parameter overrides localStorage year", async ({ page }) => {
      const years = await knownYears(page);
      expect(
        years.length,
        "two years to switch between",
      ).toBeGreaterThanOrEqual(2);
      const yearSelect = page.locator("#year-select");
      await expect(yearSelect.locator("option")).toHaveCount(years.length + 1);
      const [year1, year2] = years as [string, string];

      await setYearFilter(page, year1);
      await waitForYearFilter(page, year1);
      await expect
        .poll(async () => (await readSavedState(page))["selectedYear"])
        .toBe(year1);

      await gotoApp(page, `/?y=${year2}`);

      await expect(yearSelect).toHaveValue(year2);
    });

    test("URL aircraft parameter overrides localStorage aircraft", async ({
      page,
    }) => {
      const aircraftSelect = page.locator("#aircraft-select");
      const options = aircraftSelect.locator("option");
      expect(await options.count()).toBeGreaterThanOrEqual(2);

      const aircraft = (await options.nth(1).getAttribute("value"))!;
      await setAircraftFilter(page, "all");
      await waitForAircraftFilter(page, "all");

      await gotoApp(page, `/?a=${aircraft}`);

      await expect(aircraftSelect).toHaveValue(aircraft);
    });

    test("URL visibility overrides localStorage visibility", async ({
      page,
    }) => {
      await toggleLayer(page, "heatmap");
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await gotoApp(page, "/?v=010100000");

      await expectToggle(layerButton(page, "heatmap"), false);
      await expectToggle(layerButton(page, "altitude"), true);
    });

    test("a legacy shared link keeps its flags and drops the hide-controls bit", async ({
      page,
    }) => {
      // The 8th slot of the visibility string carried the hide-controls
      // flag. The feature is gone but links minted before it went away
      // still set the bit, and the share mode flag behind it has to survive
      // the slot being ignored rather than shifting by one. Share mode only
      // sticks with a selection to share, so the link carries one.
      await gotoApp(page);
      const pathId = await firstPathId(page);
      await gotoApp(page, `/?v=100100011&${selectionParams(pathId)}`);

      await expect(page.locator("#isolate-btn")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(await page.evaluate(() => window.mapApp!.isolateSelection)).toBe(
        true,
      );

      for (const [layer, pressed] of [
        ["heatmap", "true"],
        ["altitude", "false"],
        ["airspeed", "false"],
        ["airports", "true"],
      ] as const) {
        await expect(layerButton(page, layer), layer).toHaveAttribute(
          "aria-pressed",
          pressed,
        );
      }
      await expect(page.locator("#stats-panel")).toBeHidden();
      await expect(page.locator("#wrapped-modal")).toBeHidden();

      // The chrome the legacy bit used to hide is on screen either way
      const controls = (await usesMobileBar(page))
        ? "#mobile-bar"
        : "#left-buttons";
      await expect(page.locator(controls)).toBeVisible();

      // And the link the app writes back no longer carries the bit
      await expect
        .poll(() => new URL(page.url()).searchParams.get("v"))
        .toBe("100100001");
    });

    test("URL stats panel visibility is restored", async ({ page }) => {
      await gotoApp(page, "/?v=100111000");

      await expect(page.locator("#stats-panel")).toBeVisible();
      // Its figures follow with the Wrapped bundle, which a page opening
      // with the panel fetches ahead (ui/statsPanel.ts)
      const panel = await waitForStatsContent(page);
      await expect(panel).toContainText("Flights");
      await expect(panel.locator(".kh-stats-loading")).toHaveCount(0);
    });

    test("URL map position overrides localStorage position", async ({
      page,
    }) => {
      await gotoApp(page, "/?lat=48.000000&lng=11.000000&z=10.00");

      const center = await getCenter(page);

      expect(Math.abs(center.lat - 48.0)).toBeLessThan(1);
      expect(Math.abs(center.lng - 11.0)).toBeLessThan(1);
    });

    test("URL path selection overrides localStorage paths", async ({
      page,
    }) => {
      const pathId = await firstPathId(page);

      await gotoApp(page, `/?${selectionParams(pathId)}`);

      await page.waitForFunction(
        () => window.mapApp!.selectedPathIds.size > 0,
        undefined,
        { timeout: 15000 },
      );
      const hasPath = await page.evaluate(
        (id) => window.mapApp!.selectedPathIds.has(id),
        pathId,
      );
      expect(hasPath).toBe(true);
    });

    test("a linked flight that no longer exists is dropped with the share mode flag", async ({
      page,
    }) => {
      const pathId = await firstPathId(page);
      // Ids are content hashes, so a flight removed from the export leaves
      // an id behind that nothing answers to
      const missing = await page.evaluate(() => {
        const known = new Set(window.mapApp!.fullPathInfo!.map((p) => p.id));
        let id = 1;
        while (known.has(id)) id++;
        return id;
      });

      // Of every year: a dataset of one year has none of the others,
      // whose flights share mode keeps under the chip's "not in" the year
      await gotoApp(page, `/?v=100100001&y=all&${selectionParams(missing)}`);

      expect(
        await page.evaluate(() => ({
          selected: window.mapApp!.selectedPathIds.size,
          isolate: window.mapApp!.isolateSelection,
        })),
      ).toEqual({ selected: 0, isolate: false });
      await expect(page.locator("#isolate-btn")).toHaveAttribute(
        "aria-pressed",
        "false",
      );

      // A flight that still exists keeps its place in the same link
      await gotoApp(page, `/?${selectionParams(missing, pathId)}`);

      expect(
        await page.evaluate(() => [...window.mapApp!.selectedPathIds]),
      ).toEqual([pathId]);
      // The link spells ids in base 36 (schema 4)
      await expect
        .poll(() => new URL(page.url()).searchParams.get("p"))
        .toBe(pathId.toString(36));
    });

    test("localStorage is used when no URL params present", async ({
      page,
    }) => {
      await toggleLayer(page, "heatmap");
      await expect
        .poll(async () => (await readSavedState(page))["heatmapVisible"])
        .toBe(false);

      await gotoApp(page, "/");

      await expectToggle(layerButton(page, "heatmap"), false);
    });

    test("URL updates when state changes", async ({ page }) => {
      await toggleLayer(page, "heatmap");

      // The first flag is the heatmap; every other flag keeps its default
      await expect
        .poll(() => new URL(page.url()).searchParams.get("v"))
        .toBe("000100000");
    });

    test("a link restores the bearing, the pitch and the globe", async ({
      page,
    }) => {
      await gotoApp(page, "/?lat=50.5&lng=9.5&z=7&b=-40.5&t=35&g=1");

      expect(await getOrientation(page)).toEqual({
        bearing: -40.5,
        pitch: 35,
        projection: "globe",
      });
      await expect(layerButton(page, "globe")).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });

    test("a link from before the map could turn opens north up, flat and in Mercator", async ({
      page,
    }) => {
      // What is saved on this device must not leak into an old link
      await setOrientation(page, { bearing: 90, pitch: 30 });
      await toggleLayer(page, "globe");
      await expect
        .poll(async () => (await readSavedState(page))["bearing"])
        .toBe(90);

      await gotoApp(page, "/?lat=50.5&lng=9.5&z=7");

      expect(await getOrientation(page)).toEqual({
        bearing: 0,
        pitch: 0,
        projection: "mercator",
      });
    });

    test("the link carries the orientation only while it is not the default", async ({
      page,
    }) => {
      const params = (): URLSearchParams => new URL(page.url()).searchParams;

      await setOrientation(page, { bearing: 120.26, pitch: 45 });
      await toggleLayer(page, "globe");

      // The globe is the change made last, and the link is written with a delay
      await expect.poll(() => params().get("g")).toBe("1");
      expect(params().get("b")).toBe("120.3");
      expect(params().get("t")).toBe("45");

      await setOrientation(page, { bearing: 0, pitch: 0 });
      await toggleLayer(page, "globe");

      await expect.poll(() => params().has("g")).toBe(false);
      expect(params().has("b")).toBe(false);
      expect(params().has("t")).toBe(false);
    });

    test("the orientation saved on this device comes back on reload", async ({
      page,
    }) => {
      await setOrientation(page, { bearing: -75, pitch: 20 });
      await toggleLayer(page, "globe");
      await expect
        .poll(async () => (await readSavedState(page))["globeVisible"])
        .toBe(true);

      await gotoApp(page, "/");

      expect(await getOrientation(page)).toEqual({
        bearing: -75,
        pitch: 20,
        projection: "globe",
      });
    });

    test("combined URL params are applied together", async ({ page }) => {
      const year = (await knownYears(page))[0]!;

      await gotoApp(page, `/?y=${year}&v=000100000`);

      await expect(page.locator("#year-select")).toHaveValue(year);
      await expectToggle(layerButton(page, "heatmap"), false);
      await expectToggle(layerButton(page, "airports"), true);
    });
  });

  test("Reset view goes back to a first visit, saved and linked @heavy", async ({
    page,
  }) => {
    // About forty steps, the 3D view on the globe among them, where every
    // step takes a second in software WebGL with a browser per core: 35 s
    // on a desktop in CI, and up to 44 s (73 % of a minute) among the
    // phone's specs, which run it beside three other browsers rather than
    // in a heavy job of their own. The globe shades the relief at every
    // zoom, which this spec does not look at: without its tiles there is
    // nothing to shade, and the turn does not wait for them
    // (holdElevationTiles).
    test.setTimeout(90000);
    await holdElevationTiles(page);
    const mobile = await usesMobileBar(page);
    // Nothing to reset on a first visit: announced and dimmed, like Share
    // mode with nothing selected
    await expectResetAvailable(page, mobile, false);
    const years = await knownYears(page);
    const newest = await page.evaluate(() => window.mapApp!.selectedYear);
    expect(newest).toBe(String(Math.max(...years.map(Number))));
    // Another year when the data has one, and all of them otherwise
    const otherYear = years.find((year) => year !== newest) ?? "all";

    // Change everything Reset view covers: the filters first, since they
    // drop the selection
    await setYearFilter(page, otherYear);
    await waitForYearFilter(page, otherYear);
    const aircraft = await page
      .locator("#aircraft-select option:not([value='all'])")
      .first()
      .getAttribute("value");
    await setAircraftFilter(page, aircraft!);
    await waitForAircraftFilter(page, aircraft!);
    // A flight the filters keep
    await waitForPathData(page);
    const pathId = await page.evaluate(
      (registration) =>
        window.mapApp!.fullPathInfo!.find(
          (path) => path.aircraft_registration === registration,
        )!.id,
      aircraft!,
    );
    await togglePathSelection(page, pathId, 1);
    await toggleLayer(page, "heatmap");
    await toggleLayer(page, "airports");
    await toggleLayer(page, "aviation");
    await toggleLayer(page, "globe");
    if (mobile) {
      await openMobileSheet(page, "layers");
      await page.locator('.sheet-row[data-row="three-d"]').click();
      await closeMobileSheet(page);
    } else {
      await page.locator("#three-d-btn").click();
    }
    await expect(page.locator("#three-d-btn")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await setOrientation(page, { bearing: 70, pitch: 40 }, { idle: false });
    await expectResetAvailable(page, mobile, true);

    if (mobile) {
      await openMobileSheet(page, "more");
      await page.locator('.sheet-row[data-row="reset-view"]').click();
    } else {
      await page.getByRole("button", { name: /^Reset view/ }).click();
    }

    await waitForYearFilter(page, newest);
    await waitForAircraftFilter(page, "all");
    await expect(page.locator("#year-select")).toHaveValue(newest);
    await expect(page.locator("#aircraft-select")).toHaveValue("all");
    for (const [layer, on] of [
      ["heatmap", true],
      ["airports", true],
      ["altitude", false],
      ["aviation", false],
      ["globe", false],
    ] as const) {
      await expect(layerButton(page, layer), layer).toHaveAttribute(
        "aria-pressed",
        String(on),
      );
    }
    await expect(page.locator("#three-d-btn")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(await page.evaluate(() => window.mapApp!.selectedPathIds.size)).toBe(
      0,
    );

    // North up and flat over the bounds a first visit is fitted to, on a
    // phone above the bar as well
    await waitForMapReady(page);
    expect(await getOrientation(page)).toEqual({
      bearing: 0,
      pitch: 0,
      projection: "mercator",
    });
    const camera = await page.evaluate((phone) => {
      const app = window.mapApp!;
      const map = app.map!;
      const [[south, west], [north, east]] = app.config.bounds;
      const bar = phone
        ? parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
              "--mobile-bar-h",
            ),
          )
        : 0;
      const fit = map.cameraForBounds(
        [
          [west, south],
          [east, north],
        ],
        { padding: { top: 48, right: 48, bottom: 48 + bar, left: 48 } },
      )!;
      const center = map.getCenter();
      const target = fit.center as { lng: number; lat: number };
      return {
        zoom: [map.getZoom(), fit.zoom!],
        lng: [center.lng, target.lng],
        lat: [center.lat, target.lat],
      };
    }, mobile);
    for (const [actual, expected] of Object.values(camera)) {
      expect(actual).toBeCloseTo(expected!, 4);
    }
    // Once the fit is over, there is nothing left to reset
    await expectResetAvailable(page, mobile, false);

    // Saved and linked, so a reload opens on the same view
    await expect
      .poll(async () => {
        const saved = await readSavedState(page);
        return [
          saved["selectedYear"],
          saved["heatmapVisible"],
          saved["bearing"],
        ];
      })
      .toEqual([newest, true, 0]);
    const params = new URL(page.url()).searchParams;
    expect(params.get("y")).toBe(newest);
    for (const key of ["a", "p", "v", "g", "d", "b", "t"]) {
      expect(params.has(key), key).toBe(false);
    }
  });

  test("the satellite switch shows the imagery and its credit, kept in the link until Reset view", async ({
    page,
  }) => {
    const mobile = await usesMobileBar(page);
    const credit = attributionControl(page);
    await expect(credit).not.toContainText("EOxCloudless");

    await toggleLayer(page, "satellite");

    await expect.poll(() => satelliteOnMap(page)).toBe(true);
    await expect(credit).toContainText("EOxCloudless");
    await expect
      .poll(() => new URL(page.url()).searchParams.get("s"))
      .toBe("1");

    // The link opens with it on, and so does this device's saved state
    await gotoApp(page, new URL(page.url()).search);
    await expect(layerButton(page, "satellite")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect.poll(() => satelliteOnMap(page)).toBe(true);
    await expect(credit).toContainText("EOxCloudless");

    // Part of what a first visit shows, which has it off
    if (mobile) {
      await openMobileSheet(page, "more");
      await page.locator('.sheet-row[data-row="reset-view"]').click();
    } else {
      await page.getByRole("button", { name: /^Reset view/ }).click();
    }
    await expect(layerButton(page, "satellite")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect.poll(() => satelliteOnMap(page)).toBe(false);
    await expect(credit).not.toContainText("EOxCloudless");
    await expect
      .poll(() => new URL(page.url()).searchParams.has("s"))
      .toBe(false);
  });
});
