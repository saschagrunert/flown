import { test, expect, HEAVY } from "./fixtures";
import {
  activateReplay,
  gotoApp,
  playUntilProgress,
  toastMessage,
  waitForPathData,
} from "./helpers";
import {
  centerOnAirport,
  expectHeatUnderPaths,
  expectPopupAboveAirplane,
  mapMarkers,
  mapPopupContent,
  openAirportPopup,
} from "./map";

test.describe("Replay", () => {
  test.beforeEach(async ({ page }) => {
    await gotoApp(page);
  });

  test("replay button explains the precondition instead of doing nothing", async ({
    page,
  }) => {
    await waitForPathData(page);
    const replayBtn = page.locator("#replay-btn");
    await expect(replayBtn).toHaveAttribute(
      "title",
      "Pick flights with timing data to replay, under Flights in the statistics",
    );

    // The button is actionable even when replay is unavailable
    await replayBtn.click({ force: true });

    await expect(
      toastMessage(
        page,
        "Pick flights with timing data to replay, under Flights in the statistics",
      ),
    ).toBeVisible();
    // Screen readers hear it through the persistent status region
    await expect(page.locator("#toast-status")).toHaveText(
      "Pick flights with timing data to replay, under Flights in the statistics",
    );
    await expect(page.locator("#replay-controls")).toBeHidden();
    // With nothing selected, the list to pick a flight from opens with it
    await expect(page.locator("#stats-rail")).toBeVisible();
    await expect(page.locator("#flights-tab")).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("toggleReplay activates replay mode", async ({ page }) => {
    await activateReplay(page);

    await expect(page.locator("#replay-controls")).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/replay-active/);
  });

  test("replay button reflects the active state", async ({ page }) => {
    const replayBtn = page.locator("#replay-btn");
    await activateReplay(page);

    await expect(replayBtn).toHaveAttribute("data-icon", "stop");
    await expect(replayBtn).toHaveAttribute("aria-pressed", "true");
    // A toggle keeps its name; aria-pressed says it is on
    await expect(replayBtn).toHaveAttribute(
      "aria-label",
      "Replay selected flights",
    );

    await replayBtn.click();
    await expect(page.locator("#replay-controls")).toBeHidden();

    await expect(replayBtn).toHaveAttribute("data-icon", "play");
    await expect(replayBtn).toHaveAttribute("aria-pressed", "false");
    await expect(replayBtn).toHaveAttribute(
      "aria-label",
      "Replay selected flights",
    );
  });

  test("replay controls are visible when active", async ({ page }) => {
    await activateReplay(page);

    await expect(page.locator("#replay-play-btn")).toBeVisible();
    await expect(page.locator("#replay-stop-btn")).toBeVisible();
    await expect(page.locator("#replay-time-display")).toBeVisible();
    await expect(page.locator("#replay-speed")).toBeVisible();
    await expect(page.locator("#replay-autozoom-btn")).toBeVisible();
    await expect(page.locator("#replay-slider")).toBeVisible();
    await expect(page.locator("#replay-slider")).toHaveValue("0");
    await expect(page.locator("#replay-slider")).toHaveAttribute(
      "aria-valuetext",
      // The start is written in the total's format: 0:00:00 of 3:22:57
      /^0(:00){1,2} of \d+(:\d{2}){1,2}$/,
    );
  });

  test("playReplay starts animation and shows pause button", async ({
    page,
  }) => {
    await activateReplay(page);

    await page.locator("#replay-play-btn").click();
    await expect(page.locator("#replay-pause-btn")).toBeVisible();
    await expect(page.locator("#replay-play-btn")).toBeHidden();

    expect(await page.evaluate(() => window.mapApp!.replayState.playing)).toBe(
      true,
    );
    await expect(page.locator("#replay-live")).toHaveText("Replay playing");
  });

  test("pauseReplay pauses animation and shows play button", async ({
    page,
  }) => {
    await activateReplay(page);

    await playUntilProgress(page);
    await page.locator("#replay-pause-btn").click();

    await expect(page.locator("#replay-play-btn")).toBeVisible();
    await expect(page.locator("#replay-pause-btn")).toBeHidden();

    expect(await page.evaluate(() => window.mapApp!.replayState.playing)).toBe(
      false,
    );
    await expect(page.locator("#replay-live")).toHaveText(/^Replay paused at/);
  });

  test("stopReplay resets to beginning", async ({ page }) => {
    await activateReplay(page);

    await playUntilProgress(page);
    await page.locator("#replay-stop-btn").click();

    await expect
      .poll(() => page.evaluate(() => window.mapApp!.replayState.currentTime))
      .toBe(0);
    await expect(page.locator("#replay-slider")).toHaveValue("0");
    await expect(page.locator("#replay-play-btn")).toBeVisible();
    await expect(page.locator("#replay-pause-btn")).toBeHidden();
    await expect(page.locator("#replay-live")).toHaveText("Replay stopped");
  });

  test("seekReplay moves position and updates the slider text", async ({
    page,
  }) => {
    await activateReplay(page);

    const maxTime = await page.evaluate(
      () => window.mapApp!.replayState.maxTime,
    );
    const midpoint = Math.floor(maxTime / 2);
    const drawnBefore = await page.evaluate(
      () => window.mapApp!.replayState.lastDrawnIndex,
    );

    await page.evaluate(
      (val) => window.mapApp!.replayManager!.seekReplay(String(val)),
      midpoint,
    );

    expect(
      await page.evaluate(() => window.mapApp!.replayState.currentTime),
    ).toBe(midpoint);
    await expect(page.locator("#replay-slider")).toHaveValue(String(midpoint));
    await expect(page.locator("#replay-slider")).toHaveAttribute(
      "aria-valuetext",
      /^\d+(:\d{2}){1,2} of \d+(:\d{2}){1,2}$/,
    );
    // Drawn up to the middle, past where it was
    expect(
      await page.evaluate(() => window.mapApp!.replayState.lastDrawnIndex),
    ).toBeGreaterThan(Math.max(drawnBefore, 0));
  });

  test("changeReplaySpeed updates speed", async ({ page }) => {
    await activateReplay(page);

    expect(await page.evaluate(() => window.mapApp!.replayState.speed)).toBe(
      50,
    );

    await page.locator("#replay-speed").selectOption("100");

    await expect
      .poll(() => page.evaluate(() => window.mapApp!.replayState.speed))
      .toBe(100);
  });

  test("toggleAutoZoom toggles auto-zoom state", async ({ page }) => {
    await activateReplay(page);

    const autoZoomBtn = page.locator("#replay-autozoom-btn");

    // Off is drawn at full strength, without the accent; only an
    // unavailable control is dimmed
    await expect(autoZoomBtn).toHaveCSS("opacity", "1");
    await expect(autoZoomBtn).toHaveAttribute("aria-pressed", "false");
    await expect(autoZoomBtn).not.toHaveClass(/\bactive\b/);

    await autoZoomBtn.click();
    await expect(autoZoomBtn).toHaveCSS("opacity", "1");
    await expect(autoZoomBtn).toHaveAttribute("aria-pressed", "true");
    await expect(autoZoomBtn).toHaveClass(/\bactive\b/);
    expect(await page.evaluate(() => window.mapApp!.replayState.autoZoom)).toBe(
      true,
    );

    await autoZoomBtn.click();
    await expect(autoZoomBtn).toHaveAttribute("aria-pressed", "false");
    await expect(autoZoomBtn).not.toHaveClass(/\bactive\b/);
    expect(await page.evaluate(() => window.mapApp!.replayState.autoZoom)).toBe(
      false,
    );
  });

  test("the chase view stays off with reduced motion", async ({ page }) => {
    // The suite asks for it (playwright.config.ts): a camera that turns
    // with the airplane is what the setting spares
    await activateReplay(page);
    const chase = page.locator("#replay-chase-btn");
    await chase.click();
    await expect(chase).toHaveAttribute("aria-pressed", "false");
    await expect(toastMessage(page, "reduced motion")).toBeVisible();
  });

  test.describe("with motion", HEAVY, () => {
    // Before the page loads: WebKit does not update a media query list
    // the page already holds when the emulation changes
    test.use({ reducedMotion: "no-preference" });

    test("the chase view follows the track and gives the view back", async ({
      page,
    }) => {
      // The chase tilts the map to 70 degrees, where a frame of software
      // WebGL on a CI runner takes seconds; a smaller desktop window (the
      // desktop layout starts at 768 px) makes each one cheaper, and the
      // test gets the time the camera needs to settle three times over
      test.setTimeout(120000);
      if (!test.info().project.use.isMobile) {
        await page.setViewportSize({ width: 800, height: 500 });
      }
      await activateReplay(page);
      const camera = () =>
        page.evaluate(() => {
          const map = window.mapApp!.map!;
          const { lng, lat } = map.getCenter();
          return {
            lng,
            lat,
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch(),
          };
        });
      // How far the camera looks from the airplane's heading, in degrees
      const offTrack = () =>
        page.evaluate(() => {
          const app = window.mapApp!;
          const track = app.replayState.lastBearing ?? 0;
          const turn = (((app.map!.getBearing() - track) % 360) + 540) % 360;
          return Math.abs(turn - 180);
        });
      await page.evaluate(() => {
        const state = window.mapApp!.replayState;
        window.mapApp!.replayManager!.seekReplay(
          String(Math.floor(state.maxTime / 2)),
        );
      });
      // Settled where the replay opened, so the view to come back is known
      await expect
        .poll(() => page.evaluate(() => window.mapApp!.map!.isMoving()))
        .toBe(false);
      const before = await camera();

      // From the keyboard: a control of the transport row like the others
      const chase = page.locator("#replay-chase-btn");
      await expect(chase).toHaveAttribute("aria-pressed", "false");
      await chase.focus();
      await page.keyboard.press("Enter");
      await expect(chase).toHaveAttribute("aria-pressed", "true");
      // A replay that fast would turn before the camera could follow
      await expect(page.locator("#replay-speed")).toHaveValue("10");

      // Paused, the camera still flies in behind the airplane and settles
      await expect.poll(offTrack, { timeout: 30000 }).toBeLessThan(3);
      const chased = await camera();
      expect(chased.pitch).toBeGreaterThanOrEqual(45);
      expect(chased.pitch).toBeLessThanOrEqual(75);

      // Playing, it turns with the track, and stops where the replay pauses.
      // It plays on for ten seconds of the flight, what a second of playing
      // at this speed gives: a frame of software WebGL takes long, and each
      // moves the replay by a capped step, so the replay's own clock is the
      // one to wait on rather than the wall's.
      await playUntilProgress(page);
      const replayTime = () =>
        page.evaluate(() => window.mapApp!.replayState.currentTime);
      const playedFrom = await replayTime();
      await expect
        .poll(replayTime, { timeout: 30000 })
        .toBeGreaterThanOrEqual(playedFrom + 10);
      await page.locator("#replay-pause-btn").click();
      await expect.poll(offTrack, { timeout: 30000 }).toBeLessThan(3);
      expect((await camera()).pitch).toBeGreaterThanOrEqual(45);

      // Off: the zoom, turn and tilt from before, over the airplane
      await chase.click();
      await expect(chase).toHaveAttribute("aria-pressed", "false");
      await expect
        .poll(async () => {
          const { zoom, bearing, pitch } = await camera();
          return [zoom, bearing, pitch].map((n) => Math.round(n * 10) / 10);
        })
        .toEqual(
          [before.zoom, before.bearing, before.pitch].map(
            (n) => Math.round(n * 10) / 10,
          ),
        );
      await expect(page.locator("#replay-speed")).toHaveValue("50");

      // On again, and closing the replay gives back the whole view
      const again = await camera();
      await chase.click();
      await expect.poll(offTrack, { timeout: 30000 }).toBeLessThan(3);
      await page.locator("#replay-exit-btn").click();
      await expect(page.locator("#replay-controls")).toBeHidden();
      await expect
        .poll(async () => {
          const { lng, lat, zoom, bearing, pitch } = await camera();
          return [lng, lat, zoom, bearing, pitch].map(
            (n) => Math.round(n * 1000) / 1000,
          );
        })
        .toEqual(
          [again.lng, again.lat, again.zoom, again.bearing, again.pitch].map(
            (n) => Math.round(n * 1000) / 1000,
          ),
        );
    });
  });

  test("airplane marker appears during replay", async ({ page }) => {
    await activateReplay(page);

    const airplaneIcon = page.locator(".replay-airplane-icon");
    await expect(airplaneIcon).toBeAttached();
    // Drawn from the icon family, nose up, so the marker's rotation is the
    // track: the emoji it replaced pointed north-east on some platforms and
    // somewhere else on others
    await expect(airplaneIcon.locator("svg")).toBeAttached();
  });

  test("replay time display updates during playback", async ({ page }) => {
    await activateReplay(page);

    await playUntilProgress(page);
    await page.locator("#replay-pause-btn").click();

    const currentTime = await page.evaluate(
      () => window.mapApp!.replayState.currentTime,
    );
    expect(currentTime).toBeGreaterThan(0);
    await expect(page.locator("#replay-time-display")).not.toHaveText(
      /^0:00 \//,
    );
  });

  test("stopping replay restores normal UI", async ({ page }) => {
    await activateReplay(page);

    await page.locator("#replay-btn").click();
    await expect(page.locator("#replay-controls")).toBeHidden();
    await expect(page.locator("body")).not.toHaveClass(/replay-active/);

    await expect(page.locator("#heatmap-btn")).toBeEnabled();
    await expect(page.locator("#year-select")).toBeEnabled();
    await expect(page.locator(".replay-airplane-icon")).toHaveCount(0);
  });

  test("replay disables heatmap and filter controls", async ({ page }) => {
    await activateReplay(page);

    await expect(page.locator("#heatmap-btn")).toBeDisabled();
    await expect(page.locator("#airports-btn")).toBeDisabled();
    await expect(page.locator("#year-select")).toBeDisabled();
    await expect(page.locator("#aircraft-select")).toBeDisabled();
    // Dimmed once: the row at half strength, and the browser's own dimming
    // of a disabled select undone, which took the filters to a third
    await expect(page.locator("#heatmap-btn")).toHaveCSS("opacity", "0.5");
    await expect(page.locator("#year-filter")).toHaveCSS("opacity", "0.5");
    await expect(page.locator("#year-select")).toHaveCSS("opacity", "1");
  });

  test("replay keeps the selection it is playing", async ({ page }) => {
    await activateReplay(page);

    // Clearing it dimmed the Stop button and switched the statistics
    await expect(page.locator("#isolate-btn")).toBeDisabled();
    await expect(page.locator("#selection-clear-btn")).toBeDisabled();
    await expect(page.locator("#selection-chip-count")).toHaveText(
      "1 flight selected",
    );
    await expect(page.locator("#replay-btn")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.locator("#replay-btn")).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  test("replay slider shows time labels", async ({ page }) => {
    await activateReplay(page);

    const startLabel = page.locator("#replay-slider-start");
    const endLabel = page.locator("#replay-slider-end");

    await expect(startLabel).toBeVisible();
    await expect(endLabel).toBeVisible();
    await expect(endLabel).not.toHaveText("0:00");
    // The start is where the timeline begins, not a second clock: the
    // current time is in the transport row, in the format of the total
    await expect(startLabel).toHaveText(/^0:00(:00)?$/);
    const total = (await endLabel.textContent())!;
    const elapsed =
      total.split(":").length === 3
        ? String.raw`\d+:\d{2}:\d{2}`
        : String.raw`\d+:\d{2}`;
    await expect(page.locator("#replay-time-display")).toHaveText(
      new RegExp(`^${elapsed} / ${total}$`),
    );
  });

  test("replay speed dropdown has all options", async ({ page }) => {
    await activateReplay(page);

    const values = await page
      .locator("#replay-speed option")
      .evaluateAll((els) => els.map((el) => (el as HTMLOptionElement).value));

    expect(values).toEqual([
      "1",
      "2",
      "5",
      "10",
      "25",
      "50",
      "100",
      "200",
      "500",
      "1000",
    ]);
  });

  test("the readout follows the current position", async ({ page }) => {
    await activateReplay(page);

    const altitude = page.locator("#replay-readout-altitude");
    const speed = page.locator("#replay-readout-speed");
    const track = page.locator("#replay-readout-track");

    // Built by the renderer, not the template, so it has to be on screen
    // above the breakpoint as well as below it
    for (const cell of [altitude, speed, track]) {
      await expect(cell).toBeVisible();
    }
    await expect(page.locator(".replay-readout-label")).toHaveText([
      "Altitude",
      "Groundspeed",
      "Track",
    ]);
    // It reports the position many times a second, so it must never be a
    // live region
    await expect(page.locator("#replay-readout")).not.toHaveAttribute(
      "aria-live",
      /.*/,
    );

    await playUntilProgress(page);
    await page.locator("#replay-pause-btn").click();

    await expect(altitude).toHaveText(/^\d+ ft$/);
    await expect(speed).toHaveText(/^\d+ kt$/);
    await expect(track).toHaveText(/^\d{3}°$/);
  });

  test("the exit control and readout are laid out on desktop too", async ({
    page,
  }) => {
    // Both are built at every viewport, but their rules used to live only
    // inside the mobile media query, so on desktop the exit rendered as an
    // unstyled button in normal flow that pushed the transport row down
    await activateReplay(page);

    const layout = await page.evaluate(() => {
      const box = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? el.getBoundingClientRect() : null;
      };
      const exit = document.querySelector("#replay-exit-btn")!;
      const exitBox = exit.getBoundingClientRect();
      const panel = box("#replay-controls")!;
      const overlapping = [
        ...document.querySelectorAll("#replay-buttons button"),
      ].filter((btn) => {
        const b = btn.getBoundingClientRect();
        return !(
          exitBox.right <= b.left ||
          b.right <= exitBox.left ||
          exitBox.bottom <= b.top ||
          b.bottom <= exitBox.top
        );
      }).length;
      return {
        position: getComputedStyle(exit).position,
        width: exitBox.width,
        height: exitBox.height,
        insetRight: panel.right - exitBox.right,
        insetTop: exitBox.top - panel.top,
        overlapping,
        readoutDisplay: getComputedStyle(
          document.querySelector(".replay-readout")!,
        ).display,
        readoutCells: document.querySelectorAll(".replay-readout-cell").length,
      };
    });

    // Taken out of flow into the panel's top-right corner
    expect(layout.position).toBe("absolute");
    expect(layout.insetRight).toBeGreaterThanOrEqual(0);
    expect(layout.insetRight).toBeLessThan(24);
    expect(layout.insetTop).toBeLessThan(24);
    // A real target, and clear of every transport control
    expect(layout.width).toBeGreaterThanOrEqual(36);
    expect(layout.height).toBeGreaterThanOrEqual(36);
    expect(layout.overlapping).toBe(0);
    // The readout is one styled row, not three stacked unstyled pairs
    expect(layout.readoutDisplay).toBe("flex");
    expect(layout.readoutCells).toBe(3);
  });

  test("the exit control leaves replay", async ({ page }) => {
    await activateReplay(page);

    const exit = page.locator("#replay-exit-btn");
    await expect(exit).toBeVisible();
    await expect(exit).toHaveAttribute("aria-label", "Close replay");
    await expect(exit).toHaveAttribute("title", "Close replay");
    await expect(exit.locator("svg.icon")).toHaveCount(1);

    await exit.click();

    await expect(page.locator("#replay-controls")).toBeHidden();
    await expect(page.locator("body")).not.toHaveClass(/replay-active/);
    await expect(page.locator("#replay-btn")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.locator(".replay-airplane-icon")).toHaveCount(0);
  });

  test("airplane marker popup toggles on click", async ({ page }) => {
    await activateReplay(page);

    await playUntilProgress(page);
    await page.locator("#replay-pause-btn").click();

    await page.locator(".replay-airplane-icon").click();

    const popup = mapPopupContent(page);
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("Current position");

    // Closed through the marker: the test is of what the popup shows
    await page.evaluate(() => {
      window.mapApp!.replayState.airplaneMarker!.closePopup();
    });
    await expect(popup).toBeHidden();
  });

  test("an open airport popup draws above the airplane (regression)", async ({
    page,
  }) => {
    await activateReplay(page);
    const airport = await page.evaluate(
      () => Object.keys(window.mapApp!.airportMarkers)[0]!,
    );
    await centerOnAirport(page, airport, 10);
    await openAirportPopup(page, airport);

    await expectPopupAboveAirplane(page);
  });

  test("Enter on the focused airplane marker opens its popup", async ({
    page,
  }) => {
    await activateReplay(page);
    const marker = mapMarkers(page).filter({
      has: page.locator(".replay-airplane-icon"),
    });

    // The popup used to be bound on the first click, so the keyboard had
    // nothing to open until a pointer had been there
    await marker.focus();
    await page.keyboard.press("Enter");

    const popup = mapPopupContent(page);
    await expect(popup).toBeVisible();
    await expect(popup).toContainText("Current position");
  });

  test("the heat canvas stays under the paths after a replay", async ({
    page,
  }) => {
    await waitForPathData(page);
    await expectHeatUnderPaths(page);
    await activateReplay(page);

    await page.locator("#replay-btn").click();
    await expect(page.locator("#replay-controls")).toBeHidden();

    // Closing replay adds the heat layer back, after the path canvas
    await expectHeatUnderPaths(page);
  });
});
