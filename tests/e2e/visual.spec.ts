/**
 * Visual regression for the page's own chrome.
 *
 * styles.css is over three thousand lines and nothing checked what it
 * renders: a rule that moved a control off screen or collapsed a panel
 * passed every functional test. These snapshots cover the parts a
 * stylesheet change is most likely to break, and deliberately not the map
 * itself, which is a canvas of live data.
 *
 * They run in their own project so the rest of the suite keeps working
 * wherever it is run; the snapshots are generated in the Playwright
 * container, which is also where CI compares them (see CONTRIBUTING.md).
 *
 * That project drives visual-site/, built from the fixture flights of
 * tests/fixtures/visual/ with a fixed build stamp, and not docs/: the rail
 * and Wrapped print figures computed from the flights, and every snapshot
 * here is compared without any tolerance. With 1% of the pixels allowed to
 * differ, which the flights of data/ needed, a missing control row passed
 * and so did three stale snapshots.
 *
 * The map itself is hidden rather than masked in the snapshots of the
 * chrome: a mask over a full-viewport element covers the chrome along with
 * it. One snapshot is of the map instead, the heat cloud of the 3D view,
 * whose own shaders nothing else compares (see the last describe).
 */
import { test, expect } from "./fixtures";
import {
  gotoApp,
  openWrapped,
  settleAnimations,
  toggleStatsPanel,
  waitForPathData,
  waitForWrappedMap,
} from "./helpers";
import {
  heatCloudOnMap,
  hideChrome,
  hideMapData,
  homeField,
  jumpToView,
  mapIsIdle,
  waitForMapIdleEvent,
} from "./map";

/**
 * The year every snapshot is taken with. The fixture has a later year as
 * well, which the page would open on, so that the snapshots also cover a
 * year picked through the URL and a dropdown with more than one entry.
 */
const PINNED_YEAR = 2025;

/**
 * The pinned image renders the same page identically run after run, and the
 * fixture site never changes on its own, so any differing pixel is a change
 * to the look. `maxDiffPixels: 0` is Playwright's default, spelled out so
 * that the next tolerance somebody needs is an exception made here, in plain
 * sight. `threshold: 0` is not: by default a pixel only counts as different
 * once its colour moves by a fifth of the range, which let a grey hairline
 * vanish on white, or text fade from #666 to #999, with every snapshot green.
 */
const EXACT = {
  animations: "disabled",
  maxDiffPixels: 0,
  threshold: 0,
} as const;

test.describe("visual", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page, `/?y=${PINNED_YEAR}`);
    // A site without that year would fall back to another one and fail on
    // the pixels, which says nothing about why
    await expect(page.locator("#year-select")).toHaveValue(String(PINNED_YEAR));
    await hideMapData(page);
    await settleAnimations(page);
  });

  test("the control chrome at rest", async ({ page }) => {
    // Every control has to be in the frame. An earlier version masked
    // `#map`, which is `inset: 0` behind the whole page, so Playwright
    // painted its mask over the entire viewport and the snapshot was 1280
    // by 720 pixels of solid magenta: it passed for any stylesheet at all.
    await expect(page.locator("#left-buttons")).toBeVisible();
    await expect(page.locator("#right-buttons")).toBeVisible();

    await expect(page).toHaveScreenshot("chrome-at-rest.png", EXACT);
  });

  test("the statistics rail", async ({ page }) => {
    await toggleStatsPanel(page);
    const rail = page.locator("#stats-rail");
    await expect(rail).toBeVisible();
    await settleAnimations(page);

    await expect(rail).toHaveScreenshot("stats-rail.png", EXACT);
  });

  test("the Wrapped dialog", async ({ page }) => {
    const dialog = await openWrapped(page);
    // Without this the snapshot races the reveal
    await waitForWrappedMap(page);
    await settleAnimations(dialog);

    await expect(dialog).toHaveScreenshot("wrapped-dialog.png", EXACT);
  });
});

test.describe("visual, on the map", () => {
  // The heat cloud of the 3D view over the home field of the fixture, with
  // the flights on it. Everything in it is fixed: the fixture's flights,
  // the stubbed base map (a background colour) and flat elevation tiles
  // (fixtures.ts), the view, and a cloud without its pulses under the
  // reduced motion the suite asks for, drawn in the image's software
  // WebGL. The chrome is hidden (hideChrome): its own snapshot covers it,
  // and a change to it should not call for this one to be taken again.
  test("the heat cloud of the 3D view", async ({ page }) => {
    // Each wait may be on the elevation tiles of the tilted view, each a
    // pass of software WebGL, while the other snapshots are taken beside it
    test.setTimeout(150000);
    await gotoApp(page, `/?y=${PINNED_YEAR}`);
    await expect(page.locator("#year-select")).toHaveValue(String(PINNED_YEAR));
    await waitForPathData(page);
    await jumpToView(page, await homeField(page), 10);
    const threeD = page.locator("#three-d-btn");
    await threeD.click();
    await expect(threeD).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(async () => (await heatCloudOnMap(page)).drawn, { timeout: 60000 })
      .toBeGreaterThan(0);
    await expect.poll(() => mapIsIdle(page), { timeout: 60000 }).toBe(true);
    await waitForMapIdleEvent(page);
    await hideChrome(page);
    await settleAnimations(page);

    await expect(page).toHaveScreenshot("heat-cloud-3d.png", EXACT);
  });
});
