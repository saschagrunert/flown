/**
 * Your flights with the real build: Pyodide from its CDN, lxml, the site's
 * Python from flown-src.zip, the airport database from GitHub Pages and the
 * elevation tiles from AWS, all fetched by the worker. Some 10 MB and a
 * minute or two, from hosts the hermetic suite blocks, so this runs only
 * when asked for with FLOWN_E2E_PYODIDE=1 (the routes of the page let those
 * hosts through, ahead of the context's block). The flow around the build
 * is covered without it in local-flights.spec.ts.
 */

import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";
import { gotoApp, waitForAppReady } from "./helpers";

const FIXTURES = [
  "tests/fixtures/visual/1_DEAGJ_DA20.kml",
  "tests/fixtures/visual/49_DEHYL_DA40.kml",
];
const BUILD_HOSTS = [
  "cdn.jsdelivr.net",
  "davidmegginson.github.io",
  "s3.amazonaws.com",
];

test.describe("Your flights, built with Pyodide @desktop", () => {
  test.skip(
    process.env["FLOWN_E2E_PYODIDE"] !== "1",
    "set FLOWN_E2E_PYODIDE=1 to fetch Pyodide and run the real build",
  );
  test.setTimeout(300_000);

  test("builds two dropped flights and shows them", async ({ page }) => {
    await page.route(
      (url) => BUILD_HOSTS.includes(url.hostname),
      (route) => route.continue(),
    );
    await gotoApp(page);
    await page.locator("#local-flights-btn").click();
    await expect(page.locator("#local-flights")).toBeVisible();

    const reloaded = page.waitForEvent("load", { timeout: 280_000 });
    await page.locator('#local-flights input[type="file"]').setInputFiles(
      await Promise.all(
        FIXTURES.map(async (path) => ({
          name: path.split("/").pop()!,
          mimeType: "application/vnd.google-earth.kml+xml",
          buffer: await readFile(path),
        })),
      ),
    );
    await reloaded;
    await waitForAppReady(page);

    await expect(page.locator(".local-flights-shown")).toHaveText(
      "Showing your 2 flights from 2 files",
    );
    expect(await page.evaluate(() => window.mapApp!.config.dataDir)).toBe(
      "local",
    );
    expect(
      await page.evaluate(() => window.mapApp!.currentData!.path_info.length),
    ).toBe(2);
    // The flights are the fixture's: from Halle-Oppin, in 2025
    expect(
      await page.evaluate(
        () => window.mapApp!.siteData.metadata!.available_years,
      ),
    ).toEqual([2025]);
    expect(
      await page.evaluate(() =>
        window.mapApp!.siteData.airports!.map((a) => a.code).sort(),
      ),
    ).toContain("EDAQ");
  });
});
