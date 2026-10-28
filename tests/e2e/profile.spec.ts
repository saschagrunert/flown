import { test, expect, type Page } from "./fixtures";
import {
  expectNoA11yViolations,
  gotoApp,
  selectFlightsForReplay,
  selectPathForReplay,
  toggleStatsPanel,
} from "./helpers";

/** The chart of the flight profile */
function plot(page: Page) {
  return page.locator("#flight-profile .profile-plot");
}

/** Where the airplane of the replay is, [lat, lon] */
function airplanePosition(page: Page): Promise<[number, number]> {
  return page.evaluate(() =>
    window.mapApp!.replayState.airplaneMarker!.position(),
  );
}

/** Press on the chart `from` of the way across and drag to `to` */
async function dragAcross(page: Page, from: number, to: number) {
  const box = (await plot(page).boundingBox())!;
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * from, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to, y, { steps: 8 });
  await page.mouse.up();
}

test.describe("Flight profile", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("shows the profile of one selected flight, and puts it away", async ({
    page,
  }) => {
    await selectPathForReplay(page);
    const profile = page.locator("#flight-profile");
    const toggle = page.locator("#profile-toggle-btn");

    await expect(profile).toBeVisible();
    await expect(profile.locator(".profile-stats")).toContainText("Highest");
    await expect(profile.locator(".profile-stats")).toContainText(
      "Lowest en route",
    );
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expectNoA11yViolations(page, "flight profile");

    // Pointing reads the values there
    const box = (await plot(page).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect(profile.locator(".profile-readout")).toContainText(" ft");

    await toggle.click();
    await expect(profile).toBeHidden();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(profile).toBeVisible();
  });

  test("beside the statistics the left column stops above the legend the profile lifts", async ({
    page,
  }) => {
    // Below about 1156 px beside the rail the legend stands on top of the
    // strip, and the column's icons ran over its title and scale. The
    // selection turns the altitude on (waitForPathData), whose legend is
    // the taller one.
    await page.setViewportSize({ width: 1000, height: 640 });
    await toggleStatsPanel(page);
    await selectPathForReplay(page);
    await expect(page.locator("#flight-profile")).toBeVisible();

    const legend = page.locator("#altitude-legend");
    await expect(legend).toBeVisible();
    const column = page.locator("#left-buttons");
    await expect
      .poll(async () => {
        const below = (await legend.boundingBox())!;
        const above = (await column.boundingBox())!;
        return above.y + above.height <= below.y;
      })
      .toBe(true);
  });

  test("draws two selected flights one after another, and opens their replay there", async ({
    page,
  }) => {
    await selectFlightsForReplay(page, 2);

    const profile = page.locator("#flight-profile");
    await expect(profile).toBeVisible();
    // Each flight named by its route over its part of the chart
    await expect(profile.locator(".profile-leg")).toHaveCount(2);
    await expect(profile.locator(".profile-leg").first()).toContainText("→");
    await expect(profile.locator(".profile-axis")).toContainText("2 flights");

    // Pointing reads the time into the flight there
    const box = (await plot(page).boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.995, box.y + box.height / 2);
    await expect(profile.locator(".profile-readout")).toContainText(" ft");

    // A click near the end opens the replay of both, paused in the second,
    // in the panel of the replay of one flight with the strip as its
    // timeline
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.locator("#replay-controls")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.locator("#replay-time-display")).toHaveText(
      /^2 of 2, .+ → .+: \d+:\d{2}(:\d{2})? in$/,
    );
    await expect(page.locator("#replay-play-btn")).toBeVisible();
    await expect(
      page.locator("#replay-controls #flight-profile"),
    ).toBeVisible();
    await expect(
      page.locator("#replay-controls #flight-profile .profile-cursor"),
    ).toHaveAttribute("visibility", "visible");
  });

  test("a drag on the profile opens replay there and moves the airplane", async ({
    page,
  }) => {
    await selectPathForReplay(page);
    await expect(page.locator("#flight-profile")).toBeVisible();

    await dragAcross(page, 0.2, 0.3);

    // Replay is open, paused where the drag let go, with the profile as
    // its scrubber. The strip moved into the replay panel as the drag
    // opened it, so where it let go is only roughly a quarter of the way.
    await expect(page.locator("#replay-controls")).toBeVisible();
    await expect(
      page.locator("#replay-controls #flight-profile"),
    ).toBeVisible();
    const state = () =>
      page.evaluate(() => ({
        time: window.mapApp!.replayState.currentTime,
        max: window.mapApp!.replayState.maxTime,
        playing: window.mapApp!.replayState.playing,
      }));
    await expect.poll(async () => (await state()).time).toBeGreaterThan(0);
    const first = await state();
    expect(first.playing).toBe(false);
    expect(first.time / first.max).toBeGreaterThan(0.1);
    expect(first.time / first.max).toBeLessThan(0.5);
    const before = await airplanePosition(page);

    await dragAcross(page, 0.5, 0.8);

    await expect
      .poll(async () => (await state()).time / first.max)
      .toBeGreaterThan(0.7);
    const after = await airplanePosition(page);
    expect(after).not.toEqual(before);
    // The replay's cursor stands where the airplane is
    await expect(
      page.locator("#flight-profile .profile-cursor"),
    ).toHaveAttribute("visibility", "visible");
  });
});
