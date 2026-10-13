/**
 * Replay, Wrapped and the statistics panel are fetched only when they are
 * used.
 *
 * They are a large part of the frontend and most visits open none of them,
 * so replay and Wrapped are each built into a bundle of its own, and its
 * styles into a stylesheet of its own, that the page imports on demand; the
 * statistics panel rides in the Wrapped bundle. The saving is only real if a
 * first visit fetches none of them, and a feature only works if both of its
 * files arrive when it is opened, so both halves are checked here. Opening
 * Wrapped says nothing about replay, so it must not fetch replay's files
 * either: not under the reduced motion the suite runs with, where Wrapped
 * plays no intro over the heat cloud of the feature bundle.
 */
import { test, expect } from "./fixtures";
import {
  attachErrorCollectors,
  gotoApp,
  openWrapped,
  toastMessage,
  toggleStatsPanel,
  usesMobileBar,
  waitForAppReady,
  waitForPathData,
  waitForStatsContent,
} from "./helpers";
import { mapPopup, openAirportPopup } from "./map";
import type { Page } from "./fixtures";

const FEATURES = "features.bundle.js";
const FEATURES_CSS = "features.css";
const WRAPPED = "wrapped.bundle.js";
const WRAPPED_CSS = "wrapped.css";
/** The phone's sheet and the export, which a desktop fetches on Export */
const EXTRAS = "extras.bundle.js";

/** The requests the page made so far for a bundle, retries included */
function trackBundleRequests(page: Page, name: string): string[] {
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(`/${name}`)) requested.push(request.url());
  });
  return requested;
}

/** The requests the page made so far for a stylesheet */
function trackCssRequests(page: Page, name: string): string[] {
  const requested: string[] = [];
  page.on("request", (request) => {
    // A bundle's source map may carry the name as well, so match the end
    // of the path, which the build it belongs to follows as a query
    // (versioned in services/lazyImport.ts)
    if (new URL(request.url()).pathname.endsWith(`/${name}`)) {
      requested.push(request.url());
    }
  });
  return requested;
}

test.describe("the lazy bundles", () => {
  test("are not fetched by a visit that opens neither feature", async ({
    page,
  }) => {
    const requested = [
      ...[FEATURES, WRAPPED, EXTRAS].map((name) =>
        trackBundleRequests(page, name),
      ),
      ...[FEATURES_CSS, WRAPPED_CSS].map((name) =>
        trackCssRequests(page, name),
      ),
    ];

    await gotoApp(page);
    await waitForAppReady(page);
    // Exercise the parts of the map that stay in the main bundle
    await page.locator("#heatmap-btn").click();
    await page.locator("#airports-btn").click();

    expect(requested.flat()).toEqual([]);
    // ... and the replay control still says whether replay is possible,
    // which is what the main bundle has to answer on its own
    await expect(page.locator("#replay-btn")).toHaveAttribute(
      "title",
      "Pick flights with timing data to replay, under Statistics, Flights",
    );
  });

  test("bring Wrapped when it is opened, only once and without replay", async ({
    page,
  }) => {
    const requested = trackBundleRequests(page, WRAPPED);
    const features = trackBundleRequests(page, FEATURES);
    const featuresCss = trackCssRequests(page, FEATURES_CSS);
    await gotoApp(page);
    await waitForAppReady(page);

    const dialog = await openWrapped(page);
    await expect(dialog).toBeVisible();

    expect(requested).toHaveLength(1);

    // Closing and reopening must not fetch it again
    await dialog.locator(".close-btn").click();
    await expect(dialog).toBeHidden();
    await expect(await openWrapped(page)).toBeVisible();

    expect(requested).toHaveLength(1);
    expect(features).toEqual([]);
    expect(featuresCss).toEqual([]);
  });

  test("share one copy of the modules with the main bundle", async ({
    page,
  }) => {
    const shared: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/shared.bundle.js")) {
        shared.push(request.url());
      }
    });
    await gotoApp(page);
    await waitForAppReady(page);
    await openWrapped(page);

    // The DOM cache is a singleton the app invalidates; a second copy inside
    // a lazy bundle would quietly hold stale elements. A module is
    // instantiated once per URL, so each lazy bundle importing the chunk
    // the app already loaded is what gives them all the same instance.
    for (const name of [FEATURES, WRAPPED, EXTRAS]) {
      const bundle = await page.request.get(new URL(name, page.url()).href);
      expect(await bundle.text()).toContain('"./shared.bundle.js"');
    }
    expect(shared).toHaveLength(1);
  });

  test("load Wrapped on the next try after a failed one", async ({ page }) => {
    const errors = await attachErrorCollectors(page);
    const requested = trackBundleRequests(page, WRAPPED);
    await gotoApp(page);
    await waitForAppReady(page);
    // A network blip, or a deploy replacing the file, on the first request
    let failed = false;
    await page.route(`**/${WRAPPED}*`, (route) => {
      if (failed) return route.continue();
      failed = true;
      return route.abort();
    });

    const mobile = await usesMobileBar(page);
    await page.locator(mobile ? "#mobile-tab-wrapped" : "#wrapped-btn").click();
    await expect(
      toastMessage(page, "its code could not be loaded"),
    ).toBeVisible();

    // A browser may keep the failure of that URL for the life of the page;
    // the retry must reach the server anyway
    await expect(await openWrapped(page)).toBeVisible();
    expect(requested).toHaveLength(2);
    expect(requested[1]).not.toBe(requested[0]);

    expect(errors.pageErrors).toEqual([]);
  });

  test("bring Wrapped's stylesheet, and neither panel shows before", async ({
    page,
  }) => {
    const css = trackCssRequests(page, WRAPPED_CSS);
    await gotoApp(page);
    await waitForAppReady(page);

    // Both panels are in the markup from the first paint. Their layout is in
    // features.css and wrapped.css, so styles.css has to hide them on its
    // own until those land
    await expect(page.locator("#replay-controls")).toBeHidden();
    await expect(page.locator("#wrapped-modal")).toBeHidden();
    expect(css).toEqual([]);

    const dialog = await openWrapped(page);
    await expect(dialog).toBeVisible();

    expect(css).toHaveLength(1);
    // Applied, not merely fetched: this display only exists in wrapped.css
    const styled = await page
      .locator("#wrapped-container")
      .evaluate((el) => getComputedStyle(el).display);
    expect(styled).toBe("flex");
  });

  test("bring the statistics panel with the Wrapped bundle, once", async ({
    page,
  }) => {
    const requested = trackBundleRequests(page, WRAPPED);
    const css = trackCssRequests(page, WRAPPED_CSS);
    const features = trackBundleRequests(page, FEATURES);
    await gotoApp(page);
    await waitForAppReady(page);

    await toggleStatsPanel(page);
    const panel = page.locator("#stats-panel");
    await expect(panel).toContainText("Flights");
    // Styled, not merely filled: the lead figures' grid is in wrapped.css
    const lead = await panel
      .locator(".stats-lead")
      .evaluate((el) => getComputedStyle(el).display);
    expect(lead).toBe("grid");
    expect(requested).toHaveLength(1);
    expect(css).toHaveLength(1);

    // Closing and opening again, and Wrapped after it, fetch nothing more
    await toggleStatsPanel(page);
    await toggleStatsPanel(page);
    await expect(await openWrapped(page)).toBeVisible();
    expect(requested).toHaveLength(1);
    expect(css).toHaveLength(1);
    expect(features).toEqual([]);
  });

  test("close the statistics after a failed load, and load them on the next try", async ({
    page,
  }) => {
    const errors = await attachErrorCollectors(page);
    await gotoApp(page);
    await waitForAppReady(page);
    let failed = false;
    await page.route(`**/${WRAPPED}*`, (route) => {
      if (failed) return route.continue();
      failed = true;
      return route.abort();
    });

    const mobile = await usesMobileBar(page);
    await page.locator(mobile ? "#mobile-tab-stats" : "#stats-btn").click();
    await expect(
      toastMessage(page, "their code could not be loaded"),
    ).toBeVisible();
    await expect(page.locator("#stats-rail")).toBeHidden();

    await page.locator(mobile ? "#mobile-tab-stats" : "#stats-btn").click();
    await expect(await waitForStatsContent(page)).toContainText("Flights");
    expect(errors.pageErrors).toEqual([]);
  });

  test("list an airport's flights without fetching either bundle", async ({
    page,
  }) => {
    const requested = [FEATURES, WRAPPED].map((name) =>
      trackBundleRequests(page, name),
    );
    const css = [FEATURES_CSS, WRAPPED_CSS].map((name) =>
      trackCssRequests(page, name),
    );
    await gotoApp(page);
    await waitForPathData(page);
    const airport = await page.evaluate(
      () =>
        Object.entries(window.mapApp!.airportToPaths).sort(
          (a, b) => b[1].size - a[1].size,
        )[0]![0],
    );

    await openAirportPopup(page, airport);

    // The list used to be part of the feature bundle, which the first
    // popup fetched with its stylesheet
    await expect(mapPopup(page).locator(".popup-flight").first()).toBeVisible();
    expect(requested.flat()).toEqual([]);
    expect(css.flat()).toEqual([]);
  });
});
