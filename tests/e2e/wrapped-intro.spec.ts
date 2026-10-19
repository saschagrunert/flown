/**
 * Wrapped's intro (ui/wrappedIntro.ts): the flight over the heat cloud that
 * opens the dialog from its button, over the whole dialog, with every
 * flight of the year playing underneath, its Skip, the map settling into
 * its panel beside the cards, and what it leaves behind: nothing in the
 * link or the saved state, and the user's view, globe and 3D switches back
 * once the dialog closes.
 *
 * The suite runs with reduced motion, under which the intro does not play,
 * so these ask for motion. The camera itself is left to the unit tests: a
 * flight in software WebGL takes as long as the machine makes it.
 */
import { test, expect, type Page } from "./fixtures";
import { gotoApp, readSavedState, waitForAppReady } from "./helpers";
import {
  getOrientation,
  getZoom,
  heatCloudOnMap,
  heatmapOnMap,
  setOrientation,
  waitForMapReady,
} from "./map";

test.use({ reducedMotion: "no-preference" });

/**
 * The dialog counts as hidden once its fade has run, and with motion on that
 * takes three or four frames of the map, each of which software WebGL on a
 * busy CI runner can take seconds to hand back (a close took 6.6 s there)
 */
const CLOSED = { timeout: 20_000 };

/**
 * Open Wrapped from its button, as a user does, which plays the intro.
 *
 * The button fetches the heat cloud's code once the pointer has rested on
 * it a moment (prepareWrappedIntro, PICK_INTENT_MS), and the intro waits
 * for that code only so long
 * (INTRO_WAIT_MS, a second) before Wrapped opens without it. A click at
 * once raced that fetch, which on a busy CI runner took longer, and the
 * intro then never flew. So the pointer rests on the button until the
 * feature bundle and its stylesheet are in, the way a user's pointer
 * does on its way to the click. Polled from here: waitForFunction takes a
 * promise for a truthy answer and stops at once, whatever it resolves to.
 */
async function openWithIntro(page: Page) {
  const button = page.locator("#wrapped-btn");
  await button.hover();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          // The stylesheet the app adds as it imports the feature bundle
          // (services/stylesheet.ts). Its URL carries the build as its
          // query, as the bundle's does (versioned in
          // services/lazyImport.ts), and both sit next to the page. The
          // browser's resource timing is no place to look the bundle up:
          // it keeps 250 entries, and the tiles can push it out.
          const link = document.querySelector<HTMLLinkElement>(
            'link[data-href="./features.css"]',
          );
          if (!link) return false;
          const { search } = new URL(link.href);
          // The module the app imports, under the same URL, so the same
          // module, run once: resolved once it has been fetched and run
          await import(
            new URL(`./features.bundle.js${search}`, link.href).href
          );
          // The stylesheet has a sheet once loaded
          return !!link.sheet;
        }),
      { timeout: 15000 },
    )
    .toBe(true);
  await button.click();
  const modal = page.locator("#wrapped-modal");
  await expect(modal).toBeVisible({ timeout: 5000 });
  return modal;
}

/** What the page saw as it pressed Skip in the middle of the flight */
interface SkippedMidFlight {
  /** The camera was moving, and the flights played underneath */
  flying: boolean;
  replayAll: boolean;
  /** The intro's globe and cloud were up */
  globe: boolean;
  forcedHeatCloud: boolean;
  /** Skip was shown, and a pointer at its middle would have hit it */
  visible: boolean;
  hit: boolean;
  /** The map had the dialog to itself, over the column of the cards */
  covers: boolean;
}

/**
 * Press Skip once the camera has set off: in the task that starts the
 * flight (WrappedIntro.fly), which takes the dark off the map while the
 * dialog is still in its intro, and where the flights of the year start
 * to play underneath. From here a click would wait for Skip to hold still
 * over two frames, and in software WebGL those are slow enough for the
 * flight to end first and take Skip away; pressed from the page in the
 * same task, the intro is certain to be flying. A DOM click skips the
 * checks a pointer gets, so the page makes them itself: Skip is visible
 * and nothing covers its middle. Resolves to what the page saw, once it
 * has pressed Skip.
 */
async function skipMidFlight(page: Page) {
  await page.evaluate(() => {
    const skip = document.getElementById("wrapped-skip-btn")!;
    const modal = document.getElementById("wrapped-modal")!;
    const container = document.getElementById("wrapped-map-container")!;
    const seen = window as unknown as { skippedMidFlight?: SkippedMidFlight };
    new MutationObserver((_, observer) => {
      // The end of the intro takes the dark away as well, and the intro
      // with it
      if (
        !modal.classList.contains("is-intro") ||
        container.classList.contains("is-dark")
      ) {
        return;
      }
      observer.disconnect();
      const app = window.mapApp!;
      const map = app.map!;
      const box = skip.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      const panel = container.getBoundingClientRect();
      const cards = document
        .getElementById("wrapped-cards-column")!
        .getBoundingClientRect();
      seen.skippedMidFlight = {
        flying: map.isMoving(),
        replayAll: !!map.getLayer("replay-all"),
        globe: app.globeVisible,
        forcedHeatCloud: app.store.get("forcedHeatCloud"),
        visible: skip.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        }),
        hit: !!hit && skip.contains(hit),
        covers: panel.left <= cards.left && panel.right > cards.right,
      };
      skip.click();
    }).observe(container, { attributes: true, attributeFilter: ["class"] });
  });
  return () =>
    page.evaluate(
      () =>
        (window as unknown as { skippedMidFlight?: SkippedMidFlight })
          .skippedMidFlight ?? null,
    );
}

test.describe("Wrapped's intro", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
    await waitForAppReady(page);
    await waitForMapReady(page);
    await setOrientation(page, { bearing: 30, pitch: 20 });
  });

  test("is skipped in the middle of its flight, and the view comes back as the dialog closes", async ({
    page,
  }) => {
    // The flight sets off once the far view is drawn, which takes seconds
    // of software WebGL on a loaded runner
    test.setTimeout(60000);
    const zoom = await getZoom(page);
    const skipped = await skipMidFlight(page);
    const modal = await openWithIntro(page);
    const skip = page.locator("#wrapped-skip-btn");
    await expect.poll(skipped, { timeout: 30000 }).toEqual({
      flying: true,
      replayAll: true,
      globe: true,
      forcedHeatCloud: true,
      visible: true,
      hit: true,
      covers: true,
    });

    // Wrapped as it opens without the intro: the cards, the flat overview
    // north up, no globe and no cloud
    await expect(skip).toBeHidden();
    await expect(modal).not.toHaveClass(/is-intro/);
    await expect(page.locator("#wrapped-stats .stat-card").first()).toBeVisible(
      { timeout: 15000 },
    );
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 0, pitch: 0, projection: "mercator" });
    expect((await heatCloudOnMap(page)).onMap).toBe(false);
    // The flights that played underneath are gone, and were never a replay
    // of the map
    expect(
      await page.evaluate(() => ({
        onMap: !!window.mapApp!.map!.getLayer("replay-all"),
        replayActive: window.mapApp!.replayActive,
      })),
    ).toEqual({ onMap: false, replayActive: false });
    // Focus stays in the dialog
    await expect(modal.locator(".close-btn")).toBeFocused();

    await modal.locator(".close-btn").click();
    await expect(modal).toBeHidden(CLOSED);
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 30, pitch: 20, projection: "mercator" });
    await expect.poll(() => getZoom(page)).toBeCloseTo(zoom, 5);
  });

  test("plays to its end, and the map settles into its panel beside the cards", async ({
    page,
  }) => {
    // Ten seconds of flight on timers, whatever the frames software WebGL
    // on a loaded runner draws in them, after the far view is drawn: the
    // waits are half as long again as for the six it was
    test.setTimeout(90000);
    const modal = await openWithIntro(page);
    await expect(modal).toHaveClass(/is-intro/);
    // Over once the map has settled in its panel
    await expect(modal).not.toHaveClass(/is-(intro|settling)/, {
      timeout: 45000,
    });
    await expect(page.locator("#wrapped-skip-btn")).toBeHidden();
    const placed = await page.evaluate(() => {
      const map = window.mapApp!.map!;
      const panel = document
        .getElementById("wrapped-map-container")!
        .getBoundingClientRect();
      const cards = document
        .getElementById("wrapped-cards-column")!
        .getBoundingClientRect();
      return {
        beside: panel.left >= cards.right,
        // Measured in its panel: the canvas is as wide as the panel
        measured: Math.abs(map.getCanvas().clientWidth - panel.width) <= 1,
        padding: map.getPadding(),
      };
    });
    expect(placed).toEqual({
      beside: true,
      measured: true,
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    // On the projection of before and the flat heatmap, as after a skip:
    // the globe and the cloud were the intro's, and the cloud has faded
    // out over the heatmap
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 0, pitch: 0, projection: "mercator" });
    await expect
      .poll(() => heatCloudOnMap(page))
      .toMatchObject({ onMap: false, stepsIn: false });
    expect(await heatmapOnMap(page)).toBe(true);
    await expect(
      page.locator("#wrapped-stats .stat-card").first(),
    ).toBeVisible();

    await modal.locator(".close-btn").click();
    await expect(modal).toBeHidden(CLOSED);
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 30, pitch: 20, projection: "mercator" });
    expect(await page.evaluate(() => window.mapApp!.map!.getPadding())).toEqual(
      { top: 0, right: 0, bottom: 0, left: 0 },
    );
  });

  test("keeps its globe and cloud out of the link and the saved state, and takes them away on close", async ({
    page,
  }) => {
    const modal = await openWithIntro(page);

    // The intro draws the cloud over the globe with the 3D view off, until
    // it settles
    await expect
      .poll(() => getOrientation(page).then((view) => view.projection), {
        timeout: 15000,
      })
      .toBe("globe");
    await expect
      .poll(() => heatCloudOnMap(page), { timeout: 15000 })
      .toMatchObject({ onMap: true, stepsIn: true });
    expect(await page.evaluate(() => window.mapApp!.threeDVisible)).toBe(false);

    // A save while it is open writes the user's switches and view: the one
    // the share action makes, rather than waiting for the debounce
    await page.evaluate(() => window.mapApp!.stateManager.flush());
    const saved = await readSavedState(page);
    expect(saved["wrappedVisible"]).toBe(true);
    expect(saved["globeVisible"]).toBe(false);
    expect(saved["threeDVisible"]).toBe(false);
    expect(saved).toMatchObject({ bearing: 30, pitch: 20 });
    const link = new URL(page.url()).searchParams;
    expect(link.has("g")).toBe(false);
    expect(link.has("d")).toBe(false);

    await modal.locator(".close-btn").click();
    await expect(modal).toBeHidden(CLOSED);
    await expect
      .poll(() => getOrientation(page))
      .toMatchObject({ bearing: 30, pitch: 20, projection: "mercator" });
    await expect
      .poll(() => heatCloudOnMap(page))
      .toMatchObject({ onMap: false, stepsIn: false });
    expect(new URL(page.url()).searchParams.has("g")).toBe(false);
  });
});
