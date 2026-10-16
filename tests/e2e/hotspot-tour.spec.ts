/**
 * The hotspot tour (ui/hotspotTour.ts): the busiest places of the heat,
 * one after the other in the 3D view, with a caption for each and the way
 * back to the view it started from.
 *
 * The suite runs with reduced motion, under which the tour cuts to each
 * place and waits for the user to step on: nothing on the page moves or
 * goes away by itself, so no step here races an animation (see the Skip of
 * wrapped-intro.spec.ts). The flights and the turns are left to the unit
 * tests: in software WebGL they take as long as the machine makes them.
 *
 * The 3D view with the heat cloud, tilted over a place, is the slowest
 * thing the page draws. With a browser per core in CI the panel came up
 * 13 to 17 s after the click, and every step after it waited 5 to 6 s for
 * a frame: the state of the page is read in one go where it can be.
 */
import { test, expect, HEAVY, holdElevationTiles, type Page } from "./fixtures";
import { expectNoA11yViolations, gotoApp, readSavedState } from "./helpers";
import { getZoom } from "./map";

/** What every step waits for: a frame of the 3D view, and more */
const tourExpect = expect.configure({ timeout: 30000 });

/** A test of the tour: the panel, then a dozen steps of seconds each */
const TOUR_TEST_TIMEOUT_MS = 180000;

/** The tour as the page shows it, read in one evaluation */
function tourState(page: Page) {
  return page.evaluate(() => {
    const app = window.mapApp!;
    const byId = (id: string): HTMLElement | null =>
      document.getElementById(id);
    const text = (id: string): string => byId(id)?.textContent ?? "";
    const shown = (id: string): boolean => !!byId(id)?.checkVisibility();
    // Held: a select disabled, a button aria-disabled (ui/heldControls.ts)
    const disabled = (id: string): boolean =>
      !!byId(id)?.matches(':disabled, [aria-disabled="true"]');
    const live = byId("hotspot-tour-live");
    return {
      panel: shown("hotspot-tour"),
      pressed: byId("hotspot-tour-btn")?.getAttribute("aria-pressed"),
      focused: document.activeElement?.id ?? "",
      threeD: app.threeDVisible,
      // Rounded as getOrientation rounds it, and never -0
      pitch: Math.round(app.map!.getPitch() * 1e6) / 1e6 || 0,
      play: shown("hotspot-tour-play-btn"),
      yearHeld: disabled("year-select"),
      replayAllHeld: disabled("replay-all-btn"),
      count: text("hotspot-tour-count"),
      name: text("hotspot-tour-name"),
      detail: text("hotspot-tour-detail"),
      live: live?.textContent ?? "",
      liveMode: live?.getAttribute("aria-live"),
      previousDisabled: byId("hotspot-tour-previous-btn")?.getAttribute(
        "aria-disabled",
      ),
    };
  });
}

test.describe("Hotspot tour", HEAVY, () => {
  test.describe.configure({ timeout: TOUR_TEST_TIMEOUT_MS });

  test.beforeEach(async ({ page }) => {
    // The tour turns the 3D view on; the relief is not what is looked at
    await holdElevationTiles(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoApp(page);
  });

  test("steps through the busiest places, captioned, and goes back where it started", async ({
    page,
  }) => {
    const zoom = await getZoom(page);
    await page.locator("#hotspot-tour-btn").click();

    await tourExpect(page.locator("#hotspot-tour")).toBeVisible();
    // In the 3D view, tilted over the busiest place, and nothing to pause;
    // held while it runs, as for a replay. A place and the time spent
    // there: a total, never a date or an hour, read out as it comes.
    await tourExpect
      .poll(() => tourState(page))
      .toMatchObject({
        pressed: "true",
        threeD: true,
        play: false,
        yearHeld: true,
        replayAllHeld: true,
        count: expect.stringMatching(/^1 of [1-5]$/),
        name: expect.stringMatching(/./),
        detail: expect.stringMatching(
          /^[\d,]+ (s|min|h)( \d+ min)?, (\d+%|under 1%) of the time$/,
        ),
        liveMode: "polite",
        live: expect.stringMatching(/^1 of \d: .+ of the time$/),
        focused: "hotspot-tour-next-btn",
      });
    const first = await tourState(page);
    expect(first.pitch).toBeGreaterThan(30);
    await expectNoA11yViolations(page, "hotspot tour");

    const places = Number(first.count.split(" of ")[1]);
    if (places > 1) {
      await page.locator("#hotspot-tour-next-btn").click();
      await tourExpect
        .poll(() => tourState(page))
        .toMatchObject({
          count: `2 of ${places}`,
          live: expect.stringMatching(new RegExp(`^2 of ${places}: `)),
          previousDisabled: "false",
        });
    }
    // The link and the saved state keep the view it started from: a save
    // now, the one the share action makes, rather than the debounced one
    await page.evaluate(() => window.mapApp!.stateManager.flush());
    const saved = await readSavedState(page);
    expect(saved["threeDVisible"]).toBe(false);
    expect(saved["pitch"]).toBe(0);
    // In the unit of links, as getZoom reads it
    expect(saved["zoom"] as number).toBeCloseTo(zoom, 1);

    await page.locator("#hotspot-tour-stop-btn").click();

    await tourExpect
      .poll(() => tourState(page))
      .toMatchObject({
        panel: false,
        pressed: "false",
        focused: "hotspot-tour-btn",
        yearHeld: false,
        threeD: false,
        pitch: 0,
      });
    expect(await getZoom(page)).toBeCloseTo(zoom, 1);
  });

  test("stops on Escape", async ({ page }) => {
    await page.locator("#hotspot-tour-btn").click();
    await tourExpect(page.locator("#hotspot-tour")).toBeVisible();

    await page.keyboard.press("Escape");

    await tourExpect
      .poll(() => tourState(page))
      .toMatchObject({ panel: false, focused: "hotspot-tour-btn" });
  });
});

test.describe("Hotspot tour on a phone", HEAVY, () => {
  test.describe.configure({ timeout: TOUR_TEST_TIMEOUT_MS });
  test.use({ viewport: { width: 390, height: 844 } });

  test("starts from the More sheet, and the bar steps aside for it", async ({
    page,
  }) => {
    await holdElevationTiles(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await gotoApp(page);
    await page.locator("#mobile-tab-more").click();
    await expect(page.locator("#mobile-sheet")).toBeVisible();
    await page.locator('.sheet-row[data-row="hotspot-tour"]').click();

    await tourExpect(page.locator("#hotspot-tour")).toBeVisible();
    // As for a replay: the panel takes the bottom edge
    await tourExpect(page.locator("#mobile-bar")).toHaveCount(0);

    await page.locator("#hotspot-tour-stop-btn").click();

    await tourExpect(page.locator("#hotspot-tour")).toBeHidden();
    await tourExpect(page.locator("#mobile-bar")).toBeVisible();
    await tourExpect(page.locator("#mobile-tab-more")).toBeFocused();
  });
});
