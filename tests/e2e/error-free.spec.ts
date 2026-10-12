import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";
import {
  activateReplay,
  attachErrorCollectors,
  gotoApp,
  openWrapped,
  readSavedState,
  relevantConsoleErrors,
  selectPathForReplay,
  toastMessage,
  toggleLayer,
  togglePathSelection,
  waitForAircraftFilter,
  waitForAppReady,
  waitForPathData,
  waitForYearFilter,
  type ErrorCollector,
  type LayerName,
} from "./helpers";
import {
  PATH_POLL,
  centerOnAirport,
  expectHeatmapPainted,
  focusAirportMarker,
  getZoom,
  mapSurfaceSize,
  pathColors,
  pathCount,
  setZoom,
  watchMapStills,
} from "./map";

/** Hex or rgb(a), as the app hands a colour to the map */
const COLOR_PATTERN = /^(#[0-9a-f]{6}|rgba?\(.+\))$/i;

/** The layer carries a gradient of valid colours */
function expectColorRamp(colors: string[]): void {
  expect(colors.length).toBeGreaterThan(0);
  for (const color of colors) expect(color).toMatch(COLOR_PATTERN);
  // A ramp, not one colour for every run
  expect(new Set(colors).size).toBeGreaterThan(1);
}

function expectClean(errors: ErrorCollector): void {
  expect(errors.pageErrors).toEqual([]);
  expect(errors.cspViolations).toEqual([]);
  expect(relevantConsoleErrors(errors)).toEqual([]);
}

test.describe("Error-Free Interactions", () => {
  let errors: ErrorCollector;

  test.beforeEach(async ({ page }) => {
    errors = await attachErrorCollectors(page);
    await gotoApp(page);
  });

  test.describe("Console Error-Free", () => {
    test("no errors during layer toggling @keys", async ({ page }) => {
      const layers: LayerName[] = [
        "heatmap",
        "altitude",
        "airspeed",
        "airports",
      ];
      for (const layer of layers) await toggleLayer(page, layer);
      for (const layer of layers) await toggleLayer(page, layer);

      expectClean(errors);
    });

    test("no errors during filter changes", async ({ page }) => {
      const yearSelect = page.locator("#year-select");
      const yearOptions = yearSelect.locator("option");
      expect(await yearOptions.count()).toBeGreaterThanOrEqual(3);
      const yearVal = (await yearOptions.nth(1).getAttribute("value"))!;
      await yearSelect.selectOption(yearVal);
      await waitForYearFilter(page, yearVal);

      const aircraftSelect = page.locator("#aircraft-select");
      const aircraftOptions = aircraftSelect.locator("option");
      expect(await aircraftOptions.count()).toBeGreaterThanOrEqual(2);
      const aircraftVal = (await aircraftOptions.nth(1).getAttribute("value"))!;
      await aircraftSelect.selectOption(aircraftVal);
      await waitForAircraftFilter(page, aircraftVal);

      await yearSelect.selectOption("all");
      await waitForYearFilter(page, "all");
      await aircraftSelect.selectOption("all");
      await waitForAircraftFilter(page, "all");

      expectClean(errors);
    });

    test("no errors during path selection and deselection", async ({
      page,
    }) => {
      const pathId = await selectPathForReplay(page);

      await togglePathSelection(page, pathId, 0);

      expectClean(errors);
    });

    test("no errors during replay lifecycle", async ({ page }) => {
      await activateReplay(page);

      await page.locator("#replay-play-btn").click();
      await expect(page.locator("#replay-pause-btn")).toBeVisible();
      await page.locator("#replay-pause-btn").click();
      await expect(page.locator("#replay-play-btn")).toBeVisible();
      await page.locator("#replay-stop-btn").click();
      await expect(page.locator("#replay-play-btn")).toBeVisible();

      await page.locator("#replay-btn").click();
      await expect(page.locator("#replay-controls")).toBeHidden();

      expectClean(errors);
    });

    test("no errors during wrapped modal lifecycle", async ({ page }) => {
      const modal = await openWrapped(page);

      await modal.locator(".close-btn").click();
      await expect(modal).toBeHidden();

      expectClean(errors);
    });

    test("no errors picking a flight from an airport popup", async ({
      page,
    }) => {
      await waitForPathData(page);
      const name = await page.evaluate(
        () => Object.keys(window.mapApp!.airportToPaths)[0]!,
      );
      await centerOnAirport(page, name, 10);
      await focusAirportMarker(page, name);
      await page.keyboard.press("Enter");
      await page.locator(".kh-popup-flight").first().click();
      await expect
        .poll(() => page.evaluate(() => window.mapApp!.selectedPathIds.size))
        .toBe(1);

      expectClean(errors);
    });

    test("no errors exporting an image with the real library", async ({
      page,
    }) => {
      const download = page.waitForEvent("download", { timeout: 20000 });
      await page.locator("#export-btn").click();

      expect((await download).suggestedFilename()).toMatch(/^heatmap_.*\.jpg$/);
      await expect(toastMessage(page, "Map exported")).toBeVisible();
      // The library clones the map into an SVG image; none of that may
      // trip the CSP, which allows no inline styles
      expectClean(errors);
    });

    test.describe("on a 1x screen", () => {
      test.use({ deviceScaleFactor: 1 });

      test("the exported map has the resolution of the image around it", async ({
        page,
      }) => {
        const before = await mapSurfaceSize(page);
        const stills = await watchMapStills(page);
        const download = page.waitForEvent("download", { timeout: 20000 });
        await page.locator("#export-btn").click();

        const jpeg = await readFile(await (await download).path());
        const exportedWidth = await page.evaluate(async (base64) => {
          const image = new Image();
          image.src = `data:image/jpeg;base64,${base64}`;
          await image.decode();
          return image.naturalWidth;
        }, jpeg.toString("base64"));

        // A desktop exports at 2x, and used to enlarge a 1x frame of the
        // map for it
        expect(exportedWidth).toBe(before.width * 2);
        expect(await stills()).toEqual([
          expect.objectContaining({
            naturalWidth: exportedWidth,
            width: before.width,
          }),
        ]);
        // The map itself is back at the screen's density
        expect(await mapSurfaceSize(page)).toEqual(before);
        expectClean(errors);
      });
    });

    test("no errors during stats panel toggle", async ({ page }) => {
      await page.locator("#stats-btn").click();
      await expect(page.locator("#stats-panel")).toBeVisible();

      await page.locator("#stats-btn").click();
      await expect(page.locator("#stats-panel")).toBeHidden();

      expectClean(errors);
    });
  });

  test.describe("Zoom Behavior", () => {
    test("zooming in updates heatmap without errors", async ({ page }) => {
      const zoom = await getZoom(page);
      await setZoom(page, zoom + 2);

      await expectHeatmapPainted(page);
      expectClean(errors);
    });

    test("zooming out updates heatmap without errors", async ({ page }) => {
      const zoom = await getZoom(page);
      await setZoom(page, Math.max(1, zoom - 3));

      await expectHeatmapPainted(page);
      expectClean(errors);
    });

    test("zooming preserves altitude path colors", async ({ page }) => {
      await waitForPathData(page);

      const before = await pathColors(page, "altitude");
      expectColorRamp(before);

      const zoom = await getZoom(page);
      await setZoom(page, zoom + 2);

      expect(await page.evaluate(() => window.mapApp!.altitudeVisible)).toBe(
        true,
      );
      // Zooming must redraw the same runs in the same colours
      expect(await pathColors(page, "altitude")).toEqual(before);
      expectClean(errors);
    });

    test("zooming preserves airspeed path colors", async ({ page }) => {
      await toggleLayer(page, "airspeed");
      await expect
        .poll(() => pathCount(page, "airspeed"), PATH_POLL)
        .toBeGreaterThan(0);

      const before = await pathColors(page, "airspeed");
      expectColorRamp(before);

      const zoom = await getZoom(page);
      await setZoom(page, zoom + 2);

      expect(await page.evaluate(() => window.mapApp!.airspeedVisible)).toBe(
        true,
      );
      expect(await pathColors(page, "airspeed")).toEqual(before);
      expectClean(errors);
    });

    test("zoom level is saved to state", async ({ page }) => {
      await page.evaluate(() => localStorage.removeItem("flown-state"));
      await page.reload();
      await waitForAppReady(page);

      await setZoom(page, 12);

      await expect
        .poll(async () => (await readSavedState(page))["zoom"])
        .toBe(12);
    });

    test("zoom level is restored on reload", async ({ page }) => {
      await page.evaluate(() => localStorage.removeItem("flown-state"));
      await page.reload();
      await waitForAppReady(page);

      await setZoom(page, 12);
      await expect
        .poll(async () => (await readSavedState(page))["zoom"])
        .toBe(12);

      await page.reload();
      await waitForAppReady(page);

      const zoom = await getZoom(page);
      expect(zoom).toBe(12);
    });
  });
});
