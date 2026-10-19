/**
 * Replay of all flights: every flight of the filter starts at once and plays
 * at a hundred times its speed and more, drawn by a WebGL layer of its own,
 * with a clock that reads the time into every flight, at their height on a
 * map it tilts for them. The filters are held while it plays, and closing
 * it gives the page back as it was.
 */
import { test, expect } from "./fixtures";
import type { Page } from "./fixtures";
import {
  expectNoA11yViolations,
  gotoApp,
  openMobileSheet,
  toastMessage,
} from "./helpers";

const CLOCK = /^\d+:\d{2} into every flight$/;

/** What the layer of the replay has drawn: frames and the time of the last */
function drawn(page: Page): Promise<{ frames: number; time: number } | null> {
  return page.evaluate(() => {
    const layer = window.mapApp!.map!.getLayer("replay-all") as
      { implementation?: { frames: number; time: number } } | undefined;
    const drawing = layer?.implementation;
    return drawing ? { frames: drawing.frames, time: drawing.time } : null;
  });
}

/** The tilt of the map, which the replay sets while it plays */
function pitch(page: Page): Promise<number> {
  return page.evaluate(() => window.mapApp!.map!.getPitch());
}

test.describe("Replay all flights", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  // Playing and giving the page back are two tests: as one, the twenty-odd
  // steps of both ran out of the 30 s of a test in software WebGL on CI,
  // at the close of the replay
  test("plays every flight at once with a running clock, and holds the page", async ({
    page,
  }) => {
    const button = page.locator("#replay-all-btn");
    await button.click();

    const panel = page.locator("#replay-all-controls");
    await expect(panel).toBeVisible({ timeout: 10000 });
    await expect(button).toHaveAttribute("aria-pressed", "true");
    // Held while it plays, as for the replay of one flight
    await expect(page.locator("#year-select")).toBeDisabled();
    await expect(page.locator("#aircraft-select")).toBeDisabled();
    await expect(page.locator("#replay-btn")).toBeDisabled();

    // A minute of flight passes in a third of a second at 200 times
    const clock = page.locator("#replay-all-clock");
    await expect(clock).toHaveText(CLOCK);
    await expect(clock).not.toHaveText("0:00 into every flight", {
      timeout: 10000,
    });
    // And the layer draws the flights as far as the clock has come
    await expect
      .poll(async () => (await drawn(page))?.time ?? 0, { timeout: 10000 })
      .toBeGreaterThan(0);
    // At their height on the flat map too, which it tilts so they show
    await expect.poll(() => pitch(page)).toBe(50);
    const liftM = await page.evaluate(() => {
      const layer = window.mapApp!.map!.getLayer("replay-all") as
        | { implementation?: { style: () => { liftM: number } | null } }
        | undefined;
      return layer?.implementation?.style()?.liftM ?? 0;
    });
    expect(liftM).toBeGreaterThan(0);
    // The link keeps the tilt from before, not the replay's
    const search = await page.evaluate(() => {
      window.mapApp!.stateManager.flush();
      return location.search;
    });
    expect(search).not.toMatch(/[?&]t=/);
  });

  test("pauses with the clock held, and gives the page back as it was", async ({
    page,
  }) => {
    const button = page.locator("#replay-all-btn");
    await button.click();
    const panel = page.locator("#replay-all-controls");
    await expect(panel).toBeVisible({ timeout: 10000 });
    const clock = page.locator("#replay-all-clock");
    await expect(clock).not.toHaveText("0:00 into every flight", {
      timeout: 10000,
    });
    // Tilted, so laying it flat again below is the close's doing
    await expect.poll(() => pitch(page)).toBe(50);

    // Paused, the clock holds: half a second would be over a minute
    const play = page.locator("#replay-all-play-btn");
    await play.click();
    await expect(play).toHaveAttribute(
      "aria-label",
      "Play the replay of all flights",
    );
    const held = await clock.textContent();
    // Ten frames and half a second at least: software WebGL may draw no
    // frame in half a second, and a pause that does not hold would pass
    await Promise.all([
      page.waitForTimeout(500),
      page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let frames = 0;
            const step = (): void => {
              if (++frames >= 10) resolve();
              else requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          }),
      ),
    ]);
    await expect(clock).toHaveText(held!);
    // Paused and of the controls alone: a scan of the whole page while the
    // replay played drew a frame of every flight per step of axe, and took
    // the test above to 38 of its 45 s on CI
    await expectNoA11yViolations(page, "Replay all controls", (builder) =>
      builder.include("#replay-all-controls"),
    );

    await page.locator("#replay-all-close-btn").click();
    await expect(panel).toBeHidden();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(page.locator("#year-select")).toBeEnabled();
    expect(await drawn(page)).toBeNull();
    expect(await page.evaluate(() => window.mapApp!.replayActive)).toBe(false);
    // Laid flat again, as it was
    await expect.poll(() => pitch(page)).toBe(0);
  });

  test("scrubs the clock with its slider, and builds the heat up behind the flights", async ({
    page,
  }) => {
    await page.locator("#replay-all-btn").click();
    const slider = page.locator("#replay-all-time");
    await expect(slider).toBeVisible({ timeout: 10000 });
    await expect(slider).toHaveAttribute(
      "aria-label",
      "Time into every flight",
    );
    await expect(slider).toHaveAttribute("aria-valuetext", CLOCK);
    await expect(page.locator("#replay-all-speed option")).toHaveText([
      "100x",
      "200x",
      "300x",
      "500x",
      "1000x",
    ]);
    // The heat is the cloud's, drawn up to the clock on the flat map too
    const until = (): Promise<number | undefined> =>
      page.evaluate(() => {
        const layer = window.mapApp!.map!.getLayer("heat-cloud") as
          | { implementation?: { style: () => { until?: number } | null } }
          | undefined;
        return layer?.implementation?.style()?.until;
      });
    await expect.poll(until, { timeout: 10000 }).toBeGreaterThan(0);

    await page.locator("#replay-all-play-btn").click();
    await slider.focus();
    await page.keyboard.press("End");
    const clock = page.locator("#replay-all-clock");
    const end = await clock.textContent();
    await expect(slider).toHaveAttribute("aria-valuetext", end!);
    const atEnd = (await until())!;
    await expect.poll(async () => (await drawn(page))?.time).toBe(atEnd);

    // Backwards, a minute a press, the layer and the heat with it
    await page.keyboard.press("ArrowLeft");
    await expect.poll(until).toBeLessThan(atEnd);
    await page.keyboard.press("Home");
    await expect(clock).toHaveText("0:00 into every flight");
    await expect.poll(until).toBe(0);
    await expect.poll(async () => (await drawn(page))?.time).toBe(0);

    await page.locator("#replay-all-close-btn").click();
    expect(
      await page.evaluate(() => !!window.mapApp!.map!.getLayer("heat-cloud")),
    ).toBe(false);
  });

  test("closes on Escape and hands focus back to its control", async ({
    page,
  }) => {
    const button = page.locator("#replay-all-btn");
    await button.click();
    await expect(page.locator("#replay-all-controls")).toBeVisible({
      timeout: 10000,
    });

    await page.keyboard.press("Escape");

    await expect(page.locator("#replay-all-controls")).toBeHidden();
    await expect(button).toBeFocused();
  });

  test("keeps the orbit off under reduced motion, and says why", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#replay-all-btn").click();

    const orbit = page.locator("#replay-all-orbit-btn");
    await expect(orbit).toBeVisible({ timeout: 10000 });
    await orbit.click();

    await expect(orbit).toHaveAttribute("aria-pressed", "false");
    await expect(toastMessage(page, "reduced motion")).toBeVisible();
  });
});

test.describe("Replay all flights on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("starts from the More sheet, and the bar steps aside while it plays", async ({
    page,
  }) => {
    await gotoApp(page);
    await openMobileSheet(page, "more");
    await page.locator('.sheet-row[data-row="replay-all"]').click();

    await expect(page.locator("#replay-all-controls")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("#mobile-bar")).toHaveCount(0);
    // The slider shares the row of the controls under the clock
    const slider = (await page.locator("#replay-all-time").boundingBox())!;
    const speed = (await page.locator("#replay-all-speed").boundingBox())!;
    expect(slider.width).toBeGreaterThan(80);
    expect(
      Math.abs(slider.y + slider.height / 2 - speed.y - speed.height / 2),
    ).toBeLessThan(2);
    // Pushed to the right edge, the orbit stays clear of the close above it
    const orbit = (await page.locator("#replay-all-orbit-btn").boundingBox())!;
    const close = (await page.locator("#replay-all-close-btn").boundingBox())!;
    expect(orbit.y).toBeGreaterThanOrEqual(close.y + close.height - 0.5);

    await page.locator("#replay-all-close-btn").click();

    await expect(page.locator("#replay-all-controls")).toBeHidden();
    await expect(page.locator("#mobile-bar")).toHaveCount(1);
    await expect(page.locator("#mobile-tab-more")).toBeFocused();
  });
});
