/**
 * The data the page opens on is preloaded, and fetched once.
 *
 * The template asks for the two index files and the latest year before
 * MapLibre and the bundle have run. The loader's fetch() then has to take
 * those responses instead of downloading the largest file of the page a
 * second time, which it only does when the preload and the fetch agree on
 * the URL and on the request mode (the `crossorigin` on the link).
 */
import { test, expect } from "./fixtures";
import { waitForPathData } from "./helpers";
import { attributionControl } from "./map";

test("the first data files are preloaded and fetched once", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => {
    const file = request.url().split("/data/")[1];
    if (file?.endsWith(".json")) requested.push(file);
  });

  await page.goto("/index.html");
  await waitForPathData(page);

  const latest = await page.evaluate(() =>
    Math.max(...window.mapApp!.siteData.metadata!.available_years),
  );
  const preloaded = await page
    .locator('link[rel="preload"][as="fetch"]:not([href^="https:"])')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(preloaded).toEqual([
    "data/metadata.json",
    "data/airports.json",
    `data/${latest}/data.json`,
  ]);
  expect(requested.sort()).toEqual(
    [`${latest}/data.json`, "airports.json", "metadata.json"].sort(),
  );
});

test("CARTO's style and tile index are preloaded as the page asks for them @keys", async ({
  page,
}) => {
  const styles: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/dark-matter-gl-style/style.json")) {
      styles.push(request.url());
    }
  });

  await page.goto("/index.html");
  await waitForPathData(page);
  // The base style has arrived and gone under the flights
  await expect(attributionControl(page)).toContainText("CARTO");

  // With the site's key, or without one when it has none (baseStyle.ts)
  const key = await page.evaluate(() => window.MAP_CONFIG!.cartoApiKey);
  const query = key ? `?key=${encodeURIComponent(key)}` : "";
  const preloaded = await page
    .locator('link[rel="preload"][as="fetch"][href^="https:"]')
    .evaluateAll((links) =>
      links.map((link) => [
        link.getAttribute("href"),
        link.getAttribute("crossorigin"),
      ]),
    );
  expect(preloaded).toEqual([
    [
      `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json${query}`,
      "",
    ],
    [
      `https://tiles.basemaps.cartocdn.com/vector/carto.streets/v1/tiles.json${query}`,
      "",
    ],
  ]);
  // The app's fetch took the preload rather than asking again
  expect(styles).toEqual([preloaded[0]![0]]);
});

test("the modules the app imports are preloaded", async ({ page }) => {
  await page.goto("/index.html");

  // The chunk the bundle shares with the lazy ones, and the map library:
  // both are needed before anything draws, and neither is discovered until
  // the bundle has been parsed. The two workers are started only once those
  // have run.
  const preloaded = await page
    .locator('link[rel="modulepreload"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  expect(preloaded).toEqual([
    "./shared.bundle.js",
    "./vendor/maplibre-gl.mjs",
    "./yearWorker.bundle.js",
    "./vendor/maplibre-gl-worker.mjs",
  ]);
});
